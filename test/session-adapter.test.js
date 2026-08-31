/**
 * Session adapter unit tests (2026-09-01).
 *
 * DSH 会话 → 业务输入(messages + shadows)的翻译层:
 * 日志客观记录,适配器翻译,业务层投影——三层分离。
 */
import { describe, it, expect } from 'vitest'
import { extractMessages, extractShadows, extractText, projectSession } from '../lib/session-adapter.js'

function makeSessionWith(events) {
  return {
    events: events.map((e, i) => ({ seq: i, ...e })),
    surface: { nodes: [] },
  }
}

describe('extractText', () => {
  it('提取 text 块,拼接', () => {
    expect(extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('ab')
    expect(extractText([{ type: 'tool-result', content: 'x' }])).toBe('')
    expect(extractText(null)).toBe('')
  })
})

describe('extractMessages(全量消息,业务形态)', () => {
  it('提取 user/assistant 消息,跳过 retrace marker', () => {
    const session = makeSessionWith([
      { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'yo' }] } } },
      // retrace 编辑 marker(带 editor、空内容)→ 跳过
      { type: 'assistant/message', data: { turn: 2, editor: { targetSeq: 0 }, message: { content: [] } } },
      { type: 'user/message', data: { turn: 2, content: [{ type: 'text', text: 'more' }] } },
      { type: 'assistant/chunk', data: { turn: 2, text: 'chunk' } }, // 非消息,跳过
    ])
    const msgs = extractMessages(session)
    expect(msgs).toEqual([
      { seq: 0, role: 'user', turn: 1, text: 'hi' },
      { seq: 1, role: 'assistant', turn: 1, text: 'yo' },
      { seq: 3, role: 'user', turn: 2, text: 'more' },
    ])
  })

  it('空会话 → 空数组', () => {
    expect(extractMessages(makeSessionWith([]))).toEqual([])
    expect(extractMessages(null)).toEqual([])
  })
})

describe('extractShadows(遮蔽,时间序)', () => {
  it('提取 retrace marker 的 sourceEventSeqs 原样(精确 seq 集合)', () => {
    const session = makeSessionWith([
      { type: 'user/message', data: { content: [] } },
      { type: 'assistant/message', data: { message: { content: [] } } },
      { type: 'assistant/message', data: { editor: { targetSeq: 0 }, message: { content: [] } }, sourceEventSeqs: [0, 1] },
      { type: 'user/message', data: { content: [] } },
    ])
    const shadows = extractShadows(session)
    expect(shadows).toEqual([{ seqs: [0, 1], markerSeq: 2 }])
  })

  it('稀疏 sourceEventSeqs 原样保留(不展开成区间,不误伤中间)', () => {
    const session = makeSessionWith([
      { type: 'assistant/message', data: { editor: { targetSeq: 0 }, message: { content: [] } }, sourceEventSeqs: [5, 9, 20] },
    ])
    const shadows = extractShadows(session)
    expect(shadows).toEqual([{ seqs: [5, 9, 20], markerSeq: 0 }])
  })

  it('非 marker / 空 sourceEventSeqs → 忽略', () => {
    const session = makeSessionWith([
      { type: 'assistant/message', data: { message: { content: [] } } },
      { type: 'assistant/message', data: { editor: { targetSeq: 0 } } }, // 无 sourceEventSeqs
    ])
    expect(extractShadows(session)).toEqual([])
  })
})

describe('projectSession(翻译 + 投影一步到位)', () => {
  it('完整链路:消息 + marker → 投影 active/shadowed', () => {
    const session = makeSessionWith([
      { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: 'hi' }] } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: 'yo' }] } } },
      // 撤回第 0-1 条(轮1)
      { type: 'assistant/message', data: { turn: 2, editor: { targetSeq: 0 }, message: { content: [] } }, sourceEventSeqs: [0, 1] },
      { type: 'user/message', data: { turn: 2, content: [{ type: 'text', text: 'more' }] } },
      { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: 'ok' }] } } },
    ])
    const r = projectSession(session)
    expect(r.messages.length).toBe(4) // 3 消息 + 1 marker 被跳
    expect(r.shadows).toEqual([{ seqs: [0, 1], markerSeq: 2 }])
    expect(r.projection.filter((m) => m.status === 'shadowed').map((m) => m.seq)).toEqual([0, 1])
    expect(r.active.map((m) => m.seq)).toEqual([3, 4])
    expect(r.turnCount).toBe(1) // 只有轮2活跃
  })
})
