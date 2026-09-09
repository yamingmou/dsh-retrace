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

describe('adapter/dsh computeSpan · range 模式（长会话整理窗口批1 折叠区间）', () => {
  it('range:遮蔽 [start..end] 位置段(官方 nodes 上)', () => {
    const evts = [
      { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] } },
      { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: 'b' }] } } },
      { seq: 2, type: 'user/message', surfaceOp: 'append', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'c' }] } },
      { seq: 3, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { id: 'a2', content: [{ type: 'text', text: 'd' }] } } },
      { seq: 4, type: 'user/message', surfaceOp: 'append', data: { id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: 'e' }] } },
      { seq: 5, type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, message: { id: 'a3', content: [{ type: 'text', text: 'f' }] } } },
    ]
    const span = computeSpan(evts, 0, 'range', { endSeq: 3 }) // 折叠完成块 u1..a2(前两轮)
    expect(span).toEqual({ start: 0, end: 3, shadowedSeqs: [0, 1, 2, 3] })
    // foldSurface 写入验证(range span 位置合法)
    const marker = { type: 'assistant/message', seq: 6, data: { turn: 1, message: { id: 'retrace-fold-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 0, text: '' } }, surfaceOp: { op: 'replace', start: 0, end: 3 }, sourceEventSeqs: [0, 1, 2, 3] }
    expect(() => foldSurface([...evts, marker])).not.toThrow()
  })

  it('range:端点非 surface 节点/倒置 → null', () => {
    const evts = [
      { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'a' }] } },
      { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: 'b' }] } } },
    ]
    expect(computeSpan(evts, 0, 'range', { endSeq: 99 })).toBeNull() // end 不在 surface
    expect(computeSpan(evts, 1, 'range', { endSeq: 0 })).toBeNull() // start>end 位置倒置
  })
})

describe('adapter unfoldContentFromFile(长会话整理批3 视图层展开)', () => {
  it('从文件读 fold marker 的被遮蔽内容(整块渲染数据)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-retrace-unfold-'))
    try {
      const events = [
        { type: 'session', version: 0, id: 's1', createdAt: 1, cwd: '/tmp' },
        { type: 'user/message', seq: 1, surfaceOp: 'append', data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
        { type: 'assistant/message', seq: 2, surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'text', text: 'yo' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
        { type: 'user/message', seq: 3, surfaceOp: 'append', data: { id: 'u2', role: 'user', content: [{ type: 'text', text: 'more' }], source: { kind: 'user' } } },
        // fold marker 遮蔽 [1..2]
        { type: 'assistant/message', seq: 4, surfaceOp: { op: 'replace', start: 1, end: 2 }, sourceEventSeqs: [1, 2], data: { turn: 1, message: { id: 'retrace-fold-x', role: 'assistant', content: [{ type: 'text', text: '【完成块】摘要' }], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 1, text: '' } } },
        { type: 'user/message', seq: 5, surfaceOp: 'append', data: { id: 'u3', role: 'user', content: [{ type: 'text', text: 'after' }], source: { kind: 'user' } } },
      ]
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      const content = await dshAdapter.unfoldContentFromFile('s1', 4, file)
      expect(content).not.toBeNull()
      expect(content.markerSeq).toBe(4)
      expect(content.rows).toEqual([
        { seq: 1, type: 'user', text: 'hi' },
        { seq: 2, type: 'assistant', text: 'yo' },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('非 fold marker / 不存在 → null', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-retrace-unfold2-'))
    try {
      const events = [
        { type: 'session', version: 0, id: 's1', createdAt: 1, cwd: '/tmp' },
        { type: 'assistant/message', seq: 1, surfaceOp: 'append', data: { turn: 1, message: { id: 'retrace-recall-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } } },
      ]
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n')
      expect(await dshAdapter.unfoldContentFromFile('s1', 1, file)).toBeNull() // recall 非 fold
      expect(await dshAdapter.unfoldContentFromFile('s1', 99, file)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('adapter foldBoundaryFromFile(批5 50轮接线)', () => {
  it('从文件读事件算自动边界(未显式 end 时兜底)', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-retrace-bnd-'))
    try {
      // 5 轮(每轮 turn/start+user+assistant+turn/end):header 一次 + 20 事件,seq 0..19
      // 轮 r:turn/start=4r,user=4r+1,assistant=4r+2,turn/end=4r+3
      const evs = [{ type: 'session', version: 0, id: 's1', createdAt: 1, cwd: '/tmp' }]
      let seq = 0
      for (let r = 0; r < 5; r++) {
        evs.push({ type: 'turn/start', seq: seq++, data: { turn: r + 1 } })
        evs.push({ type: 'user/message', seq: seq++, surfaceOp: 'append', data: { id: `u${r}`, source: { kind: 'user' }, content: [{ type: 'text', text: `q${r}` }] } })
        evs.push({ type: 'assistant/message', seq: seq++, surfaceOp: 'append', data: { turn: r + 1, message: { id: `a${r}`, content: [{ type: 'text', text: `ans${r}` }], source: { kind: 'model', provider: 'p', model: 'm' } } } })
        evs.push({ type: 'turn/end', seq: seq++, data: { turn: r + 1, reason: { kind: 'completed' } } })
      }
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
      // 默认单轮:start=2(轮 0 assistant)→ 回退到轮 0 user(seq 1)
      const b = await dshAdapter.foldBoundaryFromFile('s1', 2, {}, file)
      expect(b).not.toBeNull()
      expect(b.start).toBe(1) // 轮 0 user
      expect(b.end).toBe(2) // 轮 0 assistant
      expect(b.rounds).toBe(1)
      expect(b.reason).toBe('completed')
      // 多轮:轮 0..1 两轮 → end = 轮 1 assistant(seq 6)
      const b3 = await dshAdapter.foldBoundaryFromFile('s1', 2, { rounds: 2 }, file)
      expect(b3).not.toBeNull()
      expect(b3.start).toBe(1)
      expect(b3.end).toBe(6)
      expect(b3.rounds).toBe(2)
      // 不存在文件 → null(与 unfold/maxStepInTurn 一致)
      expect(await dshAdapter.foldBoundaryFromFile('ghost', 2, {}, '/nonexistent/s.jsonl')).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('adapter summaryFromFile P0-3(摘要以 surface 节点为输入,消幽灵轮)', () => {
  it('LOG 含先前被遮蔽轮(marker)→ 摘要只计 surface 轮,不含幽灵', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-retrace-sumghost-'))
    try {
      const evs = [{ type: 'session', version: 0, id: 's1', createdAt: 1, cwd: '/tmp' }]
      // 轮0(user u0 + assistant a0,seq 0..1)→ 随后被 marker 遮蔽(幽灵)
      evs.push({ type: 'user/message', seq: 0, surfaceOp: 'append', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: '幽灵输入不该进摘要' }] } })
      evs.push({ type: 'assistant/message', seq: 1, surfaceOp: 'append', data: { turn: 1, message: { id: 'a0', content: [{ type: 'text', text: '幽灵回复' }], source: { kind: 'model', provider: 'p', model: 'm' } } } })
      // marker 遮蔽 [0..1](轮0 折叠为 recall)
      evs.push({ type: 'assistant/message', seq: 2, surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1], data: { turn: 1, message: { id: 'retrace-recall-x', content: [], source: { kind: 'model', provider: 'p', model: 'm' } } } })
      // 轮1(user u1 + assistant a1,seq 3..4)——surface 上的完成块
      evs.push({ type: 'user/message', seq: 3, surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '当前轮真实输入' }] } })
      evs.push({ type: 'assistant/message', seq: 4, surfaceOp: 'append', data: { turn: 2, message: { id: 'a1', content: [{ type: 'text', text: '当前轮回复' }], source: { kind: 'model', provider: 'p', model: 'm' } } } })
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
      // surface nodes = [2(marker), 3(u1), 4(a1)];摘要区间 [3..4] = 轮1(surface 位置段)
      const summary = await dshAdapter.summaryFromFile('s1', 3, 4, file)
      expect(typeof summary).toBe('string')
      // P0-3:摘要不得含幽灵轮(LOG 切片会含 '幽灵输入';surface 投影不含)
      expect(summary).not.toContain('幽灵输入')
      expect(summary).toContain('1 条用户输入') // 只有轮1(u1)
      // 对照:LOG 切片(端点非 surface 时兜底)会含幽灵——用 [0..1] 已验证遮蔽,
      // 此处只验证 surface 投影正确性
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('adapter unfold B2 修订链读侧(supersededByNewer,N-2)', () => {
  it('后续 marker supersededBy 指向本卡 → supersededByNewer 提示', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'dsh-retrace-sup-'))
    try {
      // 轮0(user+assistant)被 fold marker(seq 2)遮蔽;seq 3 user+4 assistant 为新结论轮;
      // seq 5 = superseding 新卡(roadmap-card.supersededBy=2)
      const evs = [
        { type: 'session', version: 0, id: 's1', createdAt: 1, cwd: '/tmp' },
        { type: 'user/message', seq: 0, surfaceOp: 'append', data: { id: 'u0', source: { kind: 'user' }, content: [{ type: 'text', text: '旧结论轮' }] } },
        { type: 'assistant/message', seq: 1, surfaceOp: 'append', data: { turn: 1, message: { id: 'a0', content: [{ type: 'text', text: '拍板:用 A' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
        // 旧 fold marker(遮蔽 0..1)
        { type: 'assistant/message', seq: 2, surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1], data: { turn: 1, message: { id: 'retrace-fold-old', content: [{ type: 'text', text: '【路标卡】…' }], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 0, text: '', trio: { 'roadmap-card': { blockTitle: '旧结论', summary: '用 A', keySeqs: [0, 1] }, process: {}, archive: { shadowedSeqs: [0, 1] } } } } },
        { type: 'user/message', seq: 3, surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '推翻改用 B' }] } },
        { type: 'assistant/message', seq: 4, surfaceOp: 'append', data: { turn: 2, message: { id: 'a1', content: [{ type: 'text', text: '拍板:改用 B' }], source: { kind: 'model', provider: 'p', model: 'm' } } } },
        // superseding 新卡(遮蔽 3..4,supersededBy=2 指旧卡)
        { type: 'assistant/message', seq: 5, surfaceOp: { op: 'replace', start: 3, end: 4 }, sourceEventSeqs: [3, 4], data: { turn: 2, message: { id: 'retrace-fold-new', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 3, text: '', trio: { 'roadmap-card': { blockTitle: '新结论', summary: '改用 B', keySeqs: [3, 4], supersededBy: 2 }, process: {}, archive: { shadowedSeqs: [3, 4] } } } } },
      ]
      const file = join(dir, 'session.jsonl')
      writeFileSync(file, evs.map((e) => JSON.stringify(e)).join('\n') + '\n')
      // 展开旧卡(seq 2)→ 提示后有修订(seq 5)
      const old = await dshAdapter.unfoldContentFromFile('s1', 2, file)
      expect(old).not.toBeNull()
      expect(old.supersededByNewer).toBe(5)
      // 展开新卡(seq 5)→ 无更新修订
      const fresh = await dshAdapter.unfoldContentFromFile('s1', 5, file)
      expect(fresh.supersededByNewer).toBeNull()
      // 旧 marker 无 trio → trio null(向后兼容)
      const noTrio = await dshAdapter.unfoldContentFromFile('s1', 2, file)
      expect(noTrio.trio).not.toBeNull() // 本夹具旧卡带 trio
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
