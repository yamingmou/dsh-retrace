# DEVLOG — 逐功能开发记录

> 按 [PLAN.md](./PLAN.md) §8.1:每完成一个功能单元即追加一条,与提交一一对应。
> 每条:目标 / 方案 / 涉及文件 / 关键决策 / 验证方式 / 遗留问题。

---

## 步骤 0 — 改名与工程基建(2026-08-21)

**目标**:目录名 `dsh-message-editor` → `dsh-retrace`;远程地址指向新仓库;全仓残留清零;建立开发记录文件。

**方案**:

- 目录改名:仓库根目录本身即 `dsh-message-editor/`,直接 `mv`(git 仓库与其父目录名无关,仓库内相对路径引用不受影响)。
- `git remote set-url origin https://github.com/azmavethy/dsh-retrace.git`(与 package.json `repository` 字段一致)。
- `HUMANS.txt` / `LICENSE` 抬头品牌同步;`PLAN.md` 自身的历史迁移说明保留(它是改名记录)。
- 新增 `DEVLOG.md`。

**涉及文件**:`HUMANS.txt`、`LICENSE`、`DEVLOG.md`(新增)、`PLAN.md`(勾选状态)。

**关键决策**:旧包 `dsh-message-editor@0.2.3` deprecation 发布(仅 README 迁移指引)后置,不影响 P0 开发。

**验证方式**:`git status` 干净(除 P0 进行中文件);`git remote -v` 指向新地址;`git grep -i message-editor` 仅剩 PLAN.md 历史迁移说明与 CHANGELOG/README 的迁移文档(有意保留)。

**遗留问题**:新远程仓库 `azmavethy/dsh-retrace` 若尚未在 GitHub 创建,首次 `git push` 前需创建;旧包 deprecation 发布待定。

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
