/**
 * dsh-retrace — test/close-guard-client.test.js
 * 关闭守卫 V2客户端纯逻辑层:reason 解析/本地化文案/快照判定/
 * 运行中清单/放行标记。
 */
import { describe, it, expect } from 'vitest'
import {
  parseReason,
  describeReason,
  sessionLine,
  runningLines,
  classifySnapshot,
  isStale,
  buildRunningCopy,
  createGuardStore,
  GUARD_ARM_TTL_MS,
  GUARD_POLL_MS,
} from '../lib/close-guard-client.js'

describe('close-guard-client parseReason(host reason 形状,对齐)', () => {
  it('识别四种官方 reason', () => {
    expect(parseReason('agent-running')).toEqual({ code: 'agent-running' })
    expect(parseReason('queued-2')).toEqual({ code: 'queued', count: 2 })
    expect(parseReason('jobs-1')).toEqual({ code: 'jobs', count: 1 })
    expect(parseReason('unclosed-turn-1,3')).toEqual({ code: 'unclosed-turn', turns: [1, 3] })
  })

  it('未知形状兜底不崩(未来 host 新增 reason)', () => {
    expect(parseReason('something-new-7')).toEqual({ code: 'other', raw: 'something-new-7' })
    expect(parseReason(undefined)).toEqual({ code: 'other', raw: '' })
  })
})

describe('close-guard-client describeReason(本地化文案)', () => {
  it('zh 文案', () => {
    expect(describeReason('agent-running', 'zh')).toBe('正在运行')
    expect(describeReason('queued-2', 'zh')).toBe('排队待办 2 条')
    expect(describeReason('jobs-1', 'zh')).toBe('后台任务 1 个')
    expect(describeReason('unclosed-turn-1,3', 'zh')).toBe('未闭合轮次 1、3')
  })

  it('en 文案', () => {
    expect(describeReason('agent-running', 'en')).toBe('agent running')
    expect(describeReason('queued-2', 'en')).toBe('2 queued')
    expect(describeReason('jobs-2', 'en')).toBe('2 background jobs')
    expect(describeReason('jobs-1', 'en')).toBe('1 background job')
    expect(describeReason('unclosed-turn-1,3', 'en')).toBe('unclosed turn 1,3')
  })

  it('未知 reason 回显原文', () => {
    expect(describeReason('wat-9', 'zh')).toBe('wat-9')
  })
})

describe('close-guard-client sessionLine/runningLines(A 明细聚合)', () => {
  it('单会话一行:会话 id + 各原因', () => {
    expect(sessionLine({ sessionId: 's1', reasons: ['agent-running', 'jobs-1'] }, { locale: 'zh' }))
      .toBe('- 会话 s1: 正在运行; 后台任务 1 个')
    expect(sessionLine({ sessionId: 's1', reasons: ['queued-2'] }, { locale: 'en' }))
      .toBe('- session s1: 2 queued')
  })

  it('label 覆盖原始 id(UI 传短码)', () => {
    expect(sessionLine({ sessionId: 'a-very-long-id', reasons: ['agent-running'] }, { locale: 'zh', label: 'member-65member-16' }))
      .toBe('- 会话 member-65member-16: 正在运行')
  })

  it('reasons 缺失兜底不崩', () => {
    expect(sessionLine({ sessionId: 's1' }, { locale: 'zh' })).toBe('- 会话 s1: 运行中(原因未识别)')
  })

  it('runningLines 多会话聚合(labelOf 逐会话短码)', () => {
    const running = [
      { sessionId: 'aaa', reasons: ['agent-running'] },
      { sessionId: 'bbb', reasons: ['jobs-2', 'unclosed-turn-5'] },
    ]
    const labelOf = (id) => (id === 'aaa' ? 'member-01' : 'member-02')
    const lines = runningLines(running, { locale: 'zh', labelOf })
    expect(lines).toEqual([
      '- 会话 member-01: 正在运行',
      '- 会话 member-02: 后台任务 2 个; 未闭合轮次 5',
    ])
  })
})

describe('close-guard-client classifySnapshot/isStale(beforeunload 同步判定)', () => {
  it('null/未同步 → unknown(不打扰);空清单 → idle;有运行 → running', () => {
    expect(classifySnapshot(null)).toBe('unknown')
    expect(classifySnapshot({})).toBe('unknown')
    expect(classifySnapshot({ running: [] })).toBe('idle')
    expect(classifySnapshot({ running: [{ sessionId: 's1', reasons: ['agent-running'] }] })).toBe('running')
  })

  it('TTL 只影响 stale 提示,不影响 A/B 判定', () => {
    const now = 1000000
    const fresh = { running: [], at: now - 1000 }
    expect(isStale(fresh, { ttlMs: 5000, now })).toBe(false)
    expect(isStale({ ...fresh, at: now - 60000 }, { ttlMs: 5000, now })).toBe(true)
    // 无 at(手动快照)→ 视为过期,但分类仍按内容
    expect(isStale({ running: [] }, { ttlMs: 5000, now })).toBe(true)
  })
})

describe('close-guard-client buildRunningCopy(A 文案,规格草案可微调)', () => {
  const snapshot = {
    running: [
      { sessionId: 's1', reasons: ['agent-running'] },
      { sessionId: 's2', reasons: ['queued-2', 'jobs-1'] },
    ],
    at: Date.now(),
  }

  it('head 含会话计数 + 每会话明细行', () => {
    const copy = buildRunningCopy(snapshot, { locale: 'zh' })
    expect(copy.head).toContain('2 个会话存在运行中任务')
    expect(copy.lines).toHaveLength(2)
    expect(copy.lines[0]).toContain('正在运行')
    expect(copy.lines[1]).toContain('排队待办 2 条')
  })

  it('过期快照附带 stale 提示(文案诚实:状态可能已变化)', () => {
    const stale = buildRunningCopy(
      { running: snapshot.running, at: Date.now() - 60000 },
      { locale: 'zh', ttlMs: 5000 },
    )
    expect(stale.stale).toBe(true)
    expect(stale.hint).toContain('可能已变化')
    const fresh = buildRunningCopy(snapshot, { locale: 'zh', ttlMs: 5000 })
    expect(fresh.stale).toBe(false)
  })
})

describe('close-guard-client createGuardStore(放行标记:二次触发语义)', () => {
  it('arm 后短时内放行,超 GUARD_ARM_TTL_MS 重新确认', () => {
    let t = 1
    const store = createGuardStore({ now: () => t })
    expect(store.isArmed()).toBe(false)
    store.arm()
    expect(store.isArmed()).toBe(true)
    t = GUARD_ARM_TTL_MS + 2
    expect(store.isArmed()).toBe(false)
  })

  it('disarm/状态复位清除放行;快照 set/get 保留 at 时间戳', () => {
    const store = createGuardStore({ now: () => 42 })
    store.set({ running: [{ sessionId: 's1', reasons: ['agent-running'] }] })
    expect(store.get().running).toHaveLength(1)
    expect(store.get().at).toBe(42)
    store.arm()
    store.disarm()
    expect(store.isArmed()).toBe(false)
  })
})

describe('close-guard-client 轮询常量(与装配一致)', () => {
  it('GUARD_POLL_MS 为 5s(beforeunload 前状态最多落后一轮)', () => {
    expect(GUARD_POLL_MS).toBe(5000)
  })
})
