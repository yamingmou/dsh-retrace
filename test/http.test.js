import { describe, it, expect, vi } from 'vitest'
import { DEFAULT_CONFIG, parseRetraceConfig, ROUTE_PREFIX, createRetraceHttpHandler } from '../lib/http.js'

describe('parseRetraceConfig', () => {
  it('returns defaults for missing or empty headers', () => {
    expect(parseRetraceConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(parseRetraceConfig('')).toEqual(DEFAULT_CONFIG)
  })

  it('parses a full client config', () => {
    expect(parseRetraceConfig(JSON.stringify({ versioning: false, git: false, retentionLimit: 10 }))).toEqual({
      versioning: false,
      git: false,
      retentionLimit: 10,
      prewrite: true,
    })
    expect(parseRetraceConfig(JSON.stringify({ prewrite: false }))).toEqual({ ...DEFAULT_CONFIG, prewrite: false })
  })

  it('merges partial configs onto defaults', () => {
    expect(parseRetraceConfig(JSON.stringify({ versioning: false }))).toEqual({
      ...DEFAULT_CONFIG,
      versioning: false,
    })
  })

  it('rejects malformed JSON and invalid field types', () => {
    expect(parseRetraceConfig('not json')).toEqual(DEFAULT_CONFIG)
    expect(parseRetraceConfig(JSON.stringify({ versioning: 'yes', retentionLimit: -5 }))).toEqual(DEFAULT_CONFIG)
  })
})

describe('ROUTE_PREFIX', () => {
  it('keeps the published route contract', () => {
    expect(ROUTE_PREFIX).toBe('/api/plugins/retrace')
  })
})

// ---------------------------------------------------------------------------
// Handler-level tests for the P1 routes (rollback / git / snapshot)
// ---------------------------------------------------------------------------

/** A minimal fake seam over the versioning surface. */
function makeSeam() {
  return {
    setConfig: vi.fn(),
    snapshot: vi.fn(() => ({ enabled: true, versions: [] })),
    readEvent: vi.fn(async () => ({ event: {} })),
    readSurface: vi.fn(async () => ({ nodes: [] })),
    gitStatus: vi.fn(async () => ({ root: '/w', headHash: 'abc', dirty: false, paths: [] })),
    gitInit: vi.fn(async () => ({ ok: true, root: '/w', headHash: 'def' })),
    resolveSnapshot: vi.fn(async () => 'sha1'),
    readSnapshot: vi.fn(async () => new TextEncoder().encode('snapshot text')),
  }
}

/** A POST helper: the handler's body parser waits for 'data'/'end' events;
 * the fake req stores the data listener, delivers the JSON payload, then
 * fires 'end' on a macrotask (matching real socket timing). */
function post(handler, url, payload) {
  const res = {
    status: 200,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
    destroy() {},
  }
  let dataListener = null
  let endListener = null
  const req = {
    method: 'POST',
    url,
    headers: { 'x-retrace-config': '' },
    setEncoding() {},
    on(event, fn) {
      if (event === 'data') dataListener = fn
      else if (event === 'end') endListener = fn
      else if (event === 'error') { /* no error */ }
    },
  }
  const run = () => {
    if (payload !== undefined && dataListener) dataListener(JSON.stringify(payload))
    if (endListener) endListener()
  }
  setTimeout(run, 0)
  return new Promise((resolve, reject) => {
    handler(req, res)
    const started = Date.now()
    const poll = () => {
      if (res.body.length > 0) return resolve(res)
      if (Date.now() - started > 500) return reject(new Error('POST handler produced no response'))
      setTimeout(poll, 2)
    }
    poll()
  })
}

function get(handler, url) {
  const res = {
    status: 200,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(chunk) {
      this.body += chunk ?? ''
    },
    destroy() {},
  }
  const req = {
    method: 'GET',
    url,
    headers: { 'x-retrace-config': '' },
    setEncoding() {},
    on() {},
  }
  handler(req, res)
  // The GET handlers are async (`void handle...`); poll until the body lands.
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const poll = () => {
      if (res.body.length > 0) return resolve(res)
      if (Date.now() - started > 500) return reject(new Error('GET handler produced no response'))
      setTimeout(poll, 2)
    }
    poll()
  })
}

describe('P1 HTTP routes', () => {
  it('GET /git/status proxies the seam', async () => {
    const seam = makeSeam()
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/git/status?sessionId=s1`)
    expect(seam.gitStatus).toHaveBeenCalledWith('s1')
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.headHash).toBe('abc')
  })

  it('GET /forkmap proxies the seam (P2.1)', async () => {
    const seam = makeSeam()
    seam.snapshotForkmap = vi.fn(() => ({
      enabled: true,
      nodes: [{ seq: 5, type: 'assistant/message' }, { seq: 3, type: 'user/message' }],
      boundaries: [{ seq: 5, kind: 'edit', replacedSeqs: [1, 2] }],
    }))
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/forkmap?sessionId=s1`)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(seam.snapshotForkmap).toHaveBeenCalledWith('s1')
    expect(parsed.value.boundaries).toEqual([{ seq: 5, kind: 'edit', replacedSeqs: [1, 2] }])
    expect(parsed.value.nodes).toHaveLength(2)
  })

  it('POST /git/init proxies the seam', async () => {
    const seam = makeSeam()
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await post(handler, `${ROUTE_PREFIX}/git/init`, { sessionId: 's1' })
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(seam.gitInit).toHaveBeenCalledWith('s1')
  })

  it('POST /rollback/preview calls the rollback executor preview', async () => {
    const seam = makeSeam()
    const rollback = { preview: vi.fn(async () => ({ context: { messages: 3 } })), execute: vi.fn() }
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback, log: () => {} })
    const res = await post(handler, `${ROUTE_PREFIX}/rollback/preview`, { sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(rollback.preview).toHaveBeenCalledWith({ sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(JSON.parse(res.body).value.context.messages).toBe(3)
  })

  it('POST /rollback executes', async () => {
    const seam = makeSeam()
    const rollback = { preview: vi.fn(), execute: vi.fn(async () => ({ op: 'restore', markerSeq: 9 })) }
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback, log: () => {} })
    const res = await post(handler, `${ROUTE_PREFIX}/rollback`, { sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(rollback.execute).toHaveBeenCalledWith({ sessionId: 's1', versionId: 'v3', scope: 'artifacts' })
    expect(JSON.parse(res.body).value.markerSeq).toBe(9)
  })

  it('POST /rollback returns 503 when the executor is unavailable', async () => {
    const seam = makeSeam()
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: undefined, log: () => {} })
    const res = await post(handler, `${ROUTE_PREFIX}/rollback`, { sessionId: 's1', versionId: 'v3', scope: 'both' })
    expect(res.status).toBe(503)
  })

  it('GET /doctor scans token-meter-breaking markers (B1)', async () => {
    const seam = makeSeam()
    seam.doctorScan = vi.fn(() => ({ enabled: true, markerCount: 2, markers: [{ seq: 5, message: 'assistant/message at seq 5 has no matching step/start' }] }))
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/doctor?sessionId=s1`)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(seam.doctorScan).toHaveBeenCalledWith('s1')
    expect(parsed.value.markerCount).toBe(2)
  })

  it('GET /snapshot resolves the version:path object', async () => {
    const seam = makeSeam()
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/snapshot?sessionId=s1&versionId=v3&path=src%2Fa.ts`)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.found).toBe(true)
    expect(parsed.value.text).toBe('snapshot text')
    expect(seam.resolveSnapshot).toHaveBeenCalledWith('v3', 'src/a.ts')
  })

  it('GET /snapshot reports found:false for missing refs', async () => {
    const seam = makeSeam()
    seam.resolveSnapshot = vi.fn(async () => null)
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/snapshot?sessionId=s1&versionId=v9&path=x.txt`)
    expect(JSON.parse(res.body).value.found).toBe(false)
  })
})
