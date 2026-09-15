/**
 * dsh-retrace — lib/boundary-now.js
 *
 * READ-SIDE "现在这条" (the counterpart that lives in the conversation TODAY).
 *
 * Why this exists (real-machine reading order, 2026-09-15): an entry could say
 * WHAT it replaced ("原来的内容：…") but never WHERE it was replaced FROM. The
 * user's words: 「这个条目，现在是什么我并不知道」. The anchor is the message the
 * action left behind — for an edit/resend it is OUR own `retrace-resend-*` node
 * (measured: boundary #8699 → #8706), for a regenerate it is the assistant reply
 * the host produced afterwards.
 *
 * What this module deliberately does NOT do: reconstruct the round's input. The
 * conversation itself is readable — only the REPLACED copy is ours to keep.
 *
 * Rules (measured on a 27k-event / 34-boundary session):
 *  - only `edit` / `regenerate` have a counterpart. A pure `recall` retracts and
 *    is followed by later, unrelated input — picking that would be a lie.
 *  - the counterpart must be a LIVE node: anything a later boundary already
 *    replaced (`shadowedSeqs`) is excluded, otherwise the entry would point at
 *    a message that is no longer on the surface.
 *  - the boundary's OWN carrier / audit events are never the counterpart: they
 *    are the marker, not the new content.
 *
 * Pure (no I/O, no host access): the caller passes the log array and the shadowed
 * set, so the seam, the HTTP route and the tests all drive the same rule.
 */
import { eventText, excerpt, roleOf } from './boundary-what.js'
import { isReplacementSurfaceEvent, replacedSeqsOfBoundary } from './version-index.js'

/** Our own resend node: written by the edit/resend op. */
export const RESEND_ID_PREFIX = 'retrace-resend-'

/** Any id we write (marker / carrier / resend / fold) — never a counterpart. */
const OUR_ID_PREFIX = 'retrace-'

/** `<id>` of a surface event, whichever slot the host used. */
function idOf(event) {
  const id = event?.data?.id ?? event?.data?.message?.id
  return typeof id === 'string' ? id : ''
}

/** One counterpart candidate as the reader needs it (no raw seq shown). */
function nowOf(event) {
  return {
    seq: event.seq,
    role: roleOf(event),
    excerpt: excerpt(eventText(event)),
  }
}

/**
 * Index the log once: the counterpart candidates, in ascending seq order.
 *
 * @param {object[]} events - the session's events (ascending seq)
 * @param {Set<number>} [shadowedSeqs] - seqs replaced by SOME boundary (ours or
 *   the host's). Those are off the surface and cannot be "现在这条".
 * @returns {{resends: object[], replies: object[]}}
 */
export function buildNowIndex(events, shadowedSeqs = new Set()) {
  const list = Array.isArray(events) ? events : []
  const shadowed = shadowedSeqs instanceof Set ? shadowedSeqs : new Set()
  const resends = []
  const replies = []
  for (const event of list) {
    const seq = event?.seq
    if (!Number.isSafeInteger(seq) || shadowed.has(seq)) continue
    const id = idOf(event)
    if (id.startsWith(RESEND_ID_PREFIX)) {
      resends.push(nowOf(event))
      continue
    }
    // A regenerate's counterpart is the host's new assistant reply. Our own
    // `retrace-*` nodes are markers, never the reply itself.
    if (event.type === 'assistant/message' && !id.startsWith(OUR_ID_PREFIX)) replies.push(nowOf(event))
  }
  resends.sort((a, b) => a.seq - b.seq)
  replies.sort((a, b) => a.seq - b.seq)
  return { resends, replies }
}

/**
 * The counterpart of ONE boundary, or null when there is honestly none.
 *
 * @param {string} kind - `classifyBoundaryKind` result (`edit` / `regenerate` /
 *   `recall` / `compaction` / `replace`)
 * @param {number} boundarySeq
 * @param {{resends: object[], replies: object[]}} index - from `buildNowIndex`
 * @returns {{seq:number, role:string, excerpt:string}|null}
 */
export function nowOfBoundary(kind, boundarySeq, index) {
  if (kind !== 'edit' && kind !== 'regenerate') return null
  if (!Number.isSafeInteger(boundarySeq) || index === null || index === undefined) return null
  const candidates = kind === 'edit' ? index.resends : index.replies
  if (!Array.isArray(candidates)) return null
  for (const candidate of candidates) {
    if (Number.isSafeInteger(candidate?.seq) && candidate.seq > boundarySeq) return candidate
  }
  return null
}

/**
 * Every seq that some SURFACE REPLACEMENT took off the surface (ours AND the
 * host's). Used to keep a counterpart from pointing at a message that is no
 * longer live.
 *
 * Scope = THIS PLUGIN's own replacements (`retrace-*` markers). Two things stay
 * out, both measured on the real session:
 *
 *  - ordinary events that merely CITE their precursors (`tool/result` → its
 *    `tool/call`). Counting those marked 14644 seqs "shadowed" instead of 107.
 *  - other surface owners' bulk operations (another plugin's fold ranges, the
 *    host's compaction checkpoints). They hide ranges from the VIEW/CONTEXT
 *    while the messages stay in the log. Counting them made every one of the 23
 *    real edits report "the counterpart is no longer in the log", including the
 *    case this reading order was specified from: boundary #8699 → the resend
 *    node #8706.
 *
 * Our own later replacement is different: the marker stands in that node's place
 * for good, so that node can never be "现在这条" again.
 *
 * @param {object[]} events
 * @param {(event:object)=>boolean} [isOurs] - id predicate for this plugin's
 *   markers (defaults to the `retrace-` prefix).
 * @returns {Set<number>}
 */
export function shadowedSeqsOf(events, isOurs = null) {
  const owns = typeof isOurs === 'function' ? isOurs : (event) => idOf(event).startsWith(OUR_ID_PREFIX)
  const shadowed = new Set()
  if (!Array.isArray(events)) return shadowed
  for (const event of events) {
    if (!isReplacementSurfaceEvent(event)) continue
    if (!owns(event)) continue
    for (const seq of replacedSeqsOfBoundary(event, null)) {
      if (Number.isSafeInteger(seq)) shadowed.add(seq)
    }
  }
  return shadowed
}
