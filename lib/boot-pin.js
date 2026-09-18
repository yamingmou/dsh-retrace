/**
 * dsh-retrace — lib/boot-pin.js
 *
 * 启动批量 pin 的**重试调度**（唯一职责:什么时候再跑一次)。
 *
 * 从 lib/index.js 迁出的理由(2026-09-18 外部 issue #1:桌面端托盘退出死锁):
 * 原实现是内联的递归 `setTimeout`,句柄被丢弃、既不 `unref` 也不在 dispose 里清。
 * 宿主是 Node 侧 —— 一条 30s 递归(最多 20 次 ≈ 启动后 10 分钟)会把宿主事件循环
 * 钉住,退出/关机流程得等它跑完(桌面端退不掉的两个拖累之一,另一个见
 * lib/watchdog.js)。
 *
 * 与 lib/watchdog.js 同款:定时器创建/销毁可注入(`schedule` / `unschedule`),
 * 于是"句柄有没有 unref""dispose 有没有撤销"能被用例直接捕获,不靠 review。
 * 职责边界:本模块只决定"何时重试";"重试做什么"由 `run()` 注入(装配点传
 * pinAllResident),"现在有没有可处理的会话"由 `hasResidentSessions()` 注入。
 * 本模块零 import、零宿主服务引用(可单测,也进得了动态件 realm)。
 */

/** 默认重试上限(对齐 0.4.19 的启动窗口:20 × 30s ≈ 启动后 10 分钟)。 */
export const BOOT_PIN_MAX_ATTEMPTS = 20
/** 默认重试间隔。 */
export const BOOT_PIN_DELAY_MS = 30_000

/**
 * 建启动重试链。
 * @param {object} options
 * @param {() => Promise<any>} options.run 实际执行体(返回值里的 `value.total` 用于日志)。
 * @param {() => boolean} options.hasResidentSessions 现在有没有可处理的会话。
 * @param {(line: string) => void} [options.log] 诊断日志。
 * @param {number} [options.maxAttempts] 重试上限(含首跑)。
 * @param {number} [options.delayMs] 重试间隔。
 * @param {(cb: () => void, ms: number) => unknown} [options.schedule] 定时器创建
 *   (默认全局 setTimeout;返回的句柄上若有 `unref` 会被调用)。
 * @param {(handle: unknown) => void} [options.unschedule] 定时器销毁(默认全局 clearTimeout)。
 * @returns {{ dispose(): void }} dispose = 停止重试链 + 撤掉挂着的定时器(幂等)。
 */
export function createBootPinRetry({
  run,
  hasResidentSessions,
  log = () => {},
  maxAttempts = BOOT_PIN_MAX_ATTEMPTS,
  delayMs = BOOT_PIN_DELAY_MS,
  schedule = (cb, ms) => setTimeout(cb, ms),
  unschedule = (handle) => clearTimeout(handle),
} = {}) {
  if (typeof run !== 'function') throw new TypeError('createBootPinRetry: run must be a function')
  if (typeof hasResidentSessions !== 'function') throw new TypeError('createBootPinRetry: hasResidentSessions must be a function')

  let timer = null
  let disposed = false

  /** 挂下一次(序号 = next)。序号到顶就不挂,链自然收尾。 */
  function arm(next) {
    if (disposed || next >= maxAttempts) return
    timer = schedule(() => {
      timer = null
      step(next + 1)
    }, delayMs)
    // 宿主是 Node 侧:不 unref ⇒ 这条 30s 递归把事件循环钉到启动后 10 分钟,
    // 退出/关机被它拖住。unref 后宿主该退就退(会话仍在时事件循环自有别的句柄撑着)。
    if (timer && typeof timer.unref === 'function') timer.unref()
  }

  function step(current) {
    if (disposed) return
    const finish = () => arm(current)
    if (!hasResidentSessions()) {
      finish()
      return
    }
    Promise.resolve()
      .then(() => run())
      .then((result) => {
        log(`retrace: bootPin(${current}) → ${result?.value?.total ?? 0} 个驻留会话标题已处理`)
      })
      .catch((error) => {
        log(`retrace: bootPin error: ${String(error).slice(0, 160)}`)
      })
      .then(finish)
  }

  step(0)

  return {
    /** 停止重试链并撤掉挂着的定时器(重复调用安全)。 */
    dispose() {
      disposed = true
      if (timer !== null) {
        unschedule(timer)
        timer = null
      }
    },
  }
}
