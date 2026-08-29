#!/usr/bin/env node
/**
 * dsh-retrace · bin/retrace.mjs
 *
 * 会话日志考古 CLI（任务书 A1-A4）——只读，不写任何日志。
 *
 *   retrace index <session> [--json]
 *       工具调用索引：调用数 / 配对率 / 孤儿数 / 命令分布（A1）
 *   retrace query <session> --cmd <regex> [--json]
 *       按命令正则查工具输出（A1）
 *   retrace extract <session> --pattern <regex> --out <dir> [--min-size N]
 *       导出匹配命令的工具输出到目录（A2）
 *   retrace file-history <session> <path> [--json]
 *       某文件的所有 write/edit 历史版本（A3）
 *   retrace file-diff <session> <path> <v1> <v2>
 *       两个历史版本的行级 diff（A3）
 *   retrace lineage <session> [--json]
 *       会话 parent 链谱系（A4，分叉图数据源）
 *
 * <session> 为完整文件路径或 sessionId（自动在 ~/.dsh/sessions 查找）。
 */
import fs from 'node:fs';
import { loadSessionLog, extractToolOutputs, auditToolCalls } from 'dsh-log-contract';
import { replayFileHistory, diffLines, resolveSessionFile, lineageOf } from '../lib/archaeology-cli.js';

const USAGE = `dsh-retrace 考古 CLI —— 会话日志数据/审计资产挖掘（只读）

用法：
  retrace index <session> [--json]
  retrace query <session> --cmd <regex> [--json]
  retrace extract <session> --pattern <regex> --out <dir> [--min-size N]
  retrace file-history <session> <path> [--json]
  retrace file-diff <session> <path> <v1> <v2>
  retrace lineage <session> [--json]`;

function fail(msg) {
  process.stderr.write(`❌ ${msg}\n\n${USAGE}\n`);
  process.exit(1);
}

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
const json = rest.includes('--json');
const positional = rest.filter((a) => !a.startsWith('-'));
const opt = (name, def) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
};

function main() {
  if (cmd === 'index') {
    const file = resolveSessionFile(positional[0] ?? fail('index 需要 <session>'));
    const log = loadSessionLog(file);
    const report = auditToolCalls(log.events.map((e) => e.event));
    if (json) return process.stdout.write(JSON.stringify({ file, ...report }, null, 2) + '\n');
    process.stdout.write(`📇 retrace index —— ${file}\n`);
    process.stdout.write(`   工具调用 ${report.calls} ｜ 结果 ${report.results} ｜ 孤儿 ${report.orphans} ｜ 配对率 ${(report.pairingRate * 100).toFixed(1)}%\n`);
    process.stdout.write(`   输出总字节 ${report.outputBytes}${report.largest ? ` ｜ 最大 ${report.largest.size}B（${(report.largest.command || '?').slice(0, 40)}）` : ''}\n`);
    process.stdout.write(`   命令分布（前 8）：\n`);
    for (const { command, count } of report.commands.top.slice(0, 8)) {
      process.stdout.write(`     ${String(count).padStart(4)}  ${(command || '(no-command)').slice(0, 70)}\n`);
    }
  } else if (cmd === 'query' || cmd === 'extract') {
    const pattern = opt('--cmd', opt('--pattern', ''));
    if (!pattern) fail(`${cmd} 需要 --cmd/--pattern <regex>`);
    const file = resolveSessionFile(positional[0] ?? fail(`${cmd} 需要 <session>`));
    const log = loadSessionLog(file);
    const minSize = cmd === 'extract' ? Number(opt('--min-size', '50')) : 0;
    const { pairs, total } = extractToolOutputs(log.events.map((e) => e.event), pattern, { minSize });
    if (cmd === 'query') {
      if (json) return process.stdout.write(JSON.stringify({ file, pattern, matched: pairs.length, total, pairs: pairs.map((p) => ({ callId: p.callId, command: p.command, size: p.size, text: p.text.slice(0, 500) })) }, null, 2) + '\n');
      process.stdout.write(`🔎 retrace query —— ${file} ｜ /${pattern}/\n`);
      process.stdout.write(`   匹配 ${pairs.length} 个输出（共 ${total} 个调用）\n`);
      for (const p of pairs.slice(0, 5)) process.stdout.write(`   - [${p.size}B] ${p.command.slice(0, 50)}… ${p.text.slice(0, 70).replace(/\n/g, ' ')}…\n`);
      if (pairs.length > 5) process.stdout.write(`   … 其余 ${pairs.length - 5} 个（extract --out 导出全部）\n`);
    } else {
      const outDir = opt('--out', '');
      if (!outDir) fail('extract 需要 --out <dir>');
      fs.mkdirSync(outDir, { recursive: true });
      let written = 0;
      for (const p of pairs) {
        fs.writeFileSync(`${outDir}/${p.callId.replace(/[^a-zA-Z0-9_-]/g, '_')}.txt`, p.text);
        written += 1;
      }
      process.stdout.write(`📤 retrace extract —— ${file} ｜ /${pattern}/ ｜ ${written}/${pairs.length} 输出 → ${outDir}\n`);
    }
  } else if (cmd === 'file-history') {
    const file = resolveSessionFile(positional[0] ?? fail('file-history 需要 <session>'));
    const path = positional[1] ?? fail('file-history 需要 <path>');
    const log = loadSessionLog(file);
    const { files } = replayFileHistory(log.events.map((e) => e.event));
    const history = files.get(path) ?? [];
    if (json) return process.stdout.write(JSON.stringify({ file, path, versions: history.map((v) => ({ seq: v.seq, time: v.time, kind: v.kind, tool: v.tool, hash: v.hash, size: v.size })) }, null, 2) + '\n');
    process.stdout.write(`📜 retrace file-history —— ${path}（${file}）\n`);
    if (history.length === 0) {
      process.stdout.write('   （该文件无 write/edit 记录）\n');
    } else {
      history.forEach((v, i) => {
        process.stdout.write(`   v${i} [${v.kind}/${v.tool}] seq ${v.seq} ${v.size}B ${v.hash} ${(v.time ? new Date(v.time).toISOString().slice(5, 16) : '')}\n`);
      });
    }
  } else if (cmd === 'file-diff') {
    const file = resolveSessionFile(positional[0] ?? fail('file-diff 需要 <session>'));
    const path = positional[1] ?? fail('file-diff 需要 <path>');
    const v1 = Number(positional[2]);
    const v2 = Number(positional[3]);
    if (!Number.isInteger(v1) || !Number.isInteger(v2)) fail('file-diff 需要 <v1> <v2>（版本索引）');
    const log = loadSessionLog(file);
    const { files } = replayFileHistory(log.events.map((e) => e.event));
    const history = files.get(path) ?? [];
    if (v1 < 0 || v2 < 0 || v1 >= history.length || v2 >= history.length) fail(`版本索引越界（共 ${history.length} 个版本）`);
    const lines = diffLines(history[v1].content, history[v2].content);
    process.stdout.write(`🔀 retrace file-diff —— ${path} v${v1}(${history[v1].hash}) → v${v2}(${history[v2].hash})\n`);
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.op === 'add') added += 1;
      if (line.op === 'del') removed += 1;
    }
    process.stdout.write(`   +${added} / -${removed}\n`);
    for (const line of lines.slice(0, 40)) {
      process.stdout.write(`   ${line.op === 'add' ? '+' : line.op === 'del' ? '-' : ' '} ${line.text}\n`);
    }
    if (lines.length > 40) process.stdout.write(`   … 其余 ${lines.length - 40} 行\n`);
  } else if (cmd === 'lineage') {
    const file = resolveSessionFile(positional[0] ?? fail('lineage 需要 <session>'));
    const log = loadSessionLog(file);
    const lineage = lineageOf(log);
    if (json) return process.stdout.write(JSON.stringify(lineage, null, 2) + '\n');
    process.stdout.write(`🌿 retrace lineage —— ${lineage.id}\n`);
    process.stdout.write(`   parent: ${lineage.parentId ?? '(无，根会话)'}\n`);
  } else {
    fail(cmd ? `未知命令 "${cmd}"` : '缺少命令');
  }
}
main();
