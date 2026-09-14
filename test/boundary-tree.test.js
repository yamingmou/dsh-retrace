/**
 * dsh-retrace — outline forest tests (lib/boundary-tree.js, frozen 2026-09-14).
 *
 * Pins the corrected rule and the two traps that motivated it:
 *   - the parent relation is EXACT SET MEMBERSHIP (`child.seq ∈ S(parent)`),
 *     because on real data `S(child) ∩ S(parent) = ∅` (the child's nodes died
 *     before the parent ran) — set inclusion would collapse the forest to
 *     depth 1;
 *   - never an interval/range test, and never an assumption that a span's
 *     endpoints ascend;
 *   - missing data degrades by OMITTING the forest, not by faking one.
 */
import { describe, it, expect } from 'vitest'
import { boundaryTreeOf } from '../lib/boundary-tree.js'

const rec = (boundarySeq, discardedSeqs, extra = {}) => ({ boundarySeq, discardedSeqs, ...extra })

describe('boundaryTreeOf — parent/children/discardedCount', () => {
  it('links a child whose OWN event seq is in the parent丢弃 set, even when the sets are disjoint', () => {
    // Real shape: 24104 (compaction) removed 421 nodes, among them the marker
    // event 22216; 22216's own removed nodes were already dead by then.
    const forest = boundaryTreeOf([rec(24104, [1, 2, 3, 22216]), rec(22216, [7, 8])])
    expect(forest).not.toBeNull()
    expect(forest.tree['22216']).toEqual({ parent: 24104, children: [], discardedCount: 2 })
    expect(forest.tree['24104']).toEqual({ parent: null, children: [22216], discardedCount: 4 })
    expect(forest.maxDepth).toBe(1)
    expect(forest.withChildren).toBe(1)
    expect(forest.nodes).toBe(2)
  })

  it('does NOT use interval coverage: a seq inside [min..max] but not in the set is not a child', () => {
    // 15 sits numerically between 10 and 20 but was never removed by 100.
    const forest = boundaryTreeOf([rec(100, [10, 20]), rec(15, [40])])
    expect(forest.tree['15'].parent).toBeNull()
    expect(forest.tree['100'].children).toEqual([])
  })

  it('picks the SMALLEST containing set as the direct parent (no skipped levels)', () => {
    const forest = boundaryTreeOf([
      rec(100, [1, 2, 3]), // outer
      rec(3, [1, 2]), // child of 100 (3 ∈ S(100)), smaller set
      rec(1, []), // 1 ∈ S(100) AND 1 ∈ S(3) ⇒ parent is the smaller container
    ])
    expect(forest.tree['3'].parent).toBe(100)
    expect(forest.tree['1'].parent).toBe(3)
    expect(forest.tree['100'].children).toEqual([3])
    expect(forest.tree['3'].children).toEqual([1])
    expect(forest.maxDepth).toBe(2)
  })

  it('is unaffected by a REVERSED span (endpoints never enter this module)', () => {
    // Real 17595 wrote `{startSeq: 16093, endSeq: 15458}`; the set is what counts.
    const forest = boundaryTreeOf([rec(17595, [16093, 16105, 16099]), rec(16093, [15458, 15456])])
    expect(forest.tree['17595'].discardedCount).toBe(3)
    expect(forest.tree['16093']).toEqual({ parent: 17595, children: [], discardedCount: 2 })
  })

  it('sorts children ascending and keeps every boundary as a node (roots included)', () => {
    const forest = boundaryTreeOf([rec(10, [1, 9, 5]), rec(9, []), rec(5, []), rec(1, [])])
    expect(forest.tree['10'].children).toEqual([1, 5, 9])
    expect(Object.keys(forest.tree).sort()).toEqual(['1', '10', '5', '9'])
    expect(forest.tree['1'].parent).toBe(10)
  })

  it('latest record wins per boundary (append-only artifact)', () => {
    const forest = boundaryTreeOf([rec(10, [1]), rec(10, [1, 2, 3])])
    expect(forest.tree['10'].discardedCount).toBe(3)
    expect(forest.nodes).toBe(1)
  })

  it('drops malformed entries instead of throwing', () => {
    const forest = boundaryTreeOf([
      rec(10, [1, null, -2, 2.5, 3, 'x']),
      rec(11, 'not-an-array'),
      { boundarySeq: 'nope', discardedSeqs: [1] },
      null,
    ])
    expect(forest.tree['10'].discardedCount).toBe(2) // only 1 and 3 survive
    expect(Object.hasOwn(forest.tree, '11')).toBe(false)
    expect(forest.nodes).toBe(1)
  })

  it('does not mutate the input records', () => {
    const records = [rec(10, [1, 2]), rec(2, [])]
    const snapshot = JSON.parse(JSON.stringify(records))
    boundaryTreeOf(records)
    expect(records).toEqual(snapshot)
  })
})

describe('boundaryTreeOf — degradation', () => {
  it('returns null when no record carries a usable discarded set', () => {
    expect(boundaryTreeOf([])).toBeNull()
    expect(boundaryTreeOf([{ boundarySeq: 1, called: true, summary: 'x' }])).toBeNull()
    expect(boundaryTreeOf(null)).toBeNull()
    expect(boundaryTreeOf(undefined)).toBeNull()
  })

  it('builds from the records that DO carry a set (mixed artifacts)', () => {
    const forest = boundaryTreeOf([{ boundarySeq: 1, called: true }, rec(2, [1])])
    expect(Object.keys(forest.tree)).toEqual(['2'])
    expect(forest.tree['2'].parent).toBeNull()
  })

  it('accepts an empty removed set as a real node with discardedCount 0', () => {
    const forest = boundaryTreeOf([rec(5, [])])
    expect(forest.tree['5']).toEqual({ parent: null, children: [], discardedCount: 0 })
  })
})

describe('boundaryTreeOf — slimmed sets + exact counts', () => {
  it('uses the stored discardedCount (exact) when the seq list is slimmed', () => {
    const forest = boundaryTreeOf([
      { boundarySeq: 100, discardedSeqs: [3], discardedCount: 1089 },
      { boundarySeq: 3, discardedSeqs: [], discardedCount: 321 },
    ])
    expect(forest.tree['100'].discardedCount).toBe(1089)
    expect(forest.tree['3'].discardedCount).toBe(321)
    expect(forest.tree['3'].parent).toBe(100)
  })

  it('produces a BYTE-IDENTICAL tree from full and slimmed sets', () => {
    // Full sets: parent removed many nodes incl. the child's own seq; the child
    // removed nodes that the parent never saw (already dead).
    const full = [
      { boundarySeq: 24104, discardedSeqs: [1, 2, 3, 22216, 9001, 9002] },
      { boundarySeq: 22216, discardedSeqs: [7, 8, 9003] },
      { boundarySeq: 7, discardedSeqs: [9] },
    ]
    // Slimmed: keep only seqs that are themselves boundaries (7 is one; 9003/9001 are not).
    const slim = [
      { boundarySeq: 24104, discardedSeqs: [22216], discardedCount: 6 },
      { boundarySeq: 22216, discardedSeqs: [7], discardedCount: 3 },
      { boundarySeq: 7, discardedSeqs: [], discardedCount: 1 },
    ]
    expect(JSON.stringify(boundaryTreeOf(slim).tree)).toBe(JSON.stringify(boundaryTreeOf(full).tree))
  })
})
