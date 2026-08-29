/**
 * dsh-retrace · lib/archaeology-cli.js
 *
 * 会话日志考古 CLI 的核心逻辑（任务书 dsh-会话日志考古-插件任务与方法.md A1-A4）。
 * 与 dsh-log-contract 的 archaeology.js 分工：B 侧提供 extract/audit 纯函数，
 * 本模块提供 A 侧的文件版本考古（write/edit 重放）与谱系（parent 链）。
 * **只读不写**（纪律 §8.1）。
 */
import { loadSessionLog, extractToolOutputs, auditToolCalls } from 'dsh-log-contract';
import { accessSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 文件写工具名（与 host-core WRITE_TOOLS 同族；DSH 真实工具名为裸 write/edit）。 */
const WRITE_NAMES = /^(?:fs\.)?(?:write|edit|create|append|patch|apply-patch)$/i;

/** 从 tool/call 提取文件操作 { path, kind: 'write'|'edit', content? }。 */
export function fileOpFromCall(event) {
  if (event?.type !== 'tool/call') return null;
  const name = typeof event.data?.name === 'string' ? event.data.name : '';
  if (!WRITE_NAMES.test(name)) return null;
  let args = {};
  try {
    args = typeof event.data?.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data?.arguments ?? {};
  } catch {
    return null;
  }
  const path = args.file_path ?? args.path ?? args.filePath ?? args.file ?? args.target;
  if (typeof path !== 'string' || path === '') return null;
  const isEdit = /edit|patch/i.test(name);
  if (isEdit) {
    if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') return null;
    return { path, kind: 'edit', oldString: args.old_string, newString: args.new_string, seq: event.seq, time: event.time, name };
  }
  if (typeof args.content !== 'string') return null;
  return { path, kind: 'write', content: args.content, seq: event.seq, time: event.time, name };
}

/**
 * 重放会话内全部文件写操作 → 每文件的版本序列（A3）。
 * write 记全量；edit 基于上一版本做 old→new 替换（重放得到全量）。
 *
 * @param events - 会话事件数组。
 * @returns {{
 *   files: Map<path, Array<{ seq, time, kind, tool, hash, size, content }>>,
 * }}
 */
export function replayFileHistory(events) {
  const files = new Map();
  for (const event of events) {
    const op = fileOpFromCall(event);
    if (!op) continue;
    const history = files.get(op.path) ?? [];
    let content;
    if (op.kind === 'write') {
      content = op.content;
    } else {
      const prev = history[history.length - 1]?.content ?? '';
      content = prev.includes(op.oldString) ? prev.replace(op.oldString, op.newString) : prev;
    }
    history.push({
      seq: op.seq,
      time: op.time,
      kind: op.kind,
      tool: op.name,
      hash: simpleHash(content),
      size: content.length,
      content,
    });
    files.set(op.path, history);
  }
  return { files };
}

/** 轻量内容哈希（考古版本标识用，非加密）。 */
export function simpleHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** 行级 diff：返回 { added, removed, lines: [{op:'same'|'add'|'del', text}] }。 */
export function diffLines(a, b) {
  const al = a.split('\n');
  const bl = b.split('\n');
  const lines = [];
  let i = 0;
  let j = 0;
  // 简单前缀/后缀对齐（考古 diff 够用；完整 LCS 不必要）
  while (i < al.length && j < bl.length && al[i] === bl[j]) {
    lines.push({ op: 'same', text: al[i] });
    i++;
    j++;
  }
  const at = al.length - 1;
  const bt = bl.length - 1;
  let ae = al.length;
  let be = bl.length;
  while (ae > i && be > j && al[ae - 1] === bl[be - 1]) {
    ae--;
    be--;
  }
  for (let k = i; k < ae; k++) lines.push({ op: 'del', text: al[k] });
  for (let k = j; k < be; k++) lines.push({ op: 'add', text: bl[k] });
  while (ae < al.length) {
    lines.push({ op: 'same', text: al[ae] });
    ae++;
  }
  return lines;
}

/** 解析会话参数：完整文件路径，或 sessionId（在 ~/.dsh/sessions 下查找）。 */
export function resolveSessionFile(ref) {
  if (typeof ref !== 'string' || ref === '') throw new Error('session 参数不能为空');
  if (ref.includes('/') || ref.endsWith('.zstd') || ref.endsWith('.jsonl')) return ref;
  // 按 id 在所有工作区查找
  const root = join(homedir(), '.dsh', 'sessions');
  for (const workspace of readdirSync(root)) {
    const candidate = join(root, workspace, ref, 'session.jsonl.zstd');
    try {
      accessSync(candidate);
      return candidate;
    } catch { /* keep looking */ }
  }
  throw new Error(`session "${ref}" 未在 ~/.dsh/sessions 下找到`);
}

/**
 * 谱系（A4）：从当前会话沿 header.parentSession 追溯父链。
 * @param log - loadSessionLog 结果。
 * @returns {{ id, parentId, ancestors: Array<{id, parentId}> }}
 */
export function lineageOf(log) {
  const header = log?.header ?? {};
  const ancestors = [];
  let parentId = header.parentSession ?? null;
  const seen = new Set([header.id]);
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    ancestors.push({ id: parentId, parentId: null });
    // 父会话文件在同一工作区；不递归读文件（只列 id 链，内容读取留给调用方）
    parentId = null; // 需要父文件才能继续；单次给出直接父
  }
  return { id: header.id, parentId: header.parentSession ?? null, ancestors };
}

export { extractToolOutputs, auditToolCalls, loadSessionLog };
