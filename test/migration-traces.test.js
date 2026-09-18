/**
 * lib/migration-traces.js + lib/marker-carrier.js(TRACE 区块)的单元测试。
 *
 * 钉死的东西:
 *  ① 承载**形状**:`feedback/record` + `data` 恰一个 `text` 成员(官方冻结词表
 *     `disposition(["text"])` 的精确形状;多一个成员官方 payload 校验器即拒);
 *  ② **保痕迹**:原类型 / 原 seq / 原 time / 原 data 逐成员不丢(空值 `turn:null`/
 *     `step:null` 显式清洗并留 `droppedNullKeys` 记录);
 *  ③ **位置轴不动**:行数、seq、time 一律不变(只改 type 与 data);
 *  ④ **幂等**:对产物再跑一次 ⇒ `changed === 0`;
 *  ⑤ **读端认得**:`isTraceEvent` / `tracePayloadOf` 只认我方前缀,真实用户 feedback
 *     绝不误认。
 */
import { describe, it, expect } from 'vitest'
import {
  LEGACY_TRACE_TYPES,
  TRACE_EVENT_TYPE,
  TRACE_TEXT_PREFIX,
  TRACE_VERSION,
  decodeTraceText,
  encodeTraceText,
  isTraceEvent,
  tracePayloadOf,
  traceSummary,
} from '../lib/marker-carrier.js'
import {
  isLegacyTraceType,
  traceEventFor,
  translateLegacyTraces,
} from '../lib/migration-traces.js'

/** A 类真实样本(生产 `<session>` @seq 7441 原文形状)。 */
const goalMarker = {
  type: 'retrace/goal-marker',
  seq: 7441,
  time: 1788097607297,
  ignorable: true,
  data: { originalOperation: 'clear' },
}

/** B 类真实样本(生产 `<session>` @seq 339 原文形状;`turn`/`step` 为 null)。 */
const legacyMarker = {
  type: 'retrace/marker',
  seq: 339,
  time: 1787779599458,
  ignorable: true,
  data: {
    turn: null,
    step: null,
    message: {
      id: 'retrace-edit-mtaltbhd-mizwfvl7',
      role: 'assistant',
      content: [],
      source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    },
    editor: { targetSeq: 10, text: '我们因为bug修复对话和…' },
  },
}

/** 一份含 header 行 + 两类事件 + 无关事件的日志(seq 连续)。 */
function logText() {
  return [
    JSON.stringify({ type: 'session', version: 0, id: 't', createdAt: 1, cwd: '/tmp', delegationDepth: 0 }),
    JSON.stringify({ type: 'turn/start', seq: 0, time: 10, data: { turn: 1 } }),
    JSON.stringify(legacyMarker),
    JSON.stringify({ type: 'step/end', seq: 340, time: 11, data: { turn: 1, step: 1 } }),
    JSON.stringify(goalMarker),
  ].join('\n')
}

describe('migration-traces · 承载形状(官方词表精确形状)', () => {
  it('信封只留 type/seq/time,承载类型 = feedback/record,ignorable 去掉', () => {
    const traced = traceEventFor(goalMarker)
    expect(traced.event.type).toBe(TRACE_EVENT_TYPE)
    expect(traced.event.seq).toBe(7441)
    expect(traced.event.time).toBe(1788097607297)
    expect(Object.keys(traced.event).sort()).toEqual(['data', 'seq', 'time', 'type'])
    // 官方 `feedback/record` 的 data 恰一个成员(text);多一个即被官方 payload 校验器拒。
    expect(Object.keys(traced.event.data)).toEqual(['text'])
    expect(typeof traced.event.data.text).toBe('string')
    expect(traced.event.data.text.startsWith(TRACE_TEXT_PREFIX)).toBe(true)
  })

  it('A 类痕迹载荷:originalOperation 与时间都在', () => {
    const payload = tracePayloadOf(traceEventFor(goalMarker).event)
    expect(payload.kind).toBe('goal-marker')
    expect(payload.v).toBe(TRACE_VERSION)
    expect(payload.originalType).toBe('retrace/goal-marker')
    expect(payload.originalSeq).toBe(7441)
    expect(payload.originalTime).toBe(1788097607297)
    expect(payload.originalOperation).toBe('clear')
    expect(payload.originalData).toEqual({ originalOperation: 'clear' })
  })

  it('B 类痕迹载荷:targetSeq / 文本 / 原 message 全保留,`turn:null`/`step:null` 被清洗且留记录', () => {
    const traced = traceEventFor(legacyMarker)
    const payload = tracePayloadOf(traced.event)
    expect(payload.kind).toBe('marker')
    expect(payload.targetSeq).toBe(10)
    expect(payload.messageId).toBe('retrace-edit-mtaltbhd-mizwfvl7')
    expect(payload.text).toBe('我们因为bug修复对话和…')
    expect(payload.originalData.message).toEqual(legacyMarker.data.message)
    expect(payload.originalData.editor).toEqual(legacyMarker.data.editor)
    // 旧值清洗:null 的 turn/step 不得进入新形态(连 originalData 里也没有),
    // 但必须留下可审计的记录。
    expect(Object.hasOwn(payload.originalData, 'turn')).toBe(false)
    expect(Object.hasOwn(payload.originalData, 'step')).toBe(false)
    expect(traced.droppedNullKeys).toEqual(['turn', 'step'])
    expect(payload.droppedNullKeys).toEqual(['turn', 'step'])
    // 新形态的痕迹**不含**任何 turn/step 键(`turn`/`step` 二字只允许出现在
    // `droppedNullKeys` 的清洗记录里)。
    expect(Object.hasOwn(payload, 'turn')).toBe(false)
    expect(Object.hasOwn(payload, 'step')).toBe(false)
    const stripped = { ...payload, droppedNullKeys: undefined }
    expect(JSON.stringify(stripped).includes('"turn"')).toBe(false)
    expect(JSON.stringify(stripped).includes('"step"')).toBe(false)
  })
})

describe('migration-traces · 保痕迹与幂等(整份日志)', () => {
  it('行数 / seq 序列 / 无关行逐字节不变(只改 type 与 data)', () => {
    const before = logText()
    const out = translateLegacyTraces(before)
    expect(out.changed).toBe(2)
    const beforeLines = before.split('\n')
    const afterLines = out.text.split('\n')
    expect(afterLines.length).toBe(beforeLines.length)
    // header / 无关事件行原样(逐字节)
    expect(afterLines[0]).toBe(beforeLines[0])
    expect(afterLines[1]).toBe(beforeLines[1])
    expect(afterLines[3]).toBe(beforeLines[3])
    const seqs = (text) => text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).seq)
    expect(seqs(out.text)).toEqual(seqs(before))
  })

  it('幂等:对产物再跑一次 changed === 0', () => {
    const once = translateLegacyTraces(logText())
    const twice = translateLegacyTraces(once.text)
    expect(twice.changed).toBe(0)
    expect(twice.alreadyTranslated).toBe(2)
    expect(twice.text).toBe(once.text)
    // 三次同样不变(可复跑)
    expect(translateLegacyTraces(twice.text).text).toBe(once.text)
  })

  it('翻译后不再有 retrace/* 事件类型', () => {
    const out = translateLegacyTraces(logText())
    const types = out.text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l).type)
    expect(types.filter((t) => t.startsWith('retrace/'))).toEqual([])
  })

  it('空日志 / 无目标事件 ⇒ 零改动且逐字节不变', () => {
    const plain = [JSON.stringify({ type: 'session', version: 0 }), JSON.stringify({ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } })].join('\n')
    const out = translateLegacyTraces(plain)
    expect(out.changed).toBe(0)
    expect(out.text).toBe(plain)
  })

  it('未知成员不丢(先保痕迹,再谈形状)', () => {
    const weird = { type: 'retrace/marker', seq: 5, time: 6, data: { editor: { targetSeq: 1 }, futureField: { a: [1, 2] } } }
    const payload = tracePayloadOf(translateLegacyTraces(JSON.stringify(weird)).text ? JSON.parse(translateLegacyTraces(JSON.stringify(weird)).text) : null)
    expect(payload.originalData.futureField).toEqual({ a: [1, 2] })
    expect(payload.targetSeq).toBe(1)
  })
})

describe('migration-traces · 读端判定(只认我方前缀)', () => {
  it('真实用户 feedback 绝不误认', () => {
    expect(isTraceEvent({ type: 'feedback/record', seq: 1, time: 1, data: { text: '这个插件很好用' } })).toBe(false)
    expect(isTraceEvent({ type: 'feedback/record', seq: 1, time: 1, data: { text: 'retrace-trace/v1 不是 JSON' } })).toBe(false)
    expect(isTraceEvent({ type: 'feedback/record', seq: 1, time: 1, data: { text: 'retrace-trace/v2 {"kind":"marker"}' } })).toBe(false)
    expect(isTraceEvent({ type: 'assistant/message', seq: 1, time: 1, data: { text: encodeTraceText({ kind: 'marker' }) } })).toBe(false)
    expect(decodeTraceText(undefined)).toBe(null)
    expect(decodeTraceText(42)).toBe(null)
  })

  it('未来 kind 仍被认出(免得未来的痕迹被当真实反馈)', () => {
    const text = encodeTraceText({ kind: 'future-kind', originalSeq: 9, originalTime: 1234 })
    const payload = decodeTraceText(text)
    expect(payload.kind).toBe('future-kind')
    expect(isTraceEvent({ type: TRACE_EVENT_TYPE, seq: 9, time: 1234, data: { text } })).toBe(true)
  })

  it('encode/decode:缺 v 或 kind 的载荷一律不认(前缀不足以构成痕迹)', () => {
    // `v` 与 kind 必须有值 —— 这是 decodeTraceText 的准入条件(前缀只是第一道门)。
    const noKind = `${TRACE_TEXT_PREFIX}${JSON.stringify({ v: TRACE_VERSION })}`
    const noVersion = `${TRACE_TEXT_PREFIX}${JSON.stringify({ kind: 'marker' })}`
    const blankKind = `${TRACE_TEXT_PREFIX}${JSON.stringify({ v: TRACE_VERSION, kind: '' })}`
    for (const text of [noKind, noVersion, blankKind]) {
      expect(decodeTraceText(text)).toBe(null)
      expect(isTraceEvent({ type: TRACE_EVENT_TYPE, seq: 1, time: 1, data: { text } })).toBe(false)
    }
  })

  it('B 类残骸逐成员保留:originalData 键集 = 原 data 键集 − 被清洗的空值键(一个不少)', () => {
    // 中和只留下 editor{targetSeq,text} 等残骸 ⇒ 这些成员是仅存的信息,翻译不得丢。
    const payload = tracePayloadOf(traceEventFor(legacyMarker).event)
    const originalKeys = Object.keys(legacyMarker.data).sort()
    const keptKeys = Object.keys(payload.originalData).sort()
    expect(keptKeys).toEqual(originalKeys.filter((k) => !['turn', 'step'].includes(k)))
    // editor 两个成员逐个相等(逐成员保留,不是"取所需字段")
    expect(payload.originalData.editor.targetSeq).toBe(legacyMarker.data.editor.targetSeq)
    expect(payload.originalData.editor.text).toBe(legacyMarker.data.editor.text)
    // 冗余便捷键与 originalData 同源(读端不必解析 originalData 也能拿到)
    expect(payload.targetSeq).toBe(payload.originalData.editor.targetSeq)
    expect(payload.text).toBe(payload.originalData.editor.text)
    expect(payload.messageId).toBe(payload.originalData.message.id)
  })

  it('B 类残骸逐成员保留:翻译产物里 editor.targetSeq / text 可直接取出', () => {
    const out = translateLegacyTraces(logText())
    const trace = out.text.split('\n').map((l) => { try { return JSON.parse(l) } catch { return null } }).find((e) => isTraceEvent(e) && tracePayloadOf(e).kind === 'marker')
    const payload = tracePayloadOf(trace)
    expect(payload.targetSeq).toBe(10)
    expect(payload.text).toBe('我们因为bug修复对话和…')
    expect(payload.originalType).toBe('retrace/marker')
    expect(payload.originalSeq).toBe(339)
    expect(payload.originalTime).toBe(1787779599458)
    expect(payload.droppedNullKeys).toEqual(['turn', 'step'])
  })

  it('痕迹文案编码是字节稳定的(同一输入 → 同一输出)', () => {
    const a = encodeTraceText({ kind: 'marker', originalType: 'retrace/marker', originalSeq: 1, originalTime: 2, targetSeq: 3 })
    const b = encodeTraceText({ kind: 'marker', originalType: 'retrace/marker', originalSeq: 1, originalTime: 2, targetSeq: 3 })
    expect(a).toBe(b)
  })

  it('人读摘要:两类各给一句话(不参与能力判据)', () => {
    expect(traceSummary(tracePayloadOf(traceEventFor(goalMarker).event))).toContain('目标曾被清空')
    expect(traceSummary(tracePayloadOf(traceEventFor(legacyMarker).event))).toContain('targetSeq=10')
    expect(traceSummary(null)).toBe('')
  })

  it('历史类型清单与 kind 映射覆盖两类(不多不少)', () => {
    expect(LEGACY_TRACE_TYPES.slice().sort()).toEqual(['retrace/goal-marker', 'retrace/marker'])
    expect(isLegacyTraceType('retrace/goal-marker')).toBe(true)
    expect(isLegacyTraceType('retrace/marker')).toBe(true)
    expect(isLegacyTraceType('retrace/versions')).toBe(false)
    expect(isLegacyTraceType('assistant/message')).toBe(false)
    expect(traceEventFor({ type: 'retrace/versions', seq: 1, time: 1, data: {} })).toBe(null)
  })
})
