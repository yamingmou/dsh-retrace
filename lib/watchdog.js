/**
 * dsh-retrace — R1 实时看门狗（watchdog）。
 *
 * 2026-08 事故根因 1/2（旧光标回放、多进程共享会话目录）的现场防线：
 * `dsh-session-persistence` 的 `appendCore` 只断言「事件 seq == 进程内 cursor」
 * （lib/index.js:835），**不复查文件尾部**——另一进程/旧光标写入时，文件尾部
 * seq 会领先于本进程内存会话长度，且没有任何写入路径会发现它。
 *
 * 本模块在运行期间轮询：对最近活跃的 attach 会话，比较「文件尾部最后一条
 * 事件的 seq」与「内存会话事件数」。只检查一个方向：
 *   fileSeq > events.length → 文件被本进程以外的写入者追加（异常）→ 快照 + 告警。
 *   fileSeq <= events.length → 正常（本进程未 flush 或一致）。
 * 绝不检查 fileSeq < events.length（本进程追加未 flush 是常态，必误报）。
 *
 * 设计约束（方案 插件实现方案-R1看门狗-R2marker契约.md §1）：
 * - 不重写 zstd 帧扫描：尾部 seq 读取走 `dsh-log-contract` 的 `tailSeq`（懒加载，
 *   复用 scanZstdFrames 解最后一帧）；包缺失/加载失败时降级为「不检查」+ warning。
 * - 快照是字节级复制（ctx.fs.readBytes → 写快照），不重压，保留现场原状。
 * - 每会话 5 分钟防刷屏；卸载/热重载时 dispose 干净（无残留定时器/监听）。
 */
import { join } from 'node:path'
// 会话文件定位收敛到 lib/platform/session-paths.js 单一实现($DSH_HOME/sessions →
// ~/dsh-v3/sessions → ~/.dsh/sessions;两种文件名都认)。此前这里另写一份硬编码,
// 基座换代后看门狗会盯错目录(漏报)。
// 快照落点同样从这里取(pluginDataHome = 与会话基座**同源**):此前用官方
// resolveDshHome()(只认 $DSH_HOME → ~/.dsh),未设 $DSH_HOME 且两基座都在时
// 「会话读 ~/dsh-v3、快照写 ~/.dsh」——快照不是会话所在基座的那一份(2026-09-14 实测)。
import { sessionFilePath, pluginDataHome } from './platform/session-paths.js'
import { sessionEvents } from './host-compat.js'

const CHECK_INTERVAL_MS = 10_000
const ACTIVE_WINDOW_MS = 5 * 60_000
const WARN_COOLDOWN_MS = 5 * 60_000
const SNAPSHOT_DIR = 'dsh-retrace/snapshots'

/**
 * 建立看门狗。
 * @param {object} ctx - cordis 上下文（on/logger/fs/subprocess）。
 * @param {(line: string) => void} [log] - 诊断日志。
 * @param {object} [options]
 * @param {number} [options.intervalMs] - 轮询间隔（默认 10s，测试注入小值）。
 * @param {number} [options.activeWindowMs] - 「最近活跃」窗口（默认 5min）。
 * @param {(sessionId: string, filePath: string) => Promise<void>} [options.snapshot]
 *   快照钩子（默认字节级复制；测试注入 fake）。
 * @param {() => Promise<number|null>} [options.tailSeqReader] 文件尾部 seq 读取器
 *   （默认懒加载 dsh-log-contract tailSeq；测试注入 fake）。
 * @param {(sessionId: string) => string|null} [options.sessionFileFor]
 *   会话文件路径解析（默认按 $DSH_HOME/~/dsh-v3/~/.dsh 基座候选；测试注入 fake）。
 * @param {(cb: () => void, ms: number) => unknown} [options.schedule]
 *   定时器创建（默认全局 setInterval；⚠️ 不要用 ctx.setInterval——cordis ctx 是
 *   Proxy，访问未 inject 的 `timer` 属性会抛 "cannot get property ... without inject"）。
 *   返回的句柄上若有 `unref`，本模块会调用它（宿主退出不被轮询钉住；测试可用假句柄断言）。
 * @param {(handle: unknown) => void} [options.unschedule]
 *   定时器销毁（默认全局 clearInterval）。
 * @returns {{ dispose(): void }}
 */
export function createWatchdog(ctx, log = () => {}, options = {}) {
  const {
    intervalMs = CHECK_INTERVAL_MS,
    activeWindowMs = ACTIVE_WINDOW_MS,
    warnCooldownMs = WARN_COOLDOWN_MS,
    snapshot = defaultSnapshot,
    tailSeqReader = defaultTailSeqReader,
    sessionFileFor: resolveFile = sessionFileFor,
    schedule = (cb, ms) => setInterval(cb, ms),
    unschedule = (handle) => clearInterval(handle),
  } = options

  /** sessionId → lastSeenTs（最近一次 session/event 时间）。 */
  const active = new Map()
  /** sessionId → 上次告警时间（防刷屏）。 */
  const lastWarnAt = new Map()
  let timer = null
  let disposed = false

  const onSessionEvent = (session) => {
    if (!session || typeof session.id !== 'string') return
    active.set(session.id, Date.now())
  }

  async function tick() {
    if (disposed) return
    const now = Date.now()
    for (const [sessionId, lastSeen] of active) {
      if (now - lastSeen > activeWindowMs) {
        active.delete(sessionId) // 超过窗口不再跟踪
        continue
      }
      const filePath = resolveFile(sessionId)
      if (filePath === null) continue
      try {
        const fileSeq = await tailSeqReader(filePath)
        if (fileSeq === null || fileSeq === undefined) continue // 读取失败/降级
        const memoryLength = memoryLengthFor(ctx, sessionId)
        // 内存视图里没有这个会话 ⇒ 无法比较，跳过（不得当成 0，见 memoryLengthFor 注释）
        if (memoryLength === null) continue
        if (fileSeq > memoryLength && now - (lastWarnAt.get(sessionId) ?? 0) >= warnCooldownMs) {
          lastWarnAt.set(sessionId, now)
          try {
            await snapshot(sessionId, filePath)
            log(`retrace-watchdog: 会话 ${sessionId} 文件尾部 seq ${fileSeq} 领先内存 ${memoryLength} —— 疑似并发写入/旧光标回放，已快照到 ${SNAPSHOT_DIR}/`)
          } catch (error) {
            log(`retrace-watchdog: 会话 ${sessionId} 检测到文件领先但快照失败：${String(error)}`)
          }
        }
      } catch (error) {
        log(`retrace-watchdog: 会话 ${sessionId} 检查失败：${String(error)}`)
      }
    }
  }

  // 订阅会话事件（与 dsh-token-meter lib/index.js:480 同款用法）；只记录活跃度。
  // ⚠️ ctx.on() 返回 disposer 函数（cordis fiber effect 的清理函数），
  // 不要用 ctx.off —— cordis 无 off 方法，访问未定义属性会踩 Proxy 抛错。
  const disposeEvent = ctx.on('session/event', onSessionEvent)

  // ⚠️ 不用 ctx.setInterval：cordis ctx 是 Proxy，访问未 inject 的 `timer` 属性
  // 直接抛 "cannot get property \"timer\" without inject"（实测启动崩溃）。
  // 全局 setInterval 由 host-runner sandbox 重定向（sandbox.js:92 TIMER_REDIRECT）。
  timer = schedule(tick, intervalMs)
  // 2026-09-18（外部 issue #1：桌面端托盘退出死锁）：引用型定时器会把宿主进程钉在
  // 事件循环上——会话早就跑完、插件也 dispose 过，宿主仍等这个 interval，退出/关机
  // 被它拖住。宿主是 Node 侧 ⇒ unref（浏览器侧没有 unref，那里也不存在这个问题）。
  // 注入的 schedule 同样走这一行，所以用例能用一个假句柄捕获到 unref 调用。
  if (timer && typeof timer.unref === 'function') timer.unref()
  // 立即跑一次，避免启动后首个周期空窗。
  tick().catch((error) => log(`retrace-watchdog: 首轮检查失败：${String(error)}`))

  return {
    dispose() {
      disposed = true
      if (timer !== null) {
        unschedule(timer)
        timer = null
      }
      if (typeof disposeEvent === 'function') {
        disposeEvent()
      }
      active.clear()
      lastWarnAt.clear()
    },
  }
}

/** 会话文件路径：按 $DSH_HOME/~/dsh-v3/~/.dsh 候选解析（找不到返回 null，可能无持久化）。 */
function sessionFileFor(sessionId) {
  return sessionFilePath(sessionId)
}

/**
 * 内存会话长度：ctx.sessions 里该 id 的 events 数。
 * **取不到就返回 null（未知），而不是 0** —— 返回 0 会把"这个会话不在本进程的
 * 内存视图里"降级成"内存里 0 条"，于是 `fileSeq > 0` 恒真、看门狗每 5 分钟对
 * 每个活跃会话抓一次全量快照（实测：4 个会话全部 memoryLength=0，含 10.9MB 父会话，
 * 快照目录持续增长）。未知 ≠ 落后，宁可不下判断。
 */
function memoryLengthFor(ctx, sessionId) {
  try {
    const session = typeof ctx.sessions?.get === 'function' ? ctx.sessions.get(sessionId) : undefined
    if (!session) return null
    // 有事件视图(新宿主 snapshotEvents / 旧宿主事件数组)才谈「长度」;两者都没有 = 未知。
    const hasEventView = typeof session.snapshotEvents === 'function' || Array.isArray(session?.events)
    if (hasEventView) return sessionEvents(session).length
  } catch { /* ignore */ }
  return null
}

/** 默认尾部 seq 读取：懒加载 dsh-log-contract 的 tailSeq；失败返回 null（降级不检查）。 */
let tailSeqPromise = null
async function defaultTailSeqReader(filePath) {
  if (tailSeqPromise === null) {
    tailSeqPromise = import('dsh-log-contract')
      .then((m) => (typeof m.tailSeq === 'function' ? m.tailSeq : null))
      .catch((error) => {
        tailSeqPromise = null // 允许下次重试
        throw error
      })
  }
  const tailSeq = await tailSeqPromise
  if (tailSeq === null) return null
  return tailSeq(filePath)
}

/**
 * 默认快照：字节级复制到 `<pluginDataHome()>/dsh-retrace/snapshots/<id>-<ts>.jsonl.zstd`
 * ($DSH_HOME 设了 = 它;未设 = 活动会话基座 → ~/dsh-v3 → ~/.dsh,即**与会话同源**)。
 */
async function defaultSnapshot(sessionId, filePath) {
  const { readFile, mkdir, writeFile } = await import('node:fs/promises')
  const dir = join(pluginDataHome(), SNAPSHOT_DIR)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const bytes = await readFile(filePath)
  const target = join(dir, `${sessionId}-${Date.now()}.jsonl.zstd`)
  await writeFile(target, bytes, { mode: 0o600 })
}
