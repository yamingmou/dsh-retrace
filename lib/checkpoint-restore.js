/**
 * dsh-retrace — lib/checkpoint-restore.js
 *
 * Batch2 checkpoint **restore** (preview-ticket → execute):
 *
 *   ① `previewCheckpoint(sessionId, versionId)` pins a ticket to the current log
 *      (cut = event count) and to every planned file `{ key, version, action }`;
 *      a ticket is valid for 120 s and any drift ⇒ `preview-expired`.
 *   ② `executeCheckpoint(ticket)` first captures the **preimage of the restore
 *      itself** (so a restore can be undone later), then
 *        · rewinds the conversation by appending a **validated batch** —
 *          `compaction/prune` (official shadow-price claim) + `system/message`
 *          with `surfaceOp:{op:'replace'}` — and re-appending the target
 *          surface messages. The whole batch is validated (dsh-log-contract
 *          `validateEdit` + kernel fold + surfaceKey equality) BEFORE the first
 *          append ⇒ a rejection appends nothing.
 *        · writes files back with CAS (`replaceIfVersion` / `createIfAbsent`);
 *          deleting a file needs the sandbox's own lock/identity APIs
 *          (`ctx.fs.withLock` + `checkedTarget` + `processPath`); when they are
 *          missing the action is reported `unsupported` and nothing is removed.
 *   ③ `collectGarbage()` merges the artifact-store `refCounts` refs
 *      (`seam.referencedShas()`) into the keep set, so shared-pool GC can never
 *      delete a version snapshot's object.
 *
 * Failure semantics follow the migration plan's asymmetry: the undo ticket in
 * `lib/rollback.js` stays fail-closed (it refuses the rollback), while a
 * checkpoint preimage capture failure degrades — the restore proceeds, marks
 * the checkpoint `filesComplete:false`, and reports the warning.
 */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, unlink } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { foldSurface, deriveEventMessage } from '@deepseek-ai/dsh-session'
import { foldSurfaceWithProjections, messageProjectionsOf } from './adapter/dsh.js'
import { runtimeSurfaceOpShape } from './adapter/contract.js'
import { sessionEvents } from './host-compat.js'
import { editorError } from './host-core.js'
import { replaceIfVersion, statVersion } from './undo-store.js'

/** Preview tickets live this long (plan §2: 120 s). */
export const CHECKPOINT_TICKET_TTL_MS = 120_000
/** One preimage/file write is bounded to this many bytes (as Batch1/undo). */
export const CHECKPOINT_MAX_FILE_BYTES = 1024 * 1024
/** A pending checkpoint older than this is a crash leftover, not an operation. */
export const CHECKPOINT_PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000

const EXCLUDED_SEGMENTS = new Set(['.git', 'node_modules'])
const HEX64 = /^[0-9a-f]{64}$/

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex')

const textOf = (bytes) => {
  const buffer = Buffer.from(bytes)
  const text = buffer.toString('utf8')
  if (text.includes('\0') || !Buffer.from(text).equals(buffer)) throw editorError('unsupported', 'binary-or-encoding')
  return text
}

const targetKeyOf = (target) => {
  if (typeof target === 'string') return target
  const key = target?.targetKey ?? target?.key ?? null
  return typeof key === 'string' ? key : null
}

/** Stable message identity: transport ids are not content (plan §3 surfaceKey). */
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

/**
 * The model-visible surface as entries `{ seq, event, message }`.
 * @param {Array<object>} events
 * @param {Function} [fold] - injected fold (defaults to the kernel's)
 */
export function surfaceEntriesOf(events, fold) {
  const folded = (fold ?? ((list) => foldSurface(list)))(events)
  const nodes = Array.isArray(folded?.nodes) ? folded.nodes : []
  return nodes
    .map((seq) => ({ seq, event: events[seq], message: deriveEventMessage(events[seq], folded?.projectedMessages) }))
    .filter((entry) => entry.event !== undefined && entry.message !== null && entry.message !== undefined)
}

/** Compare surfaces without depending on ids that a replay legitimately rewrites. */
export function surfaceKeyOf(entries) {
  const key = (message) => {
    const clone = structuredClone(message)
    delete clone.id
    if (clone.source && typeof clone.source === 'object') delete clone.source.rpcId
    return stableValue(clone)
  }
  return JSON.stringify(entries.map((entry) => key(entry.message)))
}

function surfaceOpRange(start, end, shape) {
  return shape?.startKey === 'startSeq'
    ? { op: 'replace', startSeq: start, endSeq: end }
    : { op: 'replace', start, end }
}

/**
 * Plan the append-only replay that makes the live surface equal `target`.
 *
 * Shape (same two-segment structure the marker writer uses):
 *   `compaction/prune` (shadow-price claim) → `system/message` carrying
 *   `surfaceOp:{op:'replace'}` → re-appended target messages (inside balanced
 *   step envelopes; no request/header, no usage ⇒ no model work is started).
 * An empty replacement system message derives to no message, so the restored
 * surface is exactly the checkpoint surface.
 *
 * @param {Array<object>} events
 * @param {Array<ReturnType<typeof surfaceEntriesOf>[number]>} target
 * @param {object} options
 * @param {Function} [options.fold]
 * @param {(message: object) => number|null} [options.estimateTokens]
 * @param {object} [options.surfaceOpShape]
 * @returns {{planned: Array<object>, removed: number[], common: number}}
 */
export function planCheckpointReplay(events, target, { fold, estimateTokens, surfaceOpShape = runtimeSurfaceOpShape() } = {}) {
  const folded = (fold ?? ((list) => foldSurface(list)))(events)
  const nodes = Array.isArray(folded?.nodes) ? folded.nodes : []
  const current = surfaceEntriesOf(events, fold)
  let common = 0
  while (common < target.length && common < current.length
    && surfaceKeyOf([target[common]]) === surfaceKeyOf([current[common]])) common += 1
  const keepEnd = common ? nodes.indexOf(current[common - 1].seq) : -1
  const removed = nodes.filter((_seq, index) => index > keepEnd)
  const planned = []
  const add = (type, data, extra = {}) => {
    const event = { seq: events.length + planned.length, time: Date.now(), type, data, ...extra }
    planned.push(event)
    return event
  }
  const turn = events.reduce((max, event) => Math.max(max, Number.isSafeInteger(event.data?.turn) ? event.data.turn : 0), 0)
  let step = events.reduce((max, event) => Math.max(max, event.data?.turn === turn && Number.isSafeInteger(event.data?.step) ? event.data.step : 0), 0) + 1
  const withinStep = (fn) => {
    add('step/start', { turn, step })
    fn()
    add('step/end', { turn, step })
    step += 1
  }
  const emptySystem = () => ({
    message: { id: `restore-empty-${randomUUID()}`, role: 'system', content: [], source: { kind: 'system-prompt' } },
  })
  const priceOf = (seqs) => {
    let total = 0
    for (const seq of seqs) {
      const message = deriveEventMessage(events[seq], folded?.projectedMessages)
      if (message === null || message === undefined) continue
      const price = typeof estimateTokens === 'function' ? estimateTokens(message) : null
      if (!Number.isSafeInteger(price) || price < 0) throw editorError('meter-unavailable', 'Checkpoint restore needs the official token price for the shadowed nodes')
      total += price
    }
    return total
  }
  const replacement = (seqs, data) => {
    if (seqs.length === 0) return
    const audit = add('compaction/prune', {
      shadowedRange: { start: seqs[0], end: seqs[seqs.length - 1] },
      shadowedSeqs: [...seqs],
      shadowedTokenCount: priceOf(seqs),
    })
    add('system/message', data, {
      surfaceOp: surfaceOpRange(seqs[0], seqs[seqs.length - 1], surfaceOpShape),
      sourceEventSeqs: [audit.seq, ...seqs],
    })
  }
  const head = nodes.length > 0 && events[nodes[0]]?.type === 'system/message' ? nodes[0] : null
  const targetHead = target[0]?.event?.type === 'system/message' ? target[0] : null
  const rewriteHead = common === 0 && head !== null
  if (removed.length > 0) {
    withinStep(() => {
      if (rewriteHead) {
        replacement([head], targetHead
          ? { message: { ...structuredClone(targetHead.message), id: `restore-message-${randomUUID()}` } }
          : emptySystem())
      }
      replacement(rewriteHead ? removed.filter((seq) => seq !== head) : removed, emptySystem())
    })
  }
  for (const [index, entry] of target.entries()) {
    if (index < common || (entry === targetHead && rewriteHead)) continue
    const type = entry.event.type
    const message = { ...structuredClone(entry.message), id: `restore-message-${randomUUID()}` }
    if (type === 'user/message') add(type, message, { surfaceOp: 'append' })
    else {
      withinStep(() => {
        const data = { ...structuredClone(entry.event.data), message }
        delete data.usage
        if (type === 'assistant/message') data.stream ??= []
        add(type, data, { surfaceOp: 'append' })
      })
    }
  }
  return { planned, removed, common }
}

/**
 * Validate a planned batch with dsh-log-contract **before** anything lands.
 * Baseline differencing mirrors `lib/prewrite-guard.js`: a violation that the
 * existing log already had must not block this restore (only our new rows can).
 * @throws editorError('restore-rejected') on any new error-level violation
 */
export async function validateReplayBatch(session, events, planned, { prewriterFactory, log = () => {} } = {}) {
  let factory = prewriterFactory
  if (typeof factory !== 'function') {
    try {
      factory = (await import('dsh-log-contract')).createPreWriter
    } catch (error) {
      log(`retrace: checkpoint restore contract guard unavailable (dsh-log-contract not loadable): ${String(error)}`)
      return
    }
  }
  const ownTypes = new Set(planned.map((event) => event.type))
  const normalise = (list) => list.map((event) => (
    event && event.ignorable !== true && !ownTypes.has(event.type) ? { ...event, ignorable: true } : event
  ))
  const baseline = normalise(events)
  const keyOf = (violation) => `${violation?.id}|${violation?.message}`
  let baselineKeys = new Set()
  try {
    const verdict = factory({ events: baseline, header: session?.header ?? null }).validateEdit(baseline)
    baselineKeys = new Set((verdict?.violations ?? []).map(keyOf))
  } catch { /* baseline unavailable ⇒ keep the strict side */ }
  const full = [...baseline, ...normalise(planned)]
  let verdict
  try {
    verdict = factory({ events: full, header: session?.header ?? null }).validateEdit(full)
  } catch (error) {
    throw editorError('restore-rejected', `Checkpoint restore rejected by the pre-write contract: ${String(error?.message ?? error)}`)
  }
  if (verdict?.ok !== false) return
  // Kernel-version drift rules (same set prewrite-guard excludes, see that file).
  const drift = new Set(['E6', 'E9'])
  const ours = (verdict.violations ?? []).filter((violation) => !drift.has(violation?.id) && !baselineKeys.has(keyOf(violation)))
  if (ours.length > 0) {
    const detail = ours.slice(0, 6).map((violation) => `[${violation.id}] ${violation.message}`).join(' | ').slice(0, 600)
    log(`retrace: checkpoint restore rejected by contract guard: ${detail}`)
    throw editorError('restore-rejected', `Checkpoint restore rejected by the pre-write contract: ${detail}`)
  }
}

/**
 * Create the checkpoint restore service.
 * @param {object} deps
 * @param {object} deps.ctx - host context (`fs`, `sandboxPolicy`)
 * @param {object} deps.sessions - session registry (`get` / `flush` / `messageProjections`)
 * @param {object} deps.seam - versioning seam (`agentOf` / `referencedShas`)
 * @param {object} deps.preimages - lib/preimage-store instance (shared with Batch1)
 * @param {Function} [deps.estimateTokens] - official per-message token price
 * @param {Function} [deps.prewriterFactory] - test injection (dsh-log-contract)
 * @param {Function} [deps.fold] - test injection (kernel foldSurface)
 * @param {() => number} [deps.now]
 * @param {(line: string) => void} [deps.log]
 */
export function createCheckpointRestore({
  ctx, sessions, seam, preimages, estimateTokens, prewriterFactory, fold, now = () => Date.now(), log = () => {},
} = {}) {
  if (!preimages) throw new Error('createCheckpointRestore requires a preimage store')
  const tickets = new Map()
  const foldEvents = fold ?? ((events) => foldSurfaceWithProjections(foldSurface, events, messageProjectionsOf(sessions)))
  const surfaceOpShape = runtimeSurfaceOpShape()

  const sessionOf = (sessionId) => {
    const session = sessions?.get?.(sessionId)
    if (!session) throw editorError('session-not-found', `session "${sessionId}" not found`)
    return session
  }
  const cwdOf = (session) => (typeof session.header?.cwd === 'string' && session.header.cwd !== '' ? session.header.cwd : null)

  function requireIdle(session) {
    const agent = seam?.agentOf?.(session.id)
    if (agent && typeof agent.status === 'string' && agent.status === 'running') {
      throw editorError('agent-busy', '请先停止当前回复，再恢复检查点。')
    }
  }

  /** Resolve a record path inside the workspace (no escape, no `.git`/`node_modules`). */
  async function targetOf(session, path, expectedKey) {
    const cwd = cwdOf(session)
    if (!cwd) throw editorError('no-workspace', 'Workspace unavailable')
    const lexical = resolve(cwd, path)
    const rel = relative(cwd, lexical)
    if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw editorError('unsafe-path', 'outside-workspace')
    if (rel.split(/[\\/]/).some((part) => EXCLUDED_SEGMENTS.has(part.toLowerCase()))) throw editorError('unsafe-path', 'excluded-path')
    const target = await ctx.fs.resolve(path, { cwd })
    const workspace = await ctx.fs.resolve('.', { cwd })
    if (!ctx.fs.contains(workspace, target) || targetKeyOf(target) === targetKeyOf(workspace)) throw editorError('unsafe-path', 'outside-workspace')
    const key = targetKeyOf(target)
    if (expectedKey !== undefined && expectedKey !== null && key !== expectedKey) throw editorError('unsafe-path', 'path-changed')
    return { target, key }
  }

  /** Current on-disk state of one file (bounded, race-checked). */
  async function currentOf(target) {
    const stat = await ctx.fs.stat(target)
    if (!stat) return { exists: false, bytes: null, text: null, version: null }
    if (stat.type !== 'file' || stat.size > CHECKPOINT_MAX_FILE_BYTES) throw editorError('unsupported', 'not-text-or-too-large')
    const version = statVersion(stat)
    if (version === null) throw editorError('unsupported', 'no-version-guard')
    if (typeof ctx.fs.readBytes !== 'function') throw editorError('unsupported', 'no-bounded-read')
    const bytes = await ctx.fs.readBytes(target, undefined, CHECKPOINT_MAX_FILE_BYTES)
    if ((await ctx.fs.stat(target))?.version !== stat.version) throw editorError('file-conflict', 'capture-raced')
    return { exists: true, bytes, text: textOf(bytes), version }
  }

  /**
   * One row per planned file: `skip` (already at the checkpoint content), or
   * `restore` / `delete` with the current CAS token.
   */
  async function planFiles(session, record) {
    const rows = []
    for (const file of record.files) {
      try {
        const { target } = await targetOf(session, file.path, file.key)
        const current = await currentOf(target)
        if (!current.exists) {
          if (file.sha256 === null) { rows.push({ path: file.path, key: file.key, action: 'skip', reason: 'unchanged' }); continue }
          rows.push({ path: file.path, key: file.key, sha256: file.sha256, action: 'restore', version: null })
          continue
        }
        if (file.sha256 !== null && sha256Of(current.bytes) === file.sha256) {
          rows.push({ path: file.path, key: file.key, action: 'skip', reason: 'unchanged' })
          continue
        }
        rows.push({
          path: file.path,
          key: file.key,
          sha256: file.sha256,
          action: file.sha256 === null ? 'delete' : 'restore',
          version: current.version,
        })
      } catch (error) {
        rows.push({ path: file.path, key: file.key ?? null, action: 'skip', reason: error?.code ?? 'unreadable' })
      }
    }
    return rows
  }

  const deletionSupported = () => [ctx.fs?.withLock, ctx.fs?.checkedTarget, ctx.fs?.processPath].every((fn) => typeof fn === 'function')

  /**
   * Delete one file through the sandbox's own lock/identity path. Missing APIs
   * are reported explicitly (`unsupported`) — never a weaker `rm` fallback.
   */
  async function removeFile(session, target) {
    if (!deletionSupported()) throw editorError('unsupported', 'delete-unavailable')
    const policy = ctx.sandboxPolicy?.resolve?.({ session })
    return ctx.fs.withLock(targetKeyOf(target), async () => {
      const checked = await ctx.fs.checkedTarget(target, policy)
      if (!checked || targetKeyOf(checked) !== targetKeyOf(target)) throw editorError('unsafe-path', 'target-changed')
      const path = ctx.fs.processPath(checked)
      if (typeof path !== 'string' || !isAbsolute(path)) throw editorError('unsafe-path', 'target-changed')
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink()) throw editorError('unsafe-path', 'target-changed')
      await unlink(path)
    })
  }

  /** Preimage of the restore itself (so this restore can be undone later). */
  async function captureRestorePreimage(session, rows) {
    const events = sessionEvents(session)
    const files = []
    let complete = true
    for (const row of rows) {
      try {
        const { target } = await targetOf(session, row.path)
        const current = await currentOf(target)
        if (!current.exists) { files.push({ path: row.path, key: targetKeyOf(target), version: null, sha256: null, size: 0 }); continue }
        const saved = await preimages.objectStore.save(current.bytes)
        files.push({ path: row.path, key: targetKeyOf(target), version: current.version, sha256: saved.sha256, size: saved.sizeBytes })
      } catch (error) {
        complete = false
        log(`retrace: checkpoint restore preimage capture degraded for ${row.path}: ${String(error?.message ?? error)}`)
      }
    }
    return preimages.append(session.id, {
      versionId: `cp-${randomUUID()}`,
      cutSeq: events.at(-1)?.seq ?? -1,
      kind: 'restore',
      createdAt: now(),
      files,
      filesComplete: complete,
      warnings: complete ? [] : ['capture-incomplete'],
    })
  }

  async function previewCheckpoint(sessionId, versionId) {
    const session = sessionOf(sessionId)
    await preimages.prunePending(sessionId, { maxAgeMs: CHECKPOINT_PENDING_MAX_AGE_MS, at: now() })
    const records = await preimages.records(sessionId)
    const record = records.find((candidate) => candidate.versionId === versionId)
    if (!record) throw editorError('version-not-found', `checkpoint "${versionId}" not found in session "${sessionId}"`)
    const events = sessionEvents(session)
    if (!Number.isSafeInteger(record.cutSeq) || record.cutSeq < 0 || record.cutSeq >= events.length) {
      throw editorError('version-invalid', 'Checkpoint cut position is not inside the live log')
    }
    const target = surfaceEntriesOf(events.slice(0, record.cutSeq + 1), foldEvents)
    const current = surfaceEntriesOf(events, foldEvents)
    const changed = surfaceKeyOf(target) !== surfaceKeyOf(current)
    const unavailable = record.filesUnavailable === true || record.filesComplete === false
    const rows = unavailable
      ? record.files.map((file) => ({ path: file.path, key: file.key, action: 'skip', reason: 'snapshot-incomplete' }))
      : await planFiles(session, record)
    const token = randomUUID()
    for (const [key, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(key)
    tickets.set(token, {
      token,
      sessionId,
      versionId,
      cut: events.length,
      surfaceKey: surfaceKeyOf(current),
      targetKey: surfaceKeyOf(target),
      changed,
      files: rows.map(({ path, key, version, action, sha256, reason }) => ({ path, key, version: version ?? null, action, sha256: sha256 ?? null, reason: reason ?? null })),
      expires: now() + CHECKPOINT_TICKET_TTL_MS,
    })
    return {
      versionId,
      kind: record.kind,
      cutSeq: record.cutSeq,
      token,
      expiresInMs: CHECKPOINT_TICKET_TTL_MS,
      context: { messages: changed ? target.length : 0, changed },
      artifacts: { rows: rows.map(({ path, action, reason }) => ({ path, action, ...(reason ? { reason } : {}) })) },
      applicable: changed || rows.some((row) => row.action !== 'skip'),
    }
  }

  async function executeCheckpoint(ticketOrArgs) {
    const token = String(typeof ticketOrArgs === 'string' ? ticketOrArgs : ticketOrArgs?.token ?? ticketOrArgs?.previewToken ?? '')
    const ticket = tickets.get(token)
    tickets.delete(token)
    const requestedSession = typeof ticketOrArgs?.sessionId === 'string' ? ticketOrArgs.sessionId : null
    if (!ticket || ticket.expires <= now() || (requestedSession !== null && requestedSession !== ticket.sessionId)) {
      throw editorError('preview-expired', '请先预览，再确认恢复（预览已过期或不存在）。')
    }
    const session = sessionOf(ticket.sessionId)
    requireIdle(session)
    const events = sessionEvents(session)
    if (events.length !== ticket.cut) throw editorError('preview-expired', '会话已变化，请刷新预览后再恢复。')
    const current = surfaceEntriesOf(events, foldEvents)
    if (surfaceKeyOf(current) !== ticket.surfaceKey) throw editorError('preview-expired', '会话已变化，请刷新预览后再恢复。')
    return executeWithTicket(session, ticket)
  }

  /** Shared body: revalidate the pinned files, capture the restore preimage, replay, write files. */
  async function executeWithTicket(session, ticket) {
    const record = (await preimages.records(session.id)).find((candidate) => candidate.versionId === ticket.versionId)
    if (!record) throw editorError('version-not-found', 'Checkpoint record disappeared')
    const events = sessionEvents(session)
    const target = surfaceEntriesOf(events.slice(0, record.cutSeq + 1), foldEvents)
    if (surfaceKeyOf(target) !== ticket.targetKey) throw editorError('preview-expired', '检查点目标已变化，请刷新预览。')

    // Files: validate every pinned row before any write (CAS + path identity).
    const actionable = []
    for (const row of ticket.files) {
      if (row.action === 'skip') continue
      const { target: fileTarget } = await targetOf(session, row.path, row.key)
      const current = await currentOf(fileTarget)
      if (row.action === 'delete') {
        if (!current.exists || current.version !== row.version) throw editorError('file-conflict', `文件已变化：${row.path}`)
      } else if (row.version === null) {
        if (current.exists) throw editorError('file-conflict', `文件已变化：${row.path}`)
      } else if (!current.exists || current.version !== row.version) {
        throw editorError('file-conflict', `文件已变化：${row.path}`)
      }
      actionable.push({ ...row, target: fileTarget })
    }

    // ① Preimage of the restore itself — before the first write.
    let restoreRecord = null
    let warnings = []
    try {
      restoreRecord = await captureRestorePreimage(session, actionable)
      if (restoreRecord.filesComplete === false) warnings = ['capture-incomplete']
    } catch (error) {
      warnings = ['capture-unavailable']
      log(`retrace: checkpoint restore preimage unavailable (restore proceeds): ${String(error?.message ?? error)}`)
    }

    // ② Conversation replay (validated whole batch ⇒ zero append on rejection).
    let contextMessages = 0
    if (ticket.changed) {
      const plan = planCheckpointReplay(events, target, { fold: foldEvents, estimateTokens, surfaceOpShape })
      await validateReplayBatch(session, events, plan.planned, { prewriterFactory, log })
      const full = [...events, ...plan.planned]
      let restored
      try {
        restored = surfaceEntriesOf(full, foldEvents)
      } catch (error) {
        throw editorError('restore-rejected', `Checkpoint restore failed its fold assertion: ${String(error?.message ?? error)}`)
      }
      if (surfaceKeyOf(restored) !== surfaceKeyOf(target)) {
        throw editorError('restore-rejected', 'Checkpoint restore would not reproduce the checkpoint surface; nothing was appended.')
      }
      for (const event of plan.planned) {
        if (event.surfaceOp !== undefined) {
          session.append(event.type, event.data, {
            surfaceOp: event.surfaceOp,
            ...(event.sourceEventSeqs ? { sourceEventSeqs: event.sourceEventSeqs } : {}),
          })
        } else {
          session.append(event.type, event.data)
        }
      }
      contextMessages = target.length
      try { await sessions.flush?.(session) } catch (error) { log(`retrace: checkpoint restore flush failed: ${String(error)}`) }
    }

    // ③ File write-back (CAS), per-file results, partial completion reported.
    const artifacts = []
    for (const row of actionable) {
      try {
        if (row.action === 'delete') {
          if (!deletionSupported()) { artifacts.push({ path: row.path, status: 'unsupported', reason: 'delete-unavailable' }); continue }
          await removeFile(session, row.target)
          artifacts.push({ path: row.path, status: 'deleted' })
          continue
        }
        const text = textOf(await preimages.objectStore.read(row.sha256))
        const policy = ctx.sandboxPolicy?.resolve?.({ session })
        await ctx.fs.writeText(row.target, text, row.version === null ? { kind: 'createIfAbsent' } : replaceIfVersion(row.version), undefined, policy)
        artifacts.push({ path: row.path, status: 'restored' })
      } catch (error) {
        artifacts.push({ path: row.path, status: 'failed', reason: error?.code ?? 'write-failed' })
      }
    }
    const complete = artifacts.every((row) => ['restored', 'deleted'].includes(row.status))
    return {
      versionId: ticket.versionId,
      complete,
      context: { messages: contextMessages },
      artifacts,
      ...(restoreRecord ? { checkpointId: restoreRecord.versionId } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  }

  /**
   * The session's checkpoint records as UI-safe metadata (no file bytes, no
   * paths of unreadable snapshots — the preview owns the per-file detail).
   */
  async function listCheckpoints(sessionId) {
    sessionOf(sessionId)
    await preimages.prunePending(sessionId, { maxAgeMs: CHECKPOINT_PENDING_MAX_AGE_MS, at: now() })
    const records = await preimages.records(sessionId)
    const checkpoints = records.slice().reverse().map((record) => ({
      versionId: record.versionId,
      kind: record.kind,
      cutSeq: record.cutSeq,
      createdAt: record.createdAt,
      fileCount: record.files.length,
      filesComplete: record.filesComplete !== false,
      filesUnavailable: record.filesUnavailable === true,
      pending: record.pending === true,
      warnings: Array.isArray(record.warnings) ? record.warnings : [],
    }))
    return { sessionId, checkpoints }
  }

  /** GC = checkpoint refs + live undo tickets + artifact-store refCounts (never delete a pinned object). */
  async function collectGarbage({ extraKeep = [] } = {}) {
    let artifactRefs = []
    try {
      artifactRefs = [...(seam?.referencedShas?.() ?? [])]
    } catch (error) {
      log(`retrace: checkpoint GC could not read artifact refCounts: ${String(error)}`)
    }
    return preimages.collect({ extraKeep: [...artifactRefs, ...extraKeep] })
  }

  const envelope = (fn) => async (args) => {
    try { return { ok: true, value: await fn(args) } }
    catch (error) { return { ok: false, error: { code: error?.code ?? 'internal', message: error?.message ?? String(error) } } }
  }

  return {
    previewCheckpoint,
    executeCheckpoint,
    listCheckpoints,
    list: envelope((args) => listCheckpoints(String(args?.sessionId ?? ''))),
    preview: envelope((args) => previewCheckpoint(String(args?.sessionId ?? ''), String(args?.versionId ?? ''))),
    execute: envelope((args) => executeCheckpoint(args)),
    collectGarbage,
    pruneTickets: () => { for (const [key, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(key) },
  }
}
