/**
 * dsh-retrace — lib/prewrite-guard.js
 *
 * ★ 写前校验（pre-write validation）——为会话写入故障而立。
 *
 * 故障现场：第 1 轮失败就是"违约写入没被拦"：surface-replace 的
 * `sourceEventSeqs` 被清空后写盘 → 会话加载抛 `SessionPersistenceCorruptionError`；
 * 第 2 轮把 marker 改成 append → 客户端引擎崩溃（rt.js:6816）。如果写入前先校验，
 * 会话根本不会被改坏。
 *
 * 本模块把 marker 写入（撤回/编辑/重发/重新生成/恢复追加的替换型空 assistant
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
 *   重放校验有秒级成本，见开发日志）。
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
 * 回档幅度阈值（快照点守卫，修复）。
 *
 * 业务语义（生产级运行保障）：
 * - 一次编辑/撤回/重发遮蔽的 surface 节点占比 > 本阈值 = **回档请求**——
 *   等于把生产基线大幅改写 → 拒绝落盘，引导从快照点创建官方分支；
 * - 与 client 侧 SHADOW_SAFETY_RATIO（0.4）同源：UI 降级判定与写前拦截共用同一阈值；
 * - 阈值可通过 createMarkerGuard({ rollbackRatio }) 覆盖（测试/未来配置）。
 */
export function __normalizeReplaceForV3(ev, opts = {}) {
  // 更正（撤回/编辑被 [S1]/[S8] 拒的真因）:
  //   现行运行时(v3) 的 foldSurface **要求** `system/message` 携带 surfaceOp
  //   ([S1] surface 候选类型 "system/message" 必须携带 surfaceOp 标记)。
  //   此前无条件剥掉 ⇒ 我们自己造成每次编辑/撤回被拒 ⇒ **默认改为不剥**；
  //   仅当显式要求（v4/alpha 路径，或 env DSH_RETRACE_STRIP_HEAD_SURFACEOP=1）才剥。
  const stripHead = opts.stripProtectedHeadSurfaceOp === true || process.env.DSH_RETRACE_STRIP_HEAD_SURFACEOP === '1'
  if (ev?.type === 'system/message' && stripHead) {
    const d = ev?.data
    if (d && typeof d === 'object' && 'surfaceOp' in d) { const { surfaceOp: _drop, ...rest } = d; return { ...ev, data: rest } }
    if ('surfaceOp' in (ev ?? {})) { const { surfaceOp: _drop2, ...rest } = ev; return rest }
    return ev
  }
  const so = ev?.data?.surfaceOp ?? ev?.surfaceOp
  if (so && typeof so === 'object' && so.op === 'replace' && so.startSeq === undefined) {
    const num = (x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x)
    const a = num(so.start), b = num(so.end)
    if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= 0) {
      const fixed = { op: 'replace', startSeq: a, endSeq: b }
      return ev?.data?.surfaceOp ? { ...ev, data: { ...ev.data, surfaceOp: fixed } } : { ...ev, surfaceOp: fixed }
    }
  }
  return ev
}

export const ROLLBACK_RATIO = 0.4

/**
 * 回档幅度判定（重设计——不再用「占比」）：
 *
 * 现场经验：DSH 2.0.3 的 host Session 用「事件窗口」构造（官方 Session
 * constructor(log, baseSeq) 注释「complete log or loaded event window」），
 * `session.surface.nodes` 可能只是**窗口化 surface**（编辑最后一条消息时
 * 只有 ~12 节点）。用占比做分母 → 12/12 = 100% → 编辑最新消息也被误拦
 * （用户实测：长对话编辑最后一条报「遮蔽 100%」）。
 *
 * 新判定：**绝对遮蔽数**（shadowedSeqs.length，不依赖 surface 总数）——
 * - ≤ ROLLBACK_MIN_SHADOWED 节点（≈ 20 轮）：任何会话都允许编辑/撤回；
 * - > 阈值：仅当**会话足够大**（事件数 > ROLLBACK_MIN_EVENTS）才拦
 *   （该防护针对大会话的早期编辑，避免小会话误伤）。
 * 分母信号：优先用 host 全量事件数（不窗口化）。
 */
export const ROLLBACK_MIN_SURFACE = 20

/**
 * 绝对遮蔽阈值（**默认 40 → 1000**，修订，可配置）。
 * 元问题（同「谁发起」）：**官方没拦我们，是我们自己拦的** ——
 * 安全规则必须区分【谁发起】（用户主动编辑/撤回 vs 意外回档），否则会把功能的核心用法拦死
 * （我方 UI 自己写着「撤回这条消息及其后的对话」⇒ 遮蔽"其后全部"就是该语义）。
 */
export const ROLLBACK_MIN_SHADOWED = 1000

/** 环境覆盖：DSH_RETRACE_ROLLBACK_MIN_SHADOWED（缺省/非法 ⇒ 1000）。 */
export function rollbackMinShadowedOf(env = globalThis?.process?.env) {
  const v = Number(env?.DSH_RETRACE_ROLLBACK_MIN_SHADOWED)
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : ROLLBACK_MIN_SHADOWED
}

/** 极端判据：**遮蔽占比 > 0.9 且遮蔽节点 > 2000** ⇒ 才真正拦截。 */
export const ROLLBACK_EXTREME_RATIO = 0.9
export const ROLLBACK_EXTREME_NODES = 2000

/** 会话规模阈值：事件数 > 2000 才算「大会话」（短会话永不拦）。 */
export const ROLLBACK_MIN_EVENTS = 2000

/**
 * 该 marker 是否来自 rollback（restore op）——rollback 本身就是「从快照点
 * 回档」的官方机制，不应再被回档幅度守卫拦截（否则大范围回档永远不可用，
 * 且错误文案引导「打分支」而插件内无此操作 = 死路）。问题 A。
 */
export function isRestoreMarker(envelope) {
  // 两种载体形态:id 在旧形态的 data.message.id 上,在两段结构的第 2 段 data.id 上。
  const id = envelope?.data?.message?.id ?? envelope?.data?.id
  return typeof id === 'string' && id.startsWith('retrace-restore-')
}

/**
 * 回档幅度判定（返回 true = 应拦截）。
 * 不依赖窗口化 surface 总数：遮蔽绝对数 > 阈值且会话足够大才拦。
 */
export function rollbackShareOf(session, envelope, opts = {}) {
  if (!session || !envelope) return 0
  // 遮蔽节点数取载体口径(两段结构的 sourceEventSeqs 首项是审计 seq,不计入遮蔽数)。
  const shadowed = carrierShadowedSeqs(envelope).length
  if (shadowed <= 0) return 0
  const minShadowed = Number.isFinite(opts?.minShadowed) && opts.minShadowed > 0 ? opts.minShadowed : rollbackMinShadowedOf()
  if (shadowed <= minShadowed) return 0 // 遮蔽 ≤ 阈值：允许（默认 1000，可配）
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
        !isRestoreMarker(envelope) &&
        // 用户显式按 seq 的撤回/编辑豁免（公开构建同口径）。
        extra?.explicitUserTarget !== true
      ) {
        const shadowedN = carrierShadowedSeqs(envelope).length
        const share = rollbackShareOf(session, envelope, { minShadowed: rollbackMinShadowedOf() })
        const extreme = share > ROLLBACK_EXTREME_RATIO && shadowedN > ROLLBACK_EXTREME_NODES
        const explicit = extra?.explicitUserTarget === true
        if (share > 0 && !extreme) {
          // 【告警不拦】：超阈值但未达极端 ⇒ 写日志 + 继续，不抛错。
          log(`retrace: rollback guard — **告警不拦**（遮蔽 ${shadowedN} 节点 / 占比 ${share.toFixed(3)}；来源=${explicit ? '用户显式撤回或编辑' : '非显式'}；阈值 ${rollbackMinShadowedOf()}；极端线 占比>${ROLLBACK_EXTREME_RATIO} 且 >${ROLLBACK_EXTREME_NODES}）`)
        }
        if (extreme) {
          const evN = (sessionEvents(session) ?? []).length
          const surfN = Array.isArray(session?.surface?.nodes) ? session.surface.nodes.length : 0
          log(`retrace: rollback guard — **极端回档**（遮蔽 ${shadowedN} 节点 / 占比 ${share.toFixed(3)}；来源=${explicit ? '用户显式' : '非显式'}；会话 events=${evN} surface=${surfN}）`)
          // 预留"需确认"信号位（本轮不实现弹窗；错误对象带上 needsConfirm 供后续接线）。
          const err = editorError(
            'rollback-guide',
            `本次改写范围属于极端回档（遮蔽 ${shadowedN} 个对话节点，占会话 ${(share * 100).toFixed(0)}%）。` +
              `可选出路：①改用「只改这一条」缩小范围；②先新建会话再重开；③如确需原地改写，请由用户确认后重试（待接二次确认）。`,
          )
          try { err.needsConfirm = true; err.shadowed = shadowedN; err.share = share } catch { /* ignore */ }
          throw err
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
      // 期望 N` → `[S6]` → `[S8]` 三连,整次写入被拒。
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
      // 预期值由调用方在 append 前用 `nextAppendSeq` 同步复核；不一致会被指名拦下。
      const auditData = extra?.audit
      const isPair = extra?.phase === 'pair' && auditData !== undefined
      if (isPair && Number.isSafeInteger(extra?.auditSeq) && extra.auditSeq !== expectedSeq) {
        throw editorError(
          'marker-rejected',
          `Pair validation is stale: the writer planned the audit segment at seq ${extra.auditSeq} but the live log tail implies ${expectedSeq}; nothing was written — re-plan and retry.`,
        )
      }
      let verdict
      // 根因修复: prewriter 需在 try 之外可见（基线差分要在 try 之后调用 validateEdit）
      let prewriter = null
      try {
        // ★ 显式传 `header`（dsh-log-contract ≥0.3.13）。
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
        // 新底座把 system 提示词落在 surface 节点(system/message 行),
        // 而当前 dsh-session 运行时词汇表不含该类型 ⇒ 契约门 E3 拒绝我们**没写过**的这类行,
        // 导致折一直落不了盘并反复重试。修法:仅在校验副本上给这类行补 `ignorable` 标记
        // (**不动真实日志**,也不改 node_modules/dsh-log-contract)。
        // 整类放行(停止打地鼠):契约词汇表随 harness 版本漂移——本轮实测被拒类型
        // assistant/attempt 704 ｜ deliverables/presented 297 ｜ system/message 121 ｜
        // subagent/catalog 69 ｜ model/selection 19…逐个 add 追不上。
        // 改为:校验副本上**一切非本次写入的行**按 `ignorable` 处理(checks.js:53-56 的判据只要求该标记),
        // 我方写入的行(AUDIT + 待写 envelope)保持**严格校验**(门服务于"我方写出去的东西")。
        // S4:件内可能混有旧展开工具留下的 v0/v1/v2 形状 `{op:'replace',start,end}`,
        // 而闸按文件头 v3 一刀切 ⇒ 校验副本上**按行归一**为 v3 `{op:'replace',startSeq,endSeq}`。
        const normalizeReplace = (ev) => {
          // S8 防御:受保护头节点(system/message)不得承载 surfaceOp —— 宿主原文
          // "session event \"system/message\" is not surface-eligible and cannot carry surfaceOp ⇒ 会话加载会被拒"。
          // 仅在校验副本上**剥掉**该字段(真实日志与契约包不动);根治在展开侧(互操作补丁)。
          const STRIP_HEAD = extra?.stripProtectedHeadSurfaceOp === true || process.env.DSH_RETRACE_STRIP_HEAD_SURFACEOP === '1'
          if (ev?.type === 'system/message' && STRIP_HEAD) {
            const d = ev?.data
            if (d && typeof d === 'object' && 'surfaceOp' in d) {
              const { surfaceOp: _drop, ...rest } = d
              return { ...ev, data: rest }
            }
            if ('surfaceOp' in (ev ?? {})) { const { surfaceOp: _drop2, ...rest } = ev; return rest }
            return ev
          }
          const so = ev?.data?.surfaceOp ?? ev?.surfaceOp
          // S4 逐形状补齐:v0/v1/v2 形状 {op:'replace',start,end} → v3 {startSeq,endSeq};
          // 端点做非负安全整数校验(数值字符串也接受);缺失/非法则原样留给契约门判(不猜)。
          if (so && typeof so === 'object' && so.op === 'replace' && so.startSeq === undefined) {
            const num = (x) => (typeof x === 'string' && /^\d+$/.test(x) ? Number(x) : x)
            const a = num(so.start), b = num(so.end)
            if (Number.isSafeInteger(a) && Number.isSafeInteger(b) && a >= 0 && b >= 0) {
              const fixed = { op: 'replace', startSeq: a, endSeq: b }
              return ev?.data?.surfaceOp ? { ...ev, data: { ...ev.data, surfaceOp: fixed } } : { ...ev, surfaceOp: fixed }
            }
          }
          return ev
        }
        const headerVersion = Number(session?.header?.version ?? 0)
        const planMap = (ev) => (headerVersion >= 3 ? normalizeReplace(ev) : ev)
        const ownTypes = new Set([AUDIT_EVENT_TYPE, envelope?.type].filter(Boolean))
        const markIgnorable = (list) => (Array.isArray(list) ? list.map((ev) => planMap(ev && ev.ignorable !== true && !ownTypes.has(ev.type) ? { ...ev, ignorable: true } : ev)) : list)
        const plannedEvents = markIgnorable(isPair
          ? [...events, { seq: expectedSeq, type: AUDIT_EVENT_TYPE, data: auditData }]
          : events)
        prewriter = factory({ events: plannedEvents, header: session?.header ?? null })
        verdict = prewriter.validateAppend(envelope)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw editorError('marker-rejected', `Marker pre-write validation failed: ${message}`)
      }
      if (!verdict?.ok) {
        // 根因修复: **基线差分** —— 既有的日志本身就违规时，不该拿它拦住本次写入。
        //   · 基线 = 用同一契约校验"不含本次写入"的既有事件表(`prewriter.validateEdit(events)`)；
        //   · 只有"**本次写入才出现**"的违规才拒绝；"**基线本来就有**"的违规降级为警告(留痕)。
        //   依据: 2.0.15/rc.2 收紧规则后, 旧日志里的**官方历史行**(如既有 tool/result 替换)本身违规,
        //   而 loadSessionLog/宿主仍能加载它 ⇒ 拿它拦我们的写入是**错的方向**(编辑/撤回全被拦)。
        const keyOf = (v) => `${v?.id}|${v?.message}`
        let baselineKeys = new Set()
        try {
          const base = prewriter.validateEdit(events)
          if (Array.isArray(base?.violations)) baselineKeys = new Set(base.violations.map(keyOf))
        } catch { /* 基线不可用 ⇒ 不做降级(保持严格侧) */ }
        const rawAll = Array.isArray(verdict?.violations) ? verdict.violations : []
        // (按内核实测行为核对): **剔除版本漂移型误报规则 E6/E9** ——
        //   E6/E9 是照 dsh-session@0.1.5-rc.1 写的判据, 而现役内核 0.1.7-rc.2 已改:
        //   · 内核 `lib/index.js:1166` 要求 `system/message` 的 source.kind === 'system-prompt',
        //     而 dsh-log-contract@0.3.17 `lib/checks.js:145` 仍按 `kind==='plugin'` + plugin 非空判
        //     ⇒ **方向相反**: 实测同一条**真实行**(内核自己写的, source={"kind":"system-prompt"})
        //     内核 ACCEPT / E9 报违规; 真实 v3 迁移行(source=plugin) 内核 THROW / E9 放过。
        //   · 内核 `:1148` 角色表 `"tool/result": "tool"`, 而 `checks.js:125` 仍期望 `'user'` ⇒ E6。
        //   不剔除的后果: (1)刷屏(全量 E9×335/108 会话, 日志里的 5387 是含全部规则的既有行总数);
        //   (2)下面的 `id|message` 键**含 seq**, 一旦 seq 重排（键里含 seq，重排即改动既有行的身份）, 既有违规
        //   会被归入 `ours` ⇒ 以 ERROR `marker-rejected` **拒写**(编辑/撤回发不出) —— 必须堵住。
        //   ⛔ 上游 dsh-log-contract 修好(E9→system-prompt, E6→tool)后, 本块可整块删除。
        const driftRules = new Set(['E6', 'E9'])
        const drifted = rawAll.filter((v) => driftRules.has(v?.id))
        const all = rawAll.filter((v) => !driftRules.has(v?.id))
        if (drifted.length > 0) {
          log(`retrace: contract guard — 剔除 ${drifted.length} 条**内核版本漂移**误报(E6/E9; 现役内核不要求该形状, 按内核实测行为核对)`)
        }
        const preexisting = all.filter((v) => baselineKeys.has(keyOf(v)))
        const ours = all.filter((v) => !baselineKeys.has(keyOf(v)))
        if (preexisting.length > 0) {
          const sample = preexisting.slice(0, 3).map((v) => `[${v.id}] ${v.message}`).join(' | ').slice(0, 300)
          log(`retrace: contract guard — ${preexisting.length} 条**既有行**违规已降级为警告(基线差分; 2026-09-28 修订)｜示例: ${sample}`)
        }
        if (ours.length > 0) {
          const detail = ours.map((v) => `[${v.id}/${v.severity}] ${v.message}`).join(' | ')
          log(`retrace: marker write rejected by contract guard: ${detail}`)
          throw editorError('marker-rejected', `Marker write rejected by contract guard: ${detail}`)
        }
      }
      // 成功路径（恢复：上一次块替换误删了本行 ⇒ 全部用例返回 undefined）
      return { t1Ok: true }
    },
  }
}
