/**
 * 考古 CLI 核心逻辑测试（任务书 A1-A4 的纯函数层）。
 */
import { describe, it, expect } from 'vitest';
import { fileOpFromCall, replayFileHistory, simpleHash, diffLines, lineageOf } from '../lib/archaeology-cli.js';

function call(seq, name, args) {
  return { seq, type: 'tool/call', time: seq + 1, data: { name, callId: `c${seq}`, arguments: JSON.stringify(args) } };
}

describe('fileOpFromCall', () => {
  it('识别裸 write/edit 工具与 file_path 字段', () => {
    expect(fileOpFromCall(call(0, 'write', { file_path: '/a/b.py', content: 'code' }))).toMatchObject({ path: '/a/b.py', kind: 'write', content: 'code' });
    expect(fileOpFromCall(call(1, 'edit', { file_path: '/a/b.py', old_string: 'x', new_string: 'y' }))).toMatchObject({ path: '/a/b.py', kind: 'edit', oldString: 'x', newString: 'y' });
    expect(fileOpFromCall(call(2, 'bash', { command: 'ls' }))).toBeNull();
    expect(fileOpFromCall(call(3, 'read', { file_path: '/a/b.py' }))).toBeNull();
  });
});

describe('replayFileHistory（edit 重放）', () => {
  it('write 记全量；edit 基于上一版替换', () => {
    const events = [
      call(0, 'write', { file_path: '/a/b.txt', content: 'hello\nworld' }),
      call(1, 'edit', { file_path: '/a/b.txt', old_string: 'world', new_string: 'DSH' }),
      call(2, 'edit', { file_path: '/a/b.txt', old_string: 'hello', new_string: 'hi' }),
    ];
    const { files } = replayFileHistory(events);
    const history = files.get('/a/b.txt');
    expect(history).toHaveLength(3);
    expect(history[0].content).toBe('hello\nworld');
    expect(history[1].content).toBe('hello\nDSH');
    expect(history[2].content).toBe('hi\nDSH');
    expect(history[0].kind).toBe('write');
    expect(history[1].kind).toBe('edit');
  });
});

describe('diffLines', () => {
  it('行级增删识别', () => {
    const lines = diffLines('a\nb\nc', 'a\nx\nc');
    expect(lines.filter((l) => l.op === 'del')).toHaveLength(1);
    expect(lines.filter((l) => l.op === 'add')).toHaveLength(1);
    expect(lines.filter((l) => l.op === 'same')).toHaveLength(2);
  });
});

describe('lineageOf', () => {
  it('读 header.parentSession 给出直接父', () => {
    const log = { header: { id: 'child', parentSession: 'parent' } };
    const lineage = lineageOf(log);
    expect(lineage.id).toBe('child');
    expect(lineage.parentId).toBe('parent');
  });
});
