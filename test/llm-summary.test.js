/**
 * dsh-retrace — LLM summary half tests (optional feature, default OFF).
 *
 * Pins: the artifact store is crash-safe, the call is capped/timed-out/degraded,
 * a cache hit costs zero calls, and nothing on this path throws into the op.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import {
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_TIMEOUT_MS,
  assembleSummaryStream,
  buildSummaryMessages,
  runSummary,
  triggerSummary,
} from '../lib/llm-summary.js'
import {
  appendSummary,
  findCachedSummary,
  hashSummaryInput,
  readSummaries,
  renderSummariesMarkdown,
  summaryFilePath,
} from '../lib/summary-store.js'

const LONG = '这是一段足够长的内容，用于触发摘要门槛。'.repeat(8)

function user(seq, text) {
  return { seq, type: 'user/message', data: { id: `u${seq}`, content: [{ type: 'text', text }] } }
}
function assistant(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { id: `a${seq}`, content: [{ type: 'text', text }] } } }
}
const span = [user(1, LONG), assistant(2, LONG.slice(0, 120))]

/** A stub LLM service: counts calls and streams a fixed summary. */
function stubLlm({ text = '这是桩生成的摘要', delayMs = 0, throwOn = null, failFinish = false } = {}) {
  const calls = { count: 0, configs: [], aborted: 0 }
  const llm = {
    async prepareCall(config, signal) {
      calls.count += 1
      calls.configs.push(config)
      if (throwOn === 'prepare') throw new Error('boom-prepare')
      if (delayMs > 0) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs)
          signal?.addEventListener('abort', () => {
            clearTimeout(timer)
            calls.aborted += 1
            reject(new Error('aborted'))
          })
        })
      }
      return {
        config,
        stream() {
          return (async function* () {
            if (throwOn === 'stream') throw new Error('boom-stream')
            yield { type: 'text-delta', text }
            yield { type: 'finish', reason: failFinish ? { kind: 'error', failure: { message: 'provider down' } } : { kind: 'stop' }, usage: { inputTokens: 11, outputTokens: 7 } }
          })()
        },
      }
    },
  }
  return { llm, calls }
}

let root
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retrace-summary-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const selection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
/** Per-test args (root is assigned in beforeEach, so this cannot be a module const). */
const args = (extra = {}) => ({
  root,
  sessionId: 'session-abc',
  boundarySeq: 42,
  versionId: 'v42',
  spanEvents: span,
  selection,
  // Most tests exercise the OPT-IN path; the default-off path has its own test.
  summaryEnabled: true,
  ...extra,
})

describe('summary artifact store', () => {
  it('appends and reads one record per line, per session', async () => {
    await appendSummary(root, 'session-abc', { boundarySeq: 1, contentHash: 'aaa', called: true, summary: 'S1' })
    await appendSummary(root, 'session-abc', { boundarySeq: 2, contentHash: 'bbb', called: false, rule: 'R1' })
    await appendSummary(root, 'session-other', { boundarySeq: 9, contentHash: 'zzz', called: true, summary: 'OTHER' })
    const { records, skipped, error } = await readSummaries(root, 'session-abc')
    expect(error).toBeNull()
    expect(skipped).toBe(0)
    expect(records.map((r) => r.boundarySeq)).toEqual([1, 2])
    // The artifact lives under the plugin data home root, one file per session.
    expect(summaryFilePath(root, 'session-abc').endsWith(join('summaries', 'session-abc.jsonl'))).toBe(true)
    const other = await readSummaries(root, 'session-other')
    expect(other.records).toHaveLength(1)
  })

  it('degrades on a torn/corrupt line instead of throwing', async () => {
    await appendSummary(root, 'session-torn', { boundarySeq: 1, contentHash: 'a', called: true, summary: 'ok' })
    const path = summaryFilePath(root, 'session-torn')
    writeFileSync(path, '{"boundarySeq":2,"contentH', { flag: 'a' }) // half-written record
    await appendSummary(root, 'session-torn', { boundarySeq: 3, contentHash: 'c', called: true, summary: 'ok3' })
    const { records, skipped, error } = await readSummaries(root, 'session-torn')
    expect(error).toBeNull()
    expect(skipped).toBe(1)
    expect(records.map((r) => r.boundarySeq)).toEqual([1, 3])
  })

  it('returns no records for a missing file (no throw)', async () => {
    const { records, error } = await readSummaries(root, 'never-written')
    expect(records).toEqual([])
    expect(error).toBeNull()
  })

  it('finds a cached record by boundary + content hash', async () => {
    const hash = hashSummaryInput([{ role: 'user', text: LONG }])
    await appendSummary(root, 'session-abc', { boundarySeq: 42, contentHash: hash, called: true, summary: 'cached' })
    const { records } = await readSummaries(root, 'session-abc')
    expect(findCachedSummary(records, { boundarySeq: 42, contentHash: hash })?.summary).toBe('cached')
    expect(findCachedSummary(records, { boundarySeq: 42, contentHash: 'nope' })).toBeUndefined()
  })

  it('renders a human-readable Markdown view', async () => {
    await appendSummary(root, 'session-abc', {
      boundarySeq: 42,
      versionId: 'v42',
      called: true,
      model: 'p/m',
      chars: 300,
      at: 1_700_000_000_000,
      usage: { inputTokens: 11, outputTokens: 7 },
      summary: '摘要正文',
    })
    const { records } = await readSummaries(root, 'session-abc')
    const md = renderSummariesMarkdown('session-abc', records)
    expect(md).toContain('# dsh-retrace summaries')
    expect(md).toContain('## #42 — v42')
    expect(md).toContain('摘要正文')
    expect(md).toContain('inputTokens')
  })
})

describe('runSummary — gate, call, cache, degrade', () => {
  it('records only the what digest (zero calls) when the summary switch is off', async () => {
    const { llm, calls } = stubLlm()
    const what = { op: 'recall', new: { excerpt: '' }, replaced: [{ seq: 1, role: 'user', excerpt: 'x' }] }
    const record = await runSummary(args({ llm, summaryEnabled: false, what }))
    expect(calls.count).toBe(0)
    expect(record.summaryEnabled).toBe(false)
    expect(record.called).toBe(false)
    expect(record.summary).toBeUndefined()
    // The digest still travels, and it is readable back from the artifact.
    expect(record.what).toEqual(what)
    const { records } = await readSummaries(root, 'session-abc')
    expect(records[0].what).toEqual(what)
  })

  it('writes a STRUCTURE-ONLY line for a QUIET boundary (gate blocks + 0/0/0 churn)', async () => {
    const { llm, calls } = stubLlm()
    const record = await runSummary(
      args({
        llm,
        spanEvents: [user(1, '12'), assistant(2, '好')],
        artifactCounts: { created: 0, modified: 0, deleted: 0 },
        discardedSeqs: [2],
        discardedCount: 9,
      }),
    )
    expect(record.persisted).toBe(true)
    expect(calls.count).toBe(0)
    const { records } = await readSummaries(root, 'session-abc')
    expect(records).toHaveLength(1)
    // Exactly the skeleton — no content fields, so the client shows no text row.
    expect(Object.keys(records[0]).sort()).toEqual(['boundarySeq', 'discardedCount', 'discardedSeqs', 'quiet'])
    expect(records[0].quiet).toBe(true)
    expect(records[0].discardedCount).toBe(9)
    expect(records[0].discardedSeqs).toEqual([2])
    expect(records[0].what).toBeUndefined()
    expect(records[0].chars).toBeUndefined()
    expect(records[0].rule).toBeUndefined()
  })

  it('still writes the FULL digest line when the gate blocks but artifacts DID change', async () => {
    const { llm, calls } = stubLlm()
    const what = { op: 'edit', new: { excerpt: '' }, replaced: [], artifacts: { created: 2, modified: 0, deleted: 0 } }
    const record = await runSummary(
      args({ llm, spanEvents: [user(1, '12'), assistant(2, '好')], what, artifactCounts: { created: 2, modified: 0, deleted: 0 } }),
    )
    expect(record.quiet).toBeUndefined()
    expect(record.persisted).toBe(true)
    expect(record.rule).toBe('R4')
    expect(calls.count).toBe(0)
    const { records } = await readSummaries(root, 'session-abc')
    expect(records).toHaveLength(1)
    expect(records[0].what.artifacts).toEqual({ created: 2, modified: 0, deleted: 0 })
    expect(records[0].rule).toBe('R4')
  })

  it('内容行也带精确 discardedCount(精简集不等于真值;树的计数靠它)', async () => {
    const { llm, calls } = stubLlm()
    const what = { op: 'edit', new: { excerpt: '' }, replaced: [{ seq: 1, role: 'user', excerpt: 'x' }], replacedMore: 9 }
    // discardedSeqs 只存边界 seq(精简集),但真正被丢弃的是 10 条。
    const record = await runSummary(args({ llm, summaryEnabled: false, what, discardedSeqs: [1], discardedCount: 10 }))
    expect(record.quiet).toBeUndefined()
    expect(record.called).toBe(false)
    expect(record.discardedCount).toBe(10)
    const { records } = await readSummaries(root, 'session-abc')
    expect(records[0].discardedSeqs).toEqual([1])
    // 少了它,outline 读端会退回精简集大小(1),「这次改动丢弃了 N 条消息」就会少报。
    expect(records[0].discardedCount).toBe(10)
    expect(calls.count).toBe(0)
  })

  it('轮次随记录一起存（内容行与安静行都存；取不到就不写这个字段）', async () => {
    // 人读要求：不点开也知道"这是哪一轮"。轮次在操作时从日志读出后随记录存下，
    // 读端（/summaries）就不再需要重读日志。
    const { llm } = stubLlm()
    const what = { op: 'edit', new: { excerpt: '' }, replaced: [{ seq: 1, role: 'user', excerpt: 'x' }] }
    const content = await runSummary(args({ llm, summaryEnabled: false, what, turn: 159 }))
    expect(content.turn).toBe(159)
    const { records } = await readSummaries(root, 'session-abc')
    expect(records[0].turn).toBe(159)
    // 安静行（0/0/0 且闸门不通过）同样带上轮次
    const quiet = await runSummary(args({
      llm,
      spanEvents: [user(1, '12'), assistant(2, '好')],
      artifactCounts: { created: 0, modified: 0, deleted: 0 },
      turn: 452,
      boundarySeq: 43,
    }))
    expect(quiet.quiet).toBe(true)
    expect(quiet.turn).toBe(452)
    // 取不到（null / 0 / 非整数）⇒ 整个字段不写，读端就不会显示"第 ? 轮"
    for (const bad of [null, undefined, 0, -1, 1.5, '159']) {
      const record = await runSummary(args({ llm, summaryEnabled: false, what, turn: bad, boundarySeq: 44 }))
      expect(record.turn).toBeUndefined()
    }
    const quietNoTurn = await runSummary(args({
      llm,
      spanEvents: [user(1, '12'), assistant(2, '好')],
      artifactCounts: { created: 0, modified: 0, deleted: 0 },
      boundarySeq: 45,
    }))
    expect(quietNoTurn.turn).toBeUndefined()
  })

  it('treats UNKNOWN artifact counts as NON-quiet (unknown ≠ zero) and logs it', async () => {
    const { llm, calls } = stubLlm()
    const logs = []
    const record = await runSummary(
      args({
        llm,
        spanEvents: [user(1, '12'), assistant(2, '好')],
        what: { op: 'edit', new: { excerpt: '' }, replaced: [] },
        artifactCounts: null,
        log: (m) => logs.push(m),
      }),
    )
    expect(record.quiet).toBeUndefined()
    expect(record.persisted).toBe(true)
    expect(record.what).toBeDefined()
    expect(record.rule).toBe('R4')
    expect(calls.count).toBe(0)
    expect(logs.join(' ')).toContain('artifact counts unavailable')
    expect(logs.join(' ')).toContain('non-quiet')
  })

  it('makes exactly one call when all four rules pass, capped + timed', async () => {
    const { llm, calls } = stubLlm({ text: '丢掉的内容是：一段较长的迁移计划讨论。' })
    const record = await runSummary(args({ llm }))
    expect(calls.count).toBe(1)
    expect(record.called).toBe(true)
    expect(record.summary).toBe('丢掉的内容是：一段较长的迁移计划讨论。')
    expect(record.model).toBe('deepseek-official/deepseek-v4-flash')
    expect(record.usage).toEqual({ inputTokens: 11, outputTokens: 7 })
    const config = calls.configs[0]
    expect(config.maxTokens).toBe(SUMMARY_OUTPUT_TOKENS)
    expect(config.messages).toHaveLength(2)
    // input cap: ≤6 items × 400 chars
    expect(record.inputChars).toBeLessThanOrEqual(6 * 400)
  })

  it('serves a cache hit with ZERO further calls (and the view reads cost nothing)', async () => {
    const first = stubLlm({ text: '第一次的摘要' })
    const record1 = await runSummary(args({ llm: first.llm }))
    expect(first.calls.count).toBe(1)
    const second = stubLlm({ text: '不该被调用' })
    const record2 = await runSummary(args({ llm: second.llm }))
    expect(second.calls.count).toBe(0)
    expect(record2.summary).toBe(record1.summary)
    // Reading the list three times adds no calls either (pure artifact reads).
    for (let i = 0; i < 3; i++) await readSummaries(root, 'session-abc')
    expect(first.calls.count + second.calls.count).toBe(1)
  })

  it('degrades to excerpt-only (no throw) when there is no llm service', async () => {
    const logs = []
    const record = await runSummary(args({ llm: null, log: (m) => logs.push(m) }))
    expect(record.called).toBe(false)
    expect(record.error).toBe('llm-unavailable')
    expect(record.summary).toBeUndefined()
    expect(logs.join(' ')).toContain('llm service unavailable')
  })

  it('degrades when no model/credentials are selected', async () => {
    const { llm, calls } = stubLlm()
    const logs = []
    const record = await runSummary(args({ llm, selection: null, log: (m) => logs.push(m) }))
    expect(record.error).toBe('no-credentials')
    expect(record.summary).toBeUndefined()
    expect(calls.count).toBe(0)
    expect(logs.join(' ')).toContain('no model/credentials')
  })

  it('degrades on a provider failure carried by the finish chunk', async () => {
    const { llm } = stubLlm({ failFinish: true })
    const record = await runSummary(args({ llm }))
    expect(record.called).toBe(true)
    expect(record.error).toContain('provider down')
    expect(record.summary).toBeUndefined()
  })

  it('degrades on a thrown call, with a diagnostic', async () => {
    const logs = []
    const { llm } = stubLlm({ throwOn: 'prepare' })
    const record = await runSummary(args({ llm, log: (m) => logs.push(m) }))
    expect(record.error).toContain('boom-prepare')
    expect(logs.join(' ')).toContain('summary failed')
  })

  it('aborts at the wall-clock limit and degrades', async () => {
    const { llm, calls } = stubLlm({ delayMs: 200 })
    const logs = []
    const record = await runSummary(args({ llm, timeoutMs: 20, log: (m) => logs.push(m) }))
    expect(record.error).toContain('timeout')
    expect(record.summary).toBeUndefined()
    expect(calls.aborted).toBe(1)
    expect(logs.join(' ')).toContain('summary timeout')
  })

  it('never throws out of triggerSummary (the op path is fire-and-forget)', async () => {
    const bad = { prepareCall: () => Promise.reject(new Error('nope')) }
    await expect(triggerSummary(args({ llm: bad }))).resolves.toBeTruthy()
  })
})

describe('prompt/stream helpers', () => {
  it('builds a two-message call carrying the capped items only', () => {
    const messages = buildSummaryMessages([{ seq: 3, role: 'user', text: LONG.slice(0, 400) }])
    expect(messages[0].role).toBe('system')
    expect(messages[1].content[0].text).toContain('[user #3]')
  })

  it('assembles only text-delta chunks and keeps usage', async () => {
    const out = await assembleSummaryStream([
      { type: 'reasoning-delta', text: 'thinking' },
      { type: 'text-delta', text: 'a' },
      { type: 'text-delta', text: 'b' },
      { type: 'finish', reason: { kind: 'stop' }, usage: { outputTokens: 2 } },
    ])
    expect(out.text).toBe('ab')
    expect(out.usage).toEqual({ outputTokens: 2 })
    expect(SUMMARY_TIMEOUT_MS).toBe(5000)
  })
})
