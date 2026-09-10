/**
 * dsh-retrace — lib/prewrite-guard.js
 *
 * ★ 写前校验（pre-write validation）——为 8-25 会话修复事故而立。
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

/**
 * 回档幅度阈值（快照点守卫，2026-08-31 修复）。
 *
 * 业务语义（生产级运行保障）：
 * - 一次编辑/撤回/重发遮蔽的 surface 节点占比 > 本阈值 = **回档请求**——
 *   等于把生产基线大幅改写 → 拒绝落盘，引导从快照点创建官方分支；
 * - 与 client 侧 SHADOW_SAFETY_RATIO（0.4）同源：UI 降级判定与写前拦截共用同一阈值；
 * - 阈值可通过 createMarkerGuard({ rollbackRatio }) 覆盖（测试/未来配置）。
 */
export const ROLLBACK_RATIO = 0.4

/**
 * 回档幅度判定（2026-09-01 重设计——不再用「占比」）：
 *
 * 事故复盘：DSH 2.0.3 的 host Session 用「事件窗口」构造（官方 Session
 * constructor(log, baseSeq) 注释「complete log or loaded event window」），
 * `session.surface.nodes` 可能只是**窗口化 surface**（编辑最后一条消息时
 * 只有 ~12 节点）。用占比做分母 → 12/12 = 100% → 编辑最新消息也被误拦
 * （用户实测：长对话编辑最后一条报「遮蔽 100%」）。
 *
 * 新判定：**绝对遮蔽数**（shadowedSeqs.length，不依赖 surface 总数）——
 * - ≤ ROLLBACK_MIN_SHADOWED 节点（≈ 20 轮）：任何会话都允许编辑/撤回；
 * - > 阈值：仅当**会话足够大**（事件数 > ROLLBACK_MIN_EVENTS）才拦
 *   （事故防御针对大会话的早期编辑，避免小会话误伤）。
 * 分母信号：优先用 `session.events.length`（host 全量事件数，不窗口化）。
 */
export const ROLLBACK_MIN_SURFACE = 20

/** 绝对遮蔽阈值：遮蔽 ≤ 40 个节点（≈ 20 轮）永不在任何会话拦截。 */
export const ROLLBACK_MIN_SHADOWED = 40

/** 会话规模阈值：事件数 > 2000 才算「大会话」（短会话永不拦）。 */
export const ROLLBACK_MIN_EVENTS = 2000

/**
 * 该 marker 是否来自 rollback（restore op）——rollback 本身就是「从快照点
 * 回档」的官方机制，不应再被回档幅度守卫拦截（否则大范围回档永远不可用，
 * 且错误文案引导「打分支」而插件内无此操作 = 死路）。2026-08-31 问题 A。
 */
export function isRestoreMarker(envelope) {
  const id = envelope?.data?.message?.id
  return typeof id === 'string' && id.startsWith('retrace-restore-')
}

/**
 * 回档幅度判定（返回 true = 应拦截）。
 * 不依赖窗口化 surface 总数：遮蔽绝对数 > 阈值 且 会话足够大 才拦。
 */
export function rollbackShareOf(session, envelope) {
  if (!session || !envelope) return 0
  const shadowed = Array.isArray(envelope.sourceEventSeqs) ? envelope.sourceEventSeqs.length : 0
  if (shadowed <= 0) return 0
  if (shadowed <= ROLLBACK_MIN_SHADOWED) return 0 // 遮蔽 ≤ 40 节点：允许
  // 会话规模：优先 events 全量，fallback surface（窗口化也够判断「大会话」）
  const eventCount = Array.isArray(session.events) ? session.events.length : 0
  const surfaceTotal = Array.isArray(session.surface?.nodes) ? session.surface.nodes.length : 0
  const scale = Math.max(eventCount, surfaceTotal)
  if (scale <= ROLLBACK_MIN_EVENTS) return 0 // 小会话豁免
  // 返回占比仅作日志参考（拦截判定已由绝对阈值完成）
  return shadowed / Math.max(scale, 1)
}

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
export function createMarkerGuard({ log = () => {}, prewriterFactory, enabled = () => true, rollbackRatio = ROLLBACK_RATIO } = {}) {
  let factory = prewriterFactory ?? null
  return {
    /**
     * 校验"即将追加的完整事件信封"；error 级违规则抛 `marker-rejected`（不落盘）。
     * @param {object} [extra] marker 的包裹事件序列：
     *   `extra.wrappedBefore` = marker 之前的包裹事件（turn/start、step/start），
     *   `extra.wrappedAfter` = marker 之后的包裹事件（step/end、turn/end）。
     *   校验先于落盘，包裹事件尚未写入 events —— T1 自检必须看到完整序列
     *   （before + envelope + after），否则裸信封恒报"无打开的 step"误报
     *   （0.4.12-0.4.16 刷屏根因）。
     * @returns {Promise<{ t1Ok: boolean }>} R2：三层契约通过后追加的 T1 折叠自检
     *   （token meter 配对）。t1Ok=false 表示该 marker 会使 /compact 失效，但编辑
     *   仍允许写入——调用方负责标注/提示（不阻断）。
     */
    async validateMarkerAppend(session, envelope, extra = {}) {
      if (typeof enabled === 'function' && enabled(session?.id) === false) return { t1Ok: true }
      // 快照点守卫：回档请求（遮蔽过大）
      // 拒绝落盘——生产基线不支持原地大幅改写，引导从快照点创建官方分支。
      // 在契约校验之前独立检查（业务规则，与合法性正交）；host 层强制，UI 绕过也拦。
      // 豁免：restore（rollback 回档本身合法）；判定用绝对遮蔽数（不依赖窗口化 surface）。
      if (
        envelope?.surfaceOp?.op === 'replace' &&
        Array.isArray(envelope.sourceEventSeqs) &&
        !isRestoreMarker(envelope)
      ) {
        const share = rollbackShareOf(session, envelope)
        if (share > 0) {
          const shadowed = envelope.sourceEventSeqs.length
          log(
            `retrace: rollback guard — replace shadows ${shadowed} surface nodes in a large session; refusing in-place rewrite; guide user to fork a branch from the snapshot point`,
          )
          throw editorError(
            'rollback-guide',
            `此操作将回档到较早的快照点（遮蔽 ${shadowed} 个对话节点）。生产基线不支持原地大幅改写；请从快照点创建会话分支，在新分支中继续——原会话完整保留。`,
          )
        }
      }
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
      // marker 的包裹事件序列（turn/start、step/start / step/end、turn/end）由
      // 调用方在 extra.wrappedBefore/wrappedAfter 传入（校验先于落盘，包裹事件
      // 尚未写入 events）——自检必须看到完整序列（before + envelope + after），
      // 否则裸信封恒报"无打开的 step"误报（0.4.12-0.4.16 每次轮次间编辑刷
      // "marker will break /compact" 的根因）。失败不阻断（编辑必须生效），
      // 只标注；离线用 fix --drop-turnnull 清理。
      const candidate = Array.isArray(session.events) ? session.events.slice() : []
      const before = Array.isArray(extra?.wrappedBefore) ? extra.wrappedBefore : []
      const after = Array.isArray(extra?.wrappedAfter) ? extra.wrappedAfter : []
      candidate.push(...before, envelope, ...after)
      const t1Ok = tokenMeterFoldOk(candidate)
      if (!t1Ok) {
        log(`retrace: marker will break /compact for session ${session.id} (T1 fold failed) — recorded markerT1Broken; offline clean: dsh-log-contract fix --drop-turnnull`)
      }
      return { t1Ok }
    },
  }
}
