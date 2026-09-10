/**
 * 声称 = 有校验(issue-229 第 3 项,复核)。
 *
 * 问题:代码里到处写着"保证…""绝不…"(行为承诺),但没有任何机制保证这些承诺
 * 真的有对应校验——承诺随重构腐坏,只能靠人读。
 *
 * 本测试把**声称清单化**:
 *   1. 扫描 lib/**\/*.js(排除生成件)里所有含「保证 / 确保 / guarantee / 绝不」的行;
 *   2. 每一行必须命中 CLAIM_REGISTRY 里某条登记(file + 声称片段);
 *   3. 每条登记的 evidence 必须**真的存在**(测试文件在、测试标题在)——
 *      禁止"声称指向一个不存在的测试";
 *   4. 登记不得空转:每条登记的 file 至少命中一行声称(声称被删了 → 登记也要删)。
 * 未登记的声称 → CI 红(要么补校验,要么显式登记并写明原因)。
 *
 * 私有线(折叠方案)相关登记项以**投影标记块**包住(产物重建整体剥离;公开线里对应
 * lib 文件不存在 → 那些声称天然不在清单里)。
 * 登记项的 `note` 用于说明"为什么这样校验也算覆盖"(审计要求:未覆盖要写原因)。
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

/** 声称清单:`claims` = 该文件里被登记覆盖的声称片段(行内含其一即算登记)。 */
const CLAIM_REGISTRY = [
  {
    file: 'lib/host-core.js',
    claims: ['确保 agent 空闲', '绝不冒充"已遮蔽"', '绝不静默', '绝不直扫稀疏', '绝不越过遮蔽区重发更早轮'],
    evidence: [
      { test: 'test/host-core.test.js', title: 'running agent WITH cancel API: auto-stops (cancel + whenIdle) then edits (2026-08-30 事故闭环)', claim: '确保 agent 空闲' },
      { test: 'test/host-core.test.js', title: 'issue-229 显式状态:spanStatus=replay-failed → span-replay-failed(内部错误,绝不冒充遮蔽)', claim: '绝不冒充"已遮蔽"' },
      { test: 'test/contract-runtime.test.js', title: '适配器返回坏 marker → host-core 边界抛 contract-violation(经 op 信封成 code)', claim: '绝不静默' },
      { test: 'test/host-core.test.js', title: '跨遮蔽区(更早轮已被 fold 遮蔽成幽灵) + 当前轮 user 是洞 → 只重发当前轮原文', claim: '绝不越过遮蔽区重发更早轮' },
      { test: 'test/host-core.test.js', title: '文件侧 prompt 注入(probe.prompt)→ 重发该轮 user 原文 + marker targetSeq 指向该轮', claim: '绝不直扫稀疏', note: 'M-1:重发原文一律取文件侧,不直扫 host 稀疏 events' },
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
    claims: ['遮蔽语义保证', '写前校验保证 marker 合法'],
    evidence: [
      { test: 'test/contract-runtime.test.js', title: '缺 surfaceOp / 非 assistant-message / sourceEventSeqs 与 surfaceOp 不一致 → 报错', claim: '遮蔽语义保证', note: '可判定形式 = surfaceOp.start/end 与 sourceEventSeqs 首尾一致(运行时断言)' },
      { test: 'test/contract-runtime.test.js', title: '合法 marker 通过(真实 writer 产出形状)', claim: '写前校验保证 marker 合法', note: '写前校验负责语义/契约,形状由 assertMarkerShape 兜底' },
    ],
  },
  {
    file: 'lib/span-semantics.js',
    claims: ['绝不冒充遮蔽', '两种模式共用同一条轮首回退规则'],
    evidence: [
      { test: 'test/adapter.test.js', title: 'replay-failed:foldSurface 重放抛错 → 内部错误状态(不冒充 already-shadowed)', claim: '绝不冒充遮蔽' },
      { test: 'test/span-semantics.test.js', title: 'tail 回退轮首(审计指出的分叉点):目标是轮内 assistant → 起点=该轮 user', claim: '两种模式共用同一条轮首回退规则' },
      { test: 'test/span-semantics.test.js', title: 'tail 模式:两模式语义统一后逐字一致(旧业务层"从目标自身切到尾"已废弃)', claim: '两种模式共用同一条轮首回退规则' },
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
    claims: ['在 finally 块保证 `turn/end`', 'finally 保证写入', '绝不自动写 turn/end'],
    evidence: [
      { test: 'test/interrupt-guard.test.js', title: 'turn/end reason=interrupted → 官方正常闭合，不计未闭合', claim: '在 finally 块保证 `turn/end`' },
      { test: 'test/interrupt-guard.test.js', title: 'turn/end reason=interrupted → 官方正常闭合，不计未闭合', claim: 'finally 保证写入', note: '中断闭合(reason=interrupted/aborted)按官方 finally 语义视为已闭合,不误报 open' },
      { test: 'test/interrupt-guard.test.js', title: '有 turn/start 无 turn/end（崩溃/强杀现场）→ open', claim: '绝不自动写 turn/end', note: '守卫只报 open,不补写 turn/end' },
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
    const lines = readFileSync(join(root, rel), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (CLAIM_RE.test(line)) claimLines.push({ file: rel, line: i + 1, text: line.trim() })
    })
  }

  it('扫描到声称(清单非空,防止扫描规则失效导致"假绿")', () => {
    expect(files.length).toBeGreaterThan(20) // 公开线 lib 文件更少(折叠方案件被剥离)
    expect(claimLines.length).toBeGreaterThan(10)
  })

  it('每一条声称都有登记(file + 声称片段)', () => {
    const unregistered = []
    for (const hit of claimLines) {
      const covered = CLAIM_REGISTRY.some((entry) => entry.file === hit.file
        && (entry.claims ?? []).some((claim) => hit.text.includes(claim)))
      if (!covered) unregistered.push(`${hit.file}:${hit.line}  ${hit.text}`)
    }
    expect(unregistered).toEqual([])
  })

  it('每条登记都必须真的对应校验(测试文件存在 + 测试标题存在),且不得空转', () => {
    const problems = []
    for (const entry of CLAIM_REGISTRY) {
      const entryClaims = entry.claims ?? []
      if (entryClaims.length === 0) {
        // 无声称的文件:必须给 note 说明(审计要求:未覆盖要写原因)
        if (!entry.note) problems.push(`${entry.file}: 空登记必须有 note 说明`)
        continue
      }
      // 登记不得空转:至少命中本文件里的一行声称
      const fileHits = claimLines.filter((h) => h.file === entry.file)
      if (fileHits.length === 0) problems.push(`${entry.file}: 文件不存在或无声称行(登记空转,请删)`)
      else if (!fileHits.some((h) => entryClaims.some((c) => h.text.includes(c)))) {
        problems.push(`${entry.file}: 登记的声称片段在文件里找不到(声称已改/已删?)`)
      }
      // 声称 → 校验:每条声称至少一条 evidence,且 evidence 指向真实测试标题
      for (const claim of entryClaims) {
        const owned = (entry.evidence ?? []).filter((e) => e.claim === claim)
        if (owned.length === 0) problems.push(`${entry.file}: 声称「${claim}」没有对应 evidence`)
      }
      for (const ev of entry.evidence ?? []) {
        const testPath = join(root, ev.test)
        if (!existsSync(testPath)) { problems.push(`${entry.file}: evidence 测试文件不存在 ${ev.test}`); continue }
        if (!readFileSync(testPath, 'utf8').includes(ev.title)) {
          problems.push(`${entry.file}: evidence 测试标题不存在于 ${ev.test} →「${ev.title}」`)
        }
      }
    }
    expect(problems).toEqual([])
  })
})
