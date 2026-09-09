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
import { attachCloseGuard, runningSessions, sessionRunningState } from './close-guard.js'
import { registerDeterministicCompaction, compactionOptIn } from './adapter/register-compaction-backend.js'
import { sessionBadge as fnvBadge } from './badge.js'
import { dshAdapter, semanticBadgeOf } from './adapter/dsh.js'
import { resolveFoldAuto, autoFoldBlock } from './fold-auto.js'
import { createAutoFoldScheduler, resolveAutoFoldWiring, residentSessionIds } from './auto-fold-scheduler.js'
import { createDshMarkerWriter } from './adapter/dsh-writer.js'
import { readFileSync, readdirSync, accessSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * 语义短码（2026-09-01 对齐定稿规则）：优先查 `会话短码表.json`
 * （工作区+序号+父子语义，如 op065op016），命中即返回；否则 FNV 兜底。
 * 短码表由 `tools/gen-session-codes.mjs` 生成（基于 header.createdAt + parentSession）。
 */
const BADGE_TABLE_PATH = join(homedir(), 'opena-archive-2026-08', '会话短码表.json')
let badgeTable = null
try {
  badgeTable = JSON.parse(readFileSync(BADGE_TABLE_PATH, 'utf8')).codes ?? null
} catch { /* 表缺失时 FNV 兜底 */ }
/**
 * 会话短码(2026-09-02 v2,三级)——解决"新 fork 会话不在短码表只有 FNV 兜底"：
 * ① archive 短码表(维护,固定);
 * ② 实时推导(工作区 createdAt 序号+父链,与 gen-session-codes.mjs 同规则,
 *    表的新鲜超集——1f4d986e 这类新会话也能得 op071op065);
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
export const inject = ['sessions', 'agents', 'webServer', 'fs', 'subprocess', 'sandboxPolicy', 'jobs']

export function apply(ctx) {
  const log = (line) => ctx.logger?.info(line)

  // P0 versioning seam: projection unit + artifact snapshots + config view.
  const seam = createVersioningSeam(ctx, log)
  seam.register()

  // 写前校验守卫（8-25 问题闭环）：marker 落盘前过三层契约；依赖缺失自动降级。
  const guard = createMarkerGuard({
    log,
    enabled: (sessionId) => seam.configFor(sessionId).prewrite !== false,
  })
  // 遮蔽写入器（2026-09-02 抽象设计落地）：业务层表达「遮蔽这些消息」，
  // DSH 的 turn/step 翻译（三情形/计数器推进/窗口化防御）隔离在 adapter。
  const markerWriter = createDshMarkerWriter({
    agents: ctx.agents,
    validateMarker: guard.validateMarkerAppend,
    // 情形② step 号从文件全量算（host 窗口化内存不可信，1e99e1ff 回顾 §五）
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

  /**
   * 折叠落盘组装(手动 retrace.fold / HTTP fold 同源语义 / 自动层 foldOneBlock 共用):
   * 调用方已 resolveFoldAuto(或自带 span/end);此处补 span(range mode 官方 foldSurface
   * nodes)与摘要(B2 长会话整理 serializeTrio 优先,失败回退 summaryFromFile 单文本)→ api.fold。
   * 返回 api.fold 结果({ok:true,value}|{ok:false,error}),不抛(内部读失败有兜底)。
   * M-1(独立审查闭环):args.autoFoldBusyGate = 自动层注入的最后一道 busy 复查钩子——
   * 本函数在 span/trio/summary 组装读完成后、api.fold 落盘前执行它;running 则放弃
   * (api.fold→ensureIdle 会对运行中 agent `cancel({kind:'user'})`,自动层绝不代用户
   * 中断)。手动 retrace.fold 不带此钩子(编辑语义本就允许 ensureIdle cancel)。
   */
  async function assembleFoldCall(args) {
    const s = Number(args?.start)
    const e = Number(args?.end)
    if (!args?.span && Number.isInteger(s) && Number.isInteger(e)) {
      try {
        const span = await dshAdapter.spanFromFile(args.sessionId, s, 'range', { endSeq: e })
        if (span) args = { ...args, span }
      } catch { /* span 失败 → api.fold 自行 fallback */ }
    }
    if (!args?.summary) {
      if (Number.isInteger(s) && Number.isInteger(e)) {
        try {
          // B2:优先长会话整理(trio + 人读文本 content);trioFromFile 失败回退单文本
          const trio = await dshAdapter.trioFromFile(args.sessionId, s, e)
          if (trio) {
            // B2 修订链:结论变更 = 追加新卡,superseded-by 指旧卡(旧卡不动,append-only;
            // 新卡 trio 的 roadmap-card.supersededBy 指向被推翻的旧 marker seq——
            // 读旧卡时客户端可据此提示"后有修订",不误信旧结论)。
            const sup = Number(args?.supersedeMarkerSeq)
            if (Number.isInteger(sup) && sup > 0 && trio['roadmap-card']) {
              trio['roadmap-card'].supersededBy = sup
              trio['roadmap-card'].supersedesNote = `本结论取代 seq ${sup} 的旧结论(旧卡仍在,可审计)`
            }
            const { serializeTrio } = await import('./fold-trio.js')
            args = { ...args, summary: serializeTrio(trio), trio }
          } else {
            const summary = await dshAdapter.summaryFromFile(args.sessionId, s, e)
            if (summary) args = { ...args, summary }
          }
        } catch { /* 摘要失败不阻断折叠(空 content) */ }
      }
    }
    // M-1 闸3(最终):自动层 autoFoldBlock 注入的最后复查,在 api.fold 真正执行前
    // (组装读窗口内用户可能已新发消息 agent idle→running)——running → 放弃不折。
    const autoGate = typeof args?.autoFoldBusyGate === 'function' ? args.autoFoldBusyGate : null
    if (autoGate) {
      let autoBusy = false
      try { autoBusy = !!(await autoGate()) } catch { autoBusy = true }
      if (autoBusy) {
        log(`retrace-auto-fold: 会话 ${String(args?.sessionId ?? '')} 最终落盘前会话已运行(用户新发消息)— 放弃自动折,绝不代用户 cancel`)
        return { ok: false, error: { code: 'agent-busy', message: '会话已运行(自动折执行窗口内变 busy)— 放弃本次自动折,不代用户中断' } }
      }
    }
    return api.fold(args)
  }

  /**
   * 会话运行中判定(自动层 busy 闸共用;agent 在跑/排队/后台任务/未闭合轮 → true)。
   * 读 host 实时状态(sessionRunningState),读失败按 busy 保守处理(不折,绝不误 cancel)。
   */
  function isSessionBusy(sessionId) {
    try { return !!(sessionRunningState(ctx, String(sessionId))?.running) } catch { return true }
  }

  /**
   * 长会话整理防线·自动层单块折叠执行器(,规格 §二/§十.2):折"最早完成块"。
   * 调度器给起点(start)+ rounds → 自动边界(foldBoundaryFromFile:含 50 轮上限、
   * 尾部 turn/end 完成校验——活轮/未闭合轮不折,安全闸 1/6)→ 组装长会话整理
   * (assembleFoldCall,与手动 retrace.fold 同链,零分叉)→ api.fold。
   * M-1(独立审查闭环):busy 闸从"只前置查一次"收紧为三道——闸1 入口 / 闸2 自动边界
   * 读后组装前 / 闸3 assembleFoldCall 内 api.fold 落盘前最后复查(assemble 执行
   * autoFoldBusyGate 钩子)。全流程 + isBusy 注入收敛在 lib/fold-auto.js autoFoldBlock,
   * 本函数只接线。**绝不代用户 cancel 运行中的 agent**(规格安全闸 1/6:api.fold→
   * ensureIdle 会 cancel,自动层必须以闸拦在它之前)。
   * 返回 api.fold 结果或 null(忙/无自动边界/异常 → 调度器静默退,不重试风暴)。
   */
  async function foldOneBlock(sessionId, start, opts = {}) {
    return autoFoldBlock(sessionId, start, opts, {
      adapter: dshAdapter,
      assemble: assembleFoldCall,
      isBusy: isSessionBusy,
      log,
    })
  }

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
        // fold 用 args.start(range 起点);其余 op 用 seq/messageId。
        const target = op === 'fold' ? Number(args?.start) : (typeof args?.seq === 'number' ? args.seq : args?.messageId)
        if (target !== undefined && target !== null && !args?.span) {
          const spec = modeOf(args)
          const mode = typeof spec === 'string' ? spec : spec?.mode
          const endSeq = typeof spec === 'object' && spec ? spec.endSeq : undefined
          const span = await dshAdapter.spanFromFile(args.sessionId, target, mode, endSeq !== undefined ? { endSeq } : undefined)
          log(`retrace: spanFromFile(op=${op} target=${String(target).slice(0, 24)} mode=${mode}) → ${span ? `${span.shadowedSeqs.length} seqs` : 'null(fallback)'}`)
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
      // 3f9e4f12 issue 要求)——不再只遮蔽目标轮(缺陷①断层);tail 在官方 foldSurface
      // nodes 上按位置切(ISSUE-20260907113201 修复),大范围遮蔽由快照点守卫引导分支。
      harness.handle('retrace.recall', withFileSpan('recall', () => 'tail')),
      harness.handle('retrace.editAndResend', withFileSpan('editAndResend', (a) => (a?.fromScratch ? 'tail' : 'round'))),
      harness.handle('retrace.regenerate', withFileSpan('regenerate', () => 'round')),
      // 长会话整理窗口批1:fold 完成块区间(marker 折叠承载,range mode)
      // 长会话整理批4:waterLevel(会话上下文用量体检 + 折叠建议,中文文案给正解)
      harness.handle('retrace.waterLevel', async (args) => {
        const sessionId = String(args?.sessionId ?? '')
        const level = await dshAdapter.waterLevelFromFile(sessionId, {
          window: Number(args?.window) || undefined,
        })
        if (!level) return { ok: false, error: { code: 'session-not-found', message: '会话文件不可读' } }
        const bandText = { green: '🟢 健康', yellow: '🟡 接近黄线', red: '🔴 超红线' }[level.band] ?? '?'
        const pctText = `${Math.round(level.pct * 100)}%`
        const adv = []
        if (level.band === 'green') {
          adv.push(`上下文用量${bandText}(${pctText}),缓存红利中,无需动作。`)
        } else if (level.suggestion) {
          const s = level.suggestion
          adv.push(`上下文用量${bandText}(${pctText}),余量约 ${Math.round(level.remaining / 10000)} 万 token。`)
          adv.push(`建议折叠最早完成块(seq ${s.foldRange.start}..${s.foldRange.end},${s.foldRange.rounds} 轮),释放约 ${s.gainTokens} token,折叠后上下文用量降至约 ${Math.round(s.afterPct * 100)}%。`)
          if (level.band === 'red') adv.push('红线前必须已折(官方自动压缩会折头部=缓存全断);若仍逼近,请 fork 续聊。')
        }
        // 度量(体检命令 A,规格 §五定 A):缓存前缀读数 + 官方压缩史——
        // 诚实标注"官方 API 实测"(cacheReadTokens 是官方 usage 字段,非估算)。有可测
        // 数据才报(green 也显示——体检一处看全)。
        // M-3 披露口径(独立审查):只报可测代价(Δ<0 = 前缀真被打掉);其余(Δ≥0 的
        // 突发/轮中样本或前后无读数的样本)如实披露"未计",不掩盖矛盾样本。
        const cm = level.cacheMetrics
        if (cm && (cm.latestCacheReadTokens || (cm.compactionHistory?.count ?? 0) > 0)) {
          const fmt = (n) => (Number.isFinite(n) ? (n >= 10000 ? `${Math.round(n / 1000) / 10} 万` : String(Math.round(n))) : '不可测')
          const hist = cm.compactionHistory ?? {}
          const latest = cm.latestCacheReadTokens
          const prefix = latest ? `≈${fmt(latest.cacheReadTokens)} token` : '不可测'
          const n = hist.count ?? 0
          const m = hist.measured ?? 0
          const histLine = n > 0
            ? (m > 0
                ? `官方压缩 ${n} 次,其中 ${m} 次可测代价 ≈${fmt(hist.totalCostTokens)} token(其余 ${n - m} 次为突发/轮中样本,未计)`
                : `官方压缩 ${n} 次,无可测代价(均为突发/轮中样本或前后无读数,未计)`)
            : ''
          adv.push(`缓存前缀${prefix}(官方 API 实测 cacheReadTokens)${histLine ? `;${histLine}` : ''}。`)
        }
        return { ok: true, value: { ...level, advice: adv.join('\n') } }
      }),
      // 长会话整理批3:unfold(视图层展开数据,从日志读被遮蔽内容,模型上下文不变)
      harness.handle('retrace.unfold', async (args) => {
        const markerSeq = Number(args?.markerSeq)
        if (!Number.isInteger(markerSeq) || markerSeq < 0) {
          return { ok: false, error: { code: 'bad-request', message: 'unfold 需要 fold marker 的 seq' } }
        }
        const content = await dshAdapter.unfoldContentFromFile(String(args?.sessionId ?? ''), markerSeq)
        if (!content) return { ok: false, error: { code: 'marker-not-found', message: '指定 seq 不是 retrace-fold- 折叠 marker 或无遮蔽内容' } }
        return { ok: true, value: content }
      }),
      harness.handle('retrace.fold', (async (args) => {
        // B2 折叠长会话整理。fold 特殊:span(含 shadowedSeqs)先自己算(range 模式),
        // 再生成 trio+summary,直接 api.fold(不经 withSpan——它只在 api 前设 span,
        // 此处已设;ensureBadgeTitle 照做)。
        await ensureBadgeTitle(args?.sessionId)
        // 批5(50 轮接线):未显式 endSeq → resolveFoldAuto 统一决策——
        // 默认单轮完成块 / 显式 rounds ≤50 兜底 / HIGH-2 轮首回退(surface 可算才回退)。
        // N-1/N-2/N-3:自动边界 + 回退 + span 一次性解析(读回退后真相),两入口共用
        // lib/fold-auto.js 零分叉;摘要区间一律读 args.start/args.end,无本地副本可漂移。
        // 落盘组装(span/trio/summary → api.fold)统一走 assembleFoldCall
        // (与自动层 foldOneBlock 共用,防两条链分叉)。
        args = await resolveFoldAuto(args, dshAdapter, log)
        return assembleFoldCall(args)
      })),
      // B2/P1 折前预览:不落盘,只算将生成的路标卡长会话整理(客户端确认前给用户看
      // "将折掉什么/结论是什么")。纯读。区间同 fold(range 模式 surface 端点)。
      harness.handle('retrace.foldPreview', (async (args) => {
        try {
          const s = Number(args?.start)
          const e = Number(args?.end)
          if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e < s) {
            return { ok: false, error: { code: 'bad-request', message: 'foldPreview 需要合法区间 [start..end]' } }
          }
          const trio = await dshAdapter.trioFromFile(String(args?.sessionId ?? ''), s, e)
          if (!trio) {
            return { ok: false, error: { code: 'range-not-surface', message: '区间端点不在当前 surface(已被遮蔽或非节点)' } }
          }
          const { serializeTrio } = await import('./fold-trio.js')
          return { ok: true, value: { trio, previewText: serializeTrio(trio) } }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String(error) } }
        }
      })),
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
      // 关闭守卫():查询全会话运行中状态(agent/queued/jobs/未闭合轮)。
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

  // 批6 适配器2(/145):注册官方 compaction 后端 = 确定摘要子类(零 LLM)。
  // 显式 opt-in(DSH_RETRACE_COMPACTION=1)。H-1(独立审查):标准桌面宿主已装官方
  // compaction-basic,cordis 同名注册=拒绝 → 插件单方不可替换;本接线在「无官方
  // 后端宿主」装配确定性自动折叠,或返回指向真因的 reason(不误导)。失败降级不崩。
  if (compactionOptIn()) {
    registerDeterministicCompaction(ctx, { log }).then((r) => {
      if (r.installed) log(`retrace: 确定摘要 compaction 后端已装配`)
      else log(`retrace: 确定摘要 compaction 后端未装配: ${r.reason}`)
    }).catch((error) => {
      // P0-6(代码低 1):fire-and-forget 拒绝处理器(模块内 try/catch 已兜底,双保险)
      log(`retrace: 确定摘要 compaction 装配异常: ${String(error).slice(0, 160)}`)
    })
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // 长会话整理防线·自动层(+ ,规格 comm/长会话整理防线-自动折叠-设计规格-20260909.md v1)
  // 三层机制:自动(本块)/手动(已有 retrace.fold)/被动兜底(官方压缩监测 = cache-metrics,
  // waterLevel 报告可见)。本块 = 纯编排接线(createAutoFoldScheduler 已含频控 5min/
  // 循环至安全区/失败静默):①foldOne 注入 = foldOneBlock(与手动 fold 同链零分叉;
  // M-1:busy 三道闸收敛其内——绝不代用户 cancel 运行中的 agent,安全闸 1/6)②会话活动事件钩子
  // (活动停歇 QUIET_MS 后触发一次)③60s 定时兜底④dispose 清理(ctx.effect)。默认开;
  // DSH_RETRACE_AUTOFOLD=0/off/false 关(规格 §七)。
  // (用户方向:让官方压缩失效/不再抢先)接线参数(可 env 覆写,见
  // lib/auto-fold-scheduler.js resolveAutoFoldWiring):
  //   · triggerPct 0.55(原黄线 60% 下移留缓冲——官方在 running 轮中 agent/pre-step
  //     同步触发(0.8×窗口),自动层被 busy 闸排除轮中折、只能折 idle 空窗 → 在官方
  //     可能触发前更早折);suggestion 生成线随 suggestPct 对齐(55-60% 灰区也有候选);
  //   · quietMs 3s(原 20s——活跃会话空窗更快响应);
  //   · scanWindowMs null = 60s 定时扫**全部驻留会话**(原只扫 30min 内有事件的,
  //     闲置 >30min 永不被扫——放宽;busy 闸保留,轮中绝不折)。
  // 全部 try/catch 静默——调度器任何失败不影响主功能。
  // ─────────────────────────────────────────────────────────────────────────────
  const autoFoldDispose = (() => {
    if (/^(0|off|false|no)$/i.test(String(process.env.DSH_RETRACE_AUTOFOLD ?? '').trim())) {
      log('retrace-auto-fold: DSH_RETRACE_AUTOFOLD=0 → 自动折叠已关闭(手动 fold/unfold/被动层不受影响)')
      return null
    }
    const wiring = resolveAutoFoldWiring(process.env)
    const QUIET_MS = wiring.quietMs // 活动事件停歇后触发检查(agent 流式输出期间不连发;3s)
    try {
      const activeAt = new Map() // sessionId → 最近事件 ts
      const debounce = new Map() // sessionId → 停歇定时器
      const scheduler = createAutoFoldScheduler({
        adapter: dshAdapter,
        // M-1(独立审查闭环):活轮闸不再"只前置查一次"——foldOneBlock 内部收敛三道
        // busy 复查(闸1 入口/闸2 边界读后组装前/闸3 最终 api.fold 前,
        // lib/fold-auto.js autoFoldBlock),任一窗口内 agent 变 running 都静默退,
        // **绝不代用户 cancel 运行中的 agent**(规格安全闸 1/6;api.fold 内部
        // ensureIdle 会 cancel,自动层必须以闸拦在它之前)。
        foldOne: foldOneBlock,
        // 触发线 0.55(下移留缓冲)+ measureOpts.suggestPct 对齐 →
        // suggestion 从触发线起存在(green 带 55-60% 也可折,官方 0.8 前更早折)
        config: {
          triggerPct: wiring.triggerPct,
          measureOpts: { suggestPct: wiring.triggerPct },
        },
        // 定时兜底扫全部驻留会话(scanWindowMs=null 默认;env 显式设数值
        // 才回旧"仅最近活跃"窗口语义)——闲置 >30min 的会话(用户可能回来)也扫
        listSessions: () => residentSessionIds(ctx.sessions, activeAt, wiring.scanWindowMs),
        log,
      })
      const fire = (sid) => {
        scheduler.maybeAutoFold(sid).catch((error) =>
          log(`retrace-auto-fold: 活动后检查异常(静默): ${String(error).slice(0, 120)}`))
      }
      // 去抖:每事件重置定时器,安静 QUIET_MS 才查一次上下文用量(频控在 scheduler 内)
      const scheduleCheck = (sid) => {
        const prev = debounce.get(sid)
        if (prev !== undefined) clearTimeout(prev)
        const handle = setTimeout(() => { debounce.delete(sid); fire(sid) }, QUIET_MS)
        if (typeof handle?.unref === 'function') handle.unref()
        debounce.set(sid, handle)
      }
      // 订阅会话活动(watchdog 同款 ctx.on;⚠️ 用 ctx.on 返回的 disposer,不用 ctx.off)
      const onSessionEvent = (session) => {
        try {
          if (!session || typeof session.id !== 'string') return
          const sid = session.id
          activeAt.set(sid, Date.now())
          scheduleCheck(sid)
        } catch { /* 单事件处理失败静默 */ }
      }
      const disposeEvent = typeof ctx.on === 'function' ? ctx.on('session/event', onSessionEvent) : null
      scheduler.startTimer()
      log(`retrace-auto-fold: 自动折叠调度器已启用(上下文用量 ≥${Math.round(wiring.triggerPct * 100)}% 触发/5min 频控/60s 定时兜底扫${wiring.scanWindowMs === null ? '全部驻留' : `${Math.round(wiring.scanWindowMs / 60000)}min 活跃`}会话/去抖 ${Math.round(QUIET_MS / 1000)}s;DSH_RETRACE_AUTOFOLD=0 关)`)
      return () => {
        try {
          scheduler.dispose()
          for (const t of debounce.values()) clearTimeout(t)
          debounce.clear()
          activeAt.clear()
          if (typeof disposeEvent === 'function') disposeEvent()
        } catch { /* 清理失败不影响卸载 */ }
      }
    } catch (error) {
      log(`retrace-auto-fold: 调度器装配失败(降级关闭,不影响主功能): ${String(error).slice(0, 160)}`)
      return null
    }
  })()

  ctx.effect(() => () => {
    disposeRoute()
    disposeHarness()
    watchdog.dispose()
    warnUnclosed()
    guardClose()
    if (typeof autoFoldDispose === 'function') autoFoldDispose()
  }, 'dsh-retrace: transports')
}
