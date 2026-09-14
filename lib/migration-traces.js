/**
 * dsh-retrace — lib/migration-traces.js
 *
 * **迁移前翻译**:把历史遗留的**非法事件类型**转成官方合法、且读端认得的**痕迹**形态。
 *
 * 背景(实测):
 *  - 早期版本留下两个不在官方 v0 冻结清单里的自造类型:
 *      `retrace/goal-marker`(语义=「目标曾被清空」的痕迹;`data` = `{originalOperation}`)
 *      `retrace/marker`(**`dsh-log-contract --neutralize` 的产物**,依据
 *        `dsh-log-contract/lib/repair.js:213-217`:`delete v.surfaceOp;
 *        delete v.sourceEventSeqs; v.type='retrace/marker'; v.ignorable=true`
 *        —— 即**遮蔽语义在中和时已被移除**,只留 `editor{targetSeq,text}` 等残骸)
 *  - ⇒ **两类**都是"痕迹/残骸",**都不承载遮蔽语义** ⇒ **同法翻译**(不验 targetShadowed、
 *    不存在"功能回退"风险;工程判据修订见开发日志)。
 *  - 官方 v0→v1 边**拒绝一切未知历史类型**(即使 `ignorable: true`)
 *    (`@deepseek-ai/dsh-session-format-v0-to-v1/lib/index.js` —
 *     `format v0 contains unknown historical event type … even when ignorable`)
 *    ⇒ 含这些类型的会话**永久不可迁移**。
 *  - 裁定:**不删除**(保功能痕迹)⇒ 只能**翻译**,不能丢弃。
 *
 * 本模块做三件事(全部**原地**、可复跑):
 *  ① **保痕迹**:原类型 / 原 seq / 原 time / 原 `data`(逐成员,`turn:null`/`step:null`
 *     这类**空值**显式清洗掉并留 `droppedNullKeys` 记录)**一个不丢**;
 *  ② **合法**:改写成 `feedback/record` + `data.text`(承载选型与依据见
 *     `lib/marker-carrier.js` 的 TRACE 区块 —— 官方词表恰一个自由文本成员、
 *     非 surface-eligible ⇒ 不投影、不被 token-meter 消费、不伪造任何 id/坐标);
 *  ③ **幂等**:seq / time / **行数一律不动**(只改 `type` 与 `data`),重跑找不到
 *     非法类型即零改动(且已翻译的痕迹被 `isTraceEvent` 认出、不会二次包裹)。
 *
 * ⚠️ 本模块**只做文本级就地改写**,不做压缩/落盘策略:调用方(CLI / 外部调用者)负责
 *    副本、sha256、备份。生产文件一律只读。
 */
import {
  LEGACY_TRACE_TYPES,
  TRACE_EVENT_TYPE,
  encodeTraceText,
  isTraceEvent,
} from './marker-carrier.js'

/** 历史非法类型 → 痕迹 kind。 */
const KIND_OF_LEGACY = Object.freeze({
  'retrace/goal-marker': 'goal-marker',
  'retrace/marker': 'marker',
})

/**
 * 视为**空值**、必须清洗掉的旧载荷键(`null` = 当时就没有 step 上下文,
 * 与「缺键」同义;写进新形态只会让读端误以为有 turn/step 语义)。
 */
const NULL_MEANINGLESS_KEYS = Object.freeze(['turn', 'step'])

/** 该类型是否是本模块负责翻译的历史非法类型。 */
export function isLegacyTraceType(type) {
  return LEGACY_TRACE_TYPES.includes(type)
}

/**
 * 单个历史事件 → 痕迹事件(**纯函数**;非目标类型返回 null)。
 *
 * 形状:信封只保留 `type`/`seq`/`time`,`data` 恰一个 `text` 成员 —— 官方
 * `feedback/record` 的冻结词表就是这一条(`disposition(["text"])`,无 optional/opaque),
 * 多一个成员即被官方 payload 校验器拒绝。原先的 `ignorable` **一并去掉**:承载类型
 * 已是官方已知类型,"未知类型才需要 ignorable" 的前提消失(去留都不影响合法性,
 * 去掉可减少语义噪音)。
 *
 * @param {object} event - 原始历史事件
 * @returns {{event:object, kind:string, droppedNullKeys:string[]}|null}
 */
export function traceEventFor(event) {
  const kind = KIND_OF_LEGACY[event?.type]
  if (kind === undefined) return null
  const seq = Number.isSafeInteger(event.seq) ? event.seq : null
  const time = Number.isSafeInteger(event.time) ? event.time : 0
  const originalData = (event.data && typeof event.data === 'object' && !Array.isArray(event.data))
    ? { ...event.data }
    : {}
  const droppedNullKeys = []
  for (const key of NULL_MEANINGLESS_KEYS) {
    if (Object.hasOwn(originalData, key) && originalData[key] === null) {
      delete originalData[key]
      droppedNullKeys.push(key)
    }
  }
  const text = encodeTraceText({
    v: 1,
    kind,
    originalType: event.type,
    originalSeq: seq,
    originalTime: time,
    originalOperation: originalData.originalOperation,
    targetSeq: originalData.editor?.targetSeq,
    messageId: originalData.message?.id,
    text: originalData.editor?.text,
    // 逐成员留痕:清洗后的原 data 整体保留(未知成员也不丢)。
    originalData,
    droppedNullKeys: droppedNullKeys.length > 0 ? droppedNullKeys : undefined,
  })
  return {
    kind,
    droppedNullKeys,
    event: { type: TRACE_EVENT_TYPE, seq, time, data: { text } },
  }
}

/**
 * 整份 JSONL 文本的迁移前翻译(**纯函数**,行数不变)。
 *
 * 逐行:可解析且 `type` 属历史非法类型 → 就地改写成痕迹事件;其余行**原样保留**
 * (含无法解析的行——不静默丢弃任何字节)。已翻译过的痕迹行被识别并计入
 * `alreadyTranslated`,故重复跑是幂等的。
 *
 * @param {string} text - 含 header 行的完整 JSONL 文本
 * @returns {{text:string, changed:number, events:object[], alreadyTranslated:number, unparsable:number}}
 */
export function translateLegacyTraces(text) {
  const lines = String(text).split('\n')
  const events = []
  let changed = 0
  let alreadyTranslated = 0
  let unparsable = 0
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    if (raw.trim() === '') continue
    let parsed
    try { parsed = JSON.parse(raw) } catch { unparsable++; continue }
    if (isTraceEvent(parsed)) { alreadyTranslated++; continue }
    const traced = traceEventFor(parsed)
    if (traced === null) continue
    lines[i] = JSON.stringify(traced.event)
    changed++
    events.push({
      line: i,
      seq: parsed.seq,
      time: parsed.time,
      from: parsed.type,
      to: traced.event.type,
      kind: traced.kind,
      droppedNullKeys: traced.droppedNullKeys,
    })
  }
  return { text: lines.join('\n'), changed, events, alreadyTranslated, unparsable }
}
