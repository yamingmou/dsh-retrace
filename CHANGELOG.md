## [Unreleased] — 0.4.20（recall 遮蔽语义修复 + 死锁根治）

### 修复（2026-09-07 · ISSUE-20260907113201-5e551006 + 同族 ISSUE-20260902125219-bfb965e4）

**缺陷①（遮蔽只到单轮→断层）**：recall 语义 = 遮蔽目标轮及之后全部（编辑=从此处分叉，
bfb965e4 用户要求"撤回该消息之后的所有后续输入输出"）——recall 的 span mode 从 round 改
**tail**（index.js withFileSpan + host-core fallback）；tail 起点回退到目标所在**轮首**
（撤回回复连带 input，防孤立 user）。

**缺陷②（有 marker 后再撤回 → 倒置范围 → 守卫拒绝 → 死锁）**：
- 根因：`computeSpan` 用 events 顺序收集的**虚拟 nodes**（seq 递增假设），而官方 foldSurface
  的 nodes 会被 replace marker 插入破坏 seq 单调（evidence 快照实测 710693→index 442>441；
  6 个撤回场景 foldSurface 写入 throw：5 个 "start not found"（目标已被遮蔽）+ 1 个倒置）；
- 修复：`computeSpan`/`spanFromFile` 改为**官方 foldSurface 重放得真实 nodes**——span 的
  start/end 与写入端完全一致，not found/倒置不可能；目标已被遮蔽（不在 nodes）= 返回 null
  （target-shadowed 明确提示，不再死锁）；
- host-core `shadowSpanFrom` tail 同步位置段化（host 视图尽力，主路径 = spanFromFile）。

**守卫边界（预期行为）**：撤回很旧消息遮蔽 >40 节点 → 快照点守卫拒绝并引导分支
（bfb965e4"旧消息应禁撤/建议分支"的正式出口）；撤回最近轮正常放行。

**验证**：238 测试绿（+4：官方 foldSurface nodes 回归——已遮蔽 target→null / marker 后
撤回写入不抛 / tail 轮首起点 / round marker 不入轮）；evidence 快照 6 个失败场景全修；
dynamic-host 重建。

**遗留（bfb965e4 UX 部分，另列）**：recall 二次确认 + undo 路径（误点撤回保护）未实现。



### 修复（2026-09-02 · 会话短码展示 —— 用户实测"短码在列表和窗口标题没展示过"）

**根因（三层）**：① 改标题的唯一机制 store.rename 只在打开 ForkView/RetraceView
（版本/分支标签）时触发——默认对话视图/会话列表从不触发；② host 编辑时用
session.append 写标题——不更新官方 title 投影（且被自动改名覆盖）；③ 5e551005
这类新 fork 会话不在短码表（维护线 8-31 后未刷新）→ 只有 FNV 兜底（不可读）。

**修复**：
- **官方 rename pin**：host 用 `ctx.get('sessionTitle').rename(session, '[短码] 原标题')`
  ——官方语义 = 写 user source title → **永久关闭自动改名**（onUserMessage 见
  user source 不再生成）+ 标题投影立即刷新（5e551005 已 pin"项目讨论"，正是此机制）；
  替代旧的 session.append（append 不更新投影）。edit 时 ensureBadgeTitle /
  setBadgeTitle / setUserTitle / initBadgeTitles 全部走 rename pin；
- **短码实时推导**：不在短码表 → 扫全部会话 header（工作区 createdAt 序号 + 父链，
  与维护线 generate-session-codes.mjs 同规则，表的新鲜超集）——**5e551005 = member-71member-65**；
  与维护线表 103/103 一致验证；配套 dsh-log-contract 0.3.10 readSessionHeader
  （帧1 轻量读取，全量 109 会话 ≈ 30ms，懒加载缓存）；
- **启动批量 pin**：host apply 后自动批量处理驻留会话（延迟重试 + 30s 补跑），
  用户打开 DSH 侧边栏即见 `[短码] 名称`——不依赖 ForkView、不依赖先编辑；
- 短码三级：archive 表 → 实时推导 → FNV 兜底；
- 234 测试绿；desktop file: 挂载已含新代码。

## [0.4.18] — 2026-09-02 · hotfix：情形③ turn/end 补 reason.kind（5e551005 malformed）

### 修复（2026-09-02 · 5e551005 malformed turn/end —— 维护线确认 + 逐字镜像官方契约）

- 情形③完整 turn 信封的 `turn/end` 漏 `reason.kind` → 官方 validation 拒绝
  （`turn/end = { turn, reason: { kind } }`，dsh-agent-loop:620）→ 会话加载失败
  SessionPersistenceCorruptionError → **每次编辑都触发**（5e551005，维护线
  tools/validate.mjs 固化）；
- 修复：`lib/adapter/dsh-writer.js` 情形③ wrappedAfter 的 turn/end 带
  `reason: { kind: 'completed' }`（信封 turn 立即完整关闭）；dynamic-host
  regenerate；测试断言更新（信封形状 + reason.kind）；场景重演验证
  malformed 0；234 测试绿；
- 配套：dsh-log-contract 0.3.9 加 T5（turn/end reason.kind 缺失 = error，
  check + prewrite 防再犯）。

## [0.4.17] — 2026-09-02 · P1/D8 三情形治本 + 窗口化防御 + 遮蔽写入器下沉 adapter

### 重构（2026-09-02 · 抽象设计落地：遮蔽写入器下沉 adapter）

- **新增 `lib/adapter/dsh-writer.js`**：`createDshMarkerWriter`——DSH 三情形
  turn 赋值 + 完整 turn 信封 + agent-loop 计数器推进 + step 号窗口化防御全部
  隔离在 adapter（零 import 链，可 inline 进 dynamic-host）；
- **host-core 纯业务化**：op 只调 `writeMarker(session, span, {op, targetSeq,
  originalText})`（业务意图），不再感知 turn/step；DSH 几何从 host-core 删除；
- **index.js / rollback.js**：装配 writer（validateMarker + readMaxStep 文件全量）；
  **generate-dynamic.mjs**：inline dsh-writer，动态插件路径功能完整；
- 对应抽象设计：`工程-生产级运行时/编辑撤销分支跳过-消息列表投影抽象-设计-20260902.md`
  （编辑/撤销/分支/跳过 = 通用消息列表投影，DSH 翻译成本隔离 adapter）；
- 233 测试绿。

### 修复（2026-09-02 · 独立审查处置：情形② step = max(内存,文件)+1 + 死代码清理）

独立 subagent 审查（不带认知，实测 + 真实夹具）确认 3e2262a 为纯搬迁、D7/D8
不可重演、可接受上线；处置 2 个 ⚠️ 风险与附注：

- **情形② step 分配改 `max(内存, 文件) + 1`**（lib/adapter/dsh-writer.js）：
  - 内存 maxStepInTurn 覆盖**本进程连续编辑**（文件 flush 滞后时文件读不到
    刚写的 marker——同一打开 turn 内连续两次情形② 若只信文件会取同一 step →
    step key 冲突白屏）；文件全量 readMaxStep 覆盖**窗口外既有 step**（host
    窗口化内存不可信）；双向取大，两类场景实测复现已修复（T3=0）；
- **动态路径（dynamic-host inline）降级文档化**：无 readMaxStep → 仅内存覆盖，
  窗口外 step 无法感知（5e551001 同类风险，已记录；正式装配 lib/index.js 注入
  文件全量 readMaxStep）；
- **死代码清理**：http.js / index.js 的 args.readMaxStep 注入已无人消费（writer
  readMaxStep 来自装配闭包）——删除；
- **测试 +1**：连续情形② + 文件滞后回归（m1 step 3 / m2 step 4 不冲突）。
  234 测试绿。

### 修复（2026-09-02 · 情形②窗口化防御：step 号从文件全量算）

- 复盘 2026-09-02（5e551001 白屏真正根因 = step 节点 key 冲突）：情形②
  （开 turn 无 step）分配新 step 号时，host 窗口化 session.events 可能看不到
  turn 内全部 step → 算小 → 新 step 号撞上窗口外既有 step = step key 冲突白屏
  （与 5e551002 103:1 同型）；
- `adapter/dsh.js` 加 `maxStepInTurnFromFile`（从文件全量事件算 turn 内最大
  step；readEvents 拆出 readEventsFromFile 便于测试注入）；host-core 情形②
  优先用注入的 `readMaxStep` 回调（失败 fallback 内存扫描）；index.js/http.js
  注入（与 span 同源，读文件全量事实）；
- 配套：dsh-log-contract T3（step key 唯一）/ T4（turn 缺失）渲染层规则已加入
  check + prewrite（防再犯）；
- 233 测试绿（+2：readMaxStep 优先 + adapter maxStepInTurnFromFile）；
- 抽象设计落盘：`工程-生产级运行时/编辑撤销分支跳过-消息列表投影抽象-设计-20260902.md`
  （编辑/撤销/分支/跳过 = 通用消息列表投影操作，DSH 翻译成本隔离在 adapter）。

### 修复（2026-09-01 · P1/D8 治本 v3：三情形 turn 赋值 — 铁律不得写 turn:null + 消除 T1 误报刷屏）

**两代错方案复盘（重要教训）**：

| 版本 | 轮次间 marker 形状 | 后果 |
|---|---|---|
| 0.4.10-0.4.16 | 裸 step + 真实 nextTurn | **D7 同款孤儿块**：重发 turn/start 前先产生该 turn 的 update → 客户端 turn-tail 抛 `update before its start Match` → 维护线反复删（5e551010 第 4 次修复） |
| 0.4.17（已废弃） | 临时 step **turn:null** | **D8 白屏死循环**（5e551001）：客户端渲染状态机对 turn=null 无法归属任何 turn → Renderer CPU 31.8% → 白屏「载入历史」；维护线把 null→95 后恢复，用户验证 |
| **0.4.17v3（本版）** | **三情形 turn 赋值**（见下） | 五层（foldSurface/token-meter/location/turn-tail/**客户端渲染**）全绿 |

**教训**：0.4.17 的四层验证漏了**客户端渲染层**——离线契约/匹配器都过不等于客户端不死循环。维护线 `tools/validate.mjs` 已把 step 包裹/消息本体的 null-turn 判为**致命**；**任何 step/marker 事件不得写 turn:null**（铁律）。

**治本（三情形，`lib/host-core.js appendEditorMarker`）**：
- ① **有打开的 step**（回合中编辑）：marker 携带该 step 的 turn/step（不变）；
- ② **无打开 step 但有打开着的 turn**（回合内 step 间隙编辑——5e551001 现场）：
  marker 用该 turn 号 + 新 step 号（turn 内 max step + 1）→ turn/start 早已在
  marker 之前 → 无孤儿、无 null、不占新 turn 号（重发用 agent-loop 计数器，无碰撞）；
- ③ **无打开 turn**（真轮次间）：开**完整 turn 信封**（turn/start → step/start →
  marker → step/end → turn/end）用 nextTurn，并把 agent-loop 的 `lastTurn` 推进
  一位（`advanceLoopTurn`：仅 idle 且 `lastTurn+1 === consumedTurn` 时推进，守卫
  防误伤；信封的 turn/start 让文件 max turn 前移，**跨重启自愈**）——否则重发/
  下一条消息复用同一 turn 号（turn-tail `more than one start`）。

**实现**：
- `lib/host-core.js`：三情形 + `findOpenTurn`/`maxStepInTurn`/`advanceLoopTurn`；
  recall/edit/regenerate/rollback 传入 agent；
- `lib/prewrite-guard.js`：T1 自检契约改 `wrappedBefore`/`wrappedAfter`（完整序列
  before + envelope + after）——消除"自检只见裸信封 → 恒报 markerT1Broken"误报
  （0.4.12-0.4.16 每次轮次间编辑刷 31 行日志的根因）；校验先于落盘原则不变；
- `lib/rollback.js` / `lib/index.js`：传 `agents`；动态产物 `dynamic-host.js` 同步重建。

**验证**：231 测试全绿（+2：情形②开 turn+新 step / 情形③信封+推进，含 loop 计数器
推进断言）。真实会话重放：5e551001（修复前备份）case2 四层全绿；case3 合成序列
四层全绿（对照：旧孤儿形状 THROW `update-before-start`、turn:null 形状触发白屏）。

**遗留**：5e551010 旧孤儿块已被维护线清除（2026-09-01 23:32，0 marker）；5e551001
已由维护线 null→95 修复（用户验证）；本版之后编辑不再产生孤儿块/空 turn。

### 修复（2026-08-31 · 独立审查 3 项）

- **rollback 豁免**：restore marker（`retrace-restore-` 前缀）不做回档幅度拦截——
  大范围回档是官方机制，不应被守卫拒绝（错误文案引导「打分支」而插件内无此操作）；
- **短会话豁免**：surface ≤ 6 节点（≈3 轮）不做回档幅度拦截——否则 1-2 轮新会话
  编辑/撤回/重发 100% 被拒（现有功能回归）；事故防御针对大会话的早期编辑；
- **bundle 补提交**：`client.bundle.js` 重建含短码铭牌（此前漏提交，npm 发布物会缺 UI）。

### 新增（2026-08-31 · 会话短码铭牌）

- **会话短码（identity badge）**：从 session id（唯一值）确定性导出 10 位短码
  （FNV-1a 64 → base36），永不变（标题会变）。人机交互识别用，系统内部不需要。
  - `lib/badge.js`（`sessionBadge` / `uuidOf` / `fnv1a64` / `toBase36`，纯函数无状态）；
  - host 端点 `retrace.sessionBadge`（harness，agent 可查任意会话短码）；
  - ForkView 显示「会话铭牌」+ 谱系每跳短码（`[短码]` 前缀）；
  - 测试 +9（195 全绿）。

### 新增（2026-08-31 · 快照点守卫：回档幅度保护）

- **回档幅度保护（5e55100a 事故闭环，生产级运行保障）**：编辑/撤回/重发/
  恢复写入前计算遮蔽占比（`sourceEventSeqs / surface.nodes`），
  **> 40%（`ROLLBACK_RATIO`）拒绝落盘**，抛 `rollback-guide` 错误并引导
  「从快照点创建会话分支」（生产基线不支持原地大幅改写）。
  - 判定与 client 侧 `SHADOW_SAFETY_RATIO` 同源（同一阈值）；
  - host 层强制：UI 绕过也拦得住；enabled 门控可关闭；
  - 覆盖 recall / editAndResend / regenerate / rollback 全部写入路径
    （lib/index.js hooks 装配 + rollback validateMarker）；
  - `lib/prewrite-guard.js`（`ROLLBACK_RATIO` / `rollbackShareOf` /
    `createMarkerGuard({ rollbackRatio })`），测试 +9（23）。
  - 设计：`工程-生产级运行时/快照点与回档机制-设计-20260831.md`。

### 新增（2026-08-31 · R4 中断轮次治理）

- **R4 中断轮次提示**：退出/重载时检测「未闭合 turn」（有 turn/start 无
  turn/end，或 turn/end reason 为 interrupted/aborted）并记 warning。
  只检测不写事件（官方 finally 已保证 turn/end 写入；未闭合只出现在
  崩溃/强杀现场）。中断轮次在时间线天然可见（官方事件流）。
  `lib/interrupt-guard.js`，测试 +9。

## [0.4.11] — 2026-08-30 · 渲染卡死修复（ForkView/VersionsView O(N²)）

### 修复（2026-08-30 禁用验证坐实：5e551007 打开转圈、Renderer CPU 27.7%）

- **ForkView / VersionsView 窗口化渲染 O(N²) → O(1)**：`visible.map` 里
  `nodes.indexOf(node)` / `list.indexOf(record)` 在每次渲染对每个可见节点做
  线性查找——2047 节点 × ~15 可见行 = 每次渲染 ~30K 次比较，React 重渲染风暴
  → 转圈、Renderer CPU 27.7% 持续高负载。大会话（5e551007 126.9 万事件、
  forkmap 2047 节点）打开卡死，小会话不触发。
- 修复：窗口化切片带起始索引（visibleStart），渲染用 `(visibleStart + i) * ROW_H`
  直接算 top，去掉 indexOf。ForkView + VersionsView 两处同修。
- 回归测试 +2：断言源码不再出现 `top: nodes/list.indexOf(...)`，且两处都用
  索引切片（防复发）。

### 备注

- forkmap 投影 nodes 的 seq 乱序（compaction replace 插在遮蔽范围开头）是官方
  foldSurface 语义，非 bug；ForkView 不依赖有序，仅渲染顺序，无碍。
- 本版不处理「幽灵 resend 占位消息」（0.4.6 历史遗留 seed 数据，客户端渲染正常）。

## [0.4.10] — 2026-08-30 · R2 根治：轮次间编辑不再产生 turn-null marker

### 修复(刷屏事故根治 v2)

- **轮次间编辑(常态)自动开临时 step 包裹 marker**：step/start → marker(turn=nextTurn, step=1) → step/end。官方 token-meter 要求每条 assistant/message 必须有打开的 step(stepStart===void 0 即抛，dsh-token-meter :590)，turn-null 或伪造 turn/step 都过不了；临时 step 是唯一合法形态。三层验证通过(foldSurface / token-meter / 客户端 Location boundary——step/turn 事件不进 surface)。
- 0.4.7-0.4.9 只修了回合中编辑(step-context)，轮次间编辑仍写 turn:null(5e551007 实测 6 个，最新 07:27)→ 仍会刷屏压垮 host。本次根治：任何编辑都不再产生 turn-null marker。
- 配套：check 新增 T2(跨 step sourceEventSeqs)/S9(物理序单调)/I1(inbox 重放)——dsh-log-contract 0.3.5。

### 测试

- host-core/rollback/prewrite-guard 断言更新为临时 step 形态；全量 **162** 绿。

## [0.4.8] — 2026-08-30 · R2 路径二：编辑前自动停止 agent(消除跨 step 引用)

### 修复(2026-08-30 第二类刷屏事故)

- **编辑/重发/重新生成前自动停止运行中的 agent**：ensureIdle 替代 requireIdle——agent 正在响应时不再抛 agent-busy，而是自动 agent.cancel() + whenIdle() 等待其干净收尾再执行编辑。
- 为什么必要：编辑发生在 agent 还开着 step 时，DSH 的 resend 会把旧 step 的 chunk 全部引用进新 assistant/message 的 sourceEventSeqs(5e551007 seq 7000004 跨 step 7/8/9)，token-meter 抛 belongs to another step(:645)→ 同样刷屏压垮 host。
- 配套：dsh-log-contract fix --clip-crossstep(0.3.4)裁剪历史跨 step 引用。

### 测试

- +1(auto-stop 后编辑成功 / 无 cancel API 回退 agent-busy)；全量 162 绿。

## [0.4.7] — 2026-08-30 · R2 路径一：回合内编辑写合法 turn/step（刷屏事故闭环）

### 修复（2026-08-30 锁定事故闭环）

- **回合内编辑不再产生 turn-null marker**：`appendEditorMarker` 通过 `findOpenStep()` 检测当前打开的 step，marker 携带该 step 的 `turn/step`（空 content + surface replace 形态经官方 foldSurface 与 token-meter 双验证）→ **token-meter 配对通过、零 T1 违规、不再刷屏**。
- 轮次间编辑（无打开 step）回退路径不变：`turn:null` + `editor.markerT1Broken` 标注 + 客户端提示。
- 配套：`dsh-log-contract fix --neutralize`（0.3.3）原地中和历史 turn-null marker（type→`retrace/marker` + `ignorable:true`，不动 seq/行数，会话驻留安全）——已用于现场会话 5e551008 / 5e551011。

### 测试

- +5（findOpenStep 三态 / 回合内编辑携带 turn/step + t1Ok / 轮次间回退不变）；全量 **161** 绿。

## [0.4.6] — 2026-08-29 · R1 实时看门狗 + R2 marker T1 契约 + 考古 A4 谱系

### 新增（R1 · 实时看门狗，lib/watchdog.js）

- **实时看门狗**：订阅 `session/event` 跟踪活跃会话，每 10s 比较「文件尾部最后一条事件 seq」（`dsh-log-contract tailSeq`，懒加载、只解最后一帧）与「内存 session.events.length」。**只检查一个方向**：文件尾部 seq 领先内存 → 另一进程/旧光标回放在写（事故根因 1/2 的现场）→ 字节级快照到 `$DSH_HOME/dsh-retrace/snapshots/` + warning 日志 + 每会话 5 分钟防刷屏。`fileSeq <= events.length` 永不告警（本进程未 flush 是常态，防误报）。
- 卸载/热重载 dispose 干净（定时器 + 监听双清理）；`dsh-log-contract` 缺失时降级「不检查」。

### 新增（R2 · marker T1 契约，prewrite-guard.js + host-core.js + client）

- **T1 折叠自检**：写前校验（三层契约之后）追加 `tokenMeterFoldOk`——逐字复刻 checks.js T1 状态机（含「无 step/start 不检查」保护）。t1Ok=false 时**不阻断写入**（编辑必须生效），在 marker 的 `editor.markerT1Broken` 标注，recall/edit/regenerate 返回值带 `markerT1Broken`。
- **客户端提示**：markerT1Broken 时显示提示「编辑已生效；此标记会使本会话的 /compact 失效。离线清理：关闭会话后运行 dsh-log-contract fix --drop-turnnull」。
- 让 turn-null marker 从「静默破坏 /compact」变为「写入即标注 + 提示」，离线清理命令直接给出。

### 新增（考古 A4 谱系 UI，0.4.6 批）

- **会话谱系卡片**（分叉视图头部）：`seam.lineage` 沿 `header.parentSession` 追溯父链（环保护），`GET /lineage` HTTP 路由，ForkView 头部渲染 hop 链（`dsh-rt-fork-lineage-*`），i18n zh+en。
- **doctorScan**：会话内 token-meter 违规（T1）离线扫描（`/doctor`）。

### 变更

- `dsh-log-contract` 新增导出 `tailSeq`（log-reader.js）供看门狗读文件尾部 seq。

### 测试

- watchdog 6 用例（双写入验收 / 不误报 / dispose 干净 / 降级）；prewrite-guard +6（T1 判定 / 不阻断 / host-core 标注）；全量 **156** 绿。

### 修复（启动崩溃，2026-08-29 真机）

- **cordis ctx Proxy 崩溃**：watchdog 曾访问 `ctx.setInterval`/`ctx.clearInterval`/`ctx.off`——cordis 的 ctx 是 Proxy,对任何未 inject 的属性访问直接抛 `cannot get property "timer" without inject`,导致 desktop 启动时插件树加载失败(必须删除插件才能启动)。修复:定时器改用全局 `setInterval`/`clearInterval`(host-runner sandbox 会重定向),`ctx.on()` 返回的 disposer 函数替代不存在的 `ctx.off`;测试注入 `schedule`/`unschedule` 保可测性。
- desktop profile 正式把 dsh-retrace 加入 `bundles` + `dependencies`(此前仅手动塞 node_modules,删除插件后即丢失)。

## [0.4.5] — 2026-08-28 · 分叉图骨架 + 稳定性修复批

### 新增(P2.1 分叉图骨架)

- **`retrace/forkmap` 投影单元**:镜像官方 `foldSurface` 的增量折叠 + 每个 replace 边界的 `replacedSeqs`(被遮蔽的旧路径节点);不截断(分叉全貌优先);wire 精简(节点 `{seq,type}` + 边界 `{seq,kind,replacedSeqs}`);`GET /forkmap` HTTP 降级,与 versions 同双通道。
- **「分叉」视图 Tab**(`conversation.view`,order 30,与 对话/轨迹/版本 平级):脊柱 = 当前 surface 节点流,分叉边界卡片化,历史分叉点区段(链式编辑被遮蔽的边界),固定行高窗口化,节点点击跳转对话。
- **修复 0.4.2 程序化切视图静默 no-op**:跳转/轨迹按钮改为 tab-bar DOM click(与用户点击同路径),共享 `jumpToAnchor`。
- i18n:+10 键;测试 120 → **134**。

### 修复(撤回/编辑失效回归 + review 批)

- **隐藏判定回退为 per-marker**(0.4.3 union-wide guard 曾让所有 marker 降级、撤回/编辑失效):普通撤回/编辑永远隐藏;仅单次覆盖 >40% 的大范围操作降级,并显示明确提示条(历史在日志中)。
- **原输入残留修复**:`retrace-reference` 节点锚定 `seq - 0.5`(半整数),此前永不匹配 shadowedSeqs——被编辑消息隐藏后其「原输入」对照残留。现在半整数锚点映射回整数 seq 匹配;ReferenceRow/UserActionsRow 按真实消息 seq 判定。
- **被遮蔽/压缩消息隐藏操作入口**(UX):编辑/撤回/重新生成按钮在消息被遮蔽或 compaction 压缩时直接隐藏,不再点击后才报 `target-shadowed`;compaction checkpoint 作为"只判定不渲染"的 marker(sourceEventSeqs 覆盖被压缩范围)。
- **review 批**:guard 分母只计真实行(realRowCount);hide plan 快照级缓存(防重渲染风暴);跳转 loadOlder 节点计数修正(此前恒 break 只翻一页);tab 切换只计可见 tablist;conversationEvents 定义 disposer 接入 ctx.effect(防热重载重复注册崩溃);git 配置域种子对齐 gitEnabled。

### 真机验证

- 撤回/编辑恢复:历史 marker 隐藏规则 0 → 101;大范围撤回降级 + 提示。
- 原输入残留:「插件新版本 开发 (1)」visibleRefs 2 → 0(残留消失);编辑多次 refs 不增长。
- 被遮蔽消息按钮消失:rowsWithEdit 递减、全遮蔽会话 0 按钮。

## [0.4.2] — 2026-08-26 · 轨迹借力 P0(时间线迁移官方视图 Tab)

### 变更(2026-08-26 轨迹借力分析落地)

- **时间线从 header 浮层迁移为官方 `conversation.view` 视图 Tab**(「版本」,与官方「对话/轨迹」平级):视图壳、视图切换、分页复用官方机制;版本数据通道保持插件自持(`useProjection('retrace/versions')` 推送帧 + HTTP `/versions` 降级——版本是派生数据,官方事件流不携带)。
- **详情让位官方轨迹**:版本行「详情」按钮改为「轨迹台账」(`actions.setView('trajectory')`,官方事件台账含全部事件);移除自绘 JSON 详情 modal 与客户端 `GET /event` 调用(host 路由保留)。
- **跳转适配视图切换**:跳转改为 `actions.setView('chat')` → `session.loadOlder()` 循环 → rAF 轮询 `[data-chat-anchor-key]` → scrollIntoView + 高亮;流程整体在 `jump()` 内完成(视图切换会卸载本视图)。
- **范围澄清(2026-08-26 修正)**:不做的是「线性台账式消息/思考时间线」(按时间一维展开——官方轨迹已覆盖);**保留 P2「分叉图/分支拓扑展示层」**(消息/思考节点以分支/流程图呈现,旧路径 vs 新路径——官方没有任何分支可视化,是补"怎么走到这里"的差异化维度)。
- 计划调整:PLAN.md §5.1/§5.2/§9/§10 按轨迹借力结论重写。

## [0.4.1] — 2026-08-26 · 「加载更早看不到历史」事故闭环

### 修复(2026-08-26 事故,真机实锤)

- **默认配置由破坏性改为安全**:`editFromScratch` 默认 `true → false`(编辑一条消息不再回绕隐藏整个编辑点之前的会话)。`hideShadowed` 保持默认 `true`——编辑/撤回后**被替换的那一轮**照常隐藏(旧消息消失的自然编辑体验),而 40% 安全闸保证一次操作永远不可能清空大半段历史。配置带版本号(现 v3),旧配置自动迁移,仅重置这两个键,其余自定义保留。
- **超大隐藏范围自动降级**:`useHiddenKeys` 增加安全闸——单个 marker 要隐藏超过 40% 的对话行时拒绝隐藏(仅显示标记提示)。一次编辑/撤回永远不可能让大半段历史从视图中消失。
- **Host 注入补齐**:`inject` 增加 `fs` / `subprocess` / `sandboxPolicy`——修复版本与产物快照的 `ctx.fs` 未注入告警(此前快照全部 `snapshot skipped`),git 适配器在 Desktop 组合中真正可用。
- 背景:两个会话(当前对话 / 插件新版本)中 4 个 `retrace-edit-*` marker 的替换范围覆盖了整段会话(如 `[8..31868]`、`[249867..366368]`),80%/92% 的消息行被 `display:none` 隐藏,「加载更早」看起来失效;数据本身完好。

## [0.4.0] — 2026-08-26 · 时间线与产物回退

### 已实现(P0 — 版本数据服务,2026-08-21)

- **`retrace/versions` 投影单元**(官方 `ctx.sessionProjections`):撤回/编辑/重生成/恢复、compaction 检查点与其它 replace 的版本边界检测;surface 折叠与 `foldSurface` 同语义;触碰文件窗口归集(created/modified/deleted);wire view 版本列表摘要;版本上限 200(完整历史可经日志重放)。
- **内容寻址产物快照**(`$DSH_HOME/dsh-retrace/objects/<sha256[:2]>/<sha256>`,attachment-local 同款耐久写 + 完整性校验):版本边界自动快照触碰文件(工作区围栏 + 4MiB 上限 + 二进制跳过);`retrace` storageDomain 引用计数(`<versionId>:<path>` 共享去重)。
- **双通道查询**:`session/projection` 推送帧(apiproxy 自动广播)+ HTTP `GET /api/plugins/retrace/versions`(投影快照降级);`GET /event` / `GET /surface`(sessionQuery 惰性读,时间线详情用)。
- **配置生效**:设置三开关(版本与产物快照 / git 集成 / 保留上限)随请求携带(`x-retrace-config`),Host 以请求为准;关闭"版本与产物快照"时行为退化为纯 L1(仅上下文回退,不记录版本、不追踪产物)。
- 设置 → 通用三个开关 UI 此前已落地,本次接入 Host 消费。

### 已实现(P1 — 时间线与产物回退,2026-08-25)

- **时间线浮层面板**:会话 header 新增「时间线」入口;版本列表走 `session/projection` 推送帧(零轮询)+ HTTP `/versions` 降级;每个版本显示类型图标/时间/消息数/文件变更徽标/摘要;详情抽屉惰性加载事件原文(`GET /event`);大列表固定行高窗口化渲染。
- **产物回退**:每个版本支持 仅对话 / 仅产物 / 两者 三种范围;先干跑预览(将移除 N 条消息 + 影响文件清单与动作)→ 确认后执行;git 优先(commit-free checkout 清单路径)+ 内容寻址快照兜底(CAS 防覆盖手动编辑)+ 删除文件护栏;回退本身记录为新版本(kind=restore),可再回退。
- **跳转对话**:时间线节点一键跳转到对话对应位置(自动翻页加载更早历史 + anchor 高亮动画)。
- **GitAdapter**:自动检测仓库(含外层);版本边界记录 HEAD + 脏状态(commit-free,不动分支);非仓库工作区一键 `git init`(最小 .gitignore + 基线提交 + `refs/dsh/versions` 专用引用,可删除引用复原)。
- **防膨胀 GC**:节流后台扫掠回收被截断版本(>200 版本上限)的快照对象与引用,长会话存储有界。
- 新增路由:`POST /rollback/preview`、`POST /rollback`、`GET /git/status`、`POST /git/init`、`GET /snapshot`。
- 中英双语 UI 新增时间线/回退文案(键集一致,71=71);测试 84 → **110**。

### 已实现(写前校验闭环,2026-08-26)

- **marker 写前校验(prewrite guard)**:撤回/编辑/重新生成/恢复的 marker 落盘前,先经 `dsh-log-contract` 三层契约校验(S5 覆盖 / M1 引擎 / P1/P2 marker 语义 / S8 foldSurface 终验)——8-25 事故第 1 轮"违约写入没被拦"从此有系统解。任何 error 级违规 → `marker-rejected`,不落盘。依赖缺失自动降级(插件照常工作);可配置关闭(`prewrite`,默认开)。实测:20.4 万事件会话单次校验 ~220ms。
- 新依赖:`dsh-log-contract@^0.1.0`(已发布 npm)。

### 修复(P0 遗留,真机冒烟实锤,2026-08-26)

- **投影单元 wire 契约**:`retrace/versions` 单元补 `stateSchema` + `wire:{viewSchema, view}`——此前用顶层 `schema`/`view` 注册,框架将其视为"仅检查点"单元,**版本值自 0.3.0 起从未进入推送帧/快照**(时间线无数据、`/versions` 恒 `enabled:false`)。修复后真机复验:`插件新版本` 谱系 5 个 marker 正确产出 5 条版本记录(类型/摘要/文件计数/消息数全部正确)。
- **git 适配器 subprocess 优雅获取**:`ctx.subprocess` 未注入时不再抛错,headless/最小组合降级为纯快照回退。

### 计划中(见 [PLAN.md](./PLAN.md))

- **P2 — 分叉图与增强**:回合分叉流程图、思考流对应、分支意图卡、版本对比 / 保存点 / 审计视图、消息/思考节点时间线视图。
- **待办**:真机 GUI 冒烟(profile 重装后验证时间线渲染/产物回退/跳转)。

---

## [0.3.0] — 品牌重塑为 dsh-retrace

> 改名决策:采用 **dsh-retrace(Retrace · 回溯)**,新 npm 包名,从"消息编辑插件"升维为
> "会话与产物版本化管理"的 Harness 增强插件。旧包 `dsh-message-editor` 冻结在 0.2.2。

### Changed(破坏性)

- **包名**:`dsh-message-editor` → `dsh-retrace`(npm、插件 id、HTTP 路由 `/api/plugins/retrace`、localStorage key、CSS 前缀全部同步)。
- **内部标识**:marker 前缀 `message-editor` → `retrace`;RPC 键 `messageEditor.*` → `retrace.*`;`__setMessageEditorWire` → `__setRetraceWire`;样式类 `dsh-me-*` → `dsh-rt-*`。
- **README/品牌**:中英双语 README 重写品牌与方向(单会话版本化 + 产物回退 + 分叉图),新增 [PLAN.md](./PLAN.md) 实施方案与 CHANGELOG。

### 迁移

- 旧安装(`dsh plugin add dsh-message-editor`)请改用 `dsh plugin --profile <name> add dsh-retrace` 并移除旧包,重启后生效。

---

## [0.2.2] — 修复:Host 路由注册(以 dsh-message-editor 名义发布)

### Fixed

- Host `inject` 补充 `webServer`:此前 `ctx.get('webServer')` 在 apply 时可能为 undefined,导致 `/api/plugins/message-editor/*` 路由静默未注册、所有操作 404。现在与官方 Host 插件约定一致,apply 前保证 webServer 就绪。

## [0.2.1] — 修复:客户端 loader entry bundle(以 dsh-message-editor 名义发布)

### Fixed

- `exports["./client"]` 改为**构建后的自注册 bundle**(`lib/client.bundle.js`):client-modules 运行时直接服务该文件并期望 `window.__ModuleLoader__.load({id, factory})`;此前发布的是原始 ESM 源码,首次带插件重启报 `loaded without registering "dsh-message-editor"`。
- 新增构建脚本 `scripts/build-client.mjs`(esbuild),README 开发章节说明发布前必须 `pnpm build`。

## [0.2.0] — dsh.bundle manifest 迁移(以 dsh-message-editor 名义发布)

### Changed

- 迁移到 `dsh.bundle` 清单(`cordis.patch.yml`),可通过 `dsh plugin --profile <name> add dsh-message-editor` 官方插件路径安装;加入 `dsh-plugin` topic。

---

## 旧版(dsh-message-editor 时代)功能演进摘要

- **v3.8** — 撤回时隐藏工具行(bash/task 卡片)
- **v3.7** — 撤回回合忽略注入的上下文用户消息
- **v3.6** — 新消息下方渲染"原输入"对照(折叠,可配置)
- **v3.5** — 编辑/撤回操作行上方渲染原输入对照
- **v3.4** — 修复撤回后回合尾部操作栏(copy/feedback)未隐藏
- **v3.3** — 整轮撤回(输入+输出);编辑对照显示最近被替换文本(Host 权威)
- **v3.2** — 隐藏规则在提示消失后保持挂载;折叠摘要显示截断的原输入
- **v3.1** — 单消息撤回(隐藏消息与操作行)、自动消失的回退提示、重发消息下折叠原输入对照

<!-- 版本链接(已发布)
[0.4.2]: https://github.com/yamingmou/dsh-retrace/compare/v0.4.1...v0.4.2
[0.4.1]: https://github.com/yamingmou/dsh-retrace/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/yamingmou/dsh-retrace/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/yamingmou/dsh-retrace/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/yamingmou/dsh-retrace/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yamingmou/dsh-retrace/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yamingmou/dsh-retrace/releases/tag/v0.2.0
-->
