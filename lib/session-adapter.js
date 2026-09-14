/**
 * dsh-retrace — lib/session-adapter.js
 *
 * DSH 会话适配器 —— 把 DSH 事件日志翻译成业务层(message-list.js)的输入。
 *
 * 职责(适配器模式):
 * - 日志层(DSH session.jsonl)客观记录一切事件;
 * - 本适配器负责**翻译**:session 事件 → `messages`(全量消息)+ `shadows`(遮蔽区间);
 * - 业务层(message-list.js)只消费翻译结果,不 import DSH 任何东西。
 *
 * 翻译规则:
 * - messages:遍历会话事件视图,提取 user/message 与 assistant/message
 *   (带文本内容)为 `{ seq, role, turn, text, source }`(时间序);
 *   **源(source)一并透传**——业务层的轮边界谓词按 `source.kind` 判
 *   (轮边界只认 kind==='user'),不透传就只能回落 `role==='user'`,
 *   载体的 kind:'model' 会被误当成真实用户输入而污染轮边界(实测官方不拦这个错);
 * - 遮蔽载体:两种形态都认 —— 新形态(两段结构的第 2 段:`user/message` + replace +
 *   我方 marker id,识别的单一真相在 lib/marker-carrier.js)与旧形态
 *   (`assistant/message` + `data.editor`,历史日志里仍在);两者都取其被遮蔽 seq 集合;
 * - 输出:`projectSession(session)` → `{ messages, shadows, projection }`,
 *   projection 即 message-list.projectMessageList 的结果。
 *
 * 用途:守卫/渲染/体检的业务侧验证——不再依赖 `session.surface.nodes`
 * (DSH 2.0.3 窗口化,坑过占比守卫三次)。
 */
import { projectMessageList, activeMessages, activeTurnCount } from './message-list.js'
import { isCarrierMarkerEvent, isLegacyMarkerEvent, carrierShadowedSeqs } from './marker-carrier.js'
import { sessionEvents } from './host-compat.js'

/** 从 DSH 会话提取全量消息(业务形态)。遮蔽载体(两段结构/旧 marker)跳过。 */
export function extractMessages(session) {
  if (!session) return []
  const events = sessionEvents(session)
  const out = []
  for (const event of events) {
    if (!event || typeof event.seq !== 'number') continue
    if (event.type === 'user/message') {
      // 遮蔽载体的第 2 段(两段结构)= user/message 但 source.kind:'model' ⇒ 不是消息
      if (isCarrierMarkerEvent(event)) continue
      const text = extractText(event.data?.content)
      out.push({ seq: event.seq, role: 'user', turn: event.data?.turn, text, source: event.data?.source })
    } else if (event.type === 'assistant/message') {
      // 旧形态 retrace marker(assistant/message + data.editor)→ 不是消息,跳过
      if (isLegacyMarkerEvent(event)) continue
      const text = extractText(event.data?.message?.content)
      out.push({ seq: event.seq, role: 'assistant', turn: event.data?.turn, text, source: event.data?.message?.source })
    }
  }
  return out
}

/** 提取文本块内容。 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('')
}

/**
 * 从 DSH 会话提取遮蔽区间(载体记录的精确被遮蔽 seq 集合,时间序)。
 * 两种载体形态都认(新 = 两段结构第 2 段;旧 = assistant/message + data.editor);
 * 取值口径 = lib/marker-carrier.js 的 carrierShadowedSeqs(去掉审计 seq 的连续段)。
 */
export function extractShadows(session) {
  if (!session) return []
  const events = sessionEvents(session)
  const bySeq = new Map()
  for (const event of events) {
    if (event && typeof event.seq === 'number') bySeq.set(event.seq, event)
  }
  const shadows = []
  for (const event of events) {
    if (!event) continue
    if (!isCarrierMarkerEvent(event) && !isLegacyMarkerEvent(event)) continue
    const seqs = carrierShadowedSeqs(event, (seq) => bySeq.get(seq))
    if (seqs.length === 0) continue
    // 精确 seq 集合(sourceEventSeqs 原样,不用 min/max 区间——
    // 区间会误伤中间未遮蔽消息(官方 foldSurface 只遮蔽 surface 节点))
    shadows.push({ seqs, markerSeq: event.seq })
  }
  return shadows
}

/**
 * 项目化一个 DSH 会话:翻译 + 投影一步到位。
 * @returns {{ messages:Array, shadows:Array, projection:Array, active:Array, turnCount:number }}
 */
export function projectSession(session) {
  const messages = extractMessages(session)
  const shadows = extractShadows(session)
  const projection = projectMessageList(messages, shadows)
  return {
    messages,
    shadows,
    projection,
    active: activeMessages(messages, shadows),
    turnCount: activeTurnCount(messages, shadows),
  }
}
