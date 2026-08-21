/**
 * dsh-retrace — the versioning seam: projection unit registration, artifact
 * snapshot side effects, the `retrace` storageDomain, and the per-session
 * config view.
 *
 * PLAN.md §4.1/§4.3/§4.6. Everything here lives behind `ctx.inject(...)` so
 * headless compositions without `sessionProjections`/`sessionQuery`/
 * `storageDomain` simply never activate it — the plugin degrades to plain L1
 * (recall / edit / regenerate) with no versioning surface, exactly like
 * 0.2.x.
 *
 * The projection unit is registered unconditionally once the seam is
 * available (pure fold, framework-owned cache, negligible cost). The
 * "versioning off" switch is honored at the side-effect and HTTP surface:
 * no snapshots are written and `/versions` reports `enabled: false` — the
 * user-visible behavior is identical to 0.2.x either way.
 */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import {
  createArtifactStore,
  refFor,
  retraceDomainSpec,
} from './artifact-store.js'
import { versionsProjectionDefinition } from './projection/versions.js'

/** Max bytes snapshotted per touched file (over → file skipped, version kept). */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
/** NUL-byte probe window for binary detection. */
const BINARY_PROBE_BYTES = 1024

/** Default per-session config (client may override per request). */
export const DEFAULT_RETRACE_CONFIG = { versioning: true, git: true, retentionLimit: 50 }

function isBinary(bytes) {
  const probe = bytes.subarray(0, BINARY_PROBE_BYTES)
  for (const byte of probe) if (byte === 0) return true
  return false
}

/**
 * Create the versioning seam for one plugin context.
 * `register()` must run synchronously inside `apply` so the `ctx.inject`
 * effects attach to the plugin fiber.
 * @param {object} options - `storeRoot` overrides the artifact root
 *   (defaults to `$DSH_HOME/dsh-retrace`); tests use a temp directory.
 */
export function createVersioningSeam(ctx, log = () => {}, options = {}) {
  let registered = false
  let seamCtx = null
  let domain = null
  let store = null
  const disposers = []
  /** Per-session request-carried config; seeded from the domain global when ready. */
  const configs = new Map()

  function configFor(sessionId) {
    return configs.get(sessionId) ?? { ...DEFAULT_RETRACE_CONFIG }
  }

  function setConfig(sessionId, config) {
    configs.set(sessionId, { ...DEFAULT_RETRACE_CONFIG, ...config })
  }

  /** Versioning surface availability (false in headless/minimal compositions). */
  function available() {
    return seamCtx !== null
  }

  /** Read one touched file through the sandboxed fs and snapshot it. */
  async function snapshotOne(session, record, file) {
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return
    try {
      const target = await ctx.fs.resolve(file.path, { cwd })
      const workspaceTarget = await ctx.fs.resolve('.', { cwd })
      if (!ctx.fs.contains(workspaceTarget, target)) return // outside the workspace
      const bytes = await ctx.fs.readBytes(target, undefined, MAX_SNAPSHOT_BYTES)
      if (isBinary(bytes)) return
      const { sha256, sizeBytes } = await store.save(bytes)
      const refsTable = domain.table('refcounts')
      const ref = refFor(record.versionId, file.path)
      const prev = refsTable.get(sha256)
      if (prev && !prev.refs.includes(ref)) {
        await refsTable.put(sha256, { ...prev, refs: [...prev.refs, ref] })
      } else if (!prev) {
        await refsTable.put(sha256, {
          refs: [ref],
          sizeBytes,
          createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
        })
      }
    } catch (error) {
      log(`retrace: snapshot skipped for ${file.path}: ${String(error)}`)
    }
  }

  /** Side effect: snapshot every non-deleted touched file of a new version. */
  async function snapshotVersionFiles(session, record) {
    if (!domain || !store || !configFor(session.id).versioning) return
    await Promise.allSettled(
      record.touchedFiles
        .filter((file) => file.mode !== 'deleted')
        .map((file) => snapshotOne(session, record, file)),
    )
  }

  /**
   * Register the projection unit, open the domain and wire the change feed.
   * Idempotent; safe to call from apply.
   */
  function register() {
    if (registered) return
    registered = true
    ctx.inject(['sessionProjections', 'sessionQuery', 'storageDomain'], (seam) => {
      seamCtx = seam
      disposers.push(seam.sessionProjections.register(versionsProjectionDefinition))
      disposers.push(
        seam.sessionProjections.onChanged((session, key, value, seq) => {
          if (key !== 'retrace/versions') return
          const latest = value.versions.at(-1)
          if (!latest || latest.boundarySeq !== seq) return // only NEW boundaries
          void snapshotVersionFiles(session, latest)
        }),
      )
      // Domain open is async; versioning degrades to L1 if it fails.
      void seam.storageDomain
        .open(retraceDomainSpec)
        .then((opened) => {
          domain = opened
          const root = options.storeRoot ?? join(resolveDshHome(), 'dsh-retrace')
          store = createArtifactStore(root)
          disposers.push(() => void domain.close())
          const global = opened.global.get()
          if (global) {
            // Seed session configs with the durable defaults (per-request overrides win).
            for (const [id, config] of configs) setConfig(id, { ...config, ...global })
          }
        })
        .catch((error) => log(`retrace: versioning disabled: ${String(error)}`))
    })
    ctx.effect(() => () => {
      for (const dispose of disposers) dispose()
    }, 'dsh-retrace: versioning seam')
  }

  /** HTTP fallback channel: the live projection snapshot for one session. */
  function snapshot(sessionId) {
    if (!available()) {
      return { enabled: false, versions: [] }
    }
    const session = ctx.sessions.get(sessionId)
    if (!session) {
      const error = new Error(`session "${sessionId}" not found`)
      error.code = 'session-not-found'
      throw error
    }
    const cut = seamCtx.sessionProjections.snapshot(session)
    const value = cut.values['retrace/versions']
    if (!value) return { enabled: false, versions: [] }
    return { enabled: configFor(sessionId).versioning, ...value }
  }

  /** readEvent passthrough (timeline detail drawer). */
  async function readEvent(request) {
    if (!available()) {
      const error = new Error('versioning surface unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return seamCtx.sessionQuery.readEvent(request)
  }

  /** readSurface passthrough. */
  async function readSurface(sessionId) {
    if (!available()) {
      const error = new Error('versioning surface unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return seamCtx.sessionQuery.readSurface(sessionId)
  }

  return {
    register,
    available,
    configFor,
    setConfig,
    snapshot,
    readEvent,
    readSurface,
  }
}
