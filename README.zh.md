<div align="center">

# 🧭 dsh-retrace

**撤回 · 重发（从这条重开）· 重新生成**，加上**写安全**的会话版本化 —— DeepSeek Harness 的
**Agent 业务层（生产级保证）** 实现。

[![npm version](https://img.shields.io/npm/v/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![npm downloads](https://img.shields.io/npm/dm/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![License: MIT](https://img.shields.io/npm/l/dsh-retrace)](https://www.npmjs.com/package/dsh-retrace)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4A90D9)](https://github.com/topics/dsh-plugin)

**简体中文** · [English](./README.md)

</div>

**撤回 / 重发 / 重新生成** —— 每个会话都该有的三个操作。但回退不只是「撤掉一条
消息」：DeepSeek Harness 把对话存在 append-only 事件日志里，撤回只回退上下文，改过的
**产物文件不会自动还原**。dsh-retrace 把对话**和它的产物**一起版本化，并保证
**每一次新的回退都合法**——不会弄脏日志，新写入的 marker **不产生 token-meter 配对债**
（两段原子对按构造即通过）。

> ⚠️ **诚实的边界（与配套契约自己的说明一致）**：**旧版本留下的单段 marker** 是
> **已知设计债**。压缩前请用配套 `check` 体检并 `fix --remove-markers` 清理，否则宿主的
> 压缩前自检会挡住 `/compact`。新的回退不会增加这笔债。

> 🛡️ **写安全** · 🔍 **深层体检** · 🔄 **检测→修复→守护** —— 详见下方「生产级保证」。

---

## ⚡ 一分钟安装

> 需要带 `dsh` CLI 的 DeepSeek Harness；装完**重启 DSH** 生效（运行中的应用不会热加载）。

```sh
dsh plugin --profile desktop add dsh-retrace    # DSH 桌面版
# 或 Web 部署：dsh plugin --profile web add dsh-retrace
# 或从解压后的检出 / ZIP：
#   dsh plugin --profile desktop add ~/plugins/dsh-retrace
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
| 🛡️ | **写安全** | 每次回退过三层写前契约校验；运行中的 agent 自动停止（官方 `cancel`/`whenIdle`，带等待上限）；轮次间 marker 用临时 step 包裹 —— **新的回退不会弄脏日志**，新 marker **不产生 token-meter 配对债**；**旧单段 marker 是已知设计债**（压缩前先 `check` + `fix --remove-markers`） |
| 🔍 | **深层体检** | 配套 `dsh-log-contract` 30+ 条契约规则（token-meter 配对 / 跨 step 引用 / 物理序 / inbox 重放），用真实损坏会话当测试集 —— 能找出让 /compact 永久失效的那类问题 |
| 🔄 | **检测→修复→守护** | 看门狗在并发写入第一时间快照日志；离线 `fix` 原地中和问题 marker、裁剪跨 step 引用；写前校验在坏事件落盘前拦住 |

---

## ✨ 功能

| 操作 | 入口 | 效果 |
| --- | --- | --- |
| **↩ 撤回** | 悬停任意助手回复；或用户消息下方的操作行 | 先弹**二次确认**（破坏性动作：本条及其后的对话将离开会话）。确认后，若本轮仍在运行，插件先通过官方停止入口**暂停在途轮次**并等待（有上限）；暂停失败/超时也**照常撤回**，并给出可见提示。随后整轮（该条输入**及其**输出、工具行）从模型上下文与对话视图中一并移除，输入原文**回显到输入框**方便立即修改后重发；一条短暂提示标记回退点，你继续输入后自动消失。 |
| **✎ 重发（从这条重开）** | 用户消息下方的操作行 | 主语义是**从这条重开**：本条及其后被回退，并用新文本重发，对话进入新的时间线分支。若该范围被守卫拒绝（过大、无法原地改写），错误提示里给出兜底动作 —— **「仅改文本（保留后续）」**。新消息下方有一个折叠的「原输入」对照，点击展开、可配置关闭。 |
| **↻ 重新生成** | 悬停任意助手回复 | 回退并隐藏该回复及其后内容，重新发送原提问，让智能体重新作答。 |

### 撤销一次撤回

| 操作 | 作用面 | 效果 |
| --- | --- | --- |
| ↺ **恢复显示** | 只改界面 | 把该标记隐藏的行重新显示回对话视图。日志只增不减、模型上下文不变，撤回痕迹保留。入口在该标记行上。 |
| ⏪ **真正恢复** | 改日志 | **原地**中和这两段标记（不改 seq 编号），让被撤回区间回到**模型面**，该区间的重发 / 撤回入口复活。要求会话空闲、且不是你当前正在查看的会话；成功后需切走并重开该会话（或刷新页面）才看到恢复后的内容。被拒时给出可执行的下一步（会话运行中 / 文件被其他进程持有 / 已被更晚的标记重新遮蔽 / 当前宿主未装配该能力）。 |

**读档点与回档（0.4.x 已上线）** —— 每次回退都会被记录为一个**读档点**：

| | 能力 | 说明 |
|---|---|---|
| 🕘 | **读档点** | 对话视图里的「读档点」Tab：每个改动（类型/时间/消息数/文件变更徽标），经 `session/projection` 推送帧实时更新（零轮询），大列表窗口化；嵌套历史按大纲逐层展开 |
| ↩️ | **产物回退** | 仅对话 / 仅产物 / 两者，先干跑预览再执行；git 优先 + 内容寻址快照兜底；回退本身是新读档点（`restore`）。预览在会话运行中直接拒绝（不会出现「预览说可以、确认时才被拒」），预览/回档失败都会在界面上显示，不静默 |
| 🧭 | **跳转对话** | 从读档点一键跳转到对应位置（自动翻页加载更早历史 + 锚点高亮）；该点超出自动加载预算时，给出可诊断原因，而不是点了没反应 |
| 🧹 | **存储有界** | 快照只保留最近 N 个读档点（默认 50）；节流后台扫掠回收被截断的旧档 |

> **损坏日志上的回档不静默**：宿主的严格重放是权威，但一条畸形事件（例如第三方写入的
> `sourceEventSeqs` 区间编码行）就能毒化整次重放。这种情况会退到镜像重放，日志同时记录
> 「已降级」与原始错误，并在 wire 上把结果标为 `degraded`；连镜像都跑不了时返回结构化的
> `replay-failed` 错误，而不是笼统的 `internal`。

**为什么与众不同**（交互层差异——上面的保证是存储层）：

- 🎯 **整轮撤回** —— 移除输入 *和* 它的输出（含工具行），而不只是单条气泡。
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

> **下载了 ZIP？** 解压到固定位置（如 `~/plugins/dsh-retrace`），
> 然后执行 `dsh plugin --profile desktop add ~/plugins/dsh-retrace`；或按下面步骤，
> 把依赖行指向该文件夹：`"dsh-retrace": "file:~/plugins/dsh-retrace"`。

1. 打开 profile 清单（默认位置：DSH Desktop 为 `<插件数据家>/profiles/desktop`，
   独立 Web 为 `<插件数据家>/profiles/web` —— 插件数据家在设了 `$DSH_HOME` 时就是它，
   否则跟随**活动会话基座**；`~/.dsh/profiles` 只是迁移前的兜底），同时加入依赖**和** bundle 层条目：

   ```json
   {
     "dependencies": {
       "dsh-retrace": "^0.4.130"
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
想要最新提交而不等发版时，用本包 `repository` 字段里的仓库地址加 git 依赖
（pnpm 写法 `"dsh-retrace": "github:<owner>/dsh-retrace"`），放在同一个
`dependencies` 块里，再 `pnpm install`。

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

### 5. 依赖与权限

- DeepSeek Harness 需提供 `package.json` 里声明的 peer 包
  （`@deepseek-ai/dsh-session`、`@deepseek-ai/dsh-client-*`、`cordis`、`react` ——
  当前构建面向 `0.1.7-rc.2` 这一代内核）。
- `dsh-log-contract >= 0.3.12`（作为依赖自动安装）。
- 插件通过 `inject` 声明所需宿主能力
  （`sessions`、`agents`、`webServer`、`fs`、`subprocess`、`sandboxPolicy`、`jobs`）。
  缺某个能力只会让对应功能降级（例如没有 `subprocess` ⇒ 回档只用内置快照），
  不影响启动。

---

## 🔒 关闭守卫（防误关丢进度）

退出/重载前先看清还有什么在跑：

| | 是什么 | |
|---|---|---|
| 🛡️ | **运行中检测** | 逐会话扫描运行中工作：agent 正在跑 / inbox 排队 / 后台 jobs / 未闭合轮 |
| 📋 | **运行中横幅** | 有运行中工作的会话显示页面常驻横幅（会话谱系标识 + 原因），退出前可见 |
| ⚠️ | **退出提示** | 插件 dispose（应用退出/重载）时中文提示列出每个运行中会话与原因——只提示，绝不代你取消 agent |
| 🔒 | **页面关闭拦截** | **桌面端一律不武装宿主原生确认框**；改用**页面自绘确认门**：先画框并**同步校验可见**才拦（`preventDefault`），画不出 / 不可见 / 页面不可见 ⇒ **当场放行**；确认框一直等你选择（Esc = 取消）；**看门狗（Web Worker 计时器，不受后台节流）**只作最后一道。关掉设置项「退出确认（关闭守卫）」即退回官方形态（**不用重启**） |
| 🔎 | **查询面** | `retrace.runningState`（host RPC）+ `GET\|POST /api/plugins/retrace/runningState`（HTTP），两入口同形状；全会话形状另带宿主判定的承载面（`surface` / `quitVeto`） |

> **关闭确认的行为（用户可见口径）**：**是否弹宿主原生关闭确认由宿主与页面共同决定**。
> 桌面端**不弹宿主原生框**，改用**页面内自绘确认**（Esc = 取消）。框画不出来 / 框不可见 /
> 页面不可见 ⇒ **当场放行**。把设置里的「退出确认（关闭守卫）」关掉即退回宿主默认形态
> （**不用重启**）。
>
> **已知限制（照实写）**：某些桌面壳的退出口径**根本不经过页面**（如托盘项直接销毁窗口，
> 或点 X 只是隐藏窗口）⇒ 那类壳上「退出时弹确认」**插件侧做不到**，需要**壳提供 seam**
> （`will-prevent-unload` 处理，或退出前的询问钩子）。**桌面端退不掉时**，把设置里的
> 「退出确认（关闭守卫）」关掉即退回官方形态（**不用重启**）。

### 会话谱系标识与显示名（**计划 / 默认关闭**）

谱系标识用于人机协作识别，**身份判定仍以 session id 为准**。通道
（`sessionBadge` / `setBadgeTitle` / `initBadgeTitles` / `badgeMap`，HTTP + harness 两入口）、
解析器与写护栏**均已就位**；但**启动自动写标题那条路默认关闭**
（客户端开关是 `globalThis.__DSH_RETRACE_BADGE_BOOTSTRAP = true`）：

- 会话标题显示为 `[谱系标识] 原标题`——**稳定标识由会话 id 确定性导出**，标题变化不影响它。
- **没有 `session/title` 事件的会话如实留空**（标题只显示 `[谱系标识]`）—— **不回落项目名、不伪造名字**。
- 解析器不可用时退回**原始 session id 占位**。
- 侧栏会话行、运行中横幅、读档点视图的谱系标识**同源**：都取宿主下发的**同一份**映射（宿主 op `badgeMap`）。

> **计划（未上线）**：agent 业务层规划（运行时守护、中断治理、生态开放接口）属**计划**，
> 不是已上线能力。

---

## ⚙️ 设置 → 通用

| 设置项 | 默认 | 说明 |
| --- | --- | --- |
| **编辑后显示原提问对照** | 开 | 重发消息下方的折叠「原输入」引用，显示**最近一次**被替换的原文（仅作对照，不会进入模型上下文）。 |
| **读档点与产物快照** | 开 | 开：每次撤回/编辑自动存一档（消息与触碰文件），提供读档点列表与产物回退；关：仅回退上下文，不存档、不追踪产物（最省资源）。 |
| **给旧内容生成 AI 摘要** | 关 | 开：撤回 / 编辑时多花 1 次小模型调用，为被丢弃的旧内容生成摘要；依赖宿主 `llm` 服务（官方 `@deepseek-ai/dsh-llm`），缺失时自动降级为**只显示逐字原文**。关：**零 LLM 调用**；逐字原文（零 token 成本）**始终产出**。每次操作至多 1 次小调用（输入文本上限 500 字符、输出 ≤200 token、5 秒超时），模型与凭据沿用会话自身的默认选择，插件**不新增任何配置面**。 |
| **启用 git 集成** | 开 | 开：工作区是 git 仓库时用 git 记录与回退（不自动提交、不动你的分支），非仓库可在读档点视图里一键启用；关：一律用内置快照（存于插件数据家），不触碰工作区 git 状态，功能等价。 |
| **读档点保留上限** | 50 | 文件快照只保留最近 N 个读档点，超出自动清理最旧的；读档点记录与审计痕迹始终保留。 |
| **退出确认（关闭守卫）** | 关 | 开：有运行中任务或未完成对话时，页面关闭前由本插件自绘确认框（Esc 等同取消）。默认关，因为这道门也会拦住应用内重载 —— 桌面端口径与自救方式见 [🔒 关闭守卫](#-关闭守卫防误关丢进度)。 |

设置里原有的「按标记隐藏被编辑/撤回的消息」与「编辑后从新对话开始」两个开关已撤除：
撤回/重发/重新生成恒隐藏被替换的内容（单个 marker 要隐藏超过 40% 的对话时降级为只显示提示，
历史永不静默消失），重发恒为「从这条重开」语义，兜底动作如上文所述。

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
2. **重发 / 重新生成**：额外调用 `agent.followup(...)` 发送（新的）提示文本，
   智能体的下一轮请求基于回退后的 `session.deriveMessages()` 构建。
3. **Client**（`lib/client.js`）注册：
   - 每条用户消息下的 `user-actions` 对话节点（重发/撤回行 + 内联编辑器）；
     撤回后把原文回显到输入框，
   - `recall-marker` 节点渲染器：提示行 + 注入 CSS 把被阴影化的消息行从对话流中
     隐藏（视图与模型上下文保持同步），并可显示「原提问」对照块、**「恢复显示」按钮**
     与**「真正恢复」**动作，
   - `conversation.chat.assistant-actions` 中的 `retrace` 入口
     （撤回/重新生成），
   - **「读档点」视图**与 设置 → 通用 中的偏好开关。

> 这里有两个不同层面：**持久化日志**（只追加；旧事件从不被改写或删除）与
> **模型可见表面**（由追加的替换事件回退）。因此旧事件作为审计痕迹留在记录中——
> 但它们会被**同步地从模型上下文和可见对话中清除**，界面始终反映智能体真正看到的内容。
> 因为插件只追加合法、带类型的会话事件，持久化、投影与记录保持一致。（**真正恢复**是唯一
> 会改写日志的操作，且是原地改写、不改 seq 编号。）

---

## 🔺 兼容性与升级须知

`dsh-retrace` 是 **bundle 型插件**：它插进哪套宿主，就依赖那套宿主暴露的面。因此宿主
**移除**一个包或一个客户端服务时，**旧版插件即使一行没改也会坏** —— 而且症状通常是
「起不来」，不是「某个功能看起来不对」。

本节的目的：让你能分清 **宿主侧破坏性变更** 与 **插件侧缺陷**。提 issue 前请先看这节。

### 本插件适配过的宿主侧破坏性变更 —— *不是本插件造成的*

1. **`@deepseek-ai/dsh-session` 移除了 `Session.events` 成员**（`0.1.5-rc.1`）。
   官方支持的读口是 `snapshotEvents(fromSeq, toSeqExclusive)`（冻结、按 seq 索引）、
   `eventAt(seq)`、`ownEvents()`、`isOwnSeq(seq)`。修复前，撤回与编辑点了没反应，并冒出
   `TypeError: Cannot read properties of undefined (reading 'length')`。现在插件经
   兼容访问器读日志（新 API 优先、旧数组回退），两代宿主都能跑。
2. **`@deepseek-ai/dsh-session` 把 `decodeStorageRecord` 从公开导出面拿掉了**
   （`0.1.5-rc.1`；函数仍在内部模块里，但不再从包根导出、exports map 子路径也不可达）。
   本插件自己从未 import 它，但它的依赖 `dsh-log-contract` import 了。宿主不再导出该符号时，
   加载器会以
   `plugin tree failed to load … does not provide an export named 'decodeStorageRecord'`
   中止，而且**整棵插件树一起失败——不只是本插件**，于是 App 起不来。
   → **依赖说明：** 需要 `dsh-log-contract >= 0.3.12`。
3. **一个客户端**服务**消失了：`conversationEvents`** —— 它原先由旧客户端运行时
   `@deepseek-ai/dsh-client-runtime` 提供，而该运行时已被移除。插件的客户端半若仍在
   `export const inject` 里声明它，就**永远不就绪**：fiber 停在 **pending**，宿主据此报
   `renderer boot failed (plugins: …): The client Loader did not provide an error message.`
   —— **一个字的错误信息都没有**，窗口起不来，唯一的进法是把插件禁用。现在该服务已从
   `inject` 中删除，并改在 `apply` 里**防御性解析**（`uiConversation`，取不到则回退旧名）。
   > 注意：在 `dsh.client.inject` 里声明一个**已不存在的包**，**不会**导致启动失败 ——
   > 客户端加载器对认不出的条目是**静默跳过**的。真正致命的是插件等待的那个**服务名**。
4. **客户端会话存储没有 `keys()`**（`ctx.sessions`）。用 `keys()` 枚举会话的插件会**静默地
   看到 0 个会话**：不崩不报，只是安全告警永不触发。现在优先用官方 `list()`、回退 `keys()`；
   刻意**不用**「猜服务字段」兜底 —— 猜出来的空集同样是静默失败。

> 以上四条都是**宿主侧移除**，写在这里是有意的：如果你在**升级宿主之后**立刻遇到这些症状，
> 第一个该问的是「这份插件构建是不是早于这次移除？」，而不是「插件改坏了什么？」。

### 插件侧修复（0.4.26 – 0.4.28）

- **插件数据家与会话基座合并为同一来源。** 此前插件用宿主的 home 解析器
  （`$DSH_HOME` → `~/.dsh`）决定自己的数据目录，而它不认识迁移后的基座。于是当 `$DSH_HOME`
  未设时，**会话从一个基座读、快照与产物库写到另一个基座**。现在快照、版本库与
  `verify-install` 都跟随**活动会话基座**；`$DSH_HOME` 已设时行为不变。
- **不再有任何用户可见文案写死 `~/.dsh`**（设置页原先提示快照存于 `~/.dsh`）。
- **编辑/撤回入口从不出现。** 客户端半区从 `snapshot.chat.nodes` 读聊天节点，而本宿主没有
  这条路径 —— 节点在 `useChat` 的 `snapshot.nodes` 里。所有消息级组件渲染时抛错、被错误
  边界吞掉，于是按钮消失，而不读节点的设置项显示正常。
- **读档点视图里的「跳转」点了毫无反应。** 它经 `store.getSnapshot()?.chat?.nodes` 解析锚点，
  而该路径在此恒为 `undefined`。现在改为用视图注入的 `useChat` 快照解析，并用官方
  `store.loadThrough(seq)` 分页；跳不过去时给出**可诊断理由**（renderer 警告 + 宿主日志行），
  不再静默失败。
- **设谱系标识会冲掉用户标题。** 谱系标识入标题现在**只走服务端** `setBadgeTitle`（从会话日志读当前
  标题）。手动重命名不受影响。
- **宿主侧操作失败重新有日志**（code + message + stack）。此前只把 message 回传界面、不写日志，
  这类问题因此很难从外部诊断。
- **读档点视图现在会自我解释。** 此前只有标题加一排动作，**没有任何一句话说明「读档点」是什么**，
  行内还直接显示裸节点类型。现在有常显的概念解释句、类型图例，以及每行恒有的白话「为什么」行。
- **客户端隐藏判定不再逐行重扫。** `useSeqHidden` 此前每行都重扫节点表
  （实测 2000 行/20 marker **346ms**、3000/30 **1568ms**）。现在复用同一份 per-snapshot
  隐藏计划：分别是 **8.3ms** 与 **18.3ms**，且行为判定与旧谓词逐字等价。

### 升级

```bash
dsh plugin --profile desktop add dsh-retrace@0.4.130
# 然后重启 DSH —— 插件不会热重载
```

**`0.4.27` 与 `0.4.31` 已撤回**（短暂发布后撤回、npm 上标记 deprecated）；它们的替代版本
包含其全部修复。

**不需要数据迁移。** 会话格式未变（v3），不改写任何会话，也不需要重建索引：升级、重启即可。
若宿主仍提供旧成员，兼容访问器会让那些路径继续可用 —— 本构建不丢弃老宿主。

如果**升级后 App 起不来**：一个插件失败就能拖垮整棵树，所以**先恢复、再排查**：

1. 把 `dsh-retrace` 从 profile 的 `dsh.profile.bundles` **和** `dependencies` 里删掉，重启，
   确认能先进得来；
2. 读宿主日志 —— macOS：`~/Library/Application Support/DSH Desktop/logs/host/dsh-<日期>.error.log`；
3. `plugin tree failed to load` 是**宿主侧**；`renderer boot failed` 是**客户端侧**。
   两者都会点名出问题的插件/包 —— 从那里查起。

### 版本固定建议

请固定到确切版本（`dsh-retrace@0.4.130`），并让 `dsh-log-contract` 解析到 `>=0.3.12`。
**不要在跨宿主升级时依赖 `^0.4` 这种范围**：这里的兼容性由**宿主的面**决定，光看 semver 不够。

---

## ⚠️ 要求与限制

- 只有**用户消息**可以重发；撤回同时适用于用户与助手消息。工具结果会随区间一并被阴影化，
  但不能单独作为撤回目标。
- 撤回若指向正在运行的一轮，会**先暂停**它（官方停止入口、有等待上限）。暂停失败/超时也
  照常撤回，并用提示告知。**真正恢复**与回档预览要求会话**空闲**，否则被拒。
- 撤回/重发作用于**活跃模型表面**：已被压缩或此前已撤回的消息会被拒绝
  （`target-shadowed`）；写入尚未 flush 的消息会如实报 `message-pending`（「消息生成中」），
  不再被误判成「已不在活跃对话」。
- 重新生成只重发原提示的**文本**部分；携带图片的提示会退化为仅文本重发。
- **真正恢复**会**原地**改写会话日志（中和两段标记，seq 编号不动）。会话是你当前正在查看的、
  正在运行的，或文件被其他进程持有时，它会拒绝执行；成功后需重开该会话（或刷新）才看到结果。

---

## 🗺️ 路线图

**当前已具备（0.4.x）：**

- 撤回 / 重发 / 重新生成——每次回退都过**三层写前校验**与安全编辑路径（自动停 agent、临时 step 包裹 marker），**新的回退不会损坏日志、不新增 `/compact` 债**；**旧单段 marker 需要压缩前清理**（配套 `check` + `fix --remove-markers`）。
- **撤销**：恢复显示（界面）与真正恢复（日志层面、原地）。
- 单会话**读档点时间线** + **产物回退**（git 优先 + 快照兜底、干跑预览、跳转对话）。
- **关闭守卫**（运行中横幅、退出提示、页面自绘确认门）。
- **实时看门狗**——并发写入第一时间快照日志。
- 配套 **`dsh-log-contract`**：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`），能处理会让 /compact 永久失败的会话。
- 供集成使用的只读宿主面：`retrace/versions`、`retrace/forkmap` 投影，
  `GET /api/plugins/retrace/{versions,forkmap,lineage,event,surface,doctor,snapshot}`，
  `POST /api/plugins/retrace/{rollback/preview,rollback,git/init}`，以及谱系标识操作
  （`sessionBadge` / `setBadgeTitle` / `initBadgeTitles` / `badgeMap`）与 `retrace` CLI（见文末）。

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
pnpm install          # 安装开发依赖（vitest、esbuild）；需要 Node >= 22.13
pnpm check            # 语法检查源码与生成的动态入口
pnpm build            # 重新生成 lib/dynamic-*.js 与 lib/client.bundle.js
pnpm test             # 运行单元测试
npm pack --dry-run    # 校验发布文件清单
```

> ⚠️ **生成文件。** `lib/dynamic-host.js`、`lib/dynamic-client.js` 与
> `lib/client.bundle.js` 是由 `lib/host-core.js` 和 `lib/client.js` 生成的构建
> 产物 —— **请勿手改**。CI 会在构建产物与源码不同步时失败
> （`git diff --exit-code`），因此提交前记得执行 `pnpm build`。动态 Client 与
> 发布版共用同一份 client 源码，仅通过 `__setMessageEditorWire` 切换传输层
> （`host.call` vs HTTP 路由）。

欢迎提交 PR 与 issue —— `CONTRIBUTING.md` 筹备中；问题追踪入口见本包
`repository`/`bugs` 元数据里的链接。

---

## 📚 生态

收录于 [dsh-plugin topic](https://github.com/topics/dsh-plugin)。

**Agent 业务层（生产级保证）** 的一部分——即 dsh-retrace 在 DeepSeek Harness 上实现的
那层框架无关的业务层定义。配套组件：

- [**dsh-log-contract**](https://www.npmjs.com/package/dsh-log-contract) —— 业务层的
  「医生」：30+ 条离线契约规则 + 原地修复（`fix --neutralize` / `--clip-crossstep`）。
  作为依赖自动安装，也独立发布供直接使用。

> **直接从 git 安装**（无需 npm registry —— 适合把本仓库链接丢给 AI，或想装最新提交）：
>
> ```sh
> dsh plugin --profile desktop add github:<owner>/dsh-retrace
> # 或直接用 pnpm 装进 profile：
> cd "$DSH_HOME/profiles/desktop" && pnpm add github:<owner>/dsh-retrace
> ```
>
> `<owner>` 取本包 `repository` 字段里的 owner。然后照常重启 DSH Desktop，
> `dsh-log-contract` 依赖会自动带上。

DeepSeek Harness 插件生态的精选总览见
[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（第三方收录，使用前请自行确认可用性）。

---

## 👥 团队

由 [OfferKuai](https://www.offerkuai.com) 团队开发——一款 AI 求职助手，使命是
「用户要的是结果，而不是反复的对话」。本插件以开源形式发布，回馈 DeepSeek Harness 社区。

## 📄 License

MIT

---

## 🧭 会话日志考古（retrace CLI）

DSH 会话日志持久化了每次工具调用的完整输入输出——数据资产与审计资产。
`retrace` CLI 提供只读考古能力（复用 dsh-log-contract 的契约与提取）：

```sh
retrace index <session>                        # 工具调用索引
retrace query <session> --cmd "seed-scale"     # 按命令正则查输出
retrace extract <session> --pattern "seed-scale" --out ./found   # 导出输出
retrace file-history <session> <path>          # 文件 write/edit 历史版本
retrace file-diff <session> <path> 0 5         # 两版本行级 diff
retrace lineage <session>                      # 会话 parent 链谱系
```

`<session>` 为完整日志路径或 sessionId（自动在**活动会话基座**查找：`$DSH_HOME/sessions`，
否则更新的基座，最后才是 `~/.dsh/sessions`）。全部只读。

**会话谱系**：`GET /api/plugins/retrace/lineage?sessionId=` 沿当前会话的
`parentSession` 接续链遍历（只读、带环保护），与 CLI `retrace lineage` 同一语义 ——
任何客户端都能查到「这个会话是从哪个会话接着干/分叉出来的」，也是分叉拓扑的元数据源。
