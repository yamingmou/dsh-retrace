/**
 * dsh-retrace — `retrace/forkmap` unit tests (P2.1).
 *
 * Drives the pure fold directly (same style as version-index.test.js) plus the
 * projection definition contract (key / stateSchema / init / apply / wire).
 */
import { describe, it, expect } from 'vitest'
import {
  applyForkmap,
  createForkmapState,
  viewForkmap,
} from '../lib/forkmap.js'
import { forkmapProjectionDefinition } from '../lib/projection/forkmap.js'

// ---------------------------------------------------------------------------
// Event factories (surface events with seq/surfaceOp; marker shape mirrors
// what lib/host-core.js appends).
// ---------------------------------------------------------------------------

/** A plain append surface event. */
function append(seq, type = 'user/message') {
  return { seq, type, surfaceOp: 'append' }
}

/** An assistant model reply. */
function reply(seq) {
  return append(seq, 'assistant/message')
}

/** A tool result row. */
function toolResult(seq) {
  return append(seq, 'tool/result')
}

/** A replacement event (our marker or another replace source). */
function replaceEvent(seq, start, end, extra = {}) {
  return {
    seq,
    type: 'assistant/message',
    surfaceOp: { op: 'replace', start, end },
    ...extra,
  }
}

/** Our marker event: empty assistant/message + editor payload + citations. */
function marker(seq, start, end, op, text = 'edited text') {
  return replaceEvent(seq, start, end, {
    sourceEventSeqs: [],
    data: {
      editor: { text },
      message: { id: `retrace-${op}-${seq}` },
    },
  })
}

/** A compaction checkpoint (user/message with the official compact source). */
function checkpoint(seq, start, end) {
  return {
    seq,
    type: 'user/message',
    surfaceOp: { op: 'replace', start, end },
    data: { source: { kind: 'plugin', plugin: 'compact' } },
  }
}

/** Fold a whole event log. */
function fold(events) {
  let state = createForkmapState()
  for (const event of events) state = applyForkmap(state, event)
  return state
}

describe('applyForkmap — surface fold', () => {
  it('appends surface nodes in order', () => {
    const state = fold([append(1), reply(2), toolResult(3), append(4)])
    expect(state.nodes.map((n) => n.seq)).toEqual([1, 2, 3, 4])
    expect(state.nodes.map((n) => n.type)).toEqual([
      'user/message',
      'assistant/message',
      'tool/result',
      'user/message',
    ])
    expect(state.boundaries).toEqual([])
  })

  it('returns the SAME state reference for events that change nothing', () => {
    const state = fold([append(1), reply(2)])
    const same = applyForkmap(state, { seq: 99, type: 'tool/call' }) // not surface-eligible
    expect(same).toBe(state)
    const same2 = applyForkmap(state, { type: 'assistant/message' }) // no seq
    expect(same2).toBe(state)
  })

  it('replaces a surface span with the marker node (seqs, not indices)', () => {
    // Official foldSurface splices the replacement AT the replaced range's
    // start position (dsh-session applySurfacePlan: splice(startIdx, n, seq)),
    // so the marker lands where the old round began: [5,3,4], not [3,4,5].
    const state = fold([append(1), reply(2), append(3), reply(4), marker(5, 1, 2, 'edit')])
    expect(state.nodes.map((n) => n.seq)).toEqual([5, 3, 4])
    expect(state.boundaries).toHaveLength(1)
    expect(state.boundaries[0]).toMatchObject({ seq: 5, kind: 'edit', replacedSeqs: [1, 2] })
  })

  it('ignores a replace span that is not live (already shadowed target)', () => {
    // seq1..2 replaced by 5; a later marker targeting 1..2 again is a no-op on
    // the surface (span not live; official fold would throw — we degrade to a
    // boundary without a surface move) but still closes a boundary.
    const state = fold([
      append(1), reply(2), append(3), reply(4),
      marker(5, 1, 2, 'edit'),
      marker(6, 1, 2, 'edit', 'second edit'),
    ])
    expect(state.nodes.map((n) => n.seq)).toEqual([5, 3, 4]) // marker 6 never entered the surface
    expect(state.boundaries[1]).toMatchObject({ seq: 6, kind: 'edit' })
    // splice found nothing, so replacedSeqs comes from the marker's citation.
    expect(state.boundaries[1].replacedSeqs).toEqual([])
  })

  it('falls back to sourceEventSeqs when the replaced span is not live', () => {
    const state = fold([
      append(1), reply(2), append(3), reply(4),
      marker(5, 1, 2, 'edit'),
      { ...replaceEvent(6, 7, 8, { sourceEventSeqs: [3, 4], data: { editor: { text: 'x' }, message: { id: 'retrace-edit-6' } } }) },
    ])
    expect(state.boundaries[1].replacedSeqs).toEqual([3, 4])
  })
})

describe('applyForkmap — boundary kinds', () => {
  it('classifies recall / regenerate / restore markers', () => {
    const mk = (op) => marker(10, 1, 1, op)
    expect(applyForkmap(fold([append(1), reply(2)]), mk('recall')).boundaries[0].kind).toBe('recall')
    expect(applyForkmap(fold([append(1), reply(2)]), mk('regenerate')).boundaries[0].kind).toBe('regenerate')
    expect(applyForkmap(fold([append(1), reply(2)]), mk('restore')).boundaries[0].kind).toBe('restore')
  })

  it('classifies compaction checkpoints', () => {
    const state = fold([append(1), reply(2), checkpoint(3, 1, 2)])
    expect(state.boundaries[0]).toMatchObject({ seq: 3, kind: 'compaction', replacedSeqs: [1, 2] })
  })

  it('classifies unknown replaces as replace', () => {
    const state = fold([append(1), reply(2), replaceEvent(3, 1, 2)])
    expect(state.boundaries[0]).toMatchObject({ seq: 3, kind: 'replace', replacedSeqs: [1, 2] })
  })

  it('records a chain of forks (recall → edit → restore) with full topology', () => {
    // splice-at-startIdx keeps surface order: the restore targets the LIVE
    // nodes in surface order ([8,7] — the edit marker sits before the reply
    // it replaced), which is exactly what host-core's rollback span looks like.
    const state = fold([
      append(1), reply(2), append(3), reply(4),
      marker(5, 1, 2, 'recall', 'round one recalled'),  // [1,2,3,4] → [5,3,4]
      append(6), reply(7),                               // → [5,3,4,6,7]
      marker(8, 3, 6, 'edit', 'reworded'),               // → [5,8,7]
      marker(9, 8, 7, 'restore', 'back to version v5'),  // → [5,9]
    ])
    expect(state.nodes.map((n) => n.seq)).toEqual([5, 9])
    expect(state.boundaries.map((b) => [b.kind, b.replacedSeqs])).toEqual([
      ['recall', [1, 2]],
      // surface after recall is [5,3,4,6,7]; the edit spans seqs 3..6, whose
      // surface slice is [3,4,6] — the recall marker (seq 5) sits before them.
      ['edit', [3, 4, 6]],
      ['restore', [8, 7]],
    ])
  })
})

describe('viewForkmap — wire value', () => {
  it('projects nodes and boundaries into the client shape', () => {
    const state = fold([append(1), reply(2), append(3), reply(4), marker(5, 1, 2, 'edit')])
    expect(viewForkmap(state)).toEqual({
      nodes: [
        { seq: 5, type: 'assistant/message' },
        { seq: 3, type: 'user/message' },
        { seq: 4, type: 'assistant/message' },
      ],
      boundaries: [{ seq: 5, kind: 'edit', replacedSeqs: [1, 2] }],
    })
  })
})

describe('forkmapProjectionDefinition — registry contract', () => {
  it('carries the key, stateSchema, init, apply and wire', () => {
    expect(forkmapProjectionDefinition.key).toBe('retrace/forkmap')
    expect(forkmapProjectionDefinition.stateSchema).toBeDefined()
    expect(forkmapProjectionDefinition.init).toBeTypeOf('function')
    expect(forkmapProjectionDefinition.apply).toBeTypeOf('function')
    expect(forkmapProjectionDefinition.wire?.viewSchema).toBeDefined()
    expect(forkmapProjectionDefinition.wire?.view).toBeTypeOf('function')
    expect(forkmapProjectionDefinition.stateVersion).toBe(1)
    // top-level aliases for direct-drive unit tests
    expect(forkmapProjectionDefinition.schema).toBe(forkmapProjectionDefinition.wire.viewSchema)
    expect(forkmapProjectionDefinition.view).toBe(forkmapProjectionDefinition.wire.view)
  })

  it('init state passes the stateSchema (pure JSON, durable-checkpoint safe)', () => {
    const state = forkmapProjectionDefinition.init()
    expect(forkmapProjectionDefinition.stateSchema.safeParse(state).success).toBe(true)
    const folded = [
      ...state.nodes,
      ...state.boundaries,
    ]
    expect(folded).toEqual([])
  })

  it('wire view of a folded state passes the viewSchema', () => {
    let state = forkmapProjectionDefinition.init()
    for (const event of [append(1), reply(2), append(3), reply(4), marker(5, 1, 2, 'edit')]) {
      state = forkmapProjectionDefinition.apply(state, event)
    }
    const view = forkmapProjectionDefinition.wire.view(state)
    expect(forkmapProjectionDefinition.wire.viewSchema.safeParse(view).success).toBe(true)
  })
})
