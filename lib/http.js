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
 *     — 关闭守卫 V2 (issue-176):全会话运行中清单 { running: [...] }(或单会话
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
import { runningSessions, sessionRunningState } from './close-guard.js'

export const ROUTE_PREFIX = '/api/plugins/retrace'
const MAX_BODY_BYTES = 64 * 1024

/** Default per-request config (client overrides via the header). */
export const DEFAULT_CONFIG = { versioning: true, git: true, retentionLimit: 50, prewrite: true }

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

function sendError(res, error) {
  sendJson(res, 200, {
    ok: false,
    error: {
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
      sendError(res, error)
    }
  }

  function handleForkmap(req, res, sessionId, config) {
    seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.snapshotForkmap(sessionId) })
    } catch (error) {
      sendError(res, error)
    }
  }

  function handleLineage(req, res, sessionId) {
    try {
      sendJson(res, 200, { ok: true, value: seam.lineage(sessionId) })
    } catch (error) {
      sendError(res, error)
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
      sendError(res, error)
    }
  }

  async function handleSurface(req, res, sessionId) {
    try {
      const value = await seam.readSurface(sessionId)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleGitStatus(req, res, sessionId) {
    try {
      const value = await seam.gitStatus(sessionId)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      sendError(res, error)
    }
  }

  async function handleDoctor(req, res, sessionId, config) {
    seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.doctorScan(sessionId) })
    } catch (error) {
      sendError(res, error)
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
      sendError(res, error)
    }
  }

  /**
   * 关闭守卫 V2(issue-176)运行中状态查询——client(beforeunload 拦截)的
   * 同步读数据源:host → client 状态轮询通道(页面 beforeunload 内无法 await
   * 异步查询,client 每 GUARD_POLL_MS 拉一次缓存快照)。复用 issue-146 检测:
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
      sendError(res, error)
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
        sendError(res, error)
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
      // 情形② step 号:writer 的 readMaxStep 已在 index.js 装配时注入(文件全量算)。
      // 2026-09-01:编辑操作前从文件算遮蔽(绕开 host 稀疏 session.events,用户方案)
      // 2026-09-09:recall mode 改 tail(遮蔽目标轮及之后全部)——与 index.js harness 入口
      // 同语义(独立审查 ❌-1:HTTP 入口此前漏改仍 round,两入口分叉违反"编辑走哪个入口都生效")
      if ((op === 'recall' || op === 'editAndResend' || op === 'regenerate') && !args?.span) {
        try {
          const target = typeof args?.seq === 'number' ? args.seq : args?.messageId
          if (target !== undefined && target !== null) {
            const mode = op === 'recall' || (op === 'editAndResend' && args?.fromScratch) ? 'tail' : 'round'
            const span = await dshAdapter.spanFromFile(sessionId, target, mode)
            if (span) args = { ...args, span }
          }
        } catch { /* span 计算失败 fallback 内部 */ }
      }
      try {
        const result = await opFn(args)
        sendJson(res, 200, result)
      } catch (error) {
        sendError(res, error)
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
          return handleForkmap(req, res, sessionId, config)
        case 'lineage':
          return handleLineage(req, res, sessionId)
        case 'event':
          return void handleEvent(req, res, searchParams)
        case 'surface':
          return void handleSurface(req, res, sessionId)
        case 'status':
          return void handleGitStatus(req, res, sessionId)
        case 'doctor':
          return handleDoctor(req, res, sessionId, config)
        case 'snapshot':
          return void handleSnapshot(req, res, searchParams)
        // 关闭守卫 V2(issue-176):运行中状态(client 轮询缓存;纯读)。
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
    // 关闭守卫 V2(issue-176):POST 形状与 harness 动态桥(retrace.runningState)
    // 对齐——client 的 callOp 通道无论走 wire 还是 HTTP 都拿到同一形状。
    if (op === 'runningState') {
      return handleJsonPost(req, res, async (args) => {
        const guardCtx = { sessions, agents, jobs: ctx?.jobs }
        const sid = String(args?.sessionId ?? '')
        return sid ? sessionRunningState(guardCtx, sid) : { running: runningSessions(guardCtx) }
      })
    }
 (feat(close-guard): 关闭守卫 V2(issue-176,规格 comm/关闭守卫v2-规格草案-20260909.md §二)——client 页面关闭 A 强拦/B 轻确认 + 运行中横幅 + runningState HTTP 面,363 绿)
    return handlePost(req, res, op)
  }
}
