/**
 * dsh-retrace — scripts/token-price-evidence.mjs
 *
 * **实测脚本**:第 1 段 `compaction/prune` 的 `shadowedTokenCount` 是官方口径的
 * **令牌价**(shadow price),不是节点个数 —— 全部用官方函数、真实会话日志。
 *
 * 背景(反方复核 + 官方源码):
 *   - 官方 `dsh-token-meter/lib/types/surface-projection.js:39` `foldSurfaceProjection`:
 *     `compaction/summary|compaction/prune` ⇒ 武装 claim `{start,end,tokens:shadowedTokenCount}`;
 *     下一个 surface replace 的 `deltaTokens = 本事件估价 − claim.tokens`;
 *   - 官方生产者都写令牌价:`dsh-compaction-tool-result-pruner`
 *     (`ctx.tokenMeter.estimateMessage(event.data.message)`)、
 *     `dsh-compaction-basic:544`(`selectedNodes.reduce((t,n)=>t+n.tokens,0)`);
 *   - 我方写入端曾写 `shadowedSeqs.length`(节点个数)⇒ 每个 marker 让 `surfaceTokens`
 *     少减「区间令牌价 − 节点数」,而 `surfaceTokens → projectedTokens` 是压缩压力/占用率的
 *     输入 ⇒ 占用率虚高、可能提前误触发折叠。
 *
 * 三个部分:
 *  A. 真实日志里官方生产者的 claim 口径:逐条用官方 `estimateMessage(deriveEventMessage(e))`
 *     复算 `shadowedSeqs`,与日志里的 `shadowedTokenCount` 对比(应逐条相等);
 *  B. 若把这些 claim 换成「节点个数」:官方 fold 的增量差 = 少减的令牌数(逐条 + 合计);
 *  C. claim + 相邻 replace 的成对样本:用官方 fold 直接对比两种 claim 下的增量。
 *
 * 用法:node scripts/token-price-evidence.mjs [最多扫描的会话数(默认 236)]
 * 退出码:0 = 全部复算相符;1 = 有不相符;2 = 找不到可用日志(需要桌面 DSH 环境)。
 *
 * ⚠️ 只读:活动基座 sessions 下的日志**只读取**,不复制不改写(证据脚本无写路径)。
 */
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { loadSessionLog } from 'dsh-log-contract'
import { deriveEventMessage, isSurfaceEvent } from '@deepseek-ai/dsh-session'
// 会话文件定位收敛到 lib/platform/session-paths.js 单一实现($DSH_HOME/sessions →
// ~/.dsh/sessions → ~/dsh-v3/sessions;两种文件名都认、同目录取 mtime 新者)。
import { activeSessionsRoot, listSessionFiles } from '../lib/platform/session-paths.js'

const require = createRequire(import.meta.url)
/** 官方 token-meter 的纯口径模块(exports 映射只放行包入口 ⇒ 取同级发布文件)。 */
function officialFile(relative) {
  const entry = require.resolve('@deepseek-ai/dsh-token-meter')
  return new URL(relative, pathToFileURL(entry)).href
}
const { estimateMessage } = await import(officialFile('./types/estimate.js'))
const { foldSurfaceProjection } = await import(officialFile('./types/surface-projection.js'))

/**
 * 口径同源自检:桌面宿主里的官方包是**另一份安装**(0.1.1-rc.2),其量价模块与
 * 本仓解析到的 0.1.0-rc.7 逐字节相同 ⇒ 本脚本的复算与运行宿主同源。
 */
function assertSameOfficialFiles() {
  const app = '/Applications/DSH Desktop.app/Contents/Resources/app.asar.unpacked/node_modules/@deepseek-ai/dsh-token-meter'
  if (!existsSync(app)) return '宿主包不存在(跳过同源自检)'
  const local = require.resolve('@deepseek-ai/dsh-token-meter').replace(/\/lib\/index\.js$/, '')
  const files = ['lib/types/estimate.js', 'lib/types/surface-projection.js']
  for (const rel of files) {
    const a = readFileSync(join(app, rel), 'utf8')
    const b = readFileSync(join(local, rel), 'utf8')
    if (a !== b) return `不一致:${rel}(本仓 vs 宿主)`
  }
  return `逐字节相同(${files.join(' / ')})`
}

/** 一个事件的官方估价(`estimateMessage(deriveEventMessage(event))`,官方 fold 同式)。 */
function officialPrice(event) {
  const message = deriveEventMessage(event)
  return message === null ? 0 : estimateMessage(message)
}

/**
 * 被遮蔽节点的官方价 + 该节点是否真的是**面节点**(官方 `isSurfaceEvent`:
 * 消息类事件且带 surfaceOp)。日志里存在引用非面节点(如 `assistant/chunk`)的
 * claim —— 那是迁移/修复留下的形态,不参与"口径是否一致"的判定,单独计数。
 * @returns {{price:number}|{odd:true}|null} null = 窗口外
 */
function nodePrice(bySeq, seq) {
  const event = bySeq.get(seq)
  if (event === undefined) return null
  if (!isSurfaceEvent(event)) return { odd: true }
  return { price: officialPrice(event) }
}

/** 找活动基座各工作区会话文件(基座/文件名探测见 lib/platform/session-paths.js)。 */
function findSessionFiles(limit) {
  const root = activeSessionsRoot()
  if (!existsSync(root)) return []
  const files = listSessionFiles(root)
  return files.slice(0, limit)
}

const LIMIT = Number(process.argv[2] ?? 236)
const files = findSessionFiles(LIMIT)
if (files.length === 0) {
  console.error('[token-price] 找不到真实会话(活动基座 sessions)— 跳过(需要桌面 DSH 环境)')
  process.exit(2)
}
console.log(`[token-price] 官方口径同源自检:${assertSameOfficialFiles()}`)

const claims = [] // 真实日志里的 compaction/prune claim(可复算的)
const pairs = [] // claim + 相邻且区间吻合的 surface replace
let sessions = 0
let outOfWindow = 0 // 被遮蔽节点落在会话窗口外 ⇒ 估不出价(不计入复算)
let oddClaims = 0 // 引用了非面节点(chunk 等)的 claim ⇒ 迁移/修复形态,不计入口径判定
for (const { id, file } of files) {
  let events
  try { events = loadSessionLog(file).events.map((record) => record.event) } catch { continue }
  if (!Array.isArray(events) || events.length === 0) continue
  sessions += 1
  const bySeq = new Map()
  for (const event of events) if (Number.isSafeInteger(event?.seq)) bySeq.set(event.seq, event)
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (event?.type !== 'compaction/prune' || !event.data?.shadowedRange) continue
    const seqs = Array.isArray(event.data.shadowedSeqs) ? event.data.shadowedSeqs : []
    const logged = event.data.shadowedTokenCount
    const priced = seqs.map((seq) => nodePrice(bySeq, seq))
    // 会话窗口外的被遮蔽节点(日志窗口化)⇒ 估不出价,不进复算集合
    if (priced.some((entry) => entry === null)) { outOfWindow += 1; continue }
    // 引用非面节点(chunk 等)⇒ 形态异常,同样不进"口径一致"的判定
    if (priced.some((entry) => entry.odd === true)) { oddClaims += 1; continue }
    const repriced = priced.reduce((total, entry) => total + entry.price, 0)
    const record = { id, seq: event.seq, nodes: seqs.length, logged, repriced, range: event.data.shadowedRange, claimEvent: event }
    claims.push(record)
    const next = events[i + 1]
    const op = next?.surfaceOp
    const matches = op && op !== 'append' && op.start === record.range.start && op.end === record.range.end
    if (matches) pairs.push({ ...record, carrier: next })
  }
}

if (claims.length === 0) {
  console.error(`[token-price] 扫了 ${sessions} 个会话,没有 compaction/prune claim — 跳过`)
  process.exit(2)
}

const extra = [outOfWindow ? `${outOfWindow} 条在窗口外` : '', oddClaims ? `${oddClaims} 条引用非面节点(迁移/修复形态)` : ''].filter(Boolean).join(',')
console.log(`\n=== A. 官方生产者在真实日志里的 claim 口径(${sessions} 个会话 / ${claims.length} 条可复算 claim${extra ? `;另 ${extra}` : ''})===`)
const mismatched = claims.filter((c) => c.repriced !== c.logged)
console.log(`复算相符:${claims.length - mismatched.length}/${claims.length}(官方 estimateMessage 口径 vs 日志里的 shadowedTokenCount)`)
for (const c of mismatched.slice(0, 5)) console.log(`  ✗ seq ${c.seq} 日志 ${c.logged} vs 复算 ${c.repriced}`)
const withNodes = claims.filter((c) => c.logged !== c.nodes)
console.log(`其中「令牌价 ≠ 节点数」的 claim:${withNodes.length} 条(节点数口径会写错的那些)`)
for (const c of withNodes.slice(0, 5)) {
  console.log(`  · seq ${c.seq} 区间 ${c.range.start}..${c.range.end}:节点数 ${c.nodes} vs 令牌价 ${c.logged}(官方复算 ${c.repriced})`)
}

console.log('\n=== B. 若 claim 写「节点个数」:官方 fold 会**少减**多少 ===')
let totalUnder = 0
for (const c of withNodes) totalUnder += c.repriced - c.nodes
console.log(withNodes.length > 0
  ? `${withNodes.length} 条 claim 累计少减 ${totalUnder} 令牌(平均 ${(totalUnder / withNodes.length).toFixed(0)}/条)—— 这部分被遮蔽内容的价会留在 surfaceTokens 里`
  : '本次样本里没有「节点数 ≠ 令牌价」的 claim')

console.log(`\n=== C. claim + 相邻 replace 成对样本(${pairs.length} 对,官方 foldSurfaceProjection 实跑)===`)
let deltaDrift = 0
for (const p of pairs.slice(0, 8)) {
  // 真实 claim 事件原样喂给官方 fold(它按 type + data.shadowedRange/shadowedTokenCount 武装)
  const armed = foldSurfaceProjection(undefined, p.claimEvent)
  const correct = foldSurfaceProjection(armed.claim, p.carrier).deltaTokens
  const forged = foldSurfaceProjection({ ...armed.claim, tokens: p.nodes }, p.carrier).deltaTokens
  const over = forged - correct
  deltaDrift += over
  console.log(`  · 载体 seq ${p.carrier.seq}:节点数 ${p.nodes} / 令牌价 ${p.logged} ⇒ 官方增量 ${correct}(正确) vs 节点数口径 ${forged}(少减 ${over})`)
}
if (pairs.length > 0) {
  const allOver = pairs.reduce((total, p) => total + (p.logged - p.nodes), 0)
  console.log(`成对样本合计:节点数口径让 surfaceTokens 高估 ${allOver} 令牌(平均 ${(allOver / pairs.length).toFixed(0)}/个 marker)`)
}

console.log(mismatched.length === 0
  ? '\n[token-price] OK — 官方生产者的真实 claim 与官方 estimateMessage 口径逐条相符 ⇒ 写入端按同一口径取价即与官方一致。'
  : `\n[token-price] FAIL — ${mismatched.length} 条 claim 与官方口径不符(见上)。`)
process.exit(mismatched.length === 0 ? 0 : 1)
