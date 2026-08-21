/**
 * dsh-retrace — `retrace/versions` projection unit definition.
 *
 * Registered on the official `ctx.sessionProjections` registry
 * (`@deepseek-ai/dsh-session-projection`), per PLAN.md §4.1. The framework
 * owns the single `session/event` subscription, the per-session watermark
 * cache, checkpoint persistence (`dsh-session-projection-cache`) and cold
 * reads; this unit contributes only the pure state machine:
 *
 *   - `init`   — empty fold state (see lib/version-index.js),
 *   - `apply`  — deterministic fold over one committed event (same reference
 *                when nothing changed — `Object.is` gates the change feed),
 *   - `view`   — the client-visible wire value (version list summary served
 *                in `session/projection` push frames and `snapshot()`).
 *
 * The unit schema validates the VIEW value (the registry parses `view(state)`
 * before serving); the raw fold state is plain JSON so the projection cache
 * can persist it (`z.json()` at the durable boundary).
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

/**
 * The `retrace/versions` unit — register via
 * `ctx.sessionProjections.register(versionsProjectionDefinition)`.
 */
export const versionsProjectionDefinition = {
  key: 'retrace/versions',
  schema: versionsViewSchema,
  init: () => createVersionIndexState(),
  apply: (state, event) => applyVersionIndex(state, event),
  view: (state) => viewVersionIndex(state),
  /** Bump when the serialized fold state or fold semantics change. */
  stateVersion: 1,
}
