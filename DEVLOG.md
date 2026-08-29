# DEVLOG — 逐功能开发记录

> 按 [PLAN.md](./PLAN.md) §8.1:每完成一个功能单元即追加一条,与提交一一对应。
> 每条:目标 / 方案 / 涉及文件 / 关键决策 / 验证方式 / 遗留问题。

---

## 步骤 0 — 改名与工程基建(2026-08-21)

**目标**:目录名 `dsh-message-editor` → `dsh-retrace`;远程地址指向新仓库;全仓残留清零;建立开发记录文件。

**方案**:

- 目录改名:仓库根目录本身即 `dsh-message-editor/`,直接 `mv`(git 仓库与其父目录名无关,仓库内相对路径引用不受影响)。
- `git remote set-url origin https://github.com/yamingmou/dsh-retrace.git`(与 package.json `repository` 字段一致)。
- `HUMANS.txt` / `LICENSE` 抬头品牌同步;`PLAN.md` 自身的历史迁移说明保留(它是改名记录)。
- 新增 `DEVLOG.md`。

**涉及文件**:`HUMANS.txt`、`LICENSE`、`DEVLOG.md`(新增)、`PLAN.md`(勾选状态)。

**关键决策**:旧包 `dsh-message-editor@0.2.3` deprecation 发布(仅 README 迁移指引)后置,不影响 P0 开发。

**验证方式**:`git status` 干净(除 P0 进行中文件);`git remote -v` 指向新地址;`git grep -i message-editor` 仅剩 PLAN.md 历史迁移说明与 CHANGELOG/README 的迁移文档(有意保留)。

**遗留问题**:新远程仓库已定名 `yamingmou/dsh-retrace`（2026-08-25 由 `dsh-message-editor` 改名而来,旧链接自动重定向）;旧包 deprecation 发布待定。

---

## P0.1 — `retrace/versions` 投影单元(2026-08-21)

**目标**:把旧 P0 的"手写 VersionIndex(事件订阅 + 自建 jsonl 索引)"按修订版 PLAN 重写为**官方 `ctx.sessionProjections` 投影单元的纯折叠**;版本边界检测用官方语义分类(我们的标记 / compaction 检查点 / 其它 replace),触碰文件窗口归集,wire view 提供时间线列表摘要。

**方案**:

- `lib/version-index.js`(重写,保持零依赖纯函数形态):
  - 边界谓词以官方语义等价实现并注释来源:`isReplacementSurfaceEvent`(`@deepseek-ai/dsh-session/surface`)、`isCompactCheckpointSource`(`@deepseek-ai/dsh-compaction/checkpoint`)——均为 2~4 行契约谓词,内联保证模块在任意 realm 可运行,行为用单测锁定。
  - `classifyBoundaryKind(event)`:① 我们的标记(`data.editor` 存在,按 marker id 前缀 `retrace-<op>-` 分类 recall/edit/regenerate/restore);② `isCompactCheckpointSource(event.data.source)` → `compaction`;③ 其它 replace → `replace`。
  - surface 折叠与官方 `foldSurface` 同一套状态转换:append → push;replace → `splice(startIdx, endIdx-startIdx+1, seq)`(start/end 必须都在当前 surface 中;官方 fold 对 start 在 end 之后会 throw,我们不做特殊处理——host-core 生成的 span 保证 startIdx ≤ endIdx)。
  - 触碰文件窗口:保留原 `touchedFilesFromEvent`(tool/result.meta.path 权威 + tool/call arguments 白名单);扩展 intent 为 `write|delete|unknown`(fs.remove/rename 等判 delete)。
  - 边界冻结 `VersionRecord`:`versionId: 'v<seq>'`、`boundarySeq`、`createdAt: event.time`(纯折叠不用 `Date.now()`)、`kind`、`markerText`(标记事件 `editor.text`;compaction 为 `''`,摘要丰富化留 P1)、`touchedFiles[{path, mode}]`、`messageCount = surface.length`(回退/详情需要的全量 surface 在 P1 惰性 `foldSurface(events.slice(0, boundarySeq+1))`,索引不存 messageRefs)、`git: null`。
  - mode 判定:窗口内 delete 意图 → `deleted`;文件曾出现在已冻结版本(`knownFiles`)→ `modified`;否则 `created`。
  - 版本上限 `VERSION_LIMIT = 200`,超限截断最旧(完整历史可经日志重放,不丢事实)。
  - 性能契约:无 surface/文件/边界变化的事件返回**同一 state 引用**(`Object.is` 门控 onChanged 推送)。
- `lib/projection/versions.js`(新增):单元定义 `{ key: 'retrace/versions', schema, init, apply, view, stateVersion: 1 }`;zod schema 约束状态为**纯 JSON**(`knownFiles` 用数组不用 Set——`dsh-session-projection-cache` 的 checkpoint 行 `val` 经 `z.json()` 校验,Set 无法耐久);`view` 产出时间线列表摘要(版本 + 文件计数,`sessionId` 不放入 view——apiproxy 推送帧自带 sessionId)。

**涉及文件**:`lib/version-index.js`(重写)、`lib/projection/versions.js`(新增)、`test/version-index.test.js`(重写)、`test/projection.test.js`(新增)、`package.json`(新增依赖 `zod`)。

**关键决策**:

- 状态全部纯 JSON(数组代替 Set),保证投影缓存可持久化。
- wire view 携带完整 `touchedFiles`(path+mode)而非仅计数:HTTP `/versions` 用 `sessionProjections.snapshot()` 拿到的只有 view 值,时间线详情需要路径;帧只在版本边界产生,体量可接受。
- `createdAt` 用事件时间戳 `event.time`,保持折叠确定性、可重放。

**验证方式**:`test/version-index.test.js`(纯折叠:边界分类/表面折叠/文件窗口/mode/上限/同引用契约)+ `test/projection.test.js`(单元定义 + schema + 合成事件日志的 apply/view);`pnpm check && pnpm test` 绿。

**工程修复(同批)**:原 `pnpm check` 用 `node --check a.js b.js …` 多文件语法检查,但 Node 24 的 `--check` **只校验第一个参数**,后续文件全部被静默跳过(既有隐患,曾导致 `lib/client.js`/`lib/host-core.js` 从未被真正检查)。改为 `scripts/check-syntax.mjs`(esbuild 进程内解析每个 `lib/**.js`,不产生子进程,沙箱内外一致),坏文件立即失败。

**遗留问题**:compaction 版本的 `markerText` 摘要(取 `compaction/summary` 前 N 字)待 P1;`kindFromMarkerId` 对非本插件标记的回退默认 'edit' 与官方 `isReplacementSurfaceEvent` 覆盖面一致性问题(非 replace 事件不构成版本,无影响)。

---

## P0.2 — ArtifactStore 内容寻址快照 + storageDomain 领域(2026-08-21)

**目标**:版本边界时对触碰文件做**内容寻址快照**(attachment-local 同款:tmp 暂存 + fsync + hardlink + 完整性校验),存储于 `$DSH_HOME/dsh-retrace/objects/<sha256[:2]>/<sha256>`;引用计数走 `ctx.storageDomain` 领域 `retrace`(refcounts 表 + global 配置),提供 GC。

**方案**:

- `lib/artifact-store.js`(新增):
  - `retraceDomainSpec = defineDomain({ name:'retrace', version:1, tables:{ refcounts: domainTable(zod) }, global:{ schema, initial } })`,引用域为 `@deepseek-ai/dsh-storage-domain`(peer)。⚠️ 表名必须全小写(`UNIT_NAME_RE` 只允许 `[a-z][a-z0-9_]*`),故用 `refcounts` 而非方案稿的 `refCounts`。
  - `createArtifactStore(root)`:内容寻址 save/read;save 实现 tmp(随机 UUID)+ O_EXCL 写 + fsync + hardlink 发布,EEXIST 时校验已存在对象完整性(摘要不符即报错);read 做 sha 完整性校验;`list()` 扫描 `objects/<xx>/<sha>`。
  - `gcArtifacts(store, keep)`:删除不在 keep(Set of sha256)内的对象(基础版,保留策略触发随 P1.5 后台任务)。
- `$DSH_HOME` 解析用官方 `resolveDshHome()`(`@deepseek-ai/dsh-home-paths`,peer)。

**涉及文件**:`lib/artifact-store.js`(新增)、`test/artifact-store.test.js`(新增)、`package.json`(peer 依赖 `@deepseek-ai/dsh-storage-domain`、`@deepseek-ai/dsh-home-paths`)。

**关键决策**:快照只写插件自有目录 `$DSH_HOME/dsh-retrace/`(宿主 node:fs,与 attachment 一致,不绕过任何用户审批面);工作区内的读走 `ctx.fs`(沙箱);引用记法 `refs: ['<versionId>:<path>', …]`,同一 hash 跨版本共享,rollback(P1)可按 `v<seq>:path` 反查。

**验证方式**:`test/artifact-store.test.js` 用临时目录验证 save/read 往返、去重(existed)、损坏对象完整性拒绝、list/remove/gc、领域契约(global 拒绝 null)。

**遗留问题**:二进制/超大文件判定在快照副作用处实现(P0.3 接线),折叠内不判;GC 的 retentionLimit 联动后台任务留 P1.5。

---

## P0.3 — 副作用接线 + HTTP 面 + 配置消费(2026-08-21)

**目标**:`sessionProjections.onChanged` 驱动快照副作用;HTTP `/api/plugins/retrace/*` 聚合(原 POST ops + GET versions/event/surface);配置(versioning/git/retentionLimit)随客户端请求携带,HOST 以请求为准;关闭 versioning 时行为退化为 0.2.x(L1 不动)。

**方案**:

- `lib/index.js`(更新):apply 内 `ctx.inject(['sessionProjections','sessionQuery','storageDomain'], …)` 注册投影单元 + 开领域 + onChanged 副作用;领域开失败仅告警(版本化降级 L1)。
- `lib/http.js`(新增):路由聚合——`POST recall/editAndResend/regenerate`(原逻辑迁入)、`GET /versions?sessionId=`(投影 snapshot 成品值,versioning 关时返回 `{enabled:false}`)、`GET /event`(`sessionQuery.readEvent`)、`GET /surface`(`sessionQuery.readSurface`);解析 `x-retrace-config` 请求头(JSON)更新 per-session 配置缓存。
- 快照副作用:新版本边界时,对 `touchedFiles` 非 deleted 项 `ctx.fs.resolve` + `contains`(工作区围栏)+ `readBytes(…, undefined, 4MB)`;4MB 超限/二进制(前 1024 字节含 NUL)/读取失败 → 跳过该文件(版本记录照常);成功 → ArtifactStore save + refCounts 引用计数。
- `lib/client.js`(更新):`callOp` HTTP 路径附加 `x-retrace-config` 头(versioning/git/retentionLimit);动态 wire 路径不变(动态插件保持 L1,方案只支持组合型 Host)。

**涉及文件**:`lib/index.js`、`lib/http.js`(新增)、`lib/client.js`、`lib/client.bundle.js`(重建)、`lib/dynamic-client.js`(重建)、`package.json`。

**关键决策**:配置不落 Host 持久化(以请求为准,plan §4.6 已选);投影单元**始终注册**(纯折叠、框架缓存、成本极低),"关闭 versioning"体现在副作用跳过 + HTTP 面返回 disabled——用户可见行为与 0.2.x 一致;"不注册投影单元"的理想形态因注册时机(apply 时)与配置来源(请求时)不同而折衷,见遗留问题。

**验证方式**:`pnpm check && pnpm test` 绿;构建产物(client.bundle.js/dynamic-client.js)由 `pnpm build` 再生成且 CI diff 门禁一致。

**遗留问题**:版本化开关的 apply 时注册与否,待客户端设置真正接线后(可考虑 `ctx.settings` 服务端设置迁移,plan §4.6 后续项)再收敛;`sessionQuery` 在 headless 组合缺失时 GET /event /surface 返回 503,不影响核心 ops。

---

## 修复 — marker 前缀向后兼容 + 隐藏开关(2026-08-25)

**目标**:0.3.0 改名(`message-editor-` → `retrace-`)导致旧 marker 不被识别,旧会话显示不一致;且 fromScratch 链式编辑隐藏整段内容,用户无查看出口。本次修复让"改名永不破坏识别、隐藏永远可逆"。

**方案**:

- 客户端 `lib/client.js`:引入 `MARKER_PREFIXES`(当前 + 遗留前缀)与 `LEGACY_MARKER_PREFIXES`。旧前缀(`message-editor-`)marker 现在**被识别**(渲染"已编辑并重新发送"提示与原输入对照),但作为**软兼容**:其 shadowed 范围**永不隐藏**(视为空),保证改名后既有内容不会因旧 marker 重新被藏。
- 新增配置 `hideShadowed`(默认开=现状行为):关闭后所有 marker 只显示提示/对照,不隐藏任何消息——全局"查看完整历史"出口(设置 → 通用)。
- Host 侧 `lib/version-index.js`:`kindFromMarkerId` 改为多前缀识别,旧 marker 正确归类 recall/edit/regenerate。
- `readConfig` 增加遗留配置键迁移(`dsh-message-editor:config` → `dsh-retrace:config`)。
- 三个文件均写明 **RENAME RULE**:改名时必须把旧前缀加入遗留列表,识别永不因改名断裂。

**涉及文件**:`lib/client.js`、`lib/client.bundle.js`(重建)、`lib/dynamic-client.js`、`lib/host-core.js`(注释)、`lib/version-index.js`、`test/version-index.test.js`(新增遗留前缀分类回归)。

**关键决策**:旧前缀 marker 采用"软兼容"(识别但不隐藏)而非"硬兼容"(恢复隐藏)——后者会让用户已可见的历史内容再次消失,违背本次事故的教训。

**验证方式**:84 测试全过(新增 1 条遗留前缀回归);headless GUI 实测「插件新版本」会话 882 行全渲染、0 隐藏、5 个 marker 标注行正常、旧 marker 不再隐藏 121763、无客户端报错;bundle 已同步 desktop/web 两个 profile。

**遗留问题**:Host 侧新代码需重启 DSH Desktop 生效(客户端 bundle 已即时生效,no-cache 直出)。

---

## P1.2 — 产物回退执行器(lib/rollback.js,2026-08-25)

**目标**:按 PLAN §4.5 实现 context/artifacts/both 三种回退;干跑预览 + 确认;回退记录为新版本(kind=restore),可再回退。

**方案**:

- `lib/rollback.js`(新增):`createRollbackExecutor({ctx, sessions, seam, log})`:
  - `preview({sessionId, versionId, scope})`:context 差集 = 当前 surface 中不在目标版本折叠 surface 的节点(`foldSurface(events.slice(0, boundarySeq+1))`,官方导出);artifacts 计划逐文件给 action/method(git / snapshot / delete / skip-no-snapshot);`applicable` 标记是否有事可做。
  - `execute`:context 复用 `appendEditorMarker(op='restore')` 追加空标记替换差集区间;artifacts:git 优先(`git checkout <headHash> -- <paths>`,仅清单路径,`ls-tree` 预筛存在性),快照兜底(`resolveSnapshot` 反查 refcounts → `store.read` 校验 → `ctx.fs.writeText` CAS `replaceIfVersion` + `sandboxPolicy.resolve({session, mode:'workspace-write'})`),删除文件走 subprocess `rm`(realpath 在工作区内且路径在清单内)。
  - 幂等:per-session 锁;回退本身是版本(kind=restore),投影推送自动可见。
- `lib/host-core.js`(重构):`editorId/editorError/lastModelSource/appendEditorMarker` 提升为模块级导出(rollback 复用,host-core 仍零依赖)。
- `lib/versioning.js`(扩展):新增 seam 方法 `agentOf/resolveSnapshot/readSnapshot/gitHeadFor/gitStatus/gitCheckout/gitInit`;边界副作用新增 `recordVersionGit`(读状态 `rev-parse HEAD` + `status --porcelain` → 域表 `versiongit`)。

**关键决策**:versiongit 用域表而非投影字段——折叠保持纯函数,git 事实是边界时刻的副作用记录;快照回退写回走 CAS 防覆盖用户手动编辑。

**验证方式**:`test/rollback.test.js`(8 用例:preview 差集/计划/适用性、execute 三类范围、git/快照/删除三条路径)+ `test/git-adapter.test.js`(7 用例:detect/status/checkout 护栏/init 序列);`pnpm check && pnpm test` 绿(109)。

**遗留问题**:真机验证待做(profile 重装 + GUI 冒烟);`gitHeadFor` 目前仅 rollback 预览提示用,回退直接取执行时刻 gitStatus 的 HEAD。

---

## P1.1 + P1.3 — 时间线浮层与跳转(client,2026-08-25)

**目标**:PLAN §5.1 时间线浮层面板(header 入口、投影推送 + HTTP 降级、详情抽屉、回退预览/确认、git 横幅)+ §5.1 跳转对话 + 高亮。

**方案**:

- `lib/client.js`(扩展):
  - 注册 `conversation.session.header.actions`(order 30)入口按钮 + 浮层面板(绝对定位,不换视图环标签页——chat 保持挂载,跳转才可行)。
  - 数据:版本列表优先 `useProjection('retrace/versions')`(推送帧,零轮询),缺省走 `GET /versions` + 手动刷新;详情 `GET /event?seq&before&after` 惰性加载;回退 `POST /rollback/preview` → 范围三选 → `POST /rollback`;git 横幅 `GET /git/status` + 一键 `POST /git/init`(confirm)。
  - 跳转:`sessions.binding(id).session.loadOlder()` 循环(≤500 页)直到目标 anchorSeq 节点出现(经 useSession 快照 ref 探测),`[data-chat-anchor-key]` scrollIntoView + 注入高亮动画 CSS,2 轮后自动移除。
  - 列表:固定行高零依赖窗口化(visible slice)——@tanstack/react-virtual 评估后放弃(打包 +15KiB,均匀行高下收益为负),DEVLOG 记录偏差。
  - 事件查看器(详情抽屉)pre 渲染 JSON。
- i18n:zh/en 各 +42 键(timeline.*,键集一致校验通过 71=71)。

**关键决策**:投影推送帧为数据主源、HTTP 为降级(与 PLAN §4.6 一致);回退必须 preview→confirm 两段式(防误操作);跳转失败(未加载到)给提示不静默。

**验证方式**:`pnpm check`(esbuild 逐文件语法)+ `pnpm build`(bundle 60KiB,自注册 loader entry)+ bundle 加载冒烟(模拟 window/ModuleLoader,exports 完整)+ `pnpm test` 绿(109)。

**遗留问题**:真机 GUI 冒烟待做;react-virtual 未用(记录偏差);时间线消息/思考节点视图(仅版本节点)留 P2。

---

## P1.4 — GitAdapter(lib/git-adapter.js,2026-08-25)

**目标**:PLAN §4.4 commit-free 记录 + 仓库检测(含外层)+ 非仓库一键 init(专用引用)。

**方案**:

- `lib/git-adapter.js`(新增,transport-shaped 可测):`createGitAdapter({command, writeText})`:
  - `detect(cwd)`:`git rev-parse --show-toplevel`(外层仓库自然包含)。
  - `status(cwd)`:`rev-parse HEAD` + `status --porcelain` → `{root, headHash, dirty, paths}`;unborn HEAD → `headHash: null`。
  - `checkout(cwd, headHash, paths)`:路径护栏(拒绝绝对路径/`..` 逃逸/越界),`ls-tree -r --name-only` 预筛存在路径,只 checkout 存在者。
  - `init(cwd)`:`git init -q` → 最小 `.gitignore`(经注入的 workspace 沙箱写)→ 基线提交 → `update-ref refs/dsh/versions HEAD`(专用引用,可删引用复原)。
- 全部命令经 `ctx.subprocess`(resolveExecutable('git'),collect 输出,30s grace)。

**关键决策**:适配器与 runner 分离(`createSubprocessRunner` 包装 ctx.subprocess),测试注入 fake runner 走全决策路径;写命令只在用户确认流程中触发。

**验证方式**:`test/git-adapter.test.js`(7 用例,含护栏/预筛/init 序列)。

**遗留问题**:真机验证待做;diffSha 未实现(P2)。

---

## P1.5 — 防膨胀 GC(versioning.js,2026-08-25)

**目标**:PLAN §4.3/§1.5 保留上限内回收快照,长会话不无界增长。

**方案**:

- 边界时维护 `retainedVersions`(sessionId → 窗口内版本 id 集);节流(默认 60s,可配 `gcIntervalMs`)扫掠:
  1. refcounts 中过滤已知会话已截断版本的引用(未知会话保守保留);
  2. 零引用对象经 `gcArtifacts` 删除(内容寻址文件);
  3. versiongit 行同步剪枝(版本不在任何已知会话窗口即删)。
- 快照侧 4MiB/二进制跳过已在 P0.3 实现;版本上限 200 在折叠内(P0.1)。

**验证方式**:`test/versioning.test.js` 新增 GC 用例(205 版本截断到 200 → v2 引用被剪、对象文件被删、保留对象仍在);fake KvTable 补 entries/keys/delete。

**遗留问题**:跨重启的未知会话引用不做激进回收(安全优先);真机验证待做。

---

## 真机冒烟(web profile,2026-08-25 深夜)

**目标**:把新构建同步进 `~/.dsh/profiles/web/node_modules/dsh-retrace`,起 `dsh web`,对真实会话验证 P1 Host 管线。

**验证结果**:
1. ✅ 插件在真实 harness 加载干净(apply 无抛错,路由注册成功);
2. ✅ 发现并修复真实 bug:`ctx.subprocess` 在 cordis 是 getter,未注入时**直接 throw**("cannot get property 'subprocess' without inject")——headless/最小组合下 git 面首次调用即崩。修复:ensureGit 用 try/catch 包裹,降级为纯快照回退(commit c5c1fc4);
3. ✅ `GET /git/status` 优雅降级返回 `{ok:true,value:null}`;
4. ⚠️ `GET /versions` 对**未 attach 的会话**返回 session-not-found——`ctx.sessions.get(id)` 只解析客户端已订阅(attach)的会话;GUI 打开会话即 attach,主路径(时间线推送帧/回退)可用;HTTP 降级通道在未打开会话时需冷读投影缓存(sessionProjectionCache)——记入 P1.6 观察。

**关键认知**:RPC 信封为 `POST /api/<method>` + `{type:'client-request', rpcId, method, payload}`;会话 id 带 `session-` 前缀;`session.list`/`session.history` 走磁盘读,可对未 attach 会话工作。

**P0 遗留 bug 的实锤(本轮最大收获)**:`lib/projection/versions.js` 的单元定义用了顶层 `schema`/`view` 字段,而框架 `dsh-session-projection` 的 `register()` 读的是 `definition.wire`(`{viewSchema, view}`)与 `definition.stateSchema`——**没有 wire 的单元注册为"仅检查点"类型,其键永不进入 `session/projection` 推送帧与 `snapshot()`,版本服务自 0.3.0 起在生产中从未可见**(`/versions` 恒返回 `enabled:false`,时间线无数据)。单测直接调用 definition.apply/view 绕过了框架契约,故未暴露;P1 真机冒烟(检查每个会话的 projections 块均缺 retrace/versions 键)抓到。修复:补 `stateSchema`(原始折叠状态 zod,供持久化 checkpoint 行校验)+ `wire`(客户端可见视图);保留顶层别名兼容单测(commit 8d20f3f)。**实机复验**:`插件新版本` 谱系会话的 projections 块现在含真实版本——e61d70da 5 个 marker → 5 条版本记录(kind/markerText/文件计数/messageCount 全部正确),当前会话 62c5b531 捕获到今天的真实编辑(v153124,3 文件变更)。

**遗留问题**:P1.6(可选):seam.snapshot 对未 attach 会话做投影缓存冷读,补齐时间线 HTTP 降级;headless 浏览器 GUI 冒烟(时间线渲染/回退交互)待做;快照落盘/回退需在真实边界(下一次撤回/编辑)上验证(机制已单测覆盖,本实例无新边界故未触发)。

---

## 写前校验闭环(lib/prewrite-guard.js,2026-08-26)

**目标**:8-25 事故第 1 轮"违约写入没被拦"的系统解——marker 落盘前过三层契约;`dsh-log-contract` 发布后接入(0.1.0 已上 npm)。

**方案**:

- `lib/prewrite-guard.js`(完成上次会话的 WIP 稿):
  - `createMarkerGuard({log, prewriterFactory, enabled})` → `validateMarkerAppend(session, envelope)`;
  - 依赖**运行时懒加载**(`await import('dsh-log-contract')`),包缺失/加载失败静默降级并记忆失败(不逐写重试),插件绝不被守护件拖垮;
  - `prewriterFactory` 可注入(fake 测试);`enabled(sessionId)` 门控(默认开,配 `prewrite` 开关)。
- `lib/host-core.js`:`appendEditorMarker` 增加可选 `validate` 钩子(validate first, commit later;可 async),`createEditorApi` 增加 `hooks.validateMarker` 参数;recall/edit/regenerate 三 op 接入。
- `lib/rollback.js`:restore marker 同样过校验。
- `lib/index.js`:创建守卫注入两处。
- 配置:`prewrite`(默认 true)进 DEFAULT_RETRACE_CONFIG / DEFAULT_CONFIG / parseRetraceConfig / 客户端 CONFIG_DEFAULTS。

**验证方式**:
- 单测(prewrite-guard.test.js 9 用例 + http 配置 1):fake 校验器 pass/reject/throw/门控;真实 `createPreWriter` 集成(合法信封过、8-25 空 sourceEventSeqs 形状被拒);host-core 钩子(调用时序、拒绝即不落盘、无钩子不校验);120 全绿。
- 真实化石(204,754 事件):合法 marker 信封 217ms 通过;手搓错误信封(尾事件非 surface 节点)被 S4/S8 正确拦截——守卫在真实规模下性能与正确性双达标。

**关键认知**:20 万事件全量重放校验 ~220ms,可接受;M1 检查只对 append 的 assistant/message 要求 turn/step(插件 marker 是 replace 不受影响);真实日志每个 surface 事件都带 surfaceOp 标记,夹具必须对齐。

**遗留问题**:设置 UI 未加 prewrite 开关行(可通过 localStorage 直接关);大会话(百万事件)的校验成本需随 P2 再评估。

---

## P2.1 分叉图骨架 — retrace/forkmap 投影 + 「分叉」视图 Tab(2026-08-26)

**目标**:PLAN §5.2 的分支拓扑展示层骨架——数据面(分叉边)+ 视图面(脊柱 + 旧路径卡片 + 跳转),为 P2.2 意图卡立骨架;顺带修复 0.4.2 遗留的"程序化切视图静默 no-op"。

**方案**:

- `lib/forkmap.js`(新增,纯折叠,复用 version-index 谓词):镜像官方 `foldSurface` 的状态转换(append→push;replace→splice **at startIdx**,官方 `applySurfacePlan` 同语义),并在每个 replace 边界记录 `{seq, kind, replacedSeqs}`——replacedSeqs 即被遮蔽的旧路径节点(splice 移除区间;区间非活跃时降级取 `sourceEventSeqs`)。**不截断**(分叉全貌优先;versions 的 VERSION_LIMIT 截断正是我们不扩展它的原因)。
- `lib/projection/forkmap.js`(新增):`{key:'retrace/forkmap', stateSchema, init, apply, wire:{viewSchema, view}, stateVersion:1}` + 顶层别名(照 versions 单元模式,**带 wire**——8-25 教训)。wire 保持精简:节点只有 `{seq,type}`(类型供图标),markerText 由客户端从 versions wire 按 boundarySeq join。
- `lib/versioning.js`:seam register() 追加注册 forkmap 单元(纯折叠,无副作用,不需 onChanged);`snapshotForkmap(sessionId)` HTTP 降级(与 snapshot 同构,抽公共 `snapshotKey`)。
- `lib/http.js`:`GET /forkmap?sessionId=` 路由。
- `lib/client.js`:
  - **跳转修复(0.4.2 遗留 bug 实锤)**:调研确认 `actions` 只注入给声明 `store` 的条目,chatStore 是 ui-conversation 模块私有——第三方视图 `actions?.setView?.()` 收到 undefined 静默 no-op(0.4.2 的跳转/轨迹按钮真机上失效)。修复:`switchToViewTab(viewId)` 按注册顺序 DOM 点击 tab 栏按钮(`[role="tablist"] [role="tab"]`,chat=0/trajectory=1/retrace=2/fork=3)——与用户点击同一路径。
  - 共享 `jumpToAnchor(store, seq)`(原 RetraceView 内部 jump 提升为模块级,含 waitForElement/flashKey):切 chat Tab → loadOlder 循环(24 页预算)→ rAF 轮询锚点行 → scrollIntoView + 高亮。
  - `ForkView`(id `retrace-fork`,order 30,label「分叉/Fork」):`useProjection('retrace/forkmap')` 推送帧 + HTTP 降级;脊柱 = 当前 surface 节点流(用户/助手/工具 图标 + seq),边界行卡片化(分叉图标 + kind + 被遮蔽 N 节点 + markerText 摘要);固定行高窗口化;节点点击 jump。
  - i18n:+10 键(zh/en 对齐,82=82)。

**涉及文件**:`lib/forkmap.js`(新增)、`lib/projection/forkmap.js`(新增)、`lib/versioning.js`、`lib/http.js`、`lib/client.js`、`lib/client.bundle.js`/`lib/dynamic-client.js`(重建)、`test/forkmap.test.js`(新增)、`test/http.test.js`、`test/versioning.test.js`。

**关键决策**:
- **分叉边数据走新投影单元而非扩展 versions**:VERSION_LIMIT=200 截断会丢旧分叉点;独立单元一次 fold 即全量、推送实时、与既有双通道同构(调研结论)。
- **"标记→新路径"不自解析**:官方 `traceEvent` 的 `derivedEventSeqs` 不指向新路径(新路径事件不引用标记)——新路径就是脊柱(边界后的 surface 节点),PLAN.md:295 原文修正。
- **replace 的 start/end 是事件 seq**:splice-at-startIdx 使替换节点落在被替换区间起点(官方 `applySurfacePlan` 语义),脊柱顺序即模型可见顺序(可非单调 seq)。
- 折叠对"区间非活跃"防御处理(官方会 throw):投影 apply 永不抛错,降级为仅记录边界 + `sourceEventSeqs` 兜底(与 versions 单元一致)。

**验证方式**:`test/forkmap.test.js` 13 用例(表面折叠/边界分类/链式分叉/replacedSeqs 兜底/同引用契约/wire/定义契约);`test/http.test.js` +1(forkmap 路由);`test/versioning.test.js` 更新(双单元注册断言);`pnpm check && pnpm build && pnpm test` 全绿(**134**);i18n 键集 82=82;生成物同步。

**遗留问题**:
- **真机 GUI 冒烟待做**(P1 遗留 + 本次引入):验证时间线 Tab 渲染、**跳转按钮修复后生效**(tab-bar DOM click 依赖 chat=index0 的注册顺序)、轨迹台账按钮、分叉 Tab 渲染与节点跳转。
- SVG 图形化/节点原文/分支意图卡(P2.2);分叉点性能(千级节点聚合)评估;compaction/replace 边界在分叉图上的非分叉呈现(当前仅作脊柱标记)。

---

## 真机 GUI 冒烟(web profile,2026-08-26,补 P1 遗留 + P2.1 验证)

**目标**:真实 harness 验证 P2.1(分叉 Tab/跳转修复/窗口化)+ 补 P1 遗留的时间线验证。

**方式**:`dsh --profile web --no-open --port 3080` + 无头 Chrome CDP(9222);CDP 脚本驱动打开「插件新版本讨论」会话(e61d70da),逐项断言。

**验证结果(14/14 PASS)**:
1. 4 Tab 并存:对话/轨迹/版本/分叉(conversation.view 多条目 ✓);
2. **0.4.2 跳转修复生效**:版本行「跳转」点击后活跃 tab 切到对话(activeIdx=0)——此前 `actions?.setView?.()` 静默 no-op(第三方视图无 store 注入 actions,调研实锤),tab-bar DOM click 修复真机验证通过;
3. 轨迹台账按钮切到轨迹(activeIdx=1)✓;
4. 版本视图 5 版本全数据 ✓;分叉脊柱 605 节点 ✓;
5. **发现 bug A(窗口化高度陷阱)**:viewArea flex 链 `min-height:auto` 让虚拟列表的高 spacer 把视图撑到全列表高度(33880px),列表永不滚动、窗口切片不动;官方轨迹因内容不贡献高度而幸免。修复 `bindListHeight`(实测可用高度 + `flex:none` 钉住——纯 height 被 flex 布局忽略),versions 列表同款隐患一并修;
6. **发现 bug B(链式编辑分叉可见性)**:5 次编辑互相遮蔽,仅最后 marker 在脊柱上,其余 4 个边界 UI 不可见(数据完整);新增「历史分叉点」区段展示 off-spine 边界(kind/被遮蔽数/markerText)。

**遗留问题**:分叉图节点点击跳转在真机上未逐一验证(脊柱节点跳转与版本跳转共用 jumpToAnchor,后者已验证);SVG 图形化/意图卡(P2.2);历史分叉区段的展开折叠(P2.2)。

---

## 0.4.4 修复 — 撤回/编辑失效回归(union-wide guard)(2026-08-27)

**事故**:0.4.3 的 union-wide hide guard(73fde78)在会话内 marker 累积覆盖 >40% 行时降级**所有** marker。并行会话在「规划高级版本 (1)」实测 7 个 marker 全无隐藏规则;新产生的"已撤回 4 条消息"也不隐藏——撤回/编辑"失效"(用户反馈)。

**根因**:`useMarkerHidePlan` 的 `degraded = union.size/rowCount > 0.4` 是**会话级永久状态**——历史 marker 累积一旦超限,后续每个新 marker 都被连带降级。

**修复(用户确认方案 A:per-marker 闸 + 大范围提示)**:
- guard 改回每 marker 独立(`keys.length/rowCount > 0.4` 才降级该 marker);普通撤回/编辑永远隐藏;
- 降级时渲染明确提示条(`marker.degradedHint`),首个 marker 在累积 >40% 时渲染累积提示(`marker.unionHint`);
- 操作行按"实际隐藏"判定:`rowHiddenByKey`/`useRowHidden`/`useSeqHidden` 替代 `useShadowed`——降级 marker 的消息保持可见且可操作(修 0.4.3 半失效态);
- 删除 `useShadowed`(shadowed 但未隐藏的判定已无用途)。

**验证**:真机(web profile)「规划高级版本 (1)」:修复前 hideRulesTotal=0 → 修复后 101(历史 marker 恢复隐藏);新会话大范围撤回(78 条)触发降级并显示提示条;小范围 marker 正常隐藏。`pnpm check && pnpm build && pnpm test` 全绿(134);i18n 85=85。

**遗留**:大范围撤回(如中间消息连坐 78 条)被 guard 降级——若用户确实要回退大段,可走时间线回退;guard 提示条已解释。

---

## Backlog:被遮蔽/压缩消息隐藏操作入口(2026-08-27,用户 UX 反馈)

**改进点**:被 marker 遮蔽或 compaction 压缩的消息,编辑/撤回/重新生成入口应直接隐藏,而非点击后才报 `target-shadowed`。

**背景**:0.4.4 把操作行判定从 useShadowed(被遮蔽)改为 useRowHidden/useSeqHidden(视觉隐藏)——修"降级 marker 消息可见但操作行消失"的半失效态,但把两个维度混用了:视觉隐藏(guard 保护)与操作可行性(遮蔽即失败)应分开。当前降级/压缩时按钮残留,点击报错。

**方案(下次开发执行)**:操作行显示 = `hidden(视觉) OR shadowed(被遮蔽)` 均隐藏入口;UserActionsRow/AssistantActions 判定改回含 useShadowed;核实 compaction checkpoint 事件是否携带覆盖被压缩范围的 shadowedSeqs(是则天然匹配)。

---

## UX 改进:被遮蔽/压缩消息隐藏操作入口(2026-08-28)

**背景(用户反馈)**:被 marker 遮蔽或 compaction 压缩的消息仍显示编辑/撤回按钮,点击后才报 `target-shadowed`——基础体验问题。

**方案**:
- 恢复 `useShadowed`(0.4.4 删除)——"操作可行性"维度:seq 被任何 marker 遮蔽 → 操作必然失败 → 按钮隐藏;
- UserActionsRow/AssistantActions 判定 `hidden(视觉) || shadowed(可行性)` 都隐藏入口;视觉隐藏(guard 降级保护)保持独立;
- **compaction checkpoint 支持**:`recallMarkerDefinition.match` 增加 user/message + replace + `plugin:compact` source 分支,生成 `compact:true` 的 marker 节点——shadowedSeqs = sourceEventSeqs(实测覆盖数千被压缩 seq),但 `compact` 标记使其:RecallMarkerRow 不渲染(return null)、useMarkerHidePlan/rowHiddenByKey 跳过(不参与 guard/union/视觉隐藏)、仅 useShadowed 消费(压缩消息无编辑入口);
- `isCompactCheckpoint(source)`:kind==='plugin' && plugin==='compact'(与 host 侧一致)。

**验证(真机 web profile)**:
- 「插件新版本 开发 (1)」:旧 bundle visibleRefs=2(残留)→ 新 bundle=0(修复,半整数锚点 0.4.5);
- 「数字生命讨论 (实验升维)」:编辑后 rowsWithEdit 递减(7→6,被遮蔽消息按钮消失),refs 恒 1(无残留增长);
- 全遮蔽会话 visibleUserRows=0(按钮全隐藏)。
- `pnpm check && pnpm build && pnpm test` 全绿(134);i18n 对齐。

**遗留**:重发消息/新对照链路在 headless(agent 无响应)下未能端到端复验编辑→重发→对照显示;压缩会话真机(需含 checkpoint 的会话)复验待 GUI 环境。

---

## B1 短期 + T1 — marker 压缩兼容地基(2026-08-28,事故根因 3)

**事故根因 3**:retrace 的 turn-null 编辑/撤回 marker(空 assistant/message replace)在 foldSurface 与 M1 下合法,但 **dsh-token-meter 折叠崩溃**(assistant/message 必须匹配打开的 step/start)——编辑过的会话 /compact 与压力测量永久失败(6+ 会话实测)。

**T1 规则(dsh-log-contract 0.2.2,已发布 npm)**:
- `tokenMeterViolations`(checks.js):复刻 token-meter step 状态机(step/start→end 配对 + assistant/message 匹配);仅在有 step/start 的现代会话严格判定(远古/简化日志不误报,方案 Z)。
- validate.js 全量 check:turn-null marker → T1 error(体检如实标红,化石 e61d70da 命中 5)。
- prewrite.js:只判定拟写事件自身;retrace marker(data.editor)白名单降级 warning(编辑必须可用,压缩前需 doctor 清理),其它 assistant 配对失败保持 error。
- 测试 49→53;index.js re-export tokenMeterViolations。

**retrace doctor 压缩前检测(B1 短期)**:
- seam.doctorScan(sessionId):用 tokenMeterViolations 扫描会话,返回 turn-null marker 列表(只读)。
- GET /api/plugins/retrace/doctor?sessionId=(时间线 banner 数据源)。
- 时间线 banner:"该会话含 N 个编辑/撤回标记,压缩(/compact)前请先清理"。
- 依赖 dsh-log-contract ^0.2.2(0.2.1→0.2.2 含 T1)。
- 真机验证:「数字生命讨论 (实验升维2)」9 个 marker → banner 显示 ✓;测试 134→136。

**关键认知**:marker 形态无法绕开 token-meter 检查(空 assistant/message 是唯一"合法且隐形"形态,而它必被检查;user/message 会派生幽灵消息)。根治依赖上游 D3(token meter 跳过 turn-null replace)或中期 B1(回合内携带 turn/step,受 requireIdle 限制)——已按报告路线记录。
