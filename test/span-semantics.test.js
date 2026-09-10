/**
 * span-semantics 单元 + **跨层一致性**(issue-229 第 2 项,复核)。
 *
 * 审计原话:"业务层 shadowSpanOf(host-core,直接 slice 到结尾)与适配层 computeSpan
 * (起点回退到轮首)语义不一致 → 预览与写入迟早对不上"。
 *
 * 本套件把「同一输入 → 业务层与适配层结果一致」变成**可执行断言**:
 *  - 业务层预览 = lib/message-list.js shadowSpanOf(投影后的活跃消息);
 *  - 适配层写入侧 = lib/adapter/dsh.js computeSpan(文件全量 + 官方 foldSurface nodes);
 *  - 宿主业务层实际落盘 = host-core 写入的 marker.surfaceOp/sourceEventSeqs。
 * 三条必须逐字相等(tail/round 两模式、多种目标)。
 */
import { describe, it, expect } from 'vitest'
import {
  SPAN_STATUS, SPAN_MODE, spanAt, spanForSeq, spanSliceOf, roundStartIndex, roundEndIndex,
  spanOk, spanMiss, spanMissArgsOf, describeSpanResult, isSpanStatus, isRoundBoundaryEvent,
} from '../lib/span-semantics.js'
import { shadowSpanOf } from '../lib/message-list.js'
import { computeSpan } from '../lib/adapter/dsh.js'
import { makeSession, makeAgent, makeApi } from './helpers.js'

/** 通用事件(带 surfaceOp,官方 foldSurface 需要)——与 test/adapter.test.js 同风格。 */
function conv() {
  return [
    { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
    { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'yo' }] } } },
    { seq: 2, type: 'user/message', surfaceOp: 'append', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'again' }] } },
    { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { id: 'a2', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'ok' }] } } },
    { seq: 4, type: 'user/message', surfaceOp: 'append', data: { id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: 'more' }] } },
    { seq: 5, type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, message: { id: 'a3', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: 'done' }] } } },
  ]
}

/** 业务层消息形态(role 维度;与适配层的事件形态同源同序)。 */
function messagesOf(events) {
  return events.map((e) => ({ seq: e.seq, role: e.type === 'user/message' ? 'user' : 'assistant' }))
}

describe('span-semantics · 规则原语(单一实现)', () => {
  const nodes = [10, 11, 12, 13, 14, 15] // 位置序(可非 seq 单调)
  const isBoundary = (seq) => seq === 10 || seq === 12 || seq === 14

  it('roundStartIndex:向前找最近轮边界;找不到则停在目标自身位置(不越界到 0)', () => {
    expect(roundStartIndex(nodes, 3, isBoundary)).toBe(2) // 位置 3(13)→ 位置 2(12,边界)
    expect(roundStartIndex(nodes, 2, isBoundary)).toBe(2) // 自身即边界
    expect(roundStartIndex(nodes, 0, () => false)).toBe(0) // 无边界 → 自身
  })

  it('roundEndIndex:下一个轮边界前一位;无则到末尾', () => {
    expect(roundEndIndex(nodes, 2, isBoundary)).toBe(3) // 12 起 → 13(下一个边界 14 前)
    expect(roundEndIndex(nodes, 4, isBoundary)).toBe(5) // 14 起 → 末尾
  })

  it('spanSliceOf:位置段 → {start,end,shadowedSeqs};空段 → null', () => {
    expect(spanSliceOf(nodes, 1, 3)).toEqual({ start: 11, end: 13, shadowedSeqs: [11, 12, 13] })
    expect(spanSliceOf(nodes, 2, 1)).toBeNull()
  })

  it('spanAt:round = 目标轮;tail = 目标轮首到末尾(两模式共用轮首回退)', () => {
    const round = spanAt(nodes, 3, { mode: SPAN_MODE.ROUND, isBoundary })
    expect(round).toEqual({ start: 12, end: 13, shadowedSeqs: [12, 13] })
    const tail = spanAt(nodes, 3, { mode: SPAN_MODE.TAIL, isBoundary })
    expect(tail).toEqual({ start: 12, end: 15, shadowedSeqs: [12, 13, 14, 15] })
    // 目标是轮内非边界节点(11,属于轮 10):round 只遮该轮,tail 遮到末尾
    expect(spanAt(nodes, 1, { mode: SPAN_MODE.ROUND, isBoundary }).shadowedSeqs).toEqual([10, 11])
    expect(spanAt(nodes, 1, { mode: SPAN_MODE.TAIL, isBoundary }).shadowedSeqs).toEqual([10, 11, 12, 13, 14, 15])
  })

  it('spanAt:位置非法/节点序列非法 → null(调用方按 not-found 处理)', () => {
    expect(spanAt(nodes, -1, { isBoundary })).toBeNull()
    expect(spanAt(nodes, 99, { isBoundary })).toBeNull()
    expect(spanAt(null, 0, { isBoundary })).toBeNull()
    expect(spanAt([], 0, { isBoundary })).toBeNull()
  })

  it('spanForSeq:目标不在位置序 → null;在 → 按模式给段', () => {
    expect(spanForSeq(nodes, 99, { mode: SPAN_MODE.TAIL, isBoundary })).toBeNull()
    expect(spanForSeq(nodes, 13, { mode: SPAN_MODE.TAIL, isBoundary }).shadowedSeqs).toEqual([12, 13, 14, 15])
  })

  it('isRoundBoundaryEvent:只认真实 user 输入(排除 context/steering 注入)', () => {
    expect(isRoundBoundaryEvent({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(true)
    expect(isRoundBoundaryEvent({ type: 'user/message', data: { source: { kind: 'context' } } })).toBe(false)
    expect(isRoundBoundaryEvent({ type: 'user/message' })).toBe(false)
    expect(isRoundBoundaryEvent({ type: 'assistant/message' })).toBe(false)
    expect(isRoundBoundaryEvent(null)).toBe(false)
  })

  it('状态结果构造/判定助手:spanOk / spanMiss / isSpanStatus / describeSpanResult', () => {
    const span = { start: 1, end: 2, shadowedSeqs: [1, 2] }
    expect(spanOk(span, { fileMaxSeq: 2, targetSeq: 1 })).toEqual({ status: SPAN_STATUS.OK, span, facts: { fileMaxSeq: 2, targetSeq: 1 } })
    expect(spanMiss(SPAN_STATUS.NOT_FOUND, { fileMaxSeq: 2, targetSeq: 9 })).toEqual({ status: 'not-found', span: null, facts: { fileMaxSeq: 2, targetSeq: 9 } })
    expect(isSpanStatus('ok')).toBe(true)
    expect(isSpanStatus('whatever')).toBe(false)
    expect(describeSpanResult(spanOk(span, { fileMaxSeq: 2, targetSeq: 1 }))).toBe('ok:2 seqs(targetSeq=1,fileMaxSeq=2)')
    expect(describeSpanResult(spanMiss(SPAN_STATUS.ALREADY_SHADOWED, { fileMaxSeq: 2, targetSeq: 1 }))).toBe('already-shadowed(targetSeq=1,fileMaxSeq=2)')
    expect(describeSpanResult(null)).toBe('no-result')
  })

  it('spanMissArgsOf:仅当文件侧有快照证据时下传状态(无证据 → null,业务层落内存判)', () => {
    expect(spanMissArgsOf(spanOk({ start: 1, end: 1, shadowedSeqs: [1] }, {}))).toBeNull()
    expect(spanMissArgsOf(spanMiss(SPAN_STATUS.NOT_PERSISTED, { fileMaxSeq: 5, targetSeq: 9 })))
      .toEqual({ spanStatus: 'not-persisted', spanFacts: { fileMaxSeq: 5, targetSeq: 9 } })
    expect(spanMissArgsOf(spanMiss(SPAN_STATUS.NOT_FOUND, { fileMaxSeq: -1, targetSeq: 2 }))).toBeNull()
    expect(spanMissArgsOf(undefined)).toBeNull()
  })
})

describe('业务层与适配层同一实现(审计第 2 项:同一输入 → 同一 span)', () => {
  const TARGETS = [0, 1, 2, 3, 4, 5]

  it('round 模式:business（message-list 投影）与 adapter（文件 foldSurface）逐字一致', () => {
    const events = conv()
    const messages = messagesOf(events)
    for (const target of TARGETS) {
      const business = shadowSpanOf(messages, [], target, { mode: 'round' })
      const adapter = computeSpan(events, target, 'round')
      expect(adapter.status).toBe(SPAN_STATUS.OK)
      expect(business).toEqual(adapter.span)
    }
  })

  it('tail 模式:两模式语义统一后逐字一致(旧业务层"从目标自身切到尾"已废弃)', () => {
    const events = conv()
    const messages = messagesOf(events)
    for (const target of TARGETS) {
      const business = shadowSpanOf(messages, [], target, { mode: 'tail' })
      const adapter = computeSpan(events, target, 'tail')
      expect(adapter.status).toBe(SPAN_STATUS.OK)
      expect(business).toEqual(adapter.span)
    }
  })

  it('tail 回退轮首(审计指出的分叉点):目标是轮内 assistant → 起点=该轮 user', () => {
    const events = conv()
    const messages = messagesOf(events)
    // 目标 a1(seq 1,轮1 的回复),旧业务层会从 seq 1 切到尾 [1,2,3,4,5]
    expect(shadowSpanOf(messages, [], 1, { mode: 'tail' }).shadowedSeqs).toEqual([0, 1, 2, 3, 4, 5])
    expect(computeSpan(events, 1, 'tail').span.shadowedSeqs).toEqual([0, 1, 2, 3, 4, 5])
    // 目标 a2(seq 3,轮2 的回复)→ 起点回退到轮2 user(seq 2)
    expect(shadowSpanOf(messages, [], 3, { mode: 'tail' }).shadowedSeqs).toEqual([2, 3, 4, 5])
    expect(computeSpan(events, 3, 'tail').span.shadowedSeqs).toEqual([2, 3, 4, 5])
  })
})

/** 写入侧 marker(三情形翻译会追加 step/turn 包裹事件 → 按 surfaceOp 找,不靠"最后一个")。 */
function markerOf(session) {
  return session.events.find((e) => e?.surfaceOp?.op === 'replace')
}

describe('预览 = 写入(端到端回归:业务层预览 / 适配层计算 / host-core 实际落盘三者相等)', () => {
  it('recall(无注入 span → 业务层内存计算):写入的 marker span 与两条预览一致', async () => {
    const fileEvents = conv() // 适配层读到的文件侧快照(写入前)
    const session = makeSession()
    for (const event of conv()) session.appendRaw({ ...event })
    const messages = messagesOf(session.events)
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'u2' }) // 撤回 u2(轮2)
    expect(result.ok).toBe(true)
    const marker = markerOf(session)
    const written = {
      start: marker.surfaceOp.start,
      end: marker.surfaceOp.end,
      shadowedSeqs: marker.sourceEventSeqs,
    }
    // ①业务层预览(message-list 投影,UI 侧"将遮蔽这些消息")
    const preview = shadowSpanOf(messages, [], 2, { mode: 'tail' })
    // ②适配层计算(文件全量 + 官方 foldSurface)
    const adapter = computeSpan(fileEvents, 2, 'tail')
    expect(adapter.status).toBe(SPAN_STATUS.OK)
    // ③实际落盘
    expect(written).toEqual(preview)
    expect(written).toEqual(adapter.span)
    expect(result.value.shadowed).toBe(preview.shadowedSeqs.length)
  })

  it('editAndResend(round 模式)与 preview 一致;fromScratch(tail)一致', async () => {
    const build = () => {
      const session = makeSession()
      for (const event of conv()) session.appendRaw({ ...event })
      return session
    }
    const s1 = build()
    const api1 = makeApi(s1, makeAgent())
    expect((await api1.editAndResend({ sessionId: 's1', messageId: 'u1', text: 'x' })).ok).toBe(true)
    const marker1 = markerOf(s1)
    expect({ start: marker1.surfaceOp.start, end: marker1.surfaceOp.end, shadowedSeqs: marker1.sourceEventSeqs })
      .toEqual(shadowSpanOf(messagesOf(conv()), [], 0, { mode: 'round' }))

    const s2 = build()
    const api2 = makeApi(s2, makeAgent())
    expect((await api2.editAndResend({ sessionId: 's1', messageId: 'u3', text: 'z', fromScratch: true })).ok).toBe(true)
    const marker2 = markerOf(s2)
    // fromScratch = "重新开始"语义:从**第一个 user** 起 tail 到尾部(不是从目标自身)
    const preview2 = shadowSpanOf(messagesOf(conv()), [], 0, { mode: 'tail' })
    expect({ start: marker2.surfaceOp.start, end: marker2.surfaceOp.end, shadowedSeqs: marker2.sourceEventSeqs }).toEqual(preview2)
    expect(preview2.shadowedSeqs).toEqual([0, 1, 2, 3, 4, 5])
  })
})
