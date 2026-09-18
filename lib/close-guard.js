/**
 * dsh-retrace · lib/close-guard.js
 *
 * 关闭守卫——防误关:会话有**运行中任务**时关闭会中断丢进度。
 *
 * 背景:用户刚失误关闭有运行中任务的对话损失进度。小任务。
 *
 * Seam 调研结论:
 * - 检测侧可行:agent.status('idle'|'running' 官方生命周期)、agent.inbox(排队 work,
 *   status=idle 也可能有)、unclosedTurns(崩溃/强杀现场,interrupt-guard 已有)、
 *   ctx.jobs.list()(后台任务);
 * - 拦截侧官方无 seam:host/client 均无"会话关闭前"插件钩子(宿主 UI 内部操作);
 *   可用的退出时机 = 插件 dispose(应用退出/重载最后一个插件钩子,interrupt-guard
 *   attachExitWarning 同款模式);
 * - 故交付替代路径(允许):①运行中**检测全集**(含 jobs/queued,比只查未闭合
 *   轮全)②dispose 时**强提示**(中文,列出运行中会话与原因)③host handler 供 client
 *   查询单会话/全会话运行状态(未来宿主 UI seam 出现可接真弹窗)。
 *
 * 铁律:只检测+提示,绝不中断/取消 agent、绝不写事件(中断属用户显式动作,
 * 守卫只在用户"关闭"动作时确认——本插件无该 seam 时只提示,不代执行)。
 *
 * ── 宿主承载面判定(2026-09-18,外部 issue #1:桌面端托盘退出死锁)─────────────
 *
 * 现场:DSH Desktop 上托盘「退出」点了没反应,App 退不掉(只能强退);关掉本插件
 * 的「退出确认」立刻正常;网页端一直正常。逐条核实到的事实:
 *  ① 客户端 `onBeforeUnload` 对 `kind !== 'unknown'` 一律 `preventDefault()`
 *     ——空会话也拦;
 *  ② DSH Desktop 的 Electron 壳**没有**处理 `will-prevent-unload`
 *     (装好的 2.0.9 `app.asar` 全文检索 0 命中)。Electron 的默认语义 = 尊重页面
 *     否决,且不弹任何界面 ⇒ **一旦页面否决被抬起来**,它就是静默的:不弹框、
 *     不给用户任何可见反馈;
 *  ③ 退出入口**随 Desktop 版本/平台而变**(这是本 issue 的病因:别把某一条入口
 *     当成全部事实):
 *     · 外部报告(DSH Desktop 0.9.0 / Windows)那一类入口**会**触发页面
 *       `beforeunload` ⇒ ② 生效:否决被静默吞掉,用户看到"点了退出没反应、
 *       只能强退";
 *     · 本机核对的 2.0.9 壳上,托盘项走 `requestQuit(0)` → `createDesktopShutdown`
 *       → `generation.release()` → `window.destroy()` → `app.exit(code)`
 *       (且 `before-quit` 也被 `preventDefault() + requestQuit(0)` 收进同一路径)
 *       ⇒ `destroy()` / `app.exit()` 都**不**经过页面 `beforeunload`,那类版本上
 *       退出本来就正常(与本插件无关);
 *  ④ 反之,普通浏览器(网页版)会为 `beforeunload` 弹原生确认框,页面否决对用户
 *     是**可见**的 ⇒ 只有这条路径上"武装原生门"才是有效动作。
 *
 * ⇒ 页面里分不出宿主属于哪一类,而③第一类上否决是静默的(会卡住退出且毫无反馈)
 * —— 所以**桌面端一律不武装**原生门(与版本无关):2.0.9 那类版本上它本来是空转,
 * 0.9.0 那类版本上它能卡死退出。「本页宿主是否承载 quit-veto(否决对用户可见)」
 * 是**宿主侧**才知道的属性,由宿主判定、随既有的 runningState 载荷下发(复用既有
 * 通道,不新造)。客户端只在宿主明确回 true 时武装原生门(见
 * lib/close-guard-client.js quitVetoOf)。
 *
 * 判据取**请求级证据**:DSH Desktop 主进程给 renderer 的**每一个** HTTP/WS 请求
 * 挂一个代际能力头(`electron-runtime` 的 installRendererAccessHeader;
 * `webRequest.onBeforeSendHeaders({urls:['<all_urls>']})`,且挂之前先剥掉请求里
 * 同名头 ⇒ 页面 JS 伪造不了)。头在 ⇒ 本请求来自 Desktop 的 Electron 页面;
 * 头不在且宿主看不出 Electron 痕迹 ⇒ 普通浏览器页面。
 *
 * 已知中性态(默认取**不武装**这一侧):动态桥 wire 通道拿不到请求对象;宿主能看出
 * 自己是 Electron 但请求没带该头(旧版桌面壳/桌面版兼容模式的普通浏览器页)。
 * 两种都判 unknown ⇒ 客户端不武装原生门,退化为"仅运行中横幅"。
 */
// unclosedTurns 直接复用 interrupt-guard(该文件零 import,无环),
// 不再内联复制一份——后续 interrupt-guard 演进(如 reason 感知)自动同步。
import { unclosedTurns } from './interrupt-guard.js'
// 会话枚举兼容:新宿主 SessionStore.list() / 旧宿主 keys();绝不用 Object.keys(service)
// (那会取到服务自身字段而非 session id ⇒ 运行中扫描静默为空,见 host-compat 注释)。
import { sessionIds } from './host-compat.js'

/** 判定单个会话是否"运行中"(任何未完成 work 都算,供关闭前确认)。
 * 对齐官方形状——agent.inbox 公开面是
 *  hasPending/nextStep/nextTurn(无 queued/pending);jobs 快照按 owner.id 关联
 *  (无 sessionId/session 字段)。 */
export function runningState(sessionId, { agent, session, jobs = [] } = {}) {
  const reasons = []
  // 1) agent 活动(status 官方生命周期:running = 有 driver 在跑;
  //    idle 但 maintenance 阶段也被官方映射为 idle——见原因 queued 覆盖)
  if (agent && typeof agent.status === 'string' && agent.status === 'running') {
    reasons.push('agent-running')
  }
  // 2) 排队/待办 work——官方 Inbox:hasPending = nextTurn/nextStep 任一非空
  //    (agent idle 也可能有排队消息/待办,正是守卫要防的场景)
  const inbox = agent?.inbox
  let queued = 0
  if (inbox && typeof inbox === 'object') {
    if (typeof inbox.hasPending === 'boolean' && inbox.hasPending) {
      // 精确数:nextTurn/nextStep 数组长;取不到数组时 hasPending=true 记为 1+
      const nt = Array.isArray(inbox.nextTurn) ? inbox.nextTurn.length : 0
      const ns = Array.isArray(inbox.nextStep) ? inbox.nextStep.length : 0
      queued = nt + ns > 0 ? nt + ns : 1
    }
  }
  if (queued > 0) reasons.push(`queued-${queued}`)
  // 3) 未闭合轮(崩溃/强杀现场;interrupted/aborted 是官方正常闭合不算——复用 interrupt-guard)
  const unclosed = unclosedTurns(session)
  if (unclosed.length > 0) reasons.push(`unclosed-turn-${unclosed.map((u) => u.turn).join(',')}`)
  // 4) 后台任务——官方 jobs 快照按 owner.id 关联(owner = 会话 agent)
  if (Array.isArray(jobs)) {
    const mine = jobs.filter((j) => {
      if (!j) return false
      const owner = j.owner
      const ownerId = typeof owner === 'string' ? owner : owner?.id
      return ownerId === sessionId
    })
    if (mine.length > 0) reasons.push(`jobs-${mine.length}`)
  }
  return { sessionId, running: reasons.length > 0, reasons }
}

/**
 * 读取 jobs 快照。官方 list(caller) 语义 = 只返回无主或属于该 caller 的 job;
 * 无 caller 的 list() 只给无主 job。这里:①service.list 可接受 caller 参数 →
 *   逐会话用 {id} caller 取;②不可接受参数 → 退化为全量 + 按 owner.id 过滤。
 * @returns {Array} 官方 job 快照数组(或空)。
 */
function readJobs(ctx, sessionId) {
  try {
    const service = ctx?.jobs
    if (!service || typeof service.list !== 'function') return []
    // 官方 LocalJobRegistry.list(caller):caller 形状 { id }(owner 匹配用)
    const list = sessionId !== undefined
      ? service.list({ id: sessionId })
      : service.list()
    return Array.isArray(list) ? list : []
  } catch { return [] }
}

/**
 * 扫描全会话,返回运行中列表(供 dispose 强提示与 client 查询)。
 * @param {object} ctx - cordis ctx(sessions/agents/jobs)。
 * @returns {Array<{sessionId:string, reasons:string[]}>} 运行中会话(静止会话不出现在结果)。
 */
export function runningSessions(ctx) {
  const sessions = ctx?.sessions
  if (!sessions || typeof sessions !== 'object') return []
  const ids = sessionIds(sessions)
  const out = []
  for (const id of ids) {
    const session = typeof sessions.get === 'function' ? sessions.get(id) : sessions[id]
    const agent = (() => {
      try {
        const registry = ctx?.agents
        if (!registry) return null
        return typeof registry.get === 'function' ? registry.get(id) : registry[id]
      } catch { return null }
    })()
    // 按会话取 jobs(官方 list(caller={id}) 只返该会话 job;读不到降级空)
    const jobs = readJobs(ctx, String(id))
    const state = runningState(String(id), { agent, session, jobs })
    if (state.running) out.push({ sessionId: state.sessionId, reasons: state.reasons })
  }
  return out
}

/** 单会话状态(client 查询)。静止返回 { running:false }。 */
export function sessionRunningState(ctx, sessionId) {
  const sessions = ctx?.sessions
  const session = sessions && typeof sessions.get === 'function' ? sessions.get(String(sessionId)) : undefined
  const agent = (() => {
    try {
      const registry = ctx?.agents
      if (!registry) return null
      return typeof registry.get === 'function' ? registry.get(String(sessionId)) : registry[String(sessionId)]
    } catch { return null }
  })()
  const jobs = readJobs(ctx, String(sessionId))
  return runningState(String(sessionId), { agent, session, jobs })
}

// ── 宿主承载面:判定"本页宿主是否承载 quit-veto" ─────────────────────────────
/** DSH Desktop 主进程给 renderer 每个请求挂的代际能力头(页面 JS 伪造不了)。 */
export const DESKTOP_RENDERER_HEADER = 'x-dsh-desktop-renderer'

/** 承载面取值。语义见文件头注释。 */
export const PAGE_SURFACE = Object.freeze({
  /** DSH Desktop 的 Electron 页面:原生 `beforeunload` 门在此静默。 */
  DESKTOP_RENDERER: 'desktop-renderer',
  /** 普通浏览器页面:原生 `beforeunload` 确认框在此出现。 */
  BROWSER: 'browser',
  /** 中性态:拿不到请求证据 / 能看出 Electron 但请求没带能力头。 */
  UNKNOWN: 'unknown',
})

/**
 * DSH Desktop 宿主侧注入的服务名(桌面专属)。任一在场 ⇒ 本宿主是桌面壳。
 * 只用于"要不要退回中性态"的判断,不参与"是不是 Electron 页面"的判断。
 */
const DESKTOP_HOST_SERVICES = ['desktopBrowserAccess', 'desktopRuntime', 'desktopPnpmBootstrap']

/** 安全取一个可选服务(未注册/取值抛错一律当"没有")。 */
function serviceOf(ctx, name) {
  try {
    return typeof ctx?.get === 'function' ? ctx.get(name) : undefined
  } catch { return undefined }
}

/** 本宿主是否带 Electron/桌面壳痕迹(多项独立判据,任一命中即为真)。 */
export function desktopHostEvidence(ctx) {
  try {
    if (typeof process !== 'undefined' && process?.versions?.electron) return true
  } catch { /* 浏览器侧无 process */ }
  for (const name of DESKTOP_HOST_SERVICES) {
    if (serviceOf(ctx, name)) return true
  }
  return false
}

/** 请求头里是否带 Desktop renderer 能力头(值不看内容:非空即证据)。 */
function hasDesktopRendererHeader(headers) {
  if (!headers || typeof headers !== 'object') return false
  const present = (value) => {
    if (typeof value === 'string') return value.length > 0
    if (Array.isArray(value)) return value.length > 0
    return Boolean(value)
  }
  try {
    // Node 的 req.headers 名字已小写;非 Node 形状(经序列化/代理)按大小写不敏感兜底。
    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === DESKTOP_RENDERER_HEADER && present(value)) return true
    }
  } catch { return false }
  return false
}

/**
 * 从**请求头 + 宿主痕迹**判定承载面(纯函数,可单测)。
 * @param {object} [headers] Node `req.headers` 形状;拿不到请求对象时为 undefined。
 * @param {object} [opts] `{ desktopHost }` = desktopHostEvidence(ctx) 的结果。
 * @returns {'desktop-renderer'|'browser'|'unknown'}
 */
export function pageSurfaceOf(headers, { desktopHost = false } = {}) {
  if (hasDesktopRendererHeader(headers)) return PAGE_SURFACE.DESKTOP_RENDERER
  // 无能力头。能看出宿主是 Electron ⇒ 中性态(可能是旧版桌面壳没挂头,也可能是
  // 桌面版兼容模式下的普通浏览器页;两者分不开)⇒ 交给调用方按安全侧处理。
  if (desktopHost) return PAGE_SURFACE.UNKNOWN
  return PAGE_SURFACE.BROWSER
}

/**
 * 该承载面能否承载 quit-veto(页面否决对用户可见)。
 * browser → true;desktop-renderer → false;unknown → null(未知 ⇒ 客户端不武装)。
 */
export function quitVetoFor(surface) {
  if (surface === PAGE_SURFACE.BROWSER) return true
  if (surface === PAGE_SURFACE.DESKTOP_RENDERER) return false
  return null
}

/**
 * 给 runningState 载荷用的承载面描述。
 * @param {object} ctx - cordis ctx(用于看宿主痕迹)。
 * @param {object} [headers] - 发起该请求的 `req.headers`;wire/harness 通道传 undefined。
 * @returns {{ surface:string, quitVeto:boolean|null }}
 */
export function guardSurfaceOf(ctx, headers) {
  const surface = pageSurfaceOf(headers, { desktopHost: desktopHostEvidence(ctx) })
  return { surface, quitVeto: quitVetoFor(surface) }
}

/**
 * 挂载"关闭前强提示":插件 dispose(应用退出/重载)时,若有运行中会话 → 中文提示
 * 列出每个会话与原因(agent-running/queued/jobs/unclosed-turn)。只提示不中断。
 * @returns 清理函数(调用方在 dispose 里执行)。
 */
export function attachCloseGuard(ctx, log = () => {}) {
  return () => {
    let running
    try {
      running = runningSessions(ctx)
    } catch (error) {
      log(`retrace-close-guard: 扫描失败 ${String(error).slice(0, 120)}`)
      return
    }
    if (running.length === 0) return
    const lines = running.map((r) => `  - 会话 ${r.sessionId}(${r.reasons.join(', ')})`)
    log(`retrace-close-guard: ⚠️ 有 ${running.length} 个会话存在运行中任务/未完成对话,关闭将中断进度:\n${lines.join('\n')}`)
    log('retrace-close-guard: 若需保留进度,请先等任务完成或确认中断;中断后未闭合轮可体检(dsh-log-contract check)')
  }
}
