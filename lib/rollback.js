/**
 * dsh-retrace — Rollback executor (PLAN.md §4.5).
 *
 * Rolls a session (and optionally its artifacts) back to a recorded version:
 *
 *   scope 'context'   — append an invisible replacement marker shadowing every
 *                       surface node added AFTER the version boundary, so the
 *                       model-visible history rewinds to that point (git-checkout
 *                       semantics: the rewound content stays in the durable log
 *                       as a later version — non-destructive, auditable).
 *   scope 'artifacts' — restore the files the version's window touched to their
 *                       content at that version: git checkout when the workspace
 *                       is a repository and the version recorded a HEAD, else
 *                       content-addressed snapshot read-back through `ctx.fs`
 *                       (CAS-guarded), with subprocess `rm` for files that were
 *                       deleted in the version's window (realpath-in-workspace +
 *                       in-manifest guards only).
 *   scope 'both'      — context first, then artifacts.
 *
 * Every execution is dry-run-previewable first and records the restore as a new
 * version (kind='restore') in the projection feed, so a rollback is itself a
 * version and can be rolled back again (idempotent per-session lock included).
 */
import { isAbsolute, relative, resolve } from 'node:path'
import { foldSurface } from '@deepseek-ai/dsh-session'
// 独立折叠口径:已注册消息投影显式传给 foldSurface(官方 README.zh.md「独立构造函数和
// `foldSurface(events, projections)` 显式接收处理器」;内核 @deepseek-ai/dsh-session
// 0.1.7-rc.2 lib/index.js:486 第二参 / :1561 `get messageProjections()`)。适配器是模块级
// 单例、自身拿不到 ctx,这里把本执行器持有的会话注册表注入给它(取不到 → 单参回退)。
import { foldSurfaceWithProjections, messageProjectionsOf, setSessionProjectionsSource } from './adapter/dsh.js'
import { editorError } from './host-core.js'
import { sessionEvents } from './host-compat.js'
// 退化路径(镜像折叠):与内核 foldSurface 同口径的纯 fold —— append 入面 / replace
// 用 splice 换掉区间。事件里带内核无法接受的畸形行(真实大会话的嵌套
// `sourceEventSeqs`,如 [28324,28334])时,严格折叠整体抛错,靠它算出同一份目标面。
import { applyVersionIndex, createVersionIndexState } from './version-index.js'

const VALID_SCOPES = ['context', 'artifacts', 'both']

/**
 * Create the rollback executor.
 * @param {object} deps
 * @param {object} deps.ctx            — host context (ctx.fs / ctx.subprocess / ctx.sandboxPolicy).
 * @param {object} deps.sessions       — session registry (sessions.get / sessions.flush).
 * @param {object} deps.seam           — versioning seam (snapshot / resolveSnapshot /
 *                                       readSnapshot / gitStatus / gitHeadFor).
 * @param {object} [deps.agents]       — agent registry (agents.get) 用于轮次间 marker 的
 *                                       turn 信封推进 agent-loop 计数器（writeMarker 情形③）。
 * @param {Function} [deps.writeMarker] — 遮蔽写入器（adapter 注入；业务层只表达遮蔽意图）。
 * @param {(line: string) => void} [deps.log]
 * @param {Function} [deps.fold]       — 内核 foldSurface（默认取官方包；测试可注入假实现）。
 * @param {Function} [deps.applyIndex] — 镜像折叠（默认 lib/version-index.js#applyVersionIndex；
 *                                       仅测试注入用，见 targetSurface 的退化路径）。
 */
export function createRollbackExecutor({ ctx, sessions, agents, seam, validateMarker, writeMarker, log = () => {}, fold = foldSurface, applyIndex = applyVersionIndex }) {
  /** One in-flight rollback per session; later ops wait for the earlier one. */
  const locks = new Map()

  /** 本执行器的会话注册表（已注册消息投影从这里读；见上方 import 注释）。 */
  const sessionStore = () => sessions ?? ctx?.sessions ?? null
  setSessionProjectionsSource(sessionStore)

  function locked(sessionId, fn) {
    const previous = locks.get(sessionId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(fn)
    locks.set(sessionId, next)
    void next.finally(() => {
      if (locks.get(sessionId) === next) locks.delete(sessionId)
    }).catch(() => {})
    return next
  }

  function requireSession(sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw editorError('bad-request', 'sessionId must be a non-empty string')
    }
    const session = sessions.get(sessionId)
    if (!session) throw editorError('session-not-found', `session "${sessionId}" not found`)
    return session
  }

  function requireIdle(sessionId) {
    const agent = seam.agentOf?.(sessionId)
    if (agent && typeof agent.status === 'string' && agent.status === 'running') {
      throw editorError('agent-busy', 'The agent is still responding; stop the current reply before rolling back.')
    }
  }

  function versionOf(sessionId, versionId) {
    const snap = seam.snapshot(sessionId)
    const record = (snap.versions ?? []).find((v) => v.versionId === versionId)
    if (!record) throw editorError('version-not-found', `version "${versionId}" not found in session "${sessionId}"`)
    return record
  }

  function cwdOf(session) {
    return typeof session.header?.cwd === 'string' ? session.header.cwd : null
  }

  /**
   * The target surface (seq set) at the version boundary, with a DEGRADED
   * fallback. The strict kernel fold is the authority, but it validates every
   * event as a whole-log contract: one real malformed row poisons the entire
   * replay. Measured on the user's large session (2026-09-30, 38,887 events):
   * 7 `user/message` replacements written by a third party carry a NESTED array
   * inside `sourceEventSeqs` (e.g. `[28324,28334]`) ⇒ the kernel throws
   * `session event "user/message" sourceEventSeqs must densely contain
   * non-negative safe integers` ⇒ `preview()` threw BEFORE writing anything and
   * the client got `{ok:false,error:{code:'internal'}}` ("读档点无法回档").
   *
   * So: strict fold first; on failure fall back to the mirror fold
   * (`lib/version-index.js#applyVersionIndex`, the same append/splice semantics
   * inlined for the plugin realm) and NEVER silently — a warning with both the
   * degradation notice and the original error is logged. If even the mirror
   * cannot run, the failure is reported as the structured `replay-failed` code
   * (see the throw below), never as a generic `internal`.
   *
   * The mirror's own eligibility table is a SUBSET of the kernel's (measured on
   * the real log: 2 `developer/message` appends at seq 37115/38373 are surface
   * nodes for the kernel but invisible to `version-index.js:55`), so the
   * degraded diff only shadows nodes the mirror can ALSO account for in its own
   * current surface (`known`). Blind nodes are left visible — the safe side —
   * and their count is logged. With that filter the degraded diff on the real
   * 38,887-event copy equals the strict fold's on the repaired copy, node for
   * node (16 nodes, verified 2026-09-30).
   *
   * @returns {{ nodes: Set<number>, degraded: boolean, known: Set<number>|null }}
   */
  function targetSurface(session, events, record) {
    const slice = events.slice(0, record.boundarySeq + 1)
    try {
      // 独立折叠:显式传入宿主已注册的消息投影处理器(缺少时回退单参,见 foldSurfaceWithProjections)
      const target = foldSurfaceWithProjections(fold, slice, messageProjectionsOf(sessionStore()))
      return { nodes: new Set(target.nodes), degraded: false, known: null }
    } catch (error) {
      const strictReason = error instanceof Error ? error.message : String(error)
      // 退化留痕(不静默):日志含「严格折叠失败→镜像回退」与原始错误信息。
      log(`retrace: rollback 严格折叠失败→镜像回退 (strict fold failed → mirror fold) boundarySeq=${record.boundarySeq} versionId=${record.versionId}: ${strictReason}`)
      let nodes
      let known
      try {
        // 单次遍历:前缀 → 目标面;其余 → 镜像自己的"当前面"(用于剔除镜像看不见的节点)。
        const boundary = Math.min(record.boundarySeq, events.length - 1)
        let state = createVersionIndexState()
        for (let i = 0; i <= boundary; i += 1) state = applyIndex(state, events[i])
        const target = state.surface.slice()
        for (let i = boundary + 1; i < events.length; i += 1) state = applyIndex(state, events[i])
        nodes = new Set(target)
        known = new Set(state.surface)
      } catch (mirrorError) {
        const mirrorReason = mirrorError instanceof Error ? mirrorError.message : String(mirrorError)
        log(`retrace: rollback 镜像回退亦失败 (mirror fold failed too) boundarySeq=${record.boundarySeq} versionId=${record.versionId}: ${mirrorReason}`)
        throw editorError(
          'replay-failed',
          `cannot replay session "${session?.id ?? '?'}" up to seq ${record.boundarySeq}: strict fold failed (${strictReason}); mirror fold failed too (${mirrorReason}). `
          + '该会话含内核无法折叠的行(常见原因:畸形 sourceEventSeqs,如嵌套数组);请先修复会话日志,或改从更早的读档点回档。',
          {
            boundarySeq: record.boundarySeq,
            versionId: record.versionId,
            strictError: strictReason,
            mirrorError: mirrorReason,
          },
        )
      }
      const live = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : []
      const blind = live.filter((seq) => !nodes.has(seq) && !known.has(seq)).length
      log(`retrace: rollback 已退化到镜像折叠 (degraded to mirror fold) boundarySeq=${record.boundarySeq} targetNodes=${nodes.size} mirrorCurrentNodes=${known.size} blindExcluded=${blind}`)
      return { nodes, degraded: true, known }
    }
  }

  /**
   * The surface diff of "now" vs the version boundary: every current surface
   * node absent from the version's folded surface. An empty diff means the
   * session is already at (or before) that version. `degraded` reports that the
   * target surface came from the mirror fallback (see targetSurface); in that
   * case nodes the mirror cannot account for (`known`) stay visible.
   */
  function contextDiff(session, record) {
    const events = sessionEvents(session)
    const target = targetSurface(session, events, record)
    const targetNodes = target.nodes
    const current = session.surface.nodes
    const diff = current.filter((seq) => !targetNodes.has(seq) && (target.known === null || target.known.has(seq)))
    return {
      messages: diff.length,
      diff,
      firstSeq: diff.length > 0 ? diff[0] : null,
      lastSeq: diff.length > 0 ? diff[diff.length - 1] : null,
      degraded: target.degraded,
    }
  }

  /** Realpath must stay inside the workspace and match a manifest path. */
  async function workspaceRealpath(session, relPath) {
    const cwd = cwdOf(session)
    if (!cwd) return null
    const target = await ctx.fs.resolve(relPath, { cwd })
    const root = await ctx.fs.resolve('.', { cwd })
    if (!ctx.fs.contains(root, target)) return null
    return target
  }

  /** Artifact plan for one version: per file the action and the method. */
  async function artifactPlan(session, record, git) {
    const rows = []
    const cwd = cwdOf(session)
    const headHash = git?.headHash
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        const target = cwd ? await workspaceRealpath(session, file.path) : null
        rows.push({
          path: file.path,
          action: 'delete',
          method: 'subprocess',
          safe: target !== null,
        })
        continue
      }
      if (git && headHash) {
        rows.push({ path: file.path, action: 'restore', method: 'git', safe: true })
        continue
      }
      const sha = await seam.resolveSnapshot(record.versionId, file.path)
      if (sha) {
        rows.push({ path: file.path, action: 'restore', method: 'snapshot', safe: true })
      } else {
        rows.push({ path: file.path, action: 'skip', reason: 'no-snapshot' })
      }
    }
    return { rows, git: git ? { enabled: true, headHash: git.headHash } : { enabled: false } }
  }

  /** Dry-run preview: what a rollback would remove / touch (no side effects). */
  async function preview(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    const session = requireSession(sessionId)
    const record = versionOf(sessionId, versionId)
    const context = contextDiff(session, record)
    const git = seam.configFor(sessionId).git ? await seam.gitStatus(sessionId) : null
    const artifacts = await artifactPlan(session, record, git)
    return {
      versionId,
      kind: record.kind,
      boundarySeq: record.boundarySeq,
      scope,
      context,
      artifacts,
      applicable: scope === 'context' ? context.messages > 0 : scope === 'artifacts' ? artifacts.rows.length > 0 : context.messages > 0 || artifacts.rows.length > 0,
    }
  }

  /** Delete one manifest file via `rm`, after realpath-in-workspace verification. */
  async function removeOne(session, file) {
    const target = await workspaceRealpath(session, file.path)
    if (!target) return { path: file.path, status: 'skipped', reason: 'outside-workspace' }
    const cwd = cwdOf(session)
    if (!cwd) return { path: file.path, status: 'skipped', reason: 'no-cwd' }
    const handle = ctx.subprocess.spawn({
      argv: ['rm', '--', relative(resolve(cwd), resolve(target))],
      cwd,
      stdio: { stdin: 'ignore', stdout: { maxBytes: 64 * 1024 }, stderr: { maxBytes: 64 * 1024 } },
      graceMs: 15_000,
      signal: undefined,
      env: {},
    })
    const outcome = await handle.done
    return { path: file.path, status: outcome.exitCode === 0 ? 'deleted' : 'failed' }
  }

  /** Restore one snapshot file through the sandboxed fs (CAS-guarded write). */
  async function restoreSnapshot(session, file, sha) {
    const cwd = cwdOf(session)
    if (!cwd) return { path: file.path, status: 'skipped', reason: 'no-cwd' }
    const bytes = await seam.readSnapshot(sha)
    const text = new TextDecoder().decode(bytes)
    const target = await ctx.fs.resolve(file.path, { cwd })
    let expected
    try {
      const stat = await ctx.fs.stat(target)
      if (stat && typeof stat.version === 'number') expected = { kind: 'replaceIfVersion', version: stat.version }
    } catch { /* missing file: plain create */ }
    const policy = ctx.sandboxPolicy?.resolve?.({ session, mode: 'workspace-write' })
    await ctx.fs.writeText(target, text, expected, undefined, policy)
    return { path: file.path, status: 'restored' }
  }

  /** Execute artifact rollback for one version (git first, snapshot fallback). */
  async function rollbackArtifacts(session, record, git) {
    const results = []
    const cwd = cwdOf(session)
    const gitPaths = []
    const snapshotJobs = []
    const deletes = []
    const headHash = git?.headHash
    for (const file of record.touchedFiles) {
      if (file.mode === 'deleted') {
        deletes.push(file)
        continue
      }
      if (git && headHash) {
        gitPaths.push(file.path)
        continue
      }
      const sha = await seam.resolveSnapshot(record.versionId, file.path)
      if (sha) snapshotJobs.push({ file, sha })
      else results.push({ path: file.path, status: 'skipped', reason: 'no-snapshot' })
    }
    if (gitPaths.length > 0 && cwd && headHash) {
      const outcome = await seam.gitCheckout(cwd, headHash, gitPaths)
      for (const path of gitPaths) {
        results.push({
          path,
          status: outcome.ok && outcome.checked.includes(path) ? 'restored' : outcome.ok ? 'unchanged' : 'failed',
        })
      }
    }
    for (const { file, sha } of snapshotJobs) {
      try {
        results.push(await restoreSnapshot(session, file, sha))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    for (const file of deletes) {
      try {
        results.push(await removeOne(session, file))
      } catch (error) {
        results.push({ path: file.path, status: 'failed', reason: String(error) })
      }
    }
    return results
  }

  /** Execute a rollback (callers must preview first; the host enforces confirm). */
  async function execute(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    return locked(sessionId, async () => {
      const session = requireSession(sessionId)
      requireIdle(sessionId)
      const record = versionOf(sessionId, versionId)
      const git = seam.configFor(sessionId).git ? await seam.gitStatus(sessionId) : null
      const outcome = { op: 'restore', versionId, scope, markerSeq: null, artifacts: [], context: { messages: 0 } }

      if (scope === 'context' || scope === 'both') {
        const context = contextDiff(session, record)
        const { diff } = context
        if (diff.length > 0) {
          const span = { start: diff[0], end: diff[diff.length - 1], shadowedSeqs: diff.slice() }
          if (typeof writeMarker !== 'function') {
            throw editorError('writer-unavailable', 'No marker writer (adapter) is wired; cannot restore context.')
          }
          const markerEvent = await writeMarker(session, span, { op: 'restore', targetSeq: record.boundarySeq, originalText: '' })
          await flushSafely(session)
          outcome.markerSeq = markerEvent.seq
          // degraded:true ⇒ 目标面来自镜像回退(见 targetSurface),wire 上可见,不只在日志里。
          outcome.context = { messages: diff.length, degraded: context.degraded }
        }
      }

      if (scope === 'artifacts' || scope === 'both') {
        outcome.artifacts = await rollbackArtifacts(session, record, git)
      }
      return outcome
    })
  }

  async function flushSafely(session) {
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(session)
    } catch (error) {
      log(`retrace: flush failed: ${String(error)}`)
    }
  }

  return { preview, execute }
}
