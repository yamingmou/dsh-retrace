/**
 * dsh-retrace — lib/summary-store.js
 *
 * The plugin-owned artifact store for LLM summaries (design 2026-09-14):
 * summaries do NOT go into the host session log (a non-`ignorable` plugin event
 * type makes the persistence reader refuse the log — see the report) and do NOT
 * go into the projection state (that would make the fold depend on out-of-band
 * mutations). They live as the plugin's own artifact instead:
 *
 *   <pluginDataHome()>/dsh-retrace/summaries/<sessionId>.jsonl
 *
 * One JSON object per line, append-only, key = `boundarySeq` + `contentHash` of
 * the summarised input. The artifact is durable, independently readable
 * (`cat`/`jq`) and exportable; the read route renders a Markdown view on demand
 * (`?format=md`).
 *
 * Crash safety: a torn last line (write interrupted mid-record) is SKIPPED by
 * the reader, and the reader never throws on a missing/corrupt file — it returns
 * no records, so the UI degrades to "原文 only". Nothing here is on the callback
 * path of an edit/recall: the caller appends fire-and-forget.
 *
 * Records (written even when the gate says "don't call", for audit):
 *   { boundarySeq, versionId, contentHash, called, rule, chars, model?, at,
 *     usage?, summary?, ms?, error? }
 */
import { createHash } from 'node:crypto'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Directory (under the plugin data home root) holding one file per session. */
export const SUMMARY_DIR = 'summaries'

/** Path-safe session id (the id is host-controlled, but never trust it as a path). */
function safeId(sessionId) {
  return String(sessionId ?? 'unknown').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 200)
}

/** The per-session summary artifact path. */
export function summaryFilePath(root, sessionId) {
  return join(root, SUMMARY_DIR, `${safeId(sessionId)}.jsonl`)
}

/**
 * Stable hash of the summariser input (the capped message list). Two operations
 * that would drop the same text share one cached summary.
 * @param {Array<{seq:number, role:string, text:string}>} items
 * @returns {string} 16 hex chars
 */
export function hashSummaryInput(items) {
  const canonical = (Array.isArray(items) ? items : [])
    .map((item) => `${item?.role ?? ''}\u0000${String(item?.text ?? '')}`)
    .join('\u0001')
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 16)
}

/** Cache key of one record (boundary + content). */
export function summaryKeyOf(record) {
  return `${record?.boundarySeq ?? ''}:${record?.contentHash ?? ''}`
}

/**
 * Append one record. Fire-and-forget safe: resolves to `{ok:false, error}` on
 * any filesystem failure instead of throwing, so a full disk cannot break an op.
 * @param {string} root - plugin data home root
 * @param {string} sessionId
 * @param {object} record
 * @returns {Promise<{ok:boolean, path:string, error?:string}>}
 */
export async function appendSummary(root, sessionId, record) {
  const path = summaryFilePath(root, sessionId)
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    // A LEADING newline keeps this record on its own line even when the previous
    // write was torn (no trailing newline): the torn line stays isolated and is
    // skipped by the reader instead of swallowing the next good record.
    await appendFile(path, `\n${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
    return { ok: true, path }
  } catch (error) {
    return { ok: false, path, error: String(error?.message ?? error) }
  }
}

/**
 * Read one session's summaries. Missing file → empty. A torn or foreign line is
 * skipped and counted (`skipped`), never thrown: the caller degrades to 原文.
 * @returns {Promise<{records:object[], skipped:number, error:string|null, path:string}>}
 */
export async function readSummaries(root, sessionId) {
  const path = summaryFilePath(root, sessionId)
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { records: [], skipped: 0, error: null, path }
    return { records: [], skipped: 0, error: String(error?.message ?? error), path }
  }
  const records = []
  let skipped = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const record = JSON.parse(line)
      if (record && typeof record === 'object' && Number.isSafeInteger(record.boundarySeq)) records.push(record)
      else skipped += 1
    } catch {
      skipped += 1
    }
  }
  return { records, skipped, error: null, path }
}

/**
 * The cached record for one boundary + content hash (undefined when absent).
 * @param {object[]} records
 * @param {{boundarySeq:number, contentHash:string}} key
 */
export function findCachedSummary(records, key) {
  const wanted = summaryKeyOf(key)
  for (const record of records) if (summaryKeyOf(record) === wanted) return record
  return undefined
}

/** Latest record per boundarySeq (the read route serves this). */
export function latestByBoundary(records) {
  const bySeq = new Map()
  for (const record of records) bySeq.set(record.boundarySeq, record)
  return [...bySeq.values()].sort((a, b) => a.boundarySeq - b.boundarySeq)
}

/**
 * Human-readable Markdown rendering of one session's summaries (the read route's
 * `?format=md`; the artifact itself stays structured JSONL for the client).
 */
export function renderSummariesMarkdown(sessionId, records) {
  const rows = latestByBoundary(records)
  const lines = [`# dsh-retrace summaries — ${safeId(sessionId)}`, '', `records: ${rows.length}`, '']
  for (const record of rows) {
    const when = Number.isSafeInteger(record.at) ? new Date(record.at).toISOString() : '(no time)'
    lines.push(`## #${record.boundarySeq} — ${record.versionId ?? ''}`)
    lines.push('')
    lines.push(`- called: ${record.called === true ? 'yes' : 'no'}${record.rule ? ` (rule ${record.rule})` : ''}`)
    lines.push(`- model: ${record.model ?? '(none)'}   chars: ${record.chars ?? '?'}   ms: ${record.ms ?? '?'}`)
    if (record.usage) lines.push(`- usage: ${JSON.stringify(record.usage)}`)
    if (record.error) lines.push(`- error: ${record.error}`)
    if (typeof record.summary === 'string' && record.summary !== '') {
      lines.push('')
      lines.push(record.summary)
    }
    lines.push('')
  }
  return `${lines.join('\n')}\n`
}
