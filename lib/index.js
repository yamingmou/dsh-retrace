/**
 * dsh-retrace — Host plugin entry (published form).
 *
 * Registers the retrace operations behind two transports so the same
 * package serves both the desktop/web GUI and headless deployments:
 *
 *  - `harness.handle` when present (the dynamic-package RPC bridge), and
 *  - a same-origin HTTP route under `/api/plugins/retrace/*` for
 *    bundled (published) client modules.
 *
 * The HTTP surface additionally serves the P0 versioning channels:
 * `GET /versions` (projection snapshot fallback), `GET /event` and
 * `GET /surface` (lazy sessionQuery reads). The versioning seam itself
 * (`lib/versioning.js`) lives behind `ctx.inject(...)` — headless
 * compositions without the projection/storage services simply degrade to
 * plain L1 (recall / edit / regenerate), exactly like 0.2.x.
 *
 * Every op resolves to a result object `{ ok: true, value }` /
 * `{ ok: false, error }` produced by the host core, so both transports carry
 * the identical wire shape.
 */
import { createEditorApi } from './host-core.js'
import { createRetraceHttpHandler, ROUTE_PREFIX } from './http.js'
import { createVersioningSeam } from './versioning.js'
import { createRollbackExecutor } from './rollback.js'
import { createMarkerGuard } from './prewrite-guard.js'
import { createWatchdog } from './watchdog.js'
import { attachExitWarning } from './interrupt-guard.js'
import { sessionBadge as fnvBadge } from './badge.js'
import { dshAdapter, semanticBadgeOf } from './adapter/dsh.js'
import { createDshMarkerWriter } from './adapter/dsh-writer.js'
import { readFileSync, readdirSync, accessSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 语义短码（2026-09-01 对齐维护线定稿规则）：优先查 `会话短码表.json`
 * （工作区+序号+父子语义，如 member-65member-16），命中即返回；否则 FNV 兜底。
 * 短码表由 `tools/generate-session-codes.mjs` 生成（基于 header.createdAt + parentSession）。
 */
const BADGE_TABLE_PATH = join(homedir(), 'archive-backup-2026-08', '会话短码表.json')
let badgeTable = null
try {
  badgeTable = JSON.parse(readFileSync(BADGE_TABLE_PATH, 'utf8')).codes ?? null
} catch { /* 表缺失时 FNV 兜底 */ }
/**
 * 会话短码(2026-09-02 v2,三级)——解决"新 fork 会话不在短码表只有 FNV 兜底"：
 * ① archive 短码表(维护线维护,固定);
 * ② 实时推导(工作区 createdAt 序号+父链,与 generate-session-codes.mjs 同规则,
 *    表的新鲜超集——5e551005 这类新会话也能得 member-71member-65);
 * ③ FNV-1a 确定性兜底(任何环境可复现,人机交互最低保障)。
 * ②③ 是 async(推导需扫 header);同步调用点(forkmap 等)用 syncBadge。
 */
let deriveBooted = false
async function sessionBadge(sessionId) {
  const semantic = badgeTable?.[sessionId]
  if (typeof semantic === 'string' && semantic.length > 0) return semantic
  if (!deriveBooted) {
    deriveBooted = true
    const derived = await semanticBadgeOf(sessionId)
    if (derived) return derived
  } else {
    const derived = await semanticBadgeOf(sessionId)
    if (derived) return derived
  }
  return fnvBadge(sessionId)
}

/** 同步短码(表 + FNV;推导留给异步调用点)。 */
function syncBadge(sessionId) {
  const semantic = badgeTable?.[sessionId]
  if (typeof semantic === 'string' && semantic.length > 0) return semantic
  return fnvBadge(sessionId)
}

export const name = 'dsh-retrace'
export const inject = ['sessions', 'agents', 'webServer', 'fs', 'subprocess', 'sandboxPolicy']

export function apply(ctx) {
  const log = (line) => ctx.logger?.info(line)

  // P0 versioning seam: projection unit + artifact snapshots + config view.
  const seam = createVersioningSeam(ctx, log)
  seam.register()

  // 写前校验守卫（8-25 事故闭环）：marker 落盘前过三层契约；依赖缺失自动降级。
  const guard = createMarkerGuard({
    log,
    enabled: (sessionId) => seam.configFor(sessionId).prewrite !== false,
  })
  // 遮蔽写入器（2026-09-02 抽象设计落地）：业务层表达「遮蔽这些消息」，
  // DSH 的 turn/step 翻译（三情形/计数器推进/窗口化防御）隔离在 adapter。
  const markerWriter = createDshMarkerWriter({
    agents: ctx.agents,
    validateMarker: guard.validateMarkerAppend,
    // 情形② step 号从文件全量算（host 窗口化内存不可信，5e551001 复盘 §五）
    readMaxStep: async (sessionId, turn) => dshAdapter.maxStepInTurnFromFile(sessionId, turn),
    log,
  })
  const hooks = { validateMarker: guard.validateMarkerAppend, writeMarker: markerWriter.writeMarker }

  // P1 rollback executor: context/artifact restore over the seam (git + snapshots).
  const rollback = createRollbackExecutor({ ctx, sessions: ctx.sessions, agents: ctx.agents, seam, validateMarker: hooks.validateMarker, writeMarker: hooks.writeMarker, log })

  const api = createEditorApi(ctx, ctx.sessions, ctx.agents, log, hooks)
  const handler = createRetraceHttpHandler(ctx, {
    sessions: ctx.sessions,
    agents: ctx.agents,
    seam,
    rollback,
    hooks,
    log,
  })

  const disposeRoute = (() => {
    const webServer = ctx.get('webServer')
    if (webServer && typeof webServer.register === 'function') {
      try {
        return webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler,
        })
      } catch (error) {
        ctx.logger?.warn(`dsh-retrace: route registration failed: ${String(error)}`)
      }
    }
    return () => {}
  })()

  // Dynamic-package bridge: no-op when this file runs as a plain published plugin.
  const disposeHarness = (() => {
    if (typeof harness === 'undefined' || !harness || typeof harness.handle !== 'function') return () => {}

    /**
     * 从文件全量事件计算「遮蔽范围」(事件级,绕开 host 稀疏 session.events)。
     * 返回 { start, end, shadowedSeqs } 或 null。
     * mode='round' 遮蔽目标轮;mode='tail' 遮蔽目标之后(编辑 fromScratch)。
     */
    // spanFromFile 从 lib/file-span.js 引入(读文件全量算遮蔽)
    // 标题固定 + 短码(2026-09-02 v2):任何 retrace 操作发生 = 会话活跃,
    // 用**官方 sessionTitle.rename** 写 `[短码] 原标题`(user source title)→
    // 官方自动改名被永久关闭(onUserMessage 见 user source 不再生成)+ 侧边栏/
    // 标题栏投影立即刷新。不再用 session.append(append 不更新 title 投影,
    // 且 0.4.17 前从未让用户看到短码——只依赖 ForkView 打开的旧路已弃)。
    async function ensureBadgeTitle(sessionId) {
      try {
        const sid = String(sessionId ?? '')
        const session = ctx.sessions?.get?.(sid)
        if (!session) return
        const badge = await sessionBadge(sid)
        if (!badge) return
        let currentTitle = ''
        for (let i = session.events.length - 1; i >= 0; i--) {
          if (session.events[i]?.type === 'session/title') { currentTitle = session.events[i].data?.title ?? ''; break }
        }
        // 无标题时用 cwd 基名(比 sessionId 前 16 位可读)
        if (!currentTitle) {
          const cwd = session.header?.cwd ?? ''
          currentTitle = cwd.split('/').filter(Boolean).pop() || String(sid).slice(0, 16)
        }
        // 去掉旧版可能已拼的任意 [xxx] 前缀(只去 badge 本身避免误删内容)
        const clean = currentTitle.replace(/^\[[a-z0-9]{6,}\]\s*/, '')
        const tagged = `[${badge}] ${clean}`
        if (currentTitle === tagged || currentTitle.startsWith(`[${badge}] `)) return
        pinTitle(session, tagged)
      } catch { /* 标题写入失败不影响操作 */ }
    }
    /** 官方 rename pin:user source title → 关闭自动改名 + 投影刷新。 */
    function pinTitle(session, title) {
      const titles = ctx.get?.('sessionTitle')
      if (session && titles && typeof titles.rename === 'function') {
        try { titles.rename(session, title); return true } catch { /* fallback append */ }
      }
      session?.append?.('session/title', { title, source: { kind: 'user' } })
      return true
    }
    // 2026-09-01:操作前从文件算遮蔽(绕开 host 稀疏 session.events,用户方案)
    const withFileSpan = (op, modeOf) => async (args) => {
      await ensureBadgeTitle(args?.sessionId)
      // 情形② step 号:writer 的 readMaxStep 已在装配时注入(index.js createDshMarkerWriter
      // 闭包,从文件全量算)——不再经 args 传递(3e2262a 下沉后 writer 是唯一消费方)。
      try {
        const target = typeof args?.seq === 'number' ? args.seq : args?.messageId
        if (target !== undefined && target !== null && !args?.span) {
          const span = await dshAdapter.spanFromFile(args.sessionId, target, modeOf(args))
          log(`retrace: spanFromFile(op=${op} target=${String(target).slice(0, 24)}) → ${span ? `${span.shadowedSeqs.length} seqs` : 'null(fallback)'}`)
          if (span) args = { ...args, span }
        } else {
          log(`retrace: spanFromFile skipped(op=${op} target=${String(target).slice(0, 24)} hasSpan=${!!args?.span})`)
        }
      } catch (error) { log(`retrace: spanFromFile wrapper error: ${String(error).slice(0, 120)}`) }
      return api[op](args)
    }
    /**
     * 批量 pin 全部已驻留会话(2026-09-02 v2):用官方 rename 写 `[短码] 原标题`。
     * 启动时/新会话驻留时调用——用户打开 DSH 侧边栏即可看到短码,不依赖
     * 打开 ForkView 或先编辑。返回结果数组。
     */
    async function pinAllResident() {
      const results = []
      const sessionStore = ctx.sessions
      if (!sessionStore || (typeof sessionStore.list !== 'function' && typeof sessionStore.values !== 'function')) {
        return { ok: false, error: { code: 'unavailable', message: 'session store not enumerable' } }
      }
      try {
        const sessions = typeof sessionStore.list === 'function' ? sessionStore.list() : [...sessionStore.values()]
        for (const session of sessions) {
          const sessionId = session?.id ?? session?.sessionId
          if (!sessionId) continue
          try {
            const badge = await sessionBadge(sessionId)
            if (!badge) continue
            let currentTitle = ''
            for (let i = session.events.length - 1; i >= 0; i--) {
              if (session.events[i]?.type === 'session/title') {
                currentTitle = session.events[i].data?.title ?? ''
                break
              }
            }
            if (!currentTitle) {
              const cwd = session.header?.cwd ?? ''
              currentTitle = cwd.split('/').filter(Boolean).pop() || sessionId.slice(0, 16)
            }
            const clean = currentTitle.replace(/^\[[a-z0-9]{6,}\]\s*/, '')
            const tagged = `[${badge}] ${clean}`
            if (currentTitle === tagged || currentTitle.startsWith(`[${badge}] `)) {
              results.push({ sessionId, badge, alreadyTagged: true })
              continue
            }
            pinTitle(session, tagged)
            results.push({ sessionId, badge, alreadyTagged: false })
          } catch (error) {
            results.push({ sessionId, badge: null, error: String(error) })
          }
        }
        return { ok: true, value: { total: results.length, results } }
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: String(error) } }
      }
    }
    /**
     * 启动批量 pin:DSH 会话渐进驻留,定期重试直到覆盖(幂等可重复,alreadyTagged 跳过)。
     * 0.4.19 缺陷(用户实测前发现):`bootPin(99)` 被 `retries>=8` 挡住 → 30s 重跑永不执行;
     * 启动 24s 窗口内会话未驻留 → 永久放弃 → 短码永不显示(全天 0 条 bootPin 日志)。
     * 修法:每次(成功或失败)都安排下一次,共 MAX_ATTEMPTS 次(30s×20 ≈ 启动后 10 分钟
     * 窗口,覆盖渐进驻留);错误打日志不静默。
     */
    function bootPin(attempts = 0) {
      const MAX_ATTEMPTS = 20
      const schedule = () => {
        if (attempts < MAX_ATTEMPTS) setTimeout(() => bootPin(attempts + 1), 30000)
      }
      const sessionStore = ctx.sessions
      const hasSessions = sessionStore && (
        (typeof sessionStore.list === 'function' && sessionStore.list().length > 0) ||
        (typeof sessionStore.values === 'function' && sessionStore.values().length > 0)
      )
      if (!hasSessions) {
        schedule()
        return
      }
      pinAllResident()
        .then((result) => {
          log(`retrace: bootPin(${attempts}) → ${result?.value?.total ?? 0} 个驻留会话标题已处理`)
          schedule()
        })
        .catch((error) => {
          log(`retrace: bootPin error: ${String(error).slice(0, 160)}`)
          schedule()
        })
    }
    bootPin(0)
    const disposers = [
      // 2026-09-07:recall 语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉,bfb965e4/
      // 5e551006 issue 要求)——不再只遮蔽目标轮(缺陷①断层);tail 在官方 foldSurface
      // nodes 上按位置切(ISSUE-20260907113201 修复),大范围遮蔽由快照点守卫引导分支。
      harness.handle('retrace.recall', withFileSpan('recall', () => 'tail')),
      harness.handle('retrace.editAndResend', withFileSpan('editAndResend', (a) => (a?.fromScratch ? 'tail' : 'round'))),
      harness.handle('retrace.regenerate', withFileSpan('regenerate', () => 'round')),
      // 会话短码（2026-08-31）：session id → 确定性 10 位短码，人机交互识别用。
      harness.handle('retrace.sessionBadge', async (args) => {
        const sessionId = String(args?.sessionId ?? '')
        return { ok: true, value: { sessionId, badge: await sessionBadge(sessionId) } }
      }),
      // 会话短码写入标题（2026-09-01）：给会话 title 组装「[短码]原标题」，
      // 不改标题内容本身，只在标题前加短码标识。
      harness.handle('retrace.setBadgeTitle', async (args) => {
        const sessionId = String(args?.sessionId ?? '')
        if (!sessionId) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } }
        const session = ctx.sessions?.get?.(sessionId)
        if (!session) return { ok: false, error: { code: 'not-found', message: 'session not found' } }
        try {
          const badge = await sessionBadge(sessionId)
          // 读当前 title（最后一个 session/title 事件或 header.title）
          let currentTitle = ''
          for (let i = session.events.length - 1; i >= 0; i--) {
            if (session.events[i]?.type === 'session/title') {
              currentTitle = session.events[i].data?.title ?? ''
              break
            }
          }
          if (!currentTitle) currentTitle = sessionId.slice(0, 16)
          // 检查是否已含短码（避免重复写入）
          const tagged = `[${badge}] `
          if (currentTitle.startsWith(tagged)) return { ok: true, value: { title: currentTitle, badge, alreadyTagged: true } }
          const clean = currentTitle.replace(/^\[[a-z0-9]{6,}\]\s*/, '')
          const newTitle = tagged + clean
          pinTitle(session, newTitle)
          return { ok: true, value: { title: newTitle, badge, alreadyTagged: false } }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String(error) } }
        }
      }),
      // 用户自定义会话名称（2026-09-01）：`[短码] 用户输入` 写入 user source title。
      // 官方语义：user source title 固定会话名，后续自动生成（title-llm）被禁用。
      harness.handle('retrace.setUserTitle', async (args) => {
        const sessionId = String(args?.sessionId ?? '')
        const title = String(args?.title ?? '').trim()
        if (!sessionId) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } }
        if (!title) return { ok: false, error: { code: 'bad-request', message: 'title required' } }
        const session = ctx.sessions?.get?.(sessionId)
        if (!session) return { ok: false, error: { code: 'not-found', message: 'session not found' } }
        try {
          const badge = await sessionBadge(sessionId)
          // 用户输入已含短码则直接用，否则拼接
          const tagged = title.startsWith(`[${badge}]`) ? title : `[${badge}] ${title}`
          pinTitle(session, tagged)
          return { ok: true, value: { title: tagged, badge } }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String(error) } }
        }
      }),
      harness.handle('retrace.initBadgeTitles', () => pinAllResident()),
    ]
    return () => disposers.forEach((dispose) => dispose())
  })()

  // R1 实时看门狗：轮询文件尾部 seq vs 内存长度，捕获并发写入/旧光标回放现场。
  const watchdog = createWatchdog(ctx, log)

  // R4 中断轮次治理：退出/重载时对未闭合 turn 会话提示（只检测不写事件）。
  const warnUnclosed = attachExitWarning(ctx, log)

  ctx.effect(() => () => {
    disposeRoute()
    disposeHarness()
    watchdog.dispose()
    warnUnclosed()
  }, 'dsh-retrace: transports')
}
