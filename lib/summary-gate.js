/**
 * dsh-retrace — lib/summary-gate.js
 *
 * The deterministic gate in front of the (optional, asynchronous) LLM summary:
 * "did this operation really throw away a large chunk of content?" Only when all
 * four rules pass does the caller spend one LLM call.
 *
 * Rules (frozen by the user, 2026-09-14 — quotes are the user's wording):
 *   R1 量        「被丢弃文本总量 ≥ 100 字」 — below that the 60-char `excerpt`
 *                  already carries the信息, so a summary is only a paraphrase.
 *   R2 有过程/结果「被丢弃范围里至少含一条实质输出」 — an `assistant/message`
 *                  with text, or a `tool/result`; user-only spans are dropped.
 *   R3 产出过内容 「刚启动就停／暂停／中断／报错且无文本产出」 — an abort/error
 *                  round with no assistant text is not worth summarizing.
 *   R4 非占位     「占位 空白 短指令不要」 — recall placeholders, blank or
 *                  punctuation-only text, and spans whose every message is
 *                  shorter than 20 chars ("12", "继续").
 *
 * The gate is PURE and runs at operation time, where the caller still has the log
 * (the projection fold cannot do this: it sees one event at a time and keeps only
 * 60-char digests). The only import is the shared verbatim text reader, so the
 * gate stays testable in isolation and reusable from the measurement harness.
 */
import { eventText } from './boundary-what.js'

/** R1 threshold in characters (user-set; replaced the earlier 200). */
export const SUMMARY_CHAR_THRESHOLD = 100

/** R4: a span whose every message is shorter than this is a short instruction. */
export const SHORT_MESSAGE_CHARS = 20

/** Per-message input cap for the LLM call (user-set). */
export const INPUT_ITEM_CHARS = 400

/** At most this many messages travel into ONE call (user-set). */
export const INPUT_ITEM_MAX = 6

/** Text that is one of our own withdrawal placeholders, or has no content at all. */
const PLACEHOLDER_PATTERNS = [
  /此处内容已被撤回/,
  /原消息已归档/,
  /内容已被删除/,
  /^\s*$/,
  /^[\s\p{P}\p{S}]+$/u,
]

/** Abort / error wording that marks a round which produced nothing. */
const INTERRUPT_PATTERN = /interrupt|abort|cancel|error|failed|stopped/i

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Collapse whitespace (the same normalisation `excerpt()` uses). */
function flatten(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

/** Whether one text contains no substantive content (placeholder / blank / punctuation). */
export function isPlaceholderText(text) {
  const flat = flatten(text)
  if (flat === '') return true
  return PLACEHOLDER_PATTERNS.some((re) => re.test(flat))
}

/** One span message: its role, raw length and whether it carries content. */
function readMessage(event) {
  const text = flatten(eventText(event))
  const substantive = !isPlaceholderText(text)
  return { seq: event?.seq, type: event?.type, len: text.length, text, substantive }
}

/**
 * Decide whether one replacement span deserves a single summary call.
 *
 * @param {Array<object>} spanEvents - the replaced surface events, in surface
 *   order, each optionally carrying `_gateText` (the verbatim text the caller
 *   extracted with its own log reader).
 * @returns {{
 *   needs: boolean,
 *   rule: null|'R1'|'R2'|'R3'|'R4',
 *   stats: {messages:number, chars:number, rawChars:number, hasAssistantText:boolean,
 *           hasToolResult:boolean, allShort:boolean, contentless:boolean,
 *           interrupted:boolean, inputItems:number, inputChars:number}
 * }}
 */
export function needsSummary(spanEvents) {
  const events = (Array.isArray(spanEvents) ? spanEvents : []).filter((event) => SURFACE_TYPES.has(event?.type))
  const messages = events.map(readMessage)
  const substantive = messages.filter((message) => message.substantive)
  const chars = substantive.reduce((n, message) => n + message.len, 0)
  const rawChars = messages.reduce((n, message) => n + message.len, 0)
  const hasAssistantText = substantive.some((message) => message.type === 'assistant/message')
  const hasToolResult = events.some((event) => event.type === 'tool/result')
  const allShort = messages.length > 0 && messages.every((message) => message.len < SHORT_MESSAGE_CHARS)
  const contentless = substantive.length === 0

  // R3 — a round that stopped/aborted/errored without producing assistant text.
  // Reachable only when R2 passed, i.e. the span does have a tool/result but no
  // assistant text: an empty assistant message ("only reasoning, no output"), a
  // failed tool result, or an explicit interrupt marker on the turn/step edge.
  const emptyAssistantMessage = events.some(
    (event) => event.type === 'assistant/message' && flatten(eventText(event)) === '',
  )
  const erroredToolResult = events.some((event) => event.type === 'tool/result' && Boolean(event?.data?.error))
  const interruptEdge = events.some(
    (event) =>
      (event.type === 'turn/end' || event.type === 'step/end') &&
      INTERRUPT_PATTERN.test(JSON.stringify(event?.data ?? {}).slice(0, 400)),
  )
  const interrupted = !hasAssistantText && (emptyAssistantMessage || erroredToolResult || interruptEdge)

  // The capped input this call WOULD send (≤6 items × 400 chars).
  const items = substantive.slice(0, INPUT_ITEM_MAX).map((message) => ({
    seq: message.seq,
    role: message.type === 'user/message' ? 'user' : message.type === 'assistant/message' ? 'assistant' : 'tool',
    text: message.text.slice(0, INPUT_ITEM_CHARS),
  }))
  const inputChars = items.reduce((n, item) => n + item.text.length, 0)

  const stats = {
    messages: messages.length,
    chars,
    rawChars,
    hasAssistantText,
    hasToolResult,
    allShort,
    contentless,
    interrupted,
    inputItems: items.length,
    inputChars,
  }

  // The four conditions AND together; the REPORTED rule is the most specific one
  // that blocked (structural quality before raw quantity), so the measurement
  // table explains *why* instead of always saying "too short".
  let rule = null
  if (!hasAssistantText && !hasToolResult) rule = 'R2'
  else if (interrupted) rule = 'R3'
  else if (contentless || allShort) rule = 'R4'
  else if (chars < SUMMARY_CHAR_THRESHOLD) rule = 'R1'

  return { needs: rule === null, rule, stats }
}

/**
 * The capped prompt payload for one summarise call (only the replaced span).
 * @param {Array<object>} spanEvents
 * @returns {Array<{seq:number, role:string, text:string}>}
 */
export function summaryInputOf(spanEvents) {
  const events = (Array.isArray(spanEvents) ? spanEvents : []).filter((event) => SURFACE_TYPES.has(event?.type))
  return events
    .map(readMessage)
    .filter((message) => message.substantive)
    .slice(0, INPUT_ITEM_MAX)
    .map((message) => ({
      seq: message.seq,
      role: message.type === 'user/message' ? 'user' : message.type === 'assistant/message' ? 'assistant' : 'tool',
      text: message.text.slice(0, INPUT_ITEM_CHARS),
    }))
}
