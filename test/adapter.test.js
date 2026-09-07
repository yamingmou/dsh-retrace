/**
 * Adapter layer unit tests (2026-09-01).
 *
 * 适配器层:业务层(message-list/守卫)与平台解耦——换架构时实现新的
 * EventReader/ReplaceWriter 即可,业务逻辑零改动。
 */
import { describe, it, expect } from 'vitest'
import { createAdapter, NULL_ADAPTER } from '../lib/adapter/contract.js'
import { computeSpan, isRoundBoundary, dshAdapter } from '../lib/adapter/dsh.js'
import { foldSurface } from '@deepseek-ai/dsh-session'

// 通用事件夹具(3 轮对话)——surface 候选须带 surfaceOp:'append'(官方 foldSurface 语义,
// computeSpan 现在重放 foldSurface 得真实 nodes,2026-09-07 修复后必需)
const events = [
  { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
  { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: 'yo' }] } } },
  { seq: 2, type: 'user/message', surfaceOp: 'append', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'again' }] } },
  { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { id: 'a2', content: [{ type: 'text', text: 'ok' }] } } },
  { seq: 4, type: 'user/message', surfaceOp: 'append', data: { id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: 'more' }] } },
  { seq: 5, type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, message: { id: 'a3', content: [{ type: 'text', text: 'done' }] } } },
]

describe('adapter/contract(适配器层契约)', () => {
  it('createAdapter 组装 reader+writer', () => {
    const a = createAdapter({ readEvents: async () => [] }, { writeReplace: async () => ({}) })
    expect(typeof a.reader.readEvents).toBe('function')
    expect(typeof a.writer.writeReplace).toBe('function')
  })

  it('NULL_ADAPTER 可独立运行(业务层无平台时)', async () => {
    expect(await NULL_ADAPTER.reader.readEvents('x')).toBeNull()
    expect(await NULL_ADAPTER.writer.writeReplace('x', { start: 0, end: 1, shadowedSeqs: [0, 1] })).toBeNull()
  })
})

describe('adapter/dsh computeSpan(业务逻辑,与平台无关)', () => {
  it('round 模式:遮蔽目标轮(该 user + 它的回复)', () => {
    const span = computeSpan(events, 2) // 编辑 u2(轮2)
    expect(span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
  })

  it('round 模式:编辑最后一条只遮蔽自己所在轮', () => {
    const span = computeSpan(events, 4) // 编辑 u3(轮3)
    expect(span).toEqual({ start: 4, end: 5, shadowedSeqs: [4, 5] })
  })

  it('tail 模式:遮蔽目标之后所有(重新开始)', () => {
    const span = computeSpan(events, 2, 'tail')
    expect(span.shadowedSeqs).toEqual([2, 3, 4, 5])
  })

  it('支持 messageId 查找', () => {
    const span = computeSpan(events, 'u2')
    expect(span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
  })

  it('目标不存在 → null', () => {
    expect(computeSpan(events, 99)).toBeNull()
    expect(computeSpan(events, 'nope')).toBeNull()
    expect(computeSpan(null, 2)).toBeNull()
  })

  it('isRoundBoundary:只认真实 user 输入,排除注入', () => {
    expect(isRoundBoundary({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(true)
    expect(isRoundBoundary({ type: 'user/message', data: { source: { kind: 'context' } } })).toBe(false)
    expect(isRoundBoundary({ type: 'assistant/message' })).toBe(false)
  })
})

describe('adapter/dsh dshAdapter(DSH 平台适配器)', () => {
  it('暴露 reader 接口(EventReader 契约)', () => {
    expect(typeof dshAdapter.reader.readEvents).toBe('function')
    expect(typeof dshAdapter.spanFromFile).toBe('function')
    expect(typeof dshAdapter.maxStepInTurnFromFile).toBe('function')
  })

  it('maxStepInTurnFromFile:从全量事件算 turn 内最大 step(情形②窗口化防御)', async () => {
    // 用临时会话文件验证(走真实 loadSessionLog 路径)
    const { writeFileSync, mkdtempSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'retrace-adapter-'))
    try {
      const events = [
        { type: 'session', version: 0, id: 's1', createdAt: 1, cwd: '/tmp' },
        { type: 'user/message', seq: 1, time: 2, data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
        { type: 'step/start', seq: 2, time: 3, data: { turn: 5, step: 1 } },
        { type: 'step/start', seq: 3, time: 4, data: { turn: 5, step: 45 } },
        { type: 'step/start', seq: 4, time: 5, data: { turn: 6, step: 3 } },
      ]
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      // 直接测函数:注入文件路径(生产走 sessionFilePath 找 ~/.dsh)
      const max = await dshAdapter.maxStepInTurnFromFile('s1', 5, file)
      expect(max).toBe(45)
      const max6 = await dshAdapter.maxStepInTurnFromFile('s1', 6, file)
      expect(max6).toBe(3)
      const missing = await dshAdapter.maxStepInTurnFromFile('ghost', 5, '/nonexistent/session.jsonl')
      expect(missing).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('adapter/dsh computeSpan · 官方 foldSurface nodes（2026-09-07 ISSUE-20260907113201 回归）', () => {
  // 合成:2 轮对话 + 一个 replace marker(遮蔽轮1,模拟已编辑会话)
  function withMarker() {
    return [
      { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
      { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: 'yo' }] } } },
      // marker 遮蔽 [0..1](轮1),replace 节点 seq 2 插入位置 0 → nodes 非 seq 单调
      { seq: 2, type: 'assistant/message', surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1], data: { turn: 1, message: { id: 'retrace-recall-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 0, text: 'hi' } } },
      { seq: 3, type: 'user/message', surfaceOp: 'append', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'again' }] } },
      { seq: 4, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { id: 'a2', content: [{ type: 'text', text: 'ok' }] } } },
    ]
  }

  it('已被遮蔽的消息(marker 遮蔽过)→ null(target-shadowed,不再 not found/死锁)', () => {
    const events = withMarker()
    expect(computeSpan(events, 0)).toBeNull() // u1 已被 marker 遮蔽,不在官方 nodes
    expect(computeSpan(events, 1)).toBeNull() // a1 同
  })

  it('marker 后撤回活跃消息:span 在官方 nodes 位置合法(foldSurface 写入不抛,不再倒置)', () => {
    const events = withMarker()
    for (const mode of ['round', 'tail']) {
      const span = computeSpan(events, 3, mode) // u2(活跃轮)
      expect(span).not.toBeNull()
      const marker = {
        type: 'assistant/message', seq: 5,
        data: { turn: 1, message: { id: 'retrace-recall-test', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 3, text: 'x' } },
        surfaceOp: { op: 'replace', start: span.start, end: span.end },
        sourceEventSeqs: span.shadowedSeqs,
      }
      expect(() => foldSurface([...events, marker])).not.toThrow() // S4/S8 不拒
    }
  })

  it('tail 模式:从目标所在轮首遮蔽到 surface 尾(含位置在前的 marker 段也连续)', () => {
    const events = withMarker()
    const span = computeSpan(events, 3, 'tail')
    // 官方 nodes = [2(marker), 3(u2), 4(a2)];u2 轮首=自己 → 遮蔽 [3,4] + marker(2) 位置在 3 前?
    // 位置段从 u2(index 1) 到尾 = [3, 4];marker(2) 在 index 0(3 前),不被遮蔽
    expect(span.shadowedSeqs).toEqual([3, 4])
    expect(span.start).toBe(3)
    expect(span.end).toBe(4)
  })

  it('round 模式:遮蔽目标轮(官方 nodes 上,marker 不入轮)', () => {
    const events = withMarker()
    const span = computeSpan(events, 3, 'round')
    expect(span.shadowedSeqs).toEqual([3, 4])
  })
})
