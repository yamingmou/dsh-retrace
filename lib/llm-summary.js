/**
 * dsh-retrace — lib/llm-summary.js
 *
 * The OPTIONAL LLM summary half of the boundary digest. Everything here is
 * gated four ways:
 *
 *   0. QUIET boundaries write NOTHING (no line, no call): the R1–R4 gate blocked
 *      AND the workspace saw no artifact churn. The client renders those from
 *      `/versions` (op + time) as plain rows and merges consecutive ones;
 *   1. the per-session `summary` switch defaults to OFF — off means no LLM call
 *      (the `what` digest line is still written, since it costs no tokens);
 *   2. `needsSummary` (lib/summary-gate.js) must pass all four rules;
 *   3. a cached record for the same `contentHash` short-circuits the call.
 *
 * Timing: the caller triggers this AFTER the marker pair is committed and
 * validated, fire-and-forget (`trigger()` swallows rejections into the
 * diagnostic log). Nothing here is awaited on the edit/recall path.
 *
 * Failure policy (本线规矩: 服务端错误不许静默): no credentials, no `llm`
 * service, timeout (5 s), empty output or any throw ⇒ the record is still
 * written with `called:false` + `error`, the list keeps serving `excerpt`, and a
 * one-line diagnostic goes to the plugin log.
 *
 * The LLM handle is INJECTED (`llm.prepareCall` + `selection`), so the module is
 * testable without the host package; the host composition passes
 * `ctx.get('llm')` and `ctx.agentDefaultModel.currentSelection()`.
 */
import { needsSummary, summaryInputOf } from './summary-gate.js'
import {
  appendSummary,
  findCachedSummary,
  hashSummaryInput,
  readSummaries,
} from './summary-store.js'

/** Wall-clock budget for one summary call (user-set red line). */
export const SUMMARY_TIMEOUT_MS = 5000

/** Output cap for one summary call (user-set). */
export const SUMMARY_OUTPUT_TOKENS = 200

/** Display cap for the stored summary text (the wire/route payload). */
export const SUMMARY_TEXT_MAX = 500

/** The prompt: summarize ONLY the discarded old content, same language. */
export const SUMMARY_SYSTEM_PROMPT = [
  'You summarize conversation content that a user just discarded (recalled/edited/regenerated away).',
  'The reader has already lost this content and wants to remember what was in it.',
  'Reply with a plain-text summary, at most 120 words, in the SAME language as the content.',
  'Do not greet, do not add commentary, do not mention that you are an AI. Output only the summary.',
].join(' ')

/**
 * Build the message array for one summary call from the capped input items.
 * @param {Array<{seq:number, role:string, text:string}>} items
 * @returns {Array<{role:string, content:Array<{type:'text', text:string}>}>}
 */
export function buildSummaryMessages(items) {
  const body = items.map((item) => `[${item.role} #${item.seq}] ${item.text}`).join('\n\n')
  return [
    { role: 'system', content: [{ type: 'text', text: SUMMARY_SYSTEM_PROMPT }] },
    { role: 'user', content: [{ type: 'text', text: body }] },
  ]
}

/**
 * Tolerant text assembly over the host's assistant stream chunks: only
 * `text-delta` chunks contribute, and `usage` is taken from whichever chunk
 * carries it (the terminal `finish` chunk in the 0.1.5 protocol).
 * @param {Iterable<object>} chunks
 * @returns {{text:string, usage:object|null, finish:object|null}}
 */
export async function assembleSummaryStream(chunks) {
  let text = ''
  let usage = null
  let finish = null
  for await (const chunk of chunks) {
    if (!chunk || typeof chunk !== 'object') continue
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk.type === 'text' && typeof chunk.text === 'string') text += chunk.text
    if (chunk.usage && typeof chunk.usage === 'object') usage = chunk.usage
    if (chunk.type === 'finish') finish = chunk
  }
  return { text, usage, finish }
}

/** Whether one finish chunk reports a failure reason. */
function finishError(finish) {
  const kind = finish?.reason?.kind
  if (kind === 'error' || kind === 'aborted') return `${kind}: ${finish?.reason?.failure?.message ?? finish?.reason?.failure?.code ?? 'unknown'}`
  return null
}

/**
 * Run ONE summary decision + call for one boundary. Never throws; always
 * resolves to a record when the caller wants it persisted.
 *
 * @param {object} input
 * @param {string} input.root - plugin data home root
 * @param {string} input.sessionId
 * @param {number} input.boundarySeq
 * @param {string} [input.versionId]
 * @param {object[]} input.spanEvents - the replaced surface events (log access is
 *   the caller's: this runs at operation time, where the log is still readable)
 * @param {object} [input.what] - the `what` payload (lib/boundary-what.js); stored
 *   in the same artifact line so one read serves both excerpts and summaries.
 *   Recorded regardless of the `summary` switch.
 * @param {number[]} [input.discardedSeqs] - the EXACT surface nodes this boundary
 *   removed (the span's `shadowedSeqs`). Stored so the read route can build the
 *   outline forest (lib/boundary-tree.js) without re-reading the log.
 * @param {number|null} [input.turn] - the session round the boundary belongs to
 *   (read out of the log; absent when the log does not carry it). Copied onto the
 *   record so the reader can say "which round" without re-reading the log.
 * @param {number} [input.discardedCount] - exact `|S|`; the stored list may be
 *   slimmed to `S ∩ allBoundarySeqs`, the count stays true.
 * @param {{created:number,modified:number,deleted:number}|null} [input.artifactCounts]
 *   - the boundary's artifact churn. `null` = UNKNOWN (projection unreadable):
 *   the boundary is then treated as NON-quiet (unknown ≠ zero) and still gets the
 *   full digest line, with a diagnostic.
 * @param {boolean} [input.summaryEnabled] - the per-session `summary` switch.
 *   `false`/absent ⇒ the `what` digest is still recorded, no LLM call is made.
 * @param {object} [input.llm] - `ctx.get('llm')` (absent ⇒ degrade)
 * @param {{provider:string,model:string}|null} [input.selection]
 * @param {(msg:string)=>void} [input.log]
 * @param {number} [input.timeoutMs]
 * @param {() => number} [input.now]
 * @returns {Promise<object>} the record (also appended to the artifact)
 */
export async function runSummary({
  root,
  sessionId,
  boundarySeq,
  versionId,
  spanEvents,
  what = null,
  discardedSeqs = null,
  discardedCount = null,
  turn = null,
  artifactCounts = null,
  summaryEnabled = false,
  llm = null,
  selection = null,
  log = () => {},
  timeoutMs = SUMMARY_TIMEOUT_MS,
  now = () => Date.now(),
}) {
  const at = now()
  const gate = needsSummary(spanEvents)
  const items = summaryInputOf(spanEvents)
  const contentHash = hashSummaryInput(items)
  const base = {
    boundarySeq,
    versionId,
    contentHash,
    at,
    chars: gate.stats.chars,
    called: false,
    rule: gate.rule,
    ...(Number.isSafeInteger(turn) && turn > 0 ? { turn } : {}),
    ...(what === null ? {} : { what }),
    ...(Array.isArray(discardedSeqs) ? { discardedSeqs } : {}),
    // The EXACT |S| even though `discardedSeqs` travels SLIMMED (boundary seqs
    // only): the outline reader falls back to the stored set's size when this is
    // missing, which would under-report "这次改动丢弃了 N 条消息" for every new
    // session. Quiet lines already carried it; content lines must too.
    ...(Number.isSafeInteger(discardedCount) ? { discardedCount } : {}),
  }

  const persist = async (record) => {
    const written = await appendSummary(root, sessionId, record)
    if (!written.ok) log(`retrace: summary artifact write failed (${written.error})`)
    return { ...record, persisted: written.ok }
  }

  // QUIET boundary — the R1–R4 gate blocked AND the workspace provably saw no
  // artifact churn (0/0/0). It gets a STRUCTURE-ONLY line (boundarySeq + quiet +
  // the slimmed discarded set + the exact count) instead of a content line: the
  // client renders it from `/versions` (op + time) as a plain merged row, while
  // the outline keeps its skeleton. Without that line a quiet node that was
  // itself a parent would sever its children's indentation.
  //
  // Unknown counts are NOT zero: if the projection could not be read we treat the
  // boundary as non-quiet and write the full digest line (never silently drop
  // data), with a diagnostic.
  if (artifactCounts === null && !gate.needs) {
    log(`retrace: artifact counts unavailable for #${boundarySeq} — treating the boundary as non-quiet`)
  }
  const artifactsTotal =
    artifactCounts === null
      ? null
      : (artifactCounts.created ?? 0) + (artifactCounts.modified ?? 0) + (artifactCounts.deleted ?? 0)
  if (!gate.needs && artifactsTotal === 0) {
    return persist({
      boundarySeq,
      quiet: true,
      ...(Number.isSafeInteger(turn) && turn > 0 ? { turn } : {}),
      ...(Array.isArray(discardedSeqs) ? { discardedSeqs } : {}),
      ...(Number.isSafeInteger(discardedCount) ? { discardedCount } : {}),
    })
  }

  // A boundary that DID change artifacts (or discarded enough to be worth a
  // summary) always gets its digest line: `what` costs no tokens.
  if (summaryEnabled !== true) return persist({ ...base, summaryEnabled: false })
  if (!gate.needs) return persist(base)

  // Cache: same replaced content anywhere ⇒ reuse, zero calls.
  const existing = await readSummaries(root, sessionId)
  const cached = findCachedSummary(existing.records, { boundarySeq, contentHash })
  if (cached && typeof cached.summary === 'string' && cached.summary !== '') return cached

  if (!llm || typeof llm.prepareCall !== 'function') {
    log(`retrace: summary skipped for #${boundarySeq} — llm service unavailable`)
    return persist({ ...base, error: 'llm-unavailable' })
  }
  if (!selection?.provider || !selection?.model) {
    log(`retrace: summary skipped for #${boundarySeq} — no model/credentials selected`)
    return persist({ ...base, error: 'no-credentials' })
  }

  const model = `${selection.provider}/${selection.model}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = now()
  try {
    const config = {
      provider: selection.provider,
      model: selection.model,
      messages: buildSummaryMessages(items),
      maxTokens: SUMMARY_OUTPUT_TOKENS,
    }
    const prepared = await llm.prepareCall(config, controller.signal)
    const assembled = await assembleSummaryStream(prepared.stream(config))
    const failure = finishError(assembled.finish)
    const ms = now() - startedAt
    if (controller.signal.aborted) {
      log(`retrace: summary timeout for #${boundarySeq} after ${ms}ms (limit ${timeoutMs}ms)`)
      return persist({ ...base, called: true, model, ms, error: `timeout>${timeoutMs}ms` })
    }
    if (failure !== null) {
      log(`retrace: summary call failed for #${boundarySeq}: ${failure}`)
      return persist({ ...base, called: true, model, ms, error: failure })
    }
    // The summary is its own field with its own cap — it must NOT be squeezed
    // through `excerpt()` (60 chars): that is the verbatim-text budget.
    const summary = assembled.text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_TEXT_MAX)
    if (summary === '') {
      log(`retrace: summary call returned no text for #${boundarySeq}`)
      return persist({ ...base, called: true, model, ms, error: 'empty-summary' })
    }
    return persist({
      ...base,
      called: true,
      model,
      ms,
      usage: assembled.usage ?? undefined,
      inputChars: gate.stats.inputChars,
      inputItems: gate.stats.inputItems,
      summary,
    })
  } catch (error) {
    const ms = now() - startedAt
    const message = String(error?.message ?? error)
    // An abort is the wall-clock guard firing; report it as the timeout it is.
    const reason = controller.signal.aborted ? `timeout>${timeoutMs}ms` : message
    if (controller.signal.aborted) log(`retrace: summary timeout for #${boundarySeq} after ${ms}ms (limit ${timeoutMs}ms)`)
    else log(`retrace: summary failed for #${boundarySeq} after ${ms}ms: ${message}`)
    return persist({ ...base, called: true, model, ms, error: reason })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fire-and-forget wrapper: the op path calls `trigger(...)` and moves on.
 * Rejections and artifact failures are logged, never propagated.
 * @returns {Promise<object|null>} settles in the background
 */
export function triggerSummary(args) {
  const promise = runSummary(args).catch((error) => {
    try {
      args?.log?.(`retrace: summary trigger failed: ${String(error?.message ?? error)}`)
    } catch {
      /* the diagnostic log itself must not break the op */
    }
    return null
  })
  return promise
}
