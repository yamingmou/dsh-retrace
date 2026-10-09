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
import { isAbsolute, join, relative, resolve } from 'node:path'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { foldSurface } from '@deepseek-ai/dsh-session'
// 独立折叠口径:已注册消息投影显式传给 foldSurface(官方 README.zh.md「独立构造函数和
// `foldSurface(events, projections)` 显式接收处理器」;内核 @deepseek-ai/dsh-session
// 0.1.7-rc.2 lib/index.js:486 第二参 / :1561 `get messageProjections()`)。适配器是模块级
// 单例、自身拿不到 ctx,这里把本执行器持有的会话注册表注入给它(取不到 → 单参回退)。
import { foldSurfaceWithProjections, messageProjectionsOf, mirrorSurfaceNodeSeqs, setSessionProjectionsSource, surfaceFoldOf } from './adapter/dsh.js'
import { editorError } from './host-core.js'
import { sessionEvents } from './host-compat.js'
// 备份落点与会话基座**同源**(pluginDataHome = $DSH_HOME → 活动会话基座 → 旧 home),
// 且**不在 `sessions/` 之下**(会话目录之外的硬要求)。⛔ 不硬编码某个本机绝对路径
// (波浪号家目录 / 工作区目录名都会把个人路径写进已发布包;check-发布前泄露扫描 实测判红)。
import { pluginDataHome } from './platform/session-paths.js'
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
   * replay. Measured on the user's large session (38,887 events):
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
   * node (16 nodes, verified).
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

  /**
   * Dry-run preview: what a rollback would remove / touch (no side effects).
   *
   * Carries the SAME idle gate as execute() (same requireIdle / same `agent-busy`
   * code and message): while the agent is running the preview must be refused
   * too, otherwise the panel first reports "rollback available" and the confirm
   * is then rejected — the "preview says yes, confirm says no" defect.
   */
  async function preview(args) {
    const sessionId = String(args?.sessionId ?? '')
    const versionId = String(args?.versionId ?? '')
    const scope = String(args?.scope ?? 'both')
    if (!VALID_SCOPES.includes(scope)) throw editorError('bad-scope', `scope must be one of ${VALID_SCOPES.join(', ')}`)
    const session = requireSession(sessionId)
    // idle 闸与 execute() 完全同一口径(requireIdle / agent-busy / 同一句文案):
    // 运行中预览也必须被拒,否则界面显示"可回档"、确认时才被 agent-busy 拒
    // (「预览说行、确认说不行」)。顺序也照 execute():session → idle → version。
    requireIdle(sessionId)
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

/* ═══════════════════════════════════════════════════════════════════════════
 * 「真正恢复」(true restore) —— 日志层面的遮蔽撤销(0.4.126)
 *
 * 为什么必须动日志(第 1 步调研结论,逐字依据):
 *   · 官方 surfaceOp 词表**封闭**:只有 `"append"` 与恰好三成员的
 *     `{op:'replace',startSeq,endSeq}` 两种(内核 `isReplaceOp`/`surfaceOpOf`,
 *     `@deepseek-ai/dsh-session` 0.1.7-rc.2 `lib/index.js:289-308`;迁移器同一封闭集,
 *     `dsh-session-format-v2-to-v3/lib/index.js:319-324`)。**没有** un-replace /
 *     unfold / restore / remove 之类反向操作(全 @deepseek-ai 域 grep 无命中)。
 *   · fold 语义是 append-only + replace 遮蔽:`planSurfaceEvent` 把 replace 区间
 *     `splice` 出面并插入替换节点(`lib/index.js:443-452`、`applySurfacePlan:460-472`)。
 *     ⇒ **单靠追加事件无法把已被 replace 移除的节点放回面**,这就是"真正恢复"必须
 *     改写既有日志行的根本原因(不是实现偷懒)。
 *
 * 手段 = **中和(neutralize)**:把目标 marker 的两段原地改写成 log-only 形状
 * (`type:'retrace/marker'` + `ignorable:true`,删掉 `surfaceOp`/`sourceEventSeqs`),
 * **不动 seq / 行数 / 时间 / data**:
 *   · 内核 `surfaceOpOf` 对"非 surface 词表 + 未知 type + ignorable"直接返回 undefined
 *     (`lib/index.js:295-300`)⇒ fold 跳过它、token-meter 的 shadow-price claim 随之消失;
 *   · `assertSessionEventEnvelope` 的字段白名单本就含 `ignorable`(`lib/index.js:1070-1090`);
 *   · `retrace/marker` 已在契约包 `KNOWN_IGNORABLE_CONSUMERS` 白名单里
 *     (`dsh-log-contract/lib/checks.js:444`),不触发 E7。
 *
 * 为什么**不能删**(实测,见 test/true-restore.test.js 的 seq 空洞用例):
 *   内核 `foldSurface` 按数组下标当 seq 用(`lib/index.js:486-493` 传 `SessionSeq(index)`),
 *   删行留下空洞 ⇒ `session event seq N is not contiguous; expected M`(`:423`)整库不可折叠;
 *   契约包同时报 E2 error(`dsh-log-contract/lib/checks.js` 的 strictScan/E2)。
 *   ⇒ 删除路线**被证伪**,中和是唯一可行形状。
 *
 * 安全闸(缺一不可,全部在**任何写入之前**):
 *   ① 占用闸:lsof 无持有者 + 目标会话不在运行(轮边界外);
 *   ② 当前会话闸:调用方正在看的会话 == 目标 ⇒ 拒绝("请先切走/关闭该会话再恢复");
 *   ③ 折叠预演:中和后的**全量日志必须仍能折叠**,且目标区间**必须真的回到面上**
 *      —— 否则零写入拒绝(被更晚的 replace 重新遮蔽 = 需先恢复更晚那枚);
 *   ④ 备份:原文件按字节复制到会话目录**之外**;
 *   ⑤ 帧级最小改写:只重压含目标行的帧,其余帧字节逐字节不动;先写临时文件再 rename;
 *   ⑥ 写后校验:重读逐帧解压(0 坏帧)+ 其余行逐字节相等 + 行数不变 + 折叠重放证明;
 *      任一条不过 ⇒ 用备份**字节级回滚**并 fail-loud;
 *   ⑦ 幂等:已是中和态 ⇒ 零写入返回 alreadyRestored。
 * ═════════════════════════════════════════════════════════════════════════ */

/** zstd magic(小端 u32;`28 b5 2f fd`)。 */
const ZSTD_MAGIC = 0xfd2fb528
/** 中和后的 type:非 surface 词表 + ignorable ⇒ 官方 fold 与 token-meter 双跳过。 */
export const NEUTRALIZED_MARKER_TYPE = 'retrace/marker'
/** 临时文件后缀(rename 之前;与真实文件名不同,故不会被当作会话文件扫到)。 */
const TRUE_RESTORE_TMP_SUFFIX = '.retrace-tmp'

/**
 * 扫描 zstd 帧边界(不改写、不解压)。
 *
 * 与官方 `@deepseek-ai/dsh-session-persistence-jsonl` 的 `scanZstdFrames` **同算法**
 * (该文件 `lib/index.js:1294-1360`):`payloadBytes = blockType === 1 ? 1: blockSize`
 * (Raw_Block=Block_Size / RLE_Block=1 字节 / Compressed_Block=Block_Size)。
 * 差异:撕裂尾帧**不抛**,返回 tornStart 交调用方 fail-closed(官方抛错,入口语义不同)。
 * @param {Buffer} buf - 文件全字节
 * @returns {{frames: Array<{start:number,end:number,checksum:boolean}>, tornStart: number|null, reason: string|null}}
 */
export function scanZstdFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const start = offset
    if (buf.length - offset < 4) return { frames, tornStart: start, reason: 'truncated-magic' }
    if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return { frames, tornStart: start, reason: `invalid-magic-at-${offset}` }
    offset += 4
    if (offset === buf.length) return { frames, tornStart: start, reason: 'truncated-descriptor' }
    const descriptor = buf.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) return { frames, tornStart: start, reason: `reserved-header-bit-at-${offset - 1}` }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buf.length - offset < remainingHeaderBytes) return { frames, tornStart: start, reason: 'truncated-frame-header' }
    offset += remainingHeaderBytes
    for (;;) {
      if (buf.length - offset < 3) return { frames, tornStart: start, reason: 'truncated-block-header' }
      const blockHeader = buf.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) return { frames, tornStart: start, reason: `reserved-block-type-at-${offset - 3}` }
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buf.length - offset < payloadBytes) return { frames, tornStart: start, reason: 'truncated-block-payload' }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buf.length - offset < 4) return { frames, tornStart: start, reason: 'truncated-checksum' }
      offset += 4
    }
    frames.push({ start, end: offset, checksum })
  }
  return { frames, tornStart: null, reason: null }
}

/** 与官方 writer 同款:单帧、带校验和(`dsh-session-persistence-jsonl` 的 CHECKSUM_OPTIONS)。 */
function compressFrame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'), { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } })
}

/**
 * 逐帧解压成"帧 → 整行文本"。要求每帧明文以 `\n` 结尾(帧边界 = 行边界)。
 * @returns {{frames: Array<{start:number,end:number,checksum:boolean}>, texts: string[], lines: Array<{text:string,frame:number}>, headerLine: string}}
 */
function decodeLogFrames(buf) {
  const scan = scanZstdFrames(buf)
  if (scan.tornStart !== null) {
    throw editorError('log-damaged', `会话日志的 zstd 帧结构不完整(${scan.reason} @ byte ${scan.tornStart})——不重写损坏日志,请先用 dsh-log-contract 修复`, { tornStart: scan.tornStart, reason: scan.reason })
  }
  const texts = []
  const lines = []
  scan.frames.forEach((frame, index) => {
    let text
    try {
      text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8')
    } catch (error) {
      throw editorError('log-damaged', `第 ${index} 个 zstd 帧解压失败(${String(error?.message ?? error)})——不重写损坏日志`, { frame: index })
    }
    if (text.length > 0 && !text.endsWith('\n')) {
      throw editorError('log-not-line-aligned', `第 ${index} 个 zstd 帧明文不以换行结尾(帧边界不是行边界)——本工具只做行级最小改写,拒绝猜测`, { frame: index })
    }
    texts.push(text)
    const frameLines = text.split('\n')
    for (let inFrame = 0; inFrame < frameLines.length; inFrame++) {
      const line = frameLines[inFrame]
      if (line.length > 0) lines.push({ text: line, frame: index, inFrame })
    }
  })
  if (lines.length === 0) throw editorError('log-damaged', '会话日志没有任何行')
  return { frames: scan.frames, texts, lines, headerLine: lines[0].text }
}

/**
 * 中和一个事件:保留 `seq/time/data`,改成 log-only 形状。
 * 纯函数(单测直接钉形状)。
 * @param {object} event - 原事件(任何 surface 载体)
 * @returns {object} 中和后的事件
 */
export function neutralizeMarkerEvent(event) {
  const out = { type: NEUTRALIZED_MARKER_TYPE, seq: event.seq }
  if (event.time !== undefined) out.time = event.time
  out.data = event.data
  out.ignorable = true
  return out
}

/** 事件是否已是"中和态"(幂等判据;形状与 neutralizeMarkerEvent 严格对应)。 */
export function isNeutralizedEvent(event) {
  return event?.type === NEUTRALIZED_MARKER_TYPE
    && event.ignorable === true
    && event.surfaceOp === undefined
    && event.sourceEventSeqs === undefined
}

/**
 * 是否是「遮蔽载体」:replace 区间**恰好三成员**(v3 `startSeq/endSeq` 与 v0 旧形
 * `start/end` 都认;判据与内核 `isReplaceOp` 同构,双形状由 spanRangeOf 归一)。
 */
export function isReplaceCarrier(event) {
  const op = event?.surfaceOp
  if (op === undefined || op === 'append') return false
  if (op === null || typeof op !== 'object' || Array.isArray(op)) return false
  if (Object.keys(op).length !== 3 || op.op !== 'replace') return false
  const v3 = Number.isSafeInteger(op.startSeq) && Number.isSafeInteger(op.endSeq)
  const v0 = Number.isSafeInteger(op.start) && Number.isSafeInteger(op.end)
  return v3 || v0
}

/** replace 区间展开成连续整数序列(仅在载体缺 provenance 时兜底)。 */
export function expandSurfaceOpRange(op) {
  const start = Number.isSafeInteger(op?.startSeq) ? op.startSeq : Number.isSafeInteger(op?.start) ? op.start : null
  const end = Number.isSafeInteger(op?.endSeq) ? op.endSeq : Number.isSafeInteger(op?.end) ? op.end : null
  if (start === null || end === null || end < start) return []
  const out = []
  for (let seq = start; seq <= end; seq++) out.push(seq)
  return out
}

/**
 * 磁盘存储形 `sourceEventSeqs` → 内存**稠密**序列(C1)。
 *
 * 为什么必须有这一步:磁盘上 sourceEventSeqs 是**区间编码**的
 * (`[start,end]` 对与整数混排),而内核 fold 只认稠密非负安全整数 —— 直接拿盘上事件
 * 去 fold 会抛 `session event "user/message" sourceEventSeqs must densely contain
 * non-negative safe integers`(实测于本机 v4 活件)。官方读路径在
 * **读取层唯一入口**就做这个展开(`dsh-log-contract/lib/compat.js` 的
 * `decodeSeqRanges` + `normalizeEventSeqRanges`,注释明写"下游 S5/S6 与官方
 * `foldSurface` 都按稠密整数序列判定")。这里做**同一件事**(判据同构):
 * 整数原样通过、`[s,e]` 展开为 s..e;出现范围编码时要求整体严格递增,否则**原样返回**
 * 让 fold 自己 fail-loud(而不是我们悄悄"修好"一个畸形日志)。
 * ⚠️ 只用于**折叠输入**;回写磁盘的行保持盘上原形(最小改写)。
 * @param {unknown} value - 事件上的 sourceEventSeqs
 * @returns {unknown} 稠密数组(无需展开时原样返回)
 */
export function normalizeStorageSeqRanges(value) {
  if (!Array.isArray(value)) return value
  const out = []
  let hasRange = false
  for (const entry of value) {
    if (typeof entry === 'number') { out.push(entry); continue }
    if (!Array.isArray(entry) || entry.length !== 2
      || !Number.isSafeInteger(entry[0]) || !Number.isSafeInteger(entry[1]) || entry[1] < entry[0]) return value
    hasRange = true
    for (let seq = entry[0]; seq <= entry[1]; seq++) out.push(seq)
  }
  if (!hasRange) return value
  for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) return value
  return out
}

/** 折叠输入用的事件视图(存储形 → 内存形;见 normalizeStorageSeqRanges)。 */
function foldViewOf(event) {
  if (!Array.isArray(event?.sourceEventSeqs)) return event
  const normalized = normalizeStorageSeqRanges(event.sourceEventSeqs)
  return normalized === event.sourceEventSeqs ? event : { ...event, sourceEventSeqs: normalized }
}

/** `seq → 事件`(行内事件;要求行序即 seq 序,否则 fail-closed)。 */
function eventsOfLines(lines) {
  const events = []
  for (let i = 1; i < lines.length; i++) {
    let parsed
    try {
      parsed = JSON.parse(lines[i].text)
    } catch (error) {
      throw editorError('log-damaged', `第 ${i + 1} 行不是合法 JSON(${String(error?.message ?? error)})——拒绝在无法完整解析的日志上做手术`, { line: i + 1 })
    }
    if (Number(parsed?.seq) !== events.length) {
      throw editorError(
        'log-layout-unsupported',
        `第 ${i + 1} 行的 seq=${String(parsed?.seq)} 与行位置 ${events.length} 不一致(分块行/交织日志)——本工具只支持"一行一事件且 seq==行序"的日志;拒绝猜测`,
        { line: i + 1, seq: parsed?.seq, expected: events.length },
      )
    }
    events.push(foldViewOf(parsed))
  }
  return events
}

/** 用注入的严格 fold 取面节点;严格 fold 整体抛错时退到镜像折(与 adapter 同口径)并标注 strict:false。 */
function foldNodesOf(events, { fold, mirror }) {
  try {
    const folded = fold(events)
    if (Array.isArray(folded?.nodes)) return { nodes: folded.nodes, strict: true, error: null }
  } catch (error) {
    return { nodes: mirror(events), strict: false, error: String(error?.message ?? error) }
  }
  return { nodes: mirror(events), strict: false, error: 'fold 未返回 nodes(退回镜像折)' }
}

/** 默认 lsof 探针:`lsof -nP -t <file>`。退出码 1 = 无持有者(正常);lsof 缺失 ⇒ available:false(fail-closed)。 */
function defaultLsof(file) {
  try {
    const out = execFileSync('lsof', ['-nP', '-t', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { available: true, holders: String(out).split('\n').map((s) => s.trim()).filter(Boolean) }
  } catch (error) {
    if (error?.code === 'ENOENT') return { available: false, holders: [] }
    if (error?.status === 1 || error?.code === 1) return { available: true, holders: [] }
    return { available: false, holders: [], error: String(error?.message ?? error) }
  }
}

/**
 * 默认备份根:`<pluginDataHome>/dsh-retrace/true-restore-backups/<YYYYMMDD>/`
 * —— **不在 `sessions/` 之下**(会话目录之外的硬要求),与会话基座同源,
 * 故 $DSH_HOME 一变备份也跟着走(测试里被沙箱指向 tmp,绝不会写活家)。
 * @param {Date} [now]
 * @returns {string}
 */
export function defaultBackupRoot(now = new Date()) {
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return join(pluginDataHome(), 'dsh-retrace', 'true-restore-backups', stamp)
}

/**
 * 创建「真正恢复」执行器(日志层面遮蔽撤销)。
 *
 * @param {object} [deps]
 * @param {(events: object[]) => {nodes: number[]}} [deps.fold] - 严格折叠(默认 adapter 的 surfaceFoldOf)
 * @param {(events: object[]) => number[]} [deps.mirror] - 镜像折(严格 fold 失败时的回退)
 * @param {(file: string) => {available: boolean, holders: string[]}} [deps.lsof] - 占用探针(测试注入)
 * @param {() => string} [deps.backupRoot] - 备份目录(默认 defaultBackupRoot())
 * @param {() => Date} [deps.now]
 * @param {(line: string) => void} [deps.log]
 * @returns {{restore: (args: object) => Promise<object>}}
 */
export function createTrueRestore({ fold = surfaceFoldOf, mirror = mirrorSurfaceNodeSeqs, lsof = defaultLsof, backupRoot = () => defaultBackupRoot(), now = () => new Date(), log = () => {} } = {}) {
  /**
   * 真正恢复一枚 marker(中和它的两段)。
   * @param {object} args
   * @param {string} args.file - 会话日志绝对路径
   * @param {number} args.carrierSeq - 载体(user/message + replace)seq
   * @param {number|null} [args.auditSeq] - 配对审计(compaction/prune)seq
   * @param {number[]} [args.shadowedSeqs] - 被遮蔽节点 seq(有效性判据)
   * @param {string} [args.sessionId]
   * @param {string} [args.currentSessionId] - 调用方正看着的会话(== 目标 ⇒ 拒绝)
   * @param {boolean} [args.running] - 目标会话在跑(round 中)
   * @param {boolean} [args.dryRun] - 只预演,不写盘
   */
  async function restore(args) {
    const file = typeof args?.file === 'string' ? args.file : ''
    const carrierSeq = Number(args?.carrierSeq)
    const wantAudit = Number.isSafeInteger(Number(args?.auditSeq)) ? Number(args.auditSeq) : null
    const shadowedSeqs = Array.isArray(args?.shadowedSeqs)
      ? [...new Set(args.shadowedSeqs.filter((s) => Number.isSafeInteger(s) && s >= 0))]
      : []
    const sessionId = String(args?.sessionId ?? '')
    const dryRun = args?.dryRun === true
    if (file === '' || !Number.isSafeInteger(carrierSeq) || carrierSeq < 0) {
      throw editorError('bad-request', 'trueRestore needs { file, carrierSeq }')
    }
    // ── 闸① 备份目录必须落在会话目录之外 ────────────────────────────────────
    const backupDir = String(backupRoot() ?? '')
    if (backupDir === '' || resolve(backupDir) === resolve(file) || resolve(file).startsWith(`${resolve(backupDir)}/`)) {
      throw editorError('bad-request', `备份目录必须与会话文件分离(备份 ${backupDir} / 会话 ${file})`)
    }
    // ── 读盘 + 帧级解析 ────────────────────────────────────────────────────
    if (!existsSync(file)) throw editorError('session-file-not-found', `会话文件不存在:${file}`, { file })
    const before = readFileSync(file)
    const { frames, texts, lines } = decodeLogFrames(before)
    const events = eventsOfLines(lines)
    // ── 定位两段(幂等优先)────────────────────────────────────────────────
    const carrierEvent = events[carrierSeq]
    if (!carrierEvent) throw editorError('target-not-found', `日志里没有 seq=${carrierSeq} 的事件`, { carrierSeq })
    // 溯源一律以**磁盘**为准(宿主内存视图可能已被事件管道剥掉顶层 provenance):
    //   配对审计 = sourceEventSeqs 首项且其行确为 compaction/prune;
    //   被遮蔽集合 = sourceEventSeqs 去掉审计首项;拿不到 provenance 就按 surfaceOp 区间展开兜底。
    const cited = Array.isArray(carrierEvent.sourceEventSeqs)
      ? carrierEvent.sourceEventSeqs.filter((s) => Number.isSafeInteger(s) && s >= 0)
      : []
    const auditFromDisk = cited.length > 0 && events[cited[0]]?.type === 'compaction/prune' ? cited[0] : null
    const auditSeq = wantAudit !== null ? wantAudit : auditFromDisk
    const auditEvent = auditSeq !== null ? events[auditSeq] : null
    // 幂等闸(先于载体形状判):载体**与**配对审计都已是中和态 ⇒ 零写入。
    // (半中和态不早退,落到下面的写路径补齐;幂等态本就不是 replace 载体,故必须先判。)
    if (isNeutralizedEvent(carrierEvent) && (auditSeq === null || isNeutralizedEvent(auditEvent))) {
      return {
        ok: true, alreadyRestored: true, zeroWrite: true, file, sessionId,
        carrierSeq, auditSeq, markerId: String(carrierEvent.data?.id ?? ''),
        frames: { total: frames.length, rewritten: [] },
      }
    }
    if (!isReplaceCarrier(carrierEvent)) {
      throw editorError('target-not-a-carrier', `seq=${carrierSeq} 不是遮蔽载体(user/message + replace),实际 ${String(carrierEvent.type)}/surfaceOp=${JSON.stringify(carrierEvent.surfaceOp ?? null)}——只有载体决定遮蔽,拒绝改写`, { carrierSeq })
    }
    const derivedShadowed = cited.length > 0
      ? cited.filter((s) => s !== auditSeq)
      : expandSurfaceOpRange(carrierEvent.surfaceOp)
    const shadowed = shadowedSeqs.length > 0 ? shadowedSeqs : derivedShadowed
    const carrierLine = lines[carrierSeq + 1]
    if (!carrierLine || carrierLine.frame === 0) {
      throw editorError('target-not-on-its-own-line', `seq=${carrierSeq} 的载体不在独立行上(分块行?)——拒绝改写`, { carrierSeq })
    }
    let auditLine = null
    if (auditSeq !== null) {
      if (!auditEvent) throw editorError('target-not-found', `日志里没有配对审计 seq=${auditSeq}`, { auditSeq })
      if (!isNeutralizedEvent(auditEvent) && auditEvent.type !== 'compaction/prune') {
        throw editorError('target-not-paired', `seq=${auditSeq} 不是配对审计段(compaction/prune),实际 ${String(auditEvent.type)}——拒绝改写`, { auditSeq })
      }
      auditLine = lines[auditSeq + 1]
      if (!auditLine || auditLine.frame === 0) {
        throw editorError('target-not-on-its-own-line', `seq=${auditSeq} 的审计段不在独立行上(分块行?)——拒绝改写`, { auditSeq })
      }
    }
    // ── 折叠预演(任何写入之前;两条硬判据)──────────────────────────────────
    const afterEvents = events.map((event, seq) => {
      if (seq === carrierSeq) return neutralizeMarkerEvent(event)
      if (auditSeq !== null && seq === auditSeq) return neutralizeMarkerEvent(event)
      return event
    })
    const foldBefore = foldNodesOf(events, { fold, mirror })
    const foldAfter = foldNodesOf(afterEvents, { fold, mirror })
    const afterSet = new Set(foldAfter.nodes)
    const stillHidden = shadowed.filter((seq) => !afterSet.has(seq))
    const nodeLine = (result) => ({
      nodes: result.nodes.length,
      first: result.nodes.length > 0 ? result.nodes[0] : null,
      last: result.nodes.length > 0 ? result.nodes[result.nodes.length - 1] : null,
      strict: result.strict,
      ...(result.error ? { foldError: result.error } : {}),
    })
    const surface = { before: nodeLine(foldBefore), after: nodeLine(foldAfter), restored: shadowed.length - stillHidden.length, shadowedTotal: shadowed.length, stillHidden }
    if (shadowed.length > 0 && stillHidden.length > 0) {
      const errors = []
      for (let seq = carrierSeq + 1; seq < afterEvents.length; seq++) {
        const op = afterEvents[seq]?.surfaceOp
        const cited = Array.isArray(afterEvents[seq]?.sourceEventSeqs) ? afterEvents[seq].sourceEventSeqs : null
        if (!op) continue
        const covers = stillHidden.some((target) => cited !== null && cited.includes(target))
        if (covers) errors.push(seq)
      }
      throw editorError(
        'restore-re-shadowed',
        `中和后目标区间仍被更晚的标记遮蔽(seq ${stillHidden.join(', ')} 不在面上,被更晚的 replace 覆盖${errors.length > 0 ? `:seq ${errors.slice(0, 5).join(', ')}` : ''})——请先真正恢复更晚那枚标记`,
        { carrierSeq, stillHidden, covering: errors },
      )
    }
    // ── 闸② 占用(torn 已在 decode 阶段拦下)──────────────────────────────
    if (dryRun !== true) {
      const probe = lsof(file)
      if (probe.available !== true) {
        throw editorError('lsof-unavailable', `无法确认会话文件是否被进程持有(lsof 不可用${probe.error ? `:${probe.error}` : ''})——占用闸 fail-closed,拒绝执行`, { file })
      }
      if (probe.holders.length > 0) {
        throw editorError('session-held', `会话文件正被进程持有(PID ${probe.holders.join(', ')})——请先关闭占用它的进程/切走该会话再恢复`, { file, holders: probe.holders })
      }
    }
    if (args?.running === true) {
      throw editorError('session-running', '目标会话正在运行(轮次进行中)——请等本轮结束、切走该会话后再恢复', { sessionId })
    }
    const currentSessionId = String(args?.currentSessionId ?? '')
    if (currentSessionId !== '' && currentSessionId === sessionId) {
      throw editorError('session-active', '这是你当前正在查看的会话:请先切走到别的会话(或关闭该会话)再执行「真正恢复」——就地改写正在使用的会话会让内存视图与磁盘分叉', { sessionId })
    }
    // ── 帧级最小改写 ──────────────────────────────────────────────────────
    const replacements = new Map([
      [carrierSeq + 1, neutralizeMarkerEvent(carrierEvent)],
      ...(auditSeq !== null ? [[auditSeq + 1, neutralizeMarkerEvent(auditEvent)]] : []),
    ])
    const rewrittenFrames = new Set()
    const outBuffers = []
    frames.forEach((frame, index) => {
      const touched = [...replacements.keys()].filter((lineIdx) => lines[lineIdx]?.frame === index)
      if (touched.length === 0) {
        outBuffers.push(before.subarray(frame.start, frame.end))
        return
      }
      const frameLines = texts[index].split('\n')
      frameLines.pop() // 末尾空串(帧以 \n 结尾)
      for (const lineIdx of touched) {
        const inFrame = lines[lineIdx].inFrame
        if (typeof inFrame !== 'number' || frameLines[inFrame] !== lines[lineIdx].text) {
          throw editorError('internal', `帧内定位目标行失败(line ${lineIdx + 1} @ frame ${index})`, { line: lineIdx + 1, frame: index })
        }
        frameLines[inFrame] = JSON.stringify(replacements.get(lineIdx))
      }
      outBuffers.push(compressFrame(`${frameLines.join('\n')}\n`))
      rewrittenFrames.add(index)
    })
    const next = Buffer.concat(outBuffers)
    log(`retrace: trueRestore 预演通过(seq ${carrierSeq}${auditSeq !== null ? `/${auditSeq}` : ''}):面节点 ${surface.before.nodes}→${surface.after.nodes},恢复 ${surface.restored}/${surface.shadowedTotal},重压帧 [${[...rewrittenFrames].join(',')}]/${frames.length}`)
    if (dryRun === true) {
      return {
        ok: true, dryRun: true, zeroWrite: true, file, sessionId, carrierSeq, auditSeq,
        frames: { total: frames.length, rewritten: [...rewrittenFrames], bytesBefore: before.length, bytesAfter: next.length },
        surface,
      }
    }
    // ── 备份(会话目录之外)─────────────────────────────────────────────────
    const stamp = now().toISOString().replace(/[:.]/g, '-')
    mkdirSync(backupDir, { recursive: true })
    const backupPath = join(backupDir, `${file.split('/').pop() ?? 'session'}-${stamp}.backup`)
    copyFileSync(file, backupPath)
    const backupSize = statSync(backupPath).size
    if (backupSize !== before.length) {
      throw editorError('backup-failed', `备份大小不符(备份 ${backupSize} ≠ 原文件 ${before.length})——零写入中止`, { backupPath })
    }
    // ── 原子替换:临时文件 → rename ────────────────────────────────────────
    const tmpPath = `${file}${TRUE_RESTORE_TMP_SUFFIX}`
    try {
      writeFileSync(tmpPath, next)
      renameSync(tmpPath, file)
    } catch (error) {
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch { /* 清理失败不掩盖主错误 */ }
      throw editorError('write-failed', `写入会话文件失败(${String(error?.message ?? error)})——原文件未改动`, { file, backupPath })
    }
    // ── 写后校验(必须;任一条不过 ⇒ 用备份字节级回滚)──────────────────────
    const verify = verifyWritten({ file, before, next, lines, frameCount: frames.length, events, carrierSeq, auditSeq, shadowed, fold, mirror })
    if (verify.ok !== true) {
      let rolledBack = false
      try {
        copyFileSync(backupPath, file)
        rolledBack = Buffer.compare(readFileSync(file), before) === 0
      } catch (error) {
        log(`retrace: trueRestore 回滚失败:${String(error?.message ?? error)}`)
      }
      throw editorError(
        'verify-failed',
        `写后校验失败(${verify.reason})——已${rolledBack ? '' : '尝试'}用备份回滚(${rolledBack ? '字节级一致' : '回滚未确认,请手工用备份恢复'}):${backupPath}`,
        { file, backupPath, rolledBack, ...verify.details },
      )
    }
    return {
      ok: true, alreadyRestored: false, zeroWrite: false, file, sessionId, carrierSeq, auditSeq,
      markerId: String(carrierEvent.data?.id ?? ''),
      backupPath,
      frames: { total: frames.length, rewritten: [...rewrittenFrames], bytesBefore: before.length, bytesAfter: next.length },
      surface,
      verify,
    }
  }

  /** 写后校验:重读逐帧解压 + 逐行字节对比 + 折叠重放。 */
  function verifyWritten({ file, before, next, lines, frameCount, events, carrierSeq, auditSeq, shadowed, fold, mirror }) {
    let disk
    try {
      disk = readFileSync(file)
    } catch (error) {
      return { ok: false, reason: `重读失败:${String(error?.message ?? error)}` }
    }
    const decoded = (() => {
      try { return { value: decodeLogFrames(disk) } } catch (error) { return { error: String(error?.message ?? error) } }
    })()
    if (decoded.error) return { ok: false, reason: `重读后帧结构/解压失败:${decoded.error}` }
    const after = decoded.value
    // ① 坏帧 0(decodeLogFrames 已逐帧解压)+ 帧数不变
    if (after.frames.length === 0) return { ok: false, reason: '重读后 0 帧(坏帧)' }
    if (after.frames.length !== frameCount) {
      return { ok: false, reason: `帧数变了(${frameCount} → ${after.frames.length})`, details: { framesBefore: frameCount, framesAfter: after.frames.length } }
    }
    // ② 行数不变(⇒ seq 空间不变,不会撞号)
    if (after.lines.length !== lines.length) {
      return { ok: false, reason: `行数变了(${lines.length} → ${after.lines.length}):seq 空间必须逐字不变`, details: { linesBefore: lines.length, linesAfter: after.lines.length } }
    }
    // ③ 目标两行:已中和 + **seq 保留** + **data 逐字保留**(只动信封);其余行逐字节相等
    const targets = new Set([carrierSeq + 1, ...(auditSeq !== null ? [auditSeq + 1] : [])])
    for (let i = 0; i < lines.length; i++) {
      if (targets.has(i)) {
        let parsed
        try { parsed = JSON.parse(after.lines[i].text) } catch { return { ok: false, reason: `第 ${i + 1} 行中和后不是合法 JSON` } }
        if (!isNeutralizedEvent(parsed)) return { ok: false, reason: `第 ${i + 1} 行未中和(surfaceOp/sourceEventSeqs 仍在或 type 不符)` }
        if (parsed.seq !== i - 1) return { ok: false, reason: `第 ${i + 1} 行的 seq 被改动(${String(parsed.seq)} ≠ ${i - 1})——seq 空间必须逐字不变` }
        if (JSON.stringify(parsed.data) !== JSON.stringify(events[i - 1]?.data)) {
          return { ok: false, reason: `第 ${i + 1} 行的 data 被改动(中和只允许改信封:type/ignorable,删 surfaceOp/sourceEventSeqs)` }
        }
        continue
      }
      if (after.lines[i].text !== lines[i].text) return { ok: false, reason: `第 ${i + 1} 行被意外改动(非目标行必须逐字节不动)` }
    }
    // ④ 折叠重放证明
    const afterEvents = (() => {
      try { return { value: eventsOfLines(after.lines) } } catch (error) { return { error: String(error?.message ?? error) } }
    })()
    if (afterEvents.error) return { ok: false, reason: `重读后事件序列不可用:${afterEvents.error}` }
    const foldBefore = foldNodesOf(events, { fold, mirror })
    const foldAfter = foldNodesOf(afterEvents.value, { fold, mirror })
    const afterSet = new Set(foldAfter.nodes)
    const missing = shadowed.filter((seq) => !afterSet.has(seq))
    if (missing.length > 0) return { ok: false, reason: `折叠重放证明失败:恢复后仍有 ${missing.join(', ')} 不在面上`, details: { missing } }
    const wasShadowed = shadowed.filter((seq) => !new Set(foldBefore.nodes).has(seq))
    return {
      ok: true,
      framesChecked: after.frames.length,
      // 判据名与判据严格对应(不写含糊的 "bytesEqual":目标两行**本来就该变**,
      // 逐字节相等只承诺**其余行**)。
      unchangedLinesByteEqual: true,
      targetLinesNeutralized: targets.size,
      seqPreserved: true,
      dataPreserved: true,
      lineCount: after.lines.length,
      surfaceBefore: { nodes: foldBefore.nodes.length, first: foldBefore.nodes[0] ?? null, last: foldBefore.nodes[foldBefore.nodes.length - 1] ?? null, strict: foldBefore.strict },
      surfaceAfter: { nodes: foldAfter.nodes.length, first: foldAfter.nodes[0] ?? null, last: foldAfter.nodes[foldAfter.nodes.length - 1] ?? null, strict: foldAfter.strict },
      shadowedBefore: wasShadowed.length,
      restoredAfter: shadowed.length - missing.length,
      seqGap: false, // 行数不变 ⇒ seq 空间不变(且上面逐行断言了目标行 seq 保留)
      bytesBefore: before.length,
      bytesAfter: disk.length,
      expectedBytes: next.length,
    }
  }

  return { restore }
}

export { defaultLsof as __defaultLsof }
