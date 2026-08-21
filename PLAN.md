# 实施方案:dsh-retrace — 会话与产物版本化管理插件(2026-08-20 官方文档重审修订版)

> 状态:**方案已重审,待确认开工**(2026-08-20)。本文为 v0.3 修订版:基于官方文档
> [`reference/`](https://deepseek-harness.github.io/deepseek-harness/reference/) 与
> [`develop/basic/`](https://deepseek-harness.github.io/deepseek-harness/develop/basic/)
> 重审后的实施方案;旧版(P0 手写 VersionIndex 服务 + 自建 jsonl 索引)作废。
> 功能规划(原始需求对照 + 新增方向 + 生产级架构)见 **`dsh-retrace-function-plan-v2.md`**(v2,2026-08-20,9 份调研支撑)。
> 阶段进度见 [CHANGELOG.md](./CHANGELOG.md),逐功能开发记录见 [DEVLOG.md](./DEVLOG.md)。
> 范围:从"消息编辑插件"升维为 **Harness 增强插件**——单会话内的**上下文回退 + 产物版本化 + 时间线 + 分叉图/思考流 + 导航跳转**。
> 差异化:Moeblack(dsh-message-edit)走"跨会话分支";我们走"**单会话内版本化**",不换会话身份,产物可回退,时间线即对话走过的路径。

---

## 0. 本轮修订说明(为什么改方案)

重读官方文档后,原方案的三处"自造轮子"全部有官方能力可替代,架构简化为
**"纯折叠投影 + 副作用存储 + 官方查询"** 三段式:

| 原方案(自造) | 修订后(官方能力) | 收益 |
|---|---|---|
| Host 手写 `VersionIndex` 服务:`ctx.on('session/created\|event\|flush\|disposed')` 四订阅 + 自建 `~/.dsh/dsh-retrace/index/<sessionId>.jsonl` 水印增量 + 启动重放对齐 | **`ctx.sessionProjections` 投影单元**(`dsh-session-projection`,dsh-base 默认挂载;`dsh-session-projection-cache` 由 dsh-web-app 挂载,`writeEveryEvents:200 / writeIntervalMs:5000`):框架**单次订阅** `session/event` 驱动每个单元的纯同步 `apply`;旧会话惰性从 `init` 折叠;持久化缓存(checkpoint 于 turn/end + 会话销毁 + 节流 write-behind)与冷读阶梯(cached row → `readFrom` 尾 → `restore`)**全部官方实现**;客户端经 `dsh-host-apiproxy` 的 **`session/projection` 推送帧**拿成品值,零轮询 | 删掉整个持久化/重放/对齐自研面;崩溃恢复、HMR、跨进程一致性交给框架 |
| 元数据存 `~/.dsh/storages/<plugin>.json` 或"自建域" | **`ctx.storageDomain` 类型化领域**(`defineDomain` + zod schema + `KvTable` + `domain/changed` 事件;web 组合默认 `storage-json` 后端于 `$DSH_HOME/storages`) | 类型安全、schema 校验、耐久写链、变更事件 |
| 快照"`ctx.fs` 写 `~/.dsh/dsh-retrace/snapshots/`" | **attachment-local 同款内容寻址文件**:`$DSH_HOME/dsh-retrace/objects/<sha256[:2]>/<sha256>`,tmp 暂存 + fsync + hardlink + 完整性校验(逐字照搬官方 `dsh-attachment-local` 的 `saveImageFile` 模式)。注意 **`ctx.fs` 受工作区沙箱约束,不能写 `$DSH_HOME`**;插件自有目录由宿主 `node:fs` 直接管理(与 attachment 一致),工作区内的写/删才走 `ctx.fs`/`ctx.subprocess` 围栏 | 内容寻址天然去重;宿主侧不绕过任何用户审批面(写的是插件自己的目录) |
| 分叉图"自解析旧路径→新路径" | **`ctx.sessionQuery.traceEvent`** 官方关系追踪:`replacedBy / replacementChain / replacedEventSeqs / sourceEventSeqs / derivedEventSeqs`;surface 分类用 `filterEvents([{kind:'surface',values:['shadowed']}])` 或 `readSurface()` | 分叉边、被遮蔽节点、引用链全部官方给出 |
| 手写 surface 重放 | **`foldSurface(events)`**(`@deepseek-ai/dsh-session` 导出,已核实)返回 `{nodes, replacements[]}`,与模型历史推导同一套状态转换;另导出 `isReplacementSurfaceEvent` 可直接判边界 | 回退目标 surface、messageRefs 派生与官方完全一致 |

其余 API 校正(均已对照官方文档核实):

- flush 入口:**`ctx.sessions.flush(session)`**(官方唯一入口,禁止裸发 `ctx.parallel('session/flush')`)。
- compaction 检查点识别:不用启发式,用 **`isCompactCheckpointSource()` / `compactCheckpointSource()`**(`@deepseek-ai/dsh-compaction/checkpoint` 子路径,host 与 client 均可导入;已核实存在)。
- 沙箱策略:**`ctx.sandboxPolicy.resolve({session, mode})`** → `{mode, workspaceRoot, sessionId}`;`ctx.fs.writeText(target, content, expected, signal, sandboxPolicy)` 的 `sandboxPolicy` 是最后一个形参。
- 子进程:**`ctx.subprocess.spawn({argv, cwd, stdio, graceMs, signal, env})`**(显式全量 spec;argv 不经 shell)。
- 会话标题:官方 `ctx.sessionTitle` seam 已内置,时间线直接复用 `sessionQuery.readTitleSnapshot`。
- 跳转锚点:`data-chat-anchor-key` 已核实存在于 `dsh-client-ui-conversation`;`@tanstack/react-virtual` 已在依赖树。
- 空 `assistant/message` 在 `deriveMessages()` 中被跳过(官方投影规则)——**L1 的"空标记回退"机制被官方语义背书**,保留。

---

## 1. 命名与定位

### 1.1 名称(已定)

- **dsh-retrace(Retrace · 回溯)** ✅ 已采用(package.json / README / CHANGELOG 已换新)。
- 显示名:**Retrace · 回溯 — Conversation & artifact versioning for DeepSeek Harness**。

### 1.2 包名策略(已定:B — 迁移新包名)

- 新包名 **`dsh-retrace`**(0.3.0 起);旧包 `dsh-message-editor` 冻结在 0.2.2,不再更新。
- 采用面小(几乎无人使用),迁移成本低;旧包 README 指引迁移。
- 残留改名动作(**步骤 0**,开工第一件事):
  1. 目录名 `dsh-message-editor` → `dsh-retrace`(`git mv`,仓库内所有相对路径引用不受影响)。
  2. `git remote set-url origin <dsh-retrace 新仓库地址>`(当前仍指向 `azmavethy/dsh-message-editor.git`)。
  3. `git grep -i message-editor` 全仓清零(路由/前缀已换,查漏)。
  4. 旧包 `dsh-message-editor` 发 0.2.3 仅更新 README 迁移指引(deprecation note)。

### 1.3 产品定位(2026-08-20 调研定稿:产品导向,非竞争导向)

> 不做"对标竞品/填补空白"的竞争导向产品。**出发点 = 官方 DSH 能力 + 我们自己的想法 + 开源生态的代码与逻辑 + 市面 AI 产品(对话与任务处理便利性)的体验思路**,做专业、好用、面向开发者的产品;差异化来自**复合能力**或**某个方向的明显优势**,竞争是结果不是目的。调研详见 `dsh-retrace-research.md` §5。

**产品定义:dsh-retrace = DeepSeek Harness 的"对话与任务处理增强层"**。以官方事件日志为唯一事实源,把开发者与 agent 协作中的高频动作——改话重问(编辑重发)、重跑、撤回、对比、回退、保存点——统一为一个**可追溯、可预览、非破坏性**的时间线与分叉视图,让开发者"放心试、随便改、随时回、看得懂"。

**构建配方(官方 × 开源 × 市面)**:

| 产品能力 | 官方底座 | 开源借鉴 | 市面 UX 参考 |
|---|---|---|---|
| 撤回/编辑重发/重新生成 | `surfaceOp: replace` + `sessionProjections` | gptme 编辑即分支、ably `forkOf` | prompt 回填重发(Claude Code/Cursor);翻页器保旧稿(Claude.ai) |
| 产物快照/对比/回退 | `ctx.fs` + `ctx.sandboxPolicy` + `storageDomain` | Cline/Roo shadow git + Compare/Restore;attachment-local 内容寻址 | hover Restore(Cursor)、per-file diff 预览(Copilot CLI) |
| 统一时间线 | `sessionQuery.readEvent/readSurface` | LangGraph checkpoint 链 | Local History(JetBrains/VS Code) |
| 分叉图 | `sessionQuery.traceEvent` | gptme/ably 对话树、恢复即分叉 | (我们的想法) |
| 保存点/命名版本 | 投影持久化缓存 | — | Windsurf/Gemini 命名 checkpoint |
| 任务恢复便利 | `agent.followup`、turn/step 事件 | OpenHands 事件流 | Gemini `/restore` 重提原工具调用 |

**差异化 = 复合能力 + 单点明显优势 + 体验优化**:
- 复合:对话编辑/重发/重跑 × 产物快照/对比/回退 × 统一时间线 × 分叉图 × 保存点,一个会话内一套版本模型(DSH 生态与市面均无完整组合);
- 单点优势(结构性):DSH 是事件日志架构,站在官方原语上做"对话↔产物联动、非破坏性(回退即分叉)、可审计"的回溯,是官方能力自然长出的优势(市面产品因架构限制做不了);
- **体验优化(第三重,开发者生态最稀缺)**:开发者生态插件多为"开发者思路"——功能堆砌、不考虑体验。我们把体验优化当作差异化本身:不一定是 UI,而是易用性(可发现、可达、不打断)、**解决之前的别扭点**、**用已有能力做新的流程/新用法**(清单见 §5.0 与调研报告 §5.4)。

### 1.4 明确不做

- **不做跨会话分支**(新会话版本):那是官方 `ctx.sessions.fork(source, boundary?, childSessionId?)` 原语与跨会话路线的选择。我们坚持"同一会话内",避免会话身份漂移(会话列表不膨胀,时间线=该对话真实路径)。
- **不做日志改写/删除**:永远 append-only;所有"回退"都是追加 replace 阴影 + 可选内容重放。
- **不把竞品当敌人**:Moeblack 跨会话模型有"原会话永不改"的强保证,是不同取舍;我们靠"单会话内 + 产物回退 + 非破坏分叉"的组合价值立足,不贬低任何方案。

---

## 2. 总体架构

```
┌─ Client(浏览器,Web + Desktop 共用)──────────────────────────────┐
│ 时间线浮层(版本列表来自 session/projection 推送帧,零轮询)          │
│ 分叉图(P2)/ 设置 / 节点详情抽屉 / 跳转高亮(data-chat-anchor-key)   │
│   ▲ ctx.sessions.binding(id).session + s.chat.timeline          │
│   ▲ @tanstack/react-virtual(依赖树已有)                          │
└──────────┬──────────────────────────────────────────────────────┘
           │ ① 版本列表:session/projection 推送帧(apiproxy 载体)
           │ ② 详情/操作:HTTP /api/plugins/retrace/*
┌──────────▼──────────────────────────────────────────────────────┐
│ Host(Electron 主进程 / dsh 进程)                                 │
│  A. retrace/versions 投影单元(ctx.sessionProjections.register)    │
│     纯同步折叠:版本边界 / 触碰文件窗口 / surface 折叠(与 foldSurface │
│     同状态转换);框架驱动 + sessionProjectionCache 持久化           │
│  B. 副作用服务(ctx.sessionProjections.onChanged 驱动,异步)         │
│     ArtifactStore: 内容寻址快照 → $DSH_HOME/dsh-retrace/objects/  │
│     GitAdapter:   commit-free 记录 / init / checkout(只读走        │
│                   ctx.subprocess,写操作需用户确认)                 │
│     Rollback 执行器: 先快照→干跑预览→确认→ctx.fs/ctx.subprocess    │
│     围栏执行→hash 校验                                             │
│  C. ctx.storageDomain 领域 retrace: refCounts + 全局配置          │
│  D. ctx.sessionQuery: readEvent/readSurface/traceEvent/          │
│     filterEvents/readSession(惰性读原文、分叉边、shadowed 分类)     │
└──────────────────────────────────────────────────────────────────┘
```

**原则**:版本索引**从日志派生**(官方投影注册表驱动,可随时从 `init` 重建;持久化缓存仅作加速);
快照/元数据是增强,不是权威;破坏性操作一律"先快照 → 确认 → 经围栏 → 校验"。

---

## 3. 数据模型

### 3.1 事件词汇(全部对齐官方,不用虚构类型)

| 概念 | 真实事件/字段 |
|---|---|
| 回合边界 | `turn/start` / `turn/end`(`TurnEndReasonMap`:completed/aborted/blocked/error/max-tokens/interrupted) |
| 用户输入 | `user/message`(`source` 区分真人/注入/目标续跑) |
| 思考 | `assistant/message.data.message.content` 内 `{type:'reasoning', text}` 块;流式 `assistant/chunk.chunk.type==='reasoning-delta'` |
| 回复 | `assistant/message`(空内容者被 `deriveMessages` 跳过 — 我们的标记机制) |
| 工具 | `tool/call`(`arguments` 为原始 JSON 串)/ `tool/result`(失败带 `error`;`dsh-tool-fs` 在 `meta` 携带结果时刻的上下文 diff) |
| 我们的回退标记 | 追加的 `assistant/message` 空标记,`surfaceOp:{op:'replace',start,end}` + `sourceEventSeqs=被遮蔽 seq` + `data.editor:{targetSeq,text}`(前 2000 字,防压缩后丢失摘要) |
| 系统压缩 | `compaction/start\|summary\|end`(log-only,`summary` 带 `shadowedSeqs/shadowedRange`)+ 替换检查点 `user/message`(`isCompactCheckpointSource` 可官方识别) |

### 3.2 投影状态 `retrace/versions`(客户端可见;纯 JSON,可被缓存持久化)

```ts
interface VersionRecord {
  sessionId: string
  versionId: string            // `v<seq>` — 与标记事件 seq 绑定
  boundarySeq: number          // 版本边界(标记事件 seq;首版本 = firstLiveSeq-1)
  createdAt: number
  kind: 'recall' | 'edit' | 'regenerate' | 'restore' | 'compaction' | 'replace'
  markerText?: string          // 被回退内容摘要(editor.text 前 2000 字;compaction 为摘要前 N 字)
  touchedFiles: FileChange[]   // [prevBoundary+1, boundary] 窗口解析
  messageCount: number         // boundary 时刻 surface 节点数(时间线列表用,避免存全量 refs)
  git?: { headHash: string; dirty: boolean; diffSha?: string }
}
interface FileChange {
  path: string                 // 相对会话 cwd 的规范路径
  mode: 'created' | 'modified' | 'deleted'
  contentHash?: string         // 快照内容寻址(created/modified)
  sizeBytes?: number
  snapshotSkipped?: 'too-large' | 'binary' | 'unreadable'
}
interface VersionIndexState {
  versions: VersionRecord[]    // 上限 N(默认 200,超限截断最旧;完整历史可经日志重放,不丢事实)
  windowFiles: Record<string, { intent: 'write'|'unknown'; lastSeq: number }>
  surface: number[]            // 当前 surface 节点 seq(与 foldSurface 同状态转换,边界时用于计数)
  lastSeq: number
}
```

- **messageRefs 不全量存**:时间线列表只需 `messageCount`;回退/详情需要全量 surface 时,**惰性** `foldSurface(events.slice(0, boundarySeq+1))`(经 `sessionQuery.readSession` 或 `session.events`)。
- 投影状态就是缓存(checkpoint 行 `(sessionId, key, ver, seq, val)`),**不再自建 jsonl 索引**。

### 3.3 元数据与快照存储

```
$DSH_HOME/dsh-retrace/objects/<sha256[:2]>/<sha256>   # 快照:内容寻址文件(attachment-local 同款)
storageDomain 领域 retrace(version 1):
  table refCounts: hash → { refs: string[] }          # 引用计数(跨版本共享,GC 用)
  global: { retentionLimit: number, gitEnabled: boolean }  # 全局配置
```

- 原文/全文不落库:经 `sessionQuery.readEvent` / `readSession` 惰性读。
- 快照写失败仅标记 `snapshotSkipped`,版本记录照常;回退时提示"该文件无快照,走 git 或无操作"。

---

## 4. Host 实现细节

### 4.1 `retrace/versions` 投影单元(核心,P0)

```js
ctx.inject(['sessionProjections'], (ctx) => {
  ctx.sessionProjections.register({
    key: 'retrace/versions',
    stateSchema: versionIndexStateSchema,   // zod
    init: () => ({ versions: [], windowFiles: {}, surface: [], lastSeq: -1 }),
    apply(state, event) { /* 纯同步折叠 */ },
    stateVersion: 1,                        // 序列化字段/折叠语义变化时 bump
    wire: { viewSchema, view(state) },      // 客户端成品值:版本列表摘要
  })
})
```

`apply` 折叠规则(与模型历史推导同一套状态转换):

1. **surface 维护**:`append` → `surface.push(event.seq)`;`replace` → 用 `event.seq` 替换 `surface` 中 [start..end] 区间(与 `foldSurface` 一致;start/end 是 surface 位置跨度,可能 start>end)。
2. **窗口归集**:`touchedFilesFromEvent(event)`(纯函数,见 §4.2)更新 `windowFiles`。
3. **边界检测**:`isReplacementSurfaceEvent(event)`(官方导出)→ 分类:
   - `data.editor` 存在 → 我们的标记,按 marker id 前缀(`retrace-<op>-…`)取 kind;
   - `isCompactCheckpointSource(event.data)` → `compaction`(同时可配 `compaction/summary.shadowedSeqs` 丰富展示);
   - 其他 replace → `replace`(未来其它 surface 替换方)。
   边界时**冻结 VersionRecord**(`messageCount = surface.length`)、清空 `windowFiles`;非本单元事件**返回同一 state 引用**(零下游工作)。
4. **未变化即同引用**——这是投影注册表的性能契约。

框架接管:单次 `session/event` 订阅、旧会话惰性折叠(`init` 起重放)、checkpoint(turn/end + 销毁 + 节流)、冷读(`sessionProjectionCache.coldSnapshot`)、崩溃恢复。**不注册任何 `session/*` 事件监听**(官方要求:领域不持有订阅)。

### 4.2 触碰文件解析(纯函数,P0)

- 窗口 = `[prevBoundarySeq+1, boundarySeq]`。
- 提取优先级:`tool/result.meta`(dsh-tool-fs 的结果时刻 diff 权威)→ `tool/call.arguments` JSON 解析(白名单工具:`fs.write/edit/create/append/remove/rename/copy`、`edit`、`patch`、`apply-patch`、`bash` 的 `cwd`+命令启发式)→ 结果文本启发式(仅前两者缺失时)。
- 失败 `tool/result`(`error` 存在)不产生产物变更。
- 归一化:`ctx.fs.resolve` + `ctx.fs.contains(workspaceTarget, target)` 校验在工作区内(`session.header.cwd` realpath 前缀)→ 相对路径;默认跳过 `node_modules/`、`.git/`、`$DSH_HOME/`。
- mode 判定:与上一版本该文件记录对比(created/modified/deleted);首版本"出现在窗口=created"。

### 4.3 ArtifactStore(快照副作用,P0)

- **驱动**:`ctx.sessionProjections.onChanged((session, key, value, seq) => …)`,仅当 `key==='retrace/versions'` 且出现新版本时触发;**不在 apply 内做**(apply 必须同步纯函数)。
- 对 `touchedFiles` 读内容:`ctx.fs.readBytes(target, signal, 4MB)`(超限/二进制 → `snapshotSkipped`);sha256 → 写 `$DSH_HOME/dsh-retrace/objects/<sha[:2]>/<sha>`(attachment-local 同款:tmp 暂存 + fsync + hardlink + 完整性校验;宿主 node:fs,插件自有目录)。
- 引用计数:domain `refCounts` 表维护;**GC**:`retentionLimit`(默认 50)超限时删除 `refCount===0` 且不再被任何保留版本引用的对象;元数据与时间线记录永不清。
- 失败降级:写失败仅告警,版本记录照常;下次 checkpoint 自愈。

### 4.4 GitAdapter(可开关,P1)

| 工作区状态 | 行为 |
|---|---|
| 已是仓库(含外层仓库) | **commit-free**:版本边界时 `git rev-parse HEAD` + `git status --porcelain`(只读命令,`ctx.subprocess.spawn({argv, cwd, stdio:collect, graceMs})`);回退=`git checkout <headHash> -- <清单内路径>`(写命令,需用户确认);不自动 commit、不动分支 |
| 非仓库 | 快照兜底;时间线面板"启用 git 版本管理"按钮 → 确认 → `git init` + 最小 `.gitignore`(经 `ctx.fs.writeText` 走工作区沙箱)+ 版本记录写专用引用 `refs/dsh/versions`(不动默认分支),可随时删除引用恢复原状 |
| 开关关闭 | 一律快照,不检测、不执行任何 git 命令 |

- 全部 git 经 `ctx.subprocess`(先 `resolveExecutable('git')`);只操作清单内路径;输出大小限制(spill)。

### 4.5 Rollback 执行器(P1)

请求 `{versionId, scope: 'context'|'artifacts'|'both'}`:

1. **上下文回退**(复用 L1 host-core 原语):目标版本 surface = `foldSurface(events.slice(0, boundarySeq+1)).nodes`(惰性);当前 surface = `session.surface.nodes`;差集 = 目标之后的全部节点 → 追加一个 `assistant/message` 空标记 `replace [差集首 seq, 差集尾 seq]` + `sourceEventSeqs=差集` → (可选)以该版本最后一条用户输入 `agent.followup` 重发。语义即 git checkout 旧提交:新内容仍在日志/时间线可见为"后续版本"。
2. **产物回退**:对 `touchedFiles`:
   - git 可用 → `git checkout <headHash> -- <paths>`(仅清单路径,经 ctx.subprocess + 确认);
   - 否则 → 快照读回(sha 校验)→ `ctx.fs.writeText(target, content, {kind:'replaceIfVersion', version: await ctx.fs.stat(target)?.version}, signal, ctx.sandboxPolicy.resolve({session, mode:'workspace-write'}))`(官方围栏+CAS);
   - 需删除的文件 → `ctx.subprocess` 执行 `rm`,前置护栏:realpath 在工作区内 **且** 在清单内。
3. **安全顺序**:先快照当前状态 → 干跑预览(将移除 N 消息 / 影响 M 文件)→ 用户确认 → 执行 → 内容 hash 校验。
4. **幂等**:per-session 锁;操作记录为版本(kind='restore'),可审计可再回退。

### 4.6 HTTP 面与配置消费(P0 收尾)

- 路由:`ctx.webServer.register` `/api/plugins/retrace/*`(沿用现有 `inject:['sessions','agents','webServer']` 模式):
  - `GET /versions?sessionId=`(投影推送不可用时的降级)、`GET /event?sessionId=&seq=`(`sessionQuery.readEvent`)、`GET /surface?sessionId=`(`readSurface`/`filterEvents` shadowed 分类)、`POST /rollback`、`POST /git/init`、`GET /snapshot?path=`(详情用)。
- 配置:client 侧 localStorage 随请求携带(`{versioning, git, retentionLimit}`),Host 以请求为准、不持久化(简单可靠);后续可迁 `ctx.settings` 服务端设置。
- 关闭 `versioning` 时:不注册投影单元/副作用,行为退化为 0.2.x 纯上下文回退(L1 不动)。

---

## 5. Client 实现细节

### 5.0 UX 设计原则(市面 15 条已验证 UX 内化,调研 §4.2)

面向开发者,回退/重生成不打断工作流:

1. **回退三选**:回退动作给"仅对话 / 仅产物 / 两者"(Claude Code、Gemini CLI、Copilot CLI 一致)——时间线节点回退、产物回退分开入口。
2. **prompt 回填重发**:撤回/编辑后,原输入回填 composer 可直接改完重发(我们的 L1 已实现,保留)。
3. **hover 内联入口**:hover 消息 → 内联 撤回/编辑/重新生成/查看版本(Cursor/VS Code/Windsurf 模式)。
4. **回退前预览**:per-file diff / 增删行数 / 影响文件数,确认后再执行(Copilot CLI 模式)。
5. **保护手动编辑**:回退产物时跳过用户自改过的文件、symlink、只回退 AI 工具改动(官方 fs 版本守卫 + 我们的清单机制)。
6. **重生成翻页器保旧稿**:重新生成保留旧稿可翻回(Claude.ai "1 of N";ChatGPT 移除后社区反弹)——我们的版本标记天然保留,时间线可回。
7. **命名保存点**:Windsurf/Gemini 命名 checkpoint(P2)。
8. **快捷入口**:时间线/回退有键盘与/命令入口(如 `/retrace`),不依赖鼠标。
9. **恢复=重提原工具调用**:产物回退后可选"重跑该版本最后输入"(Gemini `/restore` 模式,P2)。
10. **不打断**:操作异步、无感;失败仅提示可重试(官方 append/投影失败不阻塞会话)。

**别扭点解决清单(体验差异化 A 面,来自调研实锤)**:单会话内不膨胀会话列表(Moeblack #15);标记事件首版带 `ignorable`(Moeblack 三版未修);严格作用域避免 UI 误伤(#10);回退先预览后确认(Windsurf"irreversible"教训);旧稿永不丢(ChatGPT 翻页器反弹教训);分叉图替代难懂的分支列表(LibreChat #2908);时间线回答"会话发生过什么";编辑重发保留上下文 + prompt 回填。

**新流程/新用法清单(体验差异化 B 面,官方能力重组)**:① 撤回即回到过去(对话+产物一体);② 从旧版本继续(回退+编辑重发);③ 任务保存点(命名版本=里程碑,失败一键回);④ 复盘/审计(带版本注解的时间线导出);⑤ 版本对比(对话+文件 diff 并排);⑥ 理解拓扑(分叉图回答"怎么走到这里的")。

### 5.1 时间线面板(浮层,P1)

- **形态**:注册 `conversation.session.header.actions` 按钮(order≈30)+ **浮层面板**(非视图环标签页)。
  - 原因(调研结论):视图环一次只渲染一个视图,标签页激活会**卸载 chat**,无法 scrollIntoView;且无公共 API 切回 chat。浮层保持 chat 挂载 → 跳转一步到位。(P2 可另注册 `conversationViews.register({target:'timeline', …})` 全页视图,trajectory 先例,作为可选项。)
- **数据源**:
  - 版本列表:**session/projection 推送帧**成品值(实时,零轮询);降级走 HTTP `GET /versions`。
  - 节点原文:HTTP `GET /event`(`sessionQuery.readEvent` 惰性读,支持 before/after 上下文窗口)。
  - 消息/工具/思考节点:`s.chat.timeline`(turn/step 树,已核实)+ 版本索引;被回退消息灰显(投影状态 surface 或 `filterEvents surface=shadowed`)。
- **渲染**:自带 `@tanstack/react-virtual`(依赖树已有,trajectory 内联先例,>100 节点开启)。
- **节点内容**:
  - 版本节点:操作类型图标(撤回/编辑/重生成/恢复/压缩)、时间、`markerText` 摘要(被回退内容)、产物变更徽标(`+3 -1 个文件`)、git 头哈希(启用时)。
  - 消息节点:截断输入/输出 + 状态(成功/失败/被回退灰显)。
  - 思考节点:reasoning 块摘要(首 N 字;LLM 摘要缓存,一次生成一次缓存,P2.2)。
- **详情与跳转**:
  - 点击节点 → 详情抽屉:原文全文(输入/输出/思考)经 HTTP `readEvent` 惰性加载。
  - "跳转到对话":计算 chat 节点 key(`14:assistant-step{turn}:{step}` / `13:input-message{id}` / 按 anchorSeq 在 `s.chat.nodes` 定位)→ 目标在已加载窗口外则循环 `session.loadOlder()`(50/页)直至出现或 `hasMore=false` → `document.querySelector('[data-chat-anchor-key="…"]')?.scrollIntoView({behavior:'smooth', block:'center'})`(属性已核实)→ 注入短时高亮 CSS。
- **样式**:沿用 `<style data-plugin="dsh-retrace">` 纯 CSS + `--dsw-alias-*` 变量。

### 5.2 分叉图/思考流(P2)

- **骨架**:`s.chat.timeline` turn/step 树 + 版本索引(标记 = 分叉点)+ **`ctx.sessionQuery.traceEvent` 官方关系**(`replacedBy/replacementChain/replacedEventSeqs`,旧路径→标记→新路径 的链接,无需自解析)。
- **节点**:回合(输入→思考→输出→工具链折叠);边:推进;分叉点:标记节点,显示"此处回退:旧路径(阴影区间) vs 新路径"。
- **渲染**:SVG 连线 + 小图元卡片;节点摘要 + 点击详情/跳转(复用 5.1 机制);大图虚拟化。
- **思考流对应**:每个回合节点内嵌思考概要;折叠展开完整 reasoning 块;与时间线同源数据,保证"图上看到的=对话真实发生的"。

### 5.3 设置(已完成 UI,待接逻辑)

- 三个新开关 + 说明已落地(`versioning` / `git` / `retentionLimit`)。
- 新增(时间线面板内):非仓库时的"启用 git 版本管理"按钮(确认后调 Host 执行 init)。
- 配置在 P0 收尾接入 Host 消费(§4.6)。

---

## 6. 防膨胀设计(四层)

| 层 | 对策 |
|---|---|
| 文件快照 | 内容寻址去重(attachment-local 模式);只快照触碰文件;保留上限 GC(默认 50);存 `$DSH_HOME` 不落工作区 |
| 投影状态/日志 | 状态只存引用与计数(`messageCount`/`contentHash`),原文惰性读;版本列表截断(N=200,完整历史可重放重建);marker 自带 `editor.text` 摘要 |
| 客户端内存 | 虚拟列表 + 详情惰性加载;投影推送帧即成品值,不做二次扫描 |
| LLM 调用 | 摘要生成一次缓存一次;不重复计算;不重发提示词(P2.2) |

---

## 7. 可靠性设计

| 风险 | 对策 |
|---|---|
| 索引与日志脱节 | 索引=日志派生的投影单元;`stateVersion` 语义化 bump;`sessionProjectionCache` 冷读阶梯(cached → readFrom 尾 → restore)官方实现;崩溃截断由缓存 ladder 检测并整读重折 |
| 崩溃丢事件 | 与 DSH 现有保证一致(≤200ms write-behind,torn tail 自动修复);投影 checkpoint 随 turn/end/销毁/节流,不引入新的丢失面 |
| 破坏性回退 | 先快照当前 → 干跑预览 → 确认 → 经 `ctx.fs`(sandboxPolicy 围栏+CAS+原子写)/`ctx.subprocess`(清单路径+realpath 护栏)执行 → hash 校验 |
| compaction 共存 | 官方 `isCompactCheckpointSource` 识别;`compaction/summary.shadowedSeqs` 展示"已压缩";`editor.text` 保证摘要可显示 |
| 权限越界 | 快照只写 `$DSH_HOME/dsh-retrace/`(插件自有目录);工作区写/删一律走 `ctx.fs`/`ctx.subprocess` + `sandboxPolicy.resolve`;绝不裸 node fs 写工作区(会绕过全部沙箱与审批) |
| 动态插件差异 | 本方案仅支持组合型 Host 插件(主进程);动态插件(受限 realm)保持现状,文档说明 |
| 投影单元异步陷阱 | apply 必须同步纯函数;快照/git 全部移到 `onChanged` 副作用,失败仅告警 |
| 性能 | 千级会话:虚拟化 + 投影推送 + 首屏列表形态;分叉图 P2 先列表后图形 |

---

## 8. 开发与 Git 规范(开工即生效)

> 目的:任何时刻可回溯、可修改、可审计。以下规范从步骤 0 起执行。

### 8.1 仓库与记录文件

- `CHANGELOG.md`(Keep a Changelog):每次发布记录用户可见变更。
- `DEVLOG.md`(新增):**逐功能开发记录**——每条:目标 / 方案 / 涉及文件 / 关键决策 / 验证方式 / 遗留问题。每完成一个功能单元即追加,与提交一一对应。
- 提交信息遵循 **Conventional Commits**:`feat(scope): …` / `fix(scope): …` / `refactor` / `docs` / `test` / `chore`,一行动机 + 必要正文说明"为什么"。
- 分支策略:`main` 为发布线;每阶段开 `feature/p0-*`、`feature/p1-*` 等分支,完成后 squash 合并回 main;里程碑打 tag(`v0.3.0` …)。
- 生成文件纪律:`lib/dynamic-*.js`、`lib/client.bundle.js` 是构建产物,`pnpm build` 后提交,CI 校验 `git diff --exit-code` 防陈旧。
- 提交前门禁:`pnpm check && pnpm build && pnpm test`。

### 8.2 代码全量替换范围(如需)

新架构下,以下文件**整体重写/新增**(L1 撤回/编辑/重生成保持不动,已线上验证):

- 重写:`lib/version-index.js`(手写索引 → 投影单元纯折叠,保留可单测的纯函数形态)、`test/version-index.test.js`。
- 新增:`lib/projection/versions.js`(单元定义 + zod schema + wire view)、`lib/artifact-store.js`、`lib/git-adapter.js`、`lib/rollback.js`、`lib/http.js`(路由聚合)、`test/projection.test.js`、`test/artifact-store.test.js`、`test/git-adapter.test.js`。
- 微调:`lib/index.js`(inject 增加 `sessionProjections`/`sessionQuery`/`storageDomain` 等,按 apply 时序)、`lib/host-core.js`(回退目标 surface 计算复用 `foldSurface`)。

### 8.3 实现借鉴清单(官方 + 开源,落码前先读,DEVLOG 中注明来源)

| 借鉴点 | 来源 | 用在哪 |
|---|---|---|
| 内容寻址快照:tmp 暂存 + fsync + hardlink + 完整性校验 | 官方 `dsh-attachment-local`(lib/index.js `saveImageFile`) | ArtifactStore 写快照 |
| 投影单元:stateSchema(zod)+ init/apply/wire + stateVersion | 官方 `dsh-session-projection`(projection.md) | retrace/versions 单元 |
| shadow git 检查点 + Compare/Restore 交互 | Cline / Roo Code 文档(调研报告 §2.3/2.4) | GitAdapter + 时间线对比入口 |
| 事件日志树:编辑即分支、可见性投影 | gptme LogManager、ably-ai-transport-js `forkOf` | 分叉图语义设计 |
| 时间旅行:恢复即分叉 | LangGraph time travel 文档 | 回退=创建分叉的语义论证 |
| 版本元数据事件必须 `ignorable: true` | Moeblack 教训(三版未修) | 我们的标记事件首版即带 |
| seed + parentSession + seedLength 元数据模型 | Moeblack 源码(公开契约用法) | 若未来需要跨会话血缘(`traceSession`) |
| 回退安全契约:两段确认/救援点 | dsh-turn-rewind README | Rollback 预览确认流 |

> 所有借鉴仅取**思路与公开契约用法**,不复制他人代码;涉及许可的按 MIT/项目声明注明。

---

## 9. 阶段计划与验收

### 步骤 0 — 改名与工程基建(开工第一步)
- [x] 0.1 `git mv dsh-message-editor dsh-retrace`(目录名)+ 新远程 URL + 全仓 `message-editor` 残留清零(2026-08-21,remote 已指向 `azmavethy/dsh-retrace.git`;HUMANS/LICENSE 抬头已换)
- [x] 0.2 新建 `DEVLOG.md`,初始化本方案对应任务清单;确认提交/分支/tag 规范落地
- [ ] 0.3 旧包 deprecation 发布准备(0.2.3 README 迁移指引,可后置)
- **验收**:`git status` 干净、README/CHANGELOG/PLAN 全部为 dsh-retrace 品牌;首个基建提交入库。

### P0 — 地基(版本数据服务,官方能力落地)
- [ ] 0.1 `retrace/versions` 投影单元:边界检测(官方 `isReplacementSurfaceEvent` + `isCompactCheckpointSource` 分类)、surface 折叠、窗口归集、wire view、`stateVersion`
- [ ] 0.2 storageDomain 领域 `retrace`(refCounts + global)+ ArtifactStore 内容寻址快照(attachment-local 模式)+ GC
- [ ] 0.3 副作用接线:`onChanged` → 快照/git 记录;HTTP 面(versions/event/surface/rollback/git-init/snapshot)
- [ ] 0.4 配置消费(Host 读 versioning/git/retentionLimit;关闭即退化 0.2.x 行为)
- [ ] 0.5 spike:compaction 与 replace 标记共存行为验证(`isCompactCheckpointSource` 路径)
- **验收**:撤回/编辑后 Host 产出可查询版本记录(投影推送 + HTTP 双通道);重启后投影缓存恢复一致;开关关闭时行为与 0.2.x 一致;`pnpm check && pnpm test` 绿。

### P1 — 时间线 + 产物回退(差异化主体)
- [ ] 1.1 时间线浮层面板:版本/消息/思考/工具节点、虚拟列表、详情抽屉(投影推送 + readEvent)
- [ ] 1.2 产物回退:context/artifacts/both;快照兜底 + git 优先;干跑预览 + 确认(§4.5)
- [ ] 1.3 跳转对话 + 高亮(loadOlder 循环 + data-chat-anchor-key + CSS 高亮)
- [ ] 1.4 GitAdapter:仓库检测(含外层)、commit-free 记录、非仓库一键 init(专用引用)
- [ ] 1.5 防膨胀完善:GC 后台任务、快照上限、二进制/超大文件策略
- **验收**:用户在时间线看到版本与产物变更;可回退产物并验证文件内容;可点击节点跳转对话;开关与说明生效。

### P2 — 分叉图 + 增强(旗舰)
- [ ] 2.1 分叉流程图:turn/step 树 + 标记分叉点 + `traceEvent` 旧路径链接;SVG + 虚拟化
- [ ] 2.2 分支意图卡:回退区间摘要 + 产物列表 + 思考概要(LLM 摘要缓存)
- [ ] 2.3 精选增强:版本对比(对话/文件 diff)、保存点、审计视图
- **验收**:分叉图可读可导航;节点可展开原文、跳转对话;大会话不卡。

---

## 10. 风险与未决

- **分叉图性能**:千级节点 → 先列表形态(P1.1)再图形化(P2.1);必要时节点聚合。
- **工具路径解析覆盖面**:白名单工具表需随 DSH 工具集演进;解析失败只影响"该文件未被追踪",不影响版本记录本身。
- **投影推送在 Desktop 的可用性**:Web/Desktop 共用前端与 apiproxy 载体,应在 P0 验证推送帧在 Desktop 生效;若不生效,时间线列表降级 HTTP 轮询/手动刷新。
- **设置位置**:客户端 localStorage vs `ctx.settings`(§4.6 已选前者,后续可迁)。
- **LLM 摘要成本**:仅 P2.2 使用,一次生成一次缓存;可关闭。
- **`foldSurface` 与投影单元 surface 折叠的一致性**:两者同状态转换,用同一套 `replace` 语义;P0 用共享夹具单测对齐(含 start>end 的位置跨度用例)。

---

## 11. 里程碑与发布

| 版本 | 内容 | 目标 |
|---|---|---|
| 0.2.3 | 旧包 deprecation README(以 dsh-message-editor 名义,仅文档) | 随时可发 |
| 0.3.x | 步骤 0(改名/基建)+ P0(投影单元 + 快照 + 配置生效) | 时间线接口/推送可用 |
| 0.4.x | P1 完成:时间线 + 产物回退 + git + 跳转 | 差异化主体上线 |
| 0.5.x | P2 完成:分叉图 + 意图卡 + 精选增强 | 旗舰功能上线 |

> 每个 P 完成后发布并写 CHANGELOG + DEVLOG;README 同步新品牌与功能矩阵。
