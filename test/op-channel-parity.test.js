/**
 * **跨通道一致性**：客户端会调的每个 op，必须在**它实际使用的那条通道**上可达；
 * 而短码那组 op 必须在 **harness 与 HTTP 两条通道都在**。
 *
 * 真回归（2026-09-19 重启实测）：`badgeMap` 只挂了 harness（`harness.handle('retrace.badgeMap')`），
 * 而 App 走 **HTTP**（http.js 的 `api[op]` 分发）⇒ 客户端 `callOp('badgeMap')` 拿到 **404**，
 * 一条可选拉取的失败被误读成"客户端半没注册"。这类"挂了一条忘另一条"的错
 * **必须由测试拦下**，不能靠重启才发现。
 *
 * 通道模型（源码一手）：
 *   · harness/wire = `lib/index.js` 的 `harness.handle('retrace.X')`；
 *   · HTTP         = `lib/http.js` 的 `handlePost`：`api[op]`，其中
 *                    `api = createEditorApi(...) ∪ extraOps`，另有若干**手写分支**。
 *   · `lib/dynamic-host.js` 不自己分发这些 op（它由 host-core 生成、经 harness 转发）。
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p) => readFileSync(join(ROOT, p), 'utf8')
const all = (src, re) => [...src.matchAll(re)].map((m) => m[1])

/** 客户端 op：字面量 `callOp('X')` + 动态 `callOp(op, …)`（op 由 recall/edit/regenerate 传入）。 */
export function clientOpsOf(src) {
  const literals = all(src, /callOp\(\s*'([A-Za-z0-9/_-]+)'/g)
  const dynamic = /callOp\(op,\s*\{/.test(src) ? ['recall', 'editAndResend', 'regenerate'] : []
  return [...new Set([...literals, ...dynamic])].sort()
}

/** harness/wire 通道 op。 */
export function harnessOpsOf(src) {
  return [...new Set(all(src, /harness\.handle\(\s*'retrace\.([A-Za-z0-9/_-]+)'/g))].sort()
}

/** HTTP 通道：index.js 的 `const badgeOps = { … }`（即传给 handler 的 extraOps）键。 */
export function httpExtraOpsOf(indexSrc) {
  // 现在是「holder 声明在 apply 作用域、成员在更深闭包里无条件 Object.assign 写入」
  const block = indexSrc.match(/Object\.assign\(extraOpsHolder, \{([\s\S]*?)\n {4}\}\n/)
  if (!block) return []
  return [...new Set(all(block[1], /^ {4}([a-zA-Z][A-Za-z0-9_]*):\s*async/gm))].sort()
}

/** 编辑器 API 方法名（host-core.js `createEditorApi` 的 return 对象）。 */
export function editorOpsOf(hostCoreSrc) {
  const anchor = hostCoreSrc.indexOf('recall: (args) => recall(args)')
  if (anchor < 0) return []
  const r = hostCoreSrc.lastIndexOf('return {', anchor)
  const end = hostCoreSrc.indexOf('\n  }', anchor)
  return [...new Set(all(hostCoreSrc.slice(r, end), /^ {4}([a-zA-Z][A-Za-z0-9_]*):/gm))].sort()
}

/**
 * http.js 里**手写分支**承载的 op。每条带"该分支在源码里的形状"，用例断言它真的出现
 * ⇒ 删/改名会红；新增这类分支时在这里补一行（本清单唯一的维护点）。
 */
export const HTTP_HANDWRITTEN = [
  // 只列**客户端 callOp 会走**的 POST 手写分支；versions/forkmap/lineage/event/surface/
  // status/doctor/summaries/snapshot 是 GET 路由（客户端走 timelineGet），不在 callOp 面。
  { op: 'clientReport', needle: "op === 'clientReport'" },
  { op: 'runningState', needle: "op === 'runningState'" },
  { op: 'rollback', needle: "segments.includes('rollback')" },
  { op: 'rollback/preview', needle: "segments.includes('rollback') && op === 'preview'" },
  { op: 'git/init', needle: "segments.includes('git') && op === 'init'" },
]
export function httpSpecialOpsOf(httpSrc) {
  return HTTP_HANDWRITTEN.filter((h) => httpSrc.includes(h.needle)).map((h) => h.op).sort()
}

/**
 * **已知的 HTTP-only op**（客户端会调、但 harness/wire 侧没有对应 handler）。
 * 显式登记 = 不许静默跳过；改动这里必须写明理由，且它们仍被"必须在 HTTP 可达"钉住。
 */
export const HTTP_ONLY_BY_DESIGN = {
  clientReport: '纯上报（只打日志），wire 侧没有等价入口，也不需要在场',
  'git/init': '回滚执行器的 git 初始化，走 HTTP 的 rollback 分支族',
  rollback: '回滚执行器（HTTP 手写分支）',
  'rollback/preview': '回滚预览（HTTP 手写分支）',
}

/** **必须两条通道都在**的 op 组：短码这一族（本次回归的教训直接钉在这里）。 */
export const BOTH_CHANNELS_REQUIRED = ['sessionBadge', 'setBadgeTitle', 'initBadgeTitles', 'badgeMap']

/** 纯函数：HTTP 集合里缺哪些客户端 op。 */
export function missingOnHttp(clientOps, httpOps) {
  return clientOps.filter((op) => !httpOps.includes(op))
}
/** 纯函数：既不在 harness、又没登记为 HTTP-only 的客户端 op。 */
export function missingEverywhere(clientOps, harnessOps, httpOnly = HTTP_ONLY_BY_DESIGN) {
  return clientOps.filter((op) => !harnessOps.includes(op) && !(op in httpOnly))
}

const clientSrc = read('lib/client.js')
const indexSrc = read('lib/index.js')
const httpSrc = read('lib/http.js')
const hostCoreSrc = read('lib/host-core.js')

const clientOps = clientOpsOf(clientSrc)
const harnessOps = harnessOpsOf(indexSrc)
// ⚠️ extraOps 只有**真的接进 handler** 时才算 HTTP 可达（否则就是"声明了没接"，
// 正是本次回归的形态）⇒ 以 `extraOps: badgeOps` 的出现为闸门。
// 「接了」= ① 传了 holder ② holder 的写入是**顶格无条件**的（不在 if 分支里）
const httpExtraWired = /extraOps:\s*extraOpsHolder/.test(indexSrc)
  && /^ {4}Object\.assign\(extraOpsHolder, \{$/m.test(indexSrc)
const httpOps = [...new Set([
  ...(httpExtraWired ? httpExtraOpsOf(indexSrc) : []),
  ...httpSpecialOpsOf(httpSrc),
  ...editorOpsOf(hostCoreSrc),
])].sort()

describe('跨通道一致性:客户端 op 两条通道都要能到达', () => {
  it('解析出来的是真清单(防扫描规则失效导致假绿)', () => {
    expect(clientOps.length).toBeGreaterThanOrEqual(8)
    expect(harnessOps.length).toBeGreaterThanOrEqual(8)
    expect(httpExtraOpsOf(indexSrc)).toContain('badgeMap')
    expect(editorOpsOf(hostCoreSrc)).toContain('recall')
    expect(httpSpecialOpsOf(httpSrc)).toContain('rollback')
  })

  it('每一条客户端 op 都在 **HTTP** 通道可达(这是 App 实际走的通道)', () => {
    expect(missingOnHttp(clientOps, httpOps)).toEqual([])
    expect(httpOps).toContain('badgeMap') // 回归点直击
  })

  it('每一条客户端 op 要么在 harness,要么在"已知 HTTP-only"白名单里(不许静默漏)', () => {
    expect(missingEverywhere(clientOps, harnessOps)).toEqual([])
  })

  it('短码那组 op 必须**两条通道都在**(本次回归的教训)', () => {
    for (const op of BOTH_CHANNELS_REQUIRED) {
      expect(harnessOps, `${op} 缺 harness`).toContain(op)
      expect(httpOps, `${op} 缺 HTTP`).toContain(op)
    }
  })

  it('http.js 的 op 分发确实合并了 extraOps(不是只写了个变量)', () => {
    expect(/const opFn = api\[op\] \?\? extraOps\[op\]/.test(httpSrc)).toBe(true)
  })

  it('harness 与 HTTP 挂的是**同一份实现**(同一 holder 引用,晚绑定)', () => {
    expect(/extraOps:\s*extraOpsHolder/.test(indexSrc)).toBe(true)
    for (const op of httpExtraOpsOf(indexSrc)) {
      expect(new RegExp(`harness\\.handle\\('retrace\\.${op}', \\(\\.\\.\\.a\\) => extraOpsHolder\\.${op}\\(\\.\\.\\.a\\)\\)`).test(indexSrc)).toBe(true)
    }
  })

  it('手写分支清单自身不许漂移(每条 needle 必须真的在 http.js 里)', () => {
    const missing = HTTP_HANDWRITTEN.filter((h) => !httpSrc.includes(h.needle))
    expect(missing.map((h) => `${h.op} :: ${h.needle}`)).toEqual([])
  })

  it('阴性对照:故意从 HTTP 集合删掉 badgeMap ⇒ 必须检出(不是摆设)', () => {
    const sabotaged = httpOps.filter((op) => op !== 'badgeMap')
    expect(missingOnHttp(clientOps, sabotaged)).toContain('badgeMap')
    expect(missingOnHttp(clientOps, httpOps)).toEqual([]) // 对照:完整集合不报
  })

  it('阴性对照:extraOps 里删掉任一条都被检出;harness 侧删掉也被检出', () => {
    for (const op of httpExtraOpsOf(indexSrc)) {
      expect(missingOnHttp(clientOps, httpOps.filter((o) => o !== op))).toContain(op)
    }
    for (const op of BOTH_CHANNELS_REQUIRED) {
      const harnessSabotaged = harnessOps.filter((o) => o !== op)
      expect(harnessSabotaged).not.toContain(op)
    }
  })
})
