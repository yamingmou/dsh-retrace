/**
 * dsh-retrace — lib/adapter/contract.js
 *
 * 适配器层契约(2026-09-01)——业务层与平台解耦的接口定义。
 * **2026-09-10 契约运行时化**:契约不再只是 JSDoc
 * 声明——跨层边界处的形状在**运行时**被断言,违反时抛出**指名道姓**的错误
 * (哪个契约 / 期望什么 / 实际什么),不再"以奇怪方式炸"或静默通过。
 *
 * 目标:换架构(不用 DSH)时,业务层(message-list.js/守卫)零改动,
 * 只需实现新的「读事件 + 写替换」两个适配器。
 *
 * 三个角色:
 * - 业务层:message-list.js(纯函数,零依赖)——消费「通用事件」,产出消息列表/遮蔽;
 * - 适配器层(本文件):定义「事件读取器」和「替换写入器」两个接口 + 运行时校验;
 * - 平台实现:dsh.js / dsh-writer.js(DSH 实现)、未来 self-runtime-adapter.js 等。
 *
 * 通用事件格式(业务层消费的最小形态):
 *   { seq, type, turn, data, source }——与具体平台的存储格式无关。
 *
 * 校验原则(轻量,零依赖):
 * - 纯函数:不达标 → **抛**(`code: 'contract-violation'`,附 contract/expected/actual),
 *   或返回带 violations 的结果(供"体检"式调用);
 * - 成本可控:大日志(百万级事件)只**抽样**校验头/中/尾,禁止 O(n) 全量断言;
 * - 只在**跨层边界**校验:适配器返回值、跨层传入的 span、写出的 marker——
 *   内部实现细节不设卡(避免把断言变成运行负担)。
 *
 * 零平台 import(只引纯语义模块) → 动态插件 realm 可 inline。
 */
import { SPAN_STATUS, isSpanStatus } from '../span-semantics.js'

/** 契约违规错误码(host 侧透传到 wire;client 未映射时显示 host message)。 */
export const CONTRACT_VIOLATION = 'contract-violation'

/** 实际值的紧凑渲染(错误信息可读;超长截断,不 dump 百万事件)。 */
function describeActual(value) {
  if (value === undefined) return 'undefined'
  if (value === null) return 'null'
  if (typeof value === 'function') return 'function'
  if (Array.isArray(value)) return `Array(${value.length})`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    return `{${keys.slice(0, 8).join(',')}${keys.length > 8 ? ',…' : ''}}`
  }
  const text = String(value)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

/**
 * 造一个契约违规错误:错误信息里说清**哪个契约 / 期望什么 / 实际什么**。
 * @param {string} contract - 契约名(如 'Span.shape' / 'ReplaceWriter.result')
 * @param {string} expected - 期望(人读)
 * @param {unknown} actual - 实际值(渲染后入 message,原值挂 error.actual)
 * @returns {Error}
 */
export function contractViolation(contract, expected, actual) {
  const error = new Error(`契约违规[${contract}]:期望 ${expected};实际 ${describeActual(actual)}`)
  error.code = CONTRACT_VIOLATION
  error.contract = contract
  error.expected = expected
  error.actual = actual
  return error
}

/** 断言(条件不成立 → 抛契约违规)。 */
export function assertContract(condition, contract, expected, actual) {
  if (!condition) throw contractViolation(contract, expected, actual)
  return true
}

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * span 结构契约:{start, end, shadowedSeqs} 且 shadowedSeqs 是**位置连续段**
 * (首尾 === start/end)。
 *
 * ⚠️ 这里**不断言 start <= end**:nodes 是**位置序**(非 seq 单调)——replace marker
 * 带着更大的 seq 插进被遮蔽区间的位置,于是「位置在前、seq 更大」是合法形态。
 * 官方 `replacementRange`(dsh-session)只按 `indexOf(start) <= indexOf(end)` 的
 * **位置**判定,与 seq 数值大小无关;要求 start <= end 会把真实会话上的合法 span
 * 误判为契约违规(真实数据实测:7000011 → 7000009 的跨度是正常写入)。
 * 真正可判定的是:两端都是当前面上的节点 → 位置连续段 → 首尾一致(见下)。
 */
export function assertSpanShape(span, contract = 'Span.shape') {
  assertContract(isPlainObject(span), contract, 'span 为对象 {start,end,shadowedSeqs}', span)
  assertContract(
    Number.isSafeInteger(span.start) && span.start >= 0,
    contract, 'span.start 为非负安全整数', span.start,
  )
  assertContract(
    Number.isSafeInteger(span.end) && span.end >= 0,
    contract, 'span.end 为非负安全整数', span.end,
  )
  assertContract(
    Array.isArray(span.shadowedSeqs) && span.shadowedSeqs.length > 0,
    contract, 'span.shadowedSeqs 为非空数组', span.shadowedSeqs,
  )
  assertContract(
    span.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0),
    contract, 'span.shadowedSeqs 元素全为非负安全整数', span.shadowedSeqs,
  )
  assertContract(
    span.shadowedSeqs[0] === span.start && span.shadowedSeqs[span.shadowedSeqs.length - 1] === span.end,
    contract, 'shadowedSeqs 首尾 === span.start/end(位置连续段;seq 数值可非单调)',
    `${span.shadowedSeqs[0]}..${span.shadowedSeqs[span.shadowedSeqs.length - 1]}`,
  )
  return span
}

/**
 * span 计算结果契约:`{ status, span, facts }`——
 * status 必须是 SPAN_STATUS 成员;status ≠ ok 时 span 必须为空
 * (状态显式,不允许"有 span 又报失败"的自相矛盾结果)。
 */
export function assertSpanResult(result, contract = 'SpanResult.shape') {
  assertContract(isPlainObject(result), contract, '结果为对象 {status, span, facts}', result)
  assertContract(isSpanStatus(result.status), contract, `status ∈ SPAN_STATUS(${Object.values(SPAN_STATUS).join('|')})`, result.status)
  if (result.status === SPAN_STATUS.OK) {
    assertSpanShape(result.span, `${contract}.span`)
  } else {
    assertContract(
      result.span === null || result.span === undefined,
      contract, 'status ≠ ok 时 span 必须为空(null/undefined)', result.span,
    )
  }
  if (result.facts !== undefined) assertSpanFacts(result.facts, `${contract}.facts`)
  return result
}

/** 文件快照事实契约:{fileMaxSeq, targetSeq}(-1 = 未知/不可读)。 */
export function assertSpanFacts(facts, contract = 'SpanFacts.shape') {
  assertContract(isPlainObject(facts), contract, 'facts 为对象 {fileMaxSeq,targetSeq}', facts)
  assertContract(Number.isSafeInteger(facts.fileMaxSeq), contract, 'facts.fileMaxSeq 为安全整数(-1 = 快照不可读)', facts.fileMaxSeq)
  assertContract(Number.isSafeInteger(facts.targetSeq), contract, 'facts.targetSeq 为安全整数(-1 = 快照未含目标)', facts.targetSeq)
  return facts
}

/**
 * 事件列表契约(EventReader 返回值)——通用事件最小形态的**抽样**校验:
 * 元素必须是非 null 对象;带 seq 时必须是数字(header 帧等无 seq 事件合法)。
 * 抽样头/中/尾(百万级日志不做 O(n) 断言,成本必须可忽略)。
 */
export function assertEventListShape(events, contract = 'EventReader.events', { sample = 5 } = {}) {
  assertContract(Array.isArray(events), contract, '事件列表为数组(null = 读取失败,由调用方降级)', events)
  if (events.length === 0) return events
  const positions = new Set([0, events.length - 1, Math.floor(events.length / 2), 1, events.length - 2])
  let checked = 0
  for (const i of positions) {
    if (i < 0 || i >= events.length || checked >= sample) continue
    checked++
    const event = events[i]
    assertContract(isPlainObject(event), contract, `events[${i}] 为非 null 对象(通用事件形态)`, event)
    if (event.seq !== undefined) {
      assertContract(typeof event.seq === 'number' && Number.isSafeInteger(event.seq), contract, `events[${i}].seq 为安全整数(或省略)`, event.seq)
    }
    if (event.type !== undefined) {
      assertContract(typeof event.type === 'string', contract, `events[${i}].type 为字符串(或省略)`, event.type)
    }
  }
  return events
}

/**
 * 写入端 marker 事件契约(ReplaceWriter 返回值)。
 *
 * 为什么这些字段必须断言:"写前校验保证 marker 合法"是**声称**——本断言把
 * 其中的形状部分变成**有校验**的事实:marker 是替换型空 assistant 消息,
 * `surfaceOp.start/end` 必须与 `sourceEventSeqs` 首尾一致(否则重放面与写入
 * 端分叉 → 遮蔽范围与日志不一致,历史上正是这类不一致导致会话加载失败)。
 */
export function assertMarkerShape(marker, contract = 'ReplaceWriter.marker') {
  assertContract(isPlainObject(marker), contract, 'marker 为事件对象', marker)
  assertContract(Number.isSafeInteger(marker.seq) && marker.seq >= 0, contract, 'marker.seq 为非负安全整数', marker.seq)
  assertContract(marker.type === 'assistant/message', contract, "marker.type === 'assistant/message'", marker.type)
  const op = marker.surfaceOp
  assertContract(isPlainObject(op) && op.op === 'replace', contract, "marker.surfaceOp = {op:'replace',start,end}", op)
  assertContract(
    Number.isSafeInteger(op.start) && Number.isSafeInteger(op.end) && op.start >= 0 && op.end >= 0,
    contract, 'marker.surfaceOp.start/end 为非负安全整数(位置序,start 数值可 > end)', `${op.start}..${op.end}`,
  )
  const seqs = marker.sourceEventSeqs
  assertContract(Array.isArray(seqs) && seqs.length > 0, contract, 'marker.sourceEventSeqs 为非空数组', seqs)
  assertContract(
    seqs[0] === op.start && seqs[seqs.length - 1] === op.end,
    contract, 'sourceEventSeqs 首尾 === surfaceOp.start/end(写入端与重放面一致)', `${seqs[0]}..${seqs[seqs.length - 1]}`,
  )
  const editor = marker.data?.editor
  assertContract(
    isPlainObject(editor) && Number.isSafeInteger(editor.targetSeq),
    contract, 'marker.data.editor.targetSeq 为安全整数(业务溯源字段)', editor?.targetSeq,
  )
  return marker
}

/** 适配器组装契约(两个角色都必须实现各自方法)。 */
export function assertAdapterShape(adapter, contract = 'Adapter.shape') {
  assertContract(isPlainObject(adapter), contract, '适配器为对象 {reader, writer}', adapter)
  assertContract(
    isPlainObject(adapter.reader) && typeof adapter.reader.readEvents === 'function',
    contract, 'adapter.reader.readEvents 为函数(EventReader)', adapter.reader,
  )
  assertContract(
    isPlainObject(adapter.writer) && typeof adapter.writer.writeReplace === 'function',
    contract, 'adapter.writer.writeReplace 为函数(ReplaceWriter)', adapter.writer,
  )
  return adapter
}

/**
 * 事件读取器接口:按 sessionId 提供「全量事件」(可靠事实,非内存视图)。
 * @typedef {Object} EventReader
 * @property {(sessionId: string) => Promise<Array<{seq:number, type:string, turn?:number, data?:object, source?:object}>|null>} readEvents
 *   - 返回按 seq 升序的全量事件;
 *   - 必须从持久化层读(文件/存储),不依赖运行内存(host 内存可能稀疏/窗口化);
 *   - 失败返回 null/throw 由调用方 fallback(运行时经 assertEventListShape 抽样校验)。
 */

/**
 * 替换写入器接口:在会话上写「遮蔽替换」(模型侧消费)。
 * @typedef {Object} ReplaceWriter
 * @property {(sessionId: string, span: {start:number, end:number, shadowedSeqs:number[]}) => Promise<object>} writeReplace
 *   - 用平台机制写替换标记(DSH = session.append + surfaceOp replace);
 *   - 返回写入结果(marker seq 等),运行时经 assertMarkerShape 校验。
 */

/**
 * 组装一个「完整适配器」:读事件 + 写替换,业务层只依赖它。
 * @param {EventReader} reader
 * @param {ReplaceWriter} writer
 */
export function createAdapter(reader, writer) {
  return assertAdapterShape({ reader, writer }, 'Adapter.assembly')
}

/** 空适配器(无平台时,业务层可独立运行)。 */
export const NULL_ADAPTER = createAdapter(
  { readEvents: async () => null },
  { writeReplace: async () => null },
)
