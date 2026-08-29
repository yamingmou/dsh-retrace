/**
 * dsh-retrace · test/watchdog.test.js
 *
 * R1 实时看门狗测试（方案 插件实现方案-R1看门狗-R2marker契约.md §1）：
 * 1. 模拟双写入（文件尾部 seq 领先内存）→ 快照 + warning（验收 1）；
 * 2. 正常使用（fileSeq <= events.length）不产生任何误报（验收 2）；
 * 3. dispose 后无残留定时器/监听（验收 3）。
 *
 * 全部依赖注入 fake：tailSeqReader / snapshot / sessionFileFor / schedule /
 * unschedule / ctx.on（返回 disposer，对齐 cordis 语义），不触碰真实 ~/.dsh
 * 或真实 zstd 文件。
 */
import { describe, it, expect } from 'vitest'
import { createWatchdog } from '../lib/watchdog.js'

function fakeCtx() {
  const listeners = new Map() // eventName -> Set<fn>
  return {
    sessions: new Map(),
    on(eventName, fn) {
      // 对齐 cordis：ctx.on 返回 disposer 函数（fiber effect 的清理函数）。
      if (!listeners.has(eventName)) listeners.set(eventName, new Set())
      listeners.get(eventName).add(fn)
      return () => listeners.get(eventName)?.delete(fn)
    },
    emit(eventName, payload) {
      for (const fn of listeners.get(eventName) ?? []) fn(payload)
    },
    _listeners: listeners,
  }
}

/** 控制 tailSeqReader / snapshot / ctx.sessions 的测试夹具。 */
function makeHarness(overrides = {}) {
  const ctx = fakeCtx()
  const logLines = []
  const snapshots = []
  let fileSeq = 0
  let scheduledCb = null
  let unscheduled = 0

  const watchdog = createWatchdog(ctx, (line) => logLines.push(line), {
    intervalMs: 10,
    activeWindowMs: 60_000,
    warnCooldownMs: 0, // 测试不禁言，便于断言
    tailSeqReader: overrides.tailSeqReader ?? (async () => fileSeq),
    snapshot: overrides.snapshot ?? (async (id, filePath) => snapshots.push({ id, filePath })),
    sessionFileFor: overrides.sessionFileFor ?? (() => '/fake/session.jsonl.zstd'),
    schedule: (cb) => {
      scheduledCb = cb
      return { __timer: true }
    },
    unschedule: () => {
      unscheduled += 1
      scheduledCb = null
    },
  })

  return {
    ctx,
    logLines,
    snapshots,
    watchdog,
    setFileSeq: (v) => (fileSeq = v),
    runTick: async () => {
      if (typeof scheduledCb === 'function') await scheduledCb()
    },
    unscheduledCount: () => unscheduled,
  }
}

describe('R1 watchdog', () => {
  it('模拟双写入：文件尾部 seq 领先内存 → 快照 + warning', async () => {
    const h = makeHarness()
    const session = { id: 'sess-1', events: new Array(10) }
    h.ctx.sessions.set('sess-1', session)
    h.ctx.emit('session/event', session)
    h.setFileSeq(15) // 另一写入者把文件尾部写到 seq 15（领先内存 10）

    await h.runTick()

    expect(h.snapshots.length).toBe(1)
    expect(h.snapshots[0].id).toBe('sess-1')
    expect(h.logLines.some((l) => l.includes('文件尾部 seq 15 领先内存 10'))).toBe(true)
  })

  it('正常使用：fileSeq <= events.length 不误报', async () => {
    const h = makeHarness()
    const session = { id: 'sess-2', events: new Array(20) }
    h.ctx.sessions.set('sess-2', session)
    h.ctx.emit('session/event', session)

    h.setFileSeq(20) // 一致
    await h.runTick()
    expect(h.snapshots.length).toBe(0)
    expect(h.logLines.some((l) => l.includes('疑似并发写入'))).toBe(false)

    h.setFileSeq(18) // 文件落后（本进程未 flush）——同样不报
    await h.runTick()
    expect(h.snapshots.length).toBe(0)
    expect(h.logLines.some((l) => l.includes('疑似并发写入'))).toBe(false)
  })

  it('tailSeqReader 返回 null（读取失败/降级）→ 不告警不崩溃', async () => {
    const h = makeHarness({ tailSeqReader: async () => null })
    h.ctx.emit('session/event', { id: 'sess-4', events: [] })
    h.setFileSeq(99)
    await h.runTick()
    expect(h.snapshots.length).toBe(0)
    expect(h.logLines.some((l) => l.includes('疑似并发写入'))).toBe(false)
  })

  it('无活跃会话（未 emit session/event）→ 不检查', async () => {
    const h = makeHarness()
    h.setFileSeq(5)
    await h.runTick()
    expect(h.snapshots.length).toBe(0)
  })

  it('dispose 干净：无残留定时器/监听', async () => {
    const h = makeHarness()
    h.ctx.emit('session/event', { id: 'sess-6' })
    h.watchdog.dispose()
    // dispose 后 tick 不再检查（disposed=true 短路），且监听已移除
    await h.runTick()
    expect(h.snapshots.length).toBe(0)
    expect(h.ctx._listeners.get('session/event')?.size ?? 0).toBe(0)
    expect(h.unscheduledCount()).toBe(1) // 定时器已清理
  })

  it('快照钩子抛错 → 记录日志不崩溃', async () => {
    const h = makeHarness({
      snapshot: async () => {
        throw new Error('disk full')
      },
    })
    h.ctx.emit('session/event', { id: 'sess-7', events: [] })
    h.setFileSeq(3)
    await h.runTick()
    expect(h.logLines.some((l) => l.includes('快照失败'))).toBe(true)
  })
})
