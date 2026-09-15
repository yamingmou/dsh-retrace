/**
 * dsh-retrace — HTTP route aggregation for `/api/plugins/retrace/*`.
 *
 * Serves both the published-client transports and the versioning surface:
 *
 *   POST /api/plugins/retrace/{recall|editAndResend|regenerate}
 *     — the L1 editor ops (unchanged wire shape from 0.2.x).
 *   GET  /api/plugins/retrace/versions?sessionId=
 *     — live projection snapshot (HTTP fallback channel; the push channel is
 *       `session/projection` frames via dsh-host-apiproxy).
 *   GET  /api/plugins/retrace/forkmap?sessionId=
 *     — the fork-map projection snapshot (branch topology, P2.1; same
 *       push-frame + HTTP fallback dual channel as /versions).
 *   GET  /api/plugins/retrace/event?sessionId=&seq=&before=&after=
 *     — one event + context window (sessionQuery.readEvent, lazy reads).
 *   GET  /api/plugins/retrace/surface?sessionId=
 *     — current model surface (sessionQuery.readSurface).
 *   POST /api/plugins/retrace/rollback/preview
 *     — dry-run: messages removed + artifact actions (no side effects).
 *   POST /api/plugins/retrace/rollback
 *     — execute the rollback ({sessionId, versionId, scope}).
 *   GET  /api/plugins/retrace/git/status?sessionId=
 *     — repo detection + HEAD + dirty (timeline git banner).
 *   POST /api/plugins/retrace/git/init
 *     — one-click git init for a non-repository workspace (user-confirmed).
 *   GET  /api/plugins/retrace/doctor?sessionId=
 *     — compression pre-check: scan for token-meter-breaking turn-null markers
 *       (B1, incident root cause 3) — read-only.
 *   GET  /api/plugins/retrace/snapshot?sessionId=&versionId=&path=
 *     — read one version's snapshot content (rollback preview / detail).
 *   GET|POST /api/plugins/retrace/runningState[?sessionId=]
 * — 关闭守卫 V2 :全会话运行中清单 { running: [...] }(或单会话
 *       runningState)——client beforeunload 拦截的同步读缓存源(纯读,复用
 *       lib/close-guard.js runningSessions)。
 *
 * Per PLAN.md §4.6 the client carries its localStorage config on every
 * request as `x-retrace-config: {"versioning":bool,"git":bool,
 * "retentionLimit":n}`; the host honors it per request and does not persist
 * it. A missing/malformed header falls back to the plugin defaults.
 */
import { createEditorApi } from './host-core.js'
import { dshAdapter } from './adapter/dsh.js'
// span 显式状态 → 业务层判定输入(与 index.js harness 入口同一处理)
import { spanMissArgsOf } from './span-semantics.js'
import { runningSessions, sessionRunningState } from './close-guard.js'
import { latestByBoundary, readSummaries, renderSummariesMarkdown } from './summary-store.js'
import { boundaryTreeOf } from './boundary-tree.js'

export const ROUTE_PREFIX = '/api/plugins/retrace'
const MAX_BODY_BYTES = 64 * 1024

/** Default per-request config (client overrides via the header). */
export const DEFAULT_CONFIG = { versioning: true, git: true, retentionLimit: 50, prewrite: true, summary: false }

/** Parse the `x-retrace-config` request header (tolerant of garbage). */
export function parseRetraceConfig(raw) {
  const config = { ...DEFAULT_CONFIG }
  if (typeof raw !== 'string' || raw.length === 0) return config
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed.versioning === 'boolean') config.versioning = parsed.versioning
    if (typeof parsed.git === 'boolean') config.git = parsed.git
    if (Number.isInteger(parsed.retentionLimit) && parsed.retentionLimit > 0) {
      config.retentionLimit = parsed.retentionLimit
    }
    if (typeof parsed.prewrite === 'boolean') config.prewrite = parsed.prewrite
    // OPT-IN (default off): the LLM boundary summary. Off ⇒ no call, no artifact.
    if (typeof parsed.summary === 'boolean') config.summary = parsed.summary
  } catch {
    // malformed header → defaults
  }
  return config
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

/**
 * Error path — never silent. The wire keeps only code/message (+details), so
 * without this log an internal TypeError disappeared into a clean host log:
 * that is how the "cannot recall / cannot edit" incident stayed hidden.
 * @param {object} res
 * @param {unknown} error
 * @param {(line: string) => void} [log]
 */
function sendError(res, error, log = () => {}) {
  try {
    const message = error instanceof Error ? error.message : String(error)
    const stack = error instanceof Error && typeof error.stack === 'string' ? error.stack : '(no stack)'
    const code = error && typeof error.code === 'string' ? error.code : 'internal'
    log(`retrace: http error [${code}] ${message}\n${stack}`)
  } catch { /* logging must never break the response */ }
  sendJson(res, 200, {
    ok: false,
    error: {
      // editorError 附带的排查信息(messageId/seq)透传到 wire(同 op 信封)
      ...(error && typeof error.details === 'object' && error.details ? error.details : {}),
      code: error && typeof error.code === 'string' ? error.code : 'internal',
      message: error instanceof Error ? error.message : String(error),
    },
  })
}

/** Route one request. `seam` is the versioning seam (lib/versioning.js). */
export function createRetraceHttpHandler(ctx, { sessions, agents, seam, rollback, hooks = {}, log = () => {} }) {
  const api = createEditorApi(ctx, sessions, agents, log, hooks)

  function handleVersions(req, res, sessionId, config) {
    seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.snapshot(sessionId) })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  function handleForkmap(req, res, sessionId, config) {
    seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.snapshotForkmap(sessionId) })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  function handleLineage(req, res, sessionId) {
    try {
      sendJson(res, 200, { ok: true, value: seam.lineage(sessionId) })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  async function handleEvent(req, res, searchParams) {
    const sessionId = searchParams.get('sessionId') ?? ''
    const seq = Number(searchParams.get('seq'))
    const before = searchParams.has('before') ? Number(searchParams.get('before')) : undefined
    const after = searchParams.has('after') ? Number(searchParams.get('after')) : undefined
    try {
      const value = await seam.readEvent({ sessionId, seq, before, after })
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  async function handleSurface(req, res, sessionId) {
    try {
      const value = await seam.readSurface(sessionId)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  async function handleGitStatus(req, res, sessionId) {
    try {
      const value = await seam.gitStatus(sessionId)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  async function handleDoctor(req, res, sessionId, config) {
    seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.doctorScan(sessionId) })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  async function handleSnapshot(req, res, searchParams) {
    const sessionId = searchParams.get('sessionId') ?? ''
    const versionId = searchParams.get('versionId') ?? ''
    const path = searchParams.get('path') ?? ''
    try {
      const sha = await seam.resolveSnapshot(versionId, path)
      if (!sha) {
        sendJson(res, 200, { ok: true, value: { found: false } })
        return
      }
      const bytes = await seam.readSnapshot(sha)
      sendJson(res, 200, {
        ok: true,
        value: {
          found: true,
          sha256: sha,
          sizeBytes: bytes.byteLength,
          text: new TextDecoder().decode(bytes),
        },
      })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  /**
   * GET /api/plugins/dsh-retrace/summaries?sessionId=&boundarySeq=&format=
   *
   * The boundary digest + optional LLM summary, read from the plugin's OWN
   * artifact (`<pluginDataHome()>/dsh-retrace/summaries/<sessionId>.jsonl`).
   * The view fetches this once per open (whole session, merged by boundarySeq);
   * `?boundarySeq=` narrows to one row and `?format=md` renders a human-readable
   * export. Purely a read: no LLM call is ever made here.
   *
   * `enabled: false` (the `summary` switch is off) ⇒ the client keeps rendering
   * the plain version rows, exactly like 0.4.x.
   *
   * `tree` (outline forest, lib/boundary-tree.js): one entry per boundary with
   * `{parent, children, discardedCount}` computed from the exact `discardedSeqs`
   * sets. It is built from ALL records (not just the `?boundarySeq=` slice) so an
   * indented outline stays complete, and it is OMITTED when no record carries a
   * usable set (old artifacts, never-recorded sessions) — the client then falls
   * back to a flat list.
   */
  async function handleSummaries(req, res, searchParams, seamRef) {
    const sessionId = searchParams.get('sessionId') ?? ''
    if (sessionId === '') {
      sendJson(res, 400, { ok: false, error: { code: 'missing-session', message: 'sessionId is required' } })
      return
    }
    const boundarySeq = searchParams.has('boundarySeq') ? Number(searchParams.get('boundarySeq')) : null
    const format = searchParams.get('format') ?? 'json'
    try {
      const enabled = seamRef.configFor(sessionId)?.summary === true
      const stored = await readSummaries(seamRef.storeRoot(), sessionId)
      // Stored records win; boundaries with no stored line get their digest
      // DERIVED from the log (old sessions never wrote one — real-machine
      // finding 2026-09-15: the list showed no content at all). Host-side
      // surface replacements are filtered out of the version list and reported
      // as a count instead of being mixed into the user's own changes.
      const merged = typeof seamRef.boundariesFor === 'function'
        ? seamRef.boundariesFor(sessionId, stored.records)
        : { records: stored.records, derived: 0, hostReplacementCount: 0 }
      const records = merged.records
      const { skipped, error } = stored
      const picked = boundarySeq === null ? latestByBoundary(records) : records.filter((r) => r.boundarySeq === boundarySeq)
      if (format === 'md') {
        const body = renderSummariesMarkdown(sessionId, picked)
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Length': Buffer.byteLength(body),
          'Cache-Control': 'no-store',
        })
        res.end(body)
        return
      }
      // Degrade, never guess: an unavailable forest omits the field entirely
      // instead of shipping a flat-but-looks-nested structure.
      let tree = null
      try {
        const forest = boundaryTreeOf(records)
        if (forest !== null) tree = forest.tree
      } catch (treeError) {
        log(`retrace: summaries tree unavailable: ${String(treeError?.message ?? treeError)}`)
      }
      sendJson(res, 200, {
        ok: true,
        value: {
          enabled,
          sessionId,
          skipped,
          error,
          records: picked,
          // How many records came from the log instead of the artifact store.
          derived: picked.filter((record) => record?.derived === true).length,
          // Host-side surface replacements excluded from the read-point list.
          hostReplacementCount: merged.hostReplacementCount ?? 0,
          ...(tree === null ? {} : { tree }),
        },
      })
    } catch (caught) {
      sendError(res, caught, log)
    }
  }

  /**
   * 关闭守卫 V2运行中状态查询——client(beforeunload 拦截)的
   * 同步读数据源:host → client 状态轮询通道(页面 beforeunload 内无法 await
   * 异步查询,client 每 GUARD_POLL_MS 拉一次缓存快照)。复用关闭守卫检测:
   * runningSessions(ctx) 全会话运行中清单(agent/queued/jobs/未闭合轮)。
   * 无 sessionId → { running: [...] };有 → 单会话 runningState。
   * 纯读,无副作用(守卫只检测+确认,绝不中断/写事件)。
   */
  function handleRunningState(req, res, hostCtx, sessions, agents, searchParams) {
    try {
      // 与 index.js 的 harness `retrace.runningState` 同构(动态桥入口已有,
      // index.js:438);HTTP 面补发布模式 client 的 fetch 通道。
      const guardCtx = { sessions, agents, jobs: hostCtx?.jobs }
      const sessionId = searchParams.get('sessionId') ?? ''
      const value = sessionId
        ? sessionRunningState(guardCtx, sessionId)
        : { running: runningSessions(guardCtx) }
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error, log)
    }
  }

  /** POST body parse + dispatch shared by the rollback/git ops. */
  function handleJsonPost(req, res, fn) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        sendJson(res, 413, {
          ok: false,
          error: { code: 'payload-too-large', message: 'payload exceeds 64 KiB' },
        })
        req.destroy()
      }
    })
    req.on('error', () => { /* socket errors are terminal; nothing to send */ })
    req.on('end', async () => {
      let args = {}
      if (body.length > 0) {
        try {
          args = JSON.parse(body)
        } catch {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'bad-json', message: 'request body is not valid JSON' },
          })
          return
        }
      }
      const sessionId = String(args?.sessionId ?? '')
      if (sessionId) seam.setConfig(sessionId, parseRetraceConfig(req.headers['x-retrace-config']))
      try {
        const value = await fn(args)
        sendJson(res, 200, { ok: true, value })
      } catch (error) {
        sendError(res, error, log)
      }
    })
  }

  function handlePost(req, res, op) {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        sendJson(res, 413, {
          ok: false,
          error: { code: 'payload-too-large', message: 'payload exceeds 64 KiB' },
        })
        req.destroy()
      }
    })
    req.on('error', () => { /* socket errors are terminal; nothing to send */ })
    req.on('end', async () => {
      let args = {}
      if (body.length > 0) {
        try {
          args = JSON.parse(body)
        } catch {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'bad-json', message: 'request body is not valid JSON' },
          })
          return
        }
      }
      const sessionId = String(args?.sessionId ?? '')
      if (sessionId) seam.setConfig(sessionId, parseRetraceConfig(req.headers['x-retrace-config']))
      const opFn = api[op]
      if (typeof opFn !== 'function') {
        sendJson(res, 404, {
          ok: false,
          error: { code: 'unknown-op', message: `unknown operation "${op}"` },
        })
        return
      }
      // 2026-09-01:编辑操作前从文件算遮蔽(绕开 host 稀疏 events,用户方案)
      // 2026-09-09:recall mode 改 tail(遮蔽目标轮及之后全部)——与 index.js harness 入口
      // 同语义(HTTP 入口此前漏改仍 round,两入口分叉违反"编辑走哪个入口都生效")
      if ((op === 'recall' || op === 'editAndResend' || op === 'regenerate') && !args?.span) {
        try {
          const target = typeof args?.seq === 'number' ? args.seq : args?.messageId
          if (target !== undefined && target !== null && !args?.span) {
            const mode = op === 'recall' || (op === 'editAndResend' && args?.fromScratch) ? 'tail' : 'round'
            // 与 index.js harness 入口对齐——**单次**
            // spanProbeFromFile(span + 文件快照事实一次读回)。旧实现 spanFromFile
            // 主调 + span null 才补 spanProbeFromFile = 同一请求两次读文件,两次快照
            // 之间文件可能被 flush(TOCTOU:span 与 facts 来自不同快照,判定可能自相
            // 矛盾);一次 probe 结果内部自洽,两入口零分叉。
            const probe = await dshAdapter.spanProbeFromFile(sessionId, target, mode)
            if (probe?.span) {
              args = { ...args, span: probe.span }
              // regenerate 的重发原文 = 该轮前置
              // user 的**文件侧**原文(probe.prompt = round span 起点 user 原文),
              // 与 index.js harness 入口同源——host-core 不直扫内存稀疏 events。
              if (op === 'regenerate' && probe.prompt) args = { ...args, regeneratePrompt: probe.prompt }
            } else {
              // 按**显式状态**下传(不再靠"span 为 null + 事实"猜)——
              // not-persisted → message-pending;already-shadowed → target-shadowed;
              // not-found → message-not-found;replay-failed → 内部错误。
              // spanMissArgsOf 只在文件侧确有快照证据时返回,无证据 → 业务层按内存视图判定。
              //
              // ⚠️ 公开层安全:这里**不能**用「行级删除标记」挂在
              // `else if (op !== 'fold') {` 那一行上——整行(含收尾 `}` 与开头 `{`)被删掉后,
              // 分支体被上层 if 吸收成死代码(HTTP 入口状态判定全失效,语法却仍合法)。
              // 折叠的分支差异改用**块级替换**(私有分支 / 公开分支各自完整、括号自洽)。
              const miss = spanMissArgsOf(probe)
              if (miss) args = { ...args, ...miss }
            }
          }
        } catch { /* span 计算失败 fallback 内部 */ }
      }
      try {
        const result = await opFn(args)
        sendJson(res, 200, result)
      } catch (error) {
        sendError(res, error, log)
      }
    })
  }

  return (req, res) => {
    const url = new URL(req.url ?? '/', 'http://retrace.local')
    const segments = url.pathname.split('/').filter(Boolean)
    const op = segments.at(-1) ?? ''
    const searchParams = url.searchParams
    const sessionId = searchParams.get('sessionId') ?? ''
    const config = parseRetraceConfig(req.headers['x-retrace-config'])

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, x-retrace-config',
      })
      res.end()
      return
    }
    if (req.method === 'GET') {
      switch (op) {
        case 'versions':
          return handleVersions(req, res, sessionId, config)
        case 'forkmap':
          // @deprecated 2026-09-14: the fork-map tab was removed from the client
          // UI. The route + projection stay for tests and external readers.
          return handleForkmap(req, res, sessionId, config)
        case 'lineage':
          // @deprecated 2026-09-14: no plugin-UI consumer after the fork-tab removal.
          return handleLineage(req, res, sessionId)
        case 'event':
          return void handleEvent(req, res, searchParams)
        case 'surface':
          return void handleSurface(req, res, sessionId)
        case 'status':
          return void handleGitStatus(req, res, sessionId)
        case 'doctor':
          return handleDoctor(req, res, sessionId, config)
        case 'summaries':
          return void handleSummaries(req, res, searchParams, seam)
        case 'snapshot':
          return void handleSnapshot(req, res, searchParams)
        // 关闭守卫 V2:运行中状态(client 轮询缓存;纯读)。
        case 'runningState':
          return void handleRunningState(req, res, ctx, sessions, agents, searchParams)
        default:
          return sendJson(res, 404, {
            ok: false,
            error: { code: 'unknown-op', message: `unknown operation "${op}"` },
          })
      }
    }
    if (req.method !== 'POST') {
      return sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: 'POST or GET only' },
      })
    }
    // P1 rollback/git POST ops (last segment discriminates).
    if (segments.includes('rollback') && op === 'preview') {
      if (!rollback) return sendJson(res, 503, { ok: false, error: { code: 'rollback-unavailable', message: 'rollback surface unavailable' } })
      return handleJsonPost(req, res, (args) => rollback.preview(args))
    }
    if (segments.includes('rollback')) {
      if (!rollback) return sendJson(res, 503, { ok: false, error: { code: 'rollback-unavailable', message: 'rollback surface unavailable' } })
      return handleJsonPost(req, res, (args) => rollback.execute(args))
    }
    if (segments.includes('git') && op === 'init') {
      return handleJsonPost(req, res, (args) => seam.gitInit(String(args?.sessionId ?? '')))
    }
    // 关闭守卫 V2:POST 形状与 harness 动态桥(retrace.runningState)
    // 对齐——client 的 callOp 通道无论走 wire 还是 HTTP 都拿到同一形状。
    if (op === 'runningState') {
      return handleJsonPost(req, res, async (args) => {
        const guardCtx = { sessions, agents, jobs: ctx?.jobs }
        const sid = String(args?.sessionId ?? '')
        return sid ? sessionRunningState(guardCtx, sid) : { running: runningSessions(guardCtx) }
      })
    }
    // 客户端半自报（2026-09-14 事故 2 的可见性补丁）：证明"客户端半装载了 + 注册了
    // 几个会话 Definition / 槽位、走的是哪个注册入口"。**只打日志**（ctx.logger.info
    // ⇒ 宿主日志里的 `[dsh-retrace] …`），不落盘、不写会话、不改任何状态。
    // 客户端不再"静默降级"：取不到注册入口时也会带着 definitions=0 报到这行。
    if (op === 'clientReport') {
      return handleJsonPost(req, res, (args) => {
        const injectList = Array.isArray(args?.inject) ? args.inject.join(',') : ''
        log(
          `[dsh-retrace] client: loaded  id=${String(args?.id ?? '')}  inject=[${injectList}]`
          + `  definitions=${Number(args?.definitions) || 0}  slots=${Number(args?.slots) || 0}`
          + `  seats=${Number(args?.seats) || 0}  uiConversationSource=${String(args?.source ?? 'none')}`,
        )
        return { logged: true }
      })
    }

    return handlePost(req, res, op)
  }
}
