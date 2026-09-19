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
**产物文件不会自动还原**。dsh-retrace 把对话**和它的产物**一起版本化，并保证
**每一次新的回退都合法**——不会弄脏日志，新写入的 marker **不产生 token-meter 配对债**
（两段原子对按构造即通过）。

> ⚠️ **诚实的边界（与配套契约自己的说明一致）**：**旧版本留下的单段 marker** 是
> **已知设计债**。压缩前请用配套 `check` 体检并 `fix --remove-markers` 清理，否则宿主的
> T1 自检会挡住 `/compact`。新的回退不会增加这笔债。

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

## 🛡️ 生产级保证（0.4.x 全部已上线）

| | 能力 | 说明 |
|---|---|---|
| 🛡️ | **写安全** | 每次回退过三层写前契约校验；运行中的 agent 自动停止（官方 `cancel`/`whenIdle`）；轮次间 marker 用临时 step 包裹 —— **新的回退不会弄脏日志**，新 marker **不产生 token-meter 配对债**；**旧单段 marker 是已知设计债**（压缩前先 `check` + `fix --remove-markers`） |
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

| | 能力 | 说明 |
|---|---|---|
| 🕘 | **时间线** | 「版本」Tab（与官方「对话/轨迹」平级）：每个版本的类型/时间/消息数/文件变更徽标，经 `session/projection` 推送帧实时更新（零轮询），大列表窗口化 |
| ↩️ | **产物回退** | 仅对话 / 仅产物 / 两者，先干跑预览再执行；git 优先 + 内容寻址快照兜底；回退本身是新版本（`restore`），可以再回退 |
| 🧭 | **跳转对话** | 从时间线一键跳转到对应位置（自动翻页加载更早历史 + 锚点高亮） |
| 🧹 | **存储有界** | 快照只保留最近 N 个版本（默认 50）；节流后台扫掠回收被截断版本 |

**为什么与众不同**（交互层差异——上面的保证是存储层）：

**为什么与众不同**

- 🎯 **整轮撤回** —— 一键移除输入 *和* 它的输出（含工具行），而不只是单条气泡。
- 🖥️ **Web + Desktop 双端** —— 同一插件覆盖 DeepSeek Harness 两种界面。
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

1. 打开 profile 清单（默认位置：DSH Desktop 为 `<插件数据家>/profiles/desktop`，
   独立 Web 为 `<插件数据家>/profiles/web` —— 插件数据家在设了 `$DSH_HOME` 时就是它，
   否则跟随**活动会话基座**；`~/.dsh/profiles` 只是迁移前的兜底），同时加入依赖**和** bundle 层条目：

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
   cd "$DSH_HOME/profiles/<name>" && pnpm install   # 或你实际使用的基座
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
| **启用 git 集成** | 开 | 开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支），非仓库可在时间线里一键启用；关：一律用内置快照（存于插件数据家），不触碰工作区 git 状态，功能等价。 |
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

## 🔺 兼容性与升级须知

`dsh-retrace` 是 **bundle 型插件**：它插进哪套宿主，就依赖那套宿主暴露的面。因此宿主
**移除**一个包或一个客户端服务时，**旧版插件即使一行没改也会坏** —— 而且症状通常是
「起不来」，不是「某个功能看起来不对」。

本节的目的：让你能分清 **宿主侧破坏性变更** 与 **插件侧缺陷**。提 issue 前请先看这节。

### `0.4.26` 适配的宿主侧破坏性变更 —— *不是本插件造成的*

1. **`@deepseek-ai/dsh-session` 把 `decodeStorageRecord` 从公开导出面拿掉了（`0.1.5-rc.1`；函数仍在内部模块里，但不再从包根导出、exports map 子路径也不可达）。**
   本插件自己从未 import 它，但它的依赖 `dsh-log-contract` import 了。宿主不再导出该符号时，
   加载器会以
   `plugin tree failed to load … does not provide an export named 'decodeStorageRecord'`
   中止，而且**整棵插件树一起失败——不只是本插件**，于是 App 起不来。`0.4.26` 改为要求
   一个通过**自身兼容层**解码、不再依赖该已移除导出的 `dsh-log-contract`。
   → **依赖说明：** 需要 `dsh-log-contract >= 0.3.12`。
2. **一个客户端**服务**消失了：`conversationEvents`** —— 它原先由旧客户端运行时
   `@deepseek-ai/dsh-client-runtime` 提供，而该运行时已被移除（`conversationEvents`
   这个串在宿主里**已 0 命中**）。插件的客户端半若仍在 `export const inject` 里声明它，
   就**永远不就绪**：fiber 停在 **pending**，宿主据此报
   `renderer boot failed (plugins: …): The client Loader did not provide an error message.`
   —— **一个字的错误信息都没有**，窗口起不来，唯一的进法是把插件禁用。
   `0.4.26` 已把它从 `inject` 中删掉，并改在 `apply` 里**防御性解析**
   （`uiConversation`，取不到则回退旧名），因此：**既能在提供新服务的宿主上跑，
   也仍兼容还提供旧服务的老宿主**。
   > 注意：在 `dsh.client.inject` 里声明一个**已不存在的包**，**不会**导致启动失败 ——
   > 客户端加载器对认不出的条目是**静默跳过**的。真正致命的是插件等待的那个**服务名**。

> 上面两条都是**宿主侧移除**，写在这里是有意的：如果你在**升级宿主之后**立刻遇到这两种症状，
> 第一个该问的是「这份插件构建是不是早于这次移除？」，而不是「插件改坏了什么？」。

### `0.4.26` 里的插件侧修复（这些是我们自己的）

- **插件数据家与会话基座合并为同一来源。** 此前插件用宿主的 home 解析器
  （`$DSH_HOME` → `~/.dsh`）决定自己的数据目录，而它不认识迁移后的基座（例如一个更新的 `DSH_HOME` 目录）。
  于是当 `$DSH_HOME` 未设时，**会话从一个基座读、快照与产物库写到另一个基座**。现在快照、
  版本库与 `verify-install` 都跟随**活动会话基座**；`$DSH_HOME` 已设时行为不变。
- **不再有任何用户可见文案写死 `~/.dsh`**（设置页原先提示快照存于 `~/.dsh`）。
- 删掉已无任何引用点的陈旧 peer 声明（`@deepseek-ai/dsh-home-paths`、
  `@deepseek-ai/dsh-client-runtime`）。

### 升级

```bash
dsh plugin --profile desktop add dsh-retrace@0.4.32
# 然后重启 DSH —— 插件不会热重载
```

如果**升级后 App 起不来**：一个插件失败就能拖垮整棵树，所以**先恢复、再排查**：

1. 把 `dsh-retrace` 从 profile 的 `dsh.profile.bundles` **和** `dependencies` 里删掉，重启，
   确认能先进得来；
2. 读宿主日志 —— macOS：`~/Library/Application Support/DSH Desktop/logs/host/dsh-<日期>.error.log`；
3. `plugin tree failed to load` 是**宿主侧**；`renderer boot failed` 是**客户端侧**。
   两者都会点名出问题的插件/包 —— 从那里查起。

### 版本固定建议

请固定到确切版本（`dsh-retrace@0.4.32`），并让 `dsh-log-contract` 解析到 `>=0.3.12`。
**不要在跨宿主升级时依赖 `^0.4` 这种范围**：这里的兼容性由**宿主的面**决定，光看 semver 不够。

---

## ⚠️ 要求与限制

- **可选依赖（不写进 `package.json`）**：AI 摘要需要宿主提供 `llm` 服务
  （官方 `@deepseek-ai/dsh-llm`，随 DSH Desktop 内置）。插件用
  `ctx.get('llm')` **动态取用**：有就用，缺失即降级为**只给逐字原文**，
  安装/启动不受影响。模型与凭据沿用会话自身的默认模型选择
  （`agentDefaultModel.currentSelection()`），插件**不新增任何配置面**。
  摘要是**默认关闭**的开关（每次操作至多 1 次小调用，输入 ≤6×400 字、
  输出 ≤200 token、5 秒超时），关闭时**零 LLM 调用**；而逐字原文
  （`excerpt`）零 token 成本，**始终产出**。
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

- 撤回 / 编辑重发 / 重新生成——每次回退都过**三层写前校验**与安全编辑路径（自动停 agent、临时 step 包裹 marker），**新的回退不会损坏日志、不新增 `/compact` 债**；**旧单段 marker 需要压缩前清理**（配套 `check` + `fix --remove-markers`）。
- 单会话**版本时间线** + **产物回退**（git 优先 + 快照兜底、干跑预览、跳转对话）。
- 对话视图内的**分叉图** + **会话谱系**。
- **实时看门狗**——并发写入第一时间快照日志。
- 配套 **`dsh-log-contract`**：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`），能处理会让 /compact 永久失败的会话。
**关闭守卫（防误关丢进度）** —— 退出/重载前先看清还有什么在跑：

| | 是什么 | |
|---|---|---|
| 🛡️ | **运行中检测** | 逐会话扫描运行中工作：agent 正在跑 / inbox 排队 / 后台 jobs / 未闭合轮 |
| 📋 | **运行中横幅** | 有运行中工作的会话显示页面常驻横幅（会话短码 + 原因），退出前可见 |
| ⚠️ | **退出提示** | 插件 dispose（应用退出/重载）时中文提示列出每个运行中会话与原因——只提示，绝不代你取消 agent |
| 🔒 | **页面关闭拦截** | **不武装宿主原生确认框**；改用**页面自绘确认门**：先画框并**同步校验可见**才拦（`preventDefault`），画不出 / 不可见 / 页面不可见 ⇒ **当场放行**；确认框一直等你选择（Esc = 取消）；**看门狗（Web Worker 计时器，不受后台节流）**只作最后一道；关掉设置项即退回官方形态（免重启） |
| 🔎 | **查询面** | `retrace.runningState`（host RPC）+ `GET|POST /api/plugins/retrace/runningState`（HTTP），两入口同形状；全会话形状另带宿主判定的承载面（`surface` / `quitVeto`） |

> **桌面端口径（2026-09-20 更正）**：**桌面端一律不武装宿主原生确认框** —— **退出入口随版本/平台而变**，
> 而原生确认框在桌面壳上要么不存在、要么被静默吞掉：我们检查的 2.0.9 壳没有处理
> `will-prevent-unload`（打包 `app.asar` 全文检索 0 命中），托盘项走
> `requestQuit(0) → window.destroy() → app.exit(0)`；外部报告那套 DSH Desktop 0.9.0 / Windows
> 上虽然**会走到页面** `beforeunload`，但页面否决被**静默吞掉**（不弹界面、不给反馈，表现为退出卡住）。
>
> **桌面端真正生效的是页面自绘确认门**（2026-09-19 收尾）：它**确实会调用 `preventDefault`** ——
> 但只在"**先画出来 + 同步可见性校验通过**"之后才拦；`visibilityState` 前置检查，框画不出来 /
> 不可见 / 页面不可见 ⇒ **当场放行**；确认框一直等你选择（**Esc = 取消**）；
> **看门狗用 Web Worker 计时器**（不受后台节流）只作**最后一道**分流。
>
> 武装**宿主原生门**的判据：**两道判据都成立才武装**（2026-09-18 第二轮）—— 宿主那条只是"不反对"
> （`quitVeto: true`），客户端还有**一票否决**：本页 `navigator.userAgent` 含 `Electron`，
> 或页面 URL 含 `dsh-desktop-`（外部报告那套壳把桌面标记放在查询串里）⇒ 一律不武装。
> 宿主侧判据补成**四条请求级证据**：能力头 `x-dsh-desktop-renderer` / 请求 UA 含 `Electron` /
> 请求 URL **或 `Referer`** 含 `dsh-desktop-`（我们自己的轮询 URL 没有 query，所以页面标记
> 实际是从 `Referer` 读到的），**任一成立**即判桌面页面。这样"壳什么桌面痕迹都不给"的宿主
> （报告人那台：纯 Node 跑 harness + Electron 渲染页，三条旧判据全不成立，旧实现把
> "**完全没有证据**"归成了浏览器页 ⇒ 照旧武装 ⇒ 仍退不掉）也不会再把退出卡住。
>
> **已知限制（照实写）**：某些桌面壳的退出口径**根本不经过页面**（如
> `requestQuit → destroy → app.exit`，或点 X 只是隐藏窗口）⇒ 那类壳上"退出时弹确认"
> **插件侧做不到**，需要**壳提供 seam**（`will-prevent-unload` 处理，或退出前的询问钩子）。
> **桌面端退不掉时**，把设置里的「退出确认（关闭守卫）」关掉即退回官方形态（**不用重启**）。

**会话短码与显示名**（**计划 / 默认关闭**）—— 人机协作用短码，**身份判定仍以 session id 为准**。
通道（`sessionBadge` / `setBadgeTitle` / `initBadgeTitles` / `badgeMap`，HTTP + harness 两入口）与
解析器、写护栏**均已就位**；但**启动自动写标题那条路默认关闭**（真机上三次不同失败后按
「文件/脚本优先」改走**脚本层 T3**，T3 尚未实现）—— 需要时置 `__DSH_RETRACE_BADGE_BOOTSTRAP = true` 打开：

- 会话标题显示为 `[短码] 原标题`（形态占位：`[opxxxopxxx] 原标题`），短码形态 **`opxxxopxxx`**，
  由**真表** `codes.json` 解析（工作区 + 序号 + 父链语义，**不是 hash**）。
- **没有 `session/title` 事件的会话如实留空**（标题只显示 `[短码]`）—— **不回落项目名、不伪造名字**。
- 拿不到短码表 / 解析器不可用时退回**原始 session id 占位**，**绝不回落 FNV**。
- 侧栏会话行、运行中横幅、读档点视图的短码**同源**：都取宿主下发的**同一份**映射（宿主 op `badgeMap`）。

> **计划（未上线）**：脚本层 T3 尚未实现（短码/名字的**启动自动写标题**即卡在这里）；业务层规划
> （运行时守护、中断治理、生态开放接口）见下节，属**计划**而非已上线能力。

**未来计划**——agent 业务层规划（运行时守护、中断治理、生态开放接口）**尚未发布**，此节是**计划**而非已上线能力。本 README 描述的是**开发线（main）**，可能领先于 npm 上最新发布版。

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

欢迎提交 PR 与 issue —— `CONTRIBUTING.md` 筹备中，先与
[问题追踪](https://github.com/yamingmou/dsh-retrace/issues)。

---

## 📚 生态

收录于 [dsh-plugin topic](https://github.com/topics/dsh-plugin)。

**Agent 业务层（生产级保证）** 的一部分——即 dsh-retrace 在 DeepSeek Harness 上实现的
那层框架无关的业务层定义。配套组件：

- [**dsh-log-contract**](https://github.com/yamingmou/dsh-log-contract) —— 业务层的
  「医生」：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`）。
  作为依赖自动安装，也独立发布供直接使用。

> **直接从 GitHub 安装**（无需 npm registry —— 适合把本仓库链接丢给 AI，或想装最新提交）：
>
> ```sh
> dsh plugin --profile desktop add github:yamingmou/dsh-retrace
> # 或直接用 pnpm 装进 profile：
> cd "$DSH_HOME/profiles/desktop" && pnpm add github:yamingmou/dsh-retrace
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

<session> 为完整日志路径或 sessionId（自动在**活动会话基座**查找：`$DSH_HOME/sessions`，否则更新的基座，最后才是 `~/.dsh/sessions`）。全部只读。

**分叉图里的会话谱系（A4, UI）**：Fork map 视图头部展示当前会话的
`parentSession` 接续链（当前会话 → 父 → 根,`←` 方向）。数据来自
`GET /api/plugins/retrace/lineage?sessionId=`（只读 header 遍历,带环保护）,
与 CLI `retrace lineage` 同一语义。这样「这个会话是从哪个会话接着干/分叉出来的」
在界面上一眼可见——也是分叉图拓扑的元数据源。
