/**
 * dsh-retrace · lib/close-guard-client.js
 *
 * 关闭守卫 V2 · 客户端纯逻辑层——被 lib/client.js 装配,
 * 零 DOM/零 react 依赖(可单测;client.bundle.js/dynamic-client.js 由构建内联)。
 *
 * ── 桌面端为什么不武装原生门(2026-09-18 外部 issue #1 复核后重写)────────────
 * 本文件此前把守卫的前提写成了"桌面端退出不经过页面关闭流程",并据此把守卫当纯
 * web 能力 —— **那是把没覆盖到的路径当成了结论**(本 issue 的两条根因之一;该前提
 * 只对**重启**路径 `app.relaunch(); app.exit(0)` 成立)。复核到的事实:
 *  - **退出入口随版本/平台而变**:外部报告的 DSH Desktop 0.9.0/Windows 上,托盘「退出」
 *    走的是**会**触发页面 `beforeunload` 的入口;而我们检查的 2.0.9 壳上,托盘项走
 *    `requestQuit(0)` → `generation.release()` → `window.destroy()` → `app.exit(code)`
 *    (**不**经过 `beforeunload`)。⇒ 我们**无法保证覆盖所有入口**,
 *    这正是"桌面端一律不武装"的理由(而不是"桌面端都不会触发");
 *  - DSH Desktop 的 Electron 壳没有处理 `will-prevent-unload`(装好的 2.0.9
 *    `app.asar` 全文检索 0 命中;`beforeunload` 三处命中全在第三方库)⇒ Electron
 *    的默认语义 = 尊重页面否决,且不弹任何界面。于是**在会走到 beforeunload 的那类
 *    版本上**页面里的 `preventDefault()` 是静默的:否决被吞掉、界面什么都没有,用户
 *    看到的就是"退出卡住、只能强退"(现场:关掉本插件的「退出确认」即恢复正常);
 *    在 2.0.9 那类不经过它的版本上,退出本来就正常 —— 两种情况都指向同一个结论。
 * 结论(与事实一致):桌面端**不武装**原生 `beforeunload` 门;桌面端的保护由
 * **运行中横幅** + dispose 提示承担(两者都与退出路径无关)。网页端照常武装:
 * Chromium 会弹原生确认框,页面否决在那里对用户是可见的。
 *
 * 承载面由**宿主**判定、随既有 runningState 载荷下发(见 lib/close-guard.js 头注释
 * 与 `pageSurfaceOf` / `quitVetoFor`),客户端只在 `quitVeto === true` 时武装。
 * `false`(桌面 Electron 页面)与 `null`/`undefined`(中性态:wire 通道拿不到请求
 * 证据 / 旧版桌面壳)一律不武装 —— 未知取安全侧,避免再次死锁。
 *
 * ⚠️ **2026-09-18 第二轮(issue #1 复测仍卡死)**:只靠宿主那条还不够 —— 报告人那台
 * 壳**三条旧判据一条都不成立**,宿主于是回了 `surface="browser"` / `quitVeto=true`,
 * 客户端照旧武装 ⇒ 仍然退不掉(他抓到的原始回包就是
 * `{"running":[],"surface":"browser","quitVeto":true}`)。⇒ 客户端加**自己的一票否决**:
 * `navigator.userAgent` 含 Electron **或**页面 URL 含 `dsh-desktop-`
 * (报告人那套壳的查询参数前缀)⇒ **一律不武装**,不管宿主怎么说。
 * 语义 = 宿主说"可以武装"只是**不反对**,两者都为真才武装(见 `shouldArmNativeGate`)。
 * 这两条是**页面自身**的属性,不需要壳配合,故能兜住"壳什么都不给"的宿主。
 *
 * 浏览器 beforeunload 确认框文案/按钮不可自定义(Chromium 一律通用原生框)
 * ⇒ 本模块只产出语义/文案数据,选型由 client.js 装配层决定
 * (A 强拦 = 原生门 + 取消后中文明细模态;B 轻确认 = 原生一次确认)。
 *
 * 检测数据源 = host 侧 runningSessions(ctx)(lib/close-guard.js 复用):
 *   会话有 agent status=running / inbox 排队 / jobs 后台任务 / 未闭合轮 →
 *   running 清单 [{ sessionId, reasons: ['agent-running','queued-2',
 *   'unclosed-turn-1,3','jobs-1'] }];静止会话不出现在清单。
 * beforeunload 内无法 await 异步查询(host.call/fetch 都赶不上)→ client 侧
 * 轮询缓存快照(host → client 同步,见 GUARD_POLL_MS),handler 同步读缓存。
 *
 * ── 2026-09-19:桌面端把保护做回来——**自绘确认门** ──────────────
 * 上一版结论"桌面端一律不武装原生门"只封住了**依赖壳弹原生确认框**那条路(壳没有
 * will-prevent-unload 处理器 ⇒ 阻止被静默吞掉 ⇒ 退出卡死),保护也一起没了。
 * 本版把那条路的形态换掉:**拦下仍用页面 beforeunload(唯一可同步介入的原语),
 * 但"拦下之后显示什么"完全由页面自己负责** —— 立即自绘一个可点/可键盘操作的
 * 中文确认框([取消] / [仍要关闭]),不向壳要任何界面。于是:
 *   · [仍要关闭] → arm 放行标记 + 再 `window.close()` ⇒ 二次 beforeunload 直接过 = 真退;
 *   · [取消] → 只收掉确认框,页面留着;
 *   · 确认框压根没画出来/不可见 → 看门狗 GATE_WATCHDOG_MS 后**无条件放行**
 *     (宁可不拦,不许卡死);≤0 尺寸的"画了但看不见"同样按没画出来处理。
 * 覆盖边界照实:走到 beforeunload 的入口才归本门(0.9.0 一类壳会走到;2.0.9 的托盘项
 * 走 requestQuit→window.destroy→app.exit,不经过本门,由运行中横幅与 dispose 提示承担)。
 * 装配钩子受文件边界约束(client.js 归并行线):本模块的 `createGuardStore` 是 client.js
 * 唯一调用点,自绘门在那里以微任务装上(排在 client.js 自己的 beforeunload 监听之后)。
 */
import { sessionBadge } from './badge.js'

/** 轮询间隔(运行中状态快照刷新)。 */
export const GUARD_POLL_MS = 5000
/** 快照超过该时长视为「过期」(文案提示,不改变 A/B 判定——宁可多拦不放过)。 */
export const GUARD_TTL_MS = 30000
/** 「已放行」标记有效期:同一关闭手势的二次触发间隔内有效,过期需重新确认。 */
export const GUARD_ARM_TTL_MS = 30000

/** 规范化 locale:模块内文案只区分 zh / en(与 client 字典一致)。 */
export function localeOf(locale) {
  return locale === 'en' ? 'en' : 'zh'
}

/**
 * 解析单条 reason 字符串 → 结构化 { code, count, turns }。
 * host(close-guard.js)产出的 reason 形状:
 *   'agent-running' | `queued-${n}` | `unclosed-turn-${t1,t2}` | `jobs-${n}`
 * 无法识别的形状(未来 host 新增)→ { code:'other', raw }——文案兜底不崩。
 */
export function parseReason(reason) {
  const raw = typeof reason === 'string' ? reason : ''
  let match
  if (raw === 'agent-running') return { code: 'agent-running' }
  if ((match = raw.match(/^queued-(\d+)$/))) return { code: 'queued', count: Number(match[1]) }
  if ((match = raw.match(/^jobs-(\d+)$/))) return { code: 'jobs', count: Number(match[1]) }
  if ((match = raw.match(/^unclosed-turn-(.+)$/))) {
    const turns = match[1].split(',').map((t) => Number(t)).filter((t) => Number.isInteger(t))
    return { code: 'unclosed-turn', turns }
  }
  return { code: 'other', raw }
}

/** 单条 reason 的本地化描述(zh/en)。 */
export function describeReason(reason, locale = 'zh') {
  const lang = localeOf(locale)
  const r = parseReason(reason)
  switch (r.code) {
    case 'agent-running':
      return lang === 'zh' ? '正在运行' : 'agent running'
    case 'queued':
      return lang === 'zh' ? `排队待办 ${r.count} 条` : `${r.count} queued`
    case 'jobs':
      return lang === 'zh' ? `后台任务 ${r.count} 个` : `${r.count} background job${r.count === 1 ? '' : 's'}`
    case 'unclosed-turn':
      return lang === 'zh' ? `未闭合轮次 ${r.turns.join('、')}` : `unclosed turn ${r.turns.join(',')}`
    default:
      return r.raw || (lang === 'zh' ? '运行中' : 'running')
  }
}

/**
 * 单个运行中会话的一行描述。
 * @param {{sessionId:string, reasons?:string[]}} item - runningSessions 元素。
 * @param {object} [opts] - { locale, label }(label 覆盖原始 id,如会话短码)。
 */
export function sessionLine(item, { locale = 'zh', label } = {}) {
  const lang = localeOf(locale)
  const id = label || item?.sessionId || '?'
  const reasons = Array.isArray(item?.reasons) ? item.reasons : []
  const body = reasons.length > 0
    ? reasons.map((r) => describeReason(r, lang)).join('; ')
    : (lang === 'zh' ? '运行中(原因未识别)' : 'running (reason unknown)')
  return `- ${lang === 'zh' ? '会话' : 'session'} ${id}: ${body}`
}

/** 汇总运行中清单(供横幅/模态复用的纯文本行)。 */
export function runningLines(running, { locale = 'zh', labelOf } = {}) {
  const items = Array.isArray(running) ? running : []
  return items.map((item) => sessionLine(item, {
    locale,
    label: typeof labelOf === 'function' ? labelOf(item.sessionId) : undefined,
  }))
}

/**
 * 快照判定:null/缺 running 数组 → 'unknown'(未同步/宿主不支持,不打扰);
 * 有运行中 → 'running';否则 → 'idle'。TTL 只影响「过期」提示,不影响判定。
 */
export function classifySnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.running)) return 'unknown'
  return snapshot.running.length > 0 ? 'running' : 'idle'
}

/** 快照是否过期(超过 GUARD_TTL_MS 未刷新)。 */
export function isStale(snapshot, { ttlMs = GUARD_TTL_MS, now = Date.now() } = {}) {
  return !snapshot || typeof snapshot.at !== 'number' || now - snapshot.at > ttlMs
}

/**
 * A 强拦模态文案(中文,两按钮 [仍关闭] [取消])。
 * @returns {{ head:string, lines:string[], hint?:string, stale?:boolean }}
 */
export function buildRunningCopy(snapshot, { locale = 'zh', labelOf, now = Date.now(), ttlMs = GUARD_TTL_MS } = {}) {
  const lang = localeOf(locale)
  const running = Array.isArray(snapshot?.running) ? snapshot.running : []
  const count = running.length
  const head = lang === 'zh'
    ? `有 ${count} 个会话存在运行中任务,关闭将中断进度`
    : `${count} session${count === 1 ? '' : 's'} with running work — closing will interrupt progress`
  const lines = runningLines(running, { locale: lang, labelOf })
  const stale = isStale(snapshot, { ttlMs, now })
  const hint = stale
    ? (lang === 'zh' ? '(状态同步于较早时刻,可能已变化)' : '(state may be stale)')
    : undefined
  return { head, lines, hint, stale }
}

/**
 * 本页宿主是否承载 quit-veto(页面否决对用户可见):
 * 宿主在 runningState 载荷里明确回 `quitVeto === true` 才算。
 * `false`(桌面 Electron 页面:壳不处理 will-prevent-unload,否决静默)与
 * `null`/`undefined`(中性态)都返回 false —— 未知一律取**不武装**的安全侧。
 * @param {{quitVeto?:boolean|null}} [snapshot] 宿主快照。
 * @returns {boolean} 宿主是否"不反对"武装(注意:还要过客户端一票否决,见 shouldArmNativeGate)。
 */
export function quitVetoOf(snapshot) {
  return snapshot?.quitVeto === true
}

// ── 客户端一票否决(2026-09-18 第二轮,issue #1 复测仍卡死)────────────────────
/**
 * 页面 URL 里的桌面壳标记(与宿主侧 `DESKTOP_URL_MARK` 同值,但这里读的是**页面自己**
 * 的 location;外部报告那套壳的查询参数长这样:`?token=…&dsh-desktop-mode=advanced&
 * dsh-desktop-platform=…`)。
 */
export const CLIENT_DESKTOP_URL_MARK = 'dsh-desktop-'

/** 页面 `navigator.userAgent` 里的 Electron 段(Electron 渲染页默认带)。 */
export const CLIENT_DESKTOP_UA_RE = /electron/i

/**
 * 页面自身的桌面证据(纯函数,可单测):UA 含 Electron,或 URL 含桌面壳标记。
 * 为什么要有它:宿主侧的判据要壳配合(挂能力头 / 保留 UA / 带 URL 参数),
 * **页面自己能看见的两条**是最后一道 —— 壳什么都不给、宿主又判错时它兜底。
 * @param {{userAgent?:string, href?:string}} [page] 默认取本页全局环境。
 * @returns {{electronUa:boolean, urlMark:boolean, desktop:boolean}}
 */
export function clientDesktopEvidence(page = pageEnvironment()) {
  const ua = typeof page?.userAgent === 'string' ? page.userAgent : ''
  const url = typeof page?.href === 'string' ? page.href : ''
  const electronUa = CLIENT_DESKTOP_UA_RE.test(ua)
  const urlMark = url.includes(CLIENT_DESKTOP_URL_MARK)
  return { electronUa, urlMark, desktop: electronUa || urlMark }
}

/** 读本页全局环境(浏览器里 navigator/location 就是全局;取不到一律空串)。 */
export function pageEnvironment() {
  const g = globalThis
  const ua = g?.navigator?.userAgent
  const href = g?.location?.href
  return {
    userAgent: typeof ua === 'string' ? ua : '',
    href: typeof href === 'string' ? href : '',
  }
}

/**
 * **最终判据**:本页是否可以武装原生 `beforeunload` 门。
 * 语义 = 宿主说"可以武装"只是**不反对**,客户端还有**一票否决**:两道都为真才武装。
 *   ① 宿主 `quitVeto === true`(它认为这是会弹原生确认框的普通浏览器页);
 *   ② 页面自己**没有**桌面证据(UA 无 Electron 段、URL 无 `dsh-desktop-` 标记)。
 * 任一条不成立 ⇒ 不武装 ⇒ 退化为"仅运行中横幅"(桌面端保护路径,见文件头注释)。
 * @param {{quitVeto?:boolean|null}} [snapshot] 宿主快照。
 * @param {{userAgent?:string, href?:string}} [page] 页面环境(默认取本页全局)。
 */
export function shouldArmNativeGate(snapshot, page = pageEnvironment()) {
  // 载荷里若**已经**说这是桌面页(surface=desktop-renderer),那就不用再看别的了 ——
  // 客户端也读这个字段(实测:此前完全不读它,于是"自相矛盾载荷"
  // `{surface:'desktop-renderer', quitVeto:true}` + 普通浏览器页仍会被武装。
  // 当前宿主不产出这对值,但这是**廉价且直击**的一道,留着。)
  if (snapshot?.surface === 'desktop-renderer') return false
  if (!quitVetoOf(snapshot)) return false
  return !clientDesktopEvidence(page).desktop
}

/**
 * 关闭守卫客户端状态:快照缓存 + 已放行标记 + **桌面壳自绘确认门的装配钩子**。
 * 「放行」= 用户在一轮关闭手势中已选 [仍关闭];二次触发 beforeunload 时放行,
 * 超过 GUARD_ARM_TTL_MS 需重新确认(避免放行一次后永久静默)。
 *
 * 装配钩子说明(2026-09-19,文件边界约束):client.js 只调用本函数,
 * 所以桌面自绘确认门在这里以**微任务**装上 —— 微任务排在 client.js 同步注册它自己的
 * `beforeunload` 之后执行,监听顺序不变(既有回归锁仍指向 client.js 那条 handler)。
 * 无 window/document(纯 node 测试、宿主侧)时什么都不做。
 */
export function createGuardStore({ now = Date.now, armTtlMs = GUARD_ARM_TTL_MS } = {}) {
  let snapshot = null
  let armedAt = 0
  const store = {
    /** 设置最新 host 快照(runningSessions 形状 { running: [...] })。 */
    set(next) {
      snapshot = next && typeof next === 'object' ? { ...next, at: next.at ?? now() } : null
    },
    get() {
      return snapshot
    },
    /** 用户确认仍关闭 → 放行标记(二次触发有效)。 */
    arm() {
      armedAt = now()
    },
    /** 放行标记是否仍有效(未过期)。 */
    isArmed() {
      return armedAt > 0 && now() - armedAt <= armTtlMs
    },
    /** 状态重变(运行中→静止→运行中)或手动重置时清除放行。 */
    disarm() {
      armedAt = 0
    },
  }
  try {
    const win = globalThis?.window
    const doc = globalThis?.document
    if (win && doc) {
      queueMicrotask(() => {
        try {
          installDesktopGate({ win, doc, store })
        } catch { /* fail-soft:装不上 ⇒ 退回官方行为(能关) */ }
      })
    }
  } catch { /* 无全局环境:纯逻辑用法 */ }
  return store
}

// ── 桌面壳自绘确认门(2026-09-19)─────────────────────────────────
//
// 形态定案:**拦下 = 页面 `beforeunload`(唯一可在关闭瞬间同步介入的原语)**;
// **放行 = 我们自己的可点确认 UI**(不再依赖壳对 `will-prevent-unload` 的处理)。
//
// 为什么这里没有了"静默否决"的空子(0.4.29/0.4.30 卡死的根因):
//   旧形态把"阻止后弹什么"交给宿主(`returnValue` + 壳的原生确认框)。DSH Desktop 的
//   Electron 壳没有 `will-prevent-unload` 处理器 ⇒ 阻止被静默吞掉:没有界面、退不掉。
//   本形态里"阻止"只买来**一次绘制机会**:紧接着由页面自己画确认框(纯 DOM + 内联
//   样式,不依赖宿主样式表),确认框自带 [取消] 与 [仍要关闭];[仍要关闭] 会 arm 放行
//   标记并再次 `window.close()`,二次 `beforeunload` 直接通过 ⇒ 确认后**真的退**。
//   万一确认框没画出来(`visible()` 为假:注入异常 / 样式把尺寸打成 0),看门狗在
//   GATE_WATCHDOG_MS 后**无条件放行**(armed + `window.close()`)—— 宁可不拦,不许卡死。
//   ⇒ 任何一条路径上,页面都能凭自身走完"拦下 → 确认 → 退出",不依赖壳配合。
//
// 覆盖边界(照实,别把接线当生效):DSH Desktop 2.0.9 的托盘退出/⌘Q 走
//   `requestQuit → window.destroy() → app.exit()`,**不经过** `beforeunload`;那条路径
//   本门在此不介入(由运行中横幅与退出时的 dispose 提示承担)。窗口 X 走壳的 close→hide,
//   同样不经过本门。本门覆盖的是**会走到 beforeunload 的那类关闭/退出入口**(外部
//   issue #1 报告的 0.9.0 一类壳、普通浏览器页、以及任何先经过页面关闭流程的入口)。

/** 看门狗:确认框渲染后多久检查一次"是否真的可见";不可见 ⇒ 放行。 */
export const GATE_WATCHDOG_MS = 1500

/** 确认框容器 id(与 client.js 的 A 明细模态同 id:桌面壳上两者互斥出现)。 */
export const GATE_MODAL_ID = 'dsh-rt-guard-modal'

/** 放行后若窗口仍未关闭时给用户的下一步提示(渲染器不允许脚本关窗时的兜底)。 */
export const GATE_HINT_ID = 'dsh-rt-guard-toast'

/** 插件配置键与本次上报用的既有查询通道(client→host 的现成通道 = runningState 查询)。 */
const GATE_CONFIG_KEY = 'dsh-retrace:config'
const GATE_ROUTE = '/api/plugins/retrace/runningState'
const GATE_QUERY = 'closeGuardEvent'

/** 运行中会话数(纯函数,供文案/上报)。 */
export function runningCountOf(snapshot) {
  return Array.isArray(snapshot?.running) ? snapshot.running.length : 0
}

/** 关闭守卫开关(默认开):直读插件配置(装配层在 client.js,文件边界在此)。 */
export function gateEnabled(storage = globalThis?.localStorage) {
  try {
    const raw = storage?.getItem?.(GATE_CONFIG_KEY)
    if (raw === null || raw === undefined || raw === '') return true
    const parsed = JSON.parse(raw)
    return parsed?.closeGuard !== false
  } catch {
    return true // 配置读不到 = 默认开(与 client.js 的 CONFIG_DEFAULTS 一致)
  }
}

/**
 * **本次 beforeunload 该怎么处理**(纯决策,可单测):
 *   disabled / armed / 状态未知 / 无运行中 / **页面不可见** → allow;
 *   运行中 + 桌面页 + 可见 → gate;运行中 + 非桌面页 → allow(浏览器走 client.js 的原生确认门)。
 * 页面不可见排在 gate 之前:隐藏窗里没有"可点的确认框",而隐藏 renderer 的定时器会被
 * 后台节流 —— 安全不能押在看门狗上,所以隐藏时直接放行。
 * @returns {{action:'allow'|'gate', reason:string}}
 */
export function planBeforeUnload(snapshot, { armed = false, enabled = true, desktop = false, visible = true } = {}) {
  if (!enabled) return { action: 'allow', reason: 'disabled' }
  if (armed) return { action: 'allow', reason: 'armed' }
  const kind = classifySnapshot(snapshot)
  if (kind === 'unknown') return { action: 'allow', reason: 'state-unknown' }
  if (kind === 'idle') return { action: 'allow', reason: 'no-running' }
  if (visible === false) return { action: 'allow', reason: 'hidden' }
  if (!desktop) return { action: 'allow', reason: 'browser-native-gate' }
  return { action: 'gate', reason: 'running-desktop' }
}

/**
 * 把一次拦截/放行/失败**写进宿主日志**(搭 runningState 查询的 query 参数——文件边界内
 * 唯一既有的 client→host 通道;host 侧在 lib/close-guard.js `reportClientGateEvent` 按
 * 组合去重落日志)。`keepalive` 让关闭瞬间的上报也能发出;上报失败静默、不抛错。
 */
export function reportGateEvent(event, extra = {}, fetchImpl = globalThis?.fetch) {
  try {
    if (typeof fetchImpl !== 'function') return
    const params = new URLSearchParams({ [GATE_QUERY]: String(event) })
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined && value !== null && value !== '') params.set(key, String(value))
    }
    const done = fetchImpl(`${GATE_ROUTE}?${params.toString()}`, { method: 'GET', cache: 'no-store', keepalive: true })
    if (done && typeof done.catch === 'function') done.catch(() => {})
  } catch { /* 上报失败不影响拦截语义 */ }
}

/**
 * 装上桌面壳自绘确认门(幂等;返回卸载函数)。
 * 依赖注入(win/doc/store/…)便于单测;缺 window/document/store 时为空操作。
 *
 * **拦与放的顺序(2026-09-19 复核后重排,主保险不依赖定时器)**:
 *   ① 事件进来先判 `planBeforeUnload`(不可见 / 无任务 / 已放行 ⇒ 不拦,直接走官方行为);
 *   ② 决定拦之前**先同步自绘确认框并验证它真的可见**(`appendChild` 返回 + 有高度):
 *      拿不到"可点出口"就**当场**放行(根本不去 preventDefault)——"等看门狗来救"降级为
 *      最后一道,而不是主保险;慢渲染 / 注入异常这条路上不存在"无出口的阻止";
 *   ③ 确认框确实在 DOM 里且有高度,才 `preventDefault` 拦下;
 *   ④ 拦下之后才挂**次保险**:Web Worker 计时器(worker 定时器不受隐藏/遮挡页面的
 *      后台节流)复查"框还在不在"。**两类情形分开**(2026-09-19 裁定):
 *        A. 框**从未渲染成功** ⇒ 主保险当场放行(根本没 block),回执 `fail-soft-ui-not-rendered`;
 *        B. 框**渲染过、且拦下了** ⇒ UI 在就**只记"等待用户"、不自动放行**(用户看到界面
 *           还没来得及点就被放行 = 拦了没用);框被撤走/变不可见 ⇒ `fail-soft-ui-gone`,
 *           页面转隐藏 ⇒ `fail-soft-hidden`(后两者都是"用户已无出口"才放行)。
 *      拿不到 Worker(如 CSP 拒绝 blob worker)才退回主线程 `setTimeout` —— 它只承担次责。
 */
export function installDesktopGate({
  win,
  doc,
  store,
  page = pageEnvironment,
  enabled = gateEnabled,
  report = reportGateEvent,
  timers = {},
} = {}) {
  if (!win || !doc || !store || win.__dshRetraceCloseGate) return () => {}
  win.__dshRetraceCloseGate = true
  const setT = timers.setTimeout ?? win.setTimeout?.bind(win) ?? setTimeout
  const clearT = timers.clearTimeout ?? win.clearTimeout?.bind(win) ?? clearTimeout
  let modal = null
  let attempt = 0
  let secondary = null

  const labelOf = (sessionId) => {
    try {
      return sessionBadge(sessionId) || String(sessionId)
    } catch { return String(sessionId) }
  }
  const langOf = () => (String(win.navigator?.language ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh')
  const el = (tag, css, text) => {
    const node = doc.createElement(tag)
    if (css) node.style.cssText = css
    if (text !== undefined) node.textContent = text
    return node
  }
  const removeModal = () => {
    try { modal?.remove?.() } catch { /* ignore */ }
    modal = null
  }
  /** 确认框是否**真的可见**(主保险判据:拿不到几何信息一律按"不可见"处理)。 */
  const modalVisible = () => {
    try {
      if (!modal || modal.isConnected === false) return false
      const height = modal.offsetHeight
      if (typeof height === 'number') return height > 0
      const rect = modal.getBoundingClientRect?.()
      return rect === undefined ? false : rect.width > 0
    } catch { return false }
  }
  const eventExtra = (extra = {}) => ({ surface: 'desktop-renderer', ...extra })

  /**
   * 次保险计时器:优先 **Web Worker**(worker 里的定时器不随页面隐藏/遮挡被节流),
   * 拿不到 Worker 再退回主线程 `setTimeout`。
   */
  function createTimer() {
    try {
      const g = win
      const canWorker = typeof g.Worker === 'function' && typeof g.Blob === 'function' && typeof g.URL?.createObjectURL === 'function'
      if (canWorker) {
        const url = g.URL.createObjectURL(new g.Blob(['onmessage=function(e){setTimeout(function(){postMessage(1)},e.data)}'], { type: 'text/javascript' }))
        const worker = new g.Worker(url)
        let done = false
        const stop = () => {
          if (done) return
          done = true
          try { worker.terminate() } catch { /* ignore */ }
          try { g.URL.revokeObjectURL(url) } catch { /* ignore */ }
        }
        return {
          kind: 'worker',
          arm(ms, cb) {
            worker.onmessage = () => { if (done) return; stop(); cb() }
            worker.postMessage(ms)
          },
          dispose: stop,
        }
      }
    } catch { /* 无 Worker / CSP 拒绝 ⇒ 走主线程定时器 */ }
    let handle
    return {
      kind: 'timeout',
      arm(ms, cb) { handle = setT(cb, ms) },
      dispose() { try { clearT(handle) } catch { /* ignore */ } },
    }
  }

  /** 撤掉本次的次保险(计时器 + 隐藏监听)。 */
  function clearSecondary() {
    const current = secondary
    secondary = null
    if (!current) return
    try { current.timer?.dispose?.() } catch { /* ignore */ }
    try { doc.removeEventListener?.('visibilitychange', current.onHidden) } catch { /* ignore */ }
    try { doc.removeEventListener?.('keydown', current.onKeydown) } catch { /* ignore */ }
  }

  /** 放行后仍未退出时的兜底提示(渲染器不允许脚本关窗时,用户再点一次关闭即放行)。 */
  function showHint(text) {
    try {
      const tip = el('div', 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483002;background:#262626;color:#eee;border:1px solid #555;border-radius:8px;padding:6px 12px;font:12px/18px -apple-system,system-ui,sans-serif;max-width:90vw;', text)
      tip.id = GATE_HINT_ID
      tip.className = 'dsh-rt-guard-toast'
      doc.body.appendChild(tip)
      setT(() => { try { tip.remove?.() } catch { /* ignore */ } }, 8000)
    } catch { /* 提示画不出来不影响放行 */ }
  }

  /** 放行:arm 标记(二次 beforeunload 直接过)+ 关掉确认框 + 再触发一次关闭。 */
  function release(reason, id) {
    if (id !== undefined && id !== attempt) return
    attempt += 1 // 让本次的次保险失效
    clearSecondary()
    report(reason, eventExtra({ running: runningCountOf(store.get()) }))
    try { store.arm() } catch { /* ignore */ }
    removeModal()
    try { win.close?.() } catch { /* 浏览器 tab 拒绝脚本关闭时,用户再点一次关闭即放行 */ }
    // 关窗没生效(渲染器不允许脚本关窗 / 壳把关闭拦成 hide)⇒ 给用户明确的下一步。
    setT(() => showHint(reason.startsWith('fail-soft')
      ? '确认框未能显示：已按官方行为放行，请再点一次关闭'
      : '已放行：若窗口未关闭，请再点一次关闭'), 300)
  }

  /** 自绘确认框;@returns {boolean} 是否已插入且可见(主保险的判据)。 */
  function showModal(copy, lang, id) {
    const overlay = el('div', 'position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px;')
    overlay.id = GATE_MODAL_ID
    overlay.className = 'dsh-rt-guard-overlay'
    overlay.setAttribute?.('role', 'dialog')
    const box = el('div', 'background:#202020;color:#eee;border:1px solid #b8860b;border-radius:12px;max-width:min(520px,92vw);padding:14px 16px;font:13px/20px -apple-system,system-ui,sans-serif;display:flex;flex-direction:column;gap:10px;box-sizing:border-box;')
    box.className = 'dsh-rt-guard-modal'
    const title = el('div', 'font-weight:700;color:#f0c674;font-size:14px;', copy.head)
    title.className = 'dsh-rt-guard-modal-title'
    const body = el('div', 'white-space:pre-line;font:12px/19px ui-monospace,SFMono-Regular,monospace;', copy.lines.join('\n'))
    body.className = 'dsh-rt-guard-modal-lines'
    box.appendChild(title)
    box.appendChild(body)
    if (copy.hint) { const note = el('div', 'color:#aaa;font-size:11px;', copy.hint); note.className = 'dsh-rt-guard-modal-hint'; box.appendChild(note) }
    const waiting = el('div', 'color:#aaa;font-size:11px;', lang === 'zh' ? '等待你的选择（不自动关闭；Esc 等同取消）' : 'Waiting for your choice (no auto-close; Esc cancels)')
    waiting.className = 'dsh-rt-guard-modal-wait'
    box.appendChild(waiting)
    const actions = el('div', 'display:flex;justify-content:flex-end;gap:8px;')
    actions.className = 'dsh-rt-guard-modal-actions'
    const cancel = el('button', 'border:1px solid #555;background:transparent;color:#eee;border-radius:6px;padding:4px 12px;font-size:12px;line-height:20px;cursor:pointer;', lang === 'zh' ? '取消' : 'Cancel')
    cancel.type = 'button'
    cancel.className = 'dsh-rt-guard-btn'
    cancel.onclick = () => {
      if (id !== attempt) return
      attempt += 1
      clearSecondary()
      report('cancel', eventExtra())
      removeModal()
    }
    const proceed = el('button', 'border:1px solid #a33;background:#8b1f1f;color:#fff;font-weight:600;border-radius:6px;padding:4px 12px;font-size:12px;line-height:20px;cursor:pointer;', lang === 'zh' ? '仍要关闭' : 'Close anyway')
    proceed.type = 'button'
    proceed.className = 'dsh-rt-guard-btn dsh-rt-guard-btn-primary'
    proceed.onclick = () => release('release', id)
    actions.appendChild(cancel)
    actions.appendChild(proceed)
    box.appendChild(actions)
    overlay.appendChild(box)
    try {
      doc.body.appendChild(overlay)
      modal = overlay
    } catch {
      modal = null
      return false
    }
    // 键盘可达:默认焦点给 [取消](回车即留在页面),Tab 可切到 [仍要关闭]。
    try { (cancel.focus ?? proceed.focus)?.call(cancel) } catch { /* ignore */ }
    return modalVisible()
  }

  /** 次保险:worker 计时器复查"框还在不在";拦下后转隐藏也放行。 */
  function armSecondary(id) {
    clearSecondary()
    const onHidden = () => { if (doc.visibilityState === 'hidden') release('fail-soft-hidden', id) }
    // 键盘逃生:Esc 等同 [取消](确认框不自动关闭,用户要有随时退出的键)。
    const onKeydown = (event) => {
      if (event?.key !== 'Escape' || id !== attempt) return
      attempt += 1
      clearSecondary()
      report('cancel', eventExtra())
      removeModal()
    }
    const timer = createTimer()
    const state = { id, timer, onHidden, onKeydown }
    secondary = state
    try { doc.addEventListener?.('visibilitychange', onHidden) } catch { /* ignore */ }
    try { doc.addEventListener?.('keydown', onKeydown) } catch { /* ignore */ }
    timer.arm(GATE_WATCHDOG_MS, () => {
      if (id !== attempt || secondary !== state) return
      // 情形 B:确认框**渲染过**。它还在 ⇒ 只在回执里留"等待用户",**不放行**
      // (用户看到 UI 还没来得及点就被放行 = 拦了没用);它被撤走/变得不可见 ⇒
      // 用户已无出口,按"UI 消失"放行(与情形 A"从未渲染"分开记)。
      if (modalVisible()) report('waiting', eventExtra({ running: runningCountOf(store.get()) }))
      else release('fail-soft-ui-gone', id)
    })
  }

  /** 页面关闭瞬间:`beforeunload`。 */
  function onBeforeUnload(event) {
    const snapshot = store.get()
    const plan = planBeforeUnload(snapshot, {
      armed: store.isArmed?.() === true,
      enabled: enabled() === true,
      desktop: clientDesktopEvidence(page()).desktop === true,
      visible: doc.visibilityState !== 'hidden',
    })
    if (plan.action !== 'gate') {
      // 无任务 / 隐藏窗的关闭尝试也各留一行(阳性与阴性对照都能从宿主日志分辨)。
      if (plan.reason === 'no-running' || plan.reason === 'hidden') report(`allow-${plan.reason}`, eventExtra({ running: runningCountOf(snapshot) }))
      return
    }
    const id = attempt + 1
    attempt = id
    // 1) **主保险**:先自绘 + 同步验证可见;没有可点出口就当场走官方行为(不拦)。
    let shown = false
    try {
      shown = showModal(buildRunningCopy(snapshot, { locale: langOf(), labelOf }), langOf(), id) === true
    } catch { shown = false }
    if (!shown) {
      // 情形 A:**确认框从未渲染成功** ⇒ 当场放行(与"UI 已呈现、等用户"分开记)。
      removeModal()
      release('fail-soft-ui-not-rendered', id)
      return
    }
    // 2) 拦下(唯一同步原语)。此刻确认框在 DOM 里且有高度 ⇒ 用户有可点的出口。
    try { event?.preventDefault?.() } catch { /* ignore */ }
    try { if (event) event.returnValue = '' } catch { /* ignore */ }
    report('intercept', eventExtra({ running: runningCountOf(snapshot) }))
    // 3) 次保险(不承担主责):worker 计时器 + 转隐藏放行。
    armSecondary(id)
  }

  win.addEventListener('beforeunload', onBeforeUnload)
  // 装上即留一行"已就绪"标记:重启后 grep 它就能确认新客户端真的加载了(接线≠生效)。
  if (clientDesktopEvidence(page()).desktop === true) report('gate-ready', eventExtra({ running: runningCountOf(store.get()) }))
  return () => {
    clearSecondary()
    try { win.removeEventListener('beforeunload', onBeforeUnload) } catch { /* ignore */ }
    removeModal()
    try { delete win.__dshRetraceCloseGate } catch { /* ignore */ }
  }
}
