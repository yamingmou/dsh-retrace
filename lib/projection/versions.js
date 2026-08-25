/**
 * dsh-retrace — `retrace/versions` projection unit definition.
 *
 * Registered on the official `ctx.sessionProjections` registry
 * (`@deepseek-ai/dsh-session-projection`), per PLAN.md §4.1. The framework
 * owns the single `session/event` subscription, the per-session watermark
 * cache, checkpoint persistence (`dsh-session-projection-cache`) and cold
 * reads; this unit contributes only the pure state machine:
 *
 *   - `stateSchema` — zod schema of the RAW fold state (plain JSON; the
 *     durable checkpoint validates rows against it),
 *   - `init` / `apply` — the deterministic fold (lib/version-index.js),
 *   - `wire` — the client-visible view ({viewSchema, view}); a unit WITHOUT
 *     `wire` registers as checkpoint-only and is never served in
 *     `session/projection` push frames or `snapshot()` — the framework
 *     contract that P0's original definition missed (found by the P1
 *     real-harness smoke: every session's projection block lacked the key).
 *
 * `view` / `schema` top-level aliases stay for the unit tests, which drive
 * the definition directly instead of through the registry.
 */
import { z } from 'zod'
import {
  VERSION_LIMIT,
  applyVersionIndex,
  createVersionIndexState,
  viewVersionIndex,
} from '../version-index.js'

const VERSION_KINDS = ['recall', 'edit', 'regenerate', 'restore', 'compaction', 'replace']
const FILE_MODES = ['created', 'modified', 'deleted']

const fileChangeSchema = z.object({
  path: z.string(),
  mode: z.enum(FILE_MODES),
})

const versionSummarySchema = z.object({
  versionId: z.string(),
  boundarySeq: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
  kind: z.enum(VERSION_KINDS),
  markerText: z.string(),
  messageCount: z.number().int().nonnegative(),
  fileCounts: z.object({
    created: z.number().int().nonnegative(),
    modified: z.number().int().nonnegative(),
    deleted: z.number().int().nonnegative(),
  }),
  touchedFiles: z.array(fileChangeSchema),
  git: z.null(),
})

/** The wire view schema (what the registry validates and clients receive). */
export const versionsViewSchema = z.object({
  versions: z.array(versionSummarySchema).max(VERSION_LIMIT),
})

/** Raw fold-state schema (durable checkpoint rows validate against it). */
const windowEntrySchema = z.object({
  intent: z.enum(['write', 'delete', 'unknown']),
  lastSeq: z.number().int().nonnegative(),
})

export const versionIndexStateSchema = z.object({
  versions: z.array(z.unknown()).max(VERSION_LIMIT),
  windowFiles: z.record(z.string(), windowEntrySchema),
  knownFiles: z.array(z.string()),
  surface: z.array(z.number().int().nonnegative()),
})

/**
 * The `retrace/versions` unit — register via
 * `ctx.sessionProjections.register(versionsProjectionDefinition)`.
 */
export const versionsProjectionDefinition = {
  key: 'retrace/versions',
  stateSchema: versionIndexStateSchema,
  init: () => createVersionIndexState(),
  apply: (state, event) => applyVersionIndex(state, event),
  wire: {
    viewSchema: versionsViewSchema,
    view: (state) => viewVersionIndex(state),
  },
  /** Bump when the serialized fold state or fold semantics change. */
  stateVersion: 1,
}

// Top-level aliases (unit tests drive the definition directly).
versionsProjectionDefinition.schema = versionsProjectionDefinition.wire.viewSchema
versionsProjectionDefinition.view = versionsProjectionDefinition.wire.view
