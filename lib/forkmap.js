/**
 * dsh-retrace — `retrace/forkmap` pure fold (PLAN §5.2, P2.1).
 *
 * The fork map is the BRANCH-TOPOLOGY presentation layer ("how we got here"):
 * every surface replacement — recall / edit / regenerate / restore markers,
 * compaction checkpoints, and any other replace — is a FORK POINT that shadows
 * a range of the old path and continues a new path. This module mirrors the
 * official `foldSurface` state transition (the same one the versions unit
 * uses) and additionally records each boundary with the seqs it shadowed, so
 * the client can render:
 *
 *   spine     — the current-surface node flow (markers sit ON the spine),
 *   branches  — at each boundary, the shadowed (old-path) node cluster.
 *
 * Data notes (verified against the official source, 2026-08-26):
 *   - replace `start`/`end` are EVENT SEQS (not surface indices); the shadowed
 *     seqs are the surface nodes the splice removed — exactly
 *     `foldSurface(...).replacements[].shadowedSeqs`.
 *   - official `traceEvent` does NOT link a marker to its new path
 *     (new-path events never cite the marker, so `derivedEventSeqs` is empty)
 *     — the new path IS the spine: the surface nodes after the boundary
 *     (PLAN.md:295 "标记→新路径无需自解析" corrected by research).
 *   - boundaries ARE the versions (every replacement closes a version); the
 *     wire stays lean (no markerText — the client joins it from
 *     `retrace/versions` by boundarySeq).
 *
 * The module is import-free except for the shared boundary predicates, stays
 * transport-neutral, and is registered alongside `retrace/versions` in the
 * versioning seam. No side effects: pure fold only.
 */
import {
  classifyBoundaryKind,
  isReplacementSurfaceEvent,
  isSurfaceEvent,
} from './version-index.js'

/** Fork-map fold state (plain JSON — durable checkpoint rows validate it). */
export function createForkmapState() {
  return {
    /** Current surface nodes: `{ seq, type }` in fold order (mirror foldSurface). */
    nodes: [],
    /** Replacement boundaries in append order. */
    boundaries: [],
  }
}

/**
 * Fold one committed event into the fork-map state.
 *
 * Performance contract (load-bearing for the projection registry): when the
 * event changes nothing — no surface move, no boundary — the SAME state
 * reference is returned (`Object.is` gates the change feed).
 *
 * @param {ReturnType<typeof createForkmapState>} state
 * @param {object} event
 * @returns the next state (same reference when nothing changed).
 */
export function applyForkmap(state, event) {
  if (!event || typeof event.seq !== 'number') return state
  let next = state
  let shadowed = null

  // 1. Surface fold (mirror foldSurface / the versions unit).
  if (isSurfaceEvent(event)) {
    const op = event.surfaceOp
    if (op === 'append') {
      next = { ...next, nodes: [...next.nodes, { seq: event.seq, type: event.type }] }
    } else if (op && op.op === 'replace') {
      const startIdx = next.nodes.findIndex((node) => node.seq === op.start)
      const endIdx = next.nodes.findIndex((node) => node.seq === op.end)
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        shadowed = next.nodes.slice(startIdx, endIdx + 1).map((node) => node.seq)
        const nodes = next.nodes.slice()
        nodes.splice(startIdx, endIdx - startIdx + 1, { seq: event.seq, type: event.type })
        next = { ...next, nodes }
      }
    }
  }

  // 2. Boundary (fork point). The shadowed range is the splice's removal when
  //    the span was live; otherwise fall back to the marker's own citation.
  if (isReplacementSurfaceEvent(event)) {
    const cited = Array.isArray(event.sourceEventSeqs) ? event.sourceEventSeqs : []
    const replacedSeqs = shadowed !== null ? shadowed : cited
    const boundary = {
      seq: event.seq,
      kind: classifyBoundaryKind(event),
      replacedSeqs,
    }
    next = { ...next, boundaries: [...next.boundaries, boundary] }
  }

  return next
}

/** The client-visible wire value (what `session/projection` frames serve). */
export function viewForkmap(state) {
  return {
    nodes: state.nodes.map((node) => ({ seq: node.seq, type: node.type })),
    boundaries: state.boundaries.map((boundary) => ({
      seq: boundary.seq,
      kind: boundary.kind,
      replacedSeqs: boundary.replacedSeqs,
    })),
  }
}
