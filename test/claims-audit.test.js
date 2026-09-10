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
 * 能力分层:仅本仓私有侧存在的模块,其登记项以块**包住(生成公开产物时
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
    file: 'lib/host-core.js',
    claims: ['绝不静默', '确保 agent 空闲', '绝不冒充"已遮蔽"', '绝不直扫稀疏', '绝不越过遮蔽区重发更早轮'],
    evidence: [
      { test: 'test/contract-runtime.test.js', title: '适配器返回坏 marker → host-core 边界抛 contract-violation(经 op 信封成 code)', claim: '绝不静默' },
      { test: 'test/host-core.test.js', title: 'running agent WITH cancel API: auto-stops (cancel + whenIdle) then edits (2026-08-30 事故闭环)', claim: '确保 agent 空闲' },
      { test: 'test/host-core.test.js', title: 'issue-229 显式状态:spanStatus=replay-failed → span-replay-failed(内部错误,绝不冒充遮蔽)', claim: '绝不冒充"已遮蔽"' },
      { test: 'test/host-core.test.js', title: '文件侧 prompt 注入(probe.prompt)→ 重发该轮 user 原文 + marker targetSeq 指向该轮', claim: '绝不直扫稀疏', note: 'M-1:重发原文一律取文件侧,不直扫 host 稀疏 events' },
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
      { test: 'test/contract-runtime.test.js', title: '合法 marker 通过(真实 writer 产出形状)', claim: '写前校验保证 marker 合法', note: '写前校验负责语义/契约,形状由 assertMarkerShape 兜底' },
    ],
  },
  {
    file: 'lib/span-semantics.js',
    claims: ['绝不冒充遮蔽', '两种模式共用同一条轮首回退规则'],
    evidence: [
      { test: 'test/adapter.test.js', title: 'replay-failed:foldSurface 重放抛错 → 内部错误状态(不冒充 already-shadowed)', claim: '绝不冒充遮蔽' },
      // issue-230 :第 2 项头号声称的 evidence = **结构断言**(不是行为用例)——
      // 行为一致不排除冒出第三份实现;该断言在 lib/ 里机械搜索第二份回退/切片实现。
      // (这条声称过去连"被审集合"都没进:它不含任何声称词,靠 CLAIM_DECLARED 声明。)
      { test: 'test/span-single-truth.test.js', title: 'issue-230 :lib/ 下除 lib/span-semantics.js 外,不存在第二份轮首回退/尾部切片实现', claim: '两种模式共用同一条轮首回退规则', note: '结构断言:规则只有一份实现(不只是行为一致);轮首回退原语 roundStartIndex 亦被 host-core regenerate 回退路径复用' },
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
    claims: ['绝不中断/取消 agent、绝不写事件'],
    evidence: [
      { test: 'test/close-guard.test.js', title: '有运行中会话 → 提示并列出原因;全静止 → 静默', claim: '绝不中断/取消 agent、绝不写事件', note: '守卫只查询+提示;测试断言其返回快照与提示行,不含任何写路径' },
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
  // ── issue-230 :弱声称词扩面(必须 / 不会 / 永不 / 禁止 / 恒通过)后的逐行登记 ──
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
      ' 首尾一致(否则重放面与写入',
      '两个角色都必须实现各自方法)',
      '*   - 必须从持久化层读',
    ],
    evidence: [
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"(issue-229 中-4)', claim: '成本可控:大日志(百万级事件' },
      { test: 'test/contract-runtime.test.js', title: '非法 status → 报错并列全合法取值', claim: 'SPAN_STATUS 成员' },
      { test: 'test/contract-runtime.test.js', title: '非 ok 状态带 span → 报错(状态显式,不允许自相矛盾)', claim: '\'status ≠ ok 时' },
      { test: 'test/contract-runtime.test.js', title: '合法(含无 seq 的 header 帧)通过;非数组报错', claim: '元素必须是非 null 对象' },
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"(issue-229 中-4)', claim: 'n) 断言,成本必须可忽略)' },
      { test: 'test/contract-runtime.test.js', title: '非对象/空段/首尾≠start,end/元素非法 → 明确报错', claim: ' 首尾一致(否则重放面与写入' },
      { test: 'test/contract-runtime.test.js', title: '缺 reader.readEvents / writer.writeReplace → 组装即报错(不再运行到一半才炸)', claim: '两个角色都必须实现各自方法)' },
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"(issue-229 中-4)', claim: '*   - 必须从持久化层读' },
    ],
  },
  {
    file: 'lib/adapter/dsh-writer.js',
    claims: [
      '官方 token-meter',
      ' marker 必须落在合法',
      '都必须在边界处形状合规(违规',
      '620）：turn/end 必须带',
      '残留 fallback 标注',
      '契约边界:**可抛断言必须在任何',
      '日志里留下"半关闭 turn',
      'nextTurn+1，不会复用',
    ],
    evidence: [
      { test: 'test/host-core.test.js', title: '情形②（有打开着的 turn、无打开的 step）：marker 用该 turn 号 + 新 step 号（5e551001 D8 现场）', claim: '官方 token-meter' },
      { test: 'test/host-core.test.js', title: '情形②（有打开着的 turn、无打开的 step）：marker 用该 turn 号 + 新 step 号（5e551001 D8 现场）', claim: ' marker 必须落在合法' },
      { test: 'test/contract-runtime.test.js', title: '适配器返回坏 marker → host-core 边界抛 contract-violation(经 op 信封成 code)', claim: '都必须在边界处形状合规(违规' },
      { test: 'test/host-core.test.js', title: '轮次间编辑（无打开 step、无打开 turn = 情形③）：完整 turn 信封 + 推进 loop 计数器，T1 通过（0.4.17v3 P1/D8 治本）', claim: '620）：turn/end 必须带' },
      { test: 'test/host-core.test.js', title: '轮次间编辑（无打开 step、无打开 turn = 情形③）：完整 turn 信封 + 推进 loop 计数器，T1 通过（0.4.17v3 P1/D8 治本）', claim: '残留 fallback 标注' },
      { test: 'test/contract-runtime.test.js', title: '出口断言失败时**先落盘再报错**(不留"客户端报失败、面上其实已改"的半状态,独立审查 issue-229 中-3)', claim: '契约边界:**可抛断言必须在任何' },
      { test: 'test/contract-runtime.test.js', title: '传入坏 span 时**任何写入都不发生**(断言先于 append;不留半关闭 turn)', claim: '日志里留下"半关闭 turn' },
      { test: 'test/host-core.test.js', title: '轮次间编辑（无打开 step、无打开 turn = 情形③）：完整 turn 信封 + 推进 loop 计数器，T1 通过（0.4.17v3 P1/D8 治本）', claim: 'nextTurn+1，不会复用' },
    ],
  },
  {
    file: 'lib/adapter/dsh.js',
    claims: [
      '遮蔽移除节点 → nodes',
      '// 违规**必须往上抛**',
      'session.events',
      '// dsh-writer 的',
    ],
    evidence: [
      { test: 'test/adapter.test.js', title: '位置序 ≠ seq 数值序:marker 插在中间时 span 的 start 数值可 > end(官方只认位置)', claim: '遮蔽移除节点 → nodes' },
      { test: 'test/adapter.test.js', title: 'readEventsFromFile:日志记录包装漂移(抽样命中 undefined 洞)→ 抛契约违规,不静默当"文件不可读"(issue-229 中-4)', claim: '// 违规**必须往上抛**' },
      { test: 'test/adapter.test.js', title: '跨遮蔽区(中间 fold marker 遮蔽更早轮)→ prompt 取当前轮 user,绝不被遮蔽轮的更早 user', claim: 'session.events' },
      { test: 'test/adapter.test.js', title: 'maxStepInTurnFromFile:从全量事件算 turn 内最大 step(情形②窗口化防御)', claim: '// dsh-writer 的' },
    ],
  },
  {
    file: 'lib/client.js',
    claims: [
      '点击展开查看原提问（仅作对照',
      'fork.badgeHint',
      '用户实测调大至 20）：行数',
      '2026-08-31）：短码',
    ],
    evidence: [
      { test: 'test/client-error.test.js', title: 'zh/en 字典键集完全一致且无空值(英文界面不留中文键缺口;issue-230:文案行声称的机械兜底)', claim: '点击展开查看原提问（仅作对照', note: '文案行:由字典键完整性用例兜底(两边都有键、非空);逐字文案不在此断言' },
      { test: 'test/client-error.test.js', title: 'zh/en 字典键集完全一致且无空值(英文界面不留中文键缺口;issue-230:文案行声称的机械兜底)', claim: 'fork.badgeHint', note: '文案行:同上(会话铭牌短码提示),短码确定性另由 test/badge.test.js 覆盖' },
      { test: 'test/prewrite-guard.test.js', title: '遮蔽 > 40 节点但小会话(<2000 事件)→ 不拦(短会话豁免)', claim: '用户实测调大至 20）：行数', note: '阈值注释(client 侧短会话豁免 20 行):行为面同族阈值由 prewrite-guard 用例覆盖;client 侧渲染阈值本身暂无用例 —— 登记以免静默改动' },
      { test: 'test/badge.test.js', title: '同一 id 确定性：两次调用结果相同', claim: '2026-08-31）：短码' },
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
      { test: 'test/host-core.test.js', title: 'running agent WITH cancel API: auto-stops (cancel + whenIdle) then edits (2026-08-30 事故闭环)', claim: '编辑/重发发生在 agent' },
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
      '编辑必须生效），只返回 `{',
      '绝对遮蔽阈值：遮蔽 ≤ 40',
      '/** 会话规模阈值：事件数',
      '校验先于落盘，包裹事件尚未写入',
      '// 尚未写入 events',
      'break /compact',
    ],
    evidence: [
      { test: 'test/prewrite-guard.test.js', title: 'guard 返回 t1Ok=false 但**不阻断**写入（编辑必须生效；调用方未传 wrapped 信封时的防御路径）', claim: '* 会话根本不会被改坏。' },
      { test: 'test/prewrite-guard.test.js', title: 'guard 返回 t1Ok=false 但**不阻断**写入（编辑必须生效；调用方未传 wrapped 信封时的防御路径）', claim: '编辑必须生效），只返回 `{' },
      { test: 'test/prewrite-guard.test.js', title: '遮蔽 ≤ 40 节点(绝对阈值):即使大会话也不拦(2026-09-01 编辑最后一条修复)', claim: '绝对遮蔽阈值：遮蔽 ≤ 40' },
      { test: 'test/prewrite-guard.test.js', title: '遮蔽 ≤ 40 节点(绝对阈值):即使大会话也不拦(2026-09-01 编辑最后一条修复)', claim: '/** 会话规模阈值：事件数' },
      { test: 'test/prewrite-guard.test.js', title: 'guard：wrappedBefore/wrappedAfter 传入完整序列后 T1 自检通过（误报消除）', claim: '校验先于落盘，包裹事件尚未写入' },
      { test: 'test/prewrite-guard.test.js', title: 'guard：wrappedBefore/wrappedAfter 传入完整序列后 T1 自检通过（误报消除）', claim: '// 尚未写入 events' },
      { test: 'test/prewrite-guard.test.js', title: 'guard 返回 t1Ok=false 但**不阻断**写入（编辑必须生效；调用方未传 wrapped 信封时的防御路径）', claim: 'break /compact' },
    ],
  },
]

describe('声称 = 有校验(issue-229 第 3 项)', () => {
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
    expect(files.length).toBeGreaterThan(20) // 各层 lib 文件数不同(部分模块只在私有侧)
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
