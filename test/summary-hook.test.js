/**
 * dsh-retrace — post-write boundary artifact tests (opt-in `summary` switch).
 *
 * The seam's `onBoundary` is what lib/host-core.js calls after a marker pair is
 * committed + validated. These tests pin the two properties the design rests on:
 *
 *   1. OFF by default ⇒ zero LLM calls, zero files (identical to 0.4.x);
 *   2. ON ⇒ the artifact carries the `what` digest immediately and the LLM call
 *      happens LATER (fire-and-forget), so the op path stays under the 5 ms red
 *      line even when the provider takes much longer.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { DEFAULT_RETRACE_CONFIG, createVersioningSeam } from '../lib/versioning.js'
import { readSummaries, summaryFilePath } from '../lib/summary-store.js'
import { excerpt } from '../lib/boundary-what.js'

const LONG = '这是一段足够长的内容，用于触发摘要门槛。'.repeat(8)

function fakeLlm({ text = '桩摘要：被丢掉的是一段迁移计划讨论。', delayMs = 0 } = {}) {
  const calls = { count: 0 }
  return {
    calls,
    llm: {
      async prepareCall(config) {
        calls.count += 1
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
        return {
          config,
          stream() {
            return (async function* () {
              yield { type: 'text-delta', text }
              yield { type: 'finish', reason: { kind: 'stop' }, usage: { inputTokens: 3, outputTokens: 4 } }
            })()
          },
        }
      },
    },
  }
}

/** The injected seam stub `register()` receives (sessionProjections + storageDomain). */
function fakeSeam(projections) {
  return {
    sessionProjections: {
      register: () => () => {},
      onChanged: () => () => {},
      stateOf: (session, key) => projections?.(session, key),
    },
    sessionQuery: {},
    // Never settles: the domain-open `.then` (artifact store creation) stays out of the test.
    storageDomain: { open: () => new Promise(() => {}) },
  }
}

function fakeCtx({ llm, selection, projections } = {}) {
  const services = {
    llm,
    agentDefaultModel: selection ? { currentSelection: () => selection } : undefined,
  }
  return {
    inject(deps, cb) {
      if (Array.isArray(deps) && deps.includes('sessionProjections')) cb(fakeSeam(projections))
    },
    effect() {},
    get: (name) => services[name],
    sessions: { get: () => undefined },
  }
}

/** A session stub with the log window the span/ marker lookups need. */
function fakeSession(id = 'session-hook') {
  const events = [
    {
      seq: 0,
      type: 'user/message',
      time: 1_700_000_000_000,
      surfaceOp: 'append',
      data: { id: 'u0', role: 'user', content: [{ type: 'text', text: LONG.slice(0, 150) }] },
    },
    {
      seq: 1,
      type: 'assistant/message',
      time: 1_700_000_000_001,
      surfaceOp: 'append',
      data: { message: { id: 'a1', content: [{ type: 'text', text: LONG.slice(0, 150) }] } },
    },
    {
      seq: 2,
      type: 'user/message',
      time: 1_700_000_000_002,
      surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
      sourceEventSeqs: [0, 1],
      data: {
        id: 'retrace-recall-abc',
        role: 'user',
        content: [{ type: 'text', text: '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）' }],
      },
    },
  ]
  return { id, eventAt: (seq) => events[seq] }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retrace-hook-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('onBoundary — default OFF', () => {
  it('still records the what digest (0 calls) when the switch is off', async () => {
    const { llm, calls } = fakeLlm()
    const seam = createVersioningSeam(fakeCtx({ llm, selection: { provider: 'p', model: 'm' } }), () => {}, { storeRoot: root })
    seam.register()
    expect(DEFAULT_RETRACE_CONFIG.summary).toBe(false)
    seam.setConfig('session-hook', { ...DEFAULT_RETRACE_CONFIG })
    seam.onBoundary({ op: 'recall', session: fakeSession(), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Zero LLM cost — but the version row is still READABLE: the digest is written.
    expect(calls.count).toBe(0)
    expect(existsSync(summaryFilePath(root, 'session-hook'))).toBe(true)
    const { records } = await readSummaries(root, 'session-hook')
    expect(records).toHaveLength(1)
    expect(records[0].summaryEnabled).toBe(false)
    expect(records[0].called).toBe(false)
    expect(records[0].summary).toBeUndefined()
    expect(records[0].what.replaced).toEqual([
      { seq: 0, role: 'user', excerpt: excerpt(LONG.slice(0, 150)) },
      { seq: 1, role: 'assistant', excerpt: excerpt(LONG.slice(0, 150)) },
    ])
  })

  it('adds artifact counts from the projection state (counts only, never 0/0/0)', async () => {
    const { llm } = fakeLlm()
    const projections = () => ({
      versions: [{ boundarySeq: 2, touchedFiles: [{ path: 'a.ts', mode: 'created' }, { path: 'b.ts', mode: 'modified' }] }],
    })
    const seam = createVersioningSeam(fakeCtx({ llm, selection: { provider: 'p', model: 'm' }, projections }), () => {}, { storeRoot: root })
    seam.register()
    seam.setConfig('session-hook', { ...DEFAULT_RETRACE_CONFIG })
    seam.onBoundary({ op: 'recall', session: fakeSession(), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const { records } = await readSummaries(root, 'session-hook')
    expect(records[0].what.artifacts).toEqual({ created: 1, modified: 1, deleted: 0 })
    // No touched files (or an unfolded projection) ⇒ the field is OMITTED, not faked as 0.
    const seam2 = createVersioningSeam(fakeCtx({}), () => {}, { storeRoot: root })
    seam2.register()
    seam2.setConfig('s-plain', { ...DEFAULT_RETRACE_CONFIG })
    seam2.onBoundary({ op: 'recall', session: fakeSession('s-plain'), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const plain = (await readSummaries(root, 's-plain')).records
    expect(plain).toHaveLength(1)
    expect(Object.hasOwn(plain[0].what, 'artifacts')).toBe(false)
  })

  it('ignores a malformed payload without throwing', async () => {
    const seam = createVersioningSeam(fakeCtx(), () => {}, { storeRoot: root })
    seam.register()
    seam.setConfig('session-hook', { ...DEFAULT_RETRACE_CONFIG, summary: true })
    expect(() => seam.onBoundary(null)).not.toThrow()
    expect(() => seam.onBoundary({ session: { id: 'x' } })).not.toThrow()
    await flush()
  })
})

describe('onBoundary — ON', () => {
  it('returns immediately (fire-and-forget) while the provider is slow', async () => {
    const { llm, calls } = fakeLlm({ delayMs: 60 })
    const seam = createVersioningSeam(fakeCtx({ llm, selection: { provider: 'p', model: 'm' } }), () => {}, { storeRoot: root })
    seam.register()
    seam.setConfig('session-hook', { ...DEFAULT_RETRACE_CONFIG, summary: true })
    const started = performance.now()
    seam.onBoundary({ op: 'recall', session: fakeSession(), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    const opMs = performance.now() - started
    // The op path pays only the microtask hand-off, never the 60 ms call.
    expect(opMs).toBeLessThan(5)
    expect(calls.count).toBe(0) // not even started synchronously
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(calls.count).toBe(1)
  })

  it('writes one artifact line carrying BOTH the what digest and the summary', async () => {
    const { llm } = fakeLlm()
    const logs = []
    const seam = createVersioningSeam(fakeCtx({ llm, selection: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }), (m) => logs.push(m), { storeRoot: root })
    seam.register()
    seam.setConfig('session-hook', { ...DEFAULT_RETRACE_CONFIG, summary: true })
    seam.onBoundary({ op: 'recall', session: fakeSession(), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const { records, skipped, error } = await readSummaries(root, 'session-hook')
    expect(error).toBeNull()
    expect(skipped).toBe(0)
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record.boundarySeq).toBe(2)
    expect(record.versionId).toBe('v2')
    expect(record.called).toBe(true)
    expect(record.model).toBe('deepseek-official/deepseek-v4-flash')
    expect(record.summary).toBe('桩摘要：被丢掉的是一段迁移计划讨论。')
    // `what` rides in the same file: verbatim excerpts + the new-content slot.
    expect(record.what.op).toBe('recall')
    expect(record.what.replaced).toEqual([
      { seq: 0, role: 'user', excerpt: excerpt(LONG.slice(0, 150)) },
      { seq: 1, role: 'assistant', excerpt: excerpt(LONG.slice(0, 150)) },
    ])
    expect(record.what.new).toEqual({ excerpt: '' })
    expect(record.what.new.summary).toBeUndefined()
    // Different sources, different fields: excerpts are verbatim log text, the
    // summary is model output — neither may be stuffed into the other.
    for (const entry of record.what.replaced) expect(entry.summary).toBeUndefined()
    expect(record.summary).not.toBe(record.what.replaced[0].excerpt)
    expect(record.what.replaced[0].excerpt.startsWith('桩摘要')).toBe(false)
    expect(logs.filter((line) => line.includes('failed'))).toEqual([])
  })

  it('degrades to excerpt-only (logged, no throw) when the llm service is missing', async () => {
    const logs = []
    const seam = createVersioningSeam(fakeCtx(), (m) => logs.push(m), { storeRoot: root })
    seam.register()
    seam.setConfig('session-hook', { ...DEFAULT_RETRACE_CONFIG, summary: true })
    seam.onBoundary({ op: 'recall', session: fakeSession(), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    const { records } = await readSummaries(root, 'session-hook')
    expect(records).toHaveLength(1)
    expect(records[0].error).toBe('llm-unavailable')
    expect(records[0].summary).toBeUndefined()
    expect(records[0].what.replaced[0].excerpt).toBe(excerpt(LONG.slice(0, 150)))
    expect(logs.join(' ')).toContain('llm service unavailable')
  })

  it('serves repeated reads with zero further LLM calls', async () => {
    const { llm, calls } = fakeLlm()
    const seam = createVersioningSeam(fakeCtx({ llm, selection: { provider: 'p', model: 'm' } }), () => {}, { storeRoot: root })
    seam.register()
    seam.setConfig('session-hook', { ...DEFAULT_RETRACE_CONFIG, summary: true })
    seam.onBoundary({ op: 'recall', session: fakeSession(), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls.count).toBe(1)
    // Three list reads (what the view does when it opens) — still one call total.
    for (let i = 0; i < 3; i++) await readSummaries(root, 'session-hook')
    expect(calls.count).toBe(1)
    // A second identical operation is served from the content-hash cache.
    seam.onBoundary({ op: 'recall', session: fakeSession(), markerSeq: 2, span: { shadowedSeqs: [0, 1] }, newText: '' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(calls.count).toBe(1)
  })
})
