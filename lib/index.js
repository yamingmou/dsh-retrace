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
import { dshAdapter } from './adapter/dsh.js'
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
function sessionBadge(sessionId) {
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
    // 自动固定标题(2026-09-01):任何 retrace 操作发生 = 会话活跃,
    // 确保 title 带短码(用户体感:标题固定,不依赖打开 ForkView/RetraceView)。
    function ensureBadgeTitle(sessionId) {
      try {
        const session = ctx.sessions?.get?.(String(sessionId ?? ''))
        if (!session) return
        const badge = sessionBadge(String(sessionId))
        if (!badge) return
        let currentTitle = ''
        for (let i = session.events.length - 1; i >= 0; i--) {
          if (session.events[i]?.type === 'session/title') { currentTitle = session.events[i].data?.title ?? ''; break }
        }
        if (!currentTitle) currentTitle = String(sessionId).slice(0, 16)
        const tagged = `[${badge}] `
        if (currentTitle.startsWith(tagged)) return
        session.append('session/title', { title: tagged + currentTitle, source: { kind: 'user' } })
      } catch { /* 标题写入失败不影响操作 */ }
    }
    // 2026-09-01:操作前从文件算遮蔽(绕开 host 稀疏 session.events,用户方案)
    const withFileSpan = (op, modeOf) => async (args) => {
      ensureBadgeTitle(args?.sessionId)
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
    const disposers = [
      harness.handle('retrace.recall', withFileSpan('recall', () => 'round')),
      harness.handle('retrace.editAndResend', withFileSpan('editAndResend', (a) => (a?.fromScratch ? 'tail' : 'round'))),
      harness.handle('retrace.regenerate', withFileSpan('regenerate', () => 'round')),
      // 会话短码（2026-08-31）：session id → 确定性 10 位短码，人机交互识别用。
      harness.handle('retrace.sessionBadge', (args) => {
        const sessionId = String(args?.sessionId ?? '')
        return { ok: true, value: { sessionId, badge: sessionBadge(sessionId) } }
      }),
      // 会话短码写入标题（2026-09-01）：给会话 title 组装「[短码]原标题」，
      // 不改标题内容本身，只在标题前加短码标识。
      harness.handle('retrace.setBadgeTitle', (args) => {
        const sessionId = String(args?.sessionId ?? '')
        if (!sessionId) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } }
        const session = ctx.sessions?.get?.(sessionId)
        if (!session) return { ok: false, error: { code: 'not-found', message: 'session not found' } }
        try {
          const badge = sessionBadge(sessionId)
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
          const newTitle = tagged + currentTitle
          session.append('session/title', { title: newTitle, source: { kind: 'user' } })
          return { ok: true, value: { title: newTitle, badge, alreadyTagged: false } }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String(error) } }
        }
      }),
      // 用户自定义会话名称（2026-09-01）：`[短码] 用户输入` 写入 user source title。
      // 官方语义：user source title 固定会话名，后续自动生成（title-llm）被禁用。
      harness.handle('retrace.setUserTitle', (args) => {
        const sessionId = String(args?.sessionId ?? '')
        const title = String(args?.title ?? '').trim()
        if (!sessionId) return { ok: false, error: { code: 'bad-request', message: 'sessionId required' } }
        if (!title) return { ok: false, error: { code: 'bad-request', message: 'title required' } }
        const session = ctx.sessions?.get?.(sessionId)
        if (!session) return { ok: false, error: { code: 'not-found', message: 'session not found' } }
        try {
          const badge = sessionBadge(sessionId)
          // 用户输入已含短码则直接用，否则拼接
          const tagged = title.startsWith(`[${badge}]`) ? title : `[${badge}] ${title}`
          session.append('session/title', { title: tagged, source: { kind: 'user' } })
          return { ok: true, value: { title: tagged, badge } }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String(error) } }
        }
      }),
      // 批量初始化会话名称（2026-09-01）：所有已驻留会话的 title 拼上短码。
      // 用户体感：侧边栏/对话标题直接显示 `[短码] 名称`，不用进分叉图才看到。
      harness.handle('retrace.initBadgeTitles', () => {
        const results = []
        const sessionStore = ctx.sessions
        if (!sessionStore || typeof sessionStore.list !== 'function' && typeof sessionStore.values !== 'function') {
          return { ok: false, error: { code: 'unavailable', message: 'session store not enumerable' } }
        }
        try {
          const sessions = typeof sessionStore.list === 'function' ? sessionStore.list() : [...sessionStore.values()]
          for (const session of sessions) {
            const sessionId = session?.id ?? session?.sessionId
            if (!sessionId) continue
            try {
              const badge = sessionBadge(sessionId)
              if (!badge) continue
              let currentTitle = ''
              for (let i = session.events.length - 1; i >= 0; i--) {
                if (session.events[i]?.type === 'session/title') {
                  currentTitle = session.events[i].data?.title ?? ''
                  break
                }
              }
              if (!currentTitle) currentTitle = sessionId.slice(0, 16)
              const tagged = `[${badge}] `
              if (currentTitle.startsWith(tagged)) { results.push({ sessionId, badge, alreadyTagged: true }); continue }
              session.append('session/title', { title: tagged + currentTitle, source: { kind: 'user' } })
              results.push({ sessionId, badge, alreadyTagged: false })
            } catch (error) {
              results.push({ sessionId, badge: null, error: String(error) })
            }
          }
          return { ok: true, value: { total: results.length, results } }
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

  ctx.effect(() => () => {
    disposeRoute()
    disposeHarness()
    watchdog.dispose()
    warnUnclosed()
  }, 'dsh-retrace: transports')
}
