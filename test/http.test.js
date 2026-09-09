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

  it('GET /lineage proxies the seam (A4)', async () => {
    const seam = makeSeam()
    seam.lineage = vi.fn(() => [
      { id: 'leaf', parentId: 'mid' },
      { id: 'mid', parentId: 'root' },
      { id: 'root', parentId: null },
    ])
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/lineage?sessionId=leaf`)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(seam.lineage).toHaveBeenCalledWith('leaf')
    expect(parsed.value).toHaveLength(3)
    expect(parsed.value[2]).toEqual({ id: 'root', parentId: null })
  })

  it('GET /lineage surfaces seam errors as ok:false', async () => {
    const seam = makeSeam()
    seam.lineage = vi.fn(() => {
      throw new Error('boom')
    })
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/lineage?sessionId=s1`)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.message).toBe('boom')
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

describe('POST recall · HTTP 入口 span mode（独立审查 ❌-1 回归：recall tail 两入口一致）', () => {
  it('HTTP /recall 用 tail mode 调 spanFromFile（不再 round，缺陷①断层在 HTTP 入口也修复）', async () => {
    const { dshAdapter } = await import('../lib/adapter/dsh.js')
    const spy = vi.spyOn(dshAdapter, 'spanFromFile').mockResolvedValue({
      start: 1, end: 5, shadowedSeqs: [1, 2, 3, 4, 5],
    })
    try {
      const { makeSession, makeEnv, headerEvent, userMessage, assistantMessage } = await import('./helpers.js')
      const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'), userMessage('u2', 'again'), assistantMessage('a2', 'more'))
      const { sessions, agents } = makeEnv(session, { agent: { status: 'idle', followup: vi.fn() } })
      const seam = makeSeam()
      const fakeWriter = async (session, span, intent) => session.append('assistant/message', {
        turn: 1, step: 1,
        message: { id: `retrace-recall-${intent.targetSeq}`, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
        editor: { targetSeq: intent.targetSeq, text: intent.originalText ?? '' },
      }, { surfaceOp: { op: 'replace', start: span.start, end: span.end }, sourceEventSeqs: span.shadowedSeqs })
      const handler = createRetraceHttpHandler({}, { sessions, agents, seam, rollback: {}, hooks: { writeMarker: fakeWriter }, log: () => {} })
      const res = await post(handler, `${ROUTE_PREFIX}/recall`, { sessionId: 's1', messageId: 'u1' })
      expect(spy).toHaveBeenCalledTimes(1)
      // 关键断言:HTTP 入口 recall 也用 tail mode(与 index.js harness 入口一致)
      expect(spy.mock.calls[0][2]).toBe('tail')
      const parsed = JSON.parse(res.body)
      expect(parsed.ok).toBe(true)
      expect(parsed.value.shadowed).toBe(5) // tail 遮蔽目标轮及之后全部
    } finally {
      spy.mockRestore()
    }
  })

  it('HTTP /editAndResend 非 fromScratch 保持 round（编辑语义不变）', async () => {
    const { dshAdapter } = await import('../lib/adapter/dsh.js')
    const spy = vi.spyOn(dshAdapter, 'spanFromFile').mockResolvedValue({
      start: 1, end: 2, shadowedSeqs: [1, 2],
    })
    try {
      const { makeSession, makeEnv, headerEvent, userMessage, assistantMessage } = await import('./helpers.js')
      const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'), userMessage('u2', 'again'), assistantMessage('a2', 'more'))
      const { sessions, agents } = makeEnv(session, { agent: { status: 'idle', followup: vi.fn() } })
      const seam = makeSeam()
      const fakeWriter = async (session, span, intent) => session.append('assistant/message', {
        turn: 1, step: 1,
        message: { id: `retrace-edit-${intent.targetSeq}`, role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } },
        editor: { targetSeq: intent.targetSeq, text: intent.originalText ?? '' },
      }, { surfaceOp: { op: 'replace', start: span.start, end: span.end }, sourceEventSeqs: span.shadowedSeqs })
      const handler = createRetraceHttpHandler({}, { sessions, agents, seam, rollback: {}, hooks: { writeMarker: fakeWriter }, log: () => {} })
      const res = await post(handler, `${ROUTE_PREFIX}/editAndResend`, { sessionId: 's1', messageId: 'u1', text: 'x' })
      expect(spy).toHaveBeenCalledTimes(1)
      expect(spy.mock.calls[0][2]).toBe('round')
      expect(JSON.parse(res.body).ok).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })
})

describe('关闭守卫 V2 runningState HTTP 路由(issue-176,client 轮询同步读源)', () => {
  /** 官方形状 sessions/agents(jobs 走 ctx.jobs;缺省降级空)。 */
  function makeGuardEnv(sessions, agents) {
    return {
      ctx: { jobs: { list: () => [] } },
      sessions: { keys: () => sessions.keys(), get: (id) => sessions.get(id) },
      agents: { get: (id) => agents.get(id) },
    }
  }
  const openTurnSession = () => ({ id: 's1', events: [
    { type: 'turn/start', seq: 0, data: { turn: 1 } },
    { type: 'user/message', seq: 1, data: { id: 'u1', source: { kind: 'user' } } },
    { type: 'assistant/message', seq: 2, data: { message: { id: 'a1' } } },
  ] }) // 尾部无 turn/end = 未闭合轮(崩溃/强杀现场)

  it('GET /runningState 返回全会话运行中清单 { running: [...] }(纯读)', async () => {
    const sessions = new Map([['s1', openTurnSession()], ['s2', { id: 's2', events: [] }]])
    const agents = new Map([['s1', { id: 's1', status: 'running' }], ['s2', { id: 's2', status: 'idle' }]])
    const env = makeGuardEnv(sessions, agents)
    const handler = createRetraceHttpHandler(env.ctx, { sessions: env.sessions, agents: env.agents, seam: makeSeam(), rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/runningState`)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(Array.isArray(parsed.value.running)).toBe(true)
    const ids = parsed.value.running.map((r) => r.sessionId).sort()
    expect(ids).toEqual(['s1']) // s2 静止不出现;未闭合轮/agent-running 归 s1
    expect(parsed.value.running[0].reasons.some((r) => r.startsWith('unclosed-turn-'))).toBe(true)
  })

  it('GET /runningState?sessionId= 返回单会话状态;全静止 → 空清单', async () => {
    // s1 干净闭合(尾部 turn/end)→ 静止;单会话查返回 running:false
    const cleanSession = () => ({ id: 's1', events: [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'user/message', seq: 1, data: { id: 'u1', source: { kind: 'user' } } },
      { type: 'assistant/message', seq: 2, data: { message: { id: 'a1' } } },
      { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ] })
    const sessions = new Map([['s1', cleanSession()], ['s2', { id: 's2', events: [] }]])
    const agents = new Map([['s1', { id: 's1', status: 'idle' }], ['s2', { id: 's2', status: 'idle' }]])
    const env = makeGuardEnv(sessions, agents)
    const handler = createRetraceHttpHandler(env.ctx, { sessions: env.sessions, agents: env.agents, seam: makeSeam(), rollback: {}, log: () => {} })
    const single = await get(handler, `${ROUTE_PREFIX}/runningState?sessionId=s1`)
    expect(JSON.parse(single.body).value.running).toBe(false) // 干净会话静止
    const all = await get(handler, `${ROUTE_PREFIX}/runningState`)
    expect(JSON.parse(all.body).value.running).toEqual([])
  })

  it('POST /runningState 与 GET 同形状(dynamic 桥 retrace.runningState 对齐)', async () => {
    const sessions = new Map([['s1', openTurnSession()]])
    const agents = new Map([['s1', { id: 's1', status: 'running' }]])
    const env = makeGuardEnv(sessions, agents)
    const handler = createRetraceHttpHandler(env.ctx, { sessions: env.sessions, agents: env.agents, seam: makeSeam(), rollback: {}, log: () => {} })
    const res = await post(handler, `${ROUTE_PREFIX}/runningState`, {})
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.running).toHaveLength(1)
    expect(parsed.value.running[0].sessionId).toBe('s1')
  })

  it('jobs 服务缺失(旧 ctx)→ 降级不抛,agent-running 仍报', async () => {
    const sessions = new Map([['s1', { id: 's1', events: [] }]])
    const agents = new Map([['s1', { id: 's1', status: 'running' }]])
    const handler = createRetraceHttpHandler({}, { sessions: { keys: () => sessions.keys(), get: (id) => sessions.get(id) }, agents: { get: (id) => agents.get(id) }, seam: makeSeam(), rollback: {}, log: () => {} })
    const res = await get(handler, `${ROUTE_PREFIX}/runningState`)
    expect(JSON.parse(res.body).value.running).toHaveLength(1)
  })
})
