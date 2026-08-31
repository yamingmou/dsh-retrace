/**
 * Adapter layer unit tests (2026-09-01).
 *
 * 适配器层:业务层(message-list/守卫)与平台解耦——换架构时实现新的
 * EventReader/ReplaceWriter 即可,业务逻辑零改动。
 */
import { describe, it, expect } from 'vitest'
import { createAdapter, NULL_ADAPTER } from '../lib/adapter/contract.js'
import { computeSpan, isRoundBoundary, dshAdapter } from '../lib/adapter/dsh.js'

// 通用事件夹具(3 轮对话)
const events = [
  { seq: 0, type: 'user/message', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  { seq: 1, type: 'assistant/message', data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: 'yo' }] } } },
  { seq: 2, type: 'user/message', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'again' }] } },
  { seq: 3, type: 'assistant/message', data: { turn: 2, message: { id: 'a2', content: [{ type: 'text', text: 'ok' }] } } },
  { seq: 4, type: 'user/message', data: { id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: 'more' }] } },
  { seq: 5, type: 'assistant/message', data: { turn: 3, message: { id: 'a3', content: [{ type: 'text', text: 'done' }] } } },
]

describe('adapter/contract(适配器层契约)', () => {
  it('createAdapter 组装 reader+writer', () => {
    const a = createAdapter({ readEvents: async () => [] }, { writeReplace: async () => ({}) })
    expect(typeof a.reader.readEvents).toBe('function')
    expect(typeof a.writer.writeReplace).toBe('function')
  })

  it('NULL_ADAPTER 可独立运行(业务层无平台时)', async () => {
    expect(await NULL_ADAPTER.reader.readEvents('x')).toBeNull()
    expect(await NULL_ADAPTER.writer.writeReplace('x', { start: 0, end: 1, shadowedSeqs: [0, 1] })).toBeNull()
  })
})

describe('adapter/dsh computeSpan(业务逻辑,与平台无关)', () => {
  it('round 模式:遮蔽目标轮(该 user + 它的回复)', () => {
    const span = computeSpan(events, 2) // 编辑 u2(轮2)
    expect(span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
  })

  it('round 模式:编辑最后一条只遮蔽自己所在轮', () => {
    const span = computeSpan(events, 4) // 编辑 u3(轮3)
    expect(span).toEqual({ start: 4, end: 5, shadowedSeqs: [4, 5] })
  })

  it('tail 模式:遮蔽目标之后所有(重新开始)', () => {
    const span = computeSpan(events, 2, 'tail')
    expect(span.shadowedSeqs).toEqual([2, 3, 4, 5])
  })

  it('支持 messageId 查找', () => {
    const span = computeSpan(events, 'u2')
    expect(span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
  })

  it('目标不存在 → null', () => {
    expect(computeSpan(events, 99)).toBeNull()
    expect(computeSpan(events, 'nope')).toBeNull()
    expect(computeSpan(null, 2)).toBeNull()
  })

  it('isRoundBoundary:只认真实 user 输入,排除注入', () => {
    expect(isRoundBoundary({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(true)
    expect(isRoundBoundary({ type: 'user/message', data: { source: { kind: 'context' } } })).toBe(false)
    expect(isRoundBoundary({ type: 'assistant/message' })).toBe(false)
  })
})

describe('adapter/dsh dshAdapter(DSH 平台适配器)', () => {
  it('暴露 reader 接口(EventReader 契约)', () => {
    expect(typeof dshAdapter.reader.readEvents).toBe('function')
    expect(typeof dshAdapter.spanFromFile).toBe('function')
  })
})
