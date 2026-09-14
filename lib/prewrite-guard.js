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
 * R2 的 T1 折叠自检（token meter 配对：assistant/message 须落在打开中的 step 内）
 * 随载体改造一并作废——两段结构的第 2 段是 `user/message`，token-meter 对它没有
 * step 配对要求，自检失去对象（原实现逐字复刻 dsh-log-contract checks.js 的
 * tokenMeterViolations 状态机，已移除）。
 */
import { editorError } from './host-core.js'
import { AUDIT_EVENT_TYPE, carrierShadowedSeqs } from './marker-carrier.js'
import { nextAppendSeq, sessionEvents } from './host-compat.js'

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
 * 分母信号：优先用 host 全量事件数（不窗口化）。
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
  // 两种载体形态:id 在旧形态的 data.message.id 上,在两段结构的第 2 段 data.id 上。
  const id = envelope?.data?.message?.id ?? envelope?.data?.id
  return typeof id === 'string' && id.startsWith('retrace-restore-')
}

/**
 * 回档幅度判定（返回 true = 应拦截）。
 * 不依赖窗口化 surface 总数：遮蔽绝对数 > 阈值 且 会话足够大 才拦。
 */
export function rollbackShareOf(session, envelope) {
  if (!session || !envelope) return 0
  // 遮蔽节点数取载体口径(两段结构的 sourceEventSeqs 首项是审计 seq,不计入遮蔽数)。
  const shadowed = carrierShadowedSeqs(envelope).length
  if (shadowed <= 0) return 0
  if (shadowed <= ROLLBACK_MIN_SHADOWED) return 0 // 遮蔽 ≤ 40 节点：允许
  // 会话规模：优先 events 全量，fallback surface（窗口化也够判断「大会话」）
  const eventCount = sessionEvents(session).length
  const surfaceTotal = Array.isArray(session.surface?.nodes) ? session.surface.nodes.length : 0
  const scale = Math.max(eventCount, surfaceTotal)
  if (scale <= ROLLBACK_MIN_EVENTS) return 0 // 小会话豁免
  // 返回占比仅作日志参考（拦截判定已由绝对阈值完成）
  return shadowed / Math.max(scale, 1)
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
     * @param {object} envelope - 拟写事件信封（两段结构的第 2 段）。
     * @param {{phase?: 'pre'|'post', auditSeq?: number}} [extra] - 写入器给的阶段标记：
     *   `pre` = 两段均未落盘（只跑不依赖 seq 的业务闸 ⇒ 拒绝时零写入）；
     *   `post`/缺省 = 第 1 段已落盘、第 2 段未落盘（跑完整三层契约校验）。
     * @returns {Promise<{ t1Ok: boolean }>} 恒 `{ t1Ok: true }`（历史返回形状保留：
     *   调用方按 `result?.t1Ok === false` 判定，残留在旧装配里也不炸）。
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
      // 阶段 pre:第 1 段尚未落盘 ⇒ 契约校验器看不到审计事件（会误判
      // "sourceEventSeqs 引用更早事件"），故此阶段只跑上面的业务闸。
      if (extra?.phase === 'pre') return { t1Ok: true }
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
      // `seq` 是唯一无法提前得知的字段:信封**不得**携带伪造的追加位置。
      // `createPreWriter.validateAppend` 只在 `candidate.seq === undefined` 时按当前
      // 日志尾部赋值;带一个假 seq(历史硬编码 0)会被判 `[E2] seq 0 不连续：倒退,
      // 期望 N` → `[S6]` → `[S8]` 三连,整次写入被拒(2026-09-14 真机:期望 26033)。
      // 这里**指名道姓地**先拦:显式失败 + 可诊断原因,而不是把三连报当第一现场。
      // 合法情形(seq 恰等于追加位置)放行 —— 契约本身允许携带正确的 seq。
      const events = sessionEvents(session)
      const expectedSeq = nextAppendSeq(session)
      if (envelope !== null && typeof envelope === 'object' && Object.hasOwn(envelope, 'seq') && envelope.seq !== undefined && envelope.seq !== expectedSeq) {
        throw editorError(
          'marker-rejected',
          `Marker envelope carries seq ${String(envelope.seq)} but the live log tail implies ${expectedSeq}: the writer must OMIT seq and let the pre-writer assign the append position (fix the producer, do not relax this guard; see lib/adapter/dsh-writer.js).`,
        )
      }
      // 阶段 `pair`（写路径缺陷）：把**计划中的两段**（审计段 + 载体段）作为
      // 一个完整序列在**任何 append 之前**校验。审计事件按它将被写入的位置
      // （`expectedSeq`）合成进事件表，载体随后落在 `expectedSeq + 1`。这样"校验
      // 失败"不再可能留下已 append 的第 1 段（旧流程第 1 段先落盘、post 才拒绝 ⇒
      // 孤儿 `compaction/prune`，官方 shadow-price claim 无人消费）。
      // 预言值由调用方在 append 前用 `nextAppendSeq` 同步复核；不一致会被指名拦下。
      const auditData = extra?.audit
      const isPair = extra?.phase === 'pair' && auditData !== undefined
      if (isPair && Number.isSafeInteger(extra?.auditSeq) && extra.auditSeq !== expectedSeq) {
        throw editorError(
          'marker-rejected',
          `Pair validation is stale: the writer planned the audit segment at seq ${extra.auditSeq} but the live log tail implies ${expectedSeq}; nothing was written — re-plan and retry.`,
        )
      }
      let verdict
      try {
        // ★ 2026-09-14：显式传 `header`（dsh-log-contract ≥0.3.13）。
        //   本宿主所有会话都是 v3（磁盘文件名 `session.v3.jsonl.zstd`，首帧
        //   `{"type":"session","version":3,…}`；`Session.header.version` 由
        //   `@deepseek-ai/dsh-session` 固定戳成 `SESSION_FORMAT_VERSION`）。
        //   只传 `events` 时 0.3.13 会**按事件形状推断**版本，而推断是启发式：
        //   一份"没有 system/message、也没有任何 replace"的 v3 日志只会推出 2
        //   （`vocab.js` 的 `inferFormatVersion`：`assistant/attempt` 在 v2/v3 都有）
        //   ⇒ `normalizeReplaceOp(op, 2)` 读的是旧的 `{start,end}` 键，遇到我们写的
        //   现代 `{startSeq,endSeq}` 直接返回 null ⇒ 合法的编辑/撤回 marker 被判
        //   S4/S8 拒绝。传 `header`（= 版本单一真相，与契约自己的
        //   `preWriterFromLog` 同一写法）即在本次调用内固定版本，不再受形状影响。
        const plannedEvents = isPair
          ? [...events, { seq: expectedSeq, type: AUDIT_EVENT_TYPE, data: auditData }]
          : events
        const prewriter = factory({ events: plannedEvents, header: session?.header ?? null })
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
      return { t1Ok: true }
    },
  }
}
