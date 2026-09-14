import { describe, it, expect, vi } from 'vitest'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
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
      // opt-in LLM boundary summary — OFF unless the client asks for it
      summary: false,
    })
    expect(parseRetraceConfig(JSON.stringify({ prewrite: false }))).toEqual({ ...DEFAULT_CONFIG, prewrite: false })
    // the new switch is honored when (and only when) explicitly set
    expect(parseRetraceConfig(JSON.stringify({ summary: true }))).toEqual({ ...DEFAULT_CONFIG, summary: true })
    expect(parseRetraceConfig(JSON.stringify({ summary: 'yes' }))).toEqual(DEFAULT_CONFIG)
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

  it('an internal error is logged (message + stack) and still reported on the wire', async () => {
    // 2026-09: sendError 只回传 message、不写日志 ⇒ 内部 TypeError 让宿主日志干干净净,
    // 「不能撤回/不能编辑」被藏了很久。这条钉住:错误既上报 wire,也进服务端日志。
    const seam = makeSeam()
    seam.snapshot = vi.fn(() => {
      const error = new Error('cannot read properties of undefined')
      error.code = 'internal-boom'
      throw error
    })
    const lines = []
    const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam, rollback: {}, log: (line) => lines.push(line) })
    const res = await get(handler, `${ROUTE_PREFIX}/versions?sessionId=s1`)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('internal-boom')
    expect(parsed.error.message).toBe('cannot read properties of undefined')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('internal-boom')
    expect(lines[0]).toContain('cannot read properties of undefined')
    expect(lines[0]).toContain('Error: cannot read properties of undefined') // stack included
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

describe('POST recall · HTTP 入口 span mode（回归：recall tail 两入口一致；单次 probe）', () => {
  it('HTTP /recall 用 tail mode 单次 spanProbeFromFile（不再 round，缺陷①断层在 HTTP 入口也修复）', async () => {
    const { dshAdapter } = await import('../lib/adapter/dsh.js')
    // 与 index.js harness 入口对齐——单次 probe(span+facts
    // 同一份快照);spanFromFile 不再被主路径调用(消除双读 TOCTOU)。
    const probeSpy = vi.spyOn(dshAdapter, 'spanProbeFromFile').mockResolvedValue({
      span: { start: 1, end: 5, shadowedSeqs: [1, 2, 3, 4, 5] },
      facts: { fileMaxSeq: 5, targetSeq: 1 },
      prompt: null,
    })
    const spanSpy = vi.spyOn(dshAdapter, 'spanFromFile')
    try {
      const { makeSession, makeEnv, headerEvent, userMessage, assistantMessage, fakeCarrierWriter } = await import('./helpers.js')
      const { carrierTargetSeq } = await import('../lib/marker-carrier.js')
      // 假会话须覆盖注入 span 的全部 seq([1..5]):两段结构的审计段会占用"下一个 seq",
      // 注入 span 若把尚未存在的事件当作被遮蔽节点,审计 seq 会与它撞号(官方拒重复)
      const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'), userMessage('u2', 'again'), assistantMessage('a2', 'more'), userMessage('u3', 'tail'))
      const { sessions, agents } = makeEnv(session, { agent: { status: 'idle', followup: vi.fn() } })
      const seam = makeSeam()
      const fakeWriter = fakeCarrierWriter()
      const handler = createRetraceHttpHandler({}, { sessions, agents, seam, rollback: {}, hooks: { writeMarker: fakeWriter }, log: () => {} })
      const res = await post(handler, `${ROUTE_PREFIX}/recall`, { sessionId: 's1', messageId: 'u1' })
      expect(probeSpy).toHaveBeenCalledTimes(1) // 单次 probe
      expect(spanSpy).not.toHaveBeenCalled() // 主路径不再 spanFromFile 双读
      // 关键断言:HTTP 入口 recall 也用 tail mode(与 index.js harness 入口一致)
      expect(probeSpy.mock.calls[0][2]).toBe('tail')
      const parsed = JSON.parse(res.body)
      expect(parsed.ok).toBe(true)
      expect(parsed.value.shadowed).toBe(5) // tail 遮蔽目标轮及之后全部
    } finally {
      probeSpy.mockRestore(); spanSpy.mockRestore()
    }
  })

  it('HTTP /editAndResend 非 fromScratch 保持 round（编辑语义不变）', async () => {
    const { dshAdapter } = await import('../lib/adapter/dsh.js')
    const probeSpy = vi.spyOn(dshAdapter, 'spanProbeFromFile').mockResolvedValue({
      span: { start: 1, end: 2, shadowedSeqs: [1, 2] },
      facts: { fileMaxSeq: 5, targetSeq: 1 },
      prompt: { seq: 1, text: 'hi' },
    })
    try {
      const { makeSession, makeEnv, headerEvent, userMessage, assistantMessage, fakeCarrierWriter } = await import('./helpers.js')
      const { carrierTargetSeq } = await import('../lib/marker-carrier.js')
      // 假会话须覆盖注入 span 的全部 seq([1..5]):两段结构的审计段会占用"下一个 seq",
      // 注入 span 若把尚未存在的事件当作被遮蔽节点,审计 seq 会与它撞号(官方拒重复)
      const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'), userMessage('u2', 'again'), assistantMessage('a2', 'more'), userMessage('u3', 'tail'))
      const { sessions, agents } = makeEnv(session, { agent: { status: 'idle', followup: vi.fn() } })
      const seam = makeSeam()
      const fakeWriter = fakeCarrierWriter()
      const handler = createRetraceHttpHandler({}, { sessions, agents, seam, rollback: {}, hooks: { writeMarker: fakeWriter }, log: () => {} })
      const res = await post(handler, `${ROUTE_PREFIX}/editAndResend`, { sessionId: 's1', messageId: 'u1', text: 'x' })
      expect(probeSpy).toHaveBeenCalledTimes(1)
      expect(probeSpy.mock.calls[0][2]).toBe('round')
      expect(JSON.parse(res.body).ok).toBe(true)
    } finally {
      probeSpy.mockRestore()
    }
  })

  it('HTTP /recall probe 显式状态逐档生效(两入口/两线同一判定)', async () => {
    const { dshAdapter } = await import('../lib/adapter/dsh.js')
    const { makeSession, makeEnv, headerEvent, userMessage, assistantMessage } = await import('./helpers.js')
    // 曾因"行级吃掉 else if 的括号"把这条链路整条变成死代码(状态判定全塌成
    // message-pending)→ 本用例按**状态**逐档断言,在任一线上失效都会红。
    const cases = [
      { status: 'already-shadowed', code: 'target-shadowed' },
      { status: 'not-found', code: 'message-not-found' },
      { status: 'replay-failed', code: 'span-replay-failed' },
      { status: 'not-persisted', code: 'message-pending' },
    ]
    for (const c of cases) {
      const probeSpy = vi.spyOn(dshAdapter, 'spanProbeFromFile').mockResolvedValue({
        status: c.status,
        span: null,
        facts: { fileMaxSeq: 5, targetSeq: 4, mode: 'tail', nodes: 5 },
        prompt: null,
      })
      try {
        const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
        // 内存侧也算不出 span(目标已被移出内存 surface)→ 走状态判定分支
        session.surface.nodes = session.surface.nodes.filter((s) => s !== 2)
        const { sessions, agents } = makeEnv(session, { agent: { status: 'idle', followup: vi.fn() } })
        const handler = createRetraceHttpHandler({}, { sessions, agents, seam: makeSeam(), rollback: {}, hooks: {}, log: () => {} })
        const res = await post(handler, `${ROUTE_PREFIX}/recall`, { sessionId: 's1', messageId: 'a1' })
        const parsed = JSON.parse(res.body)
        expect(parsed.ok).toBe(false)
        expect({ status: c.status, got: parsed.error.code }).toEqual({ status: c.status, got: c.code })
      } finally {
        probeSpy.mockRestore()
      }
    }
  })

  it('HTTP /recall 文件快照未含目标(文件 flush 滞后)→ 同一份快照的 facts → message-pending 而非 target-shadowed', async () => {
    const { dshAdapter } = await import('../lib/adapter/dsh.js')
    // 文件读成功但快照未含目标(刚 commit 未 flush):单次 probe → span null + fileMaxSeq < 目标 seq
    const spanSpy = vi.spyOn(dshAdapter, 'spanFromFile')
    const probeSpy = vi.spyOn(dshAdapter, 'spanProbeFromFile').mockResolvedValue({ span: null, facts: { fileMaxSeq: 3, targetSeq: -1 }, prompt: null })
    try {
      const { makeSession, makeEnv, headerEvent, userMessage, assistantMessage, fakeCarrierWriter } = await import('./helpers.js')
      const { carrierTargetSeq } = await import('../lib/marker-carrier.js')
      // a2(seq 4)已进内存 events 但 surface 滞后未纳入 —— 用户点击落在提交窗口
      const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'), userMessage('u2', 'again'))
      session.appendRaw(assistantMessage('a2', 'more'))
      session.surface.nodes.pop()
      const { sessions, agents } = makeEnv(session, { agent: { status: 'idle', followup: vi.fn() } })
      const seam = makeSeam()
      const handler = createRetraceHttpHandler({}, { sessions, agents, seam, rollback: {}, hooks: {}, log: () => {} })
      const res = await post(handler, `${ROUTE_PREFIX}/recall`, { sessionId: 's1', messageId: 'a2' })
      expect(probeSpy).toHaveBeenCalledTimes(1) // span 与 facts 来自同一次 probe(同一份快照)
      expect(spanSpy).not.toHaveBeenCalled() // 不再主调 + 补读的双读
      const parsed = JSON.parse(res.body)
      expect(parsed.ok).toBe(false)
      expect(parsed.error.code).toBe('message-pending')
      expect(parsed.error.message).toBe('消息生成中,完成后可编辑')
      expect(parsed.error).toMatchObject({ messageId: 'a2', seq: 4 }) // 排查信息透传
    } finally {
      spanSpy.mockRestore(); probeSpy.mockRestore()
    }
  })

  it('HTTP /regenerate 注入文件侧 prompt → 重发该轮 user 原文(端到端)', async () => {
    const { dshAdapter } = await import('../lib/adapter/dsh.js')
    const probeSpy = vi.spyOn(dshAdapter, 'spanProbeFromFile').mockResolvedValue({
      span: { start: 3, end: 4, shadowedSeqs: [3, 4] },
      facts: { fileMaxSeq: 4, targetSeq: 4 },
      prompt: { seq: 3, text: 'SAME ROUND PROMPT' },
    })
    try {
      const { makeSession, makeEnv, headerEvent, userMessage, assistantMessage, fakeCarrierWriter } = await import('./helpers.js')
      const { carrierTargetSeq } = await import('../lib/marker-carrier.js')
      const session = makeSession().seed(
        headerEvent(),
        userMessage('u1', 'OLDER ROUND PROMPT'),
        assistantMessage('a1', 'older answer'),
        userMessage('u2', 'SAME ROUND PROMPT'),
      )
      // 内存 surface 滞后:目标 a2 已进 events 但未进 nodes
      session.appendRaw(assistantMessage('a2', 'current answer'))
      session.surface.nodes.pop()
      // 陷阱:该轮 user(seq 3)在内存 events 里是洞,更早轮 user(seq 1)仍在
      // ——旧实现直扫稀疏 events 会选中 seq 1(重发更早轮文本)。
      session.dropAt(3)
      const followup = vi.fn()
      const { sessions, agents } = makeEnv(session, { agent: { status: 'idle', followup } })
      const seam = makeSeam()
      const markers = []
      const fakeWriter = fakeCarrierWriter({ onWrite: (marker) => markers.push(marker) })
      const handler = createRetraceHttpHandler({}, { sessions, agents, seam, rollback: {}, hooks: { writeMarker: fakeWriter }, log: () => {} })
      const res = await post(handler, `${ROUTE_PREFIX}/regenerate`, { sessionId: 's1', messageId: 'a2' })
      const parsed = JSON.parse(res.body)
      expect(parsed.ok).toBe(true)
      // 重发文本 = 该轮 user(seq 3)原文,绝不是更早轮(seq 1)的
      expect(followup).toHaveBeenCalledTimes(1)
      expect(followup.mock.calls[0][0].content[0].text).toBe('SAME ROUND PROMPT')
      // 载体:遮蔽该轮;业务溯源 targetSeq 由区间起点派生(读端口径)
      expect(markers[0].surfaceOp).toEqual({ op: 'replace', start: 3, end: 4 })
      expect(carrierTargetSeq(markers[0])).toBe(3)
      expect(markers[0].data.id).toMatch(/^retrace-regenerate-/)
    } finally {
      probeSpy.mockRestore()
    }
  })
})

describe('关闭守卫 V2 runningState HTTP 路由(client 轮询同步读源)', () => {
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

// ---------------------------------------------------------------------------
// GET /summaries — the plugin's own boundary artifact (excerpts + opt-in summary)
// ---------------------------------------------------------------------------

describe('GET /summaries', () => {
  const makeSummarySeam = (root, { enabled = true } = {}) => {
    pretendCalls(0)
    return {
      configFor: () => ({ summary: enabled }),
      storeRoot: () => root,
    }
  }
  /** Nothing on the read path may consume LLM tokens. */
  const pretendCalls = (n) => {
    globalThis.__retraceLlmCalls = n
  }

  it('serves the artifact records and reports the switch state', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { appendSummary } = await import('../lib/summary-store.js')
    const root = mkdtempSync(join(tmpdir(), 'retrace-route-'))
    try {
      await appendSummary(root, 's1', {
        boundarySeq: 7,
        versionId: 'v7',
        called: true,
        model: 'p/m',
        summary: '摘要正文',
        what: { op: 'recall', new: { excerpt: '' }, replaced: [{ seq: 3, role: 'user', excerpt: '逐字摘录' }] },
      })
      const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam: makeSummarySeam(root), rollback: {}, log: () => {} })
      const res = await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1`)
      const parsed = JSON.parse(res.body)
      expect(parsed.ok).toBe(true)
      expect(parsed.value.enabled).toBe(true)
      expect(parsed.value.records).toHaveLength(1)
      expect(parsed.value.records[0].summary).toBe('摘要正文')
      expect(parsed.value.records[0].what.replaced[0].excerpt).toBe('逐字摘录')
      // Reading the view three times performs zero LLM work.
      for (let i = 0; i < 3; i++) await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1`)
      expect(globalThis.__retraceLlmCalls).toBe(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('still serves the what digest when the summary switch is OFF', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { appendSummary } = await import('../lib/summary-store.js')
    const root = mkdtempSync(join(tmpdir(), 'retrace-route-'))
    try {
      // The `what` line is written regardless of the switch; only `summary` is absent.
      await appendSummary(root, 's1', {
        boundarySeq: 12,
        versionId: 'v12',
        summaryEnabled: false,
        called: false,
        what: {
          op: 'recall',
          at: 1789130493921,
          new: { excerpt: '' },
          replaced: [
            { seq: 10, role: 'user', excerpt: '逐字原文（撤回前的问题）' },
            { seq: 11, role: 'assistant', excerpt: '逐字原文（撤回前的回答）' },
          ],
        },
      })
      const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam: makeSummarySeam(root, { enabled: false }), rollback: {}, log: () => {} })
      const parsed = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1`)).body)
      expect(parsed.ok).toBe(true)
      expect(parsed.value.enabled).toBe(false) // the LLM switch is off…
      expect(parsed.value.records).toHaveLength(1)
      expect(parsed.value.records[0].summary).toBeUndefined() // …no summary…
      expect(parsed.value.records[0].what.replaced[0].excerpt).toBe('逐字原文（撤回前的问题）') // …but the row IS readable
      const md = await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1&format=md`)
      expect(md.body).toContain('called: no')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('narrows to one boundary and can render Markdown', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { appendSummary } = await import('../lib/summary-store.js')
    const root = mkdtempSync(join(tmpdir(), 'retrace-route-'))
    try {
      await appendSummary(root, 's1', { boundarySeq: 7, called: true, summary: '第一条' })
      await appendSummary(root, 's1', { boundarySeq: 9, called: true, summary: '第二条' })
      const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam: makeSummarySeam(root), rollback: {}, log: () => {} })
      const one = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1&boundarySeq=9`)).body)
      expect(one.value.records.map((r) => r.summary)).toEqual(['第二条'])
      const md = await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1&format=md`)
      expect(md.body).toContain('# dsh-retrace summaries')
      expect(md.body).toContain('第一条')
      expect(md.body).toContain('第二条')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a missing sessionId and degrades on an unreadable artifact', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const root = mkdtempSync(join(tmpdir(), 'retrace-route-'))
    try {
      const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam: makeSummarySeam(root), rollback: {}, log: () => {} })
      const bad = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries`)).body)
      expect(bad.ok).toBe(false)
      expect(bad.error.code).toBe('missing-session')
      const empty = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=absent`)).body)
      expect(empty.ok).toBe(true)
      expect(empty.value.records).toEqual([])
      expect(empty.value.error).toBeNull()
      const off = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=absent`)).body)
      expect(off.value.enabled).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------------------
// GET /summaries — the outline forest (`tree`)
// ---------------------------------------------------------------------------

describe('GET /summaries — outline forest', () => {
  const treeSeam = (root, { enabled = false } = {}) => ({
    configFor: () => ({ summary: enabled }),
    storeRoot: () => root,
  })

  const withRoot = async (records, run) => {
    const { mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { appendSummary } = await import('../lib/summary-store.js')
    const root = mkdtempSync(join(tmpdir(), 'retrace-tree-'))
    try {
      for (const record of records) await appendSummary(root, 's1', record)
      return await run(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  it('serves parent/children/discardedCount built from the exact discarded sets', async () => {
    await withRoot(
      [
        { boundarySeq: 24104, what: { op: 'compaction' }, discardedSeqs: [1, 2, 22216] },
        { boundarySeq: 22216, what: { op: 'replace' }, discardedSeqs: [7, 8] },
      ],
      async (root) => {
        const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam: treeSeam(root), rollback: {}, log: () => {} })
        const parsed = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1`)).body)
        expect(parsed.value.tree['24104']).toEqual({ parent: null, children: [22216], discardedCount: 3 })
        expect(parsed.value.tree['22216']).toEqual({ parent: 24104, children: [], discardedCount: 2 })
      },
    )
  })

  it('omits tree entirely when no record carries a discarded set (client falls back to flat)', async () => {
    await withRoot([{ boundarySeq: 7, called: true, summary: 'x' }], async (root) => {
      const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam: treeSeam(root), rollback: {}, log: () => {} })
      const parsed = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1`)).body)
      expect(parsed.value.records).toHaveLength(1)
      expect(Object.hasOwn(parsed.value, 'tree')).toBe(false)
    })
  })

  it('keeps the WHOLE forest even when the request narrows to one boundary', async () => {
    await withRoot(
      [
        { boundarySeq: 10, discardedSeqs: [1, 9, 5] },
        { boundarySeq: 9, discardedSeqs: [] },
        { boundarySeq: 5, discardedSeqs: [] },
      ],
      async (root) => {
        const handler = createRetraceHttpHandler({}, { sessions: {}, agents: {}, seam: treeSeam(root), rollback: {}, log: () => {} })
        const parsed = JSON.parse((await get(handler, `${ROUTE_PREFIX}/summaries?sessionId=s1&boundarySeq=9`)).body)
        expect(parsed.value.records.map((r) => r.boundarySeq)).toEqual([9])
        expect(Object.keys(parsed.value.tree).sort()).toEqual(['10', '5', '9'])
        expect(parsed.value.tree['9'].parent).toBe(10)
      },
    )
  })
})
