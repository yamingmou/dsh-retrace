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
 *
 * Per PLAN.md §4.6 the client carries its localStorage config on every
 * request as `x-retrace-config: {"versioning":bool,"git":bool,
 * "retentionLimit":n}`; the host honors it per request and does not persist
 * it. A missing/malformed header falls back to the plugin defaults.
 */
import { createEditorApi } from './host-core.js'
import { dshAdapter } from './adapter/dsh.js'
import { resolveFoldAuto } from './fold-auto.js'

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
      if ((op === 'recall' || op === 'editAndResend' || op === 'regenerate' || op === 'fold') && !args?.span) {
        try {
          // 批5(50 轮接线):fold 自动边界/轮首回退统一走 lib/fold-auto.js resolveFoldAuto
          // (与 index.js harness 入口同一实现,零分叉——独立审查 ❌-6/N-1/N-2/N-3 闭环)。
          if (op === 'fold') {
            const resolved = await resolveFoldAuto({ ...args, sessionId }, dshAdapter, log)
            if (resolved?.end !== undefined) args = resolved // 自动边界/回退已解析(可能含 span)
          }
          const target = op === 'fold' ? Number(args?.start) : (typeof args?.seq === 'number' ? args.seq : args?.messageId)
          if (target !== undefined && target !== null && !args?.span) {
            const mode = op === 'recall' || (op === 'editAndResend' && args?.fromScratch) ? 'tail'
              : op === 'fold' ? 'range'
              : 'round'
            const span = await dshAdapter.spanFromFile(sessionId, target, mode, op === 'fold' ? { endSeq: Number(args?.end) } : undefined)
            if (span) args = { ...args, span }
          }
        } catch { /* span 计算失败 fallback 内部 */ }
      }
      // N-3:fold 摘要与 span 来源解耦——调用方前置 span 也生成摘要(与 harness 一致:
      // 区间读 args.start/args.end,不依赖 span 块成败;span 与 end 同源时无副作用)
      // B2:长会话整理优先(trio + serializeTrio 文本 content),与 harness 入口一致。
      if (op === 'fold' && !args?.summary) {
        try {
          const s = Number(args?.start)
          const e = Number(args?.end)
          if (Number.isInteger(s) && Number.isInteger(e)) {
            const trio = await dshAdapter.trioFromFile(sessionId, s, e)
            if (trio) {
              // B2 修订链:superseded-by 指旧卡(两入口与 harness 一致)
              const sup = Number(args?.supersedeMarkerSeq)
              if (Number.isInteger(sup) && sup > 0 && trio['roadmap-card']) {
                trio['roadmap-card'].supersededBy = sup
                trio['roadmap-card'].supersedesNote = `本结论取代 seq ${sup} 的旧结论(旧卡仍在,可审计)`
              }
              const { serializeTrio } = await import('./fold-trio.js')
              args = { ...args, summary: serializeTrio(trio), trio }
            } else {
              const summary = await dshAdapter.summaryFromFile(sessionId, s, e)
              if (summary) args = { ...args, summary }
            }
          }
        } catch { /* 摘要失败不阻断 */ }
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
    // 长会话整理批4:waterLevel(会话上下文用量体检 + 折叠建议,纯读)
    if (op === 'waterLevel') {
      return handleJsonPost(req, res, async (args) => {
        const level = await dshAdapter.waterLevelFromFile(String(args?.sessionId ?? ''), { window: Number(args?.window) || undefined })
        if (!level) throw new Error('会话文件不可读')
        return level // handleJsonPost 包 {ok:true, value}
      })
    }
    // 长会话整理批3:unfold(视图层展开数据,纯读)与 fold(api op,走 handlePost)
    if (op === 'unfold') {
      return handleJsonPost(req, res, async (args) => {
        const markerSeq = Number(args?.markerSeq)
        if (!Number.isInteger(markerSeq) || markerSeq < 0) throw new Error('unfold 需要 fold marker 的 seq')
        const content = await dshAdapter.unfoldContentFromFile(String(args?.sessionId ?? ''), markerSeq)
        if (!content) throw new Error('指定 seq 不是 retrace-fold- 折叠 marker 或无遮蔽内容')
        return content
      })
    }
    // B2/P1 折前预览(纯读,与 harness retrace.foldPreview 一致——M-1:两入口同可达;
    // N-1:错误码与 harness 对齐:非法区间=bad-request,端点非 surface/不可读=range-not-surface)
    if (op === 'foldPreview') {
      return handleJsonPost(req, res, async (args) => {
        const s = Number(args?.start)
        const e = Number(args?.end)
        if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) {
          const err = new Error('foldPreview 需要合法区间 [start..end]')
          err.code = 'bad-request'
          throw err
        }
        const trio = await dshAdapter.trioFromFile(String(args?.sessionId ?? ''), s, e)
        if (!trio) {
          const err = new Error('区间端点不在当前 surface 或会话不可读(已被遮蔽/非节点/无文件)')
          err.code = 'range-not-surface'
          throw err
        }
        const { serializeTrio } = await import('./fold-trio.js')
        return { trio, previewText: serializeTrio(trio) }
      })
    }
    return handlePost(req, res, op)
  }
}
