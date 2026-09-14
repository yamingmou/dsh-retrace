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
// 两段结构的形状/文案真相(纯模块零 import;动态件生成时先于本文件 inline)。
import { AUDIT_DATA_KEYS, AUDIT_EVENT_TYPE, CARRIER_DATA_KEYS, CARRIER_SOURCE_KIND, MARKER_ID_PREFIXES, isMarkerId } from '../marker-carrier.js'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'

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
 * 误判为契约违规(现场实测:位置序 span 的 seq 数值非单调属正常写入)。
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
 * 写入端**两段结构**的事件契约(ReplaceWriter 返回值 / 落盘前预演)。
 *
 * 为什么这些字段要断言:"写前校验保证 marker 合法"是**声称**——本断言把其中的形状
 * 部分变成**有校验**的事实(两段结构:第 1 段审计 + 第 2 段载体,形状各异):
 * - 第 1 段 `compaction/prune` 的 data 是官方精确三成员清单(无 optional/opaque)
 *   ⇒ 多一个成员即被官方 `has unexpected member` 拒;
 * - 第 2 段 `user/message` 的 data 同样是精确四成员清单,`surfaceOp` 区间与
 *   `sourceEventSeqs` 的被遮蔽段 首尾一致(否则重放面与写入端分叉 —— 历史上正是
 *   这类不一致导致会话加载失败)。
 *
 * `sourceEventSeqs` 的读法(与 lib/marker-carrier.js 一致):首元素 = 第 1 段审计
 * 事件的 seq,被遮蔽段自其后的**区间起点**开始 ⇒ 端点断言取「去掉审计 seq 之后的首尾」。
 * 预演阶段(第 1 段尚未写入,seq 未知)可传 `auditSeq` 占位值,断言逻辑不变。
 *
 * @param {object} marker - 第 2 段事件(或预演对象)
 * @param {string} contract - 断言上下文名
 * @param {{runtimeShape?:object, auditSeq?:number}} [opts] - runtimeShape 注入(测试/多树验证);
 *   auditSeq = 期望的审计 seq(占位允许,仅用于核对首元素位置)
 */
export function assertMarkerShape(marker, contract = 'ReplaceWriter.marker', opts = {}) {
  assertContract(isPlainObject(marker), contract, 'marker 为事件对象', marker)
  assertContract(Number.isSafeInteger(marker.seq) && marker.seq >= 0, contract, 'marker.seq 为非负安全整数', marker.seq)
  assertContract(marker.type === 'user/message', contract, "marker.type === 'user/message'(两段结构的第 2 段载体)", marker.type)
  const data = marker.data
  assertContract(isPlainObject(data), contract, 'marker.data 为对象', data)
  assertContract(
    sameKeySet(data, CARRIER_DATA_KEYS),
    contract,
    `marker.data 键集恰为 {${CARRIER_DATA_KEYS.join(',')}}(官方 user/message 词表,无 optional/opaque)`,
    Object.keys(data).join(','),
  )
  assertContract(
    isPlainObject(data.source) && data.source.kind === CARRIER_SOURCE_KIND,
    contract,
    `marker.data.source.kind === '${CARRIER_SOURCE_KIND}'(≠'user':否则轮边界被当成真实用户输入)`,
    data.source?.kind,
  )
  assertContract(
    Array.isArray(data.content) && data.content.length > 0,
    contract,
    'marker.data.content 为非空数组(空 content 会投影成一条空 user 消息)',
    data.content,
  )
  assertContract(isMarkerId(data.id), contract, `marker.data.id 为我方 marker id(前缀 ${MARKER_ID_PREFIXES.join('/')})`, data.id)
  const { start, end, startKey, endKey, shape } = markerSurfaceRange(marker.surfaceOp, contract)
  // 双向误用探测(方案 v3 §二①):**形状须与当前运行时一致**。
  // 依据:官方 v0 树只校验键数(=3)、不校验键名语义 ⇒ 用错形状的错误要等到下游才显现;
  // 且官方迁移链自己会在 v2→v3 换名 ⇒ 我方无需预先写 v3 键名(全语料 v3 形状先例 0/308)。
  // 故:本断言对**写侧严格**(形状须匹配目标树),而 markerSurfaceRange 的**解析**保持宽松
  // (两形状都解析,供读历史数据);目标树可经 opts.runtimeShape 注入(测试/多树验证用)。
  const rtShape = opts.runtimeShape ?? runtimeSurfaceOpShape()
  assertContract(
    shape === rtShape.shape,
    contract,
    `marker.surfaceOp 形状须与当前运行时一致(${rtShape.shape};SESSION_FORMAT_VERSION=${rtShape.version})`,
    `实际 ${shape}`,
  )
  const seqs = marker.sourceEventSeqs
  assertContract(Array.isArray(seqs) && seqs.length > 0, contract, 'marker.sourceEventSeqs 为非空数组', seqs)
  if (opts.auditSeq !== undefined) {
    assertContract(seqs[0] === opts.auditSeq, contract, 'sourceEventSeqs 首元素 === 第 1 段(审计)事件 seq', seqs[0])
    assertContract(seqs.length >= 2, contract, 'sourceEventSeqs = [审计 seq, …被遮蔽节点](至少 2 项)', seqs)
  }
  // 被遮蔽段自区间起点起:首元素若是区间起点(旧形态/无审计引用)则自 0 起算。
  const from = seqs[0] === start ? 0 : 1
  assertContract(
    seqs[from] === start && seqs[seqs.length - 1] === end,
    contract,
    `去掉审计 seq 后 sourceEventSeqs 首尾 === surfaceOp.${startKey}/${endKey}(写入端与重放面一致)`,
    `${seqs[from]}..${seqs[seqs.length - 1]}`,
  )
  assertContract(
    seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0),
    contract,
    'sourceEventSeqs 元素全为非负安全整数',
    seqs,
  )
  assertContract(
    new Set(seqs).size === seqs.length,
    contract,
    'sourceEventSeqs 无重复项(官方 provenance 拒重复)',
    seqs.length,
  )
  if (opts.auditSeq !== undefined) {
    // 审计事件写在其后 ⇒ 它的 seq 大于全部被遮蔽节点(官方 provenance 只允许引用
    // 更早事件;相等则同时构成重复项)。这条同时拦住"调用方拿陈旧快照算的 span"
    // ——那种 span 会把某个尚未产生的事件 seq 当成被遮蔽节点。
    const later = seqs.filter((seq) => seq !== opts.auditSeq && seq >= opts.auditSeq)
    assertContract(
      later.length === 0,
      contract,
      `全部被遮蔽节点 seq 早于审计事件 seq ${opts.auditSeq}(官方 provenance 只允许引用更早事件)`,
      later,
    )
  }
  return marker
}

/**
 * 第 1 段(`compaction/prune`,log-only 审计)的事件契约。
 *
 * 官方词表(`dsh-session-format-v0-to-v1`):data 恰三成员、无 optional/opaque;
 * 语义约束 = shadowedRange 恰 `{start,end}` 且**都早于本事件 seq**、shadowedSeqs
 * 非空且首尾 === 区间端点、shadowedTokenCount 为非负整数。
 * @param {object} audit - 第 1 段事件(或预演对象,seq 用占位 0)
 * @param {string} contract
 */
export function assertAuditShape(audit, contract = 'ReplaceWriter.audit') {
  assertContract(isPlainObject(audit), contract, '审计事件为对象', audit)
  assertContract(Number.isSafeInteger(audit.seq) && audit.seq >= 0, contract, '审计事件 seq 为非负安全整数', audit.seq)
  assertContract(audit.type === AUDIT_EVENT_TYPE, contract, `审计事件 type === '${AUDIT_EVENT_TYPE}'(官方 log-only 类型)`, audit.type)
  assertContract(
    audit.surfaceOp === undefined && audit.sourceEventSeqs === undefined,
    contract,
    '审计事件不带 surfaceOp/sourceEventSeqs(该类型非 surface-eligible,运行时直接抛)',
    describeActual({ surfaceOp: audit.surfaceOp, sourceEventSeqs: audit.sourceEventSeqs }),
  )
  const data = audit.data
  assertContract(isPlainObject(data), contract, '审计事件 data 为对象', data)
  assertContract(
    sameKeySet(data, AUDIT_DATA_KEYS),
    contract,
    `审计事件 data 键集恰为 {${AUDIT_DATA_KEYS.join(',')}}(官方词表:无 optional/opaque)`,
    Object.keys(data).join(','),
  )
  const range = data.shadowedRange
  assertContract(
    isPlainObject(range) && sameKeySet(range, ['start', 'end']),
    contract, 'shadowedRange 为精确 {start,end}', range,
  )
  assertContract(
    Number.isSafeInteger(range.start) && range.start >= 0 && Number.isSafeInteger(range.end) && range.end >= 0,
    contract, 'shadowedRange 端点为非负安全整数', `${range.start}..${range.end}`,
  )
  const seqs = data.shadowedSeqs
  assertContract(Array.isArray(seqs) && seqs.length > 0, contract, 'shadowedSeqs 为非空数组', seqs)
  assertContract(
    seqs.every((seq) => Number.isSafeInteger(seq) && seq >= 0),
    contract, 'shadowedSeqs 元素全为非负安全整数', seqs,
  )
  assertContract(
    seqs[0] === range.start && seqs[seqs.length - 1] === range.end,
    contract, 'shadowedSeqs 首尾 === shadowedRange 端点(官方语义约束)',
    `${seqs[0]}..${seqs[seqs.length - 1]}`,
  )
  assertContract(
    new Set(seqs).size === seqs.length,
    contract, 'shadowedSeqs 无重复 seq(官方 seqArray 拒重复)', `${seqs.length} 项/${new Set(seqs).size} 个不同值`,
  )
  assertContract(
    Number.isSafeInteger(data.shadowedTokenCount) && data.shadowedTokenCount >= 0,
    contract, 'shadowedTokenCount 为非负整数', data.shadowedTokenCount,
  )
  return audit
}

/** 两个键集是否**完全相同**(顺序无关)。 */
function sameKeySet(value, keys) {
  const actual = Object.keys(value)
  if (actual.length !== keys.length) return false
  return keys.every((key) => Object.hasOwn(value, key))
}

/**
 * marker.surfaceOp 的**双形状**区间取值(特性探测,勿硬断言单一形状)。
 *
 * - **运行时 0.1.1-rc.2(树 v0)**：`{op:'replace', start, end}`
 *   —— `dsh-session/lib/types/surface.js:113-122` 的 `isReplaceOp` 要求 `Object.keys(op).length === 3`;
 *   且 `dsh-session-format-v0-to-v1/lib/index.js:1564-1568` 的
 *   `assertReleasedV0Keys(replacement, ['op','start','end'], [], …)` 对**多余键**报
 *   `has unexpected member`。
 * - **lab 0.1.5(v3)**：`{op:'replace', startSeq, endSeq}`
 *   —— `surface.js:166-174` 的 `isReplaceOp` 同样要求键数**精确为 3**;
 *   键名由 v2→v3 迁移改写(`dsh-session-format-v2-to-v3/lib/index.js:366-372`)。
 *
 * 两棵树都要求**键数精确为 3** → **不允许混写**(同时带 `start` 与 `startSeq` 在两边都非法)。
 * 本函数只做形状判定与区间提取,**不决定写哪一套**;写哪套由运行时特性探测决定。
 *
 * @param op - marker.surfaceOp
 * @param contract - 断言上下文名
 * @returns {{start:number, end:number, shape:'start/end'|'startSeq/endSeq'}}
 */
/**
 * 当前运行时的 surfaceOp **形状**(特性探测,勿硬编码)。
 *
 * 依据:官方 `@deepseek-ai/dsh-session` 在**两棵树都导出** `SESSION_FORMAT_VERSION`
 * —— 运行时 0.1.1-rc.2 = `0`(形状 `{op,start,end}`);lab 0.1.5 = `3`(形状 `{op,startSeq,endSeq}`)。
 * 静态导入该常量在两棵树都安全(与"被移除的 `decodeStorageRecord`"不同)。
 *
 * ⚠️ 探测的理由:官方 v0 树只校验键数(=3),**不校验键名语义** ⇒ 写错形状的错误要等到下游才显现,
 * (`surface start targets consumed assistant/chunk undefined`)⇒ 写错形状会**静默失效**。
 *
 * @returns {{shape:'start/end'|'startSeq/endSeq', version:number, startKey:string, endKey:string}}
 */
export function runtimeSurfaceOpShape() {
  let version = 0
  try {
    // 动态读取,避免打包期静态解析失败时整体崩(降级为 v0 = 本仓当前运行时的形状)
    version = Number(SESSION_FORMAT_VERSION ?? 0)
  } catch { version = 0 }
  const v3 = Number.isFinite(version) && version >= 3
  return v3
    ? { shape: 'startSeq/endSeq', version, startKey: 'startSeq', endKey: 'endSeq' }
    : { shape: 'start/end', version, startKey: 'start', endKey: 'end' }
}

export function markerSurfaceRange(op, contract = 'ReplaceWriter.marker') {
  assertContract(
    isPlainObject(op) && op.op === 'replace',
    contract, "marker.surfaceOp = {op:'replace',start,end}(v0)或 {op:'replace',startSeq,endSeq}(v3)", op,
  )
  const keys = Object.keys(op).sort().join(',')
  const isV0Shape = keys === 'end,op,start'
  const isV3Shape = keys === 'endSeq,op,startSeq'
  assertContract(
    isV0Shape || isV3Shape,
    contract,
    "marker.surfaceOp 键集为 {op,start,end}(v0 运行时)或 {op,startSeq,endSeq}(v3 运行时);两棵树均要求键数精确为 3,不得混用",
    keys,
  )
  const start = isV0Shape ? op.start : op.startSeq
  const end = isV0Shape ? op.end : op.endSeq
  assertContract(
    Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && end >= 0,
    contract, 'marker.surfaceOp 区间端点为非负安全整数(位置序,start 数值可 > end)', `${start}..${end}`,
  )
  return {
    start,
    end,
    shape: isV0Shape ? 'start/end' : 'startSeq/endSeq',
    startKey: isV0Shape ? 'start' : 'startSeq',
    endKey: isV0Shape ? 'end' : 'endSeq',
  }
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
