/**
 * dsh-retrace — lib/recall-index.js
 *
 * 「撤回/替换区间」的**只读索引**(纯函数,零平台依赖)——把一份全量会话事件
 * 解析成「哪次撤回/替换遮蔽了哪些原文 seq」的清单,并回答两个查询:
 *   · 这条消息(seq)被哪次撤回遮蔽了 —— `recallOf(index, seq)`;
 *   · 被遮蔽的原文 seq 是哪些、原文在哪 —— `interval.targetSeqs` + 原文仍在日志
 *     的同一批 seq 上(append-only 日志:遮蔽只影响投影面,原文一个字节都不动)。
 *
 * 读 = 零写:本模块只做内存解析,没有 fs/网络/会话写入面;由 host-core 的
 * `recallIndex` op 组装(读事件来自注入的读文件链,见 lib/adapter/dsh.js 的
 * readEvents),读路径全程零写入。
 *
 * 区间条目形状(一条 = 一次 replace 遮蔽):
 *   {
 *     recallSeq,        // 遮蔽载体事件的 seq
 *     markerId,         // 载体 data.id(外部来源的 replace 事件可能为 '')
 *     op,               // op 段('recall'/'edit'/'regenerate'/'fold'…;外部来源 '')
 *     kind,             // 'marker' 本插件两段载体 | 'legacy' 旧形态 | 'external' 他人写的 replace
 *     at,               // 事件时间戳(event.time;拿不到为 null)
 *     shadowedRange,    // {start,end} 载体 surfaceOp 区间
 *     targetSeqs,       // 被遮蔽原文 seq(读法与 marker-carrier 同一取值口径)
 *     targetSeqsKnown,  // targetSeqs 是否取到了完整清单(顶层数组被剥时为 false)
 *     sourceEventSeqs,  // 载体顶层 provenance 原样(无则 [])
 *     auditSeq,         // 配对审计段 seq(无则 null)
 *   }
 *
 * 单一真相纪律:被遮蔽集合的取值(`carrierShadowedSeqs`)、区间端点(`spanRangeOf`)、
 * 载体识别(`isCarrierMarkerEvent`)全部复用 lib/marker-carrier.js,本模块不另写一份。
 */
import { MARKER_ID_PREFIXES, carrierShadowedSeqs, isCarrierMarkerEvent, isLegacyMarkerEvent, pairedAuditOf, spanRangeOf } from './marker-carrier.js'

/**
 * marker id 的 op 段(原始取值,不认识的段原样返回)。
 *
 * 与 lib/host-core.js 的 `markerOpOfMarkerId` 刻意不同:那边是**词表校验**(未知
 * op 段返回 '' 以便拒认),这边是**事实读取**(未来新增 op 段的 marker 也要能被
 * 如实列出,读端宽进)。id 形状 = `<前缀>-<op 段>-<time36>-<rand>`,前缀取自
 * marker-carrier 的同一张前缀表。
 * @returns {string} '' = 不是本插件 marker id
 */
export function markerIdOpSegment(id) {
  if (typeof id !== 'string' || id.length === 0) return ''
  for (const prefix of MARKER_ID_PREFIXES) {
    if (!id.startsWith(`${prefix}-`)) continue
    const rest = id.slice(prefix.length + 1)
    const cut = rest.indexOf('-')
    return cut === -1 ? rest : rest.slice(0, cut)
  }
  return ''
}

/** 事件里可读的文本(user/assistant/tool/command 各自的文本落点;其余为 '')。 */
export function eventReadableText(event) {
  const data = event?.data
  if (!data || typeof data !== 'object') return ''
  const collect = (content) => {
    if (!Array.isArray(content)) return []
    const out = []
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) out.push(block.text)
      if (Array.isArray(block.content)) out.push(...collect(block.content))
    }
    return out
  }
  if (event.type === 'user/message') return collect(data.content).join('\n')
  if (event.type === 'assistant/message') return collect(data.message?.content).join('\n')
  if (event.type === 'tool/result') return collect(data.message?.content).join('\n')
  if (event.type === 'command/run') {
    const args = typeof data.args === 'string' ? data.args.trim() : ''
    if (args !== '') return args
    return typeof data.name === 'string' && data.name !== '' ? `/${data.name}` : ''
  }
  return ''
}

/** 事件角色标签(回收副本的人读前缀)。 */
function eventRoleLabel(event) {
  if (event?.type === 'user/message') return 'user'
  if (event?.type === 'assistant/message') return 'assistant'
  if (event?.type === 'tool/result') return 'tool'
  if (event?.type === 'command/run') return 'command'
  return String(event?.type ?? 'unknown')
}

/**
 * 一条 replace 区间条目(见文件头形状);非 replace 事件返回 null。
 * @param {object} event
 * @param {(seq:number)=>object|undefined} [eventAt] - 顶层数组被剥时的审计配对读取器
 */
export function recallIntervalOf(event, eventAt) {
  const legacy = isLegacyMarkerEvent(event)
  const range = spanRangeOf(event?.surfaceOp)
  if (!range && !legacy) return null
  const markerId = String(event?.data?.id ?? event?.data?.message?.id ?? '')
  const opFromData = typeof event?.data?.op === 'string' ? event.data.op : ''
  const seqs = carrierShadowedSeqs(event, eventAt)
  let targetSeqs = seqs
  let known = seqs.length > 0
  if (!known && legacy) {
    const legacyTarget = event?.data?.editor?.targetSeq
    if (Number.isSafeInteger(legacyTarget)) {
      targetSeqs = [legacyTarget]
      known = true
    }
  }
  const paired = typeof eventAt === 'function' ? pairedAuditOf(event, eventAt) : null
  return {
    recallSeq: Number.isSafeInteger(event?.seq) ? event.seq : -1,
    markerId,
    op: opFromData !== '' ? opFromData : markerIdOpSegment(markerId),
    kind: isCarrierMarkerEvent(event) ? 'marker' : (legacy ? 'legacy' : 'external'),
    at: Number.isSafeInteger(event?.time) ? event.time : null,
    shadowedRange: range,
    targetSeqs: targetSeqs.slice(),
    targetSeqsKnown: known,
    sourceEventSeqs: Array.isArray(event?.sourceEventSeqs)
      ? event.sourceEventSeqs.filter((s) => Number.isSafeInteger(s))
      : [],
    auditSeq: Number.isSafeInteger(paired?.seq) ? paired.seq : null,
  }
}

/**
 * 全量事件 → 区间清单(按 recallSeq 升序)。
 * @param {Array<object>} events
 * @param {{ops?: string[]}} [opts] - 按 op 段过滤(如 ['recall'])
 */
export function recallIntervalsFromEvents(events, opts = {}) {
  const out = []
  if (!Array.isArray(events)) return out
  const bySeq = new Map()
  for (const event of events) {
    if (event && Number.isSafeInteger(event.seq)) bySeq.set(event.seq, event)
  }
  const eventAt = (seq) => bySeq.get(seq)
  const filter = Array.isArray(opts?.ops) && opts.ops.length > 0 ? new Set(opts.ops) : null
  for (const event of events) {
    const entry = recallIntervalOf(event, eventAt)
    if (!entry) continue
    if (filter && !filter.has(entry.op)) continue
    out.push(entry)
  }
  out.sort((a, b) => a.recallSeq - b.recallSeq)
  return out
}

/**
 * 建索引(可选 sessionId 随索引携带,便于按会话归档/查询)。
 * @param {Array<object>} events - 全量事件(读文件链给出的事件表)
 * @param {{sessionId?: string}} [opts]
 * @returns {{sessionId:string, intervals:Array, shadowedSeqs:number[], bySeq:Map<number, Array>}}
 */
export function buildRecallIndex(events, opts = {}) {
  const intervals = recallIntervalsFromEvents(events, opts)
  const bySeq = new Map()
  const union = new Set()
  for (const entry of intervals) {
    for (const seq of entry.targetSeqs) {
      union.add(seq)
      const list = bySeq.get(seq) ?? []
      list.push(entry)
      bySeq.set(seq, list)
    }
  }
  return {
    sessionId: typeof opts?.sessionId === 'string' ? opts.sessionId : '',
    intervals,
    shadowedSeqs: [...union].sort((a, b) => a - b),
    bySeq,
  }
}

/** 区间是否遮蔽了该 seq(清单命中,或区间范围内兜底)。 */
export function intervalCoversSeq(entry, seq) {
  if (!entry || !Number.isSafeInteger(seq)) return false
  if (entry.targetSeqs.includes(seq)) return true
  const range = entry.shadowedRange
  return Boolean(range) && seq >= range.start && seq <= range.end
}

/** 遮蔽该 seq 的全部区间(新→旧;未被遮蔽 ⇒ [])。 */
export function recallsOf(index, seq) {
  const out = []
  if (!index || !Number.isSafeInteger(seq)) return out
  for (const entry of index.intervals) {
    if (intervalCoversSeq(entry, seq)) out.push(entry)
  }
  out.reverse()
  return out
}

/** 遮蔽该 seq 的**最近一次**区间(未被遮蔽 ⇒ null)。 */
export function recallOf(index, seq) {
  return recallsOf(index, seq)[0] ?? null
}

/** 该 seq 是否被撤回/替换遮蔽。 */
export function isRecalled(index, seq) {
  return recallOf(index, seq) !== null
}

/**
 * 按 marker 定位区间:markerSeq(载体 seq)优先,否则 markerId(载体 data.id)。
 * @returns {object|null}
 */
export function intervalForMarker(index, { markerSeq, markerId } = {}) {
  if (!index) return null
  const wantSeq = Number(markerSeq)
  const wantId = typeof markerId === 'string' ? markerId : ''
  for (const entry of index.intervals) {
    if (Number.isSafeInteger(wantSeq) && wantSeq >= 0 && entry.recallSeq === wantSeq) return entry
    if (wantId !== '' && entry.markerId === wantId) return entry
  }
  return null
}

/** 回收副本的人读开头(一行说明:这是新增副本,不动正本)。 */
export function reclaimCopyHeader(entry) {
  const seqs = entry.targetSeqs.length > 0 ? entry.targetSeqs.join(',') : `区间 ${entry.shadowedRange?.start}..${entry.shadowedRange?.end}`
  return `（原文回收副本 · 仅追加,不改动日志既有行）撤回/替换标记 seq=${entry.recallSeq}${entry.markerId !== '' ? ` id=${entry.markerId}` : ''} 遮蔽的原文 seq=${seqs};原文仍在日志同一批 seq 上,以下为逐条可读副本:`
}

/**
 * 区间被遮蔽原文的可读副本文本(逐条 ` [seq=N · role] text`)。
 * 读不到文本的事件给一行占位(不静默丢:回收的价值就是"原文在哪"说清楚)。
 * @param {Array<object>} events - 全量事件
 * @param {object} entry - `recallIntervalOf` 的区间条目
 */
export function reclaimCopyText(events, entry) {
  if (!entry) return ''
  const bySeq = new Map()
  for (const event of events ?? []) {
    if (event && Number.isSafeInteger(event.seq)) bySeq.set(event.seq, event)
  }
  const seqs = entry.targetSeqs.length > 0 ? entry.targetSeqs : []
  const lines = [reclaimCopyHeader(entry)]
  for (const seq of seqs) {
    const event = bySeq.get(seq)
    const text = event ? eventReadableText(event) : ''
    lines.push(text !== ''
      ? ` [seq=${seq} · ${eventRoleLabel(event)}] ${text}`
      : ` [seq=${seq} · ${event ? eventRoleLabel(event) : 'missing'}] (无可读文本)`)
  }
  return lines.join('\n')
}
