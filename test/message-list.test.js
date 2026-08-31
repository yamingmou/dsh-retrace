/**
 * Message-list projection unit tests (2026-09-01).
 *
 * 消息列表投影 = Agent 业务层第一个抽象能力：纯函数、零依赖、
 * 只理解「消息 + 遮蔽区间」，与 DSH surface/replace/turn 无关。
 */
import { describe, it, expect } from 'vitest'
import { projectMessageList, activeMessages, activeTurnCount, shadowSpanOf } from '../lib/message-list.js'

// 一个 3 轮对话的全量消息（seq 连续）
const conv = [
  { seq: 0, role: 'user', turn: 1, text: 'hi' },
  { seq: 1, role: 'assistant', turn: 1, text: 'yo' },
  { seq: 2, role: 'user', turn: 2, text: 'again' },
  { seq: 3, role: 'assistant', turn: 2, text: 'ok' },
  { seq: 4, role: 'user', turn: 3, text: 'more' },
  { seq: 5, role: 'assistant', turn: 3, text: 'done' },
]

describe('projectMessageList（投影：日志 → 当前列表）', () => {
  it('无遮蔽 → 全部 active', () => {
    const out = projectMessageList(conv)
    expect(out.every((m) => m.status === 'active')).toBe(true)
    expect(out.length).toBe(6)
  })

  it('遮蔽区间 → 覆盖的标 shadowed，其余 active', () => {
    const out = projectMessageList(conv, [{ start: 0, end: 1 }])
    expect(out[0].status).toBe('shadowed')
    expect(out[1].status).toBe('shadowed')
    expect(out[2].status).toBe('active')
    expect(out[5].status).toBe('active')
  })

  it('后应用的遮蔽覆盖先应用的（时间序）', () => {
    // 先遮 0-1，再遮 2-3 → 2-3 也 shadowed
    const out = projectMessageList(conv, [{ start: 0, end: 1 }, { start: 2, end: 3 }])
    expect(out.slice(0, 4).every((m) => m.status === 'shadowed')).toBe(true)
    expect(out[4].status).toBe('active')
  })

  it('精确 seq 集合(seqs)不误伤中间未遮蔽消息', () => {
    // 稀疏遮蔽 {5, 9, 20} 只影响这些 seq,中间消息保持 active
    const msgs = [{ seq: 5, role: 'user' }, { seq: 9, role: 'user' }, { seq: 20, role: 'user' }, { seq: 12, role: 'user' }]
    const out = projectMessageList(msgs, [{ seqs: [5, 9, 20] }])
    expect(out.map((m) => [m.seq, m.status])).toEqual([
      [5, 'shadowed'], [9, 'shadowed'], [20, 'shadowed'], [12, 'active'],
    ])
  })

  it('seqs 与 start/end 混用', () => {
    const out = projectMessageList(conv, [{ seqs: [0] }, { start: 4, end: 5 }])
    expect(out[0].status).toBe('shadowed')
    expect(out[4].status).toBe('shadowed')
    expect(out[1].status).toBe('active')
  })

  it('非法遮蔽区间忽略', () => {
    const out = projectMessageList(conv, [{ start: 3, end: 1 }])
    expect(out.every((m) => m.status === 'active')).toBe(true)
  })

  it('非数组输入 → 空', () => {
    expect(projectMessageList(null)).toEqual([])
    expect(projectMessageList(undefined, [{ start: 0, end: 1 }])).toEqual([])
  })
})

describe('activeMessages / activeTurnCount', () => {
  it('activeMessages 只含活跃消息（时间序）', () => {
    const active = activeMessages(conv, [{ start: 0, end: 1 }])
    expect(active.map((m) => m.seq)).toEqual([2, 3, 4, 5])
  })

  it('activeTurnCount 按 turn 去重', () => {
    expect(activeTurnCount(conv)).toBe(3)
    expect(activeTurnCount(conv, [{ start: 0, end: 1 }])).toBe(2) // 轮1被遮
    expect(activeTurnCount(conv, [{ start: 0, end: 5 }])).toBe(0) // 全遮
  })

  it('无 turn 时按 user 消息计', () => {
    const noTurn = conv.map(({ turn, ...rest }) => rest)
    expect(activeTurnCount(noTurn)).toBe(3)
  })
})

describe('shadowSpanOf（业务层遮蔽计算，不依赖宿主 surface）', () => {
  it('tail 模式：从目标遮蔽到当前活跃尾部', () => {
    const span = shadowSpanOf(conv, [], 2)
    expect(span).toEqual({ start: 2, end: 5, shadowedSeqs: [2, 3, 4, 5] })
  })

  it('tail 模式：编辑最后一条 → 只遮蔽自己（2026-09-01 长对话修复语义）', () => {
    const span = shadowSpanOf(conv, [], 4)
    expect(span).toEqual({ start: 4, end: 5, shadowedSeqs: [4, 5] })
  })

  it('round 模式：只遮蔽目标轮', () => {
    const span = shadowSpanOf(conv, [], 2, { mode: 'round' })
    expect(span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
  })

  it('已有遮蔽后：目标在被遮区间 → null', () => {
    const span = shadowSpanOf(conv, [{ start: 0, end: 3 }], 1)
    expect(span).toBeNull()
  })

  it('目标不存在 → null', () => {
    expect(shadowSpanOf(conv, [], 99)).toBeNull()
  })
})
