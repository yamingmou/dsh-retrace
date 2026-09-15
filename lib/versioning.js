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
// 存储根落点走 lib/platform/session-paths.js 的 pluginDataHome(与会话基座**同源**)。
// 此前用官方 resolveDshHome()(只认 $DSH_HOME → ~/.dsh):未设 $DSH_HOME 且两基座
// 都在时,会话读 ~/dsh-v3 而对象/引用写 ~/.dsh(存储分裂,2026-09-14 实测)。
import { pluginDataHome } from './platform/session-paths.js'
import { eventAt, sessionEvents } from './host-compat.js'
import {
  createArtifactStore,
  gcArtifacts,
  refFor,
  retraceDomainSpec,
} from './artifact-store.js'
import { tokenMeterViolations } from 'dsh-log-contract'
import { versionsProjectionDefinition } from './projection/versions.js'
import { forkmapProjectionDefinition } from './projection/forkmap.js'
import { createGitAdapter, createSubprocessRunner } from './git-adapter.js'
import { makeWhat } from './boundary-what.js'
import { triggerSummary } from './llm-summary.js'
import { classifyBoundaryKind, countFileModes, replacedSeqsOfBoundary } from './version-index.js'
import { deriveBoundaryRecords } from './boundary-derive.js'
import { buildNowIndex, nowOfBoundary, shadowedSeqsOf } from './boundary-now.js'

/** Max bytes snapshotted per touched file (over → file skipped, version kept). */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024
/** NUL-byte probe window for binary detection. */
const BINARY_PROBE_BYTES = 1024

/** Default per-session config (client may override per request). */
export const DEFAULT_RETRACE_CONFIG = { versioning: true, git: true, retentionLimit: 50, prewrite: true, summary: false }

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
      // P2.1 — the fork-map unit: pure fold (branch topology), no side effects.
      disposers.push(seam.sessionProjections.register(forkmapProjectionDefinition))
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
          const root = options.storeRoot ?? join(pluginDataHome(), 'dsh-retrace')
          store = createArtifactStore(root)
          disposers.push(() => void domain.close())
          const global = opened.global.get()
          if (global) {
            // Seed session configs with the durable defaults (per-request overrides win).
            // The domain schema spells the git switch `gitEnabled` (0.4.x review:
            // it was merged in but never read — consumers use `config.git`).
            const seeded = { ...global, git: global.gitEnabled ?? configs.get('')?.git ?? true }
            delete seeded.gitEnabled
            for (const [id, config] of configs) setConfig(id, { ...config, ...seeded })
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
    return snapshotKey(sessionId, 'retrace/versions', { enabled: false, versions: [] })
  }

  /** HTTP fallback channel: the fork-map projection snapshot (P2.1). */
  function snapshotForkmap(sessionId) {
    return snapshotKey(sessionId, 'retrace/forkmap', { enabled: false, nodes: [], boundaries: [] })
  }

  function snapshotKey(sessionId, key, empty) {
    if (!available()) return empty
    const session = ctx.sessions.get(sessionId)
    if (!session) {
      const error = new Error(`session "${sessionId}" not found`)
      error.code = 'session-not-found'
      throw error
    }
    const cut = seamCtx.sessionProjections.snapshot(session)
    const value = cut.values[key]
    if (!value) return empty
    return { enabled: configFor(sessionId).versioning, ...value }
  }

  /**
   * Read-side boundary view model for `/summaries`:
   *
   *   stored artifact records (AUTHORITATIVE — written at operation time, when
   *   the replaced window was still on the surface) + digests DERIVED from the
   *   log for every one of our boundaries that has no stored record (old
   *   sessions: the artifact feature shipped after those boundaries happened, so
   *   they had no content at all) + the count of host-side surface replacements
   *   that are filtered out of the list (`viewVersionIndex`).
   *
   * Every record also carries `now` when the log still holds the message that
   * THIS action left behind (`edit` → our `retrace-resend-*` node, `regenerate`
   * → the host's new assistant reply; lib/boundary-now.js). It is read-side only:
   * old artifacts need no migration, and a record whose counterpart is honestly
   * gone keeps no `now` field at all.
   *
   * Pure read: no LLM call, no write, nothing on the op path.
   *
   * @param {string} sessionId
   * @param {object[]} [storedRecords] - already-read artifact records
   * @returns {{records:object[], derived:number, hostReplacementCount:number}}
   */
  function boundariesFor(sessionId, storedRecords = []) {
    const stored = Array.isArray(storedRecords) ? storedRecords.filter((record) => record && typeof record === 'object') : []
    const storedSeqs = new Set(stored.map((record) => record?.boundarySeq).filter((seq) => Number.isSafeInteger(seq)))
    let versions = []
    let hostReplacementCount = 0
    try {
      const view = snapshot(sessionId)
      if (Array.isArray(view?.versions)) versions = view.versions
      if (Number.isSafeInteger(view?.hostReplacementCount)) hostReplacementCount = view.hostReplacementCount
    } catch (error) {
      // Unreadable list ⇒ stored records only (degrade, never guess a boundary).
      log(`retrace: boundary list unavailable for ${sessionId}: ${String(error?.message ?? error)}`)
    }
    const missing = versions.filter((version) => !storedSeqs.has(version?.boundarySeq))
    const session = ctx.sessions.get(sessionId)
    const derived = deriveBoundaryRecords({
      versions: missing,
      eventAt: (seq) => eventAt(session, seq),
      boundarySeqs: new Set(versions.map((version) => version?.boundarySeq).filter((seq) => Number.isSafeInteger(seq))),
    })
    // 「现在这条」：读端一次性建索引（被本插件自己替换掉的节点不能再当"现在"），
    // 存储记录与派生记录都补上，旧产物因此不需要迁移。
    let index = { resends: [], replies: [] }
    try {
      const events = sessionEvents(session)
      index = buildNowIndex(events, shadowedSeqsOf(events))
    } catch (error) {
      log(`retrace: counterpart index unavailable for ${sessionId}: ${String(error?.message ?? error)}`)
    }
    const withNow = (record) => {
      const kind = typeof record?.kind === 'string' && record.kind !== ''
        ? record.kind
        : classifyBoundaryKind(eventAt(session, record?.boundarySeq))
      const now = nowOfBoundary(kind, record?.boundarySeq, index)
      return now === null ? record : { ...record, now }
    }
    return { records: [...stored, ...derived].map(withNow), derived: derived.length, hostReplacementCount }
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

  /**
   * Lineage chain (A4): walk `header.parentSession` from the current session
   * up to the root. Read-only; used by the fork-map header card to show how
   * the session continues/forks from its ancestors.
   *
   * @param {string} sessionId - the session to start from.
   * @returns {Array<{id: string, parentId: string|null}>} child-first chain
   *   (index 0 = this session, last = root).
   */
  function lineage(sessionId) {
    const chain = []
    const seen = new Set()
    let current = sessionId
    while (typeof current === 'string' && current !== '' && !seen.has(current)) {
      seen.add(current)
      const session = ctx.sessions.get(current)
      const header = session?.header ?? {}
      chain.push({ id: current, parentId: header.parentSession ?? null })
      current = header.parentSession ?? null
    }
    return chain
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

  /**
   * 压缩前体检（B1 短期 / 事故根因 3）：扫描会话内会破坏 token meter 的
   * turn-null marker（**旧形态**：assistant/message + data.editor，turn/step=null）。
   * token meter 折叠要求 assistant/message 匹配打开的 step/start，故这类历史 marker
   * 让 /compact 与压力测量永久失败。
   * ⚠️ 两段结构改造后**新写入的载体**（user/message + replace）不再有该问题
   * （token-meter 对 user/message 没有 step 配对要求）⇒ 本扫描只对历史 marker 有用，
   * 返回空清单 = 新会话已无此类病灶。
   * 检测只读不写；清理由 /retrace-doctor 流程（本端点 + 用户确认）处理。
   */
  function doctorScan(sessionId) {
    if (!available()) return { enabled: false, markerCount: 0, markers: [] }
    const session = ctx.sessions.get(sessionId)
    if (!session) {
      const error = new Error(`session "${sessionId}" not found`)
      error.code = 'session-not-found'
      throw error
    }
    const events = sessionEvents(session)
    const t1 = tokenMeterViolations(events.map((event) => ({ event })))
    const markers = t1
      .filter((v) => v.id === 'T1' && v.eventType === 'assistant/message')
      .map((v) => ({ seq: v.seq, message: v.message }))
      .slice(0, 100)
    return { enabled: true, markerCount: markers.length, markers }
  }

  /** The plugin data root (same base as the artifact store) for our own files. */
  function storeRoot() {
    return options.storeRoot ?? join(pluginDataHome(), 'dsh-retrace')
  }

  /** Read a host service without letting a missing one throw on the op path. */
  function serviceOf(name) {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }

  /** One boundary kind for the artifact `what` (a fold marker reads as a compaction-style boundary). */
  function whatOpOf(op) {
    return op === 'fold' ? 'compaction' : String(op)
  }

  /** The `retrace/versions` projection state, or undefined when unreadable. */
  function versionsStateOf(session) {
    try {
      return seamCtx?.sessionProjections?.stateOf?.(session, 'retrace/versions')
    } catch (error) {
      log(`retrace: versions projection state unavailable: ${String(error?.message ?? error)}`)
      return undefined
    }
  }

  /**
   * The artifact-churn counts of the boundary that was just closed.
   *
   * Read from the versions projection state (the framework already folded the
   * committed marker event, and the boundary query is O(1)): no second log walk,
   * no extra fold ledger. Returns null when the projection is unavailable or has
   * not folded this boundary yet — `artifacts` is then omitted from `what` (never
   * a misleading `0/0/0`) and the boundary is treated as NON-quiet (unknown ≠ 0).
   */
  function artifactCountsOf(session, markerSeq) {
    const state = versionsStateOf(session)
    const latest = Array.isArray(state?.versions) ? state.versions[state.versions.length - 1] : undefined
    if (!latest || latest.boundarySeq !== markerSeq || !Array.isArray(latest.touchedFiles)) return null
    return countFileModes(latest.touchedFiles)
  }

  /**
   * Every boundary seq the versions fold knows about, or null when unreadable.
   *
   * Used to SLIM the stored `discardedSeqs`: the outline only ever asks "did this
   * parent discard that boundary's own event seq", so non-boundary nodes need not
   * be stored. `discardedCount` keeps the exact `|S|` regardless. Unreadable ⇒
   * null ⇒ the caller stores the full set (correct, just larger).
   */
  function boundarySeqsOf(session) {
    const state = versionsStateOf(session)
    if (!Array.isArray(state?.versions)) return null
    return new Set(state.versions.map((version) => version?.boundarySeq).filter((seq) => Number.isSafeInteger(seq)))
  }

  /**
   * Post-write boundary observer (`hooks.onBoundary` from lib/host-core.js).
   *
   * The op is already committed, validated and flushed when this runs, so the
   * op path pays only a microtask: the log reads and the artifact write happen on
   * a later tick. The `what` digest has NO token cost and is always recorded;
   * only the LLM summary is opt-in (`summary` switch, default off) — when it is
   * on, at most one call happens, gated by `needsSummary` and short-circuited by
   * the content-hash cache. Every failure is logged (服务端错误不许静默), never
   * rethrown into the op.
   */
  function onBoundary(payload) {
    const session = payload?.session
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || !Number.isSafeInteger(payload?.markerSeq)) return
    const summaryEnabled = configFor(sessionId).summary === true
    void Promise.resolve()
      .then(() => buildBoundaryArtifact(session, payload, summaryEnabled))
      .catch((error) => log(`retrace: boundary artifact failed: ${String(error?.message ?? error)}`))
  }

  /** Resolve the replaced span from the log, record `what`, and (if enabled) summarize. */
  async function buildBoundaryArtifact(session, payload, summaryEnabled) {
    const spanSeqs = Array.isArray(payload?.span?.shadowedSeqs) ? payload.span.shadowedSeqs : []
    const markerEvent = eventAt(session, payload.markerSeq)
    // The EXACT removed set. The span is authoritative when the op resolved one;
    // otherwise fall back to the carrier's own citation minus its audit guide
    // item (never a numeric window — see lib/boundary-tree.js).
    const removedSeqs = spanSeqs.length > 0 ? spanSeqs : replacedSeqsOfBoundary(markerEvent, null)
    const spanEvents = removedSeqs.map((seq) => eventAt(session, seq)).filter((event) => event !== undefined)
    const artifactCounts = artifactCountsOf(session, payload.markerSeq)
    const what = makeWhat({
      op: whatOpOf(payload.op),
      at: markerEvent?.time,
      spanEvents,
      newText: payload.newText ?? '',
      artifacts: artifactCounts,
    })
    // Slim the stored set to the nodes that are themselves boundaries: the outline
    // only asks "did this parent discard that boundary's own seq". Unreadable
    // boundary list ⇒ store the full set (correct, just larger).
    const boundarySeqs = boundarySeqsOf(session)
    const discardedSeqs = boundarySeqs === null ? removedSeqs : removedSeqs.filter((seq) => boundarySeqs.has(seq))
    const selection = summaryEnabled ? serviceOf('agentDefaultModel')?.currentSelection?.() ?? null : null
    await triggerSummary({
      root: storeRoot(),
      sessionId: session.id,
      boundarySeq: payload.markerSeq,
      versionId: `v${payload.markerSeq}`,
      spanEvents,
      what,
      discardedSeqs,
      discardedCount: removedSeqs.length,
      // 轮次（人读用）：边界事件或它替换掉的那一段的 turn（真机 turn 从 1 起，
      // 0/缺失都当作取不到 ⇒ 行首整段省略）。
      turn: [markerEvent, ...spanEvents]
        .map((event) => event?.data?.turn)
        .find((value) => Number.isSafeInteger(value) && value > 0) ?? null,
      artifactCounts,
      summaryEnabled,
      llm: summaryEnabled ? serviceOf('llm') ?? null : null,
      selection,
      log,
    })
  }

  return {
    register,
    available,
    configFor,
    setConfig,
    storeRoot,
    boundariesFor,
    onBoundary,
    snapshot,
    snapshotForkmap,
    doctorScan,
    readEvent,
    readSurface,
    lineage,
    agentOf,
    resolveSnapshot,
    readSnapshot,
    gitHeadFor,
    gitStatus,
    gitCheckout,
    gitInit,
  }
}
