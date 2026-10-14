/**
 * 撤回 · 连带终止本轮派生任务（方案 A）。
 *
 * 现场缺陷：撤回只停"当前这一轮"，本轮派生出去的子代理会话与后台作业不在终止范围
 * 内 ⇒ 撤回之后它们继续写事件，时间线又继续了。
 *
 * 这一套件按设计文档的六条验收逐条钉住，并额外钉住"真的会失败"的那几条：
 *   ① 运行中子代理 ⇒ 被取消（interrupt 被调、状态离开 running）、撤回后无新事件；
 *   ② 运行中后台作业 ⇒ 被终止（job_kill 被调、状态进终态）；
 *   ③ **不误杀对照组**：早于撤回点创建的子代理/作业保持运行、终止调用一次都没打；
 *   ④ 失败路径：注入终止 API 失败 ⇒ 指名道姓的提示出现**恰好 1 次**；
 *   ⑤ 竞态/幂等：任务在终止过程中自行结束 ⇒ 不报错、不出提示、marker 只写一次；
 *   ⑥ 正常路径那条提示出现次数 = 0（用断言钉住，含客户端读法）。
 * 另外钉住顺序（终止在写 marker 之前）与"写后核对发现新事件 ⇒ 可见、但不冒充提示"。
 *
 * 枚举规则（设计 ）在真实父会话日志上的形态：
 *   · 子代理 = 父会话日志里 `subagent/catalog` 事件的持久 seq 落在被撤回区间内；
 *   · 作业   = 区间内**创建公告**里的 job id ∩ 官方 jobs 注册表里 owner=本会话者。
 */
import { describe, it, expect } from 'vitest'
import { createEditorApi } from '../lib/host-core.js'
import { derivedStuckNoticeOf } from '../lib/client.js'
import { createDerivedTaskBridge } from '../lib/index.js'
import { sessionEvents } from '../lib/host-compat.js'
import {
  makeSession, makeEnv, makeAgent, headerEvent, userMessage, assistantMessage,
  fakeCarrierWriter, lastCarrierMarker,
} from './helpers.js'

// ⛔ 不误杀的规则是"创建关系"，所以测试数据的 id 刻意分成区间内/区间外两批。
const CHILD_IN = 'child-inside-round'
const CHILD_OUT = 'child-outside-round'
const JOB_IN = 'job-inside-round'
const JOB_OUT = 'job-outside-round'

/** 追加一条 log-only 事件（不进 surface）——两个创建凭据在真日志里都不是面节点。 */
function seedLogOnly(session, event) {
  const record = session.appendRaw(event)
  session.surface.nodes = session.surface.nodes.filter((seq) => seq !== record.seq)
  return record
}

/** 子代理创建凭据：父会话日志的 `subagent/catalog`（官方 catalog.js 的形状）。 */
function catalogEvent(childId, label) {
  return { type: 'subagent/catalog', data: { version: 0, childId, childCreatedAt: 0, mode: 'continuable', label } }
}

/** 后台作业创建公告（官方产出口径：`started background subagent job <jobId>`）。 */
function jobAnnouncement(id, jobId) {
  return {
    type: 'tool/result',
    data: {
      message: {
        id,
        role: 'tool',
        source: { kind: 'tool', callId: `call-${id}` },
        content: [{
          type: 'tool-result',
          toolCallId: `call-${id}`,
          content: [{ type: 'text', text: `started background subagent job ${jobId}` }],
        }],
      },
      name: 'subagent',
    },
  }
}

/**
 * 标准测试数据（seq 即下标）：
 *   0 header ｜ 1 作业公告 JOB_OUT（区间外）｜ 2 catalog CHILD_OUT（区间外）
 *   3 u1 ← 撤回点 ｜ 4 a1 ｜ 5 catalog CHILD_IN ｜ 6 作业公告 JOB_IN ｜ 7 u2 ｜ 8 a2
 * 撤回 u1 = tail 语义 ⇒ 区间 = 3..8：区间内的两个创建凭据在 5/6，区间外的在 1/2。
 */
function seedSession() {
  const session = makeSession()
  session.appendRaw(headerEvent())
  seedLogOnly(session, jobAnnouncement('t-out-job', JOB_OUT))
  seedLogOnly(session, catalogEvent(CHILD_OUT, 'earlier round child'))
  session.appendRaw(userMessage('u1', 'recall me'))
  session.appendRaw(assistantMessage('a1', 'answer one'))
  seedLogOnly(session, catalogEvent(CHILD_IN, 'this round child'))
  session.appendRaw(jobAnnouncement('t-in-job', JOB_IN))
  session.appendRaw(userMessage('u2', 'next'))
  session.appendRaw(assistantMessage('a2', 'answer two'))
  return session
}

/**
 * 假平台：一个真 `createDerivedTaskBridge`（生产同一份代码）+ 可注入失败的官方面。
 * @param {object} opts
 * @param {boolean} [opts.failInterrupt] - 子代理终止调用抛错
 * @param {boolean} [opts.failKill] - 作业终止调用抛错（失败路径用）
 * @param {boolean} [opts.stallKill] - 作业终止调用**返回成功但状态不变**（模拟没停成）
 * @param {boolean} [opts.hangInterrupt] - 子代理终止调用永不 settle（每目标超时用）
 * @param {boolean} [opts.selfFinish] - 终止调用返回失败，但任务自己已经结算（竞态用）
 * @param {boolean} [opts.dropStatusHook] - 不装配读数面（不可判定路径用）
 * @param {boolean} [opts.dropTerminateHooks] - 不装配终止能力（装配缺口路径用）
 */
function makePlatform(session, opts = {}) {
  const order = []
  const interruptCalls = []
  const killCalls = []
  const subagentSessions = new Map([[CHILD_IN, { id: CHILD_IN, seq: 10 }], [CHILD_OUT, { id: CHILD_OUT, seq: 4 }]])
  const subagentAgents = new Map([[CHILD_IN, { id: CHILD_IN, status: 'running' }], [CHILD_OUT, { id: CHILD_OUT, status: 'running' }]])
  const jobs = new Map([
    [JOB_IN, { id: JOB_IN, owner: 's1', label: 'this round job', status: 'running', output: { total: 7 } }],
    [JOB_OUT, { id: JOB_OUT, owner: 's1', label: 'earlier round job', status: 'running', output: { total: 3 } }],
  ])
  const subagentsService = {
    interrupt(id, authority) {
      order.push(`interrupt:${id}`)
      interruptCalls.push({ id, authority })
      if (opts.hangInterrupt) return new Promise(() => {})
      if (opts.failInterrupt) throw new Error(`injected interrupt failure for ${id}`)
      subagentAgents.get(id).status = 'idle'
      return undefined
    },
  }
  const ctx = {
    jobs: {
      list: (caller) => {
        const owner = typeof caller === 'string' ? caller : caller?.id
        return [...jobs.values()].filter((job) => job.owner === owner).map((job) => ({ ...job }))
      },
      kill: (id, caller, reason) => {
        order.push(`kill:${id}`)
        killCalls.push({ id, caller, reason })
        const job = jobs.get(id)
        if (opts.failKill) throw new Error(`injected job_kill failure for ${id}`)
        // 竞态：任务在我们终止它的同时自己结算了 —— 终止调用按官方语义报"已经结束"，
        // 但对调用方就是一次**失败**（ok:false）。规则必须看"它是否还在跑"，而不是
        // 只看"调用有没有报错"。
        if (opts.selfFinish) { job.status = 'succeeded'; throw new Error(`injected: job ${id} already finished`) }
        if (opts.stallKill) return 'requested'
        job.status = 'killed'
        return 'requested'
      },
    },
    sessions: { get: (id) => (id === session.id ? session : subagentSessions.get(id)) },
    agents: { get: (id) => subagentAgents.get(id) },
    get: (name) => (name === 'subagents' ? subagentsService : undefined),
    subagents: subagentsService,
  }
  const bridge = createDerivedTaskBridge({ ctx, log: () => {}, reader: { readEvents: async () => null } })
  const readStatus = bridge.derivedStatus
  const hooks = {
    validateMarker: async () => ({ t1Ok: true }),
    writeMarker: fakeCarrierWriter({ onWrite: () => order.push('marker') }),
    ...bridge,
    // 记一笔读数（顺序断言用）：静默确认与写后核对都必须走这个面。
    derivedStatus: (payload) => { order.push('status'); return readStatus(payload) },
  }
  if (opts.dropStatusHook) delete hooks.derivedStatus
  if (opts.dropTerminateHooks) { delete hooks.interruptSubagent; delete hooks.killDerivedJob }
  return {
    hooks, order, interruptCalls, killCalls, jobs, subagentAgents, subagentSessions, bridge,
    rowOf: (target) => (target.kind === 'job' ? jobs.get(target.id) : subagentAgents.get(target.id)),
  }
}

function makeApi(session, hooks) {
  const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
  return createEditorApi({}, sessions, agents, () => {}, hooks)
}

/** 小超时测试数据：默认 10s / 3s 的窗口在测试里换成毫秒级（op 参数即配置面）。 */
const FAST = { derivedTerminateMs: 30, derivedQuietMs: 30, derivedVerifyMs: 5, derivedPollMs: 2 }

describe('枚举规则：只认有明确创建关系的任务（设计 1 节）', () => {
  it('子代理 = 父会话日志里 subagent/catalog 的持久 seq 落在被撤回区间内', async () => {
    const session = seedSession()
    const api = makeApi(session, makePlatform(session).hooks)
    const result = await api.recall({ sessionId: 's1', messageId: 'u1', ...FAST })
    expect(result.ok).toBe(true)
    const ids = result.value.derived.enumerated.map((t) => t.id)
    expect(ids).toContain(CHILD_IN)   // catalog@5 ∈ [3,8]
    expect(ids).not.toContain(CHILD_OUT) // catalog@2 ∉ [3,8]
  })

  it('作业 = 区间内创建公告的 job id ∩ owner=本会话（区间外公告与已结算作业都不入选）', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    platform.jobs.get(JOB_IN).status = 'killed' // 已结算：没有可停的，不入终止集合
    const api = makeApi(session, platform.hooks)
    const result = await api.recall({ sessionId: 's1', messageId: 'u1', ...FAST })
    const ids = result.value.derived.enumerated.map((t) => t.id)
    expect(ids).not.toContain(JOB_IN)
    expect(ids).not.toContain(JOB_OUT) // 公告在 seq=1（区间外）
    expect(platform.killCalls).toHaveLength(0)
  })

  it('平台桥的终止原语就是官方 API：jobs.kill(id, 会话id, reason) 与 subagents.interrupt(子id, {kind:user,parentSessionId})', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(result.ok).toBe(true)
    expect(result.value.derived.enumerated.map((t) => t.id).sort()).toEqual([CHILD_IN, JOB_IN].sort())
    expect(platform.killCalls).toEqual([{ id: JOB_IN, caller: 's1', reason: expect.stringContaining('recall') }])
    expect(platform.interruptCalls).toEqual([{ id: CHILD_IN, authority: { kind: 'user', parentSessionId: 's1' } }])
  })
})

describe('① 运行中子代理 ⇒ 被取消，撤回后无新事件', () => {
  it('interrupt 被调、状态离开 running、结果如实记账、写 marker 成功', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(result.ok).toBe(true)
    expect(platform.interruptCalls.map((c) => c.id)).toEqual([CHILD_IN])
    expect(platform.subagentAgents.get(CHILD_IN).status).toBe('idle') // 不再是 running
    expect(result.value.derived.terminated).toEqual([
      { kind: 'subagent', id: CHILD_IN, ok: true, timedOut: false, error: null },
      { kind: 'job', id: JOB_IN, ok: true, timedOut: false, error: null },
    ])
    expect(result.value.derived.quiet).toEqual([`subagent:${CHILD_IN}`, `job:${JOB_IN}`])
    expect(result.value.derived.afterMarkerActivity).toEqual([]) // 写后核对：新事件数 = 0
    expect(result.value.derived.verified).toBe(true)
    expect(result.value.markerSeq).toBeGreaterThan(0)
  })
})

describe('② 运行中后台作业 ⇒ 被终止', () => {
  it('job_kill 被调、状态进终态、写后无新输出', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(platform.killCalls.map((c) => c.id)).toEqual([JOB_IN])
    expect(platform.jobs.get(JOB_IN).status).toBe('killed')
    expect(platform.jobs.get(JOB_OUT).status).toBe('running') // 对照组不受影响
    expect(result.value.derived.terminated.find((t) => t.id === JOB_IN)).toMatchObject({ ok: true, timedOut: false })
    expect(result.value.derived.afterMarkerActivity).toEqual([])
  })
})

describe('③ 不误杀对照组：与撤回区间无创建关系的任务保持运行', () => {
  it('区间外的子代理与作业：终止调用一次都没打，状态不变', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(platform.interruptCalls.some((c) => c.id === CHILD_OUT)).toBe(false)
    expect(platform.killCalls.some((c) => c.id === JOB_OUT)).toBe(false)
    expect(platform.subagentAgents.get(CHILD_OUT).status).toBe('running')
    expect(platform.jobs.get(JOB_OUT).status).toBe('running')
  })

  it('终止原语按官方口径拒绝跨会话目标（jobs.kill 的 caller 不是它 ⇒ 不越过所有权）', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })
    // 每次作业终止都带上了本会话 id —— 官方 assertAccess 会据此拒绝别人的 job。
    expect(platform.killCalls.every((c) => c.caller === 's1')).toBe(true)
    expect(platform.interruptCalls.every((c) => c.authority.parentSessionId === 's1')).toBe(true)
  })
})

describe('④ 失败路径：注入终止失败 ⇒ 指名道姓的提示恰好 1 次', () => {
  it('作业终止抛错且一直 running ⇒ 重试 1 次、提示出现 1 次、点名 job id 与手动停法', async () => {
    const session = seedSession()
    const platform = makePlatform(session, { failKill: true })
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(result.ok).toBe(true) // 撤回本身照常成功（fail-soft）
    expect(platform.killCalls).toHaveLength(2) // 首次 + 重试 1 次（不循环）
    expect(result.value.derived.terminated.find((t) => t.id === JOB_IN)).toMatchObject({ ok: false })
    expect(result.value.derived.stuck).toHaveLength(1)
    expect(result.value.derived.stuck[0]).toMatchObject({ kind: 'job', id: JOB_IN, reason: 'still-running' })
    const notice = result.value.derivedNotice
    expect(typeof notice).toBe('string')
    expect(notice).toContain(JOB_IN)      // 指名道姓
    expect(notice).toContain('job_kill')  // 怎么手动停
    expect((notice.match(/未能停止/g) || []).length).toBe(1) // 恰好 1 条提示
    // 客户端读法与 host 同源，且同样只出现一次
    const clientNotice = derivedStuckNoticeOf(result.value)
    expect(clientNotice).toBe(notice)
    expect((clientNotice.match(/手动停止/g) || []).length).toBe(1)
  })

  it('子代理终止抛错且仍 running ⇒ 提示点名 interrupt_agent', async () => {
    const session = seedSession()
    const platform = makePlatform(session, { failInterrupt: true })
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })
    expect(platform.interruptCalls.filter((c) => c.id === CHILD_IN)).toHaveLength(2)
    const notice = result.value.derivedNotice
    expect(notice).toContain(CHILD_IN)
    expect(notice).toContain('interrupt_agent')
  })

  it('终止调用挂起 ⇒ 每目标超时记为 timedOut，重试 1 次，提示仍然只 1 条', async () => {
    const session = seedSession()
    // 只让作业侧挂起（子代理照常停），验证"每目标一个超时"而非全局卡住。
    const platform = makePlatform(session)
    platform.hooks.killDerivedJob = () => new Promise(() => {})
    const result = await makeApi(session, platform.hooks).recall({
      sessionId: 's1', messageId: 'u1', ...FAST, derivedTerminateMs: 10,
    })
    expect(result.ok).toBe(true)
    const jobRow = result.value.derived.terminated.find((t) => t.id === JOB_IN)
    expect(jobRow).toMatchObject({ ok: false, timedOut: true })
    expect(result.value.derived.stuck).toHaveLength(1)
    expect((result.value.derivedNotice.match(/未能停止/g) || []).length).toBe(1)
  })
})

describe('⑤ 竞态/幂等：任务在终止过程中自行结束', () => {
  it('终止调用返回失败但任务已自行结算 ⇒ 不报错、不出提示、marker 只写一次', async () => {
    const session = seedSession()
    const platform = makePlatform(session, { selfFinish: true })
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(result.ok).toBe(true)
    expect(result.value.derived.terminated.find((t) => t.id === JOB_IN)).toMatchObject({ ok: false })
    expect(result.value.derived.stuck).toEqual([])              // 没停成才报；它停了 ⇒ 不报
    expect(result.value.derivedNotice).toBeUndefined()
    expect(derivedStuckNoticeOf(result.value)).toBe('')
    expect(platform.order.filter((x) => x === 'marker')).toHaveLength(1) // 不重复写 marker
    const carriers = sessionEvents(session).filter((e) => e.type === 'user/message' && String(e.data?.id).startsWith('retrace-recall-'))
    expect(carriers).toHaveLength(1)
    expect(lastCarrierMarker(session)).toBeTruthy()
  })

  it('读数面未装配 ⇒ 不崩、marker 照写、如实记 verified=false 且不冒充提示', async () => {
    const session = seedSession()
    const platform = makePlatform(session, { dropStatusHook: true })
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })
    expect(result.ok).toBe(true)
    expect(result.value.derived.verified).toBe(false)
    expect(result.value.derived.afterMarkerActivity).toEqual([])
    expect(result.value.derivedNotice).toBeUndefined() // 没有"它还在跑"的证据 ⇒ 不出提示
    expect(sessionEvents(session).some((e) => e.type === 'user/message' && String(e.data?.id).startsWith('retrace-recall-'))).toBe(true)
  })
})

describe('装配缺口：宿主没注入终止能力 ⇒ 不枚举、不提示（不冒充做了）', () => {
  it('零终止注入面时：既不调终止、也不出 B 提示，结果如实标 skipped', async () => {
    const session = seedSession()
    const platform = makePlatform(session, { dropTerminateHooks: true })
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(result.ok).toBe(true)
    expect(result.value.derived.enumerated).toEqual([])
    expect(result.value.derived.skipped).toBe('no-terminate-capability')
    expect(result.value.derivedNotice).toBeUndefined()
    expect(derivedStuckNoticeOf(result.value)).toBe('')
    expect(result.value.markerSeq).toBeGreaterThan(0) // 撤回照常完成
  })
})

describe('⑥ 正常路径那条提示出现次数 = 0', () => {
  it('全部派生任务都停得下来 ⇒ 结果里没有 derivedNotice，文案里也没有"未能停止"', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(result.ok).toBe(true)
    expect(result.value.derivedNotice).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(result.value, 'derivedNotice')).toBe(false)
    expect(derivedStuckNoticeOf(result.value)).toBe('')
    expect(JSON.stringify(result.value)).not.toContain('未能停止')
    expect(result.value.derived.stuck).toEqual([])
  })

  it('本会话根本没有派生任务 ⇒ 一个终止调用都不发生（零开销路径）', async () => {
    const session = makeSession().seed(
      headerEvent(),
      userMessage('u1', 'hello'),
      assistantMessage('a1', 'hi'),
    )
    const platform = makePlatform(session)
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })
    expect(result.ok).toBe(true)
    expect(result.value.derived.enumerated).toEqual([])
    expect(platform.interruptCalls).toEqual([])
    expect(platform.killCalls).toEqual([])
    expect(result.value.derivedNotice).toBeUndefined()
  })
})

describe('顺序与写后核对（设计 2 节）', () => {
  it('终止在写 marker 之前；静默确认（状态读数）也在写 marker 之前', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    const markerAt = platform.order.indexOf('marker')
    const interruptAt = platform.order.indexOf(`interrupt:${CHILD_IN}`)
    const killAt = platform.order.indexOf(`kill:${JOB_IN}`)
    expect(markerAt).toBeGreaterThan(-1)
    expect(interruptAt).toBeGreaterThan(-1)
    expect(killAt).toBeGreaterThan(-1)
    expect(interruptAt).toBeLessThan(markerAt)
    expect(killAt).toBeLessThan(markerAt)
    // 静默确认（读数）也在写 marker 之前；写后核对在 marker 之后还会再读数两次。
    expect(platform.order.lastIndexOf('status', markerAt)).toBeGreaterThan(-1)
    expect(platform.order.slice(markerAt + 1).filter((x) => x === 'status').length).toBeGreaterThanOrEqual(2)
  })

  it('静默确认超时也放行写 marker，但如实记入未静默集合', async () => {
    const session = seedSession()
    // 终止调用"成功"但状态不变（没停成）⇒ 静默窗口耗尽。
    const platform = makePlatform(session, { stallKill: true })
    platform.subagentAgents.get(CHILD_IN).status = 'running' // 子代理也不再变
    platform.hooks.interruptSubagent = () => ({ ok: true, value: { accepted: true } })
    const result = await makeApi(session, platform.hooks).recall({
      sessionId: 's1', messageId: 'u1', ...FAST, derivedQuietMs: 5, derivedPollMs: 1,
    })
    expect(result.ok).toBe(true)
    expect(result.value.derived.unquiet.map((r) => r.id).sort()).toEqual([CHILD_IN, JOB_IN].sort())
    expect(result.value.markerSeq).toBeGreaterThan(0) // 超时也放行（设计 ）
    expect(result.value.derived.stuck).toHaveLength(2) // 真的没停下来 ⇒ 提示
    expect((result.value.derivedNotice.match(/未能停止/g) || []).length).toBe(1)
  })

  it('写后核对发现新事件 ⇒ 如实进 afterMarkerActivity（可见），但终止成功就不冒充提示', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    let marked = false
    let postMarkerReads = 0
    platform.hooks.writeMarker = fakeCarrierWriter({ onWrite: () => { marked = true; platform.order.push('marker') } })
    platform.hooks.derivedStatus = async () => {
      if (marked) postMarkerReads += 1
      // 写 marker 之后的第二次读数（核对末次）凭空多出 2 条事件 = 子代理又写了。
      const grown = marked && postMarkerReads >= 2
      return [
        { kind: 'subagent', id: CHILD_IN, status: 'idle', events: grown ? 12 : 10 },
        { kind: 'job', id: JOB_IN, status: 'killed', events: 7 },
      ]
    }
    const result = await makeApi(session, platform.hooks).recall({ sessionId: 's1', messageId: 'u1', ...FAST })

    expect(result.value.derived.verified).toBe(true)
    expect(result.value.derived.afterMarkerActivity).toEqual([
      { kind: 'subagent', id: CHILD_IN, newEvents: 2, status: 'idle' },
    ])
    expect(postMarkerReads).toBe(2) // 基线 + 核对末次
    // 终止调用都成功 ⇒ 这不是"终止不了"⇒ 不出 B 提示（B 只对"没停成"负责）
    expect(result.value.derivedNotice).toBeUndefined()
  })
})

describe('写后核对窗口确实等满（可配置）', () => {
  it('等满 derivedVerifyMs 才断言新事件数（不等 ⇒ 变异为 0 会红）', async () => {
    const session = seedSession()
    const platform = makePlatform(session)
    const windowMs = 60
    const started = Date.now()
    const result = await makeApi(session, platform.hooks).recall({
      sessionId: 's1', messageId: 'u1', ...FAST, derivedVerifyMs: windowMs,
    })
    const elapsed = Date.now() - started
    expect(result.ok).toBe(true)
    expect(result.value.derived.verified).toBe(true)
    expect(elapsed).toBeGreaterThanOrEqual(windowMs - 10)
    expect(elapsed).toBeLessThan(2000)
  })
})

describe('配置面：默认值即设计文档的 10s / 3s', () => {
  it('常量与设计一致（默认终止超时 10s、写后核对 3s）', async () => {
    const host = await import('../lib/host-core.js')
    expect(host.DERIVED_TERMINATE_TIMEOUT_MS).toBe(10000)
    expect(host.DERIVED_VERIFY_MS).toBe(3000)
    expect(host.DERIVED_QUIET_TIMEOUT_MS).toBe(10000)
  })

  it('纯函数规则：区间/静止/提示文案', async () => {
    const host = await import('../lib/host-core.js')
    const span = { start: 3, end: 8 }
    expect(host.inRecalledSpan(3, span)).toBe(true)
    expect(host.inRecalledSpan(8, span)).toBe(true)
    expect(host.inRecalledSpan(2, span)).toBe(false)
    expect(host.inRecalledSpan(9, span)).toBe(false)
    expect(host.derivedStatusIsQuiet('idle')).toBe(true)
    expect(host.derivedStatusIsQuiet('succeeded')).toBe(true)
    expect(host.derivedStatusIsQuiet('running')).toBe(false)
    expect(host.derivedStatusIsQuiet('stopping')).toBe(false)
    expect(host.derivedStuckNotice([])).toBe('')
    const notice = host.derivedStuckNotice([{ kind: 'job', id: 'job-x', status: 'running', terminateError: 'boom' }])
    expect(notice).toContain('job-x')
    expect(notice).toContain('boom')
    expect((notice.match(/未能停止/g) || []).length).toBe(1)
  })
})
