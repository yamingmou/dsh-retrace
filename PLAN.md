# 实施方案:dsh-retrace — 会话与产物版本化管理插件

> 状态:**已确认,进入开发**(2026-08 决策)。阶段进度见 [CHANGELOG.md](./CHANGELOG.md)。
> 范围:从"消息编辑插件"升维为 **Harness 增强插件**——单会话内的**上下文回退 + 产物版本化 + 时间线 + 分叉图/思考流 + 导航跳转**。
> 差异化:Moeblack(dsh-message-edit)走"跨会话分支";我们走"**单会话内版本化**",不换会话身份,产物可回退,时间线即对话走过的路径。

---

## 0. 命名与定位

### 0.1 名称(已定)

- **dsh-retrace(Retrace · 回溯)** ✅ 已采用。
- 显示名:**Retrace · 回溯 — Conversation & artifact versioning for DeepSeek Harness**。
- 含义:"回溯"同时覆盖撤回、回退、时间线、分叉路径、思考流。

### 0.2 包名策略(已定:B — 迁移新包名)

- 新包名 **`dsh-retrace`**(0.3.0 起);旧包 `dsh-message-editor` 冻结在 0.2.2,不再更新。
- 采用面小(几乎无人使用),迁移成本低;旧包 README 指引迁移。
- 迁移动作(随 0.3.0 发布执行):
  1. 发布 `dsh-retrace@0.3.0`。
  2. 本地 profile 迁移:`dsh plugin --profile desktop add dsh-retrace`、`dsh plugin --profile web add dsh-retrace`,再 `dsh plugin --profile <name> remove dsh-message-editor`,重生成 cordis.yml,重启。
  3. 旧包 `dsh-message-editor` 发布 0.2.3 仅更新 README 迁移指引(deprecation note)。

---

## 1. 目标与边界

### 1.1 核心能力(四层)

| 层 | 能力 | 状态 |
|---|---|---|
| L1 上下文回退 | 撤回 / 编辑重发 / 重新生成(原地 replace 阴影,view⇄context 同步) | ✅ 已实现 0.2.2 |
| L2 产物版本化 | 每版本记录触碰文件;产物回退(快照/git);git 集成(可开关) | 🆕 P1 |
| L3 单会话时间线 | 版本列表、消息/思考/工具节点、详情、跳转对话位置 | 🆕 P1 |
| L4 分叉图/思考流 | 回合节点图 + 回退分叉点 + 思考链对应 + 分支意图卡 | 🆕 P2 |

### 1.2 明确不做

- **不做跨会话分支**(新会话版本):那是官方 fork 原语与 Moeblack 的路线。我们坚持"同一会话内",避免会话身份漂移。
- **不做日志改写/删除**:永远 append-only;所有"回退"都是追加 replace 阴影 + 可选内容重放。

### 1.3 与 Moeblack 的差异(话术)

- 他们:一操作一个新会话版本,树状分支,会话身份变化(工作区/附件/子代理跟随问题)。
- 我们:同一会话内回退,时间线=该对话的真实路径;**产物可回退**(他们明确不做);思考流↔时间线对应(分叉图)。

---

## 2. 总体架构

```
┌─ Client(浏览器)─────────────────────────────────────────────┐
│ 时间线浮层面板 / 分叉图(P2) / 设置 / 节点详情 / 跳转高亮         │
│   ▲ s.chat.timeline + 自定义增量视图 + @tanstack/react-virtual │
└──────────┬───────────────────────────────────────────────────┘
           │ HTTP /api/plugins/retrace/*
┌──────────▼───────────────────────────────────────────────────┐
│ Host(Electron 主进程 / dsh 进程)                              │
│  VersionIndex 服务(事件驱动,日志派生)                          │
│    ├ 会话事件订阅(ctx.on('session/event'))                     │
│    ├ 版本边界检测(surfaceOp replace 标记)                      │
│    ├ 触碰文件解析(tool/call + tool/result)                    │
│    └ 启动重放对齐(sessionQuery + readFrom 水印)                │
│  ArtifactStore(内容寻址快照 → ~/.dsh/…/snapshots,保留策略 GC)   │
│  GitAdapter(可选:commit-free 记录 / 确认后 init / checkout)     │
│  Rollback 执行器(ctx.fs 围栏写 + subprocess + 路径护栏)         │
└──────────────────────────────────────────────────────────────┘
```

**原则**:版本索引**从日志派生**(可随时重放重建,永不与日志脱节);快照/元数据是增强,不是权威;破坏性操作一律"先快照 → 确认 → 经 ctx.fs 围栏 → 校验"。

---

## 3. 数据模型

### 3.1 事件词汇(对齐调研,不用虚构类型)

| 概念 | 真实事件/字段 |
|---|---|
| 回合边界 | `turn/start` / `turn/end`(reason: completed/aborted/…/interrupted) |
| 用户输入 | `user/message`(data.id/content) |
| 思考 | `assistant/message.data.message.content` 内 `{type:'reasoning', text}` 块;流式 `assistant/chunk.chunk.type==='reasoning-delta'` |
| 回复 | `assistant/message` |
| 工具 | `tool/call`(arguments 为原始 JSON 串)/ `tool/result`(meta,error) |
| 编辑/撤回痕迹 | 我们追加的 `assistant/message` 空标记,data 带 `editor:{targetSeq,text}` + `surfaceOp:{op:'replace',start,end}` + `sourceEventSeqs` |
| 系统压缩 | compaction 追加的 `user/message` 检查点(同样带 surfaceOp replace) |

### 3.2 VersionRecord(元数据,存 `~/.dsh/storages/<plugin>.json` 或自建域)

```ts
interface VersionRecord {
  sessionId: string
  versionId: string            // `v<seq>` — 与标记事件 seq 绑定
  boundarySeq: number          // 版本边界(标记事件 seq;首版本 = firstLiveSeq-1)
  createdAt: number
  kind: 'recall' | 'edit' | 'regenerate' | 'restore' | 'compaction'
  markerSeq?: number           // 我们的标记事件 seq(compaction 无)
  messageRefs: number[]        // boundary 时刻 surface 上的事件 seq 集(惰性读原文)
  touchedFiles: FileChange[]   // [prevBoundary+1, boundary] 窗口解析
  git?: { headHash: string; dirty: boolean; diffSha?: string }  // git 开启且为仓库时
}
interface FileChange {
  path: string                 // 相对工作区的规范路径
  mode: 'created' | 'modified' | 'deleted'
  contentHash?: string         // 快照内容寻址(created/modified)
  sizeBytes?: number
  snapshotSkipped?: 'too-large' | 'binary'
}
```

### 3.3 快照存储

```
~/.dsh/dsh-retrace/snapshots/<sha256>       # 内容寻址,天然去重
~/.dsh/storages/<plugin>.json                       # 元数据(版本记录,经 ctx.storageDomain)
~/.dsh/dsh-retrace/index/<sessionId>.jsonl  # 版本索引增量日志(可选,水印 checkpoint)
```

- 元数据:只存引用与摘要,**不复制消息全文**;原文经 `sessionQuery.readEvent/readSession` 惰性读取。
- 我们标记事件的 `editor.text` 自带原文(前 2000 字)→ 即使被压缩,时间线仍可展示摘要。

---

## 4. Host 实现细节

### 4.1 VersionIndex 服务(核心,P0)

**订阅**(根作用域,与持久化后端同模式):
```js
ctx.on('session/created', (session) => seedIndex(session))      // 种子事件不发布,先引导
ctx.on('session/event', (session, event) => observe(session, event))
ctx.on('session/flush', async (session) => checkpoint(session)) // 持久化对账
ctx.on('session/disposed', (session) => finalize(session))
```

**增量观察 `observe(session, event)`**:
1. 事件带 `surfaceOp:{op:'replace',...}` → 版本边界。若是我们标记(`data.editor` 存在)→ 用户版本;否则(compaction 检查点)→ kind='compaction' 记录(时间线显示"已压缩")。
2. 非边界事件 → 归入当前窗口,更新 `pendingTouchedFiles`:
   - `tool/call`:解析 `arguments` JSON,按工具名提取路径(`fs.*` 的 `path/paths`、`bash` 的 `cwd`+命令内路径启发式、`edit` 的 `file_path` 等)。
   - `tool/result`:取 `meta.path`(dsh-tool-fs 写入 `{path, offset, …}`)及 `error` 判定失败(失败工具不产生产物变更)。
3. 边界时:冻结 `VersionRecord`(messageRefs = `foldSurface(events.slice(0,boundary+1)).nodes`,纯函数重放)→ 触发快照(§4.3)→ 写元数据 → `session.flush()` 对账。

**启动重放对齐**:
- 对每个 live session:`readSession(sessionId)` 全量重放(回放校验),自 `firstLiveSeq` 起重建索引;增量用 `sessionPersistence.readFrom(id, fromSeq)` 水印推进。
- 崩溃恢复:索引可随时整体重放重建;元数据仅作缓存/加速,允许重建。

**并发**:沿用现有 per-session `locked(sessionId, fn)` 串行化;索引写入与操作请求同一锁。

### 4.2 触碰文件解析(细化,P0)

- 窗口 = `[prevBoundarySeq+1, boundarySeq]`。
- 提取优先级:`tool/result.meta.path`(权威,工具私有)→ `tool/call.arguments` 解析(需工具白名单表:fs-read/fs-write/edit/bash/code-runtime 等)→ 结果文本启发式(仅当上两者缺失)。
- 归一化:`fs.realpath` → 校验仍在会话工作区(`header.cwd` realpath 前缀)内 → 转相对路径;去重;默认跳过 `node_modules/`、`.git/`、`~/.dsh/`(可配置)。
- 判定 mode:与上一版本该文件的记录对比(created/modified/deleted);首版本以"出现在窗口=created"。

### 4.3 ArtifactStore(快照,P0)

- 边界时对 `touchedFiles` 读内容:`ctx.fs.readBytes(path, {maxBytes: 快照上限 4MB})`;超限/二进制 → `snapshotSkipped` 标记(不阻塞版本记录)。
- 内容寻址 `sha256(content)` → 写 `~/.dsh/dsh-retrace/snapshots/<hash>`(原子写 tmp+rename);引用计数跨版本共享。
- **保留策略**:`retentionLimit`(默认 50,设置可调):GC 时仅删除 `refCount===0` 且被清理版本引用的快照;元数据与时间线记录**永不清**(引用保留)。GC 触发:版本数超限 / 会话关闭 / 插件卸载。
- 失败降级:快照写失败 → 版本记录照常,`contentHash` 缺失 → 回退时提示"该文件无快照,走 git 或无操作"。

### 4.4 GitAdapter(可开关,P1)

| 工作区状态 | 行为 |
|---|---|
| 已是仓库(含外层仓库) | **commit-free**:版本边界记录 `git rev-parse HEAD` + `git status --porcelain`(只读命令);回退= `git checkout <headHash> -- <清单内路径>` 或反向应用记录 diff;不自动 commit、不动分支 |
| 非仓库 | 快照兜底;时间线面板显示"启用 git 版本管理"按钮 → 用户确认 → `git init` + 最小 `.gitignore`(node_modules 等)+ 版本记录写专用引用 `refs/dsh/versions`(不动默认分支),用户可随时删除该引用恢复原状 |
| 开关关闭 | 一律快照,不检测、不执行任何 git 命令 |

- 命令执行:`ctx.subprocess.spawn(spec)`(只读命令无需确认;写命令 checkout/init 走确认 UI)。
- 安全:只操作快照/版本清单内的路径;realpath 校验仍在工作区内;git 输出大小限制(spill)。

### 4.5 Rollback 执行器(P1)

请求 `{versionId, scope: 'context'|'artifacts'|'both'}`:

1. **上下文回退**(复用现有 host-core 原语):计算当前 surface 与目标版本 `messageRefs` 的差集 → 追加 replace 标记阴影"目标版本之后"的全部节点 → (可选)以该版本最后一个用户输入 `agent.followup` 重发。
   - 语义即 git checkout 旧提交:新内容仍在日志/时间线可见为"后续版本"。
2. **产物回退**:对 `touchedFiles`:
   - git 可用 → `git checkout <headHash> -- <paths>`(仅清单路径);
   - 否则/未跟踪文件 → `ctx.fs.writeText(path, snapshotContent, {kind:'replaceIfVersion', version}, signal, {sandboxPolicy:{mode:'workspace-write', workspaceRoot: 会话工作区}})` 写回(围栏+CAS);
   - 需删除的文件 → `ctx.subprocess` 执行 `rm`,前置护栏:realpath 在工作区内 **且** 在清单内。
3. **安全顺序**:先快照当前状态(防误操作可还原)→ 干跑预览(将移除 N 消息 / 影响 M 文件)→ 用户确认 → 执行 → 内容 hash 校验。
4. **幂等**:per-session 锁;操作记录为版本(kind='restore'),可审计可再回退。

### 4.6 配置消费(P0 收尾)

- Client 侧 localStorage 配置随操作请求携带(`{versioning, git, retentionLimit}` 放请求体),Host 以请求为准、不持久化配置(简单可靠);后续如需要跨端一致,再迁移到服务端设置。
- 关闭 `versioning` 时:Host 不建索引/不快照,行为退化为 0.2.x 纯上下文回退。

---

## 5. Client 实现细节

### 5.1 时间线面板(浮层,P1)

- **形态**:注册 `conversation.session.header.actions` 按钮(order≈30)+ **浮层面板**(非视图环标签页)。
  - 原因(调研结论):视图环一次只渲染一个视图,标签页激活会**卸载 chat**,无法 scrollIntoView;且无公共 API 切回 chat。浮层保持 chat 挂载 → 跳转一步到位。
- **数据源**:`ctx.sessions.binding(sessionId)?.session` → `s.chat.timeline`(turn/step 树,分叉图骨架)+ `s.views`;版本数据来自 Host(`GET /api/plugins/retrace/versions?sessionId=`),增量视图可用 `conversationViews.register({target:'timeline', create: builder})`(trajectory 先例)。
- **渲染**:自带 `@tanstack/react-virtual`(trajectory 内联先例,>100 节点开启);节点 = 版本节点(时间/操作/摘要/产物 badge)+ 消息/工具节点。
- **节点内容**:
  - 版本节点:操作类型图标(撤回/编辑/重生成/恢复/压缩)、时间、`editor.text` 摘要(被回退内容)、产物变更徽标(`+3 -1 个文件`)。
  - 消息节点:截断输入/输出 + 状态(成功/失败/被回退灰显)。
  - 思考节点:reasoning 块摘要(首 N 字;LLM 摘要缓存,一次生成一次缓存)。
- **详情与跳转**:
  - 点击节点 → 详情抽屉:原文全文(输入/输出/思考)经 `readEvent` 惰性加载。
  - "跳转到对话":计算 chat 节点 key(`14:assistant-step{turn}:{step}` / `13:input-message{id}` / 按 anchorSeq 在 `s.chat.nodes` 定位)→ 目标在已加载窗口外则循环 `session.loadOlder()`(50/页)直至出现或 `hasMore=false` → `document.querySelector('[data-chat-anchor-key="…"]')?.scrollIntoView({behavior:'smooth', block:'center'})` → 注入短时高亮 CSS(参考 trajectory `data-timeline-focus` 模式)。
- **样式**:沿用 `<style data-plugin="dsh-retrace">` 纯 CSS + `--dsw-alias-*` 变量。

### 5.2 分叉图/思考流(P2)

- **骨架**:`s.chat.timeline` turn/step 树 + Host 版本索引(标记 = 分叉点)+ `sessionQuery.traceEvent` 的 `replacedBy/replacementChain`(旧路径→标记→新路径 的链接)。
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
| 文件快照 | 内容寻址去重;只快照触碰文件;保留上限 GC(默认 50);存 `~/.dsh` 不落工作区 |
| 会话日志/索引 | 索引只存引用,原文惰性读;标记事件自带 `editor.text` 摘要;不随版本线性放大 |
| 客户端内存 | 虚拟列表 + 详情惰性加载;增量构建视图 |
| LLM 调用 | 摘要生成一次缓存一次;不重复计算;不重发提示词 |

---

## 7. 可靠性设计

| 风险 | 对策 |
|---|---|
| 索引与日志脱节 | 索引=日志派生,重放即可重建;`session/flush` 时持久化 checkpoint;`readFrom` 水印增量对账 |
| 崩溃丢事件 | 与 DSH 现有保证一致(≤200ms write-behind,torn tail 自动修复);版本记录随事件流,不引入新的丢失面 |
| 破坏性回退 | 先快照当前 → 干跑预览 → 确认 → 经 `ctx.fs`(围栏+CAS+原子写)写回 → hash 校验;删除限定工作区+清单路径 |
| compaction 共存 | P0 spike 验证;被压缩区间节点显示"已压缩"降级;`editor.text` 保证摘要可显示 |
| 权限越界 | 只写 `~/.dsh/<plugin>` + 会话工作区已知路径;绝不裸 node fs 写工作区(会绕过全部沙箱与审批) |
| 动态插件差异 | 本方案仅支持组合型 Host 插件(主进程);动态插件(受限 realm)保持现状,文档说明 |
| 性能 | 千级会话:虚拟化 + 增量构建 + 首屏列表形态;分叉图 P2 先列表后图形 |

---

## 8. 阶段计划与验收

### P0 — 地基(版本数据服务)
- [ ] 0.1 命名/品牌落地(待决策)
- [ ] 0.2 Host `VersionIndex` 服务:事件订阅、版本边界检测(区分用户操作/compaction)、messageRefs、启动重放对齐、flush 对账
- [ ] 0.3 触碰文件解析(tool/call+result,白名单表,realpath 护栏)
- [ ] 0.4 `ArtifactStore`:内容寻址快照、引用计数、保留策略 GC、失败降级
- [ ] 0.5 配置消费(Host 读 versioning/git/retentionLimit;关闭即退化 0.2.x 行为)
- [ ] 0.6 spike:compaction 与 replace 标记共存行为验证
- **验收**:撤回/编辑后 Host 产出可查询版本记录(`versions` 接口返回边界/消息引用/触碰文件);无性能回退;开关关闭时行为与 0.2.x 一致。

### P1 — 时间线 + 产物回退(差异化主体)
- [ ] 1.1 时间线浮层面板:版本/消息/思考/工具节点、虚拟列表、详情抽屉
- [ ] 1.2 产物回退:context/artifacts/both;快照兜底 + git 优先;干跑预览 + 确认
- [ ] 1.3 跳转对话 + 高亮(loadOlder 循环 + scrollIntoView + CSS 高亮)
- [ ] 1.4 GitAdapter:仓库检测(含外层)、commit-free 记录、非仓库一键 init(专用引用)
- [ ] 1.5 防膨胀完善:GC 后台任务、快照上限、二进制/超大文件策略
- **验收**:用户在时间线看到版本与产物变更;可回退产物并验证文件内容;可点击节点跳转对话;开关与说明生效。

### P2 — 分叉图 + 增强(旗舰)
- [ ] 2.1 分叉流程图:turn/step 树 + 标记分叉点 + traceEvent 旧路径链接;SVG + 虚拟化
- [ ] 2.2 分支意图卡:回退区间摘要 + 产物列表 + 思考概要(LLM 摘要缓存)
- [ ] 2.3 精选增强:版本对比(对话/文件 diff)、保存点、审计视图
- **验收**:分叉图可读可导航;节点可展开原文、跳转对话;大会话不卡。

---

## 9. 风险与未决

- **分叉图性能**:千级节点 → 先列表形态(P1.1)再图形化(P2.1);必要时节点聚合。
- **工具路径解析覆盖面**:白名单工具表需随 DSH 工具集演进;解析失败只影响"该文件未被追踪",不影响版本记录本身。
- **命名/包名**(§0.2):P0 前定。
- **设置位置**:客户端 localStorage vs 服务端配置(§4.6 已选前者,后续可迁)。
- **LLM 摘要成本**:仅 P2.2 使用,一次生成一次缓存;可关闭。

---

## 10. 里程碑与发布

| 版本 | 内容 | 目标 |
|---|---|---|
| 0.2.3 | 设置 UI(已实现,待审)+ 命名 | 随时可发(仅界面) |
| 0.3.x | P0 完成:版本数据服务 + 快照 + 配置生效 | 时间线接口可用 |
| 0.4.x | P1 完成:时间线 + 产物回退 + git + 跳转 | 差异化主体上线 |
| 0.5.x | P2 完成:分叉图 + 意图卡 + 精选增强 | 旗舰功能上线 |

> 每个 P 完成后发布并写 CHANGELOG;README 同步新品牌与功能矩阵。
