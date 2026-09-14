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
import { sessionEvents } from './host-compat.js'
import { createRetraceHttpHandler, ROUTE_PREFIX } from './http.js'
import { createVersioningSeam } from './versioning.js'
import { createRollbackExecutor } from './rollback.js'
import { createMarkerGuard } from './prewrite-guard.js'
import { createWatchdog } from './watchdog.js'
import { attachExitWarning } from './interrupt-guard.js'
import { attachCloseGuard, runningSessions, sessionRunningState } from './close-guard.js'
import { sessionBadge as fnvBadge } from './badge.js'
import { dshAdapter, semanticBadgeOf } from './adapter/dsh.js'
// span 显式状态结果 → 业务层判定输入的统一下传(单一真相模块)
import { spanMissArgsOf, describeSpanResult } from './span-semantics.js'
import { createDshMarkerWriter } from './adapter/dsh-writer.js'
// 官方「事件 → 模型可见消息」派生(逐节点估价的口径,见 adapter/dsh-writer.js):
// 宿主入口可以静态 import 官方包;动态件里同一逻辑由 measure() 表面法兜底。
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { readFileSync } from 'node:fs'
// 固定落点探测(会话基座 + 短码表 + 身份映射)收敛到 lib/platform/session-paths.js 单一实现。
import { resolveBadgeTablePath } from './platform/session-paths.js'
import { readSessionHeader } from 'dsh-log-contract'
import { createShortcodeResolver } from './identity/shortcode.js'

/**
 * 语义短码（2026-09-01 定稿）：优先查 `会话短码表.json`
 * （工作区前缀 + 序号 + 父子语义），命中即返回；否则 FNV 兜底。
 * 短码表由生成器产出（基于 header.createdAt + parentSession）。
 * 落点**可探测/可覆写**（`DSH_RETRACE_BADGE_TABLE` → 规范落点 → 基座旁）——
 * 此前钉死单一绝对路径，归档位置一变就读不到；表内容与口径不变，仅解析落点。
 */
let badgeTable = null
try {
  badgeTable = JSON.parse(readFileSync(resolveBadgeTablePath(), 'utf8')).codes ?? null
} catch { /* 表缺失时 FNV 兜底 */ }

/**
 * 权威短码解析器（lib/identity/shortcode.js）：把「已登记码钉住 + 新会话追加」
 * 解成 `uuid → code`，并做 id 形态归一化。**同步**构建（注入进程内 header 读取器，
 * 不 spawn 外部二进制），因此同步/异步两个调用点共用同一份缓存 —— 同一会话在任何
 * 调用点拿到同一个码（旧实现 sync 走 FNV、async 走推导，同一会话会出现两个码）。
 *
 * 为什么不直接用旧的三级逻辑：① 表查询是**逐字**的，同一个会话换个 id 形态
 * （`session-<uuid>` vs 裸 uuid，实测两种并存）就查不到；② ②级「按当前基座重推导」
 * 在基座换代后会成片改指到别的会话（实测绝大多数既有码会变，部分直接撞上别人的
 * 已登记码）。钉住+追加把这两条一起消掉。
 *
 * 失败即返回 null，退回既有三级逻辑 —— 短码侧故障不得影响主功能。
 */
let shortcodeResolver = null
function canonicalBadge(sessionId) {
  try {
    shortcodeResolver ??= createShortcodeResolver({
      tablePath: resolveBadgeTablePath(),
      readHeader: readSessionHeader,
    })
    return shortcodeResolver.codeOf(sessionId)
  } catch {
    return null
  }
}

/**
 * 会话短码（三级 → 权威解析器优先）：
 * ① 权威解析器（钉住的已登记码；未登记会话在序号尾部追加新号）；
 * ② archive 短码表（逐字查；解析器不可用时的兜底）；
 * ③ 实时推导（工作区 createdAt 序号+父链）；
 * ④ FNV-1a 确定性兜底（任何环境可复现，人机交互最低保障）。
 *
 * 缓存边界（如实记录）：解析器首次调用时建缓存；此后**新建**的会话不在缓存里，
 * 会落到 ③④（与旧行为一致）。会话增删后应调用 `invalidateBadgeDerive()` 或
 * `shortcodeResolver.refresh()` 重建。
 */
async function sessionBadge(sessionId) {
  const canonical = canonicalBadge(sessionId)
  if (canonical) return canonical
  const semantic = badgeTable?.[sessionId]
  if (typeof semantic === 'string' && semantic.length > 0) return semantic
  const derived = await semanticBadgeOf(sessionId)
  if (derived) return derived
  return fnvBadge(sessionId)
}

/** 同步短码（与 sessionBadge 共用同一份权威缓存，故两者对同一会话结果一致）。 */
function syncBadge(sessionId) {
  const canonical = canonicalBadge(sessionId)
  if (canonical) return canonical
  const semantic = badgeTable?.[sessionId]
  if (typeof semantic === 'string' && semantic.length > 0) return semantic
  return fnvBadge(sessionId)
}

export const name = 'dsh-retrace'
export const inject = ['sessions', 'agents', 'webServer', 'fs', 'subprocess', 'sandboxPolicy', 'jobs']

export function apply(ctx) {
  const log = (line) => ctx.logger?.info(line)

  // P0 versioning seam: projection unit + artifact snapshots + config view.
  const seam = createVersioningSeam(ctx, log)
  seam.register()

  // 写前校验守卫（8-25 事故修复）：marker 落盘前过三层契约；依赖缺失自动降级。
  const guard = createMarkerGuard({
    log,
    enabled: (sessionId) => seam.configFor(sessionId).prewrite !== false,
  })
  // 遮蔽写入器（2026-09-02 抽象设计落地）：业务层表达「遮蔽这些消息」，
  // 两段结构（审计 + 载体）的形状翻译全部隔离在 adapter。
  // turn/step 三情形翻译随载体改造作废（第 2 段是 user/message，token-meter 对它
  // 没有 step 配对要求）⇒ 不再需要 agents 与文件侧 step 号读取器。
  // 官方 token-meter 服务面**注入**给写入器：第 1 段的 shadowedTokenCount 是官方
  // shadow-price claim（令牌价，见 adapter/dsh-writer.js 的 officialShadowPrice）——
  // 取值函数封装 ctx.get，故服务缺失时写入器给出指名道姓的拒写，而不是编一个价。
  // deriveEventMessage 同样注入（官方逐节点估价的口径）：有它就按被遮蔽事件逐个取价，
  // 不依赖 token-meter 的 surface 记账（内存视图滞后时仍取得准）。
  const markerWriter = createDshMarkerWriter({
    validateMarker: guard.validateMarkerAppend,
    meter: () => ctx.get?.('tokenMeter') ?? ctx.tokenMeter,
    deriveMessage: deriveEventMessage,
    log,
  })
  const hooks = {
    validateMarker: guard.validateMarkerAppend,
    writeMarker: markerWriter.writeMarker,
    // Post-write observer (opt-in `summary` switch): builds our own boundary
    // artifact after the marker pair is committed and validated. No seam ⇒ the
    // op behaves exactly like 0.4.x (no artifact, no LLM call).
    onBoundary: (payload) => seam?.onBoundary?.(payload),
  }

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
     * 从文件全量事件计算「遮蔽范围」(事件级,绕开 host 稀疏 events)。
     * 返回 { start, end, shadowedSeqs } 或 null。
     * mode='round' 遮蔽目标轮;mode='tail' 遮蔽目标之后(编辑 fromScratch)。
     */
    // 遮蔽范围一律经 dshAdapter.spanProbeFromFile(读文件全量 events +
    // 官方 foldSurface 重放)算出起返回显式状态 {status, span, facts}。
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
        const events = sessionEvents(session)
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]?.type === 'session/title') { currentTitle = events[i].data?.title ?? ''; break }
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
    // 2026-09-01:操作前从文件算遮蔽(绕开 host 稀疏 events,用户方案)
    const withFileSpan = (op, modeOf) => async (args) => {
      await ensureBadgeTitle(args?.sessionId)
      try {
        const target = typeof args?.seq === 'number' ? args.seq : args?.messageId
        if (target !== undefined && target !== null && !args?.span) {
          const mode = modeOf(args)
          // spanProbe = span + 文件快照事实(同一份快照)。
          // 显式状态:probe.status = SPAN_STATUS 五态——
          //   ok → 注入 span;not-persisted → message-pending;already-shadowed →
          //   target-shadowed(只读);not-found → message-not-found;replay-failed →
          //   内部错误。调用方不再靠"span 为 null + 事实"猜(见 lib/span-semantics.js)。
          const probe = await dshAdapter.spanProbeFromFile(args.sessionId, target, mode)
          log(`retrace: spanFromFile(op=${op} target=${String(target).slice(0, 24)} mode=${mode}) → ${describeSpanResult(probe)}`)
          if (probe?.span) {
            args = { ...args, span: probe.span }
            // regenerate 的重发原文必须来自**该轮前置
            // user 的文件侧原文**——probe.prompt = round span 起点 user 的原文
            // (dshAdapter.roundPromptOf)。host-core 不再直扫内存稀疏 events 找前置
            // user(直扫会越过洞选中更早轮 → 重发错文本 + marker targetSeq 错)。
            if (op === 'regenerate' && probe.prompt) args = { ...args, regeneratePrompt: probe.prompt }
          } else {
            // 状态下传(只在文件侧确有快照证据时;无证据 → 业务层按内存视图判定,行为不变)
            const miss = spanMissArgsOf(probe)
            if (miss) args = { ...args, ...miss }
          }
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
            const events = sessionEvents(session)
            for (let i = events.length - 1; i >= 0; i--) {
              if (events[i]?.type === 'session/title') {
                currentTitle = events[i].data?.title ?? ''
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
      // 2026-09-07:recall 语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉)
      // ——不再只遮蔽目标轮(缺陷①断层);tail 在官方 foldSurface
      // nodes 上按位置切(修复),大范围遮蔽由快照点守卫引导分支。
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
          // 读当前 title（最后一个 session/title 事件；宿主 header **没有** title
          // 字段——dsh-session 的 types 里 0 命中，勿再引 header.title）
          let currentTitle = ''
          const events = sessionEvents(session)
          for (let i = events.length - 1; i >= 0; i--) {
            if (events[i]?.type === 'session/title') {
              currentTitle = events[i].data?.title ?? ''
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
      // 关闭守卫:查询全会话运行中状态(agent/queued/jobs/未闭合轮)。
      // host 侧无"关闭前"弹窗 seam(宿主 UI 内部),此 handler 供 client 或宿主未来
      // 在关闭动作前查询;dispose 强提示见下方 attachCloseGuard。
      harness.handle('retrace.runningState', async (args) => {
        try {
          const sid = String(args?.sessionId ?? '')
          if (sid) {
            return { ok: true, value: sessionRunningState(ctx, sid) }
          }
          return { ok: true, value: { running: runningSessions(ctx) } }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String(error) } }
        }
      }),
    ]
    return () => disposers.forEach((dispose) => dispose())
  })()

  // R1 实时看门狗：轮询文件尾部 seq vs 内存长度，捕获并发写入/旧光标回放现场。
  const watchdog = createWatchdog(ctx, log)

  // R4 中断轮次治理：退出/重载时对未闭合 turn 会话提示（只检测不写事件）。
  const warnUnclosed = attachExitWarning(ctx, log)

  // 关闭守卫(防误关)：退出/重载时对"运行中任务/未完成对话"会话强提示。
  // host 无关闭前弹窗 seam → 替代路径 = dispose 强提示 + runningState handler(client 可查)。
  const guardClose = attachCloseGuard(ctx, log)

  ctx.effect(() => () => {
    disposeRoute()
    disposeHarness()
    watchdog.dispose()
    warnUnclosed()
    guardClose()
  }, 'dsh-retrace: transports')
}
