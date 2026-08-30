/**
 * dsh-retrace · test/interrupt-guard.test.js
 *
 * R4 中断轮次治理测试（需求文档 §4）：
 * 1. 正常闭合轮次 → 无未闭合；
 * 2. 有 turn/start 无 turn/end（崩溃/强杀现场）→ open；
 * 3. turn/end reason interrupted/aborted → 官方正常闭合，不计未闭合；
 * 4. attachExitWarning：dispose 时对未闭合会话记 warning、闭合会话不记。
 *
 * 纯函数 + 依赖注入，不触碰真实 ~/.dsh 或 zstd 文件。
 */
import { describe, it, expect } from 'vitest'
import { unclosedTurns, attachExitWarning, detectUnclosed } from '../lib/interrupt-guard.js'

function turnStart(turn) {
  return { type: 'turn/start', seq: turn * 10, data: { turn } }
}
function turnEnd(turn, reasonKind) {
  return { type: 'turn/end', seq: turn * 10 + 1, data: { turn, reason: { kind: reasonKind } } }
}

describe('unclosedTurns（R4 检测）', () => {
  it('正常闭合轮次 → 无未闭合', () => {
    const session = { events: [turnStart(1), turnEnd(1, 'completed'), turnStart(2), turnEnd(2, 'completed')] }
    expect(unclosedTurns(session)).toEqual([])
  })

  it('有 turn/start 无 turn/end（崩溃/强杀现场）→ open', () => {
    const session = { events: [turnStart(1), turnEnd(1, 'completed'), turnStart(2)] }
    const r = unclosedTurns(session)
    expect(r).toEqual([{ turn: 2, state: 'open' }])
  })

  it('turn/end reason=interrupted → 官方正常闭合，不计未闭合', () => {
    const session = { events: [turnStart(1), turnEnd(1, 'interrupted')] }
    expect(unclosedTurns(session)).toEqual([])
  })

  it('turn/end reason=aborted → 官方正常闭合，不计未闭合', () => {
    const session = { events: [turnStart(1), turnEnd(1, 'aborted')] }
    expect(unclosedTurns(session)).toEqual([])
  })

  it('多轮混合：中断闭合 + 尾部真 open 只报 open', () => {
    const session = { events: [turnStart(1), turnEnd(1, 'interrupted'), turnStart(2), turnEnd(2, 'completed'), turnStart(3)] }
    expect(unclosedTurns(session)).toEqual([{ turn: 3, state: 'open' }])
  })

  it('空会话/无 events → 空', () => {
    expect(unclosedTurns({ events: [] })).toEqual([])
    expect(unclosedTurns({})).toEqual([])
  })

  it('detectUnclosed 别名导出可用', () => {
    const session = { events: [turnStart(1), turnEnd(1, 'interrupted')] }
    expect(detectUnclosed(session)).toEqual([])
  })
})

describe('attachExitWarning（R4 退出前提示）', () => {
  function makeCtxWithSessions(sessionsById) {
    const sessions = new Map(Object.entries(sessionsById))
    return { sessions }
  }

  it('dispose 时对未闭合会话记 warning', () => {
    const ctx = makeCtxWithSessions({
      's-1': { events: [turnStart(1), turnEnd(1, 'completed'), turnStart(2)] }, // 未闭合 turn 2
      's-2': { events: [turnStart(1), turnEnd(1, 'completed')] }, // 闭合
    })
    const lines = []
    const warn = attachExitWarning(ctx, (l) => lines.push(l))
    warn()
    expect(lines.length).toBe(1)
    expect(lines[0]).toContain('s-1')
    expect(lines[0]).toContain('turn 2 (open)')
  })

  it('全闭合会话 → 不记 warning', () => {
    const ctx = makeCtxWithSessions({
      's-1': { events: [turnStart(1), turnEnd(1, 'completed')] },
    })
    const lines = []
    const warn = attachExitWarning(ctx, (l) => lines.push(l))
    warn()
    expect(lines).toEqual([])
  })

  it('无会话/空 → 不抛错', () => {
    const ctx = makeCtxWithSessions({})
    const lines = []
    const warn = attachExitWarning(ctx, (l) => lines.push(l))
    expect(() => warn()).not.toThrow()
    expect(lines).toEqual([])
  })
})
