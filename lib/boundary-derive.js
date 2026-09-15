/**
 * dsh-retrace — lib/boundary-derive.js
 *
 * READ-SIDE derivation of the boundary digest ("what did this boundary throw
 * away?") for boundaries that have NO stored artifact record.
 *
 * Why this exists (real-machine finding 2026-09-15): the digest artifact
 * (`<pluginDataHome()>/dsh-retrace/summaries/<sessionId>.jsonl`) is written at
 * OPERATION time and only started shipping with the summary feature, so every
 * boundary that predates it has no record — the read point then rendered one
 * bare line (`替换 / 9-1 16:30 / 当时共 2241 条消息`) with no content at all.
 * The discarded ORIGINALS are still in the session log, so the digest can be
 * recomputed on read.
 *
 * Authority order: a STORED record always wins. The stored digest was built at
 * operation time, when the replaced window was still on the surface; once
 * compaction removes those events, the log can no longer reproduce it. This
 * module is the fallback, never an override.
 *
 * Pure (no imports beyond two pure siblings, no I/O): the caller passes an
 * `eventAt(seq)` accessor, so the host seam, the HTTP route and the tests all
 * drive the same rule and a test can hand it a plain Map.
 */
import { makeWhat } from './boundary-what.js'
import { classifyBoundaryKind, replacedSeqsOfBoundary } from './version-index.js'

/**
 * Derive one digest record per version that has no stored artifact line.
 *
 * @param {object} input
 * @param {Array<{boundarySeq:number, versionId?:string}>} input.versions - the
 *   boundaries to derive for (normally "our" boundaries only; a host-side
 *   replacement is skipped even if it is passed in).
 * @param {(seq:number)=>object|undefined} input.eventAt - one event by exact seq.
 * @param {Set<number>} [input.boundarySeqs] - the boundary seqs used to SLIM
 *   `discardedSeqs` (same convention as the write side: membership only ever
 *   asks about another boundary's seq, `discardedCount` keeps the exact |S|).
 *   Defaults to the passed `versions`.
 * @returns {object[]} derived artifact-shaped records (`derived: true`)
 */
/** 这一档属于哪一轮（人读）：载体事件 → 被替换段里第一个带 turn 的事件 → null。 */
export function turnOfBoundary(event, spanEvents = []) {
  // 实测：撤回/编辑/重发的"载体"事件常常不带 `data.turn`，被它替换掉的那一段才
  // 带 ⇒ 先看载体，再在被替换段里取第一个可用 turn。都取不到就 null（调用方整段
  // 省略，不编造"第 ? 轮"）。
  const usable = (value) => (Number.isSafeInteger(value) && value > 0 ? value : null)
  const own = usable(event?.data?.turn) ?? usable(event?.turn)
  if (own !== null) return own
  for (const spanEvent of spanEvents) {
    const found = usable(spanEvent?.data?.turn) ?? usable(spanEvent?.turn)
    if (found !== null) return found
  }
  return null
}

export function deriveBoundaryRecords({ versions, eventAt, boundarySeqs = null } = {}) {
  const list = Array.isArray(versions) ? versions : []
  if (typeof eventAt !== 'function') return []
  const boundarySet = boundarySeqs instanceof Set
    ? boundarySeqs
    : new Set(list.map((version) => version?.boundarySeq).filter((seq) => Number.isSafeInteger(seq)))
  const out = []
  for (const version of list) {
    const boundarySeq = version?.boundarySeq
    if (!Number.isSafeInteger(boundarySeq)) continue
    const event = eventAt(boundarySeq)
    if (event === undefined || event === null) continue
    const kind = classifyBoundaryKind(event)
    // Host-origin surface replacement (a tool result re-rendered by the host):
    // never a read point of ours, so never given a digest.
    if (kind === 'replace') continue
    // The EXACT removed set: the carrier's own citation minus its audit guide
    // item (never a numeric window — see lib/boundary-tree.js).
    const removed = replacedSeqsOfBoundary(event, null)
    const spanEvents = removed.map((seq) => eventAt(seq)).filter((spanEvent) => spanEvent !== undefined)
    // 轮次：载体自身常不带 turn（实测），被替换的那一段才带 ⇒ 用它的 turn 告诉
    // 用户"这一轮的输入"是哪一轮；都取不到就省略（不编造）。
    const turn = turnOfBoundary(event, spanEvents)
    const what = makeWhat({
      op: kind,
      at: event.time,
      spanEvents,
      // The EXACT seq list is passed explicitly: when compaction already ate the
      // originals, `makeWhat` still lists them (role `unknown`, empty excerpt) and
      // reports `replacedMore`, so the row keeps saying "丢弃了 N 条消息" instead
      // of collapsing to a content-free line.
      replacedSeqs: removed,
      // The action's own NEW text is NOT reconstructible here: the carrier keeps
      // only the archive notice (measured: every carrier's second segment reads
      // "（此处内容已被撤回…）"), and the live continuation is a different node.
      // Leaving it empty keeps the client from printing a misleading 延续 line.
      newText: '',
    })
    out.push({
      boundarySeq,
      turn,
      versionId: typeof version.versionId === 'string' ? version.versionId : `v${boundarySeq}`,
      kind,
      at: typeof event.time === 'number' ? event.time : undefined,
      what,
      discardedSeqs: removed.filter((seq) => boundarySet.has(seq)),
      discardedCount: removed.length,
      derived: true,
    })
  }
  return out
}
