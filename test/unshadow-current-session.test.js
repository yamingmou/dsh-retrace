/**
 * 真正恢复 · 任务 1(0.4.131)—— 「当前会话里可用」的闸门清单。
 *
 * 现场反馈缺陷:旧实现要求「目标会话**不是**当前活动会话」,而按钮就长在该会话里
 * ⇒ 切出去就点不到 ⇒ 真正恢复在界面上不可用。
 *
 * 本文件钉住**新语义**的四件事(逐条有断言):
 *   ① 活动会话(UI 打开、无在途轮次)⇒ 恢复**成功**,并带回 `reread` 重读信号;
 *   ② 有在途轮次(running / stopping / 排队)⇒ 拒绝 `session-running`,理由给到
 *      **可操作动作**("先停止当前回复"),且引擎**一次都没被调用**(零写入);
 *   ③ 别的进程持有文件(lsof)⇒ 照旧拒绝 `session-held`;
 *   ④ 幂等(已是中和态)⇒ `alreadyRestored` + `zeroWrite` + 仍下发重读信号
 *      (磁盘已是中和态,界面可能仍是旧视图)。
 * 其余硬闸的回归在 test/true-restore.test.js / test/true-restore-real.test.js。
 */
import { describe, it, expect, vi } from 'vitest'
import { createEditorApi, UNSHADOW_OP } from '../lib/host-core.js'
import { AUDIT_EVENT_TYPE, CARRIER_EVENT_TYPE } from '../lib/marker-carrier.js'
import { assistantMessage, headerEvent, makeAgent, makeEnv, userMessage } from './helpers.js'

/** 极简假会话(形状与 test/true-restore.test.js 的 makeSimpleSession 同源)。 */
function makeSession(descriptors, { isRunning = false } = {}) {
  const events = []
  const append = (event) => { const record = { seq: events.length, time: 1000 + events.length, ...event }; events.push(record); return record }
  const session = {
    id: 's1',
    events,
    header: { version: 3, id: 's1', createdAt: 0, isSeeded: false },
    surface: { nodes: [] },
    isRunning,
    get seq() { return events.length },
    appendRaw: append,
    append: (type, data, options = {}) => append({ type, data, ...options }),
    seed(...list) { for (const d of list) append(d); return this },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => events.slice(),
  }
  return session.seed(headerEvent(), ...descriptors)
}

/** 生产两段形状:0 header / 1 u1 / 2 a1 / 3 u2 / 4 a2 / 5 审计 / 6 载体。 */
function twoSegmentSession(options = {}) {
  return makeSession([
    userMessage('u1', 'q1'),
    assistantMessage('a1', 'r1'),
    userMessage('u2', 'q2'),
    assistantMessage('a2', 'r2'),
    { type: AUDIT_EVENT_TYPE, data: { shadowedRange: { start: 3, end: 4 }, shadowedSeqs: [3, 4], shadowedTokenCount: 10 } },
    {
      type: CARRIER_EVENT_TYPE,
      surfaceOp: { op: 'replace', startSeq: 3, endSeq: 4 },
      sourceEventSeqs: [5, 3, 4],
      data: { id: 'retrace-recall-mrk001', role: 'user', content: [{ type: 'text', text: 'recalled' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    },
  ], options)
}

/** 记录引擎调用;默认回「写成功」信封。 */
function makeApi({ session, agent = makeAgent(), trueRestore } = {}) {
  const seen = []
  const api = createEditorApi({}, makeEnv(session, { agent }).sessions, { get: () => agent }, () => {}, {
    sessionFileFor: async (sessionId) => `/tmp/${sessionId}.v3.jsonl.zstd`,
    trueRestore: trueRestore ?? (async (args) => {
      seen.push(args)
      return {
        ok: true, alreadyRestored: false, zeroWrite: false, file: args.file,
        auditSeq: args.auditSeq,
        surface: { before: { nodes: 3, strict: true }, after: { nodes: 4, strict: true }, restored: 2, shadowedTotal: 2, stillHidden: [] },
        frames: { total: 2, rewritten: [1] }, verify: { ok: true },
      }
    }),
  })
  return { api, seen, agent }
}

const errorOf = async (promise) => {
  const result = await promise
  expect(result?.ok).toBe(false)
  return result.error
}

describe('unshadow · 任务1:当前会话里可用(活动会话 + 无在途轮次 ⇒ 成功)', () => {
  it('① 活动会话(UI 正看着它)且无在途轮次 ⇒ 恢复成功,并带回 reread 重读信号', async () => {
    const session = twoSegmentSession()
    const { api, seen } = makeApi({ session })
    const envelope = await api.unshadow({ sessionId: 's1', markerSeq: 6 })
    expect(envelope.ok).toBe(true)
    const value = envelope.value
    expect(value.op).toBe(UNSHADOW_OP)
    expect(value.markerSeq).toBe(6)
    expect(value.markerOp).toBe('recall')
    expect(value.alreadyRestored).toBe(false)
    expect(value.zeroWrite).toBe(false)
    // 「当场可见」的信号:宿主写成功后把「磁盘已改、内存未重读」带回客户端。
    expect(value.reread).toMatchObject({
      required: true, sessionId: 's1', reason: 'log-rewritten', alreadyRestored: false,
      markerId: 'retrace-recall-mrk001',
    })
    expect(value.reread.neutralizedSeqs).toEqual([6, 5])
    // 引擎确实被调用了一次,且注入面里**不再有** currentSessionId,只有在途规则。
    expect(seen).toHaveLength(1)
    expect(seen[0].currentSessionId).toBeUndefined()
    expect(seen[0].running).toBe(false)
    expect(seen[0].runningReason).toBe('')
  })

  it('② running ⇒ 拒绝 session-running(可操作理由),引擎零调用、零写入', async () => {
    const session = twoSegmentSession({ isRunning: true })
    const spy = vi.fn(async (args) => ({ ok: true, file: args.file }))
    const { api } = makeApi({ session, trueRestore: spy })
    const error = await errorOf(api.unshadow({ sessionId: 's1', markerSeq: 6 }))
    expect(error.code).toBe('session-running')
    expect(error.message).toContain('先停止当前回复')
    // op 信封把 details 平铺在 error 上(见 host-core 的 op() 包装),故读 error.reason。
    expect(error.reason).toBe('running-reply')
    expect(spy).not.toHaveBeenCalled()
  })

  it('② agent.status=stopping ⇒ session-running(reason=stopping-reply,理由指"收尾")', async () => {
    const session = twoSegmentSession()
    const spy = vi.fn(async (args) => ({ ok: true, file: args.file }))
    const { api } = makeApi({ session, agent: makeAgent({ status: 'stopping' }), trueRestore: spy })
    const error = await errorOf(api.unshadow({ sessionId: 's1', markerSeq: 6 }))
    expect(error.code).toBe('session-running')
    expect(error.reason).toBe('stopping-reply')
    expect(error.message).toContain('收尾')
    expect(spy).not.toHaveBeenCalled()
  })

  it('② agent.inbox 有排队轮次 ⇒ session-running(reason=queued-turn)', async () => {
    const session = twoSegmentSession()
    const spy = vi.fn(async (args) => ({ ok: true, file: args.file }))
    const { api } = makeApi({ session, agent: makeAgent({ inbox: { hasPending: true } }), trueRestore: spy })
    const error = await errorOf(api.unshadow({ sessionId: 's1', markerSeq: 6 }))
    expect(error.code).toBe('session-running')
    expect(error.reason).toBe('queued-turn')
    expect(error.message).toContain('排队')
    expect(spy).not.toHaveBeenCalled()
  })

  it('② agent 面读不到(旧内核/桩)⇒ 不误拒:照常交引擎(闸只在真有证据时关)', async () => {
    const session = twoSegmentSession()
    const bare = { get: () => undefined }
    const seen = []
    const api = createEditorApi({}, makeEnv(session, { agent: undefined }).sessions, bare, () => {}, {
      sessionFileFor: async (sessionId) => `/tmp/${sessionId}.zstd`,
      trueRestore: async (args) => { seen.push(args); return { ok: true, file: args.file, alreadyRestored: false, auditSeq: args.auditSeq, surface: { restored: 1, shadowedTotal: 1, stillHidden: [] } } },
    })
    const envelope = await api.unshadow({ sessionId: 's1', markerSeq: 6 })
    expect(envelope.ok).toBe(true)
    expect(seen[0].running).toBe(false)
  })

  it('③ 别的进程持有文件(lsof)⇒ 照旧拒绝 session-held(占用闸未被放宽)', async () => {
    const session = twoSegmentSession()
    const { api } = makeApi({
      session,
      trueRestore: async () => { const error = new Error('会话文件正被进程持有(PID 4242)'); error.code = 'session-held'; throw error },
    })
    const error = await errorOf(api.unshadow({ sessionId: 's1', markerSeq: 6 }))
    expect(error.code).toBe('session-held')
  })

  it('④ 幂等:已中和态 ⇒ alreadyRestored + zeroWrite,但仍下发 reread(界面可能仍旧)', async () => {
    const session = twoSegmentSession()
    const { api } = makeApi({
      session,
      trueRestore: async (args) => ({ ok: true, alreadyRestored: true, zeroWrite: true, file: args.file, carrierSeq: args.carrierSeq, auditSeq: args.auditSeq }),
    })
    const envelope = await api.unshadow({ sessionId: 's1', markerSeq: 6 })
    expect(envelope.ok).toBe(true)
    expect(envelope.value.alreadyRestored).toBe(true)
    expect(envelope.value.zeroWrite).toBe(true)
    expect(envelope.value.reloadRequired).toBe(false)
    expect(envelope.value.reread).toMatchObject({ required: true, alreadyRestored: true, reason: 'log-rewritten' })
  })

  it('dryRun ⇒ 零写入、无 reread 信号(没有写就没有"需重读")', async () => {
    const session = twoSegmentSession()
    const { api } = makeApi({
      session,
      trueRestore: async (args) => ({ ok: true, dryRun: true, zeroWrite: true, file: args.file, carrierSeq: args.carrierSeq, surface: { restored: 2, shadowedTotal: 2, stillHidden: [] } }),
    })
    const envelope = await api.unshadow({ sessionId: 's1', markerSeq: 6, dryRun: true })
    expect(envelope.ok).toBe(true)
    expect(envelope.value.dryRun).toBe(true)
    expect(envelope.value.reread).toBe(null)
  })
})
