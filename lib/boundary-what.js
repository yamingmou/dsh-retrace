/**
 * dsh-retrace — lib/boundary-what.js
 *
 * The boundary digest — "what did this boundary change?" (the data gap behind the
 * unreadable version/fork rows: the projection wire carried only `{seq, type}` /
 * `{kind, replacedSeqs}`).
 *
 * It is built at OPERATION TIME, where the log is still readable: the caller
 * passes the replaced span events it already resolved to write the marker, this
 * module turns them into a small `what` payload, and the payload is stored in the
 * plugin's own artifact (`lib/summary-store.js`) — NOT in the host session log
 * (a plugin-owned event type without the `ignorable` marker makes the host
 * persistence reader refuse the whole log) and NOT in the projection wire or the
 * durable checkpoint (that tax is paid on every append; measured +70.8%/+93.7%).
 *
 * Frozen shape (2026-09-14):
 *   {
 *     op,                                  // recall|edit|regenerate|restore|compaction|replace
 *     at?,                                 // boundary time (epoch ms) when known
 *     new:      { excerpt },               // the action's own NEW text, verbatim
 *     replaced: [ { seq, role, excerpt, summary? } ],   // ≤ REPLACED_MAX
 *     replacedMore?,                       // count beyond the listed entries
 *     artifacts?: { created, modified, deleted }        // counts only
 *   }
 *
 * Only the OLD content is summarized (the new content is still in the
 * conversation — summarizing it would be parroting). `excerpt` and `summary` are
 * SEPARATE fields: `excerpt` is verbatim capped log text, `summary` is filled by
 * the optional LLM half (lib/llm-summary.js) and may be absent.
 *
 * Zero imports (pure) so every realm (host, dynamic sandbox, browser) can use it.
 */

/**
 * Excerpt cap in characters (before the appended ellipsis).
 *
 * 60 fits one timeline/fork row on the target UI width without wrapping and keeps
 * a full boundary payload (`replaced` × 3) around ~250 bytes. The long-form text
 * stays reachable through the snapshot / event readers. Truncation appends `…` so
 * a clipped excerpt is obvious. Note: UTF-16 code units are sliced, so a
 * surrogate pair at the boundary can be split — acceptable for a display hint.
 */
export const EXCERPT_MAX = 60

/** How many replaced entries travel per boundary; the rest become `replacedMore`. */
export const REPLACED_MAX = 3

/** Message-source roles the payload reports. */
const ROLE_BY_TYPE = Object.freeze({
  'user/message': 'user',
  'assistant/message': 'assistant',
  'tool/result': 'tool',
})

/** Collapse whitespace so an excerpt is always a single line (verbatim otherwise). */
function flatten(text) {
  return typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
}

/** Join an event's text blocks (verbatim characters, no rewriting). */
function textBlocks(content) {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') out += (out ? ' ' : '') + block.text
  }
  return out
}

/** The role reported for one surface event (`unknown` when unrecognised). */
export function roleOf(event) {
  return ROLE_BY_TYPE[event?.type] ?? 'unknown'
}

/**
 * The verbatim text carried by one event:
 *   user/message      → `data.content`
 *   assistant/message → `data.message.content`, else `data.content`
 *   tool/result       → `data.message.content`, else the tool name
 * Returns '' when the event carries no text (image-only prompt, bare tool row…).
 * @param {object} event
 * @returns {string}
 */
export function eventText(event) {
  const type = event?.type
  const data = event?.data
  if (!data || typeof data !== 'object') return ''
  if (type === 'user/message') return textBlocks(data.content)
  if (type === 'assistant/message') return textBlocks(data.message?.content) || textBlocks(data.content)
  if (type === 'tool/result') return textBlocks(data.message?.content) || textBlocks(data.content) || (typeof data.name === 'string' ? data.name : '')
  return ''
}

/**
 * Truncate one string to the payload cap. `null`/undefined → ''. Whitespace is
 * flattened first, so the result is always a single line.
 * @param {unknown} text
 * @returns {string}
 */
export function excerpt(text) {
  const flat = flatten(text)
  return flat.length > EXCERPT_MAX ? `${flat.slice(0, EXCERPT_MAX)}…` : flat
}

/**
 * Assemble the boundary `what` payload from the replaced span.
 *
 * @param {object} input
 * @param {string} input.op - boundary kind
 * @param {number} [input.at] - boundary time (epoch ms)
 * @param {object[]} [input.spanEvents] - the replaced surface events, surface order
 * @param {number[]} [input.replacedSeqs] - explicit seq list (citation fallback);
 *   defaults to the span's own seqs
 * @param {string} [input.newText] - the action's own new text (verbatim; capped)
 * @param {{created:number, modified:number, deleted:number}} [input.artifacts]
 */
export function makeWhat({ op, at, spanEvents = [], replacedSeqs = null, newText = '', artifacts = null }) {
  const events = Array.isArray(spanEvents) ? spanEvents.filter((event) => event && typeof event.seq === 'number') : []
  const bySeq = new Map(events.map((event) => [event.seq, event]))
  const seqs = Array.isArray(replacedSeqs) ? replacedSeqs : events.map((event) => event.seq)
  const listed = seqs.slice(0, REPLACED_MAX).map((seq) => {
    const event = bySeq.get(seq)
    return {
      seq,
      role: event === undefined ? 'unknown' : roleOf(event),
      excerpt: event === undefined ? '' : excerpt(eventText(event)),
    }
  })
  const what = { op: String(op) }
  if (Number.isSafeInteger(at) && at > 0) what.at = at
  what.new = { excerpt: excerpt(newText) }
  what.replaced = listed
  // Only present when something was cut off (the field is optional; omitting the
  // zero keeps ~18 bytes off every payload).
  if (seqs.length > listed.length) what.replacedMore = seqs.length - listed.length
  if (artifacts && (artifacts.created > 0 || artifacts.modified > 0 || artifacts.deleted > 0)) {
    what.artifacts = { created: artifacts.created, modified: artifacts.modified, deleted: artifacts.deleted }
  }
  return what
}
