/**
 * dsh-retrace · test/interrupt-guard.test.js
 *
 * R4 中断轮次治理测试：
 * 1. 正常闭合轮次 → 无未闭合；
 * 2. 有 turn/start 无 turn/end（崩溃/强杀现场）→ open；
 * 3. turn/end reason interrupted/aborted → 官方正常闭合，不计未闭合；
 * 4. attachExitWarning：dispose 时对未闭合会话记 warning、闭合会话不记。
 *
 * 会话形状（2026-09-14 复核）：默认 = **真实生产新宿主**
 * （只有 snapshotEvents()/eventAt()，没有 events 成员）；旧宿主 events 数组
 * 由专设 describe 显式覆盖。守卫型静默回退（Array.isArray(session?.events) ? …）
 * 在新宿主默认夹具下必须变红。
 *
 * 纯函数 + 依赖注入，不触碰真实 ~/.dsh 或 zstd 文件。
 */
import { describe, it, expect, vi } from 'vitest'
import { unclosedTurns, attachExitWarning, detectUnclosed } from '../lib/interrupt-guard.js'

function turnStart(turn) {
  return { type: 'turn/start', seq: turn * 10, data: { turn } }
}
function turnEnd(turn, reasonKind) {
  return { type: 'turn/end', seq: turn * 10 + 1, data: { turn, reason: { kind: reasonKind } } }
}

/** Production new-host session: NO `events` member (DSH Desktop 2.0.9 shape). */
function newHostSession(events) {
  return {
    snapshotEvents: () => Object.freeze(events.slice()),
    eventAt: (seq) => events[seq],
  }
}

/** Explicit legacy host: the plain events array is the only view. */
function legacySession(events) {
  return { events }
}

describe('unclosedTurns（R4 检测）', () => {
  it('正常闭合轮次 → 无未闭合', () => {
    const session = newHostSession([turnStart(1), turnEnd(1, 'completed'), turnStart(2), turnEnd(2, 'completed')])
    expect(unclosedTurns(session)).toEqual([])
  })

  it('有 turn/start 无 turn/end（崩溃/强杀现场）→ open', () => {
    const session = newHostSession([turnStart(1), turnEnd(1, 'completed'), turnStart(2)])
    const r = unclosedTurns(session)
    expect(r).toEqual([{ turn: 2, state: 'open' }])
  })

  it('turn/end reason=interrupted → 官方正常闭合，不计未闭合', () => {
    const session = newHostSession([turnStart(1), turnEnd(1, 'interrupted')])
    expect(unclosedTurns(session)).toEqual([])
  })

  it('turn/end reason=aborted → 官方正常闭合，不计未闭合', () => {
    const session = newHostSession([turnStart(1), turnEnd(1, 'aborted')])
    expect(unclosedTurns(session)).toEqual([])
  })

  it('多轮混合：中断闭合 + 尾部真 open 只报 open', () => {
    const session = newHostSession([turnStart(1), turnEnd(1, 'interrupted'), turnStart(2), turnEnd(2, 'completed'), turnStart(3)])
    expect(unclosedTurns(session)).toEqual([{ turn: 3, state: 'open' }])
  })

  it('空会话/无事件视图 → 空', () => {
    expect(unclosedTurns(newHostSession([]))).toEqual([])
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(unclosedTurns({})).toEqual([]) // no view at all → [] + one-shot diagnostic
    spy.mockRestore()
  })

  it('detectUnclosed 别名导出可用', () => {
    const session = newHostSession([turnStart(1), turnEnd(1, 'interrupted')])
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
      's-1': newHostSession([turnStart(1), turnEnd(1, 'completed'), turnStart(2)]), // 未闭合 turn 2
      's-2': newHostSession([turnStart(1), turnEnd(1, 'completed')]), // 闭合
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
      's-1': newHostSession([turnStart(1), turnEnd(1, 'completed')]),
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

  // 会话枚举兼容(P1 静默退化):新宿主 SessionStore 只有 list(),没有 keys()。
  // 旧写法 `keys() ?? Object.keys(service)` 在 list()-only 假体上取到服务字段而非
  // session id ⇒ 未闭合轮告警静默为空。这里必须断言「确实看到了 N 个」。
  describe('会话枚举:新宿主 list() / 旧宿主 keys()', () => {
    const open = (id) => ({ ...newHostSession([turnStart(1), turnEnd(1, 'completed'), turnStart(2)]), id })
    const clean = (id) => ({ ...newHostSession([turnStart(1), turnEnd(1, 'completed')]), id })

    it('新宿主:list() 且无 keys() → 对每个未闭合会话各记一条(旧实现得 0)', () => {
      const all = [open('s-1'), open('s-2'), clean('s-3')]
      const ctx = { sessions: { list: () => all, get: (id) => all.find((s) => s.id === id) } }
      const lines = []
      attachExitWarning(ctx, (l) => lines.push(l))()
      expect(lines.length).toBe(2)
      expect(lines.join('\n')).toContain('s-1')
      expect(lines.join('\n')).toContain('s-2')
      expect(lines.join('\n')).not.toContain('s-3')
    })

    it('旧宿主:只有 keys() → 同样逐条记(旧宿主回退未丢)', () => {
      const ctx = makeCtxWithSessions({ 's-1': open('s-1'), 's-2': clean('s-2') })
      const lines = []
      attachExitWarning(ctx, (l) => lines.push(l))()
      expect(lines.length).toBe(1)
      expect(lines[0]).toContain('s-1')
    })
  })

  // 旧宿主兼容（显式覆盖）：events 数组形状同样被检测/告警。
  describe('旧宿主（显式 events 数组覆盖）', () => {
    it('unclosedTurns 在 legacy 形状上照常检出', () => {
      expect(unclosedTurns(legacySession([turnStart(1), turnEnd(1, 'completed'), turnStart(2)])))
        .toEqual([{ turn: 2, state: 'open' }])
    })

    it('attachExitWarning 在 legacy Map 注册表上照常告警', () => {
      const ctx = makeCtxWithSessions({ 's-1': legacySession([turnStart(1), turnEnd(1, 'completed'), turnStart(2)]) })
      const lines = []
      attachExitWarning(ctx, (l) => lines.push(l))()
      expect(lines.length).toBe(1)
      expect(lines[0]).toContain('turn 2 (open)')
    })
  })
})
