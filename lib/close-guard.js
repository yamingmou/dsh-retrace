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
 */
// unclosedTurns 直接复用 interrupt-guard(该文件零 import,无环),
// 不再内联复制一份——后续 interrupt-guard 演进(如 reason 感知)自动同步。
import { unclosedTurns } from './interrupt-guard.js'

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
  const ids = typeof sessions.keys === 'function' ? [...sessions.keys()] : Object.keys(sessions)
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
