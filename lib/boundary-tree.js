/**
 * dsh-retrace — lib/boundary-tree.js
 *
 * The read-point outline forest: "which change landed inside which discarded
 * set". Derived from our own boundary artifact (one record per boundary, each
 * carrying `discardedSeqs` — the exact surface nodes that operation removed),
 * so the client can indent nested branches without touching the projection wire.
 *
 * RULE (frozen 2026-09-14, corrected by measurement; DO NOT change back to set
 * inclusion):
 *   parent(C) = the boundary B whose discarded set CONTAINS C's own event seq,
 *   `C.seq ∈ S(B)`, choosing the SMALLEST such |S(B)|.
 *
 * Why NOT `S(C) ⊆ S(B)` (the rule first written into the contract): measured on
 * a real 24k-event session, the child's discarded nodes were **already dead**
 * when the parent replaced its range (the child ran FIRST), so
 * `|S(child) ∩ S(parent)| = 0` for every one of the 8 links of the real 9-layer
 * chain. The parent's set only holds the child's MARKER event seq — that node was
 * still on the surface at that moment. Inclusion therefore yields a degenerate
 * forest (1 parent / depth 1) instead of 14 parents / depth 9. Membership is
 * still an EXACT SET operation: no numeric interval is ever enumerated, and no
 * `start ≤ end` ordering is assumed — a reversed range (`[16093..15458]`, real
 * data) never enters this module.
 *
 * The discarded sets may be STORED SLIMMED (`S ∩ allBoundarySeqs`, see
 * lib/versioning.js) because membership only ever asks about another boundary's
 * seq; `discardedCount` then carries the exact `|S|`. Both forms must yield a
 * byte-identical tree (pinned by a test).
 *
 * Zero imports (pure): the host, the route and the tests all share one rule.
 */

/** Parse one record's discarded seqs into a Set (invalid entries dropped). */
function discardedSetOf(record) {
  const raw = record?.discardedSeqs
  if (!Array.isArray(raw)) return null
  const set = new Set()
  for (const seq of raw) if (Number.isSafeInteger(seq) && seq >= 0) set.add(seq)
  return set
}

/** Exact `|S|`: the stored `discardedCount` when present, else the set's size. */
function discardedCountOf(record, set) {
  return Number.isSafeInteger(record?.discardedCount) && record.discardedCount >= 0 ? record.discardedCount : set.size
}

/** Distance used to break equal-size parent candidates (nearest ancestor wins). */
function tieBreak(childSeq, a, b) {
  const da = Math.abs(a.seq - childSeq)
  const db = Math.abs(b.seq - childSeq)
  if (da !== db) return da - db
  return a.seq - b.seq
}

/**
 * Build the outline forest from artifact records.
 *
 * @param {object[]} records - artifact lines ({ boundarySeq, discardedSeqs, ... })
 * @returns {{
 *   tree: Record<string, {parent:number|null, children:number[], discardedCount:number}>,
 *   maxDepth: number,
 *   withChildren: number,
 *   nodes: number
 * } | null} null when no record carries a usable `discardedSeqs`
 *   (old artifacts, or a session that never recorded one) — the caller then
 *   OMITS the field and the client falls back to a flat list.
 */
export function boundaryTreeOf(records) {
  if (!Array.isArray(records)) return null
  // Latest record wins per boundary (the artifact is append-only).
  const latest = new Map()
  for (const record of records) {
    if (!Number.isSafeInteger(record?.boundarySeq)) continue
    latest.set(record.boundarySeq, record)
  }
  const entries = []
  for (const [seq, record] of latest) {
    const set = discardedSetOf(record)
    if (set === null) continue
    entries.push({ seq, set, count: discardedCountOf(record, set) })
  }
  if (entries.length === 0) return null

  const childrenBySeq = new Map(entries.map((entry) => [entry.seq, []]))
  const parentBySeq = new Map()
  for (const child of entries) {
    let best = null
    for (const candidate of entries) {
      if (candidate.seq === child.seq) continue
      if (!candidate.set.has(child.seq)) continue
      // Smallest containing set = the direct parent; an intermediate D would be
      // smaller and would have won. Equal sizes fall back to the nearest seq.
      if (best === null || candidate.count < best.count || (candidate.count === best.count && tieBreak(child.seq, candidate, best) < 0)) {
        best = candidate
      }
    }
    parentBySeq.set(child.seq, best === null ? null : best.seq)
    if (best !== null) childrenBySeq.get(best.seq).push(child.seq)
  }

  const tree = {}
  for (const entry of entries) {
    tree[String(entry.seq)] = {
      parent: parentBySeq.get(entry.seq) ?? null,
      children: (childrenBySeq.get(entry.seq) ?? []).slice().sort((a, b) => a - b),
      discardedCount: entry.count,
    }
  }

  const depthMemo = new Map()
  const depthOf = (seq) => {
    if (depthMemo.has(seq)) return depthMemo.get(seq)
    depthMemo.set(seq, 0) // cycle guard (a parent always has a larger discarded set)
    const kids = childrenBySeq.get(seq) ?? []
    const depth = kids.length === 0 ? 0 : 1 + Math.max(...kids.map(depthOf))
    depthMemo.set(seq, depth)
    return depth
  }
  let maxDepth = 0
  let withChildren = 0
  for (const entry of entries) {
    maxDepth = Math.max(maxDepth, depthOf(entry.seq))
    if ((childrenBySeq.get(entry.seq) ?? []).length > 0) withChildren += 1
  }
  return { tree, maxDepth, withChildren, nodes: entries.length }
}
