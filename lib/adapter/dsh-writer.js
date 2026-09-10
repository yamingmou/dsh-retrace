/**
 * dsh-retrace — lib/adapter/dsh-writer.js
 *
 * DSH 平台的「遮蔽写入器」（ReplaceWriter 的 DSH 实现）——把业务意图
 * 「遮蔽这些消息」翻译成 DSH 事件形状。
 *
 * 抽象设计（工程-生产级运行时/编辑撤销分支跳过-消息列表投影抽象-设计-20260902.md）：
 * 编辑/撤销/分支/跳过 = 通用消息列表投影操作，业务层只表达「遮蔽 roundRange」。
 * **DSH 翻译成本全部隔离在本文件**：
 * - 官方 token-meter 要求 assistant/message 必须有打开的 step（T1）→
 *   marker 必须落在合法 turn/step 位置（三情形）：
 *   ① 有打开的 step（回合中）→ 携带该 step 的 turn/step；
 *   ② 无打开 step 但有打开着的 turn（回合内 step 间隙，5e551001 现场）
 *      → 该 turn 号 + 新 step 号（文件全量 max + 1，绕开窗口化内存）；
 *   ③ 无打开 turn（真轮次间）→ 完整 turn 信封 + 推进 agent-loop lastTurn
 *      （防重发/下一条消息复用同一 turn 号 = duplicate start）；
 * - 客户端渲染层（复盘 2026-09-02）：任何 step/marker 不得写 turn:null
 *   （D8 白屏死循环）、同 turn 内 step 不得复用（step key 冲突白屏）——
 *   T3/T4 检测规则见 dsh-log-contract。
 *
 * host-core 零 import（动态插件 realm 可运行），本文件被 index.js 引用，
 * 依赖方向 adapter → host-core（安全）；host-core 通过 hooks.writeMarker
 * 注入本 writer，不反向 import。
 */
import { editorError, editorId, lastModelSource } from '../host-core.js'
// issue-229 第 3 项(契约运行时化):跨层边界校验——业务层传入的 span 与写出的
// marker 都必须在边界处形状合规(违规 → 指名道姓的 contract-violation,而不是
// 写出"表面成功、重放时对不上"的 marker)。
import { assertSpanShape, assertMarkerShape } from './contract.js'
// 零 import 链（host-core 零 import）：本文件可被 generate-dynamic.mjs inline 进
// dynamic-host（动态插件 realm 不能 import）。文件全量的 step 号（readMaxStep）
// 由装配者注入；本文件自带内存 maxStepInTurn 兜底。

/**
 * 创建 DSH 遮蔽写入器。
 * @param {object} deps
 * @param {object} deps.agents      — agent 注册表（agents.get，情形③计数器推进）。
 * @param {Function} [deps.validateMarker] — 写前校验钩子（prewrite-guard）。
 * @param {(line: string) => void} [deps.log]
 */
export function createDshMarkerWriter({ agents, validateMarker, readMaxStep, log = () => {} } = {}) {
  return {
    /**
     * 写入一个「遮蔽 marker」：业务意图（遮蔽 span）翻译成 DSH 事件形状。
     * @param {object} session - DSH Session 实例。
     * @param {{start:number, end:number, shadowedSeqs:number[]}} span - 遮蔽范围（业务层算好）。
     * @param {{op:string, targetSeq:number, originalText:string}} meta - 业务元数据。
     * @returns {Promise<object>} markerEvent（调用方读取 seq/editor 等）。
     */
    async writeMarker(session, span, meta) {
      // 契约边界(issue-229 第 3 项):业务层 → 适配器。span 不合规(空/倒置/非连续段)
      // 在这里立刻报错,不进三情形翻译——否则会写出 surfaceOp 与 sourceEventSeqs
      // 不一致的 marker(会话面上的遮蔽范围与日志记录分叉,历史上正是这类不一致
      // 导致加载失败/编辑死锁)。
      assertSpanShape(span, 'dshAdapter.writeMarker.span')
      const op = String(meta?.op ?? '')
      const targetSeq = Number(meta?.targetSeq)
      const model = lastModelSource(session)
      if (!model) {
        throw editorError(
          'no-model-header',
          'This session has no model header yet; send at least one message before recalling or editing.',
        )
      }
      const marker = {
        id: editorId(op),
        role: 'assistant',
        content: [],
        source: { kind: 'model', provider: model.provider, model: model.model },
      }
      // ── 三情形 turn/step 赋值（DSH 翻译核心，见文件头注释）──
      const openStep = findOpenStep(session)
      const openTurn = openStep === null ? findOpenTurn(session) : null
      let markerTurn
      let markerStep
      let wrappedBefore = [] // marker 前的包裹事件（turn/start、step/start）
      let wrappedAfter = [] // marker 后的包裹事件（step/end、turn/end）
      if (openStep) {
        markerTurn = openStep.turn
        markerStep = openStep.step
      } else if (openTurn) {
        markerTurn = openTurn.turn
        // 情形② step 号 = **max(内存, 文件) + 1**（独立审查 2026-09-02 处置）：
        // - 内存 maxStepInTurn 覆盖本进程刚写的 marker（文件 flush 滞后时文件
        //   读不到——同一打开 turn 内连续两次情形② 若只信文件会取到同一 step
        //   → step key 冲突白屏）；
        // - 文件全量 readMaxStep 覆盖窗口外既有 step（host 窗口化内存不可信，
        //   算小会与窗口外冲突，复盘 2026-09-02 §五）；
        // 两者取大 = 双向覆盖。readMaxStep 由装配者注入（index.js 从文件全量算），
        // 动态路径（dynamic-host inline）未注入时仅内存覆盖（窗口外风险已文档化）。
        let maxStep = maxStepInTurn(session, openTurn.turn)
        if (typeof readMaxStep === 'function') {
          const fromFile = await readMaxStep(session.id, openTurn.turn)
          if (typeof fromFile === 'number' && Number.isSafeInteger(fromFile) && fromFile > maxStep) maxStep = fromFile
        }
        markerStep = maxStep + 1
        wrappedBefore = [{ type: 'step/start', data: { turn: markerTurn, step: markerStep } }]
        wrappedAfter = [{ type: 'step/end', data: { turn: markerTurn, step: markerStep } }]
      } else {
        markerTurn = nextTurnOf(session)
        markerStep = 1
        wrappedBefore = [
          { type: 'turn/start', data: { turn: markerTurn } },
          { type: 'step/start', data: { turn: markerTurn, step: 1 } },
        ]
        wrappedAfter = [
          { type: 'step/end', data: { turn: markerTurn, step: 1 } },
          // 官方契约（逐字镜像 dsh-agent-loop/lib/index.js:620）：turn/end 必须带
          // reason.kind（completed|max-tokens|blocked|aborted|error|interrupted）——
          // 缺失 = malformed → 官方 validation 拒绝 → 会话加载失败（5e551005 事故，
          // 维护线 tools/validate.mjs 固化）。我们的信封 turn 立即完整关闭 →
          // kind: 'completed'（与 agent-loop 正常完成一致）。
          { type: 'turn/end', data: { turn: markerTurn, reason: { kind: 'completed' } } },
        ]
      }
      const data = {
        turn: markerTurn,
        step: markerStep,
        message: marker,
        editor: {
          targetSeq,
          text: typeof meta?.originalText === 'string' ? meta.originalText.slice(0, 2000) : '',
        },
      }
      const surfaceOp = { op: 'replace', start: span.start, end: span.end }
      const sourceEventSeqs = Array.isArray(span.shadowedSeqs) ? span.shadowedSeqs.slice() : []
      // 2026-09-01：把遮蔽 seq 冗余进 data.shadowedSeqs——部分客户端事件管道会剥离
      // event 顶层 sourceEventSeqs（0.4.12 实测：撤回/编辑后消息不隐藏 = client 拿不到
      // shadowedSeqs）。data 里的字段随事件体持久化，client 读 data 更稳（fallback 顶层）。
      data.shadowedSeqs = sourceEventSeqs
      // 包裹事件**先于校验构建**（校验与落盘共用同一组事件），校验钩子拿到完整序列
      // （wrappedBefore + envelope + wrappedAfter）做 T1 自检——消除"自检只见裸信封 →
      // 恒报 markerT1Broken"的误报（0.4.12-0.4.16 每次轮次间编辑刷 31 行日志的根因）。
      if (typeof validateMarker === 'function') {
        const result = await validateMarker(
          session,
          { type: 'assistant/message', data, surfaceOp, sourceEventSeqs },
          { wrappedBefore, wrappedAfter },
        )
        if (result && result.t1Ok === false) {
          // 理论上三情形信封后 T1 恒通过；残留 fallback 标注（防御）。
          data.editor.markerT1Broken = true
        }
      }
      for (const w of wrappedBefore) session.append(w.type, w.data)
      const markerEvent = session.append('assistant/message', data, { surfaceOp, sourceEventSeqs })
      // 契约边界:适配器 → 业务层(出口自检)。marker 形状与业务层下游假设
      // (seq/editor/surfaceOp↔sourceEventSeqs)不一致时立刻暴露,不留给读侧。
      assertMarkerShape(markerEvent, 'dshAdapter.writeMarker.marker')
      for (const w of wrappedAfter) session.append(w.type, w.data)
      // 情形③：我们消费了 nextTurn（信封里的 turn/start），把 agent-loop 的 lastTurn
      // 推进到该 turn——重发/下一条消息才落到 nextTurn+1，不会复用（防 duplicate start）。
      if (wrappedBefore.length >= 2) {
        const agent = agents?.get?.(session.id)
        advanceLoopTurn(agent, markerTurn, log)
      }
      return markerEvent
    },
  }
}

/**
 * 找当前打开的 step（最近一次未闭合的 step/start 的 turn/step）。
 * 扫描 session.events：step/start 开、step/end 关；末尾仍开即返回。
 * 无打开 step 返回 null（轮次间编辑）。
 */
export function findOpenStep(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  let open = null
  for (const event of events) {
    if (event?.type === 'step/start') {
      open = { turn: event.data?.turn, step: event.data?.step }
    } else if (event?.type === 'step/end') {
      open = null
    }
  }
  return open
}

/**
 * 找当前打开着的 turn（最近一次 turn/start 无配对 turn/end）。
 * 扫描 session.events：turn/start 开、turn/end 关；末尾仍开即返回。
 * 无打开 turn 返回 null（真轮次间，情形③）。
 */
export function findOpenTurn(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  let open = null
  for (const event of events) {
    if (event?.type === 'turn/start') {
      open = { turn: event.data?.turn }
    } else if (event?.type === 'turn/end') {
      open = null
    }
  }
  return open
}

/** 某 turn 内已出现的最大 step 号（无 step 返回 0）。内存扫描（窗口化不可信时用文件版）。 */
export function maxStepInTurn(session, turn) {
  const events = Array.isArray(session?.events) ? session.events : []
  let max = 0
  for (const event of events) {
    if (event?.data?.turn !== turn) continue
    const step = event?.data?.step
    if (typeof step === 'number' && Number.isSafeInteger(step) && step > max) max = step
  }
  return max
}

/**
 * 下一个 turn 号：scan 最大 turn（turn/start、step/start、assistant/message、user/message
 * 的 data.turn 中取最大）+1。无任何 turn 时从 1 起。
 */
export function nextTurnOf(session) {
  const events = Array.isArray(session?.events) ? session.events : []
  let max = 0
  for (const event of events) {
    const t = event?.data?.turn
    if (typeof t === 'number' && Number.isSafeInteger(t) && t > max) max = t
  }
  return max + 1
}

/**
 * 推进 agent-loop 的 turn 计数器（情形③专用）。
 * 仅在 loop 处于 idle 且 lastTurn+1 === consumedTurn 时推进——守卫防误伤
 * （loop 已推进/文件被外部改号时跳过；信封的 turn/start 已让文件 max turn 前移，
 * 跨重启自愈，这里只补同一 loop 实例的内存计数器）。
 */
function advanceLoopTurn(agent, consumedTurn, log = () => {}) {
  if (!agent || typeof agent !== 'object') return
  const phase = agent.phase
  if (!phase || phase.kind !== 'idle') {
    log(`retrace: advanceLoopTurn skipped — agent not idle (${phase?.kind ?? 'no-phase'})`)
    return
  }
  if (!Number.isSafeInteger(phase.lastTurn) || phase.lastTurn + 1 !== consumedTurn) {
    log(`retrace: advanceLoopTurn skipped — lastTurn ${phase?.lastTurn} +1 !== consumed ${consumedTurn}`)
    return
  }
  phase.lastTurn = consumedTurn
}
