/**
 * dsh-retrace — Version index fold (pure, zero imports).
 *
 * Rewritten per PLAN.md v0.3 (2026-08-20 revision): the old "hand-written
 * VersionIndex service + custom jsonl index" design is scrapped. This module
 * is the pure fold consumed by the official `ctx.sessionProjections`
 * projection unit (lib/projection/versions.js) — the framework owns the
 * session/event subscription, the per-session watermark cache, checkpoint
 * persistence and cold-read restore; this file owns only deterministic state
 * transitions over one session's committed events.
 *
 * Boundary semantics mirror the official surface fold (`foldSurface` in
 * `@deepseek-ai/dsh-session/surface`): an append pushes the event seq onto
 * the surface; a replace splices [start..end] out and inserts the
 * replacement's own seq. Every replacement event closes a "version" — our
 * markers (recall / edit / regenerate / restore), compaction checkpoints, or
 * any other future surface replacer. Between two boundaries the fold also
 * accumulates the session's touched files (parsing tool calls and tool
 * results), so each version records what artifacts changed in its window.
 *
 * The state is plain JSON only (arrays, no Set/Map) so the projection cache
 * can persist it verbatim (`dsh-session-projection-cache` validates rows
 * with `z.json()`).
 */

import { carrierContentText, carrierLegacyText, carrierAuditSeq, isCarrierMarkerEvent, isLegacyMarkerEvent, spanRangeOf } from './marker-carrier.js'

export const MARKER_ID_PREFIX = 'retrace'

/**
 * Every marker-id prefix this build can classify. `MARKER_ID_PREFIX` is the
 * prefix NEW markers are written with; the rest are LEGACY prefixes from
 * earlier plugin names (dsh-message-editor). RENAME RULE: when the plugin
 * changes identity again, keep the retired prefix here so markers written
 * under the previous name keep classifying correctly.
 */
export const MARKER_ID_PREFIXES = [MARKER_ID_PREFIX, 'message-editor']

/** Timeline keeps the most recent N versions; full history stays replayable from the log. */
export const VERSION_LIMIT = 200

// ---------------------------------------------------------------------------
// Official-equivalent predicates
// ---------------------------------------------------------------------------
// Semantics copied from the official contracts (not code) and locked by unit
// tests, so this module stays import-free and runnable in every realm:
//   isReplacementSurfaceEvent — @deepseek-ai/dsh-session/surface
//   isCompactCheckpointSource — @deepseek-ai/dsh-compaction/checkpoint

const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result'])

/** Whether an event is surface-eligible AND carries a surfaceOp marker. */
export function isSurfaceEvent(event) {
  return SURFACE_EVENT_TYPES.has(event?.type) && event.surfaceOp !== undefined
}

/** Whether an event shadowed an existing surface range (append is the only non-replacement). */
export function isReplacementSurfaceEvent(event) {
  return isSurfaceEvent(event) && event.surfaceOp !== 'append'
}

/** Whether a message source identifies a compaction checkpoint (`plugin: compact`). */
export function isCompactCheckpointSource(source) {
  return Boolean(source) && source.kind === 'plugin' && source.plugin === 'compact'
}

/** Map a marker event id prefix to a user-facing version kind. */
export function kindFromMarkerId(id) {
  if (typeof id !== 'string') return 'edit'
  for (const p of MARKER_ID_PREFIXES) {
    const prefix = `${p}-`
    if (!id.startsWith(prefix)) continue
    const op = id.slice(prefix.length).split('-')[0]
    if (op === 'recall' || op === 'edit' || op === 'regenerate' || op === 'restore') return op
  }
  return 'edit'
}

/**
 * Classify a replacement boundary event into a version kind.
 * 1. our carriers — the two-segment shape (`user/message` + replace + id
 *    `retrace-<op>-…`) and the legacy shape (`assistant/message` + `data.editor`);
 * 2. compaction checkpoints are user/message with the `plugin: compact` source;
 * 3. anything else is a generic `replace`.
 * 两种形态的判据来自 lib/marker-carrier.js(单一真相),本模块只分类。
 */
export function classifyBoundaryKind(event) {
  if (isLegacyMarkerEvent(event)) return kindFromMarkerId(event.data?.message?.id)
  if (isCarrierMarkerEvent(event)) return kindFromMarkerId(event.data?.id)
  if (isCompactCheckpointSource(event?.data?.source)) return 'compaction'
  return 'replace'
}

// ---------------------------------------------------------------------------
// Touched-file extraction (pure)
// ---------------------------------------------------------------------------

/** Tool name → write intent. Unknown tools are ignored unless meta.path says otherwise. */
const WRITE_TOOLS = /(?:^|\.)(fs\.(?:write|edit|create|append)|edit|patch|apply-patch)(?:$|\.)/i
const DELETE_TOOLS = /(?:^|\.)(fs\.(?:remove|delete|rename)|rm|del)(?:$|\.)/i

function classifyToolIntent(name) {
  if (typeof name !== 'string') return null
  if (DELETE_TOOLS.test(name)) return 'delete'
  if (WRITE_TOOLS.test(name)) return 'write'
  return null
}

/** Pull path-like strings out of a tool-call arguments JSON (best effort). */
export function pathsFromToolCallArguments(name, argumentsJson) {
  if (typeof argumentsJson !== 'string' || argumentsJson.length === 0) return []
  let args
  try {
    args = JSON.parse(argumentsJson)
  } catch {
    return []
  }
  if (typeof args !== 'object' || args === null) return []
  const found = new Set()
  // Values under these keys are paths by contract — accepted even without a
  // slash (`README.md`); free-floating strings elsewhere need a slash to be
  // considered path-like (avoids capturing prose like "hello world").
  const PATH_KEYS = new Set(['path', 'paths', 'file_path', 'filepath', 'cwd', 'dirname'])
  const visit = (value, underPathKey) => {
    if (typeof value === 'string') {
      const looksLikePath = underPathKey
        ? value.length > 0 && value !== '.' && value !== '..'
        : value.includes('/') && value.length > 1
      if (looksLikePath) found.add(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, underPathKey)
      return
    }
    if (typeof value === 'object' && value !== null) {
      for (const key of Object.keys(value)) {
        if (PATH_KEYS.has(key)) visit(value[key], true)
        else if (typeof value[key] === 'object' && value[key] !== null) visit(value[key], underPathKey)
      }
    }
  }
  visit(args, false)
  return [...found]
}

/**
 * Parse one event's touched-file contribution.
 * @returns {Array<{path: string, intent: 'write'|'delete'|'unknown'}>}
 */
export function touchedFilesFromEvent(event) {
  if (!event) return []
  const { type, data } = event
  const out = []
  if (type === 'tool/call' && data && typeof data.arguments === 'string') {
    const intent = classifyToolIntent(data.name)
    if (intent !== null) {
      for (const path of pathsFromToolCallArguments(data.name, data.arguments)) {
        out.push({ path, intent })
      }
    }
  }
  if (type === 'tool/result' && data) {
    const failed = Boolean(data.error)
    const metaPath = data.meta && typeof data.meta.path === 'string' ? data.meta.path : null
    if (metaPath && !failed) out.push({ path: metaPath, intent: 'write' })
  }
  return out
}

// ---------------------------------------------------------------------------
// Version index fold
// ---------------------------------------------------------------------------

/**
 * @typedef {object} VersionFile
 * @property {string} path        — canonical path relative to the session cwd.
 * @property {'created'|'modified'|'deleted'} mode
 */

/**
 * @typedef {object} VersionRecord
 * @property {string} versionId          — `v<boundarySeq>`.
 * @property {number} boundarySeq        — the replacement event's seq.
 * @property {number} createdAt          — event time (ms), keeps the fold replayable.
 * @property {'recall'|'edit'|'regenerate'|'restore'|'compaction'|'replace'} kind
 * @property {string} markerText         — boundary highlight: legacy `editor.text`, else the
 *                                          carrier's segment-2 content text; '' when neither.
 * @property {VersionFile[]} touchedFiles
 * @property {number} messageCount       — surface node count at the boundary.
 * @property {null} git                  — P1: { headHash, dirty, diffSha }.
 */

/** Create the empty per-session fold state (plain JSON only). */
export function createVersionIndexState() {
  return {
    versions: [],
    /** path → { intent, lastSeq } — files touched since the last boundary. */
    windowFiles: {},
    /** paths that appeared in any already-finalized version (for created/modified). */
    knownFiles: [],
    /** current surface node seqs (mirrors foldSurface). */
    surface: [],
  }
}

/** Map a window file entry to its version mode against the previous versions. */
function fileMode(state, path, window) {
  if (window.intent === 'delete') return 'deleted'
  return state.knownFiles.includes(path) ? 'modified' : 'created'
}

/**
 * The seqs a boundary reports as replaced (for `what.replaced`):
 * the live splice's shadowed nodes when the span was on the surface, else the
 * marker's own citation with its audit-seq guide item removed (the audit is not
 * a message; `carrierAuditSeq` is the read-side predicate for that item).
 * @param {object} event
 * @param {number[]|null} shadowedSeqs
 * @returns {number[]}
 */
export function replacedSeqsOfBoundary(event, shadowedSeqs) {
  if (Array.isArray(shadowedSeqs)) return shadowedSeqs
  const cited = Array.isArray(event?.sourceEventSeqs)
    ? event.sourceEventSeqs.filter((seq) => Number.isSafeInteger(seq))
    : []
  const audit = carrierAuditSeq(event)
  return audit === null ? cited : cited.filter((seq) => seq !== audit)
}

function extractMarkerText(event, kind) {
  if (kind === 'compaction') return ''
  // 旧形态:editor.text(被替换原文摘要)。
  // 新形态:原文不再随载体存储(改由读端从日志按需派生)⇒ 取第 2 段 content 的
  // 留痕/摘要文本(撤回说明,或业务侧派生的人读摘要文本),它就是该边界在时间线上的说明。
  const legacy = carrierLegacyText(event)
  if (legacy) return legacy
  return carrierContentText(event)
}

/**
 * Close a version at a replacement boundary (window files frozen, window cleared).
 *
 * `shadowedSeqs` are the surface seqs the splice removed (surface order). The
 * fold records only the boundary itself; the human-readable digest of WHAT it
 * replaced is built from the log at operation time and stored as the plugin's
 * own artifact (lib/boundary-what.js + lib/llm-summary.js), so neither the wire
 * nor the durable checkpoint carries it.
 */
function freezeVersion(state, event, shadowedSeqs = null) {
  const boundarySeq = event.seq
  const kind = classifyBoundaryKind(event)
  const files = Object.entries(state.windowFiles)
    .map(([path, window]) => ({ path, mode: fileMode(state, path, window) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const record = {
    versionId: `v${boundarySeq}`,
    boundarySeq,
    createdAt: typeof event.time === 'number' ? event.time : 0,
    kind,
    markerText: extractMarkerText(event, kind),
    touchedFiles: files,
    messageCount: state.surface.length,
    git: null,
  }
  const versions = [...state.versions, record]
  if (versions.length > VERSION_LIMIT) versions.splice(0, versions.length - VERSION_LIMIT)
  const knownFiles = [...state.knownFiles]
  for (const file of files) {
    if (!knownFiles.includes(file.path)) knownFiles.push(file.path)
  }
  return { ...state, versions, windowFiles: {}, knownFiles }
}

/**
 * Fold one committed event into the version index state.
 *
 * Performance contract (load-bearing for the projection registry): when the
 * event changes nothing — not surface, not files, not a boundary — the SAME
 * state reference is returned (`Object.is` gates the change feed, so a new
 * object means a downstream snapshot/push).
 *
 * @param {ReturnType<typeof createVersionIndexState>} state
 * @param {object} event
 * @returns the next state (same reference when nothing changed).
 */
export function applyVersionIndex(state, event) {
  if (!event || typeof event.seq !== 'number') return state
  let next = state

  // 1. Surface fold (mirror foldSurface): append → push; replace → splice.
  let shadowedSeqs = null
  if (isSurfaceEvent(event)) {
    const op = event.surfaceOp
    if (op === 'append') {
      next = { ...next, surface: [...next.surface, event.seq] }
    } else if (op && op.op === 'replace') {
      // Dual-shape range reader: v0 hosts write `{start,end}`, the 0.1.5 host
      // writes `{startSeq,endSeq}` (lib/marker-carrier.js#spanRangeOf). Reading
      // only v0 keys silently disabled the live splice on real 2.0.9 sessions
      // (found by folding a real session log: every boundary showed 0
      // shadowed nodes and the surface never shrank).
      const range = spanRangeOf(op)
      const startIdx = range === null ? -1 : next.surface.indexOf(range.start)
      const endIdx = range === null ? -1 : next.surface.indexOf(range.end)
      if (startIdx !== -1 && endIdx !== -1 && startIdx <= endIdx) {
        shadowedSeqs = next.surface.slice(startIdx, endIdx + 1)
        const surface = next.surface.slice()
        surface.splice(startIdx, endIdx - startIdx + 1, event.seq)
        next = { ...next, surface }
      }
    }
  }

  // 2. Touched-file window.
  const touched = touchedFilesFromEvent(event)
  if (touched.length > 0) {
    const windowFiles = { ...next.windowFiles }
    for (const { path, intent } of touched) {
      const prev = windowFiles[path]
      if (!prev || event.seq > prev.lastSeq) windowFiles[path] = { intent, lastSeq: event.seq }
    }
    next = { ...next, windowFiles }
  }

  // 3. Version boundary.
  if (isReplacementSurfaceEvent(event)) {
    next = freezeVersion(next, event, shadowedSeqs)
  }

  return next
}

/** Count file modes of one version's touched files (timeline badge input). */
export function countFileModes(touchedFiles) {
  const counts = { created: 0, modified: 0, deleted: 0 }
  for (const file of touchedFiles) {
    if (file.mode === 'created') counts.created += 1
    else if (file.mode === 'modified') counts.modified += 1
    else if (file.mode === 'deleted') counts.deleted += 1
  }
  return counts
}

/**
 * The client-visible wire value (what `ctx.sessionProjections` serves in
 * `session/projection` frames and `snapshot()`). Compact per-version summary
 * plus the full touched-file list (the HTTP `/versions` route serves this
 * same shape; rollback/detail reads files lazily in P1).
 */
export function viewVersionIndex(state) {
  return {
    versions: state.versions.map((record) => ({
      versionId: record.versionId,
      boundarySeq: record.boundarySeq,
      createdAt: record.createdAt,
      kind: record.kind,
      markerText: record.markerText,
      messageCount: record.messageCount,
      fileCounts: countFileModes(record.touchedFiles),
      touchedFiles: record.touchedFiles,
      git: record.git,
    })),
  }
}
