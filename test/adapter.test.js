/**
 * Adapter layer unit tests (2026-09-01).
 *
 * 适配器层:业务层(message-list/守卫)与平台解耦——换架构时实现新的
 * EventReader/ReplaceWriter 即可,业务逻辑零改动。
 */
import { describe, it, expect } from 'vitest'
import { createAdapter, NULL_ADAPTER, assertSpanShape, assertSpanResult, assertMarkerShape, assertEventListShape } from '../lib/adapter/contract.js'
import { computeSpan, computeSpanProbe, isRoundBoundary, roundPromptOf, dshAdapter } from '../lib/adapter/dsh.js'
import { SPAN_STATUS, spanMissArgsOf, spanAt, spanForSeq } from '../lib/span-semantics.js'
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
  // issue-229 第 1 项:computeSpan 返回**显式状态** {status, span, facts}(SPAN_STATUS
  // 五态,见 lib/span-semantics.js),不再用 null 承载四种语义。测试里 spanOf 断言
  // status=ok 并取 span;states 相关用例见下方「显式状态枚举」段。
  const spanOf = (result) => {
    expect(result.status).toBe('ok')
    return result.span
  }

  it('round 模式:遮蔽目标轮(该 user + 它的回复)', () => {
    const span = spanOf(computeSpan(events, 2)) // 编辑 u2(轮2)
    expect(span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
  })

  it('round 模式:编辑最后一条只遮蔽自己所在轮', () => {
    const span = spanOf(computeSpan(events, 4)) // 编辑 u3(轮3)
    expect(span).toEqual({ start: 4, end: 5, shadowedSeqs: [4, 5] })
  })

  it('tail 模式:遮蔽目标轮首到面尾(重新开始)', () => {
    const span = spanOf(computeSpan(events, 2, 'tail'))
    expect(span.shadowedSeqs).toEqual([2, 3, 4, 5])
  })

  it('支持 messageId 查找', () => {
    const span = spanOf(computeSpan(events, 'u2'))
    expect(span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
  })

  it('isRoundBoundary:只认真实 user 输入,排除注入', () => {
    expect(isRoundBoundary({ type: 'user/message', data: { source: { kind: 'user' } } })).toBe(true)
    expect(isRoundBoundary({ type: 'user/message', data: { source: { kind: 'context' } } })).toBe(false)
    expect(isRoundBoundary({ type: 'assistant/message' })).toBe(false)
  })
})

describe('adapter/dsh computeSpan · 显式状态枚举(issue-229 第 1 项:null 不再承载四种语义)', () => {
  const spanOf = (result) => {
    expect(result.status).toBe('ok')
    return result.span
  }

  it('ok:目标在快照里且在当前面 → status ok + span + facts(同一份快照)', () => {
    const result = computeSpan(events, 2)
    expect(result.status).toBe('ok')
    expect(result.span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
    expect(result.facts).toMatchObject({ fileMaxSeq: 5, targetSeq: 2, mode: 'round', nodes: 6 })
  })

  it('not-found:目标 seq 在快照范围内却不存在该位置(seq 空洞)→ not-found', () => {
    // 快照 0..5,但抽掉 seq 2(洞) → 目标 seq 2 在范围内却没有 → 不是"未落盘"也不是"被遮蔽"
    const holed = events.filter((e) => e.seq !== 2)
    const result = computeSpan(holed, 2)
    expect(result.status).toBe('not-found')
    expect(result.span).toBeNull()
    expect(result.facts).toMatchObject({ fileMaxSeq: 5, targetSeq: 2 })
  })

  it('not-found:事件列表不可读/为空(fileMaxSeq = -1 → 无判定证据,业务层落内存判)', () => {
    for (const input of [null, undefined, []]) {
      const result = computeSpan(input, 2)
      expect(result.status).toBe('not-found')
      expect(result.span).toBeNull()
      expect(result.facts.fileMaxSeq).toBe(-1)
    }
  })

  it('not-persisted:数字目标超出文件快照最大 seq(刚 commit 未 flush → message-pending)', () => {
    const result = computeSpan(events, 99)
    expect(result.status).toBe('not-persisted')
    expect(result.span).toBeNull()
    expect(result.facts).toMatchObject({ fileMaxSeq: 5, targetSeq: 99 })
    expect(99 > result.facts.fileMaxSeq).toBe(true)
  })

  it('not-persisted:消息 id 不在 append-only 日志里(同因:尚未落盘)', () => {
    const result = computeSpan(events, 'ghost-id')
    expect(result.status).toBe('not-persisted')
    expect(result.span).toBeNull()
    expect(result.facts).toMatchObject({ fileMaxSeq: 5, targetSeq: -1 })
  })

  it('already-shadowed:目标在日志里但已被更早 replace 移出当前面', () => {
    const marked = [
      { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
      { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: 'yo' }] } } },
      { seq: 2, type: 'assistant/message', surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1], data: { turn: 1, message: { id: 'retrace-recall-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 0, text: 'hi' } } },
    ]
    // 按 seq 与按 messageId 两条路径都给 already-shadowed(不再只是 null)
    expect(computeSpan(marked, 0).status).toBe('already-shadowed')
    expect(computeSpan(marked, 'u1').status).toBe('already-shadowed')
    expect(computeSpan(marked, 1).status).toBe('already-shadowed')
    expect(computeSpan(marked, 2).status).toBe('ok') // marker 自身在面上
  })

  it('replay-failed:foldSurface 重放抛错 → 内部错误状态(不冒充 already-shadowed)', () => {
    // 非法 surfaceOp(replace 的 start/end 不在面上)→ 官方 foldSurface 抛错
    const broken = [
      { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] } },
      { seq: 1, type: 'assistant/message', surfaceOp: { op: 'replace', start: 42, end: 43 }, sourceEventSeqs: [42, 43], data: { turn: 1, message: { id: 'retrace-recall-x', role: 'assistant', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 42, text: '' } } },
    ]
    const result = computeSpan(broken, 0)
    expect(result.status).toBe('replay-failed')
    expect(result.span).toBeNull()
    expect(result.facts).toMatchObject({ fileMaxSeq: 1, targetSeq: 0 })
  })

  it('spanMissArgsOf:只在文件侧确有快照证据时下传状态(无证据 → 业务层落内存判,行为不变)', () => {
    expect(spanMissArgsOf(computeSpan(events, 99))).toMatchObject({ spanStatus: 'not-persisted' })
    expect(spanMissArgsOf(computeSpan(events, 2))).toBeNull() // ok 不下传
    expect(spanMissArgsOf(computeSpan(null, 2))).toBeNull() // fileMaxSeq -1 → 无证据
    expect(spanMissArgsOf(null)).toBeNull()
  })

  it('spanOf 自检:ok 结果一定带合法 span(契约)', () => {
    expect(spanOf(computeSpan(events, 2)).shadowedSeqs).toEqual([2, 3])
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

  it('已被遮蔽的消息(marker 遮蔽过)→ already-shadowed(target-shadowed,不再 not found/死锁)', () => {
    const events = withMarker()
    expect(computeSpan(events, 0).status).toBe(SPAN_STATUS.ALREADY_SHADOWED) // u1 已被 marker 遮蔽,不在官方 nodes
    expect(computeSpan(events, 1).status).toBe(SPAN_STATUS.ALREADY_SHADOWED) // a1 同
    expect(computeSpan(events, 0).span).toBeNull()
  })

  it('marker 后撤回活跃消息:span 在官方 nodes 位置合法(foldSurface 写入不抛,不再倒置)', () => {
    const events = withMarker()
    for (const mode of ['round', 'tail']) {
      const result = computeSpan(events, 3, mode) // u2(活跃轮)
      expect(result.status).toBe(SPAN_STATUS.OK)
      const span = result.span
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
    const span = computeSpan(events, 3, 'tail').span
    // 官方 nodes = [2(marker), 3(u2), 4(a2)];u2 轮首=自己 → 遮蔽 [3,4] + marker(2) 位置在 3 前?
    // 位置段从 u2(index 1) 到尾 = [3, 4];marker(2) 在 index 0(3 前),不被遮蔽
    expect(span.shadowedSeqs).toEqual([3, 4])
    expect(span.start).toBe(3)
    expect(span.end).toBe(4)
  })

  it('round 模式:遮蔽目标轮(官方 nodes 上,marker 不入轮)', () => {
    const events = withMarker()
    const span = computeSpan(events, 3, 'round').span
    expect(span.shadowedSeqs).toEqual([3, 4])
  })
})

describe('adapter/dsh computeSpanProbe(issue-200 文件快照事实)', () => {
  it('span 命中 → facts 报文件快照最大 seq 与目标 seq', () => {
    const probe = computeSpanProbe(events, 2) // 编辑 u2(轮2)的全量夹具 seq 0..5
    expect(probe.status).toBe(SPAN_STATUS.OK)
    expect(probe.span).toEqual({ start: 2, end: 3, shadowedSeqs: [2, 3] })
    expect(probe.facts).toMatchObject({ fileMaxSeq: 5, targetSeq: 2, mode: 'round' })
  })

  it('messageId 定位:facts.targetSeq 从文件反向找到', () => {
    const probe = computeSpanProbe(events, 'u2')
    expect(probe.facts.targetSeq).toBe(2)
    expect(probe.span).not.toBeNull()
  })

  it('目标超出文件快照(文件 flush 滞后/刚 commit 未落盘)→ not-persisted(issue-229 显式状态)', () => {
    const probe = computeSpanProbe(events, 99, 'round')
    expect(probe.status).toBe(SPAN_STATUS.NOT_PERSISTED)
    expect(probe.span).toBeNull()
    expect(probe.facts.fileMaxSeq).toBe(5)
    // host-core 判据:not-persisted → message-pending(提交中),非 target-shadowed
    expect(99 > probe.facts.fileMaxSeq).toBe(true)
  })

  it('文件里没有该 messageId → not-persisted + facts.targetSeq -1(文件存在,快照已覆盖到尾部)', () => {
    const probe = computeSpanProbe(events, 'ghost')
    expect(probe.status).toBe(SPAN_STATUS.NOT_PERSISTED)
    expect(probe.span).toBeNull()
    expect(probe.facts).toMatchObject({ fileMaxSeq: 5, targetSeq: -1 })
  })

  it('不可读/空 events → 状态 not-found + facts.fileMaxSeq -1(无证据 → 业务层落内存判)', () => {
    const probe = computeSpanProbe(null, 2)
    expect(probe.status).toBe(SPAN_STATUS.NOT_FOUND)
    expect(probe.span).toBeNull()
    expect(probe.facts.fileMaxSeq).toBe(-1) // <0 → withFileSpan/http 不注入,host-core 落内存判
    const empty = computeSpanProbe([], 2)
    expect(empty.span).toBeNull()
    expect(empty.facts.fileMaxSeq).toBe(-1)
    const ghostId = computeSpanProbe(null, 'u2')
    expect(ghostId.span).toBeNull()
    expect(ghostId.facts).toMatchObject({ fileMaxSeq: -1, targetSeq: -1 })
    // 无证据 → 状态不下传(spanMissArgsOf 是唯一出口 → 业务层内存判定,行为不变)
    expect(spanMissArgsOf(probe)).toBeNull()
  })
})

describe('adapter/dsh computeSpanProbe · prompt(round 起点 user 原文,M-1 独立审查 74e580d 后续)', () => {
  it('round 模式:prompt = span 起点 user 的原文(目标同一轮的前置 user)', () => {
    const probe = computeSpanProbe(events, 5) // 目标 a3(轮3)
    expect(probe.span).toEqual({ start: 4, end: 5, shadowedSeqs: [4, 5] })
    expect(probe.prompt).toEqual({ seq: 4, text: 'more' }) // 轮3 user u3,不是更早轮
    // 目标是轮首 user 本身(edit 语义)时,prompt = 该 user 自己
    const editProbe = computeSpanProbe(events, 2)
    expect(editProbe.prompt).toEqual({ seq: 2, text: 'again' })
  })

  it('roundPromptOf 直测:round span 起点为轮边界 user 才返回原文', () => {
    const span = { start: 2, end: 3, shadowedSeqs: [2, 3] }
    expect(roundPromptOf(events, span, 'round')).toEqual({ seq: 2, text: 'again' })
    // 非 user 起点(孤儿回复:c1 assistant 起点)→ null
    expect(roundPromptOf(events, { start: 1, end: 3, shadowedSeqs: [1, 2, 3] }, 'round')).toBeNull()
    // 非 round 模式(tail/range 无「前置 user」语义)→ null
    expect(roundPromptOf(events, span, 'tail')).toBeNull()
    expect(roundPromptOf(events, span, 'range')).toBeNull()
    expect(roundPromptOf(events, null, 'round')).toBeNull()
    expect(roundPromptOf(null, span, 'round')).toBeNull()
  })

  it('tail / range 模式 → prompt null(非 round 轮语义)', () => {
    expect(computeSpanProbe(events, 2, 'tail').prompt).toBeNull()
    expect(computeSpanProbe(events, 0, 'range', { endSeq: 3 }).prompt).toBeNull()
  })

  it('孤儿回复(向前无 user 轮边界)→ span 起点是回复本身,prompt null(host-core 报 no-prompt)', () => {
    const orphan = [
      { seq: 0, type: 'assistant/message', surfaceOp: 'append', data: { message: { id: 'a1', content: [{ type: 'text', text: 'orphan' }] } } },
    ]
    const probe = computeSpanProbe(orphan, 0)
    expect(probe.span).not.toBeNull()
    expect(probe.prompt).toBeNull()
  })

  it('跨遮蔽区(中间 fold marker 遮蔽更早轮)→ prompt 取当前轮 user,绝不被遮蔽轮的更早 user', () => {
    // 轮1(u1/a1)被 fold marker(seq 2)遮蔽 → surface 只剩 marker + 轮2(u2/a2)
    const evts = [
      { seq: 0, type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: '影子轮旧输入' }] } },
      { seq: 1, type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, message: { id: 'a1', content: [{ type: 'text', text: '影子轮回复' }] } } },
      { seq: 2, type: 'assistant/message', surfaceOp: { op: 'replace', start: 0, end: 1 }, sourceEventSeqs: [0, 1], data: { turn: 1, message: { id: 'retrace-recall-x', content: [], source: { kind: 'model', provider: 'p', model: 'm' } }, editor: { targetSeq: 0, text: '' } } },
      { seq: 3, type: 'user/message', surfaceOp: 'append', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: '当前轮真实输入' }] } },
      { seq: 4, type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, message: { id: 'a2', content: [{ type: 'text', text: '当前轮回复' }] } } },
    ]
    const probe = computeSpanProbe(evts, 4) // regenerate 目标 a2
    expect(probe.span).toEqual({ start: 3, end: 4, shadowedSeqs: [3, 4] })
    // 关键断言:原文是当前轮 user(seq 3),不是被遮蔽的更早轮 u1(seq 0)
    expect(probe.prompt).toEqual({ seq: 3, text: '当前轮真实输入' })
  })
})
