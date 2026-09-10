/**
 * 契约运行时化测试(issue-229 第 3 项,复核:"契约仅 JSDoc 声明 → 跨层契约错误
 * 以奇怪方式炸")。
 *
 * 声称 = 有校验:本套件把 lib/adapter/contract.js 的每条运行时断言都钉住——
 *  - 违规必须**抛**(不是静默通过、不是莫名崩溃);
 *  - 错误信息必须说清「哪个契约 / 期望什么 / 实际什么」;
 *  - 端到端:业务层传入坏 span / 适配器返回坏 marker → 立刻 contract-violation。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  CONTRACT_VIOLATION, contractViolation, assertContract, assertSpanShape, assertSpanResult,
  assertSpanFacts, assertEventListShape, assertMarkerShape, assertAdapterShape, createAdapter, NULL_ADAPTER,
} from '../lib/adapter/contract.js'
import { createDshMarkerWriter } from '../lib/adapter/dsh-writer.js'
import { createEditorApi } from '../lib/host-core.js'
import { makeSession, makeAgent, makeApi, userMessage, assistantMessage, headerEvent } from './helpers.js'

const span = (start = 0, end = 2) => ({ start, end, shadowedSeqs: [start, start + 1, end].filter((v, i, a) => a.indexOf(v) === i && v <= end) })

describe('契约违规错误形状(哪个契约 / 期望什么 / 实际什么)', () => {
  it('contractViolation:message 带契约名+期望+实际,error 上挂 contract/expected/actual', () => {
    const error = contractViolation('Span.shape', 'start 为非负整数', -1)
    expect(error.message).toBe('契约违规[Span.shape]:期望 start 为非负整数;实际 -1')
    expect(error.code).toBe(CONTRACT_VIOLATION)
    expect(error.contract).toBe('Span.shape')
    expect(error.expected).toBe('start 为非负整数')
    expect(error.actual).toBe(-1)
  })

  it('contractViolation:实际值渲染紧凑(对象/数组只给形状,不 dump 百万事件)', () => {
    expect(contractViolation('c', 'e', { a: 1, b: 2 }).message).toContain('{a,b}')
    expect(contractViolation('c', 'e', [1, 2, 3]).message).toContain('Array(3)')
    expect(contractViolation('c', 'e', undefined).message).toContain('undefined')
    expect(contractViolation('c', 'e', null).message).toContain('null')
    expect(contractViolation('c', 'e', () => {}).message).toContain('function')
  })

  it('assertContract:通过返回 true;不通过抛契约违规', () => {
    expect(assertContract(true, 'c', 'e', 1)).toBe(true)
    expect(() => assertContract(false, 'c', 'e', 1)).toThrow(/契约违规\[c\]/)
  })
})

describe('Span.shape(跨层 span 结构契约)', () => {
  it('合法 span 通过,并原样返回', () => {
    const s = { start: 0, end: 2, shadowedSeqs: [0, 1, 2] }
    expect(assertSpanShape(s)).toBe(s)
  })

  it('非对象/空段/首尾≠start,end/元素非法 → 明确报错', () => {
    expect(() => assertSpanShape(null)).toThrow(/Span\.shape.*期望 span 为对象/)
    expect(() => assertSpanShape({ start: 0, end: 2, shadowedSeqs: [] })).toThrow(/shadowedSeqs 为非空数组/)
    expect(() => assertSpanShape({ start: 0, end: 2, shadowedSeqs: [0, 9] })).toThrow(/shadowedSeqs 首尾 === span\.start\/end/)
    expect(() => assertSpanShape({ start: -1, end: 0, shadowedSeqs: [-1, 0] })).toThrow(/span\.start 为非负安全整数/)
    expect(() => assertSpanShape({ start: 0, end: -1, shadowedSeqs: [0, -1] })).toThrow(/span\.end 为非负安全整数/)
    expect(() => assertSpanShape({ start: 0, end: 1, shadowedSeqs: [0, 'x'] })).toThrow(/元素全为非负安全整数/)
  })

  it('**不断言 start <= end**:位置序 span 的 seq 数值可非单调(marker 插入 → 合法)', () => {
    // 官方 replacementRange 只按 indexOf(start) <= indexOf(end) 的**位置**判定;
    // 真实会话实测:位置连续段 [7000011 … 7000009](start 数值 > end)是正常写入。
    const positional = { start: 7000011, end: 7000009, shadowedSeqs: [7000011, 7000010, 7000009] }
    expect(assertSpanShape(positional)).toBe(positional)
    expect(() => assertMarkerShape({
      seq: 9,
      type: 'assistant/message',
      surfaceOp: { op: 'replace', start: 7000011, end: 7000009 },
      sourceEventSeqs: [7000011, 7000010, 7000009],
      data: { editor: { targetSeq: 7000011, text: '' } },
    })).not.toThrow()
  })

  it('契约名可定制(报错指认调用点)', () => {
    expect(() => assertSpanShape(null, 'host-core.writeMarker.span')).toThrow(/契约违规\[host-core\.writeMarker\.span\]/)
  })
})

describe('SpanResult.shape / SpanFacts.shape(显式状态结果契约)', () => {
  it('ok + 合法 span 通过;ok 缺 span → 报错', () => {
    const ok = { status: 'ok', span: { start: 0, end: 1, shadowedSeqs: [0, 1] }, facts: { fileMaxSeq: 1, targetSeq: 0 } }
    expect(assertSpanResult(ok)).toBe(ok)
    expect(() => assertSpanResult({ status: 'ok', span: null })).toThrow(/SpanResult\.shape\.span/)
  })

  it('非 ok 状态带 span → 报错(状态显式,不允许自相矛盾)', () => {
    expect(() => assertSpanResult({ status: 'not-found', span: { start: 0, end: 1, shadowedSeqs: [0, 1] } }))
      .toThrow(/status ≠ ok 时 span 必须为空/)
  })

  it('非法 status → 报错并列全合法取值', () => {
    expect(() => assertSpanResult({ status: 'pending', span: null }))
      .toThrow(/status ∈ SPAN_STATUS\(ok\|not-found\|already-shadowed\|not-persisted\|replay-failed\)/)
  })

  it('facts 必须是安全整数(-1 = 未知)', () => {
    expect(() => assertSpanFacts({ fileMaxSeq: 'x', targetSeq: 0 })).toThrow(/fileMaxSeq 为安全整数/)
    expect(() => assertSpanFacts({ fileMaxSeq: 0, targetSeq: null })).toThrow(/targetSeq 为安全整数/)
    expect(assertSpanFacts({ fileMaxSeq: -1, targetSeq: -1 })).toEqual({ fileMaxSeq: -1, targetSeq: -1 })
  })
})

describe('EventReader.events(事件列表契约,抽样校验)', () => {
  it('合法(含无 seq 的 header 帧)通过;非数组报错', () => {
    const events = [{ type: 'session', version: 0 }, { seq: 1, type: 'user/message' }, { seq: 2, type: 'assistant/message' }]
    expect(assertEventListShape(events)).toBe(events)
    expect(() => assertEventListShape({ events: [] })).toThrow(/事件列表为数组/)
    expect(assertEventListShape([])).toEqual([])
  })

  it('undefined 洞(记录包装漂移)→ 抽样命中并明确报错', () => {
    const events = [{ seq: 0, type: 'user/message' }, undefined, { seq: 2, type: 'assistant/message' }]
    expect(() => assertEventListShape(events)).toThrow(/events\[1\] 为非 null 对象/)
  })

  it('seq 非数字 / type 非字符串 → 报错(抽样到才报,不 O(n) 全量)', () => {
    expect(() => assertEventListShape([{ seq: '1', type: 'user/message' }])).toThrow(/seq 为安全整数/)
    expect(() => assertEventListShape([{ seq: 1, type: 42 }])).toThrow(/type 为字符串/)
  })
})

describe('ReplaceWriter.marker(写入端 marker 契约)', () => {
  const good = {
    seq: 5,
    type: 'assistant/message',
    surfaceOp: { op: 'replace', start: 0, end: 1 },
    sourceEventSeqs: [0, 1],
    data: { editor: { targetSeq: 0, text: 'hi' } },
  }

  it('合法 marker 通过(真实 writer 产出形状)', () => {
    expect(assertMarkerShape(good)).toBe(good)
  })

  it('缺 surfaceOp / 非 assistant-message / sourceEventSeqs 与 surfaceOp 不一致 → 报错', () => {
    expect(() => assertMarkerShape({ ...good, surfaceOp: undefined })).toThrow(/marker\.surfaceOp = \{op:'replace',start,end\}/)
    expect(() => assertMarkerShape({ ...good, type: 'user/message' })).toThrow(/marker\.type === 'assistant\/message'/)
    expect(() => assertMarkerShape({ ...good, sourceEventSeqs: [0, 1, 2] })).toThrow(/sourceEventSeqs 首尾 === surfaceOp\.start\/end/)
    expect(() => assertMarkerShape({ ...good, seq: -1 })).toThrow(/marker\.seq 为非负安全整数/)
    expect(() => assertMarkerShape({ ...good, data: {} })).toThrow(/marker\.data\.editor\.targetSeq/)
  })
})

describe('Adapter.shape(适配器组装契约)', () => {
  it('缺 reader.readEvents / writer.writeReplace → 组装即报错(不再运行到一半才炸)', () => {
    expect(() => createAdapter({}, { writeReplace: async () => null })).toThrow(/adapter\.reader\.readEvents 为函数/)
    expect(() => createAdapter({ readEvents: async () => null }, {})).toThrow(/adapter\.writer\.writeReplace 为函数/)
    expect(() => assertAdapterShape(null)).toThrow(/适配器为对象 \{reader, writer\}/)
    expect(createAdapter({ readEvents: async () => null }, { writeReplace: async () => null }).reader.readEvents).toBeTypeOf('function')
    expect(NULL_ADAPTER.writer.writeReplace).toBeTypeOf('function')
  })
})

describe('端到端:跨层契约违规 → 立刻明确报错(不静默、不奇怪地炸)', () => {
  it('业务层传入坏 span → dsh-writer 边界抛 contract-violation(带契约名)', async () => {
    const writer = createDshMarkerWriter({ agents: { get: () => null } })
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    // 首尾与 start/end 不一致(位置连续段被破坏)
    await expect(writer.writeMarker(session, { start: 0, end: 5, shadowedSeqs: [0, 1, 9] }, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toThrow(/契约违规\[dshAdapter\.writeMarker\.span\].*shadowedSeqs 首尾/)
    // start 非整数
    await expect(writer.writeMarker(session, { start: '0', end: 1, shadowedSeqs: [0, 1] }, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toThrow(/span\.start 为非负安全整数/)
    // 空 span 同样拦下(写出去就是"遮蔽零条"的诡异 marker)
    await expect(writer.writeMarker(session, { start: 0, end: 0, shadowedSeqs: [] }, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toThrow(/shadowedSeqs 为非空数组/)
    // 注意:**start 数值 > end 数值不是违规**(位置序;官方只判 indexOf(start) <= indexOf(end))
    const positional = await writer.writeMarker(session, { start: 4, end: 1, shadowedSeqs: [4, 3, 1] }, { op: 'recall', targetSeq: 1, originalText: '' })
    expect(positional.surfaceOp).toEqual({ op: 'replace', start: 4, end: 1 })
  })

  it('适配器返回坏 marker → host-core 边界抛 contract-violation(经 op 信封成 code)', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const agent = makeAgent()
    const sessions = { get: () => session, flush: async () => {} }
    const agents = { get: () => agent }
    // 坏写入器:返回的 marker 缺 surfaceOp(形状不合契约)
    const api = createEditorApi({}, sessions, agents, () => {}, { writeMarker: async () => ({ seq: 9, type: 'assistant/message' }) })
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe(CONTRACT_VIOLATION)
    expect(result.error.message).toMatch(/契约违规\[host-core\.writeMarker\.marker\]/)
  })

  it('正常路径不受断言影响(真 writer + 真 api 全绿)', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(true)
    const marker = session.events.find((e) => e?.surfaceOp?.op === 'replace')
    expect(() => assertMarkerShape(marker)).not.toThrow()
  })

  it('断言不改变调用方可见行为:坏 span 只在写前拦住,会话未被改坏', async () => {
    const session = makeSession().seed(headerEvent(), userMessage('u1', 'hi'), assistantMessage('a1', 'yo'))
    const before = session.events.length
    const writer = createDshMarkerWriter({ agents: { get: () => null } })
    await expect(writer.writeMarker(session, null, { op: 'recall', targetSeq: 0, originalText: '' }))
      .rejects.toMatchObject({ code: CONTRACT_VIOLATION })
    expect(session.events.length).toBe(before) // 没有半写状态
  })
})
