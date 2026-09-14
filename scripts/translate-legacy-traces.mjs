#!/usr/bin/env node
/**
 * dsh-retrace — scripts/translate-legacy-traces.mjs
 *
 * **迁移前翻译**的 CLI:把历史非法事件类型
 *   `retrace/goal-marker` / `retrace/marker`
 * 就地翻译成官方合法、读端认得的**痕迹**形态(`feedback/record` + `data.text`)。
 *
 * 为什么需要:官方 v0→v1 边拒绝一切未知历史类型(即使 `ignorable: true`)⇒ 含这两类
 * 事件的会话**永久不可迁移**;裁定**不删除**(保功能痕迹)⇒ 只能翻译。
 * 翻译走的是 `lib/migration-traces.js`(形状/依据/幂等口径都在那里)。
 *
 * 用法:
 *   node scripts/translate-legacy-traces.mjs <input.jsonl[.zstd]> [选项]
 *
 * 选项:
 *   --out <file>      输出文件(默认:输入同目录同名 + `.traced.jsonl`)
 *   --zstd            输出先用 `zstd -19` 压成 `<out>.zstd`(该格式的一般做法)
 *   --report <file>   写 JSON 报告(翻译明细 + 幂等复核结果)
 *   --dry-run         只报告,不写任何文件
 *   --quiet           只打印摘要
 *
 * 不变量(脚本自己复核,不靠调用方信任):
 *   ① **行数不变、seq 不变、time 不变**(只改 `type` 与 `data`);
 *   ② **幂等**:对输出再跑一次 ⇒ `changed === 0`;
 *   ③ 翻译后**不再有任何** `retrace/` 前缀事件类型。
 *
 * 生产纪律:本脚本**只读输入**、只写 `--out`;对生产会话请先 `cp` 到 /tmp 并核对
 * sha256(脚本在报告里记录输入/输出的 sha256)。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join, resolve } from 'node:path'
import { decodeTraceText, isTraceEvent, traceSummary } from '../lib/marker-carrier.js'
import { translateLegacyTraces } from '../lib/migration-traces.js'

const USAGE = 'usage: node scripts/translate-legacy-traces.mjs <input.jsonl[.zstd]> [--out <file>] [--zstd] [--report <file>] [--dry-run] [--quiet]'

function parseArgs(argv) {
  const opts = { out: null, report: null, zstd: false, dryRun: false, quiet: false, input: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out') opts.out = argv[++i]
    else if (arg === '--report') opts.report = argv[++i]
    else if (arg === '--zstd') opts.zstd = true
    else if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--quiet') opts.quiet = true
    else if (arg === '--help' || arg === '-h') { console.log(USAGE); process.exit(0) }
    else if (arg.startsWith('-')) { console.error(`未知选项 ${arg}\n${USAGE}`); process.exit(2) }
    else if (opts.input === null) opts.input = arg
    else { console.error(`多余参数 ${arg}\n${USAGE}`); process.exit(2) }
  }
  if (opts.input === null) { console.error(USAGE); process.exit(2) }
  return opts
}

/** 多帧 zstd(zstd CLI 会解全部帧;node:zlib 只解第一帧 ⇒ 不能用)。 */
function readText(file) {
  if (!file.endsWith('.zstd')) return readFileSync(file, 'utf8')
  return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 30, encoding: 'utf8' })
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex')

/** 行数 / seq 序列指纹(证明"只改 type 与 data",没动位置轴)。 */
function fingerprint(text) {
  const lines = text.split('\n').filter((l) => l.trim() !== '')
  const seqs = []
  for (const line of lines) {
    try { seqs.push(JSON.parse(line).seq) } catch { seqs.push(null) }
  }
  return { lineCount: lines.length, seqDigest: sha256(Buffer.from(JSON.stringify(seqs))) }
}

const opts = parseArgs(process.argv.slice(2))
const input = resolve(opts.input)
if (!existsSync(input)) { console.error(`输入不存在: ${input}`); process.exit(1) }

const original = readText(input)
const before = fingerprint(original)
const first = translateLegacyTraces(original)
const second = translateLegacyTraces(first.text) // 幂等复核(对输出再跑一次)

// 官方类型层复核:翻译产物里不得再有自造 `retrace/` 类型事件。
const remaining = []
for (const line of first.text.split('\n')) {
  if (line.trim() === '') continue
  let parsed
  try { parsed = JSON.parse(line) } catch { continue }
  if (typeof parsed?.type === 'string' && parsed.type.startsWith('retrace/')) remaining.push({ seq: parsed.seq, type: parsed.type })
}

const after = fingerprint(first.text)
const traces = []
for (const line of first.text.split('\n')) {
  if (line.trim() === '') continue
  let parsed
  try { parsed = JSON.parse(line) } catch { continue }
  if (isTraceEvent(parsed)) traces.push({ seq: parsed.seq, time: parsed.time, summary: traceSummary(decodeTraceText(parsed.data.text)) })
}

const report = {
  ts: new Date().toISOString(),
  input,
  inputSha256: sha256(readFileSync(input)),
  inputBytes: readFileSync(input).length,
  translated: first.changed,
  alreadyTranslated: first.alreadyTranslated,
  unparsableLines: first.unparsable,
  events: first.events,
  idempotentSecondRunChanged: second.changed,
  lineCountBefore: before.lineCount,
  lineCountAfter: after.lineCount,
  seqDigestUnchanged: before.seqDigest === after.seqDigest,
  remainingRetraceTypes: remaining,
  tracesInOutput: traces.length,
  traces: traces.slice(0, 20),
}

if (!opts.quiet) {
  console.log(`输入: ${input}`)
  console.log(`  行数 ${before.lineCount} → ${after.lineCount}(seq 指纹${report.seqDigestUnchanged ? '一致' : '★不一致★'})`)
  console.log(`  翻译 ${first.changed} 条(已翻译跳过 ${first.alreadyTranslated} / 非 JSON 行 ${first.unparsable})`)
  for (const e of first.events.slice(0, 10)) {
    console.log(`    line ${e.line} seq ${e.seq} ${e.from} → ${e.to} [${e.kind}]${e.droppedNullKeys.length ? ` 清洗空值 ${e.droppedNullKeys.join(',')}` : ''}`)
  }
  if (first.events.length > 10) console.log(`    …共 ${first.events.length} 条(明细见报告)`)
  console.log(`  复核:第二次跑 changed=${second.changed}（幂等 ${second.changed === 0 ? '通过' : '★不通过★'}）`)
  console.log(`  复核:产物里残留 retrace/* 类型 ${remaining.length} 条${remaining.length ? ' ★' + JSON.stringify(remaining.slice(0, 3)) : ''}`)
  console.log(`  产物痕迹 ${traces.length} 条`)
}

if (!opts.dryRun) {
  const out = opts.out === null
    ? join(dirname(input), `${basename(input).replace(/\.(jsonl|zstd)+$/u, '')}.traced.jsonl`)
    : resolve(opts.out)
  writeFileSync(out, first.text)
  report.output = out
  report.outputSha256 = sha256(Buffer.from(first.text))
  if (opts.zstd) {
    execFileSync('zstd', ['-19', '-f', '-q', out, '-o', `${out}.zstd`])
    report.outputZstd = `${out}.zstd`
    report.outputZstdBytes = readFileSync(`${out}.zstd`).length
  }
  if (!opts.quiet) console.log(`输出: ${out}${opts.zstd ? `（+ ${out}.zstd）` : ''}`)
}

if (opts.report !== null) {
  writeFileSync(resolve(opts.report), JSON.stringify(report, null, 1))
  if (!opts.quiet) console.log(`报告: ${resolve(opts.report)}`)
}

process.exitCode = (report.idempotentSecondRunChanged === 0 && report.seqDigestUnchanged && remaining.length === 0) ? 0 : 1
