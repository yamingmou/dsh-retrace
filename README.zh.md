<div align="center">

# 🧭 dsh-retrace

**撤回 · 编辑重发 · 重新生成**，加上**写安全**的会话版本化 —— DeepSeek Harness 的
**Agent 业务层（生产级保证）** 实现。

[![npm version](https://img.shields.io/npm/v/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![npm downloads](https://img.shields.io/npm/dm/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![License: MIT](https://img.shields.io/npm/l/dsh-retrace)](https://github.com/yamingmou/dsh-retrace/blob/main/LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9)](https://github.com/topics/dsh-plugin)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](https://github.com/yamingmou/dsh-retrace/pulls)

**简体中文** · [English](./README.md)

</div>

**撤回 / 编辑重发 / 重新生成** —— 每个会话都该有的三个操作。但回退不只是「撤掉一条
消息」：DeepSeek Harness 把对话存在 append-only 事件日志里，撤回只回退上下文，改过的
**产物文件不会自动还原**。dsh-retrace 把对话**和它的产物**一起版本化，并且保证
**每次回退都合法、不弄脏日志、不破坏 /compact**。

> 🛡️ **写安全** · 🔍 **深层体检** · 🔄 **检测→修复→守护** —— 详见下方「生产级保证」。

---

## ⚡ 一分钟安装

> 需要带 `dsh` CLI 的 DeepSeek Harness；装完**重启 DSH** 生效（运行中的应用不会热加载）。

```sh
dsh plugin --profile desktop add dsh-retrace    # DSH 桌面版
# 或 Web 部署：dsh plugin --profile web add dsh-retrace
# 或从 GitHub 直装：dsh plugin --profile desktop add github:yamingmou/dsh-retrace
# 或从 ZIP 解压后：dsh plugin --profile desktop add ~/plugins/dsh-retrace
```

**没有命令行？** 先装一次社区插件市场，再在 **设置 → Plugin Market** 搜
**dsh-retrace** 一键安装：

```sh
dsh plugin --profile desktop add dshmarket    # 只需一次
```

重启后，悬停任意助手回复 → **↩ / ↻**；任意用户消息 → **✎**。详细步骤见
[📦 安装](#-安装)。

---
---

## 🛡️ 生产级保证（0.4.x 全部已上线）

| | 能力 | 说明 |
|---|---|---|
| 🛡️ | **写安全** | 每次回退过三层写前契约校验；运行中的 agent 自动停止（官方 `cancel`/`whenIdle`）；轮次间 marker 用临时 step 包裹 —— **回退永不弄脏日志，/compact 永不失效** |
| 🔍 | **深层体检** | 配套 `dsh-log-contract` 30+ 条契约规则（token-meter 配对 / 跨 step 引用 / 物理序 / inbox 重放），用真实损坏会话当测试集 —— 能找出让 /compact 永久失效的那类问题 |
| 🔄 | **检测→修复→守护** | 看门狗在并发写入第一时间快照日志；离线 `fix` 原地中和问题 marker、裁剪跨 step 引用；写前校验在坏事件落盘前拦住 |

---

## ✨ 功能

| 操作 | 入口 | 效果 |
| --- | --- | --- |
| **↩ 撤回** | 悬停任意助手回复；或用户消息下方的操作行 | **移除整轮对话**（该条输入及其对应的输出、工具行一并消失），从模型上下文与对话视图中同步清除，并把输入原文**回显到输入框**方便立即修改后重发；一条短暂提示标记回退点，你继续输入后自动消失。 |
| **✎ 编辑重发** | 用户消息下方的操作行 | 回退该条输入及其回复并重发修改后的文本。默认**只替换被编辑那一轮**（更早的历史保持可见）；可在设置中开启「从新对话开始」让对话从新消息重新开始（此时此前的消息不再进入上下文，视图中也默认保持可见、仅显示标记提示）。新消息下方有一个折叠的「原提问」对照，点击展开、可配置关闭。 |
| **↻ 重新生成** | 悬停任意助手回复 | 回退并隐藏该回复及其后内容，重新发送原提问，让智能体重新作答。 |

**版本化与回退（0.4.x 已上线）** —— 每次回退都会被记录为一个**版本**：

- 🕘 **时间线** —— 会话视图新增「版本」Tab（与官方「对话/轨迹」平级，0.4.2 起）：展示每个版本（类型/时间/消息数/文件变更徽标/摘要），经 `session/projection` 推送帧实时更新（零轮询），大列表窗口化渲染；事件原文查看复用官方「轨迹」台账。
- ↩️ **产物回退** —— 每个版本支持 仅对话 / 仅产物 / 两者 三种回退范围，先干跑预览再执行；git 优先（commit-free checkout 清单路径）+ 内容寻址快照兜底。回退本身记录为新版本（`restore`），可以再回退。
- 🧭 **跳转对话** —— 从时间线一键跳转到对话对应位置（自动翻页加载更早历史 + 锚点高亮）。
- 🧹 **存储有界** —— 文件快照只保留最近 N 个版本（默认 50）；节流后台扫掠回收被截断版本的快照，长会话不膨胀。

**为什么与众不同**

- 🎯 **整轮撤回** —— 一键移除输入 *和* 它的输出（含工具行），而不只是单条气泡。
- 🖥️ **Web + Desktop 双端** —— 同一插件覆盖 DeepSeek Harness 两种界面。
- 🔒 **删除的是视图与上下文，不是日志** —— 被撤回/编辑的消息从对话视图和模型上下文中
  消失，但持久化日志从不被改写或删除；插件只追加合法、带类型的会话事件（与内置压缩
  使用的 `replace` 原语一致），日志保留完整审计痕迹。
- 🧠 **视图 ⇄ 上下文同步** —— 对话视图永远反映智能体真正看到的内容。
- ⚡ **30 秒上手** —— 动态插件形式无需重建即可在当前会话试用。

---

## 📦 安装

### 1. Profile bundle（推荐）

包声明了 `dsh.bundle` 清单，可通过官方插件路径安装到任意 profile：

```sh
dsh plugin --profile <name> add dsh-retrace
```

> ⚠️ **安装后需要重启。** 安装会写入新文件并重新生成 profile 组合，但运行中的应用
> **不会**热加载 bundle —— 请**退出并重新打开 DSH Desktop**（独立 Web 部署则重启
> `dsh` 进程）来加载插件。卸载：`dsh plugin --profile <name> remove
> dsh-retrace`（卸载后同样需要重启）。

### 2. 手动安装（不依赖 `dsh` CLI）

用纯文件编辑 + `pnpm` 装进同一个 profile —— 也就是 `dsh plugin add` 帮你做的那些步骤：

> **从 GitHub 下载了 ZIP？** 解压到固定位置（如 `~/plugins/dsh-retrace`），
> 然后执行 `dsh plugin --profile desktop add ~/plugins/dsh-retrace`；或按下面步骤，
> 把依赖行指向该文件夹：`"dsh-retrace": "file:~/plugins/dsh-retrace"`。

1. 打开 profile 清单（默认位置：DSH Desktop 为 `~/.dsh/profiles/desktop`，
   独立 Web 为 `~/.dsh/profiles/web`），同时加入依赖**和** bundle 层条目：

   ```json
   {
     "dependencies": {
       "dsh-retrace": "^0.4.0"
     },
     "dsh": {
       "profile": {
         "bundles": [
           "@deepseek-ai/dsh-base",
           "@deepseek-ai/dsh-web-app",
           "dsh-retrace"
         ]
       }
     }
   }
   ```

   （保留 profile 原有条目，只需新增 `dsh-retrace` 这两处。）

2. 在 profile 目录里安装：

   ```sh
   cd ~/.dsh/profiles/<name> && pnpm install
   ```

3. 重启 DSH Desktop / `dsh` 进程（见上文）。

本地开发时，可以把依赖指向本地检出目录而不是注册表：
`"dsh-retrace": "file:/路径/to/dsh-retrace"` —— 或者交给 `dsh`：
`dsh plugin --profile <name> add /路径/to/dsh-retrace`。

### 3. npm 包 + 组合文件（经典方式）

```sh
npm i dsh-retrace
```

在所使用的应用/部署的 `cordis.yml` 组合文件中加入一行普通插件条目：

```yaml
- name: 'dsh-retrace'
```

Client 半区会依据包内 `dsh.client` 元数据被自动打包进 Web 客户端（组合变化时会自动
重建客户端模块）；Host 半区为浏览器 UI 注册同源 HTTP 路由 `/api/plugins/retrace/*`。

### 4. 动态插件（当前会话，免安装、免重建）

包内提供了两个自包含的动态入口：

1. 打开插件编辑界面，用 `lib/dynamic-host.js`（Host 半区）和
   `lib/dynamic-client.js`（Client 半区）新建插件；
2. 批准并运行 Client 半区；
3. 完成 —— 悬停任意助手回复或用户消息，即可使用 ↩ / ✎ / ↻。

动态 Host 通过 `harness.handle` 注册同一组操作
（`retrace.recall` / `retrace.editAndResend` / `retrace.regenerate`）。

---

## ⚙️ 设置 → 通用

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| **编辑后显示原提问对照** | 开 | 重发消息下方的折叠「原输入」引用，显示**最近一次**被替换的原文（仅作对照，不会进入模型上下文）。 |
| **编辑后从新对话开始** | 关 | 编辑后连此前的消息也一并隐藏，让对话看起来像从新消息重新开始（重发前回退整个表面）。默认关：只替换被编辑那一轮的上下文。 |
| **按标记隐藏被编辑/撤回的消息** | 开 | 开（默认）：撤回/编辑/重新生成按标记隐藏被替换的那一轮消息。关：所有消息保持可见，标记仅显示提示与对照（查看完整历史用）。单个 marker 要隐藏超过 40% 的对话时自动降级为不隐藏（历史永不静默消失）。 |
| **版本与产物快照** | 开 | 开：每次撤回/编辑记录一个版本（消息与触碰文件），提供时间线与产物回退；关：仅回退上下文，不记录版本、不追踪产物（最省资源）。 |
| **启用 git 集成** | 开 | 开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支），非仓库可在时间线里一键启用；关：一律用内置快照（存于 `~/.dsh`），不触碰工作区 git 状态，功能等价。 |
| **版本保留上限** | 50 | 文件快照只保留最近 N 个版本，超出自动清理最旧的；时间线记录与审计痕迹始终保留。 |

---

## 🧠 工作原理

```
 持久化日志（只追加）                          模型上下文与视图
 ┌────────────────────────────────┐      ┌────────────────────┐
 │  … 目标消息                    │      │  … 目标消息        │
 │      ↓ 阴影区间                │      │       ↓ 回退       │
 │  [目标 … 最后一个表面节点]     │ ──▶  │  (空 replace       │
 │      ↳ 追加一条替换型          │      │   = 上下文截断)    │
 │        assistant/message（空） │                           agent.followup(新提示)
 │      ↳ 可选「原提问」对照      │                           → 下一轮基于回退后的历史重建请求
 └────────────────────────────────┘      └────────────────────┘
```

1. **Host 核心**（`lib/host-core.js`，零运行时依赖）：在会话的活跃表面中定位目标
   消息，计算阴影区间 `[消息 … 最后一个表面节点]`，追加一条**空内容**的替换型
   `assistant/message` —— 空助手消息是合法表面节点，但派生不出任何模型消息，
   因此 LLM 上下文直接回退。
2. **编辑 / 重新生成**：额外调用 `agent.followup(...)` 发送（新的）提示文本，
   智能体的下一轮请求基于回退后的 `session.deriveMessages()` 构建。
3. **Client**（`lib/client.js`）注册：
   - 每条用户消息下的 `user-actions` 对话节点（编辑/撤回行 + 内联编辑器）；
     撤回后把原文回显到输入框，
   - `recall-marker` 节点渲染器：提示行 + 注入 CSS 把被阴影化的消息行从对话流中
     隐藏（视图与模型上下文保持同步），并可显示「原提问」对照块，
   - `conversation.chat.assistant-actions` 中的 `retrace` 入口
     （撤回/重新生成），
   - 设置 → 通用 中的偏好开关与版本保留上限。

> 这里有两个不同层面：**持久化日志**（只追加；旧事件从不被改写或删除）与
> **模型可见表面**（由追加的替换事件回退）。因此旧事件作为审计痕迹留在记录中——
> 但它们会被**同步地从模型上下文和可见对话中清除**，界面始终反映智能体真正看到的内容。
> 因为插件只追加合法、带类型的会话事件，持久化、投影与记录保持一致。

---

## ⚠️ 要求与限制

- 只有**用户消息**可以编辑；撤回同时适用于用户与助手消息。工具结果会随区间一并
  被阴影化，但不能单独作为撤回目标。
- 智能体必须**空闲**：回复流式输出时需先点击 ⏹ 停止，再撤回或编辑；否则 Host
  返回 `agent-busy`。
- 撤回/编辑作用于**活跃模型表面**：已被压缩或此前已撤回的消息会被拒绝
  （`target-shadowed`）。
- 重新生成只重发原提示的**文本**部分；携带图片的提示会退化为仅文本重发。

---

## 🗺️ 路线图

**当前已具备（0.4.x）：**

- 撤回 / 编辑重发 / 重新生成——每次回退都过**三层写前校验**与安全编辑路径（自动停 agent、临时 step 包裹 marker），**不会损坏日志、不会破坏 /compact**。
- 单会话**版本时间线** + **产物回退**（git 优先 + 快照兜底、干跑预览、跳转对话）。
- 对话视图内的**分叉图** + **会话谱系**。
- **实时看门狗**——并发写入第一时间快照日志。
- 配套 **`dsh-log-contract`**：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`），能处理会让 /compact 永久失败的会话。

**未来计划**——见 [公开路线图](./docs/ROADMAP.md)（agent 业务层规划：运行时守护、中断治理、生态开放接口）。本 README 只描述已上线的能力。

---

## 🛠️ 开发

```sh
# 目录结构
lib/host-core.js       # 传输无关的 Host 逻辑（无 import）
lib/index.js           # 发布版 Host：harness RPC + HTTP 路由
lib/client.js          # Client 源码（import React；传输层可插拔）
lib/client.bundle.js   # 构建产物 —— 自注册 loader entry
                       # （`window.__ModuleLoader__.load`），由 client-modules 提供
lib/dynamic-host.js    # 生成的动态 Host 半区（源自 lib/host-core.js）
lib/dynamic-client.js  # 生成的动态 Client 半区（源自 lib/client.js）
scripts/build-client.mjs      # 打包 lib/client.js → lib/client.bundle.js
scripts/generate-dynamic.mjs  # 从权威源生成两个动态入口
scripts/check-dynamic.mjs     # 语法检查动态入口（函数体形态）
test/                 # vitest 套件：host-core 操作 + 生成产物冒烟测试
.github/workflows/    # CI（语法 + 构建同步 + 测试）与 npm 发布（v* tag）
cordis.patch.yml      # dsh.bundle profile patch 层
```

```sh
pnpm install          # 安装开发依赖（vitest、esbuild）
pnpm check            # 语法检查源码与生成的动态入口
pnpm build            # 重新生成 lib/dynamic-*.js 与 lib/client.bundle.js
pnpm test             # 运行 host-core 单元测试
npm pack --dry-run    # 校验发布文件清单
```

> ⚠️ **生成文件。** `lib/dynamic-host.js`、`lib/dynamic-client.js` 与
> `lib/client.bundle.js` 是由 `lib/host-core.js` 和 `lib/client.js` 生成的构建
> 产物 —— **请勿手改**。CI 会在构建产物与源码不同步时失败
> （`git diff --exit-code`），因此提交前记得执行 `pnpm build`。动态 Client 与
> 发布版共用同一份 client 源码，仅通过 `__setMessageEditorWire` 切换传输层
> （`host.call` vs HTTP 路由）。

欢迎提交 PR 与 issue —— 见 [CONTRIBUTING](./CONTRIBUTING.md)（筹备中）与
[问题追踪](https://github.com/yamingmou/dsh-retrace/issues)。

---

## 📚 生态

收录于 [dsh-plugin topic](https://github.com/topics/dsh-plugin)。

**Agent 业务层（生产级保证）** 的一部分——见 [公开路线图](./docs/ROADMAP.md)
（框架无关的业务层定义，dsh-retrace 是它在 DeepSeek Harness 上的实现）。配套组件：

- [**dsh-log-contract**](https://github.com/yamingmou/dsh-log-contract) —— 业务层的
  「医生」：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`）。
  作为依赖自动安装，也独立发布供直接使用。

> **直接从 GitHub 安装**（无需 npm registry —— 适合把本仓库链接丢给 AI，或想装最新提交）：
>
> ```sh
> dsh plugin --profile desktop add github:yamingmou/dsh-retrace
> # 或直接用 pnpm 装进 profile：
> cd ~/.dsh/profiles/desktop && pnpm add github:yamingmou/dsh-retrace
> ```
>
> 然后照常重启 DSH Desktop。`dsh-log-contract` 依赖会自动带上。

DeepSeek Harness 插件生态的精选总览见
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（第三方收录，使用前请自行确认可用性）。

---

## 👥 团队

由 [OfferKuai](https://www.offerkuai.com) 团队开发——一款 AI 求职助手，使命是
「用户要的是结果，而不是反复的对话」。创始人：Zhaofeng（Yaming）。本插件以开源
形式发布，回馈 DeepSeek Harness 社区。

## 📄 License

MIT

---

## 🧭 会话日志考古（retrace CLI）

DSH 会话日志持久化了每次工具调用的完整输入输出——数据资产与审计资产。
`retrace` CLI 提供只读考古能力（复用 dsh-log-contract 的契约与提取）：

```sh
retrace index <session>                        # 工具调用索引（A1）
retrace query <session> --cmd "seed-scale"     # 按命令正则查输出（A1）
retrace extract <session> --pattern "seed-scale" --out ./found   # 导出输出（A2）
retrace file-history <session> <path>          # 文件 write/edit 历史版本（A3）
retrace file-diff <session> <path> 0 5         # 两版本行级 diff（A3）
retrace lineage <session>                      # 会话 parent 链谱系（A4）
```

<session> 为完整日志路径或 sessionId（自动在 ~/.dsh/sessions 查找）。全部只读。

**分叉图里的会话谱系（A4, UI）**：Fork map 视图头部展示当前会话的
`parentSession` 接续链（当前会话 → 父 → 根,`←` 方向）。数据来自
`GET /api/plugins/retrace/lineage?sessionId=`（只读 header 遍历,带环保护）,
与 CLI `retrace lineage` 同一语义。这样「这个会话是从哪个会话接着干/分叉出来的」
在界面上一眼可见——也是分叉图拓扑的元数据源。
