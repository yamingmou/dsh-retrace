/**
 * 声称 = 有校验。
 *
 * 问题:代码里到处写着"保证…""绝不…"(行为承诺),但没有任何机制保证这些承诺
 * 真的有对应校验——承诺随重构腐坏,只能靠人读。
 *
 * 本测试把**声称清单化并逐条钉死**:
 *   1. 扫描 lib/**\/*.js(排除生成件)里所有含强/弱声称词
 *      (`保证|确保|guarantee|绝不|恒通过|必须|不会|禁止|永不`)的行;
 *      **外加**显式声明的声称(CLAIM_DECLARED)——关键词扫不到的写法(如第 2 项的
 * 「两种模式共用同一条轮首回退规则」)过去**根本不在被审集合里**;
 *   2. **每条声称行**必须命中登记表里的一个片段,且**每个片段只能命中一条声称行**
 *      (一一对应:新增一条声称而片段恰好与旧行相同 → 片段命中 2 行 → 红);
 *   3. 每条片段必须有 evidence,且 evidence 必须指向**真实存在**的测试:
 *      测试标题按 `it('…')` **解析后精确匹配**(不再是"字符串出现在文件里"),
 *      并要求该测试体内至少有一条 `expect(`(掏空断言的用例不再算校验);
 *      无法逐字断言的注释/文案行,evidence 的 `note` 必须写明覆盖边界(登记不空转);
 *   4. 登记不得空转:片段必须真的命中声称行(声称被删/改写 → 登记也要改)。
 * 未登记的新声称 → CI 红(要么补校验,要么显式登记并写明理由)。
 *
 * **已知局限(诚实记录)**:第 3 条只能证明"该测试存在且有断言",不能证明断言的
 * 内容真的覆盖了这条声称的语义(不可判定);登记项的 `note` 用于人工写明对应关系。
 * 另:本测试只扫 lib/(不扫 scripts/、bin/、docs/)——非 lib 的承诺靠 review 兜底。
 * 弱声称词(必须/不会/永不…)在注释与文案里出现频繁,扩面后逐行登记;其中"文案/阈值
 * 注释"类声称的证据是**同族行为用例**(note 写明边界),不是逐字断言。
 *
 * 模块分层:只在部分构建面存在的模块,其登记项以块**包住(生成对外产物时整块移除
 * );对应 lib 文件/声称行不在时,登记项也不在清单里。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
/**
 * 声称词(扩面):强词(保证/确保/绝不)+ 弱词(恒通过/必须/不会/禁止/永不)。
 * 扩面前弱词不入集 → 「必须/永不」类声称可以无声新增。
 */
const CLAIM_RE = /保证|确保|guarantee|绝不|恒通过|必须|不会|禁止|永不/
/**
 * **关键词扫不到的声称**(显式声明)。机制盲区:第 2 项的头号声称
 * 「两种模式共用同一条轮首回退规则」用的是「共用同一条」,不在 CLAIM_RE 命中集里——
 * 它此前**根本不在被审的声称集合中**。这里按「文件 + 片段」显式登记:片段必须**恰好
 * 命中一行**(与关键词声称同等强制),该行同样必须有登记项与证据。
 */
const CLAIM_DECLARED = [
  { file: 'lib/span-semantics.js', fragment: '两种模式共用同一条轮首回退规则' },
]
/** 生成件不算声称源(dynamic-* 是 host-core 的副本;client.bundle 是打包产物)。 */
const SKIP = /(^|\/)(dynamic-(host|client)\.js|client\.bundle\.js)$/

function listLibFiles() {
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!entry.endsWith('.js')) continue
      const rel = relative(root, full).split(sep).join('/')
      if (SKIP.test(rel)) continue
      files.push(rel)
    }
  }
  walk(join(root, 'lib'))
  return files
}

/** 解析测试文件里的用例(标题 + 用例体),用于 evidence 的精确校验。 */
function parseTests(relPath) {
  const text = readFileSync(join(root, relPath), 'utf8')
  const out = []
  const re = /\b(it|test)\((['"`])((?:\\.|(?!\2).)*?)\2\s*,/g
  let m
  while ((m = re.exec(text)) !== null) {
    const start = m.index + m[0].length
    let end = text.indexOf('\n  })', start)
    if (end === -1) end = text.length
    out.push({ title: m[3], body: text.slice(start, end) })
  }
  return out
}

const testCache = new Map()
const testsOf = (relPath) => {
  if (!testCache.has(relPath)) testCache.set(relPath, parseTests(relPath))
  return testCache.get(relPath)
}

/**
 * 声称登记表:`claims` = 与该文件**声称行一一对应**的片段(每个片段恰好命中一行);
 * evidence = 覆盖该片段的测试(标题按 it() 解析后精确匹配,且用例体内必须有断言)。
 */
const CLAIM_REGISTRY = [
  {
    file: 'lib/close-guard-client.js',
    claims: ['无法保证覆盖所有入口', '而不是"桌面端都不会触发"'],
    evidence: [
      { test: 'test/close-guard-desktop-quit.test.js', title: '对外文本都写明了"壳未处理 will-prevent-unload / 退出入口随版本而变 / 桌面端一律不武装"', claim: '无法保证覆盖所有入口', note: '这两条是**设计取舍的免责说明**（不是行为承诺）：用例锁定六份对外文本都写明"入口随版本/平台而变"与"桌面端一律不武装" ⇒ 该判断有文本级校验；它不声称覆盖所有宿主版本（这正是要表达的意思）' },
      { test: 'test/close-guard-desktop-quit.test.js', title: '宿主回报 quitVeto=false（Desktop Electron 页面）→ running 会话也不 preventDefault', claim: '而不是"桌面端都不会触发"', note: '行为侧真正被钉住的是"桌面端不武装"：该用例断言即便有运行中会话、quitVeto=false 也不调用 preventDefault —— 与"具体哪条入口是否触发 beforeunload"无关' },
    ],
  },
  {
    file: 'lib/marker-carrier.js',
    claims: ['`v` 与 kind 必须有值'],
    evidence: [
      { test: 'test/migration-traces.test.js', title: 'encode/decode:缺 v 或 kind 的载荷一律不认(前缀不足以构成痕迹)', claim: '`v` 与 kind 必须有值', note: '前缀只是第一道门;v/kind 缺失或 kind 为空串时 decodeTraceText 返回 null,用例逐条断言' },
    ],
  },
  {
    file: 'lib/migration-traces.js',
    claims: ['不会二次包裹', '必须清洗掉的旧载荷键'],
    evidence: [
      { test: 'test/migration-traces.test.js', title: '幂等:对产物再跑一次 changed === 0', claim: '不会二次包裹', note: '产物已是痕迹事件 ⇒ isTraceEvent 认出并跳过,重跑零改动且字节不变' },
      { test: 'test/migration-traces.test.js', title: 'B 类痕迹载荷:targetSeq / 文本 / 原 message 全保留,`turn:null`/`step:null` 被清洗且留记录', claim: '必须清洗掉的旧载荷键', note: 'null 的 turn/step 从原载荷里删除并记入 droppedNullKeys;用例同时断言二者都不在新形态里' },
    ],
  },
  {
    file: 'lib/host-core.js',
    claims: ['绝不静默', '确保 agent 空闲', '绝不冒充"已遮蔽"', '绝不直扫稀疏', '绝不越过遮蔽区重发更早轮'],
    evidence: [
      { test: 'test/contract-runtime.test.js', title: '适配器返回坏 marker → host-core 边界抛 contract-violation(经 op 信封成 code)', claim: '绝不静默' },
      { test: 'test/host-core.test.js', title: 'running agent WITH cancel API: auto-stops (cancel + whenIdle) then edits (2026-08-30 事故修复)', claim: '确保 agent 空闲' },
      { test: 'test/host-core.test.js', title: '显式状态:spanStatus=replay-failed → span-replay-failed(内部错误,绝不冒充遮蔽)', claim: '绝不冒充"已遮蔽"' },
      { test: 'test/host-core.test.js', title: '文件侧 prompt 注入(probe.prompt)→ 重发该轮 user 原文 + marker targetSeq 指向该轮', claim: '绝不直扫稀疏', note: '重发原文一律取文件侧,不直扫 host 稀疏 events' },
      { test: 'test/host-core.test.js', title: '跨遮蔽区(更早轮已被 fold 遮蔽成幽灵) + 当前轮 user 是洞 → 只重发当前轮原文', claim: '绝不越过遮蔽区重发更早轮' },
    ],
  },
  {
    file: 'lib/adapter/dsh.js',
    claims: ['绝不冒充"已遮蔽"', '绝不冒充遮蔽', '绝不重发更早轮的文本'],
    evidence: [
      { test: 'test/adapter.test.js', title: 'replay-failed:foldSurface 重放抛错 → 内部错误状态(不冒充 already-shadowed)', claim: '绝不冒充"已遮蔽"' },
      { test: 'test/adapter.test.js', title: 'replay-failed:foldSurface 重放抛错 → 内部错误状态(不冒充 already-shadowed)', claim: '绝不冒充遮蔽', note: 'replay-failed 走独立状态与错误码,不复用 target-shadowed 文案' },
      { test: 'test/adapter.test.js', title: '跨遮蔽区(中间 fold marker 遮蔽更早轮)→ prompt 取当前轮 user,绝不被遮蔽轮的更早 user', claim: '绝不重发更早轮的文本' },
    ],
  },
  {
    file: 'lib/adapter/contract.js',
    claims: ['写前校验保证 marker 合法'],
    evidence: [
      { test: 'test/contract-runtime.test.js', title: '合法载体通过(真实 writer 产出形状)', claim: '写前校验保证 marker 合法', note: '写前校验负责语义/契约,形状由 assertMarkerShape 兜底(两段结构:第 1 段审计 + 第 2 段载体)' },
    ],
  },
  {
    file: 'lib/span-semantics.js',
    claims: ['绝不冒充遮蔽', '两种模式共用同一条轮首回退规则'],
    evidence: [
      { test: 'test/adapter.test.js', title: 'replay-failed:foldSurface 重放抛错 → 内部错误状态(不冒充 already-shadowed)', claim: '绝不冒充遮蔽' },
      // 该声称的 evidence = **结构断言**(不是行为用例)——
      // 行为一致不排除冒出第三份实现;该断言在 lib/ 里机械搜索第二份回退/切片实现。
      // (这条声称过去连"被审集合"都没进:它不含任何声称词,靠 CLAIM_DECLARED 声明。)
      { test: 'test/span-single-truth.test.js', title: 'lib/ 下除 lib/span-semantics.js 外,不存在第二份轮首回退/尾部切片实现', claim: '两种模式共用同一条轮首回退规则', note: '结构断言:规则只有一份实现(不只是行为一致);轮首回退原语 roundStartIndex 亦被 host-core regenerate 回退路径复用' },
      // related(非声称行的设计属性,同样有校验:两层同一实现):
      { test: 'test/span-semantics.test.js', title: 'tail 回退轮首(审计指出的分叉点):目标是轮内 assistant → 起点=该轮 user' },
      { test: 'test/span-semantics.test.js', title: 'tail 模式:两模式语义统一后逐字一致(旧业务层"从目标自身切到尾"已废弃)' },
    ],
  },
  {
    file: 'lib/message-list.js',
    claims: [],
    evidence: [],
    note: '本文件无声称词字样;其规则单一真相由 test/span-semantics.test.js + test/span-single-truth.test.js 覆盖(另见下方按文件登记的弱声称行)',
  },
  {
    file: 'lib/client.js',
    claims: ['保证英文界面也显示英文'],
    evidence: [
      { test: 'test/client-error.test.js', title: 'agent-busy 仍映射 error.busy;未映射 code → 透传 host message(已中文直接用);无 message → error.generic', claim: '保证英文界面也显示英文' },
    ],
  },
  {
    file: 'lib/close-guard.js',
    claims: ['绝不中断/取消 agent、绝不写事件', '绝不用 Object.keys(service)'],
    evidence: [
      { test: 'test/close-guard.test.js', title: '有运行中会话 → 提示并列出原因;全静止 → 静默', claim: '绝不中断/取消 agent、绝不写事件', note: '守卫只查询+提示;测试断言其返回快照与提示行,不含任何写路径' },
      // 2026-09-14 P1:会话枚举绝不猜服务字段(Object.keys(service) 会取到 list/get 自身,
      // 令运行中扫描静默为空)。用例:list()-only 新宿主必须看到全部运行中会话,
      // 且「既无 list 也无 keys」时必须回空数组而不是去猜服务字段。
      { test: 'test/close-guard.test.js', title: '既无 list 也无 keys → 空数组 + 可判定诊断(不静默;不猜服务字段)', claim: '绝不用 Object.keys(service)', note: '同文件另有「新宿主 list() 且无 keys() → 看到全部 2 个」断言:猜服务字段的实现会得 0 而变红;诊断断言钉住「形状不认识时必须留痕」' },
    ],
  },
  {
    file: 'lib/prewrite-guard.js',
    claims: ['保证"体检看到的问题 = 写入前拦下的问题"', '绝不因守护件损坏主功能'],
    evidence: [
      { test: 'test/prewrite-guard.test.js', title: 'rejects the 8-25 incident shape: empty sourceEventSeqs on a replace', claim: '保证"体检看到的问题 = 写入前拦下的问题"' },
      { test: 'test/prewrite-guard.test.js', title: 'degrades silently when the lazy import fails, and remembers the failure', claim: '绝不因守护件损坏主功能' },
    ],
  },
  {
    file: 'lib/interrupt-guard.js',
    claims: ['在 finally 块保证 `turn/end`', '绝不自动写 turn/end', 'finally 保证写入'],
    evidence: [
      { test: 'test/interrupt-guard.test.js', title: 'turn/end reason=interrupted → 官方正常闭合，不计未闭合', claim: '在 finally 块保证 `turn/end`' },
      { test: 'test/interrupt-guard.test.js', title: '有 turn/start 无 turn/end（崩溃/强杀现场）→ open', claim: '绝不自动写 turn/end', note: '守卫只报 open,不补写 turn/end' },
      { test: 'test/interrupt-guard.test.js', title: 'turn/end reason=interrupted → 官方正常闭合，不计未闭合', claim: 'finally 保证写入', note: '中断闭合(reason=interrupted/aborted)按官方 finally 语义视为已闭合,不误报 open' },
    ],
  },
  {
    file: 'lib/watchdog.js',
    claims: ['绝不检查 fileSeq < events.length'],
    evidence: [
      { test: 'test/watchdog.test.js', title: '正常使用：fileSeq <= events.length 不误报', claim: '绝不检查 fileSeq < events.length' },
    ],
  },
  {
    file: 'lib/http.js',
    claims: ['绝不中断/写事件'],
    evidence: [
      { test: 'test/http.test.js', title: 'GET /runningState 返回全会话运行中清单 { running: [...] }(纯读)', claim: '绝不中断/写事件' },
    ],
  },
  // ── 弱声称词扩面(必须 / 不会 / 永不 / 禁止 / 恒通过)后的逐行登记 ──
  // 每个文件一条:claims 片段**只命中该文件里的这一行**(片段通配 → 红),evidence 指向覆盖它的用例
  // (标题精确匹配 + 用例体内有断言);无法逐字断言的注释/文案行在 note 里写明覆盖边界。
  {
    file: 'lib/adapter/contract.js',
    claims: [
      '成本可控:大日志(百万级事件',
      'SPAN_STATUS 成员',
      '\'status ≠ ok 时',
      '元素必须是非 null 对象',
      'n) 断言,成本必须可忽略)',
      '两个角色都必须实现各自方法)',
      '*   - 必须从持久化层读',
    ],
    evidence: [
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"', claim: '成本可控:大日志(百万级事件' },
      { test: 'test/contract-runtime.test.js', title: '非法 status → 报错并列全合法取值', claim: 'SPAN_STATUS 成员' },
      { test: 'test/contract-runtime.test.js', title: '非 ok 状态带 span → 报错(状态显式,不允许自相矛盾)', claim: '\'status ≠ ok 时' },
      { test: 'test/contract-runtime.test.js', title: '合法(含无 seq 的 header 帧)通过;非数组报错', claim: '元素必须是非 null 对象' },
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"', claim: 'n) 断言,成本必须可忽略)' },
      { test: 'test/contract-runtime.test.js', title: '非对象/空段/首尾≠start,end/元素非法 → 明确报错', claim: ' 首尾一致(否则重放面与写入' },
      { test: 'test/contract-runtime.test.js', title: '缺 reader.readEvents / writer.writeReplace → 组装即报错(不再运行到一半才炸)', claim: '两个角色都必须实现各自方法)' },
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"', claim: '*   - 必须从持久化层读' },
    ],
  },
  {
    // 两段结构改造后本文件**不再有声称词行**:turn/step 三情形的八条声称
    // （官方 token-meter 配对 / 信封 / 计数器推进 / 半关闭 turn 防御）随翻译作废一并消失，
    // 剩下的"写前断言先于 append""两段形状"等不变量的机械校验落在
    // lib/adapter/contract.js 的 assertAuditShape/assertMarkerShape 与其用例上。
    file: 'lib/adapter/dsh-writer.js',
    claims: [],
    evidence: [],
    note: '载体写入器:形状不变量由 lib/adapter/contract.js 的两段断言覆盖(test/contract-runtime.test.js);'
      + '写序(审计先写)与轮边界(source.kind=model)由 test/host-core.test.js「两段结构…」用例覆盖',
  },
  {
    file: 'lib/adapter/dsh.js',
    claims: [
      '遮蔽移除节点 → nodes',
      '// 违规**必须往上抛**',
      '必须算在文件侧',
    ],
    evidence: [
      { test: 'test/adapter.test.js', title: '位置序 ≠ seq 数值序:marker 插在中间时 span 的 start 数值可 > end(官方只认位置)', claim: '遮蔽移除节点 → nodes' },
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"', claim: '// 违规**必须往上抛**' },
      { test: 'test/adapter.test.js', title: '跨遮蔽区(中间 fold marker 遮蔽更早轮)→ prompt 取当前轮 user,绝不被遮蔽轮的更早 user', claim: '必须算在文件侧' },
    ],
  },
  {
    file: 'lib/client.js',
    claims: [
      '点击展开查看原提问（仅作对照',
      'badge.hint',
      '用户实测调大至 20）：行数',
      // 2026-09-15「收起三处」:注释里逐字引用了用户原话(含弱声称词)。
      '要不必须到底部才能收起」。两枚是同一个动作',
    ],
    evidence: [
      { test: 'test/client-error.test.js', title: 'zh/en 字典键集完全一致且无空值(英文界面不留中文键缺口;文案行声称的机械兜底)', claim: '点击展开查看原提问（仅作对照', note: '文案行:由字典键完整性用例兜底(两边都有键、非空);逐字文案不在此断言' },
      { test: 'test/client-error.test.js', title: 'zh/en 字典键集完全一致且无空值(英文界面不留中文键缺口;文案行声称的机械兜底)', claim: 'badge.hint', note: '文案行:同上(会话铭牌短码提示),短码确定性另由 test/badge.test.js 覆盖' },
      { test: 'test/prewrite-guard.test.js', title: '遮蔽 > 40 节点但小会话(<2000 事件)→ 不拦(短会话豁免)', claim: '用户实测调大至 20）：行数', note: '阈值注释(client 侧短会话豁免 20 行):行为面同族阈值由 prewrite-guard 用例覆盖;client 侧渲染阈值本身暂无用例 —— 登记以免静默改动' },
      // 2026-09-15「收起三处」:注释里**逐字**引用了用户原话(含弱声称词"必须")。
      // 这是需求引文,不是产品保证 ⇒ 按既有格式登记,证据是覆盖该需求的行为用例。
      { test: 'test/client-chat-hooks.test.js', title: 'R46 · 收起三处：开头一枚 + 末尾一枚（未展开态一个都没有）', claim: '要不必须到底部才能收起」。两枚是同一个动作', note: '需求引文(收起入口三处):开头/末尾各恰好一枚、位置分别在子行之前/之后、两枚同一个 onToggle(seq)' },
      { test: 'test/client-chat-hooks.test.js', title: 'R49 · 悬浮收起条：父行滚出视口上方、末尾还在视口下方时给得出入口', claim: '要不必须到底部才能收起」。两枚是同一个动作', note: '同一引文的第三处(展开层内悬浮):展开层横跨视口时给浮层入口,末尾进视口/整层滚出后都不给' },
    ],
  },
  {
    file: 'lib/host-core.js',
    claims: [
      '传出去的 span 必须先合规',
      '// 出口自检:适配器返回的',
      '编辑/重发发生在 agent',
      '不会被 details 覆盖',
    ],
    evidence: [
      { test: 'test/contract-runtime.test.js', title: '传入坏 span 时**任何写入都不发生**(断言先于 append;不留半关闭 turn)', claim: '传出去的 span 必须先合规' },
      { test: 'test/contract-runtime.test.js', title: '适配器返回坏 marker → host-core 边界抛 contract-violation(经 op 信封成 code)', claim: '// 出口自检:适配器返回的' },
      { test: 'test/host-core.test.js', title: 'running agent WITH cancel API: auto-stops (cancel + whenIdle) then edits (2026-08-30 事故修复)', claim: '编辑/重发发生在 agent' },
      { test: 'test/client-error.test.js', title: 'agent-busy 仍映射 error.busy;未映射 code → 透传 host message(已中文直接用);无 message → error.generic', claim: '不会被 details 覆盖' },
    ],
  },
  {
    file: 'lib/index.js',
    claims: [
      'regenerate 的重发原文必须来自',
      ':`bootPin(99)`',
      '24s 窗口内会话未驻留 →',
    ],
    evidence: [
      { test: 'test/host-core.test.js', title: 'rewinds to the preceding user prompt and re-sends its text', claim: 'regenerate 的重发原文必须来自' },
      { test: 'test/badge.test.js', title: '同一 id 确定性：两次调用结果相同', claim: ':`bootPin(99)`', note: '缺陷复盘注释(0.4.19 启动重试窗口):该启动重试逻辑本身无用例;短码依据的确定性由 badge 用例覆盖,此行的回归保护靠 review 兜底' },
      { test: 'test/badge.test.js', title: '同一 id 确定性：两次调用结果相同', claim: '24s 窗口内会话未驻留 →', note: '同上(短码永不显示的症候):启动窗口重试无用例,登记以免静默改动' },
    ],
  },
  {
    file: 'lib/interrupt-guard.js',
    claims: [
      '含 reason.kind=',
    ],
    evidence: [
      { test: 'test/interrupt-guard.test.js', title: 'turn/end reason=interrupted → 官方正常闭合，不计未闭合', claim: '含 reason.kind=' },
    ],
  },
  {
    file: 'lib/message-list.js',
    claims: [
      '日志层：客观记录一切消息事件',
    ],
    evidence: [
      { test: 'test/message-list.test.js', title: '遮蔽区间 → 覆盖的标 shadowed，其余 active', claim: '日志层：客观记录一切消息事件', note: '日志层 append-only:投影只给状态、不改写日志(用例断言投影结果;日志本体完整性由 host-core 折叠用例覆盖)' },
    ],
  },
  {
    file: 'lib/prewrite-guard.js',
    claims: [
      '* 会话根本不会被改坏。',
      '绝对遮蔽阈值：遮蔽 ≤ 40',
      '/** 会话规模阈值：事件数',
    ],
    evidence: [
      { test: 'test/prewrite-guard.test.js', title: 'rejects the 8-25 incident shape: empty sourceEventSeqs on a replace', claim: '* 会话根本不会被改坏。' },
      { test: 'test/prewrite-guard.test.js', title: '遮蔽 ≤ 40 节点(绝对阈值):即使大会话也不拦(2026-09-01 编辑最后一条修复)', claim: '绝对遮蔽阈值：遮蔽 ≤ 40' },
      { test: 'test/prewrite-guard.test.js', title: '遮蔽 ≤ 40 节点(绝对阈值):即使大会话也不拦(2026-09-01 编辑最后一条修复)', claim: '/** 会话规模阈值：事件数' },
    ],
  },
  // ── 短码侧身份确认（lib/identity/shortcode.js，公开面）─────────────────────
  // 该模块把「身份判定只看 session id」「已登记码钉住不变」「不可判必须显式」
  // 「身份与可用性分栏」等硬约束写在注释里；每条都由 test/identity-shortcode.test.js
  // 的行为用例逐条钉住（合成数据，不读真实基座/短码表，公开产物里同样可跑）。
  {
    file: 'lib/identity/shortcode.js',
    claims: [
      '**短码必须可解析到 session id**',
      '**身份判定永不读短码**',
      '是两个并列字段，永不合并',
      '但折叠若产生歧义必须检出',
      '**只用于比较/连接**，绝不回写',
      '折叠即产生歧义 → 必须检出',
      '绝不用于改写身份或覆盖冲突',
      '**不可判必须显式输出**，不默认通过',
      '本函数绝不把两者相乘',
      '独立分栏，绝不参与上面的判定',
      '**已登记(pinned)的码永不变**',
      '故运行时**绝不**用推导结果覆盖已登记码',
    ],
    evidence: [
      { test: 'test/identity-shortcode.test.js', title: 'A2 短码 → 唯一 session id:已登记码解析到登记的会话', claim: '**短码必须可解析到 session id**' },
      { test: 'test/identity-shortcode.test.js', title: 'R1 身份判定只看 uuid:传入短码这类非 uuid 判为不可解析', claim: '**身份判定永不读短码**', note: 'sameSession 只吃 id:短码形状的输入被显式判为不可解析,而不是"看着像就通过"' },
      { test: 'test/identity-shortcode.test.js', title: 'R10 identity 与 availability 是两个并列字段(顶层同级,不合并)', claim: '是两个并列字段，永不合并' },
      { test: 'test/identity-shortcode.test.js', title: '大小写折叠:FF 根标记的小写写法解析到同一会话', claim: '但折叠若产生歧义必须检出', note: '正常折叠(同一会话两种写法)必须命中;真正的折叠歧义由下一条用例钉住' },
      { test: 'test/identity-shortcode.test.js', title: '规范化是纯函数:normalizeSessionId/uuidOf 不改动入参对象', claim: '**只用于比较/连接**，绝不回写' },
      { test: 'test/identity-shortcode.test.js', title: '折叠歧义:根标记 FF 与真实 ff 工作区折叠后相撞 → 检出为 ambiguous', claim: '折叠即产生歧义 → 必须检出' },
      { test: 'test/identity-shortcode.test.js', title: 'R9 一码两指 → REFUSED_AMBIGUOUS,不静默择一', claim: '绝不用于改写身份或覆盖冲突', note: '冲突只记 REFUSED_AMBIGUOUS 并保留两个候选,绝不择一覆盖' },
      { test: 'test/identity-shortcode.test.js', title: 'A5 不可判必须显式:码不可解析 → undecidable + 原因', claim: '**不可判必须显式输出**，不默认通过' },
      { test: 'test/identity-shortcode.test.js', title: 'R10 verifyPair 的身份判定不读取可用性(注入 availability 也不影响判定)', claim: '本函数绝不把两者相乘' },
      { test: 'test/identity-shortcode.test.js', title: 'R10 身份一致但文件缺失 → 身份栏仍 consistent,可用性栏独立为 false', claim: '独立分栏，绝不参与上面的判定' },
      { test: 'test/identity-shortcode.test.js', title: 'R9 分配器:已登记码钉住不变,新会话在工作区序号尾部追加', claim: '**已登记(pinned)的码永不变**' },
      { test: 'test/identity-shortcode.test.js', title: 'R9 基座换代:重推导会改码,但已登记码仍不变(钉住优先于推导)', claim: '故运行时**绝不**用推导结果覆盖已登记码', note: '用例先证明"按新集合重推导确实会把码改指",再断言已登记码不动且新会话改用追加号' },
    ],
  },
]

describe('声称 = 有校验', () => {
  const files = listLibFiles()
  const keywordLines = []
  for (const rel of files) {
    readFileSync(join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      if (CLAIM_RE.test(line)) keywordLines.push({ file: rel, line: i + 1, text: line.trim() })
    })
  }
  // 显式声明的声称(关键词扫不到):片段必须恰好命中一行,否则声明本身失效(红)
  const declaredProblems = []
  const declaredLines = []
  for (const d of CLAIM_DECLARED) {
    if (!existsSync(join(root, d.file))) { declaredProblems.push(`${d.file}: 声明文件不存在(登记空转,请删)`); continue }
    const hits = readFileSync(join(root, d.file), 'utf8').split('\n')
      .map((line, i) => ({ file: d.file, line: i + 1, text: line.trim() }))
      .filter((h) => h.text.includes(d.fragment))
    if (hits.length !== 1) declaredProblems.push(`${d.file}: 声明片段「${d.fragment}」命中 ${hits.length} 行(期望恰好 1)`)
    declaredLines.push(...hits)
  }
  // 被审集合 = 关键词命中 ∪ 显式声明(按 文件:行 去重)
  const seen = new Set()
  const claimLines = []
  for (const hit of [...keywordLines, ...declaredLines]) {
    const key = `${hit.file}:${hit.line}`
    if (seen.has(key)) continue
    seen.add(key)
    claimLines.push(hit)
  }
  const lineHits = (entry, claim) => claimLines.filter((h) => h.file === entry.file && h.text.includes(claim))

  it('扫描到声称(清单非空,防止扫描规则失效导致"假绿")', () => {
    expect(files.length).toBeGreaterThan(20) // 各层 lib 文件数不同(部分模块随构建面不同)
    expect(claimLines.length).toBeGreaterThan(10)
    // 扩面后弱声称词必须真的在命中集里(否则"扩面"是假的)
    expect(claimLines.some((h) => /必须|不会|永不|禁止|恒通过/.test(h.text))).toBe(true)
  })

  it('显式声明的声称必须恰好命中一行(机制盲区:关键词扫不到的声称也要进被审集合)', () => {
    expect(CLAIM_DECLARED.length).toBeGreaterThan(0)
    expect(declaredProblems).toEqual([])
    expect(declaredLines.length).toBe(CLAIM_DECLARED.length)
    // 声明必须真的补上关键词扫不到的行(否则该声明是多余的)
    const keywords = new Set(keywordLines.map((h) => `${h.file}:${h.line}`))
    expect(declaredLines.filter((h) => !keywords.has(`${h.file}:${h.line}`)).length).toBe(declaredLines.length)
  })

  it('每一条声称行都有登记,且**每个片段只对应一条声称行**(一一对应,防片段通配)', () => {
    const unregistered = []
    const ambiguous = []
    for (const hit of claimLines) {
      const matched = CLAIM_REGISTRY.filter((entry) => entry.file === hit.file
        && (entry.claims ?? []).some((claim) => hit.text.includes(claim)))
      if (matched.length === 0) unregistered.push(`${hit.file}:${hit.line}  ${hit.text}`)
      if (matched.length > 1) ambiguous.push(`${hit.file}:${hit.line} 命中多个登记项`)
    }
    expect(unregistered).toEqual([])
    expect(ambiguous).toEqual([])
    // 反向:每个片段必须恰好命中一行(片段通配 → 命中多行 → 红;声称被删 → 命中 0 行 → 红)
    const strayFragments = []
    for (const entry of CLAIM_REGISTRY) {
      for (const claim of entry.claims ?? []) {
        const hits = lineHits(entry, claim)
        if (hits.length !== 1) strayFragments.push(`${entry.file}: 片段「${claim}」命中 ${hits.length} 行(期望恰好 1)`)
      }
    }
    expect(strayFragments).toEqual([])
  })

  it('每条登记都必须真的对应校验(用例标题解析后精确匹配 + 用例体内有断言)', () => {
    const problems = []
    for (const entry of CLAIM_REGISTRY) {
      const entryClaims = entry.claims ?? []
      if (entryClaims.length === 0) {
        if (!entry.note) problems.push(`${entry.file}: 空登记必须有 note 说明`)
        continue
      }
      if (!files.includes(entry.file)) problems.push(`${entry.file}: 文件不存在(登记空转,请删)`)
      // 每条声称必须有 evidence
      for (const claim of entryClaims) {
        if (!(entry.evidence ?? []).some((e) => e.claim === claim)) problems.push(`${entry.file}: 声称「${claim}」没有对应 evidence`)
      }
      for (const ev of entry.evidence ?? []) {
        if (!existsSync(join(root, ev.test))) { problems.push(`${entry.file}: evidence 测试文件不存在 ${ev.test}`); continue }
        const tests = testsOf(ev.test)
        const found = tests.find((t) => t.title === ev.title)
        if (!found) { problems.push(`${entry.file}: ${ev.test} 里没有用例「${ev.title}」(标题需精确匹配)`); continue }
        if (!found.body.includes('expect(')) problems.push(`${entry.file}: ${ev.test} 的用例「${ev.title}」体内没有任何断言(空转用例不算校验)`)
      }
    }
    expect(problems).toEqual([])
  })
})
