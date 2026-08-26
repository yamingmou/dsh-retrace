/**
 * dsh-retrace — `retrace/forkmap` projection unit definition.
 *
 * Registered on the official `ctx.sessionProjections` registry alongside
 * `retrace/versions` (PLAN §5.2, P2.1). Same contract as the versions unit:
 *
 *   - `stateSchema` — zod schema of the RAW fold state (plain JSON; the
 *     durable checkpoint validates rows against it),
 *   - `init` / `apply` — the deterministic fold (lib/forkmap.js),
 *   - `wire` — the client-visible view ({viewSchema, view}); a unit WITHOUT
 *     `wire` registers as checkpoint-only and is never served in
 *     `session/projection` push frames or `snapshot()` (the framework
 *     contract the P0 versions definition missed; found by the P1 smoke).
 *
 * Unlike the versions unit, the fork-map state is NOT truncated: the whole
 * branch topology must survive (VERSION_LIMIT=200 truncation would drop old
 * fork points). Per-boundary payloads are tiny (seqs only), so the projection
 * stays small even for long sessions; node content stays out of the fold
 * (lazy reads via the HTTP surface when the client needs detail).
 */
import { z } from 'zod'
import {
  applyForkmap,
  createForkmapState,
  viewForkmap,
} from '../forkmap.js'

const FORK_KINDS = ['recall', 'edit', 'regenerate', 'restore', 'compaction', 'replace']

const forkmapNodeSchema = z.object({
  seq: z.number().int().nonnegative(),
  type: z.string(),
})

const forkmapBoundarySchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: z.enum(FORK_KINDS),
  replacedSeqs: z.array(z.number().int().nonnegative()),
})

/** Raw fold-state schema (durable checkpoint rows validate against it). */
export const forkmapStateSchema = z.object({
  nodes: z.array(forkmapNodeSchema),
  boundaries: z.array(forkmapBoundarySchema),
})

/** The wire view schema (what the registry validates and clients receive). */
export const forkmapViewSchema = forkmapStateSchema

/**
 * The `retrace/forkmap` unit — register via
 * `ctx.sessionProjections.register(forkmapProjectionDefinition)`.
 */
export const forkmapProjectionDefinition = {
  key: 'retrace/forkmap',
  stateSchema: forkmapStateSchema,
  init: () => createForkmapState(),
  apply: (state, event) => applyForkmap(state, event),
  wire: {
    viewSchema: forkmapViewSchema,
    view: (state) => viewForkmap(state),
  },
  /** Bump when the serialized fold state or fold semantics change. */
  stateVersion: 1,
}

// Top-level aliases (unit tests drive the definition directly).
forkmapProjectionDefinition.schema = forkmapProjectionDefinition.wire.viewSchema
forkmapProjectionDefinition.view = forkmapProjectionDefinition.wire.view
