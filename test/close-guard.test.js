import { describe, it, expect, vi } from 'vitest'
import { runningState, runningSessions, sessionRunningState, attachCloseGuard } from '../lib/close-guard.js'
import { resetHostCompatDiagnostics } from '../lib/host-compat.js'

/** 合成 agent(官方形态:id/status/inbox)。 */
function makeAgent(status = 'idle', inbox = {}) {
  return { id: 's1', status, inbox }
}

/**
 * 合成 session —— 默认 = **真实生产新宿主**（DSH Desktop 2.0.9）：只有
 * `snapshotEvents()`/`eventAt()`，**没有 `events` 成员**（复核：
 * 假会话只有 events 时，守卫型静默回退在整套用例下测不出来）。
 * 旧宿主 events 数组由 `legacySessionWith` 显式覆盖。
 */
function sessionWith(events, id = 's1') {
  return { id, snapshotEvents: () => Object.freeze(events.slice()), eventAt: (seq) => events[seq] }
}

/** 显式旧宿主覆盖：events 数组是唯一视图。 */
function legacySessionWith(events, id = 's1') {
  return { id, events }
}

const openTurnEvents = () => [
  { type: 'turn/start', seq: 0, data: { turn: 1 } },
  { type: 'user/message', seq: 1, data: { id: 'u1', source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 2, data: { message: { id: 'a1' } } },
] // 尾部无 turn/end = 崩溃/强杀现场
const cleanEvents = () => [
  ...openTurnEvents(),
  { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: 'completed' } } },
]
const openTurnSession = (id = 's1') => sessionWith(openTurnEvents(), id)
const cleanSession = (id = 's1') => sessionWith(cleanEvents(), id)

describe('close-guard runningState(关闭守卫检测)', () => {
  it('agent running → agent-running', () => {
    const s = runningState('s1', { agent: makeAgent('running') })
    expect(s.running).toBe(true)
    expect(s.reasons).toContain('agent-running')
  })

  it('agent idle + 无 queued → 静止(不打扰)', () => {
    const s = runningState('s1', { agent: makeAgent('idle'), session: cleanSession() })
    expect(s.running).toBe(false)
    expect(s.reasons).toEqual([])
  })

  it('status=idle 但 inbox.hasPending(官方形状)→ 运行中(排队 work 也算)', () => {
    // 官方 Inbox:hasPending + nextStep/nextTurn 数组;无 queued/pending 字段
    const s = runningState('s1', { agent: makeAgent('idle', { hasPending: true, nextStep: [{ id: 'q1' }], nextTurn: [] }) })
    expect(s.running).toBe(true)
    expect(s.reasons).toContain('queued-1')
    // hasPending=true 但数组不可读 → queued-1(兜底)
    const s2 = runningState('s1', { agent: makeAgent('idle', { hasPending: true }) })
    expect(s2.running).toBe(true)
    expect(s2.reasons).toContain('queued-1')
    // 旧形状 queued/pending(非官方)→ 不再误报
    const s3 = runningState('s1', { agent: makeAgent('idle', { queued: [{ id: 'x' }] }) })
    expect(s3.running).toBe(false)
  })

  it('未闭合轮(崩溃现场)→ unclosed-turn;interrupted 正常闭合不算', () => {
    const open = runningState('s1', { agent: makeAgent('idle'), session: openTurnSession() })
    expect(open.running).toBe(true)
    expect(open.reasons.some((r) => r.startsWith('unclosed-turn-'))).toBe(true)
    const interrupted = runningState('s1', { agent: makeAgent('idle'), session: sessionWith([
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'assistant/message', seq: 1, data: { message: { id: 'a1' } } },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'interrupted' } } },
    ]) })
    expect(interrupted.running).toBe(false) // interrupted 是官方正常闭合
  })

  it('未闭合轮在**旧宿主**(显式 events 数组)上同样检出(回退未丢)', () => {
    const legacy = legacySessionWith(openTurnEvents())
    const state = runningState('s1', { agent: makeAgent('idle'), session: legacy })
    expect(state.running).toBe(true)
    expect(state.reasons.some((r) => r.startsWith('unclosed-turn-'))).toBe(true)
  })

  it('关联后台任务(官方 owner.id 形状)→ jobs-N', () => {
    const s = runningState('s1', { agent: makeAgent('idle'), session: cleanSession(), jobs: [{ id: 'j1', owner: { id: 's1' } }] })
    expect(s.running).toBe(true)
    expect(s.reasons).toContain('jobs-1')
    // owner 为字符串 id 也认(部分快照形状)
    const s2 = runningState('s1', { agent: makeAgent('idle'), session: cleanSession(), jobs: [{ id: 'j2', owner: 's1' }] })
    expect(s2.running).toBe(true)
    // 旧形状 sessionId(非官方)→ 不再误报
    const s3 = runningState('s1', { agent: makeAgent('idle'), session: cleanSession(), jobs: [{ id: 'j3', sessionId: 's1' }] })
    expect(s3.running).toBe(false)
  })

  it('他人会话的 jobs 不算', () => {
    const s = runningState('s1', { agent: makeAgent('idle'), session: cleanSession(), jobs: [{ id: 'j1', owner: { id: 'other' } }] })
    expect(s.running).toBe(false)
  })
})

describe('close-guard runningSessions/sessionRunningState(全量/单会话)', () => {
  function makeCtx(entries) {
    const sessions = new Map(entries.map(([id, session]) => [id, session]))
    const agents = new Map(entries.map(([id, agent]) => [id, agent]))
    return {
      sessions: {
        keys: () => sessions.keys(),
        get: (id) => sessions.get(id),
      },
      agents: {
        get: (id) => agents.get(id),
      },
      jobs: { list: () => [] },
    }
  }

  it('全会话扫描:只返回运行中(静止不打扰)', () => {
    const ctx = makeCtx([
      ['s1', cleanSession()],
      ['s2', openTurnSession()],
    ])
    ctx.agents.get = (id) => (id === 's1' ? makeAgent('running') : makeAgent('idle'))
    const running = runningSessions(ctx)
    expect(running.map((r) => r.sessionId).sort()).toEqual(['s1', 's2'])
    expect(running.find((r) => r.sessionId === 's1').reasons).toContain('agent-running')
    expect(running.find((r) => r.sessionId === 's2').reasons.some((x) => x.startsWith('unclosed-turn-'))).toBe(true)
  })

  it('全静止 → 空数组(不打扰)', () => {
    const ctx = makeCtx([['s1', cleanSession()]])
    ctx.agents.get = () => makeAgent('idle')
    expect(runningSessions(ctx)).toEqual([])
  })

  it('sessionRunningState 单会话查询(client 用)', () => {
    const ctx = makeCtx([['s1', openTurnSession()]])
    ctx.agents.get = () => makeAgent('idle')
    const state = sessionRunningState(ctx, 's1')
    expect(state.running).toBe(true)
  })

  it('jobs 服务缺失 → 不抛(降级为空)', () => {
    const ctx = makeCtx([['s1', cleanSession()]])
    delete ctx.jobs
    ctx.agents.get = () => makeAgent('idle')
    expect(() => runningSessions(ctx)).not.toThrow()
  })
})

describe('close-guard attachCloseGuard(dispose 强提示)', () => {
  it('有运行中会话 → 提示并列出原因;全静止 → 静默', () => {
    const log = vi.fn()
    const warn = (entries, runningIds) => {
      const sessions = new Map(entries)
      const ctx = {
        sessions: { keys: () => sessions.keys(), get: (id) => sessions.get(id) },
        agents: { get: () => null },
        jobs: { list: () => [] },
      }
      const dispose = attachCloseGuard(ctx, log)
      if (runningIds.includes('s1')) {
        // s1 通过 agent 侧 running(直接塞 fake agent)
        ctx.agents.get = (id) => (id === 's1' ? { status: 'running' } : null)
      }
      dispose()
    }
    // 全静止 → 不 log
    log.mockClear()
    warn([['s1', cleanSession()]], [])
    expect(log).not.toHaveBeenCalled()
    // s1 agent running → 提示
    log.mockClear()
    warn([['s1', cleanSession()]], ['s1'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retrace-close-guard'))
    expect(log.mock.calls[0][0]).toContain('运行中')
  })
})

describe('close-guard 会话枚举:新宿主 list() / 旧宿主 keys()(P1 静默退化回归)', () => {
  /** 官方 SessionStore 形状(实测 0.1.5-rc.1):list() 返回 Session[];没有 keys()。 */
  function newHostStore(sessions) {
    return { list: () => sessions, get: (id) => sessions.find((s) => s.id === id) }
  }
  /** 更早 Map 风格注册表(防御性回退形状,非实测宿主)。 */
  function oldHostStore(sessions) {
    const byId = new Map(sessions.map((s) => [s.id, s]))
    return { keys: () => byId.keys(), get: (id) => byId.get(id) }
  }
  const CASES = [
    openTurnSession('s-run'), // 未闭合轮 = 运行中
    openTurnSession('s-open2'),
    cleanSession('s-idle'), // 静止
  ]

  it('新宿主:list() 且无 keys() → runningSessions 看到全部 2 个运行中会话(旧实现得 0)', () => {
    const ctx = {
      sessions: newHostStore(CASES),
      agents: { get: () => makeAgent('idle') },
      jobs: { list: () => [] },
    }
    const running = runningSessions(ctx)
    expect(running.map((r) => r.sessionId).sort()).toEqual(['s-open2', 's-run'])
  })

  it('旧宿主:只有 keys() → 同样看到 2 个(旧宿主回退未丢)', () => {
    const ctx = {
      sessions: oldHostStore(CASES),
      agents: { get: () => makeAgent('idle') },
      jobs: { list: () => [] },
    }
    const running = runningSessions(ctx)
    expect(running.map((r) => r.sessionId).sort()).toEqual(['s-open2', 's-run'])
  })

  it('list() 抛异常 → 回退 keys(),不静默变 0', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = oldHostStore(CASES)
    store.list = () => { throw new Error('host bug') }
    const ctx = { sessions: store, agents: { get: () => makeAgent('idle') }, jobs: { list: () => [] } }
    expect(runningSessions(ctx).map((r) => r.sessionId).sort()).toEqual(['s-open2', 's-run'])
    spy.mockRestore()
  })

  it('既无 list 也无 keys → 空数组 + 可判定诊断(不静默;不猜服务字段)', () => {
    // 断言诊断而非仅返回值：旧 `Object.keys(service)` 实现同样返回 []，只有
    // 「明确的 no-api 诊断」能把「真没有会话」与「枚举 API 形状不认识」区分开。
    resetHostCompatDiagnostics()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const ctx = { sessions: { get: () => undefined }, agents: { get: () => null }, jobs: { list: () => [] } }
    expect(runningSessions(ctx)).toEqual([])
    expect(spy).toHaveBeenCalledTimes(1)
    expect(String(spy.mock.calls[0][0])).toContain('neither list() nor keys()')
    spy.mockRestore()
  })
})
