/**
 * dsh-retrace · test/boundary-derive.test.js
 *
 * READ-SIDE digest derivation (real-machine finding 2026-09-15). The boundary
 * artifact is written at OPERATION time and only exists for boundaries that
 * happened after the summary feature shipped; older boundaries rendered as one
 * bare line with no content at all. Their discarded originals are still in the
 * log, so the digest is recomputed on read.
 *
 * All fixtures here are real SHAPES (measured on a 27k-event session), not
 * invented ones: the carrier is `user/message` + `{op,start,end}` + a
 * `retrace-*` id; a host-side replacement is `tool/result` + `{op,startSeq,
 * endSeq}` + a plain UUID id.
 */
import { describe, it, expect } from 'vitest'
import { deriveBoundaryRecords, turnOfBoundary } from '../lib/boundary-derive.js'
import { REPLACED_MAX, EXCERPT_MAX } from '../lib/boundary-what.js'
import { MARKER_ID_PREFIX } from '../lib/version-index.js'

const T0 = 1_700_000_000_000

/** A user-message surface event (the replaced original). */
const userMessage = (seq, text) => ({
  seq,
  type: 'user/message',
  time: T0 + seq,
  surfaceOp: 'append',
  data: { id: `u-${seq}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } },
})

/** An assistant-message surface event. */
const assistantMessage = (seq, text) => ({
  seq,
  type: 'assistant/message',
  time: T0 + seq,
  surfaceOp: 'append',
  data: {
    turn: 0,
    step: 0,
    message: { id: `a-${seq}`, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
  },
})

/** Our carrier (two-segment shape; `data.id` carries the op). */
const carrier = (seq, { start, end, op = 'edit', cited = null } = {}) => ({
  seq,
  type: 'user/message',
  time: T0 + seq,
  surfaceOp: { op: 'replace', start, end },
  sourceEventSeqs: cited ?? [seq - 1, ...Array.from({ length: end - start + 1 }, (_, i) => start + i)],
  data: {
    role: 'user',
    id: `${MARKER_ID_PREFIX}-${op}-abc123`,
    // Measured: the carrier only ever carries the archive notice, never the new text.
    content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
    source: { kind: 'model', provider: 'p', model: 'm' },
  },
})

/** The paired audit event (measured: `compaction/prune`, cited FIRST by the carrier). */
const audit = (seq) => ({
  seq,
  type: 'compaction/prune',
  time: T0 + seq,
  data: { shadowedRange: { start: 0, end: 3 }, shadowedSeqs: [0, 1, 2, 3], shadowedTokenCount: 10 },
})

/** HOST-side replacement (measured shape): tool/result + plain UUID id. */
const hostReplace = (seq, target) => ({
  seq,
  type: 'tool/result',
  time: T0 + seq,
  surfaceOp: { op: 'replace', startSeq: target, endSeq: target },
  sourceEventSeqs: [target],
  data: { id: 'host-surface-replacement-1', turn: 0, step: 0, message: { role: 'tool', content: [{ type: 'text', text: 'tool out' }] } },
})

/** An official compaction checkpoint (user/message + plugin: compact source). */
const compaction = (seq, start, end) => ({
  seq,
  type: 'user/message',
  time: T0 + seq,
  surfaceOp: { op: 'replace', start, end },
  sourceEventSeqs: Array.from({ length: end - start + 1 }, (_, i) => start + i),
  data: { id: `compact-${seq}`, role: 'user', content: [{ type: 'text', text: '<compaction summary>' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'c1' } },
})

const eventAtOf = (events) => {
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  return (seq) => bySeq.get(seq)
}

describe('deriveBoundaryRecords — 无存储记录时从日志反推 digest', () => {
  // #4 是配套审计事件(compaction/prune,被载体 sourceEventSeqs 首位引用)——
  // 真实数据就是这个形状:审计 seq 不是被丢弃的消息,读端要把它排除。
  const events = [
    userMessage(0, '第一问：我和外部AI的思路一致'),
    assistantMessage(1, '第一答：好的'),
    userMessage(2, '中间被丢弃的一条'),
    assistantMessage(3, '中间被丢弃的回复'),
    audit(4),
    carrier(5, { start: 0, end: 3, op: 'edit', cited: [4, 0, 1, 2, 3] }),
  ]

  it('① 没有存储记录 ⇒ 从日志现算(标注 derived,内容与写侧同形)', () => {
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 5, versionId: 'v5' }], eventAt: eventAtOf(events) })
    expect(record).toMatchObject({
      boundarySeq: 5,
      versionId: 'v5',
      kind: 'edit',
      derived: true,
      discardedCount: 4,
    })
    expect(record.what.op).toBe('edit')
    expect(record.what.at).toBe(T0 + 5)
    // 审计 seq(#4)不是被丢弃的消息 ⇒ 不在 replaced 里(实测同形)。
    expect(record.what.replaced.map((entry) => entry.seq)).not.toContain(4)
    expect(record.what.replaced.map((entry) => entry.seq)).toEqual([0, 1, 2, 3].slice(0, REPLACED_MAX))
    expect(record.what.replaced[0]).toMatchObject({ seq: 0, role: 'user' })
    expect(record.what.replaced[0].excerpt).toContain('我和外部AI的思路一致')
    expect(record.what.replaced[1]).toMatchObject({ seq: 1, role: 'assistant' })
    // 4 removed, 3 listed ⇒ "还有 1 条"
    expect(record.what.replacedMore).toBe(4 - REPLACED_MAX)
  })

  it('摘录逐字截断到 ≤60 字(EXCERPT_MAX,超出加省略号)', () => {
    const long = '很长的原文'.repeat(40)
    const withLong = [userMessage(0, long), carrier(1, { start: 0, end: 0, op: 'recall' })]
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 1 }], eventAt: eventAtOf(withLong) })
    const excerpt = record.what.replaced[0].excerpt
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX + 1)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('discardedSeqs 精简到边界 seq,但 discardedCount 保持精确 |S|', () => {
    // 边界只有 #4;#2 是被丢弃的普通节点(不是边界)⇒ 不进精简集。
    const [record] = deriveBoundaryRecords({
      versions: [{ boundarySeq: 5 }],
      eventAt: eventAtOf(events),
      boundarySeqs: new Set([5]),
    })
    expect(record.discardedSeqs).toEqual([])
    expect(record.discardedCount).toBe(4)
    // 有子边界时只保留那个边界 seq(树的成员判定只需要它)。
    const nested = deriveBoundaryRecords({
      versions: [{ boundarySeq: 5 }],
      eventAt: eventAtOf(events),
      boundarySeqs: new Set([5, 2]),
    })[0]
    expect(nested.discardedSeqs).toEqual([2])
    expect(nested.discardedCount).toBe(4)
  })

  it('轮次：从被替换的那一段取 turn（载体自己往往没有 turn）', () => {
    // 真机实测：撤回/编辑/重发的载体事件没有 `data.turn`，被它替换掉的那一段才带
    // ⇒ 用户问"这是哪一轮"时，答案只能从被替换段里取。
    const span = { ...userMessage(0, '这一轮的输入'), data: { ...userMessage(0, '').data, turn: 159 } }
    const withTurn = [span, carrier(1, { start: 0, end: 0, op: 'edit', cited: [0] })]
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 1 }], eventAt: eventAtOf(withTurn) })
    expect(record.turn).toBe(159)
    // 载体自己也带 turn 时以载体为准（离这次改动最近的那一轮）
    const carrierWithTurn = {
      ...carrier(3, { start: 0, end: 0, op: 'edit', cited: [0] }),
      data: { ...carrier(3, { cited: [0] }).data, turn: 7 },
    }
    const [own] = deriveBoundaryRecords({
      versions: [{ boundarySeq: 3 }],
      eventAt: eventAtOf([span, carrierWithTurn]),
    })
    expect(own.turn).toBe(7)
  })

  it('轮次取不到就不编造：turn 缺/0/非整数都返回 null（行首整段省略）', () => {
    expect(turnOfBoundary({ data: {} }, [])).toBeNull()
    expect(turnOfBoundary({ data: { turn: 0 } }, [])).toBeNull()       // 真机 turn 从 1 起
    expect(turnOfBoundary({ data: { turn: -1 } }, [])).toBeNull()
    expect(turnOfBoundary({ data: { turn: 1.5 } }, [])).toBeNull()
    expect(turnOfBoundary({ data: { turn: '159' } }, [])).toBeNull()
    expect(turnOfBoundary({ data: { turn: 159 } }, [])).toBe(159)
    expect(turnOfBoundary({}, [{ data: { turn: 452 } }])).toBe(452)
    // 派生记录如实反映"取不到"（不写 0、不写占位）
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 5 }], eventAt: eventAtOf(events) })
    expect(record.turn).toBeNull()
  })

  it('② 不伪造「延续」原文(载体只留归档提示,新原文不在这个 seq 上)', () => {
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 5 }], eventAt: eventAtOf(events) })
    expect(record.what.new).toEqual({ excerpt: '' })
  })

  it('③ 宿主自身的 surface 替换被过滤(不是我们的读档点,不给 digest)', () => {
    const withHost = [...events, hostReplace(6, 2)]
    const records = deriveBoundaryRecords({
      versions: [{ boundarySeq: 5 }, { boundarySeq: 6 }],
      eventAt: eventAtOf(withHost),
    })
    expect(records.map((record) => record.boundarySeq)).toEqual([5])
  })

  it('官方 compaction checkpoint 仍然给出 digest(op=compaction)', () => {
    const withCompact = [userMessage(0, '被压缩的原文'), assistantMessage(1, '被压缩的回复'), compaction(2, 0, 1)]
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 2 }], eventAt: eventAtOf(withCompact) })
    expect(record.kind).toBe('compaction')
    expect(record.what.op).toBe('compaction')
    expect(record.discardedCount).toBe(2)
    expect(record.what.replaced[0].excerpt).toContain('被压缩的原文')
  })

  it('反序列载体(assistant/message + data.editor)照样认得出 op', () => {
    const legacy = [
      userMessage(0, '旧形态被丢弃的原文'),
      { seq: 1, type: 'assistant/message', time: T0 + 1, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0], data: { turn: null, step: null, message: { id: 'retrace-recall-legacy', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 0, text: '' } } },
    ]
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 1 }], eventAt: eventAtOf(legacy) })
    expect(record.kind).toBe('recall')
    expect(record.what.replaced[0].excerpt).toContain('旧形态被丢弃的原文')
  })

  it('原文已被压缩掉(事件不在日志里)⇒ 不编造内容,但行仍然存在', () => {
    // 只有载体,没有被丢弃的事件(模拟压缩后原文消失)。
    const gone = [audit(4), carrier(5, { start: 0, end: 3, op: 'edit', cited: [4, 0, 1, 2, 3] })]
    const [record] = deriveBoundaryRecords({ versions: [{ boundarySeq: 5 }], eventAt: eventAtOf(gone) })
    expect(record).toBeDefined()
    expect(record.discardedCount).toBe(4)
    expect(record.what.replaced.map((entry) => entry.excerpt)).toEqual(['', '', ''])
    expect(record.what.replaced.every((entry) => entry.role === 'unknown')).toBe(true)
    // 计数仍在 —— 行不会变成空白,只是没有逐字摘录可显示。
    expect(record.what.replacedMore).toBe(1)
  })

  it('边界事件本身不在日志里 ⇒ 跳过(不抛、不产出空记录)', () => {
    expect(deriveBoundaryRecords({ versions: [{ boundarySeq: 99 }], eventAt: eventAtOf(events) })).toEqual([])
  })

  it('非法输入降级:没有 eventAt / 非数组 versions ⇒ 空结果', () => {
    expect(deriveBoundaryRecords({ versions: [{ boundarySeq: 5 }] })).toEqual([])
    expect(deriveBoundaryRecords({ versions: null, eventAt: () => undefined })).toEqual([])
    expect(deriveBoundaryRecords()).toEqual([])
    expect(deriveBoundaryRecords({ versions: [{ boundarySeq: 'x' }], eventAt: () => ({}) })).toEqual([])
  })
})
