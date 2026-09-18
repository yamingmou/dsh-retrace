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
 */

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
 * @returns {boolean} 是否可以在本页武装原生 `beforeunload` 门。
 */
export function quitVetoOf(snapshot) {
  return snapshot?.quitVeto === true
}

/**
 * 关闭守卫客户端状态(纯,可单测):快照缓存 + 已放行标记。
 * 「放行」= 用户在一轮关闭手势中已选 [仍关闭];二次触发 beforeunload 时放行,
 * 超过 GUARD_ARM_TTL_MS 需重新确认(避免放行一次后永久静默)。
 */
export function createGuardStore({ now = Date.now, armTtlMs = GUARD_ARM_TTL_MS } = {}) {
  let snapshot = null
  let armedAt = 0
  return {
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
}
