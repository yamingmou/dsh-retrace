/**
 * dsh-retrace · test/boundary-now.test.js
 *
 * READ-SIDE 「现在这条」 (lib/boundary-now.js). User feedback 2026-09-15: an entry
 * said WHAT it replaced but never WHERE it was replaced from, so the reader could
 * not tell what the entry IS. The anchor is the message the action left behind —
 * our own `retrace-resend-*` node for an edit, the host's new assistant reply for
 * a regenerate.
 *
 * Fixtures are the MEASURED shapes of a 27k-event session (boundary #8699 →
 * resend #8706; the two carry the same text).
 */
import { describe, it, expect } from 'vitest'
import { buildNowIndex, nowOfBoundary, shadowedSeqsOf } from '../lib/boundary-now.js'
import { EXCERPT_MAX } from '../lib/boundary-what.js'

const T0 = 1_700_000_000_000

const userMessage = (seq, text, id = `u-${seq}`) => ({
  seq, type: 'user/message', time: T0 + seq, surfaceOp: 'append',
  data: { id, role: 'user', content: [{ type: 'text', text }] },
})

const assistantMessage = (seq, text, id = `a-${seq}`) => ({
  seq, type: 'assistant/message', time: T0 + seq, surfaceOp: 'append',
  data: { turn: 1, step: 0, message: { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } } },
})

/** Our resend node (measured id prefix). */
const resend = (seq, text) => userMessage(seq, text, `retrace-resend-abc123-${seq}`)

/** Our marker / carrier (a replacement; `sourceEventSeqs` cites the shadowed set). */
const carrier = (seq, { op = 'edit', start = 0, end = 0, cited = null } = {}) => ({
  seq, type: 'user/message', time: T0 + seq, surfaceOp: { op: 'replace', start, end },
  sourceEventSeqs: cited ?? [seq - 1, ...Array.from({ length: end - start + 1 }, (_, i) => start + i)],
  data: { role: 'user', id: `retrace-${op}-abc123`, content: [{ type: 'text', text: '（此处内容已被撤回）' }], source: { kind: 'model', provider: 'p', model: 'm' } },
})

const idOf = (event) => event?.data?.id ?? event?.data?.message?.id ?? ''

describe('boundary-now — 「现在这条」是从日志读出来的，不是猜出来的', () => {
  it('编辑档：对应物 = 之后那个未被遮蔽的 retrace-resend 节点（真机 #8699 → #8706）', () => {
    const events = [
      userMessage(8692, '我和外部AI的思路一致'),
      assistantMessage(8693, '第一答'),
      carrier(8699, { op: 'edit', start: 8692, end: 8693, cited: [8698, 8692, 8693] }),
      { seq: 8700, type: 'turn/end', time: T0 + 8700, data: { turn: 160 } },
      resend(8706, '我和外部AI的思路一致'),
      assistantMessage(8707, '新的第一答'),
    ]
    const index = buildNowIndex(events, shadowedSeqsOf(events))
    const now = nowOfBoundary('edit', 8699, index)
    expect(now).toMatchObject({ seq: 8706, role: 'user' })
    expect(now.excerpt).toContain('我和外部AI的思路一致')
    // 载体自己（#8699）绝不是"现在这条"
    expect(now.seq).not.toBe(8699)
  })

  it('重新生成档：对应物 = 之后那条新的助手回复（跳过我们自己的 marker）', () => {
    const events = [
      assistantMessage(100, '旧的回复'),
      assistantMessage(101, '（此处内容已被重新生成）', 'retrace-regenerate-abc123'),
      assistantMessage(102, '新的回复'),
      userMessage(103, '后续输入'),
    ]
    const now = nowOfBoundary('regenerate', 101, buildNowIndex(events, new Set()))
    expect(now).toMatchObject({ seq: 102, role: 'assistant' })
    expect(now.excerpt).toBe('新的回复')
  })

  it('纯撤回没有对应物：后面的输入是另一件事，不当成"现在这条"', () => {
    const events = [
      userMessage(10, '要撤回的内容'),
      carrier(11, { op: 'recall', start: 10, end: 10 }),
      resend(14, '后面随便发的一句'),
    ]
    expect(nowOfBoundary('recall', 11, buildNowIndex(events, shadowedSeqsOf(events)))).toBeNull()
    // 压缩档同理（压缩行的读法只有归属说明 + 跳转）
    expect(nowOfBoundary('compaction', 12, buildNowIndex(events, new Set()))).toBeNull()
    // 未知 kind 不乱猜
    expect(nowOfBoundary('replace', 13, buildNowIndex(events, new Set()))).toBeNull()
  })

  it('被本插件后来的改动替换掉的 resend 不能再当"现在这条"（往后找）', () => {
    const events = [
      carrier(20, { op: 'edit', start: 10, end: 10 }),
      resend(25, '第一次重发的文本'),
      carrier(30, { op: 'edit', start: 25, end: 25 }),
      resend(35, '第二次重发的文本'),
    ]
    const index = buildNowIndex(events, shadowedSeqsOf(events))
    expect(nowOfBoundary('edit', 20, index)?.seq).toBe(35)
    expect(nowOfBoundary('edit', 30, index)?.seq).toBe(35)
  })

  it('遮蔽范围只算我们自己的替换：普通引用与其他插件的批量替换都不算', () => {
    const events = [
      userMessage(1, '一'),
      // 普通事件也会引用自己的来源（tool/result → tool/call）：不算遮蔽
      { seq: 2, type: 'tool/result', time: T0 + 2, surfaceOp: 'append', sourceEventSeqs: [1], data: { id: 'tool-x' } },
      // 别的插件的折叠：一次替换上千条 —— 不算"我们的遮蔽"
      { seq: 3, type: 'user/message', time: T0 + 3, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 }, sourceEventSeqs: [0, 1, 2], data: { id: 'fix-line-fold-v0-1' } },
      // 官方压缩 checkpoint：同理（上下文压缩 ≠ 对话里没有这条了）
      { seq: 4, type: 'user/message', time: T0 + 4, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 3 }, sourceEventSeqs: [0, 1, 2, 3], data: { id: 'compact-4', source: { kind: 'plugin', plugin: 'compact' } } },
      // 我们自己的替换：算
      { seq: 5, type: 'user/message', time: T0 + 5, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [5 - 1, 1, 2], data: { id: 'retrace-edit-abc123' } },
    ]
    const shadowed = shadowedSeqsOf(events)
    expect([...shadowed].sort((a, b) => a - b)).toEqual([1, 2])
    expect(shadowed.has(0)).toBe(false)
  })

  it('摘要里的摘录与角色按同一条规则截断（≤60 字，role 用 roleOf）', () => {
    const long = '很长的原文'.repeat(40)
    const events = [carrier(5, { op: 'edit', start: 0, end: 0 }), resend(9, long)]
    const now = nowOfBoundary('edit', 5, buildNowIndex(events, null))
    expect(now.excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX + 1)
    expect(now.excerpt.endsWith('…')).toBe(true)
    expect(now.role).toBe('user')
  })

  it('降级如实：空日志 / 坏输入不抛，只是没有对应物', () => {
    expect(buildNowIndex(null, null)).toEqual({ resends: [], replies: [] })
    expect(buildNowIndex([{ type: 'user/message', data: {} }], new Set())).toEqual({ resends: [], replies: [] })
    expect(nowOfBoundary('edit', 5, null)).toBeNull()
    expect(nowOfBoundary('edit', Number.NaN, { resends: [], replies: [] })).toBeNull()
    expect(shadowedSeqsOf(null).size).toBe(0)
    // 没有 seq 的事件不入索引（不产生 NaN 行）
    expect(buildNowIndex([{ type: 'assistant/message', data: { id: 'a' } }], new Set()).replies).toEqual([])
    expect(idOf({ data: {} })).toBe('')
  })
})
