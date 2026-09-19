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
 * 判据取**请求级证据**。能力头(第一条)是外部报告那个 issue 的**第一次修复**:
 * DSH Desktop 主进程给 renderer 的**每一个** HTTP/WS 请求挂一个代际能力头
 * (`electron-runtime` 的 installRendererAccessHeader;
 * `webRequest.onBeforeSendHeaders({urls:['<all_urls>']})`,且挂之前先剥掉请求里
 * 同名头 ⇒ 页面 JS 伪造不了)。头在 ⇒ 本请求来自 Desktop 的 Electron 页面。
 *
 * ⚠️ **2026-09-18 第二轮(外部 issue #1 复测仍卡死)**:那条修复只对**挂了能力头的
 * 壳**成立。报告人那台(Dsh Desktop 0.9.0 / Windows)是**纯 Node 跑 harness**
 * (`node.exe … resources\app\harness-node-entry.mjs`)+ Electron 渲染页,三条旧判据
 * 逐条实测都不成立(能力头 0 命中;`desktopBrowserAccess`/`desktopRuntime`/
 * `desktopPnpmBootstrap` 三个服务名 0 命中;`process.versions.electron` 为假)。
 * 旧实现把"**完全没有证据**"归成了 `BROWSER`(`pageSurfaceOf` 末尾直接 return
 * BROWSER)⇒ `quitVeto=true` ⇒ 客户端**照旧武装**原生门 ⇒ 仍然退不掉,而且比
 * 0.9.0 时更隐蔽(空闲也拦)。报告人抓到的原始回包是决定性的:
 * `{"running":[],"surface":"browser","quitVeto":true}`。
 *
 * ⇒ 判据补成**四条请求级证据 + 一条宿主痕迹**,任一请求级证据成立即判桌面页面:
 *   ① 能力头 `x-dsh-desktop-renderer` 非空(挂了头的壳);
 *   ② 请求 `user-agent` 含 `Electron`(**页面自身属性**,纯 Node 宿主也读得到);
 *   ③ 请求 URL 或 **`Referer`** 含 `dsh-desktop-`(报告人那套壳的查询参数前缀
 *      `?token=…&dsh-desktop-mode=advanced&dsh-desktop-platform=…`)。
 *      ⚠️ 2026-09-19 复核:我们**自己**的轮询打的是 `ROUTE_BASE+'/runningState'`
 *      (**无 query**)、wire 通道传 `undefined` ⇒ **URL 这一条对生产请求打不着**;
 *      同源 fetch 默认 `strict-origin-when-cross-origin` 会在 `Referer` 里带**完整页面 URL**
 *      ⇒ **Referer 才是宿主侧真能看到页面标记的通道**(两条都留:URL 判据对外部直连调用仍有效);
 *   ④ 宿主痕迹(进程是 Electron / 注册了桌面专属服务)→ 中性态 `unknown`。
 *   三条都没有 **且** 宿主没有桌面痕迹 ⇒ 才判 `BROWSER`(真浏览器页照旧武装;
 *   "把默认翻过来"会把网页端的保护一起关掉,所以补的是**正向判据**而不是翻默认)。
 *
 * 客户端另有**一票否决**(lib/close-guard-client.js `shouldArmNativeGate`):页面
 * 自己的 `navigator.userAgent` 含 Electron 或页面 URL 含 `dsh-desktop-` ⇒ 一律不
 * 武装。语义 = 宿主说"可以武装"只是"不反对",**两者都为真才武装** —— 两道独立判据
 * 互为兜底(壳可以把 UA 里的 Electron 段改掉,那就靠宿主侧的能力头/URL 判据)。
 *
 * 已知中性态(默认取**不武装**这一侧):动态桥 wire 通道拿不到请求对象;宿主能看出
 * 自己是 Electron 但请求没带任何请求级证据(旧版桌面壳/桌面版兼容模式的普通浏览器页)。
 * 两种都判 unknown(或浏览器页但被客户端否决)⇒ 客户端不武装原生门,退化为
 * "仅运行中横幅"。
 *
 * 探针(`installSurfaceProbe`):把每次判定的**入参与结果**按组合去重写进宿主日志,
 * 供报告人一次跑完就定位是哪条判据生效(不再互相猜)。
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

/** 请求 URL 里的桌面壳标记(外部报告那套壳的参数前缀,见文件头 ③)。 */
export const DESKTOP_URL_MARK = 'dsh-desktop-'

/** 请求 `user-agent` 里的 Electron 段(Electron 渲染页默认带;壳可改 ⇒ 只作三条之一)。 */
export const DESKTOP_UA_RE = /electron/i

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

/**
 * 大小写不敏感读一个请求头,值统一成字符串(缺失/空一律返回 '')。
 * Node 的 `req.headers` 名字已小写,但经序列化/代理的形状未必如此 ⇒ 逐键比对。
 */
function headerText(headers, name) {
  if (!headers || typeof headers !== 'object') return ''
  try {
    for (const [key, value] of Object.entries(headers)) {
      if (String(key).toLowerCase() !== name) continue
      if (typeof value === 'string') return value
      if (Array.isArray(value)) return value.filter((v) => typeof v === 'string').join(' ')
      return value === undefined || value === null ? '' : String(value)
    }
  } catch { return '' }
  return ''
}

/** 请求头里是否带 Desktop renderer 能力头(值不看内容:非空即证据)。 */
function hasDesktopRendererHeader(headers) {
  return headerText(headers, DESKTOP_RENDERER_HEADER).length > 0
}

/** 请求 `user-agent` 是否含 Electron(页面自身属性;纯 Node 宿主也读得到)。 */
export function isElectronRequest(headers) {
  return DESKTOP_UA_RE.test(headerText(headers, 'user-agent'))
}

/** 某个 URL/字符串是否带桌面壳标记(`dsh-desktop-`)。 */
export function hasDesktopUrlMark(url) {
  return typeof url === 'string' && url.includes(DESKTOP_URL_MARK)
}

/**
 * **页面标记在宿主侧真正看得见的通道 = `Referer`**(2026-09-19 实测指出):
 * 我们客户端轮询打的是 `ROUTE_BASE + '/runningState'`(**无 query**),wire 通道更是传
 * `undefined` ⇒ 第三条判据(请求 **URL** 含标记)对**生产请求**永远为假,"函数能过"不等于
 * "生产可达"。而同源 `fetch` 默认 `strict-origin-when-cross-origin` 会在 `Referer` 里带上
 * **完整页面 URL**(含 `?…&dsh-desktop-mode=…`)⇒ 那才是宿主侧真能读到页面标记的地方。
 * 两条都保留:URL 判据对外部/直连调用仍有效,Referer 判据覆盖我们自己的轮询。
 */
export function refererOf(headers) {
  return headerText(headers, 'referer') || headerText(headers, 'referrer')
}

/**
 * 判定用的**入参快照**(探针要把它写进日志,故单独成型、可单测)。
 * @returns {{header:boolean, electronUa:boolean, urlMark:boolean, desktopHost:boolean, ua:string}}
 */
export function surfaceEvidenceOf(headers, { desktopHost = false, url = '' } = {}) {
  const ua = headerText(headers, 'user-agent')
  return {
    header: hasDesktopRendererHeader(headers),
    electronUa: DESKTOP_UA_RE.test(ua),
    urlMark: hasDesktopUrlMark(url),
    refererMark: hasDesktopUrlMark(refererOf(headers)),
    desktopHost: desktopHost === true,
    // 只留前 160 字符:UA 可能很长,日志不该被它刷屏;够看清有没有 Electron 段。
    ua: ua.length > 160 ? `${ua.slice(0, 160)}…` : ua,
  }
}

/**
 * 从**请求证据 + 宿主痕迹**判定承载面(纯函数,可单测)。
 * 顺序即优先级:任一请求级证据成立 ⇒ 桌面页面(不武装);都没有才看宿主痕迹。
 * @param {object} [headers] Node `req.headers` 形状;拿不到请求对象时为 undefined。
 * @param {object} [opts] `{ desktopHost, url }`;url = 该请求的 URL(path+query)。
 * @returns {'desktop-renderer'|'browser'|'unknown'}
 */
export function pageSurfaceOf(headers, { desktopHost = false, url = '' } = {}) {
  if (hasDesktopRendererHeader(headers)) return PAGE_SURFACE.DESKTOP_RENDERER
  if (isElectronRequest(headers)) return PAGE_SURFACE.DESKTOP_RENDERER
  if (hasDesktopUrlMark(url)) return PAGE_SURFACE.DESKTOP_RENDERER
  // 页面标记的生产通道(见 refererOf 注释):我们自己的轮询 URL 无 query,标记只在 Referer 里。
  if (hasDesktopUrlMark(refererOf(headers))) return PAGE_SURFACE.DESKTOP_RENDERER
  // 无任何请求级证据。能看出宿主是 Electron ⇒ 中性态(可能是旧版桌面壳没挂头,也可能是
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
 * 判定 + 入参快照(权威入口;`guardSurfaceOf` 与探针都用它)。
 * @returns {{surface:string, quitVeto:boolean|null, evidence:object}}
 */
export function surfaceDecisionOf(ctx, headers, url) {
  const desktopHost = desktopHostEvidence(ctx)
  const evidence = surfaceEvidenceOf(headers, { desktopHost, url })
  const surface = pageSurfaceOf(headers, { desktopHost, url })
  return { surface, quitVeto: quitVetoFor(surface), evidence }
}

// ── 承载面探针(2026-09-18 第二轮:让报告人一次跑完就定位判据)────────────────────
let surfaceProbeLog = null
const surfaceProbeSeen = new Map()

/**
 * 装上承载面探针。**按"入参组合"去重**:同一组合只打印第一次(客户端每 5s 轮询一次,
 * 不去重会把日志刷爆)。
 *
 * 组合空间是**有界的**:判定只看四个布尔(能力头 / UA-Electron / URL 标记 / 宿主桌面
 * 痕迹)⇒ 最多 16 种组合,故"不刷屏"是结构性的(组合空间有界),不需要额外的条数上限
 * (那种写法会有死代码 / 写错风险)。
 * @param {(line:string)=>void} log 宿主日志函数(`ctx.logger.info` 那一层)。
 */
export function installSurfaceProbe(log) {
  surfaceProbeLog = typeof log === 'function' ? log : null
  surfaceProbeSeen.clear()
  if (surfaceProbeLog) {
    surfaceProbeLog(
      'retrace-close-guard: 承载面探针已启用(按入参组合去重,组合最多 16 种)。判据 = ①能力头 ' +
      `${DESKTOP_RENDERER_HEADER} ②请求 UA 含 Electron ③请求 URL **或 Referer** 含 ${DESKTOP_URL_MARK}` +
      '(页面标记在宿主侧真正可见的通道是 Referer —— 我们自己的轮询 URL 无 query) ④宿主桌面痕迹(→unknown)。' +
      '任一请求级判据成立 ⇒ surface=desktop-renderer / quitVeto=false(客户端不武装原生门)。',
    )
  }
}

/** 卸下探针(dispose/测试用)。 */
export function uninstallSurfaceProbe() {
  surfaceProbeLog = null
  surfaceProbeSeen.clear()
}

/** 探针状态(测试用:证明"同组合只一次")。 */
export function surfaceProbeState() {
  return { installed: surfaceProbeLog !== null, combos: surfaceProbeSeen.size }
}

/** 按组合去重地把一次判定写进宿主日志。 */
function reportSurfaceDecision({ surface, quitVeto, evidence }) {
  if (!surfaceProbeLog) return
  const key = [
    surface, quitVeto === null ? 'null' : String(quitVeto),
    evidence.header ? 'H' : '-', evidence.electronUa ? 'U' : '-',
    evidence.urlMark ? 'R' : '-', evidence.refererMark ? 'F' : '-', evidence.desktopHost ? 'D' : '-',
  ].join('|')
  const times = surfaceProbeSeen.get(key) ?? 0
  surfaceProbeSeen.set(key, times + 1)
  if (times > 0) return
  const yn = (value) => (value ? '有' : '无')
  surfaceProbeLog(
    `retrace-close-guard: 承载面判定 surface=${surface} quitVeto=${quitVeto === null ? 'null' : quitVeto} ｜ 入参 ` +
    `能力头=${yn(evidence.header)} 请求UA-Electron=${yn(evidence.electronUa)} URL标记=${yn(evidence.urlMark)} ` +
    `Referer标记=${yn(evidence.refererMark)} 宿主桌面痕迹=${yn(evidence.desktopHost)} ｜ UA="${evidence.ua}"`,
  )
}

/**
 * 给 runningState 载荷用的承载面描述(宿主面**唯一的**判定入口)。
 * @param {object} ctx - cordis ctx(用于看宿主痕迹)。
 * @param {object} [headers] - 发起该请求的 `req.headers`;wire/harness 通道传 undefined。
 * @param {string} [url] - 发起该请求的 URL(path+query);wire/harness 通道传 undefined。
 * @returns {{ surface:string, quitVeto:boolean|null }}
 */
export function guardSurfaceOf(ctx, headers, url) {
  const decision = surfaceDecisionOf(ctx, headers, url)
  reportSurfaceDecision(decision)
  // 客户端自绘确认门的事件回执搭在同一条请求上(无 closeGuardEvent 参数时无动作)。
  reportClientGateEvent(url)
  return { surface: decision.surface, quitVeto: decision.quitVeto }
}

/**
 * 挂载"关闭前强提示":插件 dispose(应用退出/重载)时,若有运行中会话 → 中文提示
 * 列出每个会话与原因(agent-running/queued/jobs/unclosed-turn)。只提示不中断。
 * @returns 清理函数(调用方在 dispose 里执行)。
 */
export function attachCloseGuard(ctx, log = () => {}) {
  // 客户端自绘确认门的日志落点(见下方 reportClientGateEvent):装配期装上、dispose 撤销。
  installClientGateLog(log)
  return () => {
    uninstallClientGateLog()
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

// ── 客户端自绘确认门的事件回执(2026-09-19)─────────────────────
//
// 页面侧(close-guard-client.js)在拦截/放行/失败时上报一条事件。**通道** = 既有
// `GET /api/plugins/retrace/runningState?closeGuardEvent=…`(host 侧唯一既有的
// client→host HTTP 面;新增独立路由会与既有前缀路由的优先级打架,故不新造通道)。
// 不许静默:拦截/放行/失败都要能在宿主日志 grep 到;**每处去重**(按
// 事件+承载面+运行中数目一次),客户端 5s 轮询不受影响(无参数 = 无动作)。
export const CLIENT_GATE_EVENT_PARAM = 'closeGuardEvent'

let clientGateLog = null
const clientGateSeen = new Set()

/** 装上事件日志落点(装配期调用;可重复调用 = 重置去重表)。 */
export function installClientGateLog(log) {
  clientGateLog = typeof log === 'function' ? log : null
  clientGateSeen.clear()
  return clientGateLog !== null
}

/** 卸下事件日志落点(dispose/测试用)。 */
export function uninstallClientGateLog() {
  clientGateLog = null
  clientGateSeen.clear()
}

/** 事件回执状态(测试用:证明"同组合只落一次")。 */
export function clientGateEventState() {
  return { installed: clientGateLog !== null, seen: clientGateSeen.size }
}

/**
 * 从一次 runningState 请求的 URL 里解析客户端确认门事件并**按组合去重**落日志。
 * @param {string} [url] 请求的 path+query;无参数/无落点时无动作。
 * @returns {string|null} 记录的组合键(仅首次),否则 null。
 */
export function reportClientGateEvent(url) {
  if (clientGateLog === null || typeof url !== 'string' || !url.includes(CLIENT_GATE_EVENT_PARAM)) return null
  let params
  try {
    params = new URL(url, 'http://retrace.local').searchParams
  } catch { return null }
  const event = params.get(CLIENT_GATE_EVENT_PARAM)
  if (!event) return null
  const surface = params.get('surface') ?? ''
  const running = params.get('running') ?? ''
  const key = `${event}|${surface}|${running}`
  if (clientGateSeen.has(key)) return null
  clientGateSeen.add(key)
  clientGateLog(`retrace-close-guard: 客户端确认门事件 event=${event} surface=${surface || '-'} running=${running || '-'}(同类仅记一次)`)
  return key
}
