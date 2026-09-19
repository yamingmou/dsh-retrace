/**
 * dsh-retrace — lib/marker-carrier.js
 *
 * 「遮蔽载体」= 两段结构 —— **读端与写端共用的唯一形状真相**(零 import,纯函数)。
 *
 * 为什么载体改成两段(依据两段载体设计阶段 1.1,官方源码到行):
 * - `assistant/message` 作载体结构性出局:官方 v3 树不接受它带 provenance
 *   (`dsh-session/lib/index.js` —— assistant/message embeds its source stream),
 *   v1→v2 迁移边又无条件剥掉它的 `sourceEventSeqs` ⇒ 今天的遮蔽能力是 v0 独有;
 * - `user/message` 是四种 surface-eligible 类型里唯一能做「任意多节点区间替换」的
 *   (`tool/result` 限单节点,`system/message` v0 无此类型/须匹配打开中 step);
 * - 官方自己就是两段:`dsh-compaction-basic` 写 `compaction/summary`(log-only 审计)
 *   + `user/message`(真正替换);`dsh-compaction-tool-result-pruner` 同理。
 *
 * 形状(第 1 段先写,第 2 段后写——两者都引用更早 seq):
 *   第 1 段 `compaction/prune`(log-only,不投影):
 *     data = { shadowedRange:{start,end}, shadowedSeqs:[…], shadowedTokenCount:n }
 *     —— 官方词表把 data 定为**精确三成员**(无 optional/opaque)⇒ 多一个成员即被拒;
 *        且该类型非 surface-eligible ⇒ 带 surfaceOp/sourceEventSeqs 会在运行时抛错。
 *   第 2 段 `user/message`(真正遮蔽):
 *     data = { role, id, content, source }(官方词表同样精确四成员)
 *     surfaceOp = {op:'replace',start,end}(v0)/ {op:'replace',startSeq,endSeq}(v3)
 *     sourceEventSeqs = [<第 1 段 seq>, …全部被遮蔽节点]
 *     source.kind = 'model'(≠'user':见下)
 *
 * ⭐ 轮边界:轮边界谓词(`isRoundBoundaryEvent`)只认 `data.source.kind === 'user'`。
 * 载体若写 `kind:'user'` 就会被当成「真实用户输入」→ 切分交换轮 → round/tail 遮蔽
 * 段整体偏移(实测官方**不拦**,照样 load 且能力看着正常)。故载体一律 `kind:'model'`
 * (官方 `messageSourceValue` 对 `kind:'model'` 只要求 provider/model 非空串,与
 * message 角色无关 ⇒ 合法;v2→v3 的 SOURCE_KINDS 同样含 'model')。
 *
 * 关联读法(本文件即判据) —— **写侧 / 读侧分别如实**:
 *   写侧:`sourceEventSeqs = [<第 1 段 seq>, …全部被遮蔽节点]`(审计 seq 置首,权威);
 *   读侧:兼容**不含审计 seq 的历史形态** —— 该形态靠「审计段与载体段**紧邻**
 *         (审计.seq = 载体.seq − 1)且 `审计.shadowedRange === 载体的 surfaceOp 区间`」
 *         判定,**不可仅凭区间一致**:否则"审计段在、载体段在很远处或根本不存在"的
 *         真孤儿会被误判成成对 —— 容错反而掩盖要检出的缺陷(裁定 2026-09-14)。
 *         三选一判成对 = `isAuditPairedWithCarrier`(纯谓词)/ `pairedAuditOf`(带读取器)。
 * 被遮蔽节点 = 该数组里**从区间起点起**的连续段(有审计引导项时审计 seq 在区间之外,
 * 先于写入、数值上也更大)。旧形态(assistant/message + data.editor)的
 * `sourceEventSeqs` 本就以 `surfaceOp.start` 开头 ⇒ 切片结果 = 原数组。
 *
 * 纯模块:零 import、零平台依赖(动态插件 realm 可 inline,浏览器/Node 同构)。
 */

/**
 * 本插件 marker id 前缀清单(NEW markers 用第一个;其余是历史插件名,改名后仍须能识别)。
 *
 * ⚠️ 这里只导出**清单**、不导出单数常量:本模块与 host-core 会被 inline 进同一个
 * 动态插件作用域(generate-dynamic 逐个 strip import/export),而 host-core 已导出
 * `MARKER_ID_PREFIX`(公开面 ./host-core 的一部分)⇒ 同名再声明即 `Identifier …
 * has already been declared`。两份取值由单测钉住相等(test/marker-carrier.test.js)。
 */
export const MARKER_ID_PREFIXES = ['retrace', 'message-editor']

/** 第 1 段(审计载体,log-only)。 */
export const AUDIT_EVENT_TYPE = 'compaction/prune'
/** 第 1 段 data 的精确成员(官方词表,一个都不能多)。 */
export const AUDIT_DATA_KEYS = ['shadowedRange', 'shadowedSeqs', 'shadowedTokenCount']

/** 第 2 段(遮蔽载体,surface)。 */
export const CARRIER_EVENT_TYPE = 'user/message'
/** 第 2 段 data 的精确成员(官方词表,一个都不能多)。 */
export const CARRIER_DATA_KEYS = ['role', 'id', 'content', 'source']
/** 第 2 段的 source.kind(见文件头「轮边界」)。 */
export const CARRIER_SOURCE_KIND = 'model'

/**
 * 留痕文案(定稿形态,不带品牌前缀)——遮蔽在模型上下文里留一句人读说明:
 * 读者应理解为「撤回痕迹」,而非「用户发了空消息」。
 * 依据:实测 `content: []` 会投影成一条 `role:'user', len:0` 的空消息(误读为
 * 用户发了空消息);带说明文本则读者读到撤回痕迹。
 */
export const TRACE_TEXT = '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）'

/** 该 id 是否为本插件 marker id(当前或历史前缀)。 */
export function isMarkerId(id, prefixes = MARKER_ID_PREFIXES) {
  return typeof id === 'string' && prefixes.some((p) => id.startsWith(`${p}-`))
}

// ─────────────────────────────────────────────────────────────────────────────
// 迁移痕迹(TRACE)—— 历史**非法事件类型**的合法承载
//
// 问题:早期版本写过两种**不在官方 v0 冻结清单(51 条)**里的自造类型:
//   `retrace/goal-marker`(语义 =「目标曾被清空」的痕迹,data 只有 originalOperation)
//   `retrace/marker`(dsh-log-contract `--neutralize` 的产物:turn-null marker 被
//     原地中和成 `retrace/marker + ignorable`,残留 editor{targetSeq,text})
// 官方 v0→v1 边**拒绝一切未知历史类型**(`dsh-session-format-v0-to-v1/lib/index.js`
// 的 `assertReleasedArtifactCoordinates`:`unknown historical event type … migration
// refuses unknown historical events even when ignorable`)⇒ 含这些类型的会话**永久
// 不可迁移**。裁定:**不删除**(保功能痕迹)⇒ 迁移前置步骤把它们**翻译**
// 成官方合法、且我们读端认得的形态。
//
// 选定承载 = `feedback/record`,理由(逐条对官方词表,行号见下):
//  ① 在冻结清单里 ⇒ 迁移接受(`RELEASED_V0_EVENT_DISPOSITIONS["feedback/record"]
//     = disposition(["text"])`,即 data **恰一个** `text` 成员,无 optional/opaque);
//  ② **非** surface-eligible(`SURFACE_EVENT_TYPES` 只含 user/message、
//     assistant/message、tool/result)⇒ 信封不许 surfaceOp/sourceEventSeqs,
//     也不进 `deriveEventMessage` 的投影 ⇒ **不投影进模型上下文**、不需要伪造 turn/step;
//  ③ 官方 token-meter 只消费 assistant/message · assistant/attempt ·
//     compaction/summary · compaction/prune(`dsh-token-meter/lib/index.js:305,392,428`)
//     ⇒ **不被 token-meter 当 shadow-price claim 消费**;
//  ④ 它是官方词表里**唯一**「自由文本 + 零坐标 + 零状态机」的注解槽:不要求
//     turn/step/callId/goalId,不参与 goal/schedule/team/workflow 任何 fold ⇒ 承载痕迹
//     时**不伪造任何 id**、不改变任何官方状态。
// ⚠️ 已知代价(如实登记,不掩盖):`feedback/record` 在官方侧被 OTel 遥测当作「反馈」
//   信号(`dsh-session-telemetry-otel/lib/index.js:37-45` 的 `isFeedback`,只判 type
//   不看 payload)。但那条监听挂在 `session/event`(**运行期 append**)上,且带
//   `session.eventAt(seq) === event` 前置(同文件 `:165-171`)—— 离线翻译写进日志的
//   事件走**加载**路径,不经该监听;只有"运行期再追加一条痕迹"才会命中。故痕迹文案里
//   显式写明 `retrace-trace`,读端与人都不把它当真实用户反馈(判据见
//   `test/migration-traces.test.js` 的读端判定用例)。
//
// 形状(在线改写:seq/time/行数**一律不动**,只改 type 与 data):
//   { type:'feedback/record', seq, time, data:{ text: 'retrace-trace/v1 {…}' } }
// 文案前缀是**唯一识别判据**(前缀 + v1 + JSON);非本插件前缀的真实 feedback 一律不认。
// ─────────────────────────────────────────────────────────────────────────────

/** 痕迹事件的官方承载类型(见上:官方词表 data 恰一个自由文本成员)。 */
export const TRACE_EVENT_TYPE = 'feedback/record'
/** 痕迹文案前缀(唯一识别判据;无它即非本插件痕迹)。 */
export const TRACE_TEXT_PREFIX = 'retrace-trace/v1 '
/** 痕迹格式版本(前缀里已带 v1;这里是 JSON 内的同源字段,双写互证)。 */
export const TRACE_VERSION = 1
/** 已知痕迹种类:goal-marker(A 类)/ marker(B 类,中和产物)。 */
export const TRACE_KINDS = Object.freeze(['goal-marker', 'marker'])
/** A 类原类型 / B 类原类型(迁移翻译的输入,也是痕迹里的溯源字段)。 */
export const LEGACY_TRACE_TYPES = Object.freeze(['retrace/goal-marker', 'retrace/marker'])

/** 痕迹 JSON 的**固定成员顺序**(字节稳定:同一输入 → 同一输出,便于幂等比对)。 */
const TRACE_KEY_ORDER = Object.freeze(['v', 'kind', 'originalType', 'originalSeq', 'originalTime'])
/** 各类别的**类别专属成员**(顺序固定;全部为可丢失判定的纯数据)。 */
const TRACE_KIND_KEYS = Object.freeze({
  'goal-marker': Object.freeze(['originalOperation']),
  marker: Object.freeze(['targetSeq', 'messageId', 'text']),
})

/**
 * 痕迹 → 官方文本成员。成员顺序固定(字节稳定),`v` 与 kind 必须有值。
 * @param {{kind:string, originalType:string, originalSeq:number, originalTime:number}} trace
 * @returns {string}
 */
export function encodeTraceText(trace) {
  const out = { v: TRACE_VERSION }
  const written = new Set(['v'])
  const put = (key) => {
    if (written.has(key) || trace?.[key] === undefined) return
    out[key] = trace[key]
    written.add(key)
  }
  for (const key of TRACE_KEY_ORDER) put(key)
  for (const key of TRACE_KIND_KEYS[trace?.kind] ?? []) put(key)
  // 其余自有成员**原样带上**(未知/未来的痕迹字段不得静默丢弃;调用方按固定顺序
  // 构造入参 ⇒ 输出字节稳定,幂等比对可用)。
  for (const key of Object.keys(trace ?? {})) put(key)
  return TRACE_TEXT_PREFIX + JSON.stringify(out)
}

/**
 * 官方文本成员 → 痕迹载荷。**读端宽进**:前缀是唯一门(不认识的前缀 = 真实反馈),
 * 前缀之内只要 `v`/`kind` 成立就认(未知 kind 也认,免得未来的痕迹被误当真实反馈)。
 * @param {unknown} text - `data.text`
 * @returns {object|null} 解析失败时 null
 */
export function decodeTraceText(text) {
  if (typeof text !== 'string' || !text.startsWith(TRACE_TEXT_PREFIX)) return null
  let parsed
  try { parsed = JSON.parse(text.slice(TRACE_TEXT_PREFIX.length)) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (parsed.v !== TRACE_VERSION) return null
  if (typeof parsed.kind !== 'string' || parsed.kind.length === 0) return null
  return parsed
}

/** 痕迹事件判定(承载类型 + 文案前缀可解析;两者缺一不认)。 */
export function isTraceEvent(event) {
  return event?.type === TRACE_EVENT_TYPE && decodeTraceText(event?.data?.text) !== null
}

/** 痕迹事件的载荷(非痕迹 → null)。 */
export function tracePayloadOf(event) {
  return isTraceEvent(event) ? decodeTraceText(event.data.text) : null
}

/**
 * 痕迹事件的**人读**一句话(读端展示/排障用;不参与任何能力判据)。
 * @param {object} payload - `tracePayloadOf` 的结果
 * @returns {string} 无法描述时 ''
 */
export function traceSummary(payload) {
  if (!payload || typeof payload !== 'object') return ''
  const at = Number.isSafeInteger(payload.originalTime) ? new Date(payload.originalTime).toISOString() : '(时间未知)'
  if (payload.kind === 'goal-marker') return `目标曾被清空（${payload.originalOperation ?? '未知操作'}）@ ${at}`
  if (payload.kind === 'marker') return `旧载体 marker 痕迹（targetSeq=${payload.targetSeq ?? '?'}）@ ${at}`
  return `${payload.kind} 痕迹 @ ${at}`
}

/**
 * surfaceOp 的区间端点(双形状探测,读端宽进)。
 * v0 运行时 = `{op,start,end}`;v3 运行时 = `{op,startSeq,endSeq}`。
 * 两棵树都要求键数**精确为 3** 且键名精确 ⇒ 混写(同时带 start 与 startSeq)
 * 在这里一并被拒(返回 null),交由调用方按下标/形状自行判定。
 * @returns {{start:number, end:number}|null}
 */
export function spanRangeOf(surfaceOp) {
  if (!surfaceOp || typeof surfaceOp !== 'object' || Array.isArray(surfaceOp)) return null
  if (surfaceOp.op !== 'replace') return null
  const keys = Object.keys(surfaceOp)
  if (keys.length !== 3) return null
  const sorted = [...keys].sort().join(',')
  const v0 = sorted === 'end,op,start'
  const v3 = sorted === 'endSeq,op,startSeq'
  if (!v0 && !v3) return null
  const start = v0 ? surfaceOp.start : surfaceOp.startSeq
  const end = v0 ? surfaceOp.end : surfaceOp.endSeq
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null
  return { start, end }
}

/**
 * 第 2 段(遮蔽载体)判定:user/message + replace + 本插件 marker id。
 * 旧形态(assistant/message + `data.editor`)由 `isLegacyMarkerEvent` 单独判定
 * ——读端两种形态并存(历史日志里旧 marker 仍在,识别不得因改造而失效)。
 */
export function isCarrierMarkerEvent(event) {
  if (event?.type !== CARRIER_EVENT_TYPE) return false
  if (!spanRangeOf(event.surfaceOp)) return false
  return isMarkerId(event.data?.id)
}

/** 旧形态判定(2026-09 改造前的 marker:assistant/message + data.editor)。 */
export function isLegacyMarkerEvent(event) {
  return event?.type === 'assistant/message' && Boolean(event?.data?.editor)
}

/** 任一形态的遮蔽载体(读端入口)。 */
export function isShadowCarrierEvent(event) {
  return isCarrierMarkerEvent(event) || isLegacyMarkerEvent(event)
}

/**
 * 载体的遮蔽目标 seq(业务溯源)——旧形态读 `data.editor.targetSeq`,新形态由
 * `surfaceOp` 区间起点**派生**。
 *
 * 依据(147/147 全量实测):`data.editor.targetSeq` 与 `surfaceOp.start` 逐例相等
 * ⇒ 新形态该字段随 `editor` 一并去掉,读端按此派生(写端另有写前断言钉住相等)。
 * **旧形态仍以 `editor.targetSeq` 为准**(它是当时写入的业务意图;两值在实测中相等,
 * 但派生值只是区间起点,不是当时的意图本身)。
 * @returns {number} -1 = 无法派生
 */
export function carrierTargetSeq(event) {
  const legacy = event?.data?.editor?.targetSeq
  if (Number.isSafeInteger(legacy)) return legacy
  const range = spanRangeOf(event?.surfaceOp)
  return range ? range.start : -1
}

/**
 * 第 1 段(审计事件)的 seq —— 第 2 段 `sourceEventSeqs` 的首元素(无则 null)。
 *
 * ⚠️ 该定位**依赖顶层数组**:顶层被事件管道整条剥掉时它必然返回 null(见
 * `carrierShadowedSeqs` 的兜底链——那里不靠本函数也能取到被遮蔽段)。
 */
export function carrierAuditSeq(event) {
  const range = spanRangeOf(event?.surfaceOp)
  const seqs = Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs : null
  if (!range || !seqs || seqs.length === 0) return null
  if (seqs[0] === range.start) return null // 旧形态/无审计引用:首元素即区间起点
  return Number.isSafeInteger(seqs[0]) ? seqs[0] : null
}

/**
 * 客户端「审计上下文」的 kind —— 第 1 段审计事件的读端上下文(见本文件末尾的
 * `auditContextDefinition`)。
 */
export const AUDIT_CONTEXT_KIND = 'retrace-audit'

/** 第 1 段 data 的**识别**判据(只认形状,不抛;与 contract.js 的断言同词表)。 */
function isAuditData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const keys = Object.keys(data)
  if (keys.length !== AUDIT_DATA_KEYS.length) return false
  if (!AUDIT_DATA_KEYS.every((key) => Object.hasOwn(data, key))) return false
  const range = data.shadowedRange
  if (!range || typeof range !== 'object' || Array.isArray(range)) return false
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)) return false
  const seqs = data.shadowedSeqs
  return Array.isArray(seqs) && seqs.length > 0 && seqs.every((seq) => Number.isSafeInteger(seq))
}

/** 第 1 段事件(或它的 data)是否带本插件可识别的审计形状。 */
export function isAuditEvent(eventOrData) {
  const data = eventOrData && typeof eventOrData === 'object' && 'data' in eventOrData ? eventOrData.data : eventOrData
  return isAuditData(data)
}

/**
 * 从第 1 段审计记录取「被遮蔽 seq」——**校验后才采用**。
 *
 * 判据(缺一不采用,返回 []):① 审计记录的 `shadowedRange` 与载体区间逐值相等
 * (官方 shadow-price 协议本身就是按区间配对 claim;区间不等 = 不是本载体的审计段
 * —— 官方 `compaction-tool-result-pruner` 也写 `compaction/prune`,两侧同词表,
 * 因此**区间相等是区分「谁写的」的唯一判据**);② `shadowedSeqs` 非空且首尾 === 区间
 * 端点(官方语义约束:列全被遮蔽节点)。
 * @param {object} audit - 第 1 段事件,或它的 data(客户端读者只拿得到 data)
 * @param {object} event - 第 2 段载体(提供区间)
 * @returns {number[]} 不采用时 []
 */
export function shadowedSeqsOfAudit(audit, event) {
  const range = spanRangeOf(event?.surfaceOp)
  if (!range) return []
  const data = audit && typeof audit === 'object' && 'data' in audit ? audit.data : audit
  if (!isAuditData(data)) return []
  if (data.shadowedRange.start !== range.start || data.shadowedRange.end !== range.end) return []
  const seqs = data.shadowedSeqs.slice()
  if (seqs[0] !== range.start || seqs[seqs.length - 1] !== range.end) return []
  return seqs
}

/**
 * 读侧「审计段 ↔ 载体段」配对判定(单一真相;裁定 2026-09-14 §一)。
 *
 * **写侧规范(权威)**:`sourceEventSeqs[0] = 审计段 seq`。读侧为兼容历史形态采用
 * 三选一 —— 但**容错不得丢掉紧邻性**:
 *   ① `sourceEventSeqs[0] === 审计段.seq`(现行写侧形态);
 *   ② 审计段.seq **出现在** `sourceEventSeqs` 中(非首位;未来若有人放后面);
 *   ③ 历史形态(顶层数组只含区间节点、不含审计 seq,甚至整条被管道剥掉)⇒
 *      **审计段与载体段紧邻**(`载体.seq === 审计.seq + 1`)**且**
 *      `审计.shadowedRange === 载体 surfaceOp 区间`。
 *
 * ⚠️ 第 ③ 条**同时**要求紧邻 + 区间一致:只认区间一致会把"审计段在、载体段在很远处
 * 或根本不存在"的真孤儿误判为成对 —— 容错把要检出的缺陷掩盖掉,是唯一不可接受的
 * 结果。写侧 `assertPairing` **保持严格**(我们自己永远写审计首位,不该容忍自己的偏差)。
 *
 * @param {object} audit - 候选审计事件(`compaction/prune`)
 * @param {object} carrier - 候选载体事件(`user/message` + replace + 本插件 marker id)
 * @returns {{paired: boolean, via: 'ref-first'|'ref-anywhere'|'adjacent-range'|null}}
 */
export function isAuditPairedWithCarrier(audit, carrier) {
  if (!isAuditEvent(audit) || !isCarrierMarkerEvent(carrier)) return { paired: false, via: null }
  const auditSeq = Number.isSafeInteger(audit.seq) ? audit.seq : null
  const seqs = Array.isArray(carrier.sourceEventSeqs)
    ? carrier.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq))
    : []
  if (auditSeq !== null && seqs.length > 0 && seqs[0] === auditSeq) return { paired: true, via: 'ref-first' }
  if (auditSeq !== null && seqs.includes(auditSeq)) return { paired: true, via: 'ref-anywhere' }
  // ③ 历史形态:紧邻 + 区间一致(**两条都要**)
  const range = spanRangeOf(carrier.surfaceOp)
  if (auditSeq === null || !range || !Number.isSafeInteger(carrier.seq)) return { paired: false, via: null }
  if (carrier.seq !== auditSeq + 1) return { paired: false, via: null }
  const data = audit.data
  if (!isAuditData(data)) return { paired: false, via: null }
  if (data.shadowedRange.start !== range.start || data.shadowedRange.end !== range.end) return { paired: false, via: null }
  return { paired: true, via: 'adjacent-range' }
}

/**
 * 载体的配对审计段(读侧入口;带按 seq 取事件的读取器)。
 *
 * 候选顺序:先按 `sourceEventSeqs`(① 首位 / ② 任意位),再按**紧邻**(③)。
 * 每个候选都用 `isAuditPairedWithCarrier` 判定 —— 判定逻辑只有一份。
 * @param {object} carrier
 * @param {(seq:number)=>object|undefined} eventAt
 * @returns {{seq:number, event:object, via:string}|null}
 */
export function pairedAuditOf(carrier, eventAt) {
  if (typeof eventAt !== 'function') return null
  const seqs = Array.isArray(carrier?.sourceEventSeqs)
    ? carrier.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq))
    : []
  const adjacent = Number.isSafeInteger(carrier?.seq) ? carrier.seq - 1 : null
  const candidates = [...new Set([...seqs, ...(adjacent === null ? [] : [adjacent])])]
  for (const seq of candidates) {
    const audit = eventAt(seq)
    const verdict = isAuditPairedWithCarrier(audit, carrier)
    if (verdict.paired) return { seq, event: audit, via: verdict.via }
  }
  return null
}

/**
 * 审计段是否**被某个载体配对**(孤儿判定的唯一判据;裁定 §二末)。
 * 孤儿 = `!isAuditPairedWithSomeCarrier(audit, log)`。
 * @param {object} audit
 * @param {object[]} carriers - 日志里全部载体候选
 * @returns {{paired: boolean, via: string|null, carrierSeq: number|null}}
 */
export function isAuditPairedWithSomeCarrier(audit, carriers) {
  for (const carrier of carriers) {
    const verdict = isAuditPairedWithCarrier(audit, carrier)
    if (verdict.paired) return { paired: true, via: verdict.via, carrierSeq: Number.isSafeInteger(carrier.seq) ? carrier.seq : null }
  }
  return { paired: false, via: null, carrierSeq: null }
}

/**
 * 客户端侧的审计上下文定义(Cordis Conversation Definition)——**只参与取值,不建视图**
 * (无 target/buildViewNode ⇒ 不产生任何对话行;定义注册与匹配由 `register` 服务按
 * kind 收敛,读端用 `reader.previous(AUDIT_CONTEXT_KIND)` 取本载体之前那一条审计上下文)。
 *
 * 为什么客户端需要它:客户端只能按 kind 取**相邻上下文**,没有「按 seq 取任意事件」的
 * 接口 ⇒ 顶层 `sourceEventSeqs` 一旦被事件管道剥掉,载体自身再也拼不出被遮蔽集合
 * (0.4.12 的 `data.shadowedSeqs` 冗余已随官方词表收紧而取消)。
 */
export function auditContextDefinition() {
  return {
    kind: AUDIT_CONTEXT_KIND,
    match: (event) => (event?.type === AUDIT_EVENT_TYPE && isAuditData(event.data)
      ? { id: `audit:${Number(event.seq)}`, role: 'start' }
      : null),
    start: (_context, match) => match.event.data,
    update: (context) => context.state,
  }
}

/**
 * 载体的**被遮蔽 seq 列表**(单一取值口径)。
 *
 * 读法:从 `sourceEventSeqs` 里**区间起点**那一项起截(审计 seq 在区间之外);
 * 找不到区间起点(无 surfaceOp / 旧数据缺失)时原样返回,保持 0.4.x 的口径。
 *
 * 兜底链(顶层 provenance 被事件管道剥掉/截断时;取自 `pairedAuditOf` 的配对审计,
 * 再经 `shadowedSeqsOfAudit` 要求区间**端点吻合**,与官方语义约束同判据):
 *   ① 引用:审计 seq 在 `sourceEventSeqs` 首位 / 任意位 → `eventAt` 取该段;
 *   ② 相邻:审计段与本载体**紧邻**写盘(官方 shadow-price 协议要求两者紧邻)且区间一致;
 *   ③ 旧字段:本事件 `data.shadowedSeqs`(0.4.12 形态的冗余)。
 * ⚠️ 客户端没有 `eventAt`(只能按 kind 取相邻上下文)⇒ 那边走
 * `AUDIT_CONTEXT_KIND` 上下文 + `shadowedSeqsOfAudit`,同一判据。
 *
 * @param {object} event
 * @param {(seq:number)=>object|undefined} [eventAt] - 可选:按 seq 取事件。
 * @returns {number[]}
 */
export function carrierShadowedSeqs(event, eventAt) {
  const top = Array.isArray(event?.sourceEventSeqs)
    ? event.sourceEventSeqs.filter((s) => Number.isSafeInteger(s))
    : []
  const range = spanRangeOf(event?.surfaceOp)
  if (top.length > 0) {
    // 无区间(如外部 checkpoint 形态)→ 顶层数组即被遮蔽段,原样返回
    if (!range) return top
    // 官方 provenance 要求**列全被遮蔽节点**且区间起点是首节点 ⇒ 数组里必有区间起点;
    // 起点之前的部分是审计 seq 引导项。找不到起点 = 顶层数组不完整(事件管道被截断),
    // 落到下面的兜底路径,而不是把不完整的数组当成被遮蔽段。
    const at = top.indexOf(range.start)
    if (at >= 0 && top[top.length - 1] === range.end) return top.slice(at)
  }
  // 兜底路径(顶层被事件管道剥掉/截断时):若调用方给了事件读取器,
  // 取配对审计段(`pairedAuditOf`:① 首位引用 / ② 任意位引用 / ③ 紧邻+区间一致)
  // 的 `data.shadowedSeqs`(官方合法成员)——读侧配对判据只有一份。
  if (typeof eventAt === 'function') {
    const paired = pairedAuditOf(event, eventAt)
    if (paired) {
      const byPaired = shadowedSeqsOfAudit(paired.event, event)
      if (byPaired.length > 0) return byPaired
    }
  }
  const inner = event?.data?.shadowedSeqs
  return Array.isArray(inner) ? inner.filter((s) => Number.isSafeInteger(s)) : []
}

/** 载体的 content 文本(读端:留痕/说明文本 = 人读部分)。 */
export function carrierContentText(event) {
  const content = event?.data?.content
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/** 载体的派生文本字段(旧形态取 editor.text;新形态按需派生,此处给空,由读端决定)。 */
export function carrierLegacyText(event) {
  const text = event?.data?.editor?.text
  return typeof text === 'string' ? text : ''
}

/**
 * 本模块**只承载「载体形状」**:两段结构、被遮蔽集合、人读文本的**读取**。
 *
 * 「结构化业务元数据 → 人读文本」的序列化属**业务侧概念**(字段名与文案都是业务
 * 词表),不在通用层:它由宿主装配成**注入面**交给写入器(lib/adapter/dsh-writer.js
 * 的 `deriveContentText`)。通用层因此零业务词汇,也不需要"没有业务数据时恒空"的
 * 分支——注入面缺席 = 该宿主本就没有结构化业务数据。
 */
