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
  gcArtifacts,
  refFor,
  retraceDomainSpec,
} from './artifact-store.js'
import { versionsProjectionDefinition } from './projection/versions.js'
import { createGitAdapter, createSubprocessRunner } from './git-adapter.js'

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
  let git = null
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
   * Side effect: record the git facts (HEAD + dirty) of a new version boundary
   * (PLAN §4.4 commit-free). Read-only commands only; best-effort — a failure
   * just leaves the version without git facts (snapshot rollback still works).
   */
  async function recordVersionGit(session, record) {
    if (!domain || !git || !configFor(session.id).git) return
    const cwd = session.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return
    try {
      const status = await git.status(cwd)
      await domain.table('versiongit').put(record.versionId, {
        headHash: status?.headHash ?? null,
        dirty: status?.dirty ?? false,
      })
    } catch (error) {
      log(`retrace: git facts skipped for ${record.versionId}: ${String(error)}`)
    }
  }

  /** The git adapter, created lazily once the seam context is available. */
  function ensureGit() {
    if (git === null && seamCtx !== null) {
      // `ctx.subprocess` is a cordis getter that throws when the service is not
      // injected; headless/minimal compositions degrade to snapshot-only
      // rollback instead of crashing the plugin.
      let subprocess
      try {
        subprocess = ctx.subprocess
      } catch {
        subprocess = undefined
      }
      if (subprocess) git = createGitAdapter(createSubprocessRunner(ctx, log))
    }
    return git
  }

  // -------------------------------------------------------------------------
  // P1.5 — bounded retention: background GC over the artifact store.
  // -------------------------------------------------------------------------
  /** sessionId → retained versionIds (updated at every boundary we observe). */
  const retainedVersions = new Map()
  /** Throttle: one sweep per session at most every GC_INTERVAL_MS. */
  const lastGc = new Map()
  const GC_INTERVAL_MS = options.gcIntervalMs ?? 60_000

  function noteRetained(sessionId, versions) {
    retainedVersions.set(sessionId, new Set(versions.map((v) => v.versionId)))
  }

  /**
   * Filter a refcounts record to the references still retained by any known
   * session, returning the surviving refs. Unknown versions are kept
   * (conservative — a cold-restored session we have not seen yet may still
   * reference them).
   */
  function retainedRefs(refs) {
    const retained = new Set()
    for (const ids of retainedVersions.values()) for (const id of ids) retained.add(id)
    return refs.filter((ref) => {
      const colon = ref.indexOf(':')
      const versionId = colon === -1 ? ref : ref.slice(0, colon)
      return retained.has(versionId)
    })
  }

  /**
   * Throttled sweep: prune refs to truncated versions of known sessions, drop
   * objects that end up with zero refs, and prune versiongit rows of versions
   * no longer retained. Safe by construction — never touches an object a
   * retained version references, and unknown sessions keep their refs.
   */
  async function sweepGc(sessionId) {
    if (!domain || !store) return
    const now = Date.now()
    const last = lastGc.get(sessionId) ?? 0
    if (now - last < GC_INTERVAL_MS) return
    lastGc.set(sessionId, now)
    try {
      const refcounts = domain.table('refcounts')
      const versiongit = domain.table('versiongit')
      const keep = new Set()
      const dead = []
      for (const [sha, record] of refcounts.entries()) {
        const refs = Array.isArray(record.refs) ? record.refs : []
        const kept = retainedRefs(refs)
        if (kept.length !== refs.length) await refcounts.put(sha, { ...record, refs: kept })
        if (kept.length > 0) keep.add(sha)
        else dead.push(sha)
      }
      // Prune versiongit rows of versions no session retains any more.
      const retained = new Set()
      for (const ids of retainedVersions.values()) for (const id of ids) retained.add(id)
      for (const versionId of [...versiongit.keys()]) {
        if (!retained.has(versionId)) await versiongit.delete(versionId)
      }
      const removed = await gcArtifacts(store, keep)
      if (removed > 0 || dead.length > 0) log(`retrace: GC removed ${removed} objects (${dead.length} zero-ref)`)
    } catch (error) {
      log(`retrace: GC sweep failed: ${String(error)}`)
    }
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
          noteRetained(session.id, value.versions ?? [])
          const latest = value.versions.at(-1)
          if (!latest || latest.boundarySeq !== seq) return // only NEW boundaries
          void snapshotVersionFiles(session, latest)
          void recordVersionGit(session, latest)
          void sweepGc(session.id)
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

  /** The live agent for one session (rollback busy-guard). */
  function agentOf(sessionId) {
    return ctx.agents?.get?.(sessionId) ?? undefined
  }

  /** Resolve the content address of `<versionId>:<path>` (or null). */
  async function resolveSnapshot(versionId, path) {
    if (!domain || !store) return null
    const ref = refFor(versionId, path)
    const refcounts = domain.table('refcounts')
    for (const [sha, record] of refcounts.entries()) {
      if (record.refs && record.refs.includes(ref)) return sha
    }
    return null
  }

  /** Integrity-checked snapshot read (rollback restore path). */
  async function readSnapshot(sha) {
    if (!store) {
      const error = new Error('versioning surface unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return store.read(sha)
  }

  /** Git facts for one version (headHash recorded at its boundary). */
  async function gitHeadFor(versionId) {
    if (!domain) return null
    return domain.table('versiongit').get(versionId) ?? null
  }

  /** Repo status of the session workspace (null = not a repository). */
  async function gitStatus(sessionId) {
    const adapter = ensureGit()
    if (!adapter) return null
    const session = ctx.sessions.get(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    return adapter.status(cwd)
  }

  /** `git checkout <headHash> -- <paths>` (write; caller confirms first). */
  async function gitCheckout(cwd, headHash, paths) {
    const adapter = ensureGit()
    if (!adapter) {
      const error = new Error('git adapter unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    return adapter.checkout(cwd, headHash, paths)
  }

  /** One-click init for a non-repository workspace (write; caller confirms). */
  async function gitInit(sessionId) {
    const adapter = ensureGit()
    if (!adapter) {
      const error = new Error('git adapter unavailable')
      error.code = 'versioning-unavailable'
      throw error
    }
    const session = ctx.sessions.get(sessionId)
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || cwd.length === 0) {
      const error = new Error('session has no workspace cwd')
      error.code = 'no-cwd'
      throw error
    }
    return adapter.init(cwd)
  }

  return {
    register,
    available,
    configFor,
    setConfig,
    snapshot,
    readEvent,
    readSurface,
    agentOf,
    resolveSnapshot,
    readSnapshot,
    gitHeadFor,
    gitStatus,
    gitCheckout,
    gitInit,
  }
}
