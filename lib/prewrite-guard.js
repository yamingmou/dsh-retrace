/**
 * dsh-retrace — lib/prewrite-guard.js
 *
 * ★ 写前校验（pre-write validation）——8-25 会话修复事故的闭环。
 *
 * 事故（2026-08-25）第 1 轮失败就是"违约写入没被拦"：surface-replace 的
 * `sourceEventSeqs` 被清空后写盘 → 会话加载抛 `SessionPersistenceCorruptionError`；
 * 第 2 轮把 marker 改成 append → 客户端引擎崩溃（rt.js:6816）。如果写入前先校验，
 * 会话根本不会被改坏。
 *
 * 本模块把 marker 写入（撤回/编辑/重发/重新生成/恢复 追加的替换型空 assistant
 * 消息）接到 `dsh-log-contract` 的写前校验器上：`createPreWriter(...).validateAppend(...)`
 * 与离线体检共用同一套判定（S5 覆盖 / M1 引擎 / P1/P2 marker 语义 / S8 foldSurface
 * 终验），保证"体检看到的问题 = 写入前拦下的问题"。
 *
 * 设计约束：
 * - host-core 保持零 import（动态插件 realm 可运行），校验器以
 *   `hooks.validateMarker` 注入 `createEditorApi`（lib/host-core.js）；
 * - 依赖 `dsh-log-contract` 在运行时**懒加载**（`await import`）——包缺失/加载失败
 *   时守卫静默降级（仅日志），插件照常工作，绝不因守护件损坏主功能；
 * - `prewriterFactory` 可注入（测试用 fake），默认指向 `createPreWriter`；
 * - `enabled(sessionId)` 门控（默认全开）：写前校验可整体关闭（大会话的完整
 *   重放校验有秒级成本，见 DEVLOG）。
 *
 * 失败语义：任何 error 级违规 → 抛 `marker-rejected`（op 包装层转为
 * `{ ok: false, error: { code: 'marker-rejected', ... } }`），**不落盘**。
 *
 * R2（2026-08-29）：在三层契约校验**之后**追加 T1 折叠自检（token meter 配对，
 * 逐字复刻 dsh-log-contract checks.js 的 tokenMeterViolations 状态机）。T1 失败
 * **不阻断写入**（编辑必须生效），只返回 `{ t1Ok: false }` 供调用方标注/提示——
 * 让 turn-null marker 不再"静默"破坏 /compact。
 */
import { editorError } from './host-core.js'

/** R2 —— T1 折叠自检：与 dsh-token-meter/_foldEvent 及 checks.js T1 同语义。 */
export function tokenMeterFoldOk(events) {
  // 与 checks.js:372 同语义：无任何 step/start 的日志（极早期格式/简化夹具）
  // 不做配对检查——token-meter 的 step 配对兼容性未定义，避免误报。
  if (!Array.isArray(events) || !events.some((e) => e?.type === 'step/start')) return true
  let stepStart // {turn, step}
  for (const e of events) {
    if (e?.type === 'step/start') {
      if (stepStart !== undefined) return false // step 未闭合又来 step/start
      stepStart = { turn: e.data?.turn, step: e.data?.step }
    } else if (e?.type === 'step/end') {
      if (!stepStart || stepStart.turn !== e.data?.turn || stepStart.step !== e.data?.step) return false
      stepStart = undefined
    } else if (e?.type === 'assistant/message') {
      if (!stepStart || stepStart.turn !== e.data?.turn || stepStart.step !== e.data?.step) return false
    }
  }
  return true
}

/**
 * 建立 marker 写前校验器。
 * @param {object} [options]
 * @param {(line: string) => void} [options.log] 拒绝/降级时的诊断日志
 * @param {(input: {events: Array}) => { validateAppend(candidate: object): {ok: boolean, violations?: Array} }} [options.prewriterFactory]
 *   默认 `dsh-log-contract` 的 `createPreWriter`；测试注入 fake。
 * @param {(sessionId: string) => boolean} [options.enabled] 门控（默认恒 true）。
 * @returns {{ validateMarkerAppend(session, envelope): Promise<void> }}
 */
export function createMarkerGuard({ log = () => {}, prewriterFactory, enabled = () => true } = {}) {
  let factory = prewriterFactory ?? null
  return {
    /**
     * 校验"即将追加的完整事件信封"；error 级违规则抛 `marker-rejected`（不落盘）。
     * @returns {Promise<{ t1Ok: boolean }>} R2：三层契约通过后追加的 T1 折叠自检
     *   （token meter 配对）。t1Ok=false 表示该 marker 会使 /compact 失效，但编辑
     *   仍允许写入——调用方负责标注/提示（不阻断）。
     */
    async validateMarkerAppend(session, envelope) {
      if (typeof enabled === 'function' && enabled(session?.id) === false) return { t1Ok: true }
      if (factory === null) {
        try {
          factory = (await import('dsh-log-contract')).createPreWriter
        } catch (error) {
          log(`retrace: prewrite guard unavailable (dsh-log-contract not loadable): ${String(error)}`)
          factory = false // remember the failure; don't retry per write
          return { t1Ok: true }
        }
      }
      if (factory === false) return { t1Ok: true }
      let verdict
      try {
        const prewriter = factory({ events: session.events })
        verdict = prewriter.validateAppend(envelope)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw editorError('marker-rejected', `Marker pre-write validation failed: ${message}`)
      }
      if (!verdict?.ok) {
        const detail = Array.isArray(verdict?.violations)
          ? verdict.violations.map((v) => `[${v.id}/${v.severity}] ${v.message}`).join(' | ')
          : 'unknown violation'
        log(`retrace: marker write rejected by contract guard: ${detail}`)
        throw editorError('marker-rejected', `Marker write rejected by contract guard: ${detail}`)
      }
      // R2：T1 折叠自检——把候选事件并入 session.events 后跑 token-meter 配对。
      // 失败不阻断（编辑必须生效），只标注；离线用 fix --drop-turnnull 清理。
      const candidate = Array.isArray(session.events) ? session.events.slice() : []
      candidate.push(envelope)
      const t1Ok = tokenMeterFoldOk(candidate)
      if (!t1Ok) {
        log(`retrace: marker will break /compact for session ${session.id} (T1 fold failed) — recorded markerT1Broken; offline clean: dsh-log-contract fix --drop-turnnull`)
      }
      return { t1Ok }
    },
  }
}
