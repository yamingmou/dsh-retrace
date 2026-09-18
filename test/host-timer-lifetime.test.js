/**
 * dsh-retrace · test/host-timer-lifetime.test.js
 *
 * 外部 issue #1（桌面端托盘退出死锁）的第二组根因：**两个定时器拖住宿主退出**。
 * 宿主是 Node 侧，引用型定时器（未 `unref`）会把宿主进程钉在事件循环上：
 *   ① lib/boot-pin.js 的启动重试链（30s × 20 ≈ 启动后 10 分钟）；
 *   ② lib/watchdog.js 的轮询 interval（10s，永不结束）。
 * 两者此前都不 `unref`；bootPin 的句柄还被丢弃（dispose 也撤不掉）。
 *
 * 验收方式：`schedule` / `unschedule` 可注入 ⇒ 用例直接捕获句柄，断言
 *   句柄 `unref()` 被调用过，且 dispose 时 `unschedule(handle)` 被调用。
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBootPinRetry } from '../lib/boot-pin.js'
import { createWatchdog } from '../lib/watchdog.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

/** 可注入的假定时器：捕获句柄 + 记录 unref + 手动触发。 */
function fakeTimers() {
  const handles = []
  const unscheduled = []
  return {
    handles,
    unscheduled,
    schedule(cb, ms) {
      const handle = { ms, cb, unref: vi.fn(), fired: false }
      handles.push(handle)
      return handle
    },
    unschedule(handle) { unscheduled.push(handle) },
    /** 触发第 i 个句柄的回调（模拟定时器到点）。 */
    fire(i = handles.length - 1) {
      const handle = handles[i]
      handle.fired = true
      handle.cb()
    },
    /** 链上挂着（尚未触发、尚未撤销）的句柄 = 最后一个。 */
    pending() { return handles[handles.length - 1] },
  }
}

describe('bootPin 启动重试链：句柄 unref + 撤离路径存在（issue #1）', () => {
  it('挂上的定时器句柄被 unref（否则 30s 递归把宿主事件循环钉住）', async () => {
    const timers = fakeTimers()
    createBootPinRetry({
      run: async () => ({ value: { total: 1 } }),
      hasResidentSessions: () => true,
      maxAttempts: 3,
      delayMs: 30_000,
      schedule: timers.schedule,
      unschedule: timers.unschedule,
    })
    await flush()
    expect(timers.handles).toHaveLength(1)
    expect(timers.handles[0].unref).toHaveBeenCalledTimes(1)
    expect(timers.handles[0].ms).toBe(30_000)
  })

  it('dispose 撤销挂着的句柄（clearTimeout 等价路径）且幂等', async () => {
    const timers = fakeTimers()
    const retry = createBootPinRetry({
      run: async () => ({ value: { total: 0 } }),
      hasResidentSessions: () => true,
      schedule: timers.schedule,
      unschedule: timers.unschedule,
    })
    await flush()
    const handle = timers.pending()
    retry.dispose()
    expect(timers.unscheduled).toEqual([handle])
    retry.dispose() // 幂等:第二次不再重复撤销
    expect(timers.unscheduled).toEqual([handle])
  })

  it('dispose 之后到点的重试不再跑 run，也不再挂新定时器', async () => {
    const timers = fakeTimers()
    const run = vi.fn(async () => ({ value: { total: 1 } }))
    const retry = createBootPinRetry({
      run,
      hasResidentSessions: () => true,
      maxAttempts: 5,
      schedule: timers.schedule,
      unschedule: timers.unschedule,
    })
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    const pending = timers.pending()
    retry.dispose()
    pending.cb() // 定时器到点:disposed ⇒ step() 直接返回
    await flush()
    expect(run).toHaveBeenCalledTimes(1)
    expect(timers.handles).toHaveLength(1)
  })

  it('每次到点都重新挂一个新句柄，且每个新句柄同样被 unref(链上无裸句柄)', async () => {
    const timers = fakeTimers()
    createBootPinRetry({
      run: async () => ({ value: { total: 2 } }),
      hasResidentSessions: () => true,
      maxAttempts: 3,
      schedule: timers.schedule,
      unschedule: timers.unschedule,
    })
    await flush()
    timers.fire()
    await flush()
    timers.fire()
    await flush()
    expect(timers.handles.length).toBeGreaterThanOrEqual(3)
    for (const handle of timers.handles) expect(handle.unref).toHaveBeenCalledTimes(1)
  })

  it('序号到顶后自然收尾(不再挂新定时器)', async () => {
    const timers = fakeTimers()
    createBootPinRetry({
      run: async () => ({ value: { total: 0 } }),
      hasResidentSessions: () => true,
      maxAttempts: 2,
      schedule: timers.schedule,
      unschedule: timers.unschedule,
    })
    await flush()          // step(0) → 挂 #1
    timers.fire()
    await flush()          // step(1) → 挂 #2
    timers.fire()
    await flush()          // step(2) → 2 >= maxAttempts ⇒ 不挂
    expect(timers.handles).toHaveLength(2)
  })

  it('暂无驻留会话时照样只有"被 unref 的"定时器，不跑 run', async () => {
    const timers = fakeTimers()
    const run = vi.fn(async () => ({ value: { total: 0 } }))
    createBootPinRetry({
      run,
      hasResidentSessions: () => false,
      maxAttempts: 3,
      schedule: timers.schedule,
      unschedule: timers.unschedule,
    })
    await flush()
    expect(run).not.toHaveBeenCalled()
    expect(timers.handles).toHaveLength(1)
    expect(timers.handles[0].unref).toHaveBeenCalledTimes(1)
  })

  it('run 抛错也不留裸句柄(错误路径同样 arm + unref)', async () => {
    const timers = fakeTimers()
    const log = vi.fn()
    createBootPinRetry({
      run: async () => { throw new Error('boom') },
      hasResidentSessions: () => true,
      maxAttempts: 3,
      schedule: timers.schedule,
      unschedule: timers.unschedule,
      log,
    })
    await flush()
    expect(log.mock.calls.some(([line]) => String(line).includes('bootPin error'))).toBe(true)
    expect(timers.handles).toHaveLength(1)
    expect(timers.handles[0].unref).toHaveBeenCalledTimes(1)
  })
})

describe('watchdog 轮询 interval：句柄 unref + dispose 撤销（issue #1）', () => {
  function fakeCtx() {
    return {
      sessions: new Map(),
      on: () => () => {},
    }
  }

  it('注入的 schedule 句柄被 unref；dispose 时 unschedule(handle) 被调用', () => {
    const handle = { unref: vi.fn() }
    const unscheduled = []
    const watchdog = createWatchdog(fakeCtx(), () => {}, {
      intervalMs: 10_000,
      schedule: () => handle,
      unschedule: (h) => unscheduled.push(h),
    })
    expect(handle.unref).toHaveBeenCalledTimes(1)
    watchdog.dispose()
    expect(unscheduled).toEqual([handle])
  })

  it('没有 unref 方法的环境(浏览器侧形状)不抛，dispose 路径照旧', () => {
    const handle = {} // 无 unref
    const unscheduled = []
    const watchdog = createWatchdog(fakeCtx(), () => {}, {
      schedule: () => handle,
      unschedule: (h) => unscheduled.push(h),
    })
    expect(() => watchdog.dispose()).not.toThrow()
    expect(unscheduled).toEqual([handle])
  })
})

describe('装配点：宿主入口把重试链的撤离路径接进 disposers（issue #1 接线面）', () => {
  it('lib/index.js 用 createBootPinRetry 且把它的 dispose 推入 disposers', () => {
    // 这是**接线面**断言(源码级):上面两个用例覆盖模块行为,"模块做好了但没人撤"
    // 是另一类失效(0.4.28 的现场:句柄被丢弃、dispose 里也没它),故在这里钉住。
    const src = readFileSync(path.join(ROOT, 'lib', 'index.js'), 'utf8')
    expect(src).toContain('createBootPinRetry({')
    expect(src).toContain('disposers.push(() => bootPinRetry.dispose())')
    // 旧的裸递归 setTimeout(句柄丢弃)不得复活
    expect(src).not.toMatch(/setTimeout\(\(\) => bootPin\(/)
  })
})
