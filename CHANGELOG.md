# Changelog

本项目(dsh-retrace)的版本历史与开发记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]
## [Unreleased]

### 修复(0.4.4,撤回/编辑失效回归)

- **隐藏判定回退为 per-marker**:0.4.3 的 union-wide guard 在会话内 marker 累积覆盖 >40% 行时让**所有** marker(含新的撤回/编辑)全部降级不隐藏——「规划高级版本 (1)」会话即如此(实测 7 个 marker 全无隐藏规则,新撤回"已撤回 4 条消息"也不隐藏)。现在每个 marker 独立判定:普通撤回/编辑(几行)永远隐藏;仅单次覆盖 >40% 的大范围操作(如「编辑后从新对话开始」)降级。
- **降级不再静默**:大范围操作降级时显示提示条("为保护历史未隐藏内容,日志完好");首个 marker 在累积隐藏 >40% 时提示可关闭「按标记隐藏」查看完整历史。
- **操作行与隐藏状态一致**:UserActionsRow / AssistantActions / ReferenceRow 改为按"实际隐藏"判定(useRowHidden/useSeqHidden)——修复 0.4.3 的半失效态(消息可见但操作行消失)。
- 真机验证:历史 marker 隐藏规则 0 → 101;大范围撤回(78 条)降级 + 提示;i18n 85=85;测试 134 绿。


### 新增(P2.1 分叉图骨架,2026-08-26)

- **`retrace/forkmap` 投影单元**:镜像官方 `foldSurface` 的增量折叠 + 每个 replace 边界的 `replacedSeqs`(被遮蔽的旧路径节点);不截断(分叉全貌优先);wire 精简(节点 `{seq,type}` + 边界 `{seq,kind,replacedSeqs}`);`GET /forkmap` HTTP 降级,与 versions 同双通道。
- **「分叉」视图 Tab**(`conversation.view`,order 30,与 对话/轨迹/版本 平级):脊柱 = 当前 surface 节点流(用户/助手/工具 图标),分叉边界卡片化(撤回/编辑/重新生成/恢复 图标 + kind + 被遮蔽节点数 + markerText 摘要),固定行高窗口化,节点点击跳转对话。
- **修复 0.4.2 程序化切视图静默 no-op**:调研实锤第三方视图的 `actions.setView` 收到 undefined(chatStore 私有,仅声明 `store` 的条目有 actions);跳转/轨迹按钮改为 tab-bar DOM click(与用户点击同路径),共享 `jumpToAnchor`(切 Tab → loadOlder → 锚点滚动高亮)。
- i18n:+10 键(zh/en 对齐);测试 120 → **134**。

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
