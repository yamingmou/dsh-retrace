/**
 * Regression: the marker producer must NOT fabricate the append seq.
 *
 * Real-machine incident (DSH Desktop 2.0.9, 2026-09-14): clicking edit or recall
 * failed with
 *   Marker write rejected by contract guard: [E2/error] seq 0 不连续：倒退（backward），
 *   期望 26033 —— 只能追加到日志尾部（append-only，N6）
 *   | [S6/error] sourceEventSeqs 必须引用更早事件：26032 >= 当前 seq 0
 *   | [S8/error] foldSurface 重放失败 … 会话加载会被拒（SessionPersistenceCorruptionError）
 *
 * Root cause was in `lib/adapter/dsh-writer.js`: the envelopes handed to
 * `validateMarker` were hardcoded `seq: 0`. `dsh-log-contract`'s
 * `createPreWriter.validateAppend` treats a PRESENT `seq` as authoritative — it
 * only assigns `nextSeq` when `seq === undefined` — so once the guard saw the
 * real log tail the candidate was read as "backward to 0" (and the audit
 * reference 26032 looked like a forward reference). The guard correctly refused
 * to write; the producer was wrong.
 *
 * These tests run the REAL contract guard (no fake `prewriterFactory`) against a
 * production-shaped new-host fake (`helpers.makeSession()` default:
 * `snapshotEvents()` / `eventAt()`, no `events` member) and against an explicit
 * legacy fake, so the fix is pinned on both host generations.
 */
import { describe, it, expect } from 'vitest'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { makeSession, makeLegacySession } from './helpers.js'
import { sessionEvents } from '../lib/host-compat.js'
import { createDshMarkerWriter } from '../lib/adapter/dsh-writer.js'
import { createMarkerGuard } from '../lib/prewrite-guard.js'
import { officialSurfaceProjection, officialNodePrice, officialSurfaceMeter, deriveMessage } from './official-meter.js'

/** Mirrors the real machine's log tail (26033 = last seq 26032). */
const REAL_TAIL = 26033
const MODEL = { provider: 'test-provider', model: 'test-model' }
const SPAN = { start: 1, end: 2, shadowedSeqs: [1, 2] }

/**
 * A host-shaped session: a `request/header`, one user/assistant round carrying
 * `surfaceOp: 'append'`, then log-only `assistant/chunk` padding up to `tail`.
 * Version comes from the installed `@deepseek-ai/dsh-session` so the writer's
 * `runtimeSurfaceOpShape()` and the contract's format version agree.
 */
function buildSession(tail, { host = 'new' } = {}) {
  const session = host === 'legacy' ? makeLegacySession() : makeSession()
  session.header = { version: SESSION_FORMAT_VERSION, id: 's1', createdAt: 0, isSeeded: false }
  session.append('request/header', { header: { config: MODEL } })
  session.append(
    'user/message',
    { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } },
    { surfaceOp: 'append' },
  )
  session.append(
    'assistant/message',
    { turn: 0, step: 0, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'yo' }], source: { kind: 'model', ...MODEL } } },
    { surfaceOp: 'append' },
  )
  for (let i = session.seq; i < tail; i++) session.append('assistant/chunk', { turn: 0, step: 0, text: 'x' })
  return session
}

/** The production writer wired to the REAL prewrite guard + official meter. */
function makeRealWriter(log = () => {}) {
  const guard = createMarkerGuard({ log })
  return createDshMarkerWriter({ validateMarker: guard.validateMarkerAppend, meter: officialSurfaceMeter(), deriveMessage, log: () => {} })
}

describe('marker append seq — real-machine E2 regression (期望 26033, candidate 0)', () => {
  it('new host: carrier gets the real append seq; every reference is strictly earlier', async () => {
    const session = buildSession(REAL_TAIL)
    const before = session.seq
    expect(before).toBe(REAL_TAIL)
    expect('events' in session).toBe(false) // production shape: snapshotEvents()/eventAt() only

    const marker = await makeRealWriter().writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: 'hi' })

    // First append = audit (compaction/prune) at `before`; second = carrier at `before + 1`.
    expect(marker.seq).toBe(before + 1)
    expect(marker.sourceEventSeqs[0]).toBe(before)
    expect(marker.sourceEventSeqs).toEqual([before, 1, 2])
    expect(marker.sourceEventSeqs.every((seq) => seq < marker.seq)).toBe(true)
    expect(session.eventAt(before)?.type).toBe('compaction/prune')
    expect(session.eventAt(marker.seq)).toBe(marker)
  })

  it('legacy host (events array only): same correct append seq', async () => {
    const session = buildSession(1000, { host: 'legacy' })
    const before = session.seq
    expect(Array.isArray(session.events)).toBe(true)

    const marker = await makeRealWriter().writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: 'hi' })

    expect(marker.seq).toBe(before + 1)
    expect(marker.sourceEventSeqs[0]).toBe(before)
    expect(marker.sourceEventSeqs.every((seq) => seq < marker.seq)).toBe(true)
  })

  it('producer unit: the envelopes handed to validateMarker carry no fabricated seq', async () => {
    const session = buildSession(64)
    const seen = []
    const writer = createDshMarkerWriter({
      validateMarker: async (_session, envelope, extra) => { seen.push({ envelope, extra }) },
      meter: officialSurfaceMeter(),
      deriveMessage,
      log: () => {},
    })
    await writer.writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: 'hi' })

    expect(seen.map(({ extra }) => extra?.phase)).toEqual(['pre', 'pair'])
    for (const { envelope } of seen) {
      expect(Object.hasOwn(envelope, 'seq')).toBe(false) // seq is unknown until append
    }
    // pair phase hands the planned audit segment + its predicted seq to the guard
    expect(seen[1].extra?.auditSeq).toBe(64)
    expect(seen[1].extra?.audit?.shadowedSeqs).toEqual([1, 2])
  })

  it('guard names a fabricated seq instead of emitting the E2/S6/S8 triple', async () => {
    const session = buildSession(64)
    const guard = createMarkerGuard({ log: () => {} })
    const fabricated = {
      seq: 0, // the historical producer bug
      type: 'user/message',
      data: { role: 'user', id: 'retrace-recall-x', content: [{ type: 'text', text: 'x' }], source: { kind: 'model', ...MODEL } },
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1, 2],
    }
    await expect(guard.validateMarkerAppend(session, fabricated, { phase: 'post' }))
      .rejects.toThrow(/must OMIT seq/)
    // the named message is diagnosable: it says what the live tail implies
    await expect(guard.validateMarkerAppend(session, fabricated, { phase: 'post' }))
      .rejects.toThrow(/implies 64/)
  })
})

/**
 * 本轮整改 §四.3: the guard used to reject the carrier **after** the audit was
 * already appended, leaving an orphan `compaction/prune` (the real machine left
 * seq 26032/26033). Now the whole two-segment sequence is validated BEFORE any
 * append, so a rejection writes nothing.
 */
describe('two-segment pairing (no orphan audit on rejection)', () => {
  it('negative control: a pair the contract rejects leaves NO audit orphan (zero writes)', async () => {
    const session = buildSession(64)
    // Force a contract-level rejection: the writer emits the runtime surfaceOp
    // shape (v0 for the installed package) while the header claims the opposite
    // version, so S4/S8 fire — at PAIR time now, not after appending segment 1.
    session.header = { ...session.header, version: SESSION_FORMAT_VERSION === 0 ? 3 : 0 }
    const before = session.seq

    await expect(makeRealWriter().writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: 'hi' }))
      .rejects.toThrow(/S4|S8|marker-rejected/)

    expect(session.seq).toBe(before) // zero writes: no audit orphan
    expect(sessionEvents(session).some((e) => e?.type === 'compaction/prune')).toBe(false)
  })

  it('positive: audit + carrier are adjacent, and the host fold consumes the claim (no orphan, no drift)', async () => {
    const session = buildSession(64)
    const carrier = await makeRealWriter().writeMarker(session, SPAN, { op: 'recall', targetSeq: 1, originalText: 'hi' })
    const all = sessionEvents(session)
    const audit = all[all.indexOf(carrier) - 1]

    // 判据取自 lib/marker-carrier.js:23 / :32 —— 首元素 = 第 1 段 seq,且两段紧邻
    expect(audit.type).toBe('compaction/prune')
    expect(carrier.sourceEventSeqs[0]).toBe(audit.seq)
    expect(carrier.seq).toBe(audit.seq + 1)

    // The host's own shadow-price fold (dsh-token-meter surface-projection):
    // the claim armed by our audit is consumed by our carrier, and NO claim
    // survives — a surviving orphan claim is what makes the next replace fold
    // with zero delta and drift contextPressure.surfaceTokens.
    const armed = officialSurfaceProjection.foldSurfaceProjection(undefined, audit)
    expect(armed.claim).toBeDefined()
    const consumed = officialSurfaceProjection.foldSurfaceProjection(armed.claim, carrier)
    expect(consumed.claim).toBeUndefined()
    expect(consumed.deltaTokens).toBe(officialNodePrice(carrier) - audit.data.shadowedTokenCount)
  })
})

/**
 * 本轮整改 §四.4 — WHY `contextPressure.surfaceTokens` can fail to converge.
 *
 * These are HOST fields (`@deepseek-ai/dsh-token-meter`), not the plugin's; the
 * plugin never reads or writes them. But our two-segment writes feed the host's
 * shadow-price fold, so this pins the host contract our adjacency guarantee
 * relies on: a surface `replace` only subtracts the replaced range when an
 * adjacent `compaction/prune` armed a claim for the SAME range. Otherwise it
 * folds with ZERO delta (host-documented "possible drift"), and an armed claim
 * for a DIFFERENT range makes the host fold throw.
 */
describe('host shadow-price fold (the drift mechanism behind surfaceTokens)', () => {
  const prune = (seq, start, end, tokens) => ({ seq, type: 'compaction/prune', data: { shadowedRange: { start, end }, shadowedSeqs: [start, end], shadowedTokenCount: tokens } })
  const replace = (seq, start, end) => ({ seq, type: 'user/message', surfaceOp: { op: 'replace', start, end }, data: { role: 'user', id: `retrace-x-${seq}`, content: [{ type: 'text', text: 'r' }], source: { kind: 'model', ...MODEL } } })
  const fold = (log) => {
    let claim
    let total = 0
    for (const event of log) {
      const result = officialSurfaceProjection.foldSurfaceProjection(claim, event)
      claim = result.claim
      total += result.deltaTokens
    }
    return { total, claim }
  }

  it('with an adjacent matching claim the total drops; without any claim it folds ZERO (drift)', () => {
    expect(fold([prune(1, 0, 0, 1000), replace(2, 0, 0)]).total).toBeLessThan(0)
    expect(fold([replace(1, 0, 0)]).total).toBe(0) // zero delta: the range is never subtracted
  })

  it('an orphan claim + an adjacent DIFFERENT-range replace makes the host fold throw', () => {
    expect(() => fold([prune(1, 0, 0, 1000), replace(2, 5, 5)])).toThrow(/no adjacent shadow price/)
  })

  it('two adjacent orphan prunes: the first claim is overwritten and the last is expired by the next event', () => {
    const { claim } = fold([prune(1, 0, 0, 878), prune(2, 0, 0, 878), { seq: 3, type: 'user/message', surfaceOp: 'append', data: { role: 'user', id: 'u3', content: [{ type: 'text', text: 'x' }], source: { kind: 'user' } } }])
    expect(claim).toBeUndefined() // nothing survives to price the next replace
  })
})
