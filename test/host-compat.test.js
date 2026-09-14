/**
 * Host event-view compatibility — regression guard for the DSH Desktop 2.0.9
 * incident.
 *
 * `@deepseek-ai/dsh-session@0.1.5-rc.1` removed the public `events` member from
 * Session (no instance field, no getter): the append-only log is reachable only
 * through `snapshotEvents()` / `eventAt(seq)`. Reading the old member made
 * `findMessageSeq` / `lastModelSource` throw
 *   TypeError: Cannot read properties of undefined (reading 'length')
 * before any write — so recall (撤回) and edit (编辑) both died silently.
 *
 * These tests pin BOTH host generations:
 *   - new host: ONLY `snapshotEvents()` / `eventAt()` — `events` is absent, so
 *     any surviving direct read throws again (the fake has no such member);
 *   - old host: ONLY the `events` array (index semantics identical).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sessionEvents, eventAt, sessionIds, resetHostCompatDiagnostics } from '../lib/host-compat.js'
import { lastModelSource } from '../lib/host-core.js'
import { makeSession, makeLegacySession, makeApi, makeAgent, headerEvent, userMessage, assistantMessage } from './helpers.js'

/**
 * A fake shaped like DSH 2.0.9's Session: the event array is kept in a closure
 * and exposed **only** through the new API — `session.events` does not exist.
 * `helpers.makeSession()` now defaults to exactly this production shape.
 */
function newHostSession() {
  return makeSession()
}

/** Legacy host: the `events` array is the only view (explicit override). */
function oldHostSession() {
  return makeLegacySession()
}

const seed = (session) => session.seed(
  headerEvent(),
  userMessage('u1', 'hello world'),
  assistantMessage('a1', 'hi there'),
)

// One-shot diagnostics are process-global; reset between tests so call counts
// stay deterministic regardless of execution order.
beforeEach(() => { resetHostCompatDiagnostics() })

describe('host-compat accessors', () => {
  it('new host: sessionEvents reads snapshotEvents(); eventAt reads eventAt(seq)', () => {
    const session = newHostSession()
    seed(session)
    expect('events' in session).toBe(false) // the incident shape: no such member
    expect(sessionEvents(session).length).toBe(3)
    expect(sessionEvents(session)[1].data.id).toBe('u1')
    expect(eventAt(session, 2).type).toBe('assistant/message')
    expect(eventAt(session, 99)).toBeUndefined()
  })

  it('old host: falls back to the events array (same ref, same seq indexing)', () => {
    const session = oldHostSession()
    seed(session)
    expect(sessionEvents(session)).toBe(session.events)
    expect(sessionEvents(session).length).toBe(3)
    expect(eventAt(session, 1).data.id).toBe('u1')
    expect(eventAt(session, 99)).toBeUndefined()
  })

  it('partial new host: snapshotEvents() without eventAt() still resolves by seq', () => {
    const session = oldHostSession()
    seed(session)
    session.snapshotEvents = () => Object.freeze(session.events.slice())
    expect(eventAt(session, 2).type).toBe('assistant/message')
  })

  it('a throwing new API degrades to the legacy view (diagnostic, no crash)', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const events = [{ seq: 0, type: 'user/message', data: { id: 'u1' } }]
    const session = {
      events,
      snapshotEvents: () => { throw new Error('host bug') },
      eventAt: () => { throw new Error('host bug') },
    }
    expect(sessionEvents(session)).toBe(events)
    expect(eventAt(session, 0)).toBe(events[0])
    // Two one-shot diagnostics (different shapes ⇒ different lines):
    // ① snapshotEvents() threw inside sessionEvents; ② eventAt() threw.
    // The inner snapshotEvents() retry on eventAt's fallback is deduped.
    expect(spy).toHaveBeenCalledTimes(2)
    const [first, second] = spy.mock.calls.map((call) => String(call[0]))
    expect(first).not.toBe(second)
    expect(first).toContain('snapshotEvents()')
    expect(second).toContain('eventAt(')
    spy.mockRestore()
  })

  it('missing session / missing view → empty log, undefined event', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(sessionEvents(null)).toEqual([])
    expect(sessionEvents(undefined)).toEqual([])
    expect(sessionEvents({})).toEqual([]) // object with no view → diagnosed once (see below)
    expect(eventAt(null, 0)).toBeUndefined()
    expect(eventAt({}, 0)).toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })
})

describe('lastModelSource on both host generations', () => {
  it('new host (snapshotEvents/eventAt only) resolves the provider/model', () => {
    const session = newHostSession()
    seed(session)
    expect(lastModelSource(session)).toEqual({ provider: 'test-provider', model: 'test-model' })
  })

  it('old host (events array only) resolves the provider/model', () => {
    const session = oldHostSession()
    seed(session)
    expect(lastModelSource(session)).toEqual({ provider: 'test-provider', model: 'test-model' })
  })
})

describe('message-id lookup (findMessageSeq) on both host generations', () => {
  it('new host: recall finds the target seq and rewinds the round', async () => {
    const session = newHostSession()
    seed(session)
    const agent = makeAgent()
    const api = makeApi(session, agent)
    const result = await api.recall({ sessionId: 's1', messageId: 'u1' })
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ op: 'recall', seq: 1, text: 'hello world' })
    expect(agent.followup).not.toHaveBeenCalled()
  })

  it('new host: edit finds the target seq and re-sends the replacement', async () => {
    const session = newHostSession()
    seed(session)
    const agent = makeAgent()
    const api = makeApi(session, agent)
    const result = await api.editAndResend({ sessionId: 's1', messageId: 'u1', text: 'edited text' })
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ op: 'edit', seq: 1, text: 'edited text', originalText: 'hello world' })
    expect(agent.followup).toHaveBeenCalledTimes(1)
  })

  it('new host: an unknown message id reports message-not-found (lookup returns -1, never throws)', async () => {
    const session = newHostSession()
    seed(session)
    const api = makeApi(session, makeAgent())
    const result = await api.recall({ sessionId: 's1', messageId: 'nope' })
    expect(result.ok).toBe(false)
    expect(result.error.code).toBe('message-not-found')
  })

  it('old host: same lookup + recall path stays green', async () => {
    const session = oldHostSession()
    seed(session)
    const agent = makeAgent()
    const api = makeApi(session, agent)
    const result = await api.recall({ sessionId: 's1', messageId: 'a1' })
    expect(result.ok).toBe(true)
    expect(result.value).toMatchObject({ op: 'recall', seq: 2 })
  })
})

/**
 *  (review): returning [] WITHOUT a diagnostic turns the
 * next host-API drift into an empty log — the exact shape of the incident.
 * These tests assert the *diagnostics*, not just the return values, and that
 * distinct broken shapes produce distinct, shape-fingerprinted lines.
 */
describe('host-compat diagnostics: silent [] is a bug ()', () => {
  const capture = () => {
    const lines = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line) => lines.push(String(line)))
    return { lines, restore: () => spy.mockRestore() }
  }

  it('sessionEvents: "no view at all" and "snapshot returns a non-array" are distinguishable', () => {
    const first = capture()
    expect(sessionEvents({ get: () => {}, append: () => {} })).toEqual([])
    expect(first.lines).toHaveLength(1)
    const noView = first.lines[0]
    first.restore()

    resetHostCompatDiagnostics()
    const second = capture()
    const broken = { snapshotEvents: () => ({ not: 'an array' }) }
    expect(sessionEvents(broken)).toEqual([])
    expect(second.lines).toHaveLength(1)
    const wrongShape = second.lines[0]
    second.restore()

    expect(noView).not.toBe(wrongShape)
    expect(noView).toContain('neither snapshotEvents() nor an events array')
    expect(noView).toContain('get') // shape fingerprint of the object
    expect(wrongShape).toContain('not an array')
    expect(wrongShape).toContain('not') // fingerprint of what snapshotEvents returned
  })

  it('sessionEvents: an events member that is not an array is diagnosed too', () => {
    const { lines, restore } = capture()
    expect(sessionEvents({ events: 'legacy-but-broken' })).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('neither snapshotEvents() nor an events array')
    restore()
  })

  it('sessionIds: a real empty store is silent; an unrecognized enumerator is diagnosed', () => {
    const { lines, restore } = capture()
    expect(sessionIds({ list: () => [] })).toEqual([])
    expect(lines).toEqual([]) // authoritative "no live sessions"
    restore()

    const bad = capture()
    expect(sessionIds({ list: () => ({ nope: true }) })).toEqual([])
    expect(bad.lines).toHaveLength(1)
    expect(bad.lines[0]).toContain('not an array')
    bad.restore()

    resetHostCompatDiagnostics()
    const missing = capture()
    expect(sessionIds({ get: () => undefined })).toEqual([])
    expect(missing.lines).toHaveLength(1)
    expect(missing.lines[0]).toContain('neither list() nor keys()')
    // the two failure modes are different diagnostics, not one generic noise line
    expect(bad.lines[0]).not.toBe(missing.lines[0])
    missing.restore()
  })

  it('sessionIds: list() entries without a string id are diagnosed', () => {
    const { lines, restore } = capture()
    expect(sessionIds({ list: () => [{ nope: 1 }, { other: 2 }] })).toEqual([])
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('none exposes a string id')
    restore()
  })

  it('sessionIds: list() wins over keys() (an empty list is authoritative)', () => {
    const { lines, restore } = capture()
    expect(sessionIds({ list: () => [], keys: () => ['k'] })).toEqual([])
    expect(lines).toEqual([])
    restore()
  })

  it('sessionIds: reads both generations and dedupes one-shot diagnostics', () => {
    const newHost = { list: () => [{ id: 's1' }, { id: 's2' }] }
    expect(sessionIds(newHost)).toEqual(['s1', 's2'])
    const legacy = { keys: () => ['k1', 'k2'] }
    expect(sessionIds(legacy)).toEqual(['k1', 'k2'])

    // one-shot: the same broken shape logs once even when probed repeatedly
    const { lines, restore } = capture()
    sessionIds({ get: () => undefined })
    sessionIds({ get: () => undefined })
    sessionIds({ get: () => undefined })
    expect(lines).toHaveLength(1)
    restore()
  })
})
