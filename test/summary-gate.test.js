/**
 * dsh-retrace — `needsSummary` gate tests (frozen 2026-09-14, user-set rules).
 *
 * R1 量  ≥100 字   R2 有 assistant 文本或 tool/result
 * R3 未中断/报错且无文本产出   R4 非占位/空白/短指令
 *
 * Each rule gets a blocking case (⇒ needs:false) and a passing case (⇒ the rule
 * is not the blocker). The last block pins the "all four pass ⇒ exactly one
 * call" property and the input cap (≤6 items × 400 chars).
 */
import { describe, it, expect } from 'vitest'
import {
  INPUT_ITEM_CHARS,
  INPUT_ITEM_MAX,
  SHORT_MESSAGE_CHARS,
  SUMMARY_CHAR_THRESHOLD,
  isPlaceholderText,
  needsSummary,
  summaryInputOf,
} from '../lib/summary-gate.js'

const LONG = '这是一段足够长的内容。'.repeat(20) // 200 chars

function user(seq, text) {
  return { seq, type: 'user/message', data: { id: `u${seq}`, content: [{ type: 'text', text }] } }
}
function assistant(seq, text) {
  return { seq, type: 'assistant/message', data: { message: { id: `a${seq}`, content: [{ type: 'text', text }] } } }
}
function tool(seq, text, error) {
  const data = { id: `t${seq}`, message: { content: [{ type: 'text', text }] } }
  if (error) data.error = error
  return { seq, type: 'tool/result', data }
}

describe('R1 量 — under 100 chars is not summarized', () => {
  it('blocks a span below the threshold', () => {
    // Both messages are ≥ SHORT_MESSAGE_CHARS, so R4 does not apply: the only
    // blocker is quantity (70 < 100).
    const span = [user(1, 'x'.repeat(40)), assistant(2, 'y'.repeat(30))]
    const gate = needsSummary(span)
    expect(gate.needs).toBe(false)
    expect(gate.rule).toBe('R1')
    expect(gate.stats.allShort).toBe(false)
    expect(gate.stats.chars).toBeLessThan(SUMMARY_CHAR_THRESHOLD)
  })

  it('passes the rule at/above the threshold', () => {
    const span = [user(1, LONG.slice(0, 120)), assistant(2, LONG.slice(0, 40))]
    const gate = needsSummary(span)
    expect(gate.stats.chars).toBeGreaterThanOrEqual(SUMMARY_CHAR_THRESHOLD)
    expect(gate.rule).not.toBe('R1')
  })
})

describe('R2 过程/结果 — user-only spans are not summarized', () => {
  it('blocks a long span that never produced assistant/tool output', () => {
    const span = [user(1, LONG.slice(0, 150)), user(2, LONG.slice(0, 150))]
    const gate = needsSummary(span)
    expect(gate.needs).toBe(false)
    expect(gate.rule).toBe('R2')
    expect(gate.stats.hasAssistantText).toBe(false)
    expect(gate.stats.hasToolResult).toBe(false)
  })

  it('passes with assistant text only', () => {
    const gate = needsSummary([user(1, LONG.slice(0, 150)), assistant(2, '收到，我来处理这件事')])
    expect(gate.stats.hasAssistantText).toBe(true)
    expect(gate.rule).not.toBe('R2')
  })

  it('passes with a tool result only', () => {
    const gate = needsSummary([user(1, LONG.slice(0, 150)), tool(2, 'ok')])
    expect(gate.stats.hasToolResult).toBe(true)
    expect(gate.rule).not.toBe('R2')
  })
})

describe('R3 中断/报错且无产出 — aborted rounds are not summarized', () => {
  it('blocks a span whose only output is a failed tool result', () => {
    const gate = needsSummary([user(1, LONG.slice(0, 150)), tool(2, '', 'boom')])
    expect(gate.needs).toBe(false)
    expect(gate.rule).toBe('R3')
    expect(gate.stats.interrupted).toBe(true)
  })

  it('blocks a span with an empty assistant message and no assistant text', () => {
    const gate = needsSummary([user(1, LONG.slice(0, 150)), assistant(2, ''), tool(3, 'partial')])
    expect(gate.rule).toBe('R3')
  })

  it('passes once the round produced assistant text', () => {
    const gate = needsSummary([user(1, LONG.slice(0, 150)), assistant(2, '这里是实际产出的一段较长的回答内容'), tool(3, '', 'boom')])
    expect(gate.stats.hasAssistantText).toBe(true)
    expect(gate.rule).not.toBe('R3')
  })
})

describe('R4 占位/空白/短指令 — nothing real to summarize', () => {
  it('blocks an all-short span', () => {
    const span = [user(1, '12'), user(2, '继续'), assistant(3, '好')]
    const gate = needsSummary(span)
    expect(gate.needs).toBe(false)
    expect(gate.rule).toBe('R4')
    expect(gate.stats.allShort).toBe(true)
    expect(SHORT_MESSAGE_CHARS).toBe(20)
  })

  it('passes as soon as one message carries real length', () => {
    const gate = needsSummary([user(1, '12'), user(2, '继续'), assistant(3, LONG.slice(0, 150))])
    expect(gate.stats.allShort).toBe(false)
    expect(gate.rule).not.toBe('R4')
  })

  it('treats recall placeholders / blank / punctuation as no content', () => {
    expect(isPlaceholderText('（此处内容已被撤回：原消息已归档，可在恢复视图中查看）')).toBe(true)
    expect(isPlaceholderText('   ')).toBe(true)
    expect(isPlaceholderText('……！？')).toBe(true)
    expect(isPlaceholderText('正常内容')).toBe(false)
    const gate = needsSummary([
      user(1, '（此处内容已被撤回：原消息已归档，可在恢复视图中查看）'),
      assistant(2, ''),
      tool(3, '   '),
    ])
    expect(gate.needs).toBe(false)
    expect(gate.stats.contentless).toBe(true)
  })
})

describe('all four pass ⇒ one call, capped input', () => {
  const span = [
    user(1, LONG.slice(0, 150)),
    assistant(2, LONG.slice(0, 150)),
    tool(3, LONG.slice(0, 150)),
  ]

  it('returns a single “summarize” decision and is pure', () => {
    const first = needsSummary(span)
    const second = needsSummary(span)
    expect(first.needs).toBe(true)
    expect(first.rule).toBeNull()
    expect(second).toEqual(first)
  })

  it('caps the prompt payload at INPUT_ITEM_MAX items × INPUT_ITEM_CHARS', () => {
    const many = Array.from({ length: 10 }, (_, i) => user(i + 1, LONG.repeat(3)))
    const items = summaryInputOf(many)
    expect(items).toHaveLength(INPUT_ITEM_MAX)
    for (const item of items) expect(item.text.length).toBeLessThanOrEqual(INPUT_ITEM_CHARS)
    expect(items.reduce((n, item) => n + item.text.length, 0)).toBeLessThanOrEqual(INPUT_ITEM_MAX * INPUT_ITEM_CHARS)
    const gate = needsSummary(many)
    expect(gate.stats.inputItems).toBe(INPUT_ITEM_MAX)
    expect(gate.stats.inputChars).toBeLessThanOrEqual(INPUT_ITEM_MAX * INPUT_ITEM_CHARS)
  })

  it('ignores non-surface events inside the span', () => {
    const gate = needsSummary([{ seq: 0, type: 'step/start', data: {} }, ...span])
    expect(gate.stats.messages).toBe(3)
    expect(gate.needs).toBe(true)
  })
})
