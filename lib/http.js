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
 *   GET  /api/plugins/retrace/snapshot?sessionId=&versionId=&path=
 *     — read one version's snapshot content (rollback preview / detail).
 *
 * Per PLAN.md §4.6 the client carries its localStorage config on every
 * request as `x-retrace-config: {"versioning":bool,"git":bool,
 * "retentionLimit":n}`; the host honors it per request and does not persist
 * it. A missing/malformed header falls back to the plugin defaults.
 */
import { createEditorApi } from './host-core.js'

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
export function createRetraceHttpHandler(ctx, { sessions, agents, seam, rollback, log = () => {} }) {
  const api = createEditorApi(ctx, sessions, agents, log)

  function handleVersions(req, res, sessionId, config) {
    seam.setConfig(sessionId, config)
    try {
      sendJson(res, 200, { ok: true, value: seam.snapshot(sessionId) })
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
        case 'event':
          return void handleEvent(req, res, searchParams)
        case 'surface':
          return void handleSurface(req, res, sessionId)
        case 'status':
          return void handleGitStatus(req, res, sessionId)
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
    return handlePost(req, res, op)
  }
}
