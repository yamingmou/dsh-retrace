/**
 * 声称 = 有校验(issue-229 第 3 项,复核)。
 *
 * 问题:代码里到处写着"保证…""绝不…"(行为承诺),但没有任何机制保证这些承诺
 * 真的有对应校验——承诺随重构腐坏,只能靠人读。
 *
 * 本测试把**声称清单化并逐条钉死**:
 *   1. 扫描 lib/**\/*.js(排除生成件)里所有含「保证 / 确保 / guarantee / 绝不」的行;
 *   2. **每条声称行**必须命中登记表里的一个片段,且**每个片段只能命中一条声称行**
 *      (一一对应:新增一条声称而片段恰好与旧行相同 → 片段命中 2 行 → 红);
 *   3. 每条片段必须有 evidence,且 evidence 必须指向**真实存在**的测试:
 *      测试标题按 `it('…')` **解析后精确匹配**(不再是"字符串出现在文件里"),
 *      并要求该测试体内至少有一条 `expect(`(掏空断言的用例不再算校验);
 *   4. 登记不得空转:片段必须真的命中声称行(声称被删/改写 → 登记也要改)。
 * 未登记的新声称 → CI 红(要么补校验,要么显式登记并写明理由)。
 *
 * **已知局限(诚实记录)**:第 3 条只能证明"该测试存在且有断言",不能证明断言的
 * 内容真的覆盖了这条声称的语义(不可判定);登记项的 `note` 用于人工写明对应关系。
 * 另:本测试只扫 lib/(不扫 scripts/、bin/、docs/)——非 lib 的承诺靠 review 兜底。
 *
 * 能力分层:仅本仓私有侧存在的模块,其登记项以**投影标记块**包住(生成公开产物时
 * 整体剥离);对应 lib 文件/声称行不在时,登记项也不在清单里。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const CLAIM_RE = /保证|确保|guarantee|绝不/
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
    claims: ['绝不冒充遮蔽'],
    evidence: [
      { test: 'test/adapter.test.js', title: 'replay-failed:foldSurface 重放抛错 → 内部错误状态(不冒充 already-shadowed)', claim: '绝不冒充遮蔽' },
      // related(非声称行的设计属性,同样有校验:两层同一实现):
      { test: 'test/span-semantics.test.js', title: 'tail 回退轮首(审计指出的分叉点):目标是轮内 assistant → 起点=该轮 user' },
      { test: 'test/span-semantics.test.js', title: 'tail 模式:两模式语义统一后逐字一致(旧业务层"从目标自身切到尾"已废弃)' },
    ],
  },
  {
    file: 'lib/message-list.js',
    claims: [],
    evidence: [],
    note: '本文件无「保证/绝不」字样;其规则单一真相由 test/span-semantics.test.js 覆盖',
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
]

describe('声称 = 有校验(issue-229 第 3 项)', () => {
  const files = listLibFiles()
  const claimLines = []
  for (const rel of files) {
    readFileSync(join(root, rel), 'utf8').split('\n').forEach((line, i) => {
      if (CLAIM_RE.test(line)) claimLines.push({ file: rel, line: i + 1, text: line.trim() })
    })
  }
  const lineHits = (entry, claim) => claimLines.filter((h) => h.file === entry.file && h.text.includes(claim))

  it('扫描到声称(清单非空,防止扫描规则失效导致"假绿")', () => {
    expect(files.length).toBeGreaterThan(20) // 各层 lib 文件数不同(部分模块只在私有侧)
    expect(claimLines.length).toBeGreaterThan(10)
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
