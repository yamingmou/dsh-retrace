/**
 * dsh-retrace — lib/session-adapter.js
 *
 * DSH 会话适配器 —— 把 DSH 事件日志翻译成业务层(message-list.js)的输入。
 *
 * 职责(适配器模式,见 工程-生产级运行时/契约全景与业务层衔接-分析-20260901.md):
 * - 日志层(DSH session.jsonl)客观记录一切事件;
 * - 本适配器负责**翻译**:session 事件 → `messages`(全量消息)+ `shadows`(遮蔽区间);
 * - 业务层(message-list.js)只消费翻译结果,不 import DSH 任何东西。
 *
 * 翻译规则:
 * - messages:遍历 session.events,提取 user/message 与 assistant/message
 *   (带文本内容)为 `{ seq, role, turn, text }`(时间序);
 * - shadows:遍历 retrace marker(带 `data.editor` 的 assistant/message),
 *   取其 `sourceEventSeqs` 的 [min, max] 作为遮蔽区间(时间序);
 * - 输出:`projectSession(session)` → `{ messages, shadows, projection }`,
 *   projection 即 message-list.projectMessageList 的结果。
 *
 * 用途:守卫/渲染/体检的业务侧验证——不再依赖 `session.surface.nodes`
 * (DSH 2.0.3 窗口化,坑过占比守卫三次)。
 */
import { projectMessageList, activeMessages, activeTurnCount } from './message-list.js'

/** 从 DSH 会话提取全量消息(业务形态)。无文本的 assistant 消息(retrace marker)跳过。 */
export function extractMessages(session) {
  if (!session || !Array.isArray(session.events)) return []
  const out = []
  for (const event of session.events) {
    if (!event || typeof event.seq !== 'number') continue
    if (event.type === 'user/message') {
      const text = extractText(event.data?.content)
      out.push({ seq: event.seq, role: 'user', turn: event.data?.turn, text })
    } else if (event.type === 'assistant/message') {
      // retrace 编辑/撤回 marker(带 editor、空内容)→ 不是消息,跳过
      if (event.data?.editor) continue
      const text = extractText(event.data?.message?.content)
      out.push({ seq: event.seq, role: 'assistant', turn: event.data?.turn, text })
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

/** 从 DSH 会话提取遮蔽区间(retrace marker 的 sourceEventSeqs 范围,时间序)。 */
export function extractShadows(session) {
  if (!session || !Array.isArray(session.events)) return []
  const shadows = []
  for (const event of session.events) {
    if (!event || event.type !== 'assistant/message') continue
    if (!event.data?.editor) continue // 只认 retrace marker
    const seqs = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs.filter((s) => typeof s === 'number') : []
    if (seqs.length === 0) continue
    // 2026-09-01:精确 seq 集合(sourceEventSeqs 原样),不用 min/max 区间——
    // 区间会误伤中间未遮蔽消息(官方 foldSurface 只遮蔽 surface 节点)
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
