# Changelog

本项目(dsh-retrace)的版本历史与开发记录。格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 已实现(P0 — 版本数据服务,2026-08-21)

- **`retrace/versions` 投影单元**(官方 `ctx.sessionProjections`):撤回/编辑/重生成/恢复、compaction 检查点与其它 replace 的版本边界检测;surface 折叠与 `foldSurface` 同语义;触碰文件窗口归集(created/modified/deleted);wire view 版本列表摘要;版本上限 200(完整历史可经日志重放)。
- **内容寻址产物快照**(`$DSH_HOME/dsh-retrace/objects/<sha256[:2]>/<sha256>`,attachment-local 同款耐久写 + 完整性校验):版本边界自动快照触碰文件(工作区围栏 + 4MiB 上限 + 二进制跳过);`retrace` storageDomain 引用计数(`<versionId>:<path>` 共享去重)。
- **双通道查询**:`session/projection` 推送帧(apiproxy 自动广播)+ HTTP `GET /api/plugins/retrace/versions`(投影快照降级);`GET /event` / `GET /surface`(sessionQuery 惰性读,时间线详情用)。
- **配置生效**:设置三开关(版本与产物快照 / git 集成 / 保留上限)随请求携带(`x-retrace-config`),Host 以请求为准;关闭"版本与产物快照"时行为退化为纯 L1(仅上下文回退,不记录版本、不追踪产物)。
- 设置 → 通用三个开关 UI 此前已落地,本次接入 Host 消费。

### 计划中(见 [PLAN.md](./PLAN.md))

- **P1 — 时间线与产物回退**:单会话版本时间线(浮层面板)、产物回退(git 优先 + 快照兜底,干跑预览 + 确认)、跳转对话位置 + 高亮、git 集成(commit-free / 一键 init)。
- **P2 — 分叉图与增强**:回合分叉流程图、思考流对应、分支意图卡、版本对比 / 保存点 / 审计视图。

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

<!-- 版本链接占位(发布后启用)
[0.3.0]: https://github.com/yamingmou/dsh-retrace/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/yamingmou/dsh-retrace/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/yamingmou/dsh-retrace/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/yamingmou/dsh-retrace/releases/tag/v0.2.0
-->
