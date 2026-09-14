/**
 * Test helpers — a fake DSH Session/Sessions/Agents shaped like the real
 * runtime objects that `lib/host-core.js` consumes.
 *
 * The host core only reads `sessionEvents(session)` / `session.surface.nodes`, calls
 * `session.append(...)` and `sessions.flush(...)`, and queries
 * `agents.get(sessionId).status` / `.followup(...)`. This helper mirrors the
 * append-only log plus a shadow-able surface so the three editor ops can be
 * unit-tested without the real runtime.
 */
import { vi } from 'vitest'
import { sessionEvents, eventAt } from '../lib/host-compat.js'
import { createEditorApi } from '../lib/host-core.js'
import { createDshMarkerWriter, carrierContentOf } from '../lib/adapter/dsh-writer.js'
import { isCarrierMarkerEvent } from '../lib/marker-carrier.js'
import { deriveMessage, officialSurfaceMeter } from './official-meter.js'

/** User message event factory (real user input → round boundary). */
export function userMessage(id, text, extra = {}) {
  return {
    type: 'user/message',
    data: {
      id,
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
      ...extra,
    },
  }
}

/**
 * Injected-context user message (source.kind !== 'user'). The runtime appends
 * these for steering/context and they must NOT split an exchange round
 * (regression guard for the v3.7 fix).
 */
export function contextMessage(id, text) {
  return userMessage(id, text, { source: { kind: 'context' } })
}

/** Assistant model reply event factory. */
export function assistantMessage(id, text, source = {}) {
  return {
    type: 'assistant/message',
    data: {
      message: {
        id,
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: 'test-provider', model: 'test-model', ...source },
      },
    },
  }
}

/** Tool row event factory (surface-eligible, part of a round). */
export function toolRow(id, name = 'bash', extra = {}) {
  return {
    type: 'tool/result',
    data: {
      message: {
        id,
        role: 'tool',
        source: { kind: 'tool', callId: `call-${id}` },
        content: [
          {
            type: 'tool-result',
            toolCallId: `call-${id}`,
            content: [{ type: 'text', text: 'ok' }],
          },
        ],
      },
      name,
      ...extra,
    },
  }
}

/** request/header event — durable log only, NOT a surface node. */
export function headerEvent() {
  return {
    type: 'request/header',
    data: {
      header: {
        config: { provider: 'test-provider', model: 'test-model' },
      },
    },
  }
}

/** log-only 事件类型(官方定义:不进入 surface,不产生模型可见节点)。 */
const LOG_ONLY_TYPES = new Set(['request/header', 'compaction/prune', 'compaction/summary'])

/**
 * Build a fake session. `seed(...events)` appends events and builds the
 * surface exactly as the runtime does for these shapes: every non-log-only
 * event is a surface node. `append` additionally applies `surfaceOp.replace`
 * by dropping the shadowed span from the surface (the replacement carrier
 * becomes the new tail node).
 *
 * HOST GENERATION (2026-09-14, review): the DEFAULT is
 * the real production shape — DSH Desktop 2.0.9's `Session` exposes
 * `snapshotEvents()` / `eventAt(seq)` and has **no `events` member at all**.
 * The legacy array is an EXPLICIT override (`makeSession({ host: 'legacy' })`).
 * Rationale: while the fake carried only `events`, the whole suite silently
 * exercised the legacy branch, and a "guarded" regression such as
 * `Array.isArray(session?.events) ? session.events : []` passed 38/38 — i.e.
 * it could ship "recall/edit is dead" with a fully green suite.
 *
 * Members mirrored from the measured host class (audit table report.md §2.1):
 * `id`, `header`, `seq`, `surface(.nodes)`, `append`, `snapshotEvents`,
 * `eventAt`. Test-only additions: `seed` / `appendRaw` / `dropAt`.
 *
 * @param {{host?: 'new'|'legacy'}} [options]
 */
export function makeSession({ host = 'new' } = {}) {
  const events = []
  const surface = { nodes: [] }
  const session = {
    id: 's1',
    // production header shape (cwd omitted ⇒ undefined, like a session created
    // without meta.cwd; exercises the `session.header?.cwd` reads in lib/).
    header: { version: 3, id: 's1', createdAt: 0, isSeeded: false },
    surface,
    /** Production: `get seq() { return this.log.length }`. */
    get seq() { return events.length },
    /** Test-only: drop one slot, simulating a partial/windowed view (a hole). */
    dropAt(seq) { delete events[seq] },
    seed(...descriptors) {
      for (const event of descriptors) this.appendRaw(event)
      return this
    },
    appendRaw(event) {
      const record = { seq: events.length, ...event }
      events.push(record)
      // log-only 类型(request/header、compaction/prune 审计段)不进 surface
      if (!LOG_ONLY_TYPES.has(record.type)) surface.nodes.push(record.seq)
      return record
    },
    append(type, data, options = {}) {
      const record = { seq: events.length, type, data, ...options }
      events.push(record)
      // 真实 DSH（dsh-session）只有 surface-eligible 类型（user/assistant/tool + surfaceOp）
      // 进入 surface；step/start、step/end、turn/start、turn/end 是位置边界，不产生节点。
      if (LOG_ONLY_TYPES.has(type)) return record
      if (type === 'step/start' || type === 'step/end' || type === 'turn/start' || type === 'turn/end') return record
      if (options.surfaceOp && options.surfaceOp.op === 'replace') {
        const { start, end } = options.surfaceOp
        surface.nodes = surface.nodes.filter((seq) => seq < start || seq > end)
      }
      // The replacement marker itself becomes the new surface tail node
      // (it derives to no model message, but it is part of the surface).
      surface.nodes.push(record.seq)
      return record
    },
  }
  if (host === 'legacy') {
    // Explicit old-host override: the plain log array only (no new API).
    session.events = events
  } else {
    // Production shape: cached immutable snapshot + O(1) single-seq accessor.
    session.snapshotEvents = () => Object.freeze(events.slice())
    session.eventAt = (seq) => events[seq]
  }
  return session
}

/** Explicit legacy-generation fake (readability alias for host tests). */
export function makeLegacySession() {
  return makeSession({ host: 'legacy' })
}

/**
 * Build the `sessions` / `agents` facade the host core receives.
 * `flushImpl` lets tests assert that flush ran.
 */
export function makeEnv(session, { agent, flushImpl } = {}) {
  const sessions = {
    get: (id) => (id === 's1' ? session : undefined),
    async flush(session) {
      if (flushImpl) await flushImpl(session)
    },
  }
  const agents = {
    get: () => agent,
  }
  return { sessions, agents }
}

/** An idle agent with a spying followup. */
export function makeAgent(overrides = {}) {
  const followup = vi.fn()
  return { status: 'idle', followup, ...overrides }
}

/**
 * 一个「形状合规」的假写入器(两段结构),供只需要"写入发生过"的用例
 * (HTTP 路由 / rollback executor)注入——不依赖真实 adapter,但写出的形状与生产
 * 一致(审计段 `compaction/prune` + 载体段 `user/message`),故 host-core 的出口
 * 断言照常生效(假写入器写旧形状会被契约拦下)。
 * @param {{onWrite?: (marker: object) => void}} [opts]
 */
export function fakeCarrierWriter({ onWrite } = {}) {
  return async function writeMarker(session, span, intent = {}) {
    const shadowed = Array.isArray(span.shadowedSeqs) ? span.shadowedSeqs.slice() : []
    const audit = session.append('compaction/prune', {
      shadowedRange: { start: span.start, end: span.end },
      shadowedSeqs: shadowed.slice(),
      shadowedTokenCount: shadowed.length,
    })
    const marker = session.append('user/message', {
      role: 'user',
      id: `retrace-${intent.op ?? 'recall'}-${intent.targetSeq ?? span.start}`,
      content: carrierContentOf(intent),
      source: { kind: 'model', provider: 'p', model: 'm' },
    }, { surfaceOp: { op: 'replace', start: span.start, end: span.end }, sourceEventSeqs: [audit.seq, ...shadowed] })
    if (typeof onWrite === 'function') onWrite(marker)
    return marker
  }
}

/** 最近一次写入的遮蔽载体(两段结构的第 2 段)。 */
export function lastCarrierMarker(session) {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    if (isCarrierMarkerEvent(events[i])) return events[i]
  }
  return null
}

/**
 * 默认 hooks(2026-09-02 抽象设计落地):真实 DSH 遮蔽写入器 + 默认校验通过。
 * 测试可覆盖 validateMarker(断言 writer→校验链路)或整体覆盖。
 * meter 注入官方口径的测量桩(写作器拿不到 meter 会拒写——见 official-meter.js)。
 */
export function makeHooks(agents, overrides = {}) {
  const validateMarker = overrides.validateMarker ?? (async () => ({ t1Ok: true }))
  const writer = createDshMarkerWriter({ validateMarker, meter: officialSurfaceMeter(), deriveMessage })
  return { validateMarker, writeMarker: writer.writeMarker, ...overrides }
}

/** Convenience: one ready-to-use host API over a seeded session. */
export function makeApi(session, agent, { flushImpl } = {}) {
  const { sessions, agents } = makeEnv(session, { agent, flushImpl })
  return createEditorApi({}, sessions, agents, () => {}, makeHooks(agents))
}
