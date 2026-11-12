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
import { createEditorApi, lastModelSource, subagentTargetsInEvents, jobIdsInEvents } from './host-core.js'
import { sessionEvents } from './host-compat.js'
import { createRetraceHttpHandler, ROUTE_PREFIX } from './http.js'
import { createVersioningSeam } from './versioning.js'
import { createRollbackExecutor, createTrueRestore } from './rollback.js'
import { createPreimageStore } from './preimage-store.js'
import { createCheckpointRestore } from './checkpoint-restore.js'
import { createMarkerGuard } from './prewrite-guard.js'
import { createWatchdog } from './watchdog.js'
import { createBootPinRetry } from './boot-pin.js'
import { attachExitWarning } from './interrupt-guard.js'
import {
  attachCloseGuard, runningSessions, sessionRunningState, guardSurfaceOf,
  installSurfaceProbe, uninstallSurfaceProbe,
} from './close-guard.js'
import { dshAdapter } from './adapter/dsh.js'

// span 显式状态结果 → 业务层判定输入的统一下传(单一真相模块)
import { spanMissArgsOf, describeSpanResult } from './span-semantics.js'
import { createDshMarkerWriter } from './adapter/dsh-writer.js'
// 官方「事件 → 模型可见消息」派生(逐节点估价的口径,见 adapter/dsh-writer.js):
// 宿主入口可以静态 import 官方包;动态件里同一逻辑由 measure() 表面法兜底。
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sessionFilePath, extraSessionBases } from './platform/session-paths.js'
async function sessionBadge() { return '' }
function syncBadge() { return '' }
/**
 * 名称真值 = 日志里最后一个 `session/title` 事件。
 *
 * 日志里确实没有 title 事件的会话（实测已知数条）⇒ 返回空串：**如实留空**。
 * 不回落成 cwd 项目名、也不拿 sessionId 前 16 位冒充名字 —— 虚构的名字经官方
 * rename 会固化成 user source title，把以后的真名字永久盖掉。
 *
 * 提到模块级并导出（`apply()` 之外）是为了可单测：这是"列表里显示什么名字"的
 * 唯一真值来源，回归代价高（见 test/badge-title-wiring.test.js 的阴性对照）。
 */
export function trueTitleOf(session) {
  const events = sessionEvents(session)
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === 'session/title') return events[i].data?.title ?? ''
  }
  return ''
}

// public build: title-prefix helpers removed
/**
 * **投影缓存（projcache）标题行清理** —— 侧栏旧前缀残留的根因修复点（P1 2026-11-12）。
 *
 * 真机证据：`grep 旧前缀 ~/DSH/sessions` = 0（权威日志已干净），而
 * `~/DSH/storages/session_projcache/sessions/*.json` 里 34 个文件含旧前缀 ⇒ **侧栏读的是
 * 宿主投影缓存**，官方 `sessionTitle.rename` 只改会话日志、不回写这份缓存。
 * 这里只把 `record.rows.title.val` 换成去前缀的标题（ver/seq 与其它行**一律不动**），
 * 原子写（tmp+rename，防半截文件）；幂等（已干净的不写）；失败计数可见。
 *
 * @param {{log?: (line:string)=>void}} [hooks]
 * @returns {{dir: string|null, scanned: number, updated: number, failed: number}}
 */
export function scrubProjcacheTitles({ log = null } = {}) {
  const result = { dir: null, scanned: 0, updated: 0, failed: 0 }
  const say = typeof log === 'function' ? log : () => {}
  let dir = null
  try {
    for (const base of [process.env.DSH_HOME, join(homedir(), '.dsh'), ...extraSessionBases({ home: homedir() })]) {
      if (base === undefined || base === '') continue
      const candidate = join(base, 'storages', 'session_projcache', 'sessions')
      if (existsSync(candidate)) { dir = candidate; break }
    }
  } catch (error) {
    say(`retrace: projcache 目录探测失败（可见）: ${String(error?.message ?? error).slice(0, 120)}`)
    return result
  }
  result.dir = dir
  if (dir === null) {
    say('retrace: 未找到 projcache 目录（宿主机型差异）—— 只清会话日志，跳过缓存')
    return result
  }
  let files = []
  try { files = readdirSync(dir).filter((name) => name.endsWith('.json')) } catch (error) {
    say(`retrace: projcache 枚举失败（可见）: ${String(error?.message ?? error).slice(0, 120)}`)
    return result
  }
  for (const name of files) {
    const file = join(dir, name)
    let row = null
    try { row = JSON.parse(readFileSync(file, 'utf8')) } catch { continue } // 坏件/半截件：跳过（不阻塞其余）
    const title = row?.record?.rows?.title
    if (title === null || typeof title !== 'object' || typeof title.val !== 'string') continue
    result.scanned += 1
    const clean = stripTitlePrefix(title.val)
    if (clean === title.val) continue
    try {
      title.val = clean
      const tmp = `${file}.retrace-tmp`
      writeFileSync(tmp, JSON.stringify(row))
      renameSync(tmp, file)
      result.updated += 1
    } catch (error) {
      result.failed += 1
      say(`retrace: projcache 标题行写入失败 ${name}: ${String(error?.message ?? error).slice(0, 120)}`)
    }
  }
  return result
}

/**
 * 去掉标题**开头**的插件旧前缀（兼容历史 ASCII `[xxx]` 与全角 `【xxx】` 两种写法）。
 * 纯函数：只做字符串判定，不写任何会话内容；清理路径用它得到"原标题"。
 * 不改生成规则、不解析前缀含义（对外不暴露实现细节）。
 */
export function stripTitlePrefix(title) {
  const text = String(title ?? '')
  const stripped = text.replace(/^(?:\[[^\]\s]{4,24}\]|【[^】\s]{4,24}】)\s*/, '')
  return stripped === text ? text : stripped
}

/**
 * **只读**审计:驻留会话里还有多少条标题带着历史前缀(issue #7)。
 *
 * 启动路径只做这一件事 —— **不重命名任何标题**(自动写标题已移除;清理是用户在读档点
 * 页点「清理标题旧前缀」的显式动作,走 op `restoreSessionTitles`)。纯函数,便于单测:
 * 传入 sessions 与 titleOf,返回 {scanned, prefixed}。
 */
export function titlePrefixAudit(sessions, { titleOf = trueTitleOf } = {}) {
  const list = Array.isArray(sessions) ? sessions : []
  let prefixed = 0
  for (const session of list) {
    const current = titleOf(session)
    if (stripTitlePrefix(current) !== current) prefixed += 1
  }
  return { scanned: list.length, prefixed }
}

// public build: badge-title check removed
/**
 * 写标题结果汇总（纯函数，便于单测）。
 * "无驻留会话不许伪造写入数"就钉在这里：所有计数**只来自 results**，
 * 空集合 ⇒ 全 0；带 error 的结果计入 failed，**不**计入 wrote。
 */
export function summarizePinResults(results, sessionCount) {
  const list = Array.isArray(results) ? results : []
  return {
    sessions: Number.isFinite(sessionCount) ? sessionCount : list.length,
    wrote: list.filter((r) => r.alreadyTagged === false).length,
    skipped: list.filter((r) => r.alreadyTagged === true).length,
    noTitle: list.filter((r) => r.titled === false).length,
    failed: list.filter((r) => r.error).length,
  }
}

export const name = 'dsh-retrace'
export const inject = ['sessions', 'agents', 'webServer', 'fs', 'subprocess', 'sandboxPolicy', 'jobs']

/** titleMap 结果缓存(60s TTL,仅全量调用缓存;懒取不落缓存) */
const titleMapCache = { root: null, at: 0, titles: {} }

/**
 * 撤回 · 连带终止派生任务（方案 A）的**平台桥**。
 *
 * host-core 零平台 import，全部能力经 hooks 注入（规则与顺序见 lib/host-core.js
 * 文件头同名块）。这里只做四件事，每条都对应一个**官方 API**：
 *
 *  ① `derivedTasks` —— 枚举被撤回区间内派生出来的任务：
 *     · 子代理会话 = 父会话**自己日志**里的 `subagent/catalog` 事件（结构化创建凭据），
 *       其持久 seq 落在 [span.start, span.end]；目标 id = `data.childId`。
 *     · 后台作业   = 区间内的**创建公告**里的 job id ∩ 官方 jobs 注册表里
 *       `owner === 本会话` 且未结算的作业（公告形态与产出者见 host-core 的
 *       DERIVED_JOB_CREATION_PATTERNS）。仅被 job_output 提到的老作业不算 —— 防误杀。
 *  ② `interruptSubagent` / `killDerivedJob` —— 终止原语：
 *     `ctx.subagents.interrupt(childId, {kind:'user', parentSessionId})`
 *     与 `ctx.jobs.kill(jobId, sessionId, reason)`。
 *  ③ `derivedStatus` —— 静默确认/写后核对的读数口：
 *     子代理 = 活 agent 的 `status` + 子会话日志长度；作业 = 官方 `status` + 输出环
 *     累计字节（结算后冻结）。
 *
 * ⚠ 官方 `list(caller)` / `kill(id, caller, …)` 的 caller 是**字符串 owner id**
 * （实测 `@deepseek-ai/dsh-jobs-local` 的 `list` 用 `job.owner.id === caller` 过滤、
 * `assertAccess` 也用同一比较；`dsh-tool-jobs` 传的是 `exec.agent?.id`）——传 `{id}`
 * 形状会一个都匹配不到。这里两种形状都试，只为兼容更早的实现。
 */
export function createDerivedTaskBridge({ ctx, log, reader }) {
  const ownedJobViews = (sessionId) => {
    const service = ctx?.jobs
    if (!service || typeof service.list !== 'function') return []
    const caller = String(sessionId)
    const out = new Map()
    const take = (rows) => {
      if (!Array.isArray(rows)) return
      for (const job of rows) {
        if (!job || typeof job.id !== 'string') continue
        const owner = typeof job.owner === 'string' ? job.owner : job.owner?.id
        if (owner !== caller) continue
        out.set(job.id, job)
      }
    }
    for (const shape of [caller, { id: caller }]) {
      try { take(service.list(shape)) } catch { /* 该形状不被接受 → 试下一种 */ }
    }
    return [...out.values()]
  }

  const safeAgent = (id) => {
    try { return ctx?.agents?.get?.(id) } catch { return undefined }
  }
  const safeSession = (id) => {
    try { return ctx?.sessions?.get?.(id) } catch { return undefined }
  }
  const sessionEventCount = (session) => {
    if (!session) return 0
    try {
      if (Number.isFinite(session.seq)) return session.seq
    } catch { /* seq 读取抛错 → 走快照 */ }
    try {
      const snapshot = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : null
      if (Array.isArray(snapshot)) return snapshot.length
    } catch { /* 读不到就当 0（下面照实上报 unreadable 由宿主日志兜） */ }
    return 0
  }

  /** 全量文件日志优先；读不到（超大件/无文件）回落宿主内存视图。 */
  const liveEvents = async (sessionId, session) => {
    try {
      const events = await reader.readEvents(sessionId)
      if (Array.isArray(events) && events.length > 0) return events
    } catch (error) {
      log(`retrace: 派生任务枚举读会话文件失败，回落内存视图: ${String(error?.message ?? error)}`)
    }
    return sessionEvents(session)
  }

  const terminalJobStatuses = new Set(['succeeded', 'failed', 'killed'])

  return {
    derivedTasks: async ({ sessionId, session, span }) => {
      const events = await liveEvents(sessionId, session)
      const subagents = subagentTargetsInEvents(events, span)
      const owned = ownedJobViews(sessionId)
      const byId = new Map(owned.map((job) => [job.id, job]))
      const jobs = []
      for (const id of jobIdsInEvents(events, span)) {
        const view = byId.get(id)
        if (!view) continue // 不是本会话的作业（或已从注册表移除）⇒ 不碰
        if (terminalJobStatuses.has(view.status)) continue // 已结算：没有可停的
        jobs.push({
          kind: 'job',
          id,
          label: typeof view.label === 'string' ? view.label : '',
          evidence: 'tool/result 创建公告(区间内) + owner=本会话',
        })
      }
      return { subagents, jobs }
    },
    interruptSubagent: ({ sessionId, id }) => {
      const subagents = ctx.get?.('subagents') ?? ctx.subagents
      if (!subagents || typeof subagents.interrupt !== 'function') {
        return { ok: false, error: { message: '宿主未装配 ctx.subagents.interrupt（无法中断子代理会话）' } }
      }
      // 权限凭据 = 「该子会话的 parentSession 是本会话」：官方 interrupt 会核对
      // activation.handle.agent.session.header.parentSession === parentSessionId，
      // 不匹配即抛 UNAUTHORIZED —— 这就是"只终止有明确父子关系者"的运行时保障。
      subagents.interrupt(String(id), { kind: 'user', parentSessionId: String(sessionId) })
      return { ok: true, value: { accepted: true } }
    },
    killDerivedJob: ({ sessionId, id }) => {
      const service = ctx?.jobs
      if (!service || typeof service.kill !== 'function') {
        return { ok: false, error: { message: '宿主未装配 ctx.jobs.kill（无法终止后台作业）' } }
      }
      const outcome = service.kill(String(id), String(sessionId), 'retrace: recall cascades to derived tasks')
      return { ok: true, value: { outcome } }
    },
    derivedStatus: ({ sessionId, targets }) => {
      const owned = new Map(ownedJobViews(sessionId).map((job) => [job.id, job]))
      const rows = []
      for (const target of Array.isArray(targets) ? targets : []) {
        if (!target || typeof target.id !== 'string' || target.id.length === 0) continue
        if (target.kind === 'job') {
          const view = owned.get(target.id)
          rows.push({
            kind: 'job',
            id: target.id,
            status: typeof view?.status === 'string' ? view.status : 'settled',
            // 作业的「事件数」= 输出环累计字节（官方 view.output.total；结算后冻结）。
            events: Number.isFinite(view?.output?.total) ? view.output.total : 0,
          })
          continue
        }
        const agent = safeAgent(target.id)
        const child = safeSession(target.id)
        rows.push({
          kind: 'subagent',
          id: target.id,
          // 官方 agent 注册表只在有活实例时返回 ⇒ 没有活 agent = 没在跑。
          status: typeof agent?.status === 'string' ? agent.status : (child ? 'idle' : 'absent'),
          events: sessionEventCount(child),
        })
      }
      return rows
    },
  }
}

export function apply(ctx) {
  // (OOM/拒写修·真落点):新底座把 system 提示词落在 surface 节点(system/message),
  // 而契约词汇 = 运行时 KNOWN_SESSION_EVENT_TYPES(旧运行时不含该类型)⇒ 契约门 E3 拒绝
  // **我们没写过**的这类历史行,折一直落不了盘。修法:进程内对该运行时词汇集做并集
  // (不改 node_modules;与 prewrite-guard 的 ignorable 标记互为双保险)。
  // 并集清单 = prewrite-guard 注释里登记的 5 型契约门拒读行(逐个 add 追不上 ⇒ 一次并齐):
  // assistant/attempt / deliverables/presented / system/message / subagent/catalog /
  // model/selection。现役内核 0.1.7-rc.2 的 KNOWN 已含这 5 型(并集成为无副作用的
  // 幂等动作),留着是为了旧运行时(词汇表随 harness 版本漂移)。
  void import('@deepseek-ai/dsh-session')
    .then((m) => { try { for (const t of ['system/message', 'assistant/attempt', 'deliverables/presented', 'subagent/catalog', 'model/selection']) { try { m?.KNOWN_SESSION_EVENT_TYPES?.add?.(t) } catch {} } } catch { /* 只读集则退化为 ignorable 路径 */ } })
    .catch(() => { /* 解析不到该包时保持原状 */ })

  const log = (line) => ctx.logger?.info(line)
  log('retrace: BOOT-MARKER autofold-hardoff-20261023 已加载（用于确认加载的是哪份代码）')
  /** 一次性日志（按 key 去重）:会话标识诊断每 30s 重跑,重复行会淹掉真信号。 */
  const loggedOnce = new Set()
  const logOnce = (key, line) => { if (loggedOnce.has(key)) return; loggedOnce.add(key); log(line) }

  // P0 versioning seam: projection unit + artifact snapshots + config view.
  const seam = createVersioningSeam(ctx, log)
  seam.register()

  // 写前校验守卫：marker 落盘前过三层契约；依赖缺失自动降级。
  const guard = createMarkerGuard({
    log,
    enabled: (sessionId) => seam.configFor(sessionId).prewrite !== false,
  })
  // 遮蔽写入器：业务层表达「遮蔽这些消息」，
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
  // 「真正恢复」(0.4.126):日志层面的遮蔽撤销 —— 文件手术(帧级最小改写 + 备份 +
  // 写后校验 + 写后回滚)全部在 lib/rollback.js 的 createTrueRestore 里,host-core 只
  // 通过这两个注入面调用(保持零平台 import,动态插件 realm 仍可运行):
  //   · sessionFileFor —— 会话 id → 日志文件绝对路径(基座候选口径收敛在 session-paths);
  //   · trueRestore    —— 预演/执行 + 全部硬闸。
  // 折叠口径:createTrueRestore 默认走 adapter 的 surfaceFoldOf(官方 foldSurface +
  // 已注册消息投影),整体抛错时退到镜像折并标注 strict:false(如实上报,不假装通过)。
  const trueRestore = createTrueRestore({ log })
  // 撤回 · 连带终止派生任务（方案 A）的平台桥（枚举/终止/状态读数，见上方
  // createDerivedTaskBridge 的逐条依据）。host-core 只按形状消费这五个注入面。
  const derivedBridge = createDerivedTaskBridge({ ctx, log, reader: dshAdapter.reader })
  const hooks = {
    validateMarker: guard.validateMarkerAppend,
    writeMarker: markerWriter.writeMarker,
    // 原文回收(读 = 零写枚举 / 写 = append 单段副本)的两个注入面:
    //   · readEvents      —— 会话 id → 全量事件(读文件链;dshAdapter 的 readEvents,
    //     单次读 + 短缓存,见 lib/adapter/dsh.js)。host-core 的 recallIndex/reclaim
    //     拿它当权威事件源(内存视图可能窗口化);缺席时回落内存视图并如实标注。
    //   · writeRestoreCopy —— 单段 append 的回收副本写入(lib/adapter/dsh-writer.js,
    //     复用既有写入器:写前 validateMarker 契约校验 + 运行中拒写闸)。
    readEvents: (sessionId) => dshAdapter.reader.readEvents(String(sessionId)),
    writeRestoreCopy: markerWriter.writeRestoreCopy,
    sessionFileFor: (sessionId) => sessionFilePath(String(sessionId)),
    trueRestore: (args) => trueRestore.restore(args),
    // 方案 A：撤回前先停"这一轮派生出去的任务"（子代理会话/后台作业）。
    derivedTasks: (payload) => derivedBridge.derivedTasks(payload),
    interruptSubagent: (payload) => derivedBridge.interruptSubagent(payload),
    killDerivedJob: (payload) => derivedBridge.killDerivedJob(payload),
    derivedStatus: (payload) => derivedBridge.derivedStatus(payload),
    // Post-write observer (opt-in `summary` switch): builds our own boundary
    // artifact after the marker pair is committed and validated. No seam ⇒ the
    // op behaves exactly like 0.4.x (no artifact, no LLM call).
    onBoundary: (payload) => seam?.onBoundary?.(payload),
  }

  // P1 rollback executor: context/artifact restore over the seam (git + snapshots).
  // Batch2 checkpoint line: one preimage store shared by the rollback shadow
  // capture and the restore service, plus the restore service itself
  // (preview-ticket → CAS file write-back + validated append-only replay).
  const preimages = createPreimageStore({ root: seam.storeRoot(), log })
  const checkpointRestore = createCheckpointRestore({
    ctx,
    sessions: ctx.sessions,
    seam,
    preimages,
    // Official per-message price for the replay's shadow-price claim; absent ⇒
    // the restore refuses explicitly instead of writing a fabricated price.
    estimateTokens: (message) => {
      const meter = ctx.get?.('tokenMeter') ?? ctx.tokenMeter
      return meter && typeof meter.estimateMessage === 'function' ? meter.estimateMessage(message) : null
    },
    log,
  })
  // Unified rollback executor: readpoint entries keep their snapshot/git path;
  // checkpoint entries (operation preimages) are delegated to the restore
  // service, so ONE preview/execute op pair serves the whole list.
  const rollback = createRollbackExecutor({ ctx, sessions: ctx.sessions, agents: ctx.agents, seam, validateMarker: hooks.validateMarker, writeMarker: hooks.writeMarker, log, preimageStore: preimages, checkpoints: checkpointRestore })

  const api = createEditorApi(ctx, ctx.sessions, ctx.agents, log, hooks)

  /**
   * 会话标识相关 op 的**单一实现**（harness 与 HTTP 两条通道共用同一份函数）。
   *
   * 真回归：`badgeMap` 只挂了 harness ⇒ App 走 HTTP ⇒ **404**。
   * 根因是"同一件事写两遍、挂了一条忘另一条"。这里把四条 op 收成一个对象，
   * 两条通道都从这个对象挂 ⇒ **结构上不可能只挂一条**（跨通道一致性由
   * test/op-channel-parity.test.js 再兜一道）。
   */
  /**
   * 会话标识四条 op 的**晚绑定 holder**。
   *
   * 为什么需要：这四条要调内部写标题函数，而它们在下面的
   * `disposeHarness` IIFE 闭包里（函数声明提升，只在那个闭包可见）。
   * 在这里**直接构造**会 ReferenceError（重启
   * 写标题 op 失败（内部函数不可见）。
   * ⇒ 这里只声明**同一个对象引用**：HTTP handler 拿它当 `extraOps`，
   *   harness 侧也包一层从它取；真正的成员在 IIFE 里**无条件**写入。
   */
  const extraOpsHolder = {}


  const handler = createRetraceHttpHandler(ctx, {
    sessions: ctx.sessions,
    agents: ctx.agents,
    seam,
    rollback,
    hooks,
    log,
    // HTTP 侧与 harness 侧**同一份实现**（真回归修复：badgeMap 曾只挂 harness ⇒ 404）。
    extraOps: extraOpsHolder,
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
    // 会话标识四条 op：**在这里**构造（本闭包内写标题函数可见），
    // 并**无条件**写入 holder —— 不放在任何 if 分支里，杜绝"没走到就没赋值"。
    /**
     * **冷会话**（未驻留）标题清理 —— P1 真机残留的根因修复点。
     *
     * 官方 `sessionTitle.rename(session, title)` 只接受**活**会话（实测
     * `@deepseek-ai/dsh-session-title#rename` 校验 `sessions.get(id) === session`）。
     * 冷会话因此拿不到会话对象 ⇒ 旧实现只能记 pending（真机 114 个里绝大多数清不掉）。
     * 这里走**宿主公开 primitive**：从日志读出事件 → `store.prepare(id,{seed})` 造一个
     * 未入册的会话 → `store.enter` 入册（不 announce，不触发 session/created）→
     * 官方 rename（只 append `session/title`）→ `flush` 落盘 → `detach` 退册。
     * 任一步缺失/抛错 ⇒ 记录失败（可见），不留半状态。
     * @returns {Promise<'restored'|'skipped'|'failed'|'unsupported'|'unreadable'>}
     */
    async function cleanColdTitle(id) {
      const store = ctx.sessions?.store
      const can = store && typeof store.prepare === 'function' && typeof store.enter === 'function' && typeof ctx.sessions?.flush === 'function'
      if (!can) return 'unsupported'
      // 会话目录命名有两种历史形态（`<id>` 与 `session-<id>`）⇒ 用前缀匹配的单一实现，
      // 不要只试 `sessionFilePath(id)`（真机实测：`session-<id>` 那批会全部解析成 null）。
      const file = matchSessionFiles(id)[0]?.file ?? sessionFilePath(id) ?? null
      if (file === null) return 'unreadable'
      let events = null
      try { events = await readEventsFromFile(file) } catch { events = null }
      if (!Array.isArray(events) || events.length === 0) return 'unreadable'
      let session = null
      let detach = null
      try {
        session = store.prepare(id, { seed: events })
        detach = store.enter(session)
        const outcome = cleanLiveTitle(session, `cold:${id}`)
        if (outcome === 'restored') await ctx.sessions.flush(session)
        return outcome
      } catch (error) {
        log(`retrace: 冷会话标题清理失败 ${String(id).slice(0, 24)}: ${String(error?.message ?? error).slice(0, 120)}`)
        return 'failed'
      } finally {
        try { detach?.() } catch { /* 退册失败不致命；日志已可见 */ }
      }
    }

    /** 启动清理的**持久**留痕（宿主 logger 可能不落 info 级；写到插件数据家，一行一次）。 */
    function appendAutoCleanLog(line) {
      try {
        const dir = join(pluginDataHome(), 'dsh-retrace')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, 'auto-clean.log'), `${new Date().toISOString()} ${line}\n`, { flag: 'a' })
      } catch (error) {
        log(`retrace: 自动清理留痕写入失败(可见): ${String(error?.message ?? error).slice(0, 120)}`)
      }
    }

    /**
     * 非驻留会话的标题**只读**枚举（投影缓存行，与 titleMap 同源）。
     * P1 口径更正（2026-11-12）：清理要覆盖**全部会话**，不能只看 `ctx.sessions.list()`。
     * 只读；坏件跳过；枚举失败不伪报"扫过了"（返回空表 + 日志）。
     */
    function cachedSessionTitles(liveIds = new Set()) {
      const titles = new Map()
      try {
        let root = null
        for (const base of [process.env.DSH_HOME, join(homedir(), '.dsh'), ...extraSessionBases({ home: homedir() })]) {
          if (base === undefined || base === '') continue
          const candidate = join(base, 'storages', 'session_projcache', 'sessions')
          if (existsSync(candidate)) { root = candidate; break }
        }
        if (root === null) return titles
        for (const file of readdirSync(root)) {
          if (!file.endsWith('.json')) continue
          const id = file.replace(/\.json$/, '')
          if (liveIds.has(id)) continue
          try {
            const row = JSON.parse(readFileSync(join(root, file), 'utf8'))
            const title = row?.record?.rows?.title?.val
            if (typeof title === 'string' && title !== '') titles.set(id, title)
          } catch { /* 坏件/超限件跳过：不阻塞其余会话 */ }
        }
      } catch (error) {
        log(`retrace: 会话标题全量枚举不可用: ${String(error?.message ?? error).slice(0, 120)}`)
      }
      return titles
    }

    /**
     * 清一个**活**会话标题里的历史前缀（官方 `sessionTitle.rename`；幂等；失败可见）。
     * @returns {'restored'|'skipped'|'failed'}
     */
    function cleanLiveTitle(session, label = '') {
      const current = trueTitleOf(session)
      const stripped = stripTitlePrefix(current)
      if (stripped === current) return 'skipped'
      // 失败要可见：rename 抛错（会话非活/服务未挂载/标题非法）都留一条带上下文的日志
      const titles = ctx.get?.('sessionTitle')
      if (!titles || typeof titles.rename !== 'function') {
        log(`retrace: 标题清理跳过（官方 sessionTitle 不可用）${label === '' ? '' : ` @${label}`}: ${String(current).slice(0, 60)}`)
        return 'failed'
      }
      try {
        titles.rename(session, stripped)
        return 'restored'
      } catch (error) {
        log(`retrace: 标题清理失败${label === '' ? '' : ` @${label}`}: ${String(error?.message ?? error).slice(0, 120)}`)
        return 'failed'
      }
    }

    /**
     * **自动清理（P1 口径更正）**：插件加载后自动把标题里的旧前缀清掉。
     *
     * 官方 `sessionTitle.rename` 的契约是"**活的**会话对象"（实测源码：
     * `@deepseek-ai/dsh-session-title` `rename()` 会校验 `sessions.get(id) === session`），
     * 所以能清的范围是「已驻留会话」；其余会话在 **`session/created`（被打开的那一刻）**
     * 自动清 —— 两条路径合起来 = 覆盖全部会话，无需用户点按钮。
     * 只 rename（写 `session/title` 事件），不写消息/其它内容；幂等；失败可见。
     * 关闭开关：`DSH_RETRACE_AUTO_CLEAN_TITLES=0`。
     */
    async function autoCleanTitles() {
      if (process.env.DSH_RETRACE_AUTO_CLEAN_TITLES === '0') {
        logOnce('autoCleanTitles:off', 'retrace: 标题自动清理已关闭（DSH_RETRACE_AUTO_CLEAN_TITLES=0）')
        return { restored: 0, skipped: 0, failed: 0, pending: 0 }
      }
      const sessions = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
      let restored = 0, skipped = 0, failed = 0
      // ① 已驻留：直接官方 rename
      for (const session of sessions) {
        const outcome = cleanLiveTitle(session, 'startup')
        if (outcome === 'restored') restored += 1
        else if (outcome === 'failed') failed += 1
        else skipped += 1
      }
      // ② **冷会话**：枚举全部会话（缓存标题只读），逐个"造对象→rename→落盘→退册"。
      //    这是真机残留的根因路径（旧实现只记 pending）。
      const liveIds = new Set(sessions.map((session) => String(session?.id ?? '')))
      let pending = 0
      let unsupported = 0
      let unreadable = 0
      const cap = Number(process.env.DSH_RETRACE_AUTO_CLEAN_MAX ?? 300)
      let handled = 0
      for (const [id, title] of cachedSessionTitles(liveIds)) {
        if (stripTitlePrefix(title) === title) { skipped += 1; continue }
        if (!(handled < cap)) { pending += 1; continue } // 超单轮上限 ⇒ 留给下一轮/打开时
        handled += 1
        const outcome = await cleanColdTitle(id)
        if (outcome === 'restored') restored += 1
        else if (outcome === 'skipped') skipped += 1
        else if (outcome === 'unsupported') { unsupported += 1; pending += 1 }
        else if (outcome === 'unreadable') { unreadable += 1; pending += 1 }
        else failed += 1
      }
      if (unsupported > 0) {
        log(`retrace: 冷会话标题清理降级（宿主未提供 prepare/enter/flush 之一）——${unsupported} 个未驻留会话只能在其被打开时清理（可见，不崩）`)
      }
      // ③ **投影缓存（侧栏读的就是它）**：官方 rename 只改会话日志，不回写 projcache
      //    ⇒ 要把 title 行一起清掉，否则侧栏永远显示旧前缀（真机 114 个）。
      const cache = scrubProjcacheTitles({ log })
      const summaryLine = `retrace: 启动标题自动清理完成 → 已清理 ${restored} / 跳过 ${skipped} / 失败 ${failed}`
        + `（未驻留剩余 ${pending}${unreadable > 0 ? `，日志不可读 ${unreadable}` : ''}`
        + `；投影缓存 title 行 ${cache.updated}/${cache.scanned} 已更新${cache.failed > 0 ? `，失败 ${cache.failed}` : ''}）`
      logOnce(`autoCleanTitles:${restored}:${skipped}:${failed}:${pending}:${cache.updated}`, summaryLine)
      // 持久日志（宿主 logger 的 info 级别可能被过滤 ⇒ 真机无法判断"跑没跑"）：
      // 写到插件自己的数据家，一行一次运行，便于事后核对。
      appendAutoCleanLog(summaryLine)
      return { restored, skipped, failed, pending, cacheUpdated: cache.updated, cacheScanned: cache.scanned }
    }

    Object.assign(extraOpsHolder, {
    // 检查点恢复（Batch2）：预览票据 + 执行。HTTP 与 harness 同一份实现。
    restoreList: async (args) => checkpointRestore.restoreList(args),
    restoreExport: async (args) => checkpointRestore.restoreExport(args),
    checkpointList: async (args) => checkpointRestore.list(args),
    checkpointPreview: async (args) => checkpointRestore.preview(args),
    checkpointExecute: async (args) => checkpointRestore.execute(args),
    // 会话会话标识：session id → 稳定的会话标识，便于人工引用。
    sessionBadge: async (args) => {
      const sessionId = String(args?.sessionId ?? '')
      return { ok: true, value: { sessionId, badge: await sessionBadge(sessionId) } }
    },
    // public build: title-write op removed
    // 兼容清理（issue #7）：把历史版本写入标题的插件前缀去掉，恢复原标题。
    // 只走官方 sessionTitle.rename（user source title）；**不写会话日志内容**、不碰消息；
    // 无前缀的标题原样跳过（幂等）。返回计数供宿主日志与调用方核对。
    //
    // P1（2026-11-12 真机反馈「只扫 2 个会话」）:旧实现只遍历 `ctx.sessions.list()`
    // **驻留**会话 ⇒ 真机 scanned=2（其余会话从未被看到）。现在按「**驻留 ∪ 全部会话**」
    // 枚举：非驻留会话的标题从**投影缓存行**只读取（与 titleMap 同源、只读）；
    // 官方 rename 需要会话对象 ⇒ 未驻留的带前缀会话计入 `pending`（客户端显示
    // "打开后再点一次即可清理"），不直接改他人的日志/缓存。
    restoreSessionTitles: async () => {
      try {
        const sessions = typeof ctx.sessions?.list === 'function' ? ctx.sessions.list() : []
        const liveIds = new Set(sessions.map((session) => String(session?.id ?? '')))
        // ① 非驻留会话的标题只读来源：投影缓存行（与启动自动清理同一实现）
        const cachedTitles = cachedSessionTitles(liveIds)
        let scanned = 0, restored = 0, skipped = 0, failed = 0, pending = 0
        const pendingSample = []
        // ② 驻留会话:标题取日志真值,官方 rename 直接清
        for (const session of sessions) {
          scanned += 1
          const outcome = cleanLiveTitle(session, 'manual')
          if (outcome === 'restored') restored += 1
          else if (outcome === 'failed') failed += 1
          else skipped += 1
        }
        // ③ 非驻留会话:扫描全部(缓存标题),并**尽力清理**:
        //   官方 rename 的契约是"活的会话对象",非驻留只给得出 `{ id }` 句柄 ⇒ 先试一次
        //   (宿主只接受活会话时会抛 ⇒ 计入 pending,不猜、更不直接写人家的日志/缓存)。
        for (const [id, title] of cachedTitles) {
          scanned += 1
          const stripped = stripTitlePrefix(title)
          if (stripped === title) { skipped += 1; continue }
          let wrote = false
          try {
            const titles = ctx.get?.('sessionTitle')
            if (titles && typeof titles.rename === 'function') { titles.rename({ id }, stripped); wrote = true }
          } catch { wrote = false }
          if (wrote) { restored += 1; continue }
          pending += 1
          if (pendingSample.length < 5) pendingSample.push(id)
        }
        const cache = scrubProjcacheTitles({ log })
        logOnce(`restoreSessionTitles:${scanned}:${restored}:${pending}:${cache.updated}`,
          `retrace: restoreSessionTitles → scanned=${scanned}(驻留 ${sessions.length} + 未驻留 ${cachedTitles.size}) restored=${restored} skipped=${skipped} pending=${pending} failed=${failed}；投影缓存 title 行 ${cache.updated}/${cache.scanned} 已更新`)
        return { ok: true, value: { scanned, restored, skipped, failed, pending, pendingSample, cacheUpdated: cache.updated, cacheScanned: cache.scanned } }
      } catch (error) {
        return { ok: false, error: { code: 'internal', message: String(error) } }
      }
    },
    // public build: batch title-write op removed
    // 会话标识全量映射：客户端同步渲染路径（横幅 labelOf）不能 await、也不能自算
    // （本地只有 FNV 兜底模块）⇒ 由宿主把已解析映射一次下发，保证跨载体同源。
    /**
     * 只读名字映射：id → 最后一条 `session/title` 真值。拿不到的表项**留空**（不伪造）。
     * 数据源 = **投影缓存行**（`rows.title.val`；T3b 已把日志真值回填进去），失败退回空表。
     * 只读：不写任何文件。
     */
    titleMap: async (opts = {}) => {
      try {
        const { readdirSync, readFileSync, existsSync, statSync } = await import('node:fs')
        const { join } = await import('node:path')
        const { homedir } = await import('node:os')
        let root = null
        for (const base of [process.env.DSH_HOME, join(homedir(), '.dsh'), ...extraSessionBases({ home: homedir() })]) {
          if (base === undefined || base === '') continue
          const candidate = join(base, 'storages', 'session_projcache', 'sessions')
          if (existsSync(candidate)) { root = candidate; break }
        }
        // (懒加载+体积上限,目标①):支持按 id 懒取 + 单件上限 + 单次预算 + 结果缓存 + 可观测日志
        const maxBytes = Number(process.env.DSH_RETRACE_MAX_PROJCACHE_KB ?? 256) * 1024   // comm:单条 projcache 行 >256KB ⇒ 跳过不解析(env 可配)
        const budgetBytes = Number(process.env.DSH_RETRACE_TITLE_BUDGET_MB ?? 8) * 1048576
        const wantIds = Array.isArray(opts?.ids) ? new Set(opts.ids.map(String)) : null
        // B1: 显式 ids(懒取)请求 ⇒ 放宽"解析闸"到 `DSH_RETRACE_TITLE_MAX_MB`(默认 2MB)/件
        //   —— 语义: "**你点名要的件，我一律解析**"（仍受单次预算 8MB 约束）；全量调用保持 256KB 闸。
        const capBytes = wantIds ? Math.max(maxBytes, Number(process.env.DSH_RETRACE_TITLE_MAX_MB ?? 2) * 1048576) : maxBytes
        if (root !== null && titleMapCache.root === root && Array.isArray(opts?.ids) === false && Date.now() - titleMapCache.at < 60000) {
          return { ok: true, value: { count: Object.keys(titleMapCache.titles).length, titles: titleMapCache.titles, cached: true } }
        }
        const titles = {}
        let count = 0, readFiles = 0, skipped = 0, bytes = 0, skippedBytes = 0
        const t0 = Date.now()
        if (root !== null) {
          let seen = 0
          for (const f of readdirSync(root)) {
            if (!f.endsWith('.json')) continue
            if (++seen % 50 === 0) await new Promise((r) => setTimeout(r, 0))   // comm:分块 + 每 50 条让出事件循环
            const id = f.replace(/\.json$/, '')
            if (wantIds !== null && !wantIds.has(id)) continue
            const fp = join(root, f)
            let sz = 0
            try { sz = statSync(fp).size } catch { sz = 0 }
            if (sz > capBytes) { skipped++; skippedBytes += sz; logOnce(`titleMap:skip:${id}`, `retrace: titleMap 跳过超限件 ${id}（${Math.round(sz / 1024)}KB > 上限 ${Math.round(capBytes / 1024)}KB）⇒ 该行只显示会话标识`); continue }
            if (bytes + sz > budgetBytes) { logOnce('titleMap:budget', `retrace: titleMap 达单次读取预算 ${Math.round(budgetBytes / 1048576)}MB（已读 ${readFiles} 件）⇒ 停止枚举，余下只显示会话标识`); break }
            try {
              const row = JSON.parse(readFileSync(fp, 'utf8'))
              bytes += sz; readFiles++
              const val = row?.record?.rows?.title?.val
              if (typeof val === 'string' && val !== '') { titles[id] = (process.env.DSH_RETRACE_SHOW_CODES === '0' ? val.replace(/^\[[^\]\s]{4,24}\]\s*/, '') : val); count++ }
            } catch (error) { logOnce(`titleMap:bad:${id}`, `retrace: titleMap 读 ${id} 失败：${String(error?.message ?? error).slice(0, 80)} ⇒ 跳过(不阻塞渲染)`) }
          }
        }
        if (root !== null && wantIds === null) { titleMapCache.root = root; titleMapCache.at = Date.now(); titleMapCache.titles = titles }
        logOnce('titleMap:result', `retrace: titleMap → ${count} 条 / 跳过 ${skipped} 条(解析闸>${Math.round(maxBytes/1024)}KB, ${skippedBytes} B) / 读 ${readFiles} 件 ${bytes} B / 耗时 ${Date.now() - t0}ms${wantIds ? ' / 懒取' : ''}`)
        return { ok: true, value: { count, titles } }
      } catch (error) {
        return { ok: false, error: { code: 'titleMap-failed', message: String(error?.message ?? error) } }
      }
    },
    badgeMap: async () => {

      return { ok: true, value: { count: 0, badges: {}, tableError: null, inject: process.env.DSH_RETRACE_INJECT !== '0' } }
      
    },    })

    if (typeof harness === 'undefined' || !harness || typeof harness.handle !== 'function') return () => {}

    /**
     * 从文件全量事件计算「遮蔽范围」(事件级,绕开 host 稀疏 events)。
     * 返回 { start, end, shadowedSeqs } 或 null。
     * mode='round' 遮蔽目标轮;mode='tail' 遮蔽目标之后(编辑 fromScratch)。
     */
    // 遮蔽范围一律经 dshAdapter.spanProbeFromFile(读文件全量 events +
    // 官方 foldSurface 重放)算出起返回显式状态 {status, span, facts}。
    /**
     * 名称真值 = 日志里最后一个 `session/title` 事件（实现见模块级 `trueTitleOf`，
     * 提到模块级是为了可单测）。
     */
    /** 官方 rename pin:user source title → 关闭自动改名 + 投影刷新。 */
    function pinTitle(session, title) {
      const titles = ctx.get?.('sessionTitle')
      if (session && titles && typeof titles.rename === 'function') {
        try { titles.rename(session, title); return true } catch { /* fallback append */ }
      }
      // ⑤ 官方 rename 不可用 ⇒ 只记日志,不做持久 append(轮边界外 append 会写坏恢复链)
      log(`retrace: 标题 pin 跳过(官方 rename 不可用):"${String(title).slice(0, 60)}"`) 
      return false
    }
    // 操作前从文件算遮蔽(绕开 host 稀疏 events,用户方案)
    const withFileSpan = (op, modeOf) => async (args) => {
      // 不自动改标题（issue #7）：操作路径只做数据操作，不重命名会话。
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
      let attempt = await api[op](args)
      // C 竞态重探(只重试一次,绝不循环):区间在本函数开头就算好了,而 api[op]
      // 内部的 ensureIdle(host-core)在**之后**才停下正在跑的轮次 —— 停下后
      // 才落盘的 tool/result 不在已算好的区间里 ⇒ 区间把 assistant 的 tool-call
      // 与它的 tool/result 拆开 ⇒ 守卫 W1 以 marker-rejected 拒写
      // (实测现场:probe 时面尾 43843,轮次停下后 43845 才落盘)。
      // 首次被拒 + 确实注入过文件侧 span ⇒ 事后重新探一次,用**新** span 重试一次。
      if (attempt?.ok === false && attempt?.error?.code === 'marker-rejected' && args?.span) {
        try {
          const spec = modeOf(args)
          const mode = typeof spec === 'string' ? spec : spec?.mode
          const endSeq = typeof spec === 'object' && spec ? spec.endSeq : undefined
          const target = typeof args?.seq === 'number' ? args.seq : args?.messageId
          const fresh = await dshAdapter.spanProbeFromFile(
            args.sessionId, target, mode, endSeq !== undefined ? { endSeq } : undefined,
          )
          log(`retrace: marker-rejected → 重探区间(op=${op} target=${String(target).slice(0, 24)} mode=${mode}) → ${describeSpanResult(fresh)}`)
          if (fresh?.span) {
            attempt = await api[op]({
              ...args,
              span: fresh.span,
              ...(op === 'regenerate' && fresh.prompt ? { regeneratePrompt: fresh.prompt } : {}),
            })
          }
        } catch (error) {
          // 重探/重试自身失败 ⇒ 原样返回第一次结果(绝不再试第二次)
          log(`retrace: marker-rejected 重探失败(op=${op}): ${String(error).slice(0, 120)}`)
        }
      }
      return attempt
    }
    /**
     * 批量 pin 全部已驻留会话:用官方 rename 写 `[会话标识] 原标题`。
     * 启动时/新会话驻留时调用——用户打开 DSH 侧边栏即可看到会话标识,不依赖
     * 打开 ForkView 或先编辑。返回结果数组。
     */
    let sessionCreatedDispose = null
    const bootPinRetry = { dispose: () => {} }

    // **启动即清理**：不等重试链的 30s 第一轮,加载后 ~1.2s 先清一次(句柄 unref;
    // dispose 撤销)。会话陆续驻留由重试链 + session/created 继续覆盖。
    let autoCleanTimer = null
    try {
      autoCleanTimer = setTimeout(() => {
        autoCleanTimer = null
        Promise.resolve()
          .then(() => autoCleanTitles())
          .then((result) => {
            logOnce(`autoCleanTitles:startup:${result.restored}:${result.skipped}:${result.failed}`,
              `retrace: 启动标题自动清理完成 → 已清理 ${result.restored} / 跳过 ${result.skipped} / 失败 ${result.failed}（未驻留剩余 ${result.pending}）`)
          })
          .catch((error) => log(`retrace: 启动标题自动清理异常(可见,不影响主功能): ${String(error?.message ?? error).slice(0, 120)}`))
      }, 1200)
      if (typeof autoCleanTimer?.unref === 'function') autoCleanTimer.unref()
    } catch (error) {
      log(`retrace: 启动标题自动清理调度失败(可见): ${String(error?.message ?? error).slice(0, 120)}`)
    }

    const disposers = [
      () => sessionCreatedDispose?.(),
      () => { if (autoCleanTimer !== null) { try { clearTimeout(autoCleanTimer) } catch { /* 已触发 */ } autoCleanTimer = null } },

      // recall 语义 = 遮蔽目标轮及之后全部(编辑=从此处分叉)
      // ——不再只遮蔽目标轮(缺陷①断层);tail 在官方 foldSurface
      // nodes 上按位置切(修复),大范围遮蔽由快照点守卫引导分支。
      harness.handle('retrace.recall', withFileSpan('recall', () => 'tail')),
      harness.handle('retrace.editAndResend', withFileSpan('editAndResend', (a) => (a?.fromScratch ? 'tail' : 'round'))),
      harness.handle('retrace.regenerate', withFileSpan('regenerate', () => 'round')),
      // 撤销撤回(hidden effect cancel):0.4.124。单段 append,不需要文件侧 span
      // (也没有遮蔽计算)⇒ 不走 withFileSpan,直接转 api.unhide。
      // 两条通道都挂:harness/wire 走这里,HTTP 走 http.js 的通用 `api[op]` 分发
      // (见 lib/http.js 的注释与 test/op-channel-parity.test.js:unhide **不在**
      // HTTP_ONLY_BY_DESIGN 名单里 —— 它两通道都可达)。
      harness.handle('retrace.unhide', (args) => api.unhide(args)),
      // 原文回收(撤回后的原文回收能力,插件自带):读 = 零写枚举撤回/替换区间
      // (recallIndex),写 = append 单段可读副本/恢复标记(reclaim,正本不动)。
      // 两条通道都挂:harness/wire 走这里,HTTP 走 http.js 的通用 `api[op]` 分发
      // (与 unhide 同规:不需要手写 HTTP 分支,两条通道同挂)。
      harness.handle('retrace.recallIndex', (args) => api.recallIndex(args)),
      harness.handle('retrace.reclaim', (args) => api.reclaim(args)),
      // 真正恢复(true restore,0.4.126):日志层面中和目标 marker 的两段 ⇒ 区间回到
      // **模型面** ⇒ 编辑/重发/撤回入口复活。与 unhide 同为 host-core 一等 op,故
      // HTTP 侧由 lib/http.js 的通用 `api[op]` 分发天然覆盖(两条通道都可达)。
      harness.handle('retrace.unshadow', (args) => api.unshadow(args)),

      harness.handle('retrace.restoreList', (...a) => extraOpsHolder.restoreList(...a)),
      harness.handle('retrace.restoreExport', (...a) => extraOpsHolder.restoreExport(...a)),
      harness.handle('retrace.checkpointList', (...a) => extraOpsHolder.checkpointList(...a)),
      harness.handle('retrace.checkpointPreview', (...a) => extraOpsHolder.checkpointPreview(...a)),
      harness.handle('retrace.checkpointExecute', (...a) => extraOpsHolder.checkpointExecute(...a)),
      harness.handle('retrace.sessionBadge', (...a) => extraOpsHolder.sessionBadge(...a)),
      // 兼容清理：旧标题前缀 → 原标题（只 rename，不改会话内容）。
      harness.handle('retrace.restoreSessionTitles', (...a) => extraOpsHolder.restoreSessionTitles(...a)),
      // public build: title-write handles removed
      harness.handle('retrace.badgeMap', (...a) => extraOpsHolder.badgeMap(...a)),
      harness.handle('retrace.titleMap', (...a) => extraOpsHolder.titleMap(...a)),
      // 关闭守卫:查询全会话运行中状态(agent/queued/jobs/未闭合轮)。
      // host 侧无"关闭前"弹窗 seam(宿主 UI 内部),此 handler 供 client 或宿主未来
      // 在关闭动作前查询;dispose 强提示见下方 attachCloseGuard。
      harness.handle('retrace.runningState', async (args) => {
        try {
          const sid = String(args?.sessionId ?? '')
          if (sid) {
            return { ok: true, value: sessionRunningState(ctx, sid) }
          }
          // 负载形状与 HTTP 面同构(含宿主承载面)。wire 通道拿不到请求对象 ⇒
          // guardSurfaceOf(ctx, undefined, undefined) 只能靠宿主痕迹判:桌面宿主 →
          // unknown(客户端不武装原生门,安全侧),web 宿主 → browser。**客户端那边
          // 还有一票否决**(UA/URL),所以这条通道判错也不会把桌面端卡死。
          return { ok: true, value: { running: runningSessions(ctx), ...guardSurfaceOf(ctx, undefined, undefined) } }
        } catch (error) {
          return { ok: false, error: { code: 'internal', message: String(error) } }
        }
      }),
    ]
    // 启动重试链的定时器收口(不再额外钉住宿主事件循环;dispose 时撤销挂着的那个)。
    disposers.push(() => bootPinRetry.dispose())
    return () => disposers.forEach((dispose) => dispose())
  })()

  // R1 实时看门狗：轮询文件尾部 seq vs 内存长度，捕获并发写入/旧光标回放现场。
  const watchdog = createWatchdog(ctx, log)

  // R4 中断轮次治理：退出/重载时对未闭合 turn 会话提示（只检测不写事件）。
  const warnUnclosed = attachExitWarning(ctx, log)

  // 关闭守卫(防误关)：退出/重载时对"运行中任务/未完成对话"会话强提示。
  // host 无关闭前弹窗 seam → 替代路径 = dispose 强提示 + runningState handler(client 可查)。
  const guardClose = attachCloseGuard(ctx, log)

  // 承载面探针(第二轮,issue #1):把每次判定的**入参(能力头 / 请求 UA /
  // 请求 URL 标记 / 宿主桌面痕迹)与结果(surface/quitVeto)**按组合去重写进宿主日志。
  // 用途:报告人跑一次就能确认是哪条规则生效(不必再互相猜是哪一层判反了)。
  // 只打日志,不改任何判定。
  installSurfaceProbe(log)

  ctx.effect(() => () => {
    disposeRoute()
    disposeHarness()
    watchdog.dispose()

    warnUnclosed()
    guardClose()
    uninstallSurfaceProbe()

  }, 'dsh-retrace: transports')
}
