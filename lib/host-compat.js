/**
 * dsh-retrace — lib/host-compat.js
 *
 * Host event-view compatibility accessors (single source of truth).
 *
 * DSH Desktop 2.0.9 (@deepseek-ai/dsh-session 0.1.5-rc.1) removed the public
 * event array from Session: the append-only log is reachable only through
 * `snapshotEvents()` (cached immutable full snapshot, indexed by seq) and
 * `eventAt(seq)` (one event at one exact seq). Older hosts expose a plain
 * `events` array with the same indexing (`events[i].seq === i`).
 *
 * Every host-event read in this plugin MUST go through these two accessors.
 * Reading the old member directly throws
 *   TypeError: Cannot read properties of undefined (reading 'length')
 * on the new host — that is exactly the "cannot recall / cannot edit"
 * incident (lib/host-core.js lastModelSource / findMessageSeq read the log
 * before any write, so both ops died before touching the session).
 *
 * Rules:
 *  - New API first (`snapshotEvents` / `eventAt`), legacy array second.
 *    The legacy path stays: both host generations stay supported.
 *  - A throwing or unrecognized view degrades to [] WITHOUT crashing, but it
 *    always leaves a one-shot diagnostic carrying a shape fingerprint — a
 *    silent empty log is how the incident stayed hidden. "Return [] and say
 *    nothing" is a bug, not resilience.
 *  - Import-free by design: the dynamic-plugin generator inlines this module
 *    into lib/dynamic-host.js, where module resolution is unavailable.
 */

/** Diagnostic line for a degraded or fallback read (never throws). */
function diagnose(line) {
  try {
    if (typeof console !== 'undefined' && typeof console.error === 'function') console.error(line)
  } catch { /* diagnostics must never break a read */ }
}

/** One-shot memory: a shape can only drift once per process; do not spam. */
const diagnosed = new Set()

/**
 * Emit `line` once per `key`. The key carries the shape fingerprint, so two
 * different broken shapes still produce two different, distinguishable lines.
 */
function diagnoseOnce(key, line) {
  if (diagnosed.has(key)) return
  diagnosed.add(key)
  diagnose(line)
}

/** Test-only: clear the one-shot diagnostic memory. */
export function resetHostCompatDiagnostics() {
  diagnosed.clear()
}

/** Bounded shape fingerprint for diagnostics (never throws). */
function shapeOf(value) {
  try {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    const type = typeof value
    if (type !== 'object' && type !== 'function') return type
    const keys = Object.keys(value)
    const head = keys.slice(0, 6).join(',')
    return `{${head}${keys.length > 6 ? ',…' : ''}}`
  } catch {
    return '<unreadable>'
  }
}

/**
 * The session's event log as an array indexed by seq.
 * @param {object} [session]
 * @returns {Array<object>} snapshot on new hosts, legacy array on old hosts, [] when neither exists
 */
export function sessionEvents(session) {
  if (!session) return []
  let legacy
  try {
    legacy = session.events
  } catch (error) {
    diagnoseOnce(
      `session-events:legacy-threw:${shapeOf(session)}`,
      `retrace: reading the legacy event view threw (${String(error)}); returning an empty log`,
    )
    return []
  }
  const hasLegacy = Array.isArray(legacy)
  const hasNewApi = typeof session.snapshotEvents === 'function'
  if (hasNewApi) {
    try {
      const snapshot = session.snapshotEvents()
      if (Array.isArray(snapshot)) return snapshot
      diagnoseOnce(
        `session-events:snapshot-not-array:${shapeOf(snapshot)}`,
        `retrace: session.snapshotEvents() returned ${shapeOf(snapshot)}, not an array; falling back to the legacy event view`,
      )
    } catch (error) {
      diagnoseOnce(
        `session-events:snapshot-threw:${shapeOf(session)}`,
        `retrace: session.snapshotEvents() threw (${String(error)}); falling back to the legacy event view`,
      )
    }
  }
  if (hasLegacy) return legacy
  // Only the "no API at all" case gets the generic line: when snapshotEvents()
  // exists but misbehaved, its own shape diagnostic above is the specific one.
  if (!hasNewApi) {
    diagnoseOnce(
      `session-events:no-view:${shapeOf(session)}`,
      `retrace: session exposes neither snapshotEvents() nor an events array (shape ${shapeOf(session)}) — the host API may have drifted; returning an empty log`,
    )
  }
  return []
}

/**
 * The next append position of the session log.
 *
 * Same formula as `dsh-log-contract`'s `createPreWriter` nextSeq:
 * `baseSeq = 0` then `max(seq) + 1`, with `seq`-less events counted
 * positionally. Producers need this to validate a **planned** two-segment
 * write (audit + carrier) *before* appending either segment — see
 * lib/adapter/dsh-writer.js (a post-append rejection left an
 * orphan `compaction/prune`).
 *
 * @param {object} [session]
 * @returns {number} non-negative next append seq
 */
export function nextAppendSeq(session) {
  const events = sessionEvents(session)
  let expected = 0
  for (const event of events) {
    const seq = Number.isSafeInteger(event?.seq) ? event.seq : expected
    if (seq + 1 > expected) expected = seq + 1
  }
  return expected
}

/**
 * One event at one exact sequence number.
 * @param {object} [session]
 * @param {number} seq - non-negative sequence number
 * @returns {object|undefined}
 */
export function eventAt(session, seq) {
  if (!session) return undefined
  if (typeof session.eventAt === 'function') {
    try {
      const event = session.eventAt(seq)
      if (event !== undefined) return event
    } catch (error) {
      diagnoseOnce(
        `session-event-at:threw:${shapeOf(session)}`,
        `retrace: session.eventAt(${String(seq)}) threw (${String(error)}); falling back to snapshot indexing`,
      )
    }
  }
  return sessionEvents(session)[seq]
}

/**
 * Enumerate the ids of all live sessions from a sessions service.
 *
 * Measured hosts (`@deepseek-ai/dsh-session` 0.1.0-rc.7 and 0.1.5-rc.1) both
 * expose `list()` returning `Session[]` (each with an `id` getter) and
 * neither exposes `keys()`. The `keys()` branch is kept only as a defensive
 * shape for still-earlier Map-style registries; it is NOT attested by any
 * measured host, so do not treat it as the "old host" contract.
 *
 * Deliberately NO `Object.keys(service)` fallback: on a host service instance
 * that yields the service's own implementation fields (e.g. `list`/`get`), not
 * session ids — the scan then silently sees zero sessions while looking
 * healthy. An unrecognized enumerator is reported as [] PLUS a one-shot
 * diagnostic with a shape fingerprint, so "no sessions" and "unknown shape"
 * are distinguishable.
 *
 * @param {object} [sessions] - the `sessions` service (`ctx.sessions`)
 * @returns {string[]} live session ids
 */
export function sessionIds(sessions) {
  if (!sessions || typeof sessions !== 'object') return []
  const shape = shapeOf(sessions)
  const hasList = typeof sessions.list === 'function'
  if (hasList) {
    let list
    let listError = null
    try {
      list = sessions.list()
    } catch (error) {
      listError = error
    }
    if (listError !== null) {
      diagnoseOnce(
        `session-ids:list-threw:${shape}`,
        `retrace: sessions.list() threw (${String(listError)}); falling back to sessions.keys()`,
      )
    } else if (Array.isArray(list)) {
      const ids = list.map((session) => session?.id).filter((id) => typeof id === 'string' && id.length > 0)
      if (ids.length > 0) return ids
      if (list.length === 0) return [] // authoritative: there really are no live sessions
      diagnoseOnce(
        `session-ids:list-no-id:${shape}`,
        `retrace: sessions.list() returned ${list.length} entries but none exposes a string id (first entry shape ${shapeOf(list[0])}) — the host API may have drifted`,
      )
      return []
    } else {
      diagnoseOnce(
        `session-ids:list-not-array:${shape}`,
        `retrace: sessions.list() returned ${shapeOf(list)}, not an array; falling back to sessions.keys()`,
      )
    }
  }
  const hasKeys = typeof sessions.keys === 'function'
  if (hasKeys) {
    try {
      return [...sessions.keys()]
    } catch (error) {
      diagnoseOnce(`session-ids:keys-threw:${shape}`, `retrace: sessions.keys() threw (${String(error)})`)
      return []
    }
  }
  // Only "neither enumerator exists" gets the generic line; a present-but-broken
  // list() already produced its own specific shape diagnostic above.
  if (!hasList) {
    diagnoseOnce(
      `session-ids:no-api:${shape}`,
      `retrace: sessions service exposes neither list() nor keys() (shape ${shape}) — cannot enumerate live sessions`,
    )
  }
  return []
}
