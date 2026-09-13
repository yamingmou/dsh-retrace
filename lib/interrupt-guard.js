/**
 * dsh-retrace · lib/interrupt-guard.js
 *
 * R4 中断轮次治理。
 *
 * 目标：退出/关闭会话前对「未闭合 turn」的会话提示用户，避免误以为任务
 * 已干净结束。
 *
 * 设计（按实现方案 §R4，铁律「先核实官方 turn 关闭路径」）：
 *   - 官方 `dsh-agent-loop/lib/index.js:620` 在 finally 块保证 `turn/end`
 *     必然写入（含 reason.kind='error' 的中断）——正常退出/中断路径不会
 *     留下未闭合 turn；
 *   - 未闭合 turn 只出现在「崩溃 / 强杀 / 断电」场景：有 turn/start 无
 *     turn/end（interrupted/aborted 是官方正常闭合，不在此列）；
 *   - 因此本守卫**只检测 + 提示，绝不自动写 turn/end**（与官方持久化竞态
 *     会引入双写；且插件不应在运行期补写持久化事件——铁律「插件内不要
 *     删除/重编号持久化事件」的同类约束）。
 *
 * 检测函数：
 *   unclosedTurns(session) → { turn, state: 'open' }[]
 *     扫描 session.events：turn/start 开、turn/end 关；尾部仍开 = 未闭合。
 */

/**
 * 扫描会话，找未闭合的轮次。
 * @param {object} session - DSH session 对象（session.events 为事件数组）。
 * @returns {Array<{turn: number, state: 'open'}>}
 *
 * ⚠️ 判定（2026-08-31 修正）：只报**真正未闭合**的轮次——有
 * turn/start 且尾部没有对应 turn/end（崩溃/强杀现场）。
 * turn/end 的 reason.kind 为 'interrupted'/'aborted' 是官方**正常闭合**
 * （用户主动中断，agent-loop finally 保证写入），archive 实测 69 会话中
 * 666 aborted + 126 interrupted 全是正常闭合、真 open 只 10 个——把它们
 * 当"未闭合"会在每次退出对 91% 会话打误导性 warning。
 */
export function unclosedTurns(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  const found = []
  let openTurn = null
  for (const event of events) {
    if (!event || typeof event !== 'object') continue
    if (event.type === 'turn/start') {
      openTurn = event.data?.turn
    } else if (event.type === 'turn/end') {
      openTurn = null
    }
  }
  // 尾部仍有未闭合 turn（崩溃/强杀现场）
  if (openTurn !== null) {
    found.push({ turn: openTurn, state: 'open' })
  }
  return found
}

/**
 * 挂载退出前提示：在插件 dispose 时对「当前 attach 且有未闭合轮次」的会话
 * 记录一条 warning（非阻断）。调用方（apply 的 ctx.effect 清理）负责在
 * 退出/重载时触发。
 *
 * 不做客户端弹窗（非阻断提示由宿主 UI 在会话内呈现——本插件只负责检测与
 * 日志；客户端时间线渲染未闭合轮次的提示属 UI 层，后续可扩展）。
 * @param {object} ctx - cordis ctx。
 * @param {(line: string) => void} log - 日志函数。
 * @param {() => Array<object>} [sessionList] - 活跃会话列表（默认 ctx.sessions）。
 */
export function attachExitWarning(ctx, log, sessionList) {
  return () => {
    const sessions = typeof sessionList === 'function' ? sessionList() : ctx?.sessions
    if (!sessions || typeof sessions !== 'object') return
    const ids = typeof sessions.keys === 'function' ? [...sessions.keys()] : Object.keys(sessions)
    for (const id of ids) {
      const session = typeof sessions.get === 'function' ? sessions.get(id) : sessions[id]
      if (!session) continue
      const unclosed = unclosedTurns(session)
      if (unclosed.length === 0) continue
      const summary = unclosed.map((u) => `turn ${u.turn} (${u.state})`).join(', ')
      log(`retrace-interrupt-guard: 会话 ${id} 存在未闭合轮次 ${summary}——中断未干净收尾，重启后可能触发旧光标回放；建议退出前先体检（dsh-log-contract check）`)
    }
  }
}

/**
 * 在给定会话上运行检测（供 CLI/测试直接调用）。
 * @param {object} session - 会话对象或 { events: [...] }。
 * @returns {Array<{turn: number, state: string}>}
 */
export function detectUnclosed(session) {
  return unclosedTurns(session)
}
