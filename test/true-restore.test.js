/**
 * 真正恢复(true restore / `unshadow`,0.4.126)—— 日志层面的遮蔽撤销。
 *
 * 本文件钉住四层:
 *  ① **路线判据**(为什么只能中和、不能删):删行 ⇒ `foldSurface` 报 "is not contiguous"
 *     整库不可折叠(内核 fold 用数组下标当 seq);中和 ⇒ fold 跳过该事件、区间回到面上。
 *  ② **帧级最小改写**:多帧 zstd 只重压含目标行的帧,其余帧**字节不动**;header 帧恒不动。
 *  ③ **全部硬闸**:占用(lsof)、当前会话、运行中、lsof 不可用 fail-closed、折叠预演
 *     (被更晚 replace 重新遮蔽 ⇒ 拒绝)、幂等(零写入)、写后校验失败 ⇒ 备份字节级回滚。
 *  ④ **宿主 op 层**:`unshadow` 的注入面接线、信封映射、已中和态幂等、未装配时报
 *     `unshadow-unavailable`。
 * ⛔ 本文件只在 `mkdtempSync(tmpdir())` 下建测试文件,绝不碰真实会话目录
 * (真实会话副本的端到端见 test/true-restore-real.test.js,同样只读复制)。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants as zlibConstants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { foldSurface } from '@deepseek-ai/dsh-session'
import {
  createTrueRestore,
  defaultBackupRoot,
  expandSurfaceOpRange,
  isNeutralizedEvent,
  isReplaceCarrier,
  neutralizeMarkerEvent,
  scanZstdFrames,
} from '../lib/rollback.js'
import {
  NEUTRALIZED_MARKER_TYPE,
  UNSHADOW_OP,
  createEditorApi,
  isNeutralizedMarkerEvent,
} from '../lib/host-core.js'
import { AUDIT_EVENT_TYPE, CARRIER_EVENT_TYPE } from '../lib/marker-carrier.js'
import { strictScanText } from 'dsh-log-contract'
import { computeSpan, readEventsFromFile } from '../lib/adapter/dsh.js'
import { SPAN_STATUS } from '../lib/span-semantics.js'
import { assistantMessage, headerEvent, makeAgent, makeEnv, userMessage } from './helpers.js'

/** 严格折叠(测试进程内核 = 0.1.0-rc.7/v0;本文件夹具即 v0 形状 ⇒ 严格折 100% 生效)。 */
const strictFold = (events) => foldSurface(events)
/** 镜像折替身(严格折不抛时永不使用;它的存在本身就是"退化路径可见"的判据)。 */
const passthroughMirror = () => []

let root = null
let file = null
let backupDir = null

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'retrace-true-restore-'))
  file = join(root, 'sessiondir', 's1', 'session.v3.jsonl.zstd')
  backupDir = join(root, 'backups-outside-sessiondir')
  mkdirSync(join(root, 'sessiondir', 's1'), { recursive: true })
})

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 清理失败不影响判定 */ }
})

/**
 * 两轮会话 + 撤回标记(标准夹具):
 *   0 u1 / 1 a1 / 2 u2 / 3 a2 / 4 审计(compaction/prune) / 5 载体(replace 2..3, retrace-recall)
 */
function standardEvents() {
  return [
    { type: 'user/message', surfaceOp: 'append', data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'q1' }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 1, step: 1, message: { id: 'a1', content: [{ type: 'text', text: 'r1' }] } } },
    { type: 'user/message', surfaceOp: 'append', data: { id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'q2' }] } },
    { type: 'assistant/message', surfaceOp: 'append', data: { turn: 2, step: 1, message: { id: 'a2', content: [{ type: 'text', text: 'r2' }] } } },
    { type: AUDIT_EVENT_TYPE, data: { shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], shadowedTokenCount: 10 } },
    {
      type: CARRIER_EVENT_TYPE,
      // 现役内核 v4(SESSION_FORMAT_VERSION=4):replace 区间键名 = startSeq/endSeq
      // (内核 lib/index.js:292 isReplaceOp);v0 的 start/end 会被判 invalid 并拒掉整份日志。
      surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 },
      sourceEventSeqs: [4, 2, 3],
      data: { id: 'retrace-recall-mrk001', role: 'user', content: [{ type: 'text', text: 'recalled' }], source: { kind: 'model', provider: 'p', model: 'm' } },
    },
  ]
}

const ZSTD_OPTS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } }
const HEADER = { type: 'session', version: 3, id: 's1', createdAt: 0, isSeeded: false }

/**
 * 把事件写成真会话文件形状:帧 0 = header 行,其余帧 = 事件行。
 * `frameSplit = n` ⇒ 正文每 n 行一个帧(默认 1 ⇒ 每个事件帧含 1 行,便于逐帧字节对比)。
 * @returns {Buffer} 写盘字节
 */
function writeLog(events, { frameSplit = 1, target = file, header = HEADER } = {}) {
  const headText = `${JSON.stringify(header)}\n`
  const bodyLines = events.map((event, seq) => JSON.stringify({ seq, time: 1000 + seq, ...event }))
  const frames = [zstdCompressSync(Buffer.from(headText, 'utf8'), ZSTD_OPTS)]
  for (let i = 0; i < bodyLines.length; i += frameSplit) {
    const chunk = `${bodyLines.slice(i, i + frameSplit).join('\n')}\n`
    frames.push(zstdCompressSync(Buffer.from(chunk, 'utf8'), ZSTD_OPTS))
  }
  const buffer = Buffer.concat(frames)
  writeFileSync(target, buffer)
  return buffer
}

/** 读盘事件(测试自持解码:帧扫描 → 逐帧解压 → 逐行 JSON;与引擎实现无关,避免同源自证)。 */
function readEventsFromDisk(path) {
  const buf = readFileSync(path)
  const { frames, tornStart } = scanZstdFrames(buf)
  if (tornStart !== null) throw new Error(`torn frame at ${tornStart}`)
  const events = []
  for (const frame of frames) {
    const text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      const parsed = JSON.parse(line)
      if (parsed.type !== 'session') events.push(parsed)
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return { events, frames }
}

function engine({ fold = strictFold, mirror = passthroughMirror, lsof, log } = {}) {
  return createTrueRestore({
    fold,
    mirror,
    lsof: lsof ?? (() => ({ available: true, holders: [] })),
    backupRoot: () => backupDir,
    log: log ?? (() => {}),
  })
}

const restoreArgs = (extra = {}) => ({
  file,
  carrierSeq: 5,
  auditSeq: 4,
  shadowedSeqs: [2, 3],
  sessionId: 's1',
  currentSessionId: 'other-session',
  ...extra,
})

describe('真正恢复 · 路线判据(删 vs 中和)', () => {
  it('删掉两段 marker 行 ⇒ 日志留下 seq 空洞(契约层 E2 直报),故删除路线不可行', () => {
    // ⚠️ 本测试进程的内核是 dev 依赖 0.1.0-rc.7(v0):它**不**校验 seq==下标,故删行不抛。
    // 现役内核 0.1.7-rc.2(v3)会抛 "session event seq N is not contiguous; expected M"
    // —— 该读数在 test/true-restore-real.test.js 用真 v3 内核钉住(/tmp 实测同样读数)。
    // 这里用**与内核版本无关**的契约层判据(strictScanText)钉住"空洞"这件事本身。
    const header = JSON.stringify({ type: 'session', version: 3, id: 's1', createdAt: 0, isSeeded: false })
    // marker 两段必须在**日志中段**才能看出空洞(末尾两行删掉不留洞):
    // 之后还有两个 append 事件(seq 6/7),删掉 seq 4/5 ⇒ 期望 4 实际 6。
    const full = [
      ...standardEvents(),
      { type: 'user/message', surfaceOp: 'append', data: { id: 'u3', source: { kind: 'user' }, content: [{ type: 'text', text: 'q3' }] } },
      { type: 'assistant/message', surfaceOp: 'append', data: { turn: 3, step: 1, message: { id: 'a3', content: [{ type: 'text', text: 'r3' }] } } },
    ]
    const lines = full.map((event, seq) => JSON.stringify({ seq, time: 1, ...event }))
    expect(strictScanText(`${header}\n${lines.join('\n')}\n`).failures).toEqual([])
    const deleted = lines.filter((_, i) => i !== 4 && i !== 5)
    const scan = strictScanText(`${header}\n${deleted.join('\n')}\n`)
    expect(scan.failures.length).toBeGreaterThan(0)
    expect(scan.failures[0]).toMatchObject({ expected: 4, got: 6 })
    // 空洞就是"期望 4 实际 6";中和不动 seq ⇒ 永远不可能产生空洞。
    const neutral = standardEvents().map((event, seq) => (seq === 4 || seq === 5 ? { ...neutralizeMarkerEvent({ ...event, seq }), seq } : { ...event, seq }))
    expect(neutral.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('中和两段 ⇒ 严格 fold 成功且被遮蔽区间回到面上(载体节点消失)', () => {
    const events = standardEvents().map((event, seq) => ({ seq, time: 1, ...event }))
    expect(foldSurface(events).nodes).toEqual([0, 1, 5])
    const neutral = events.map((event, seq) => (seq === 4 || seq === 5 ? { ...neutralizeMarkerEvent(event), seq } : event))
    const folded = foldSurface(neutral)
    expect(folded.nodes).toEqual([0, 1, 2, 3])
    expect(folded.nodes).toContain(2)
    expect(folded.nodes).toContain(3)
    expect(folded.nodes).not.toContain(5)
  })

  it('中和形状 = log-only(type + ignorable,无 surfaceOp/sourceEventSeqs),seq/time/data 逐字保留', () => {
    const event = { seq: 5, time: 1234, type: 'user/message', surfaceOp: { op: 'replace', start: 2, end: 3 }, sourceEventSeqs: [4, 2, 3], data: { id: 'x' } }
    const out = neutralizeMarkerEvent(event)
    expect(out).toEqual({ type: NEUTRALIZED_MARKER_TYPE, seq: 5, time: 1234, data: { id: 'x' }, ignorable: true })
    expect(isNeutralizedEvent(out)).toBe(true)
    // 两处各自持有的判据必须同值/同形(host-core ↔ rollback.js,不许分叉)
    expect(NEUTRALIZED_MARKER_TYPE).toBe('retrace/marker')
    expect(isNeutralizedMarkerEvent(out)).toBe(true)
  })

  it('载体区间判据认 v3/v0 双形状;区间展开只认恰好三成员', () => {
    expect(isReplaceCarrier({ surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 } })).toBe(true)
    expect(isReplaceCarrier({ surfaceOp: { op: 'replace', start: 2, end: 3 } })).toBe(true)
    expect(isReplaceCarrier({ surfaceOp: 'append' })).toBe(false)
    expect(isReplaceCarrier({ surfaceOp: { op: 'replace', start: 2, end: 3, extra: 1 } })).toBe(false)
    expect(isReplaceCarrier({})).toBe(false)
    expect(expandSurfaceOpRange({ op: 'replace', startSeq: 2, endSeq: 4 })).toEqual([2, 3, 4])
    expect(expandSurfaceOpRange({ op: 'replace', start: 4, end: 2 })).toEqual([])
  })
})

describe('真正恢复 · 帧级最小改写', () => {
  it('多帧文件只重压含目标行的帧,其余帧字节逐字节不动;header 帧恒不动', async () => {
    const before = writeLog(standardEvents(), { frameSplit: 1 })
    const scanBefore = scanZstdFrames(before)
    expect(scanBefore.tornStart).toBeNull()
    expect(scanBefore.frames.length).toBe(7) // header + 6 事件
    const result = await engine().restore(restoreArgs())
    expect(result.ok).toBe(true)
    expect(result.frames.total).toBe(7)
    expect(result.verify.framesChecked).toBe(7)
    const after = readFileSync(file)
    const scanAfter = scanZstdFrames(after)
    expect(scanAfter.frames.length).toBe(7)
    const rewritten = new Set(result.frames.rewritten)
    expect([...rewritten].sort((a, b) => a - b)).toEqual([5, 6]) // seq4 审计 = 行 5;seq5 载体 = 行 6
    for (let i = 0; i < scanBefore.frames.length; i++) {
      const a = before.subarray(scanBefore.frames[i].start, scanBefore.frames[i].end)
      const b = after.subarray(scanAfter.frames[i].start, scanAfter.frames[i].end)
      if (rewritten.has(i)) expect(Buffer.compare(a, b)).not.toBe(0)
      else expect(Buffer.compare(a, b)).toBe(0)
    }
    expect(rewritten.has(0)).toBe(false) // header 帧
  })

  it('2 帧容器(header + 整段正文)也成立:header 帧字节不动', async () => {
    const before = writeLog(standardEvents(), { frameSplit: 99 })
    const scanBefore = scanZstdFrames(before)
    expect(scanBefore.frames.length).toBe(2)
    const result = await engine().restore(restoreArgs())
    expect(result.frames.rewritten).toEqual([1])
    const after = readFileSync(file)
    const scanAfter = scanZstdFrames(after)
    expect(Buffer.compare(
      before.subarray(scanBefore.frames[0].start, scanBefore.frames[0].end),
      after.subarray(scanAfter.frames[0].start, scanAfter.frames[0].end),
    )).toBe(0)
  })

  it('写后:目标两行中和、seq/行数不变、其余行逐字节不动(verify 自证)', async () => {
    writeLog(standardEvents())
    const result = await engine().restore(restoreArgs())
    expect(result.ok).toBe(true)
    const { events } = readEventsFromDisk(file)
    expect(events.length).toBe(6)
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5])
    expect(isNeutralizedEvent(events[4])).toBe(true)
    expect(isNeutralizedEvent(events[5])).toBe(true)
    expect(events[5].data.id).toBe('retrace-recall-mrk001')
    expect(result.verify.lineCount).toBe(7) // header + 6 事件
    expect(result.verify.unchangedLinesByteEqual).toBe(true)
    expect(result.verify.targetLinesNeutralized).toBe(2)
    expect(result.verify.seqPreserved).toBe(true)
    expect(result.verify.dataPreserved).toBe(true)
    expect(result.verify.seqGap).toBe(false)
    expect(result.verify.shadowedBefore).toBe(2)
    expect(result.verify.restoredAfter).toBe(2)
    expect(result.verify.surfaceBefore).toEqual({ nodes: 3, first: 0, last: 5, strict: true })
    expect(result.verify.surfaceAfter).toEqual({ nodes: 4, first: 0, last: 3, strict: true })
  })
})

describe('真正恢复 · 安全闸(缺一不可)', () => {
  it('占用闸:lsof 有持有者 ⇒ session-held,文件零改动', async () => {
    writeLog(standardEvents())
    const original = readFileSync(file)
    await expect(engine({ lsof: () => ({ available: true, holders: ['4242'] }) }).restore(restoreArgs()))
      .rejects.toMatchObject({ code: 'session-held' })
    expect(Buffer.compare(readFileSync(file), original)).toBe(0)
  })

  it('占用闸 fail-closed:lsof 不可用 ⇒ 拒绝,绝不"没查到就当没占用"', async () => {
    writeLog(standardEvents())
    await expect(engine({ lsof: () => ({ available: false, holders: [], error: 'lsof not found' }) }).restore(restoreArgs()))
      .rejects.toMatchObject({ code: 'lsof-unavailable' })
  })

  it('当前会话闸:currentSessionId === sessionId ⇒ session-active(可读原因交给客户端文案)', async () => {
    writeLog(standardEvents())
    const original = readFileSync(file)
    const error = await engine().restore(restoreArgs({ currentSessionId: 's1' })).catch((e) => e)
    expect(error.code).toBe('session-active')
    expect(error.message).toContain('切走')
    expect(Buffer.compare(readFileSync(file), original)).toBe(0)
  })

  it('运行闸:会话正在跑 ⇒ session-running', async () => {
    writeLog(standardEvents())
    await expect(engine().restore(restoreArgs({ running: true }))).rejects.toMatchObject({ code: 'session-running' })
  })

  it('折叠预演闸:被更晚的 replace 重新遮蔽 ⇒ restore-re-shadowed 且零写入', async () => {
    writeLog([
      ...standardEvents(),
      { type: AUDIT_EVENT_TYPE, data: { shadowedRange: { start: 2, end: 3 }, shadowedSeqs: [2, 3], shadowedTokenCount: 10 } },
      { type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [6, 2, 3], data: { id: 'retrace-edit-mrk002', role: 'user', content: [{ type: 'text', text: 'again' }], source: { kind: 'model', provider: 'p', model: 'm' } } },
    ])
    const original = readFileSync(file)
    const error = await engine().restore(restoreArgs()).catch((e) => e)
    expect(error.code).toBe('restore-re-shadowed')
    expect(error.details.stillHidden).toEqual([2, 3])
    expect(Buffer.compare(readFileSync(file), original)).toBe(0)
  })

  it('幂等闸:已中和 ⇒ alreadyRestored + zeroWrite,文件 sha 一字不变', async () => {
    writeLog(standardEvents())
    const first = await engine().restore(restoreArgs())
    expect(first.alreadyRestored).toBe(false)
    const mid = readFileSync(file)
    const second = await engine().restore(restoreArgs())
    expect(second.alreadyRestored).toBe(true)
    expect(second.zeroWrite).toBe(true)
    expect(Buffer.compare(readFileSync(file), mid)).toBe(0)
    // 幂等闸先于占用闸:无写入 ⇒ 被持有也无风险,返回 alreadyRestored 而不是报错
    const third = await engine({ lsof: () => ({ available: true, holders: ['1'] }) }).restore(restoreArgs())
    expect(third.alreadyRestored).toBe(true)
  })

  it('写后校验失败 ⇒ 用备份字节级回滚 + verify-failed(第 4 次 fold 调用伪造"区间没回面")', async () => {
    writeLog(standardEvents())
    const original = readFileSync(file)
    let calls = 0
    const fold = (events) => {
      calls += 1
      // 调用序:1 预演-before / 2 预演-after / 3 校验-before / 4 校验-after
      if (calls === 4) return { nodes: [0, 1] }
      return strictFold(events)
    }
    const error = await engine({ fold }).restore(restoreArgs()).catch((e) => e)
    expect(calls).toBe(4)
    expect(error.code).toBe('verify-failed')
    expect(error.details.rolledBack).toBe(true)
    expect(Buffer.compare(readFileSync(file), original)).toBe(0)
  })

  it('备份落在会话目录之外且字节一致', async () => {
    const original = writeLog(standardEvents())
    const result = await engine().restore(restoreArgs())
    expect(result.backupPath.startsWith(backupDir)).toBe(true)
    expect(result.backupPath.includes(join('sessiondir', 's1'))).toBe(false)
    expect(Buffer.compare(readFileSync(result.backupPath), original)).toBe(0)
  })

  it('损坏日志(撕裂尾帧)⇒ log-damaged,拒绝在坏日志上做手术', async () => {
    const good = writeLog(standardEvents())
    writeFileSync(file, Buffer.concat([good, Buffer.from([0x28, 0xb5, 0x2f])]))
    await expect(engine().restore(restoreArgs())).rejects.toMatchObject({ code: 'log-damaged' })
  })

  it('目标不是 replace 载体 ⇒ target-not-a-carrier(绝不猜着改)', async () => {
    writeLog([userMessage('u1', 'q1'), { type: CARRIER_EVENT_TYPE, surfaceOp: 'append', data: { id: 'retrace-unhide-x', role: 'user', content: [{ type: 'text', text: 'x' }] } }])
    await expect(engine().restore(restoreArgs({ carrierSeq: 1, auditSeq: null, shadowedSeqs: [] })))
      .rejects.toMatchObject({ code: 'target-not-a-carrier' })
  })

  it('dryRun 预演:零写入但给出面节点前后读数', async () => {
    writeLog(standardEvents())
    const original = readFileSync(file)
    const result = await engine().restore(restoreArgs({ dryRun: true }))
    expect(result.dryRun).toBe(true)
    expect(result.zeroWrite).toBe(true)
    expect(result.surface.before.nodes).toBe(3)
    expect(result.surface.after.nodes).toBe(4)
    expect(result.surface.restored).toBe(2)
    expect(result.surface.after.strict).toBe(true)
    expect(Buffer.compare(readFileSync(file), original)).toBe(0)
  })

  it('默认备份根与会话基座同源且不在 sessions/ 之下(形状判据)', () => {
    const dir = defaultBackupRoot(new Date('2026-10-08T00:00:00Z'))
    expect(dir).toContain('true-restore-backups')
    expect(dir).toContain('20261008')
    expect(dir.includes('sessions/')).toBe(false)
    expect(dir.includes('/sessions')).toBe(false)
  })
})

describe('真正恢复 · target-shadowed 消失(与适配器同一份文件快照判据)', () => {
  it('恢复前 computeSpan=already-shadowed;恢复后 status=ok 且区间回到面', async () => {
    writeLog(standardEvents())
    const before = await readEventsFromFile(file)
    expect(before).toBeTruthy()
    const spanBefore = computeSpan(before, 2, 'round')
    expect(spanBefore.status).toBe(SPAN_STATUS.ALREADY_SHADOWED)
    await engine().restore(restoreArgs())
    const after = await readEventsFromFile(file)
    const spanAfter = computeSpan(after, 2, 'round')
    expect(spanAfter.status).toBe(SPAN_STATUS.OK)
    expect(spanAfter.span.start).toBe(2)
    expect(spanAfter.span.end).toBe(3)
    expect(spanAfter.span.shadowedSeqs).toEqual([2, 3])
  })
})

/**
 * op 信封判据:`createEditorApi` 的每个 op 都经 `op()` 包装 —— 抛错**不**冒泡到调用方,
 * 而是落成 `{ok:false, error:{code,message,...}}`(与 HTTP 侧同一信封)。故 op 层用例
 * 断言信封,不断言 reject。
 * @returns {Promise<object>} error 对象(ok===true 时用例自身失败)
 */
async function opError(promise) {
  const result = await promise
  expect(result?.ok).toBe(false)
  expect(typeof result?.error?.code).toBe('string')
  return result.error
}

/** 极简假会话(仅够 op 层读事件;surface.nodes 与断言无关)。 */
function makeSimpleSession(descriptors, { isRunning = false } = {}) {
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

/** 生产两段形状的 marker 会话:0 header / 1 u1 / 2 a1 / 3 u2 / 4 a2 / 5 审计 / 6 载体。 */
function twoSegmentSession() {
  const marker = {
    type: CARRIER_EVENT_TYPE,
    surfaceOp: { op: 'replace', start: 3, end: 4 },
    sourceEventSeqs: [5, 3, 4],
    data: { id: 'retrace-recall-mrk001', role: 'user', content: [{ type: 'text', text: 'x' }], source: { kind: 'model', provider: 'p', model: 'm' } },
  }
  return makeSimpleSession([
    userMessage('u1', 'q1'),
    assistantMessage('a1', 'r1'),
    userMessage('u2', 'q2'),
    assistantMessage('a2', 'r2'),
    { type: AUDIT_EVENT_TYPE, data: { shadowedRange: { start: 3, end: 4 }, shadowedSeqs: [3, 4], shadowedTokenCount: 10 } },
    marker,
  ])
}

describe('真正恢复 · 宿主 op 层(unshadow)', () => {
  it('注入面接线:载体 seq / 审计 seq / 被遮蔽集合 / currentSessionId 交给 trueRestore,结果映射成 op 信封', async () => {
    const session = twoSegmentSession()
    expect(session.events.length).toBe(7)
    expect(session.events[6].seq).toBe(6)
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const seen = []
    const api = createEditorApi({}, sessions, agents, () => {}, {
      sessionFileFor: async (sessionId) => `/tmp/${sessionId}.v3.jsonl.zstd`,
      trueRestore: async (args) => {
        seen.push(args)
        return {
          ok: true, alreadyRestored: false, zeroWrite: false, file: args.file, auditSeq: args.auditSeq,
          surface: { before: { nodes: 3, strict: true }, after: { nodes: 4, strict: true }, restored: 2, shadowedTotal: 2, stillHidden: [] },
          frames: { total: 2, rewritten: [1] }, verify: { ok: true },
        }
      },
    })
    const envelope = await api.unshadow({ sessionId: 's1', markerSeq: 6, currentSessionId: 'viewer' })
    expect(envelope.ok).toBe(true)
    const result = envelope.value // op 信封:成功载荷在 value 下(与 unhide 既有用例同一读法)
    expect(seen.length).toBe(1)
    expect(seen[0].file).toBe('/tmp/s1.v3.jsonl.zstd')
    expect(seen[0].carrierSeq).toBe(6)
    expect(seen[0].auditSeq).toBe(5)
    expect(seen[0].shadowedSeqs).toEqual([3, 4])
    expect(seen[0].currentSessionId).toBe('viewer')
    expect(seen[0].running).toBe(false)
    expect(result.op).toBe(UNSHADOW_OP)
    expect(result.markerSeq).toBe(6)
    expect(result.markerOp).toBe('recall')
    expect(result.alreadyRestored).toBe(false)
    expect(result.reloadRequired).toBe(true) // 磁盘已改、内存视图未重读 ⇒ 必须重开会话
    expect(result.restored).toBe(2)
    expect(result.surface.after.nodes).toBe(4)
  })

  it('运行中的会话 ⇒ running:true 原样交给引擎(闸在引擎侧,不在 op 侧静默放过)', async () => {
    const session = makeSimpleSession([
      userMessage('u1', 'q1'),
      { type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: 'retrace-edit-mrk', role: 'user', content: [{ type: 'text', text: 'x' }] } },
    ], { isRunning: true })
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const seen = []
    const api = createEditorApi({}, sessions, agents, () => {}, {
      sessionFileFor: async () => '/tmp/s1.zstd',
      trueRestore: async (args) => { seen.push(args); return { ok: true } },
    })
    await api.unshadow({ sessionId: 's1', markerSeq: 2, currentSessionId: 'viewer' })
    expect(seen[0].running).toBe(true)
  })

  it('已中和态幂等:目标已是 log-only ⇒ 仍交给引擎(磁盘才是权威),结果为 alreadyRestored + 零写入', async () => {
    const session = makeSimpleSession([
      userMessage('u1', 'q1'),
      { type: NEUTRALIZED_MARKER_TYPE, ignorable: true, data: { id: 'retrace-recall-mrk001', role: 'user' } },
    ])
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    // host-core **不**自己判幂等:内存视图可能是陈旧的,唯一权威是磁盘(引擎的幂等闸,
    // 零写入 + alreadyRestored)。故这里断言"引擎被调用了一次且被如实转述"。
    const spy = vi.fn(async (args) => ({ ok: true, alreadyRestored: true, zeroWrite: true, file: args.file, carrierSeq: args.carrierSeq }))
    const api = createEditorApi({}, sessions, agents, () => {}, {
      sessionFileFor: async () => '/tmp/s1.zstd',
      trueRestore: spy,
    })
    const envelope = await api.unshadow({ sessionId: 's1', markerSeq: 2, currentSessionId: 'viewer' })
    expect(envelope.ok).toBe(true)
    const result = envelope.value
    expect(spy).toHaveBeenCalledTimes(1)
    expect(result.alreadyRestored).toBe(true)
    expect(result.zeroWrite).toBe(true)
    expect(result.reloadRequired).toBe(false)
  })

  it('宿主未装配 trueRestore ⇒ unshadow-unavailable(动态插件 realm 的真实情形)', async () => {
    const session = makeSimpleSession([
      userMessage('u1', 'q1'),
      { type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: 'retrace-edit-mrk', role: 'user', content: [{ type: 'text', text: 'x' }] } },
    ])
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, {})
    const error = await opError(api.unshadow({ sessionId: 's1', markerSeq: 2 }))
    expect(error.code).toBe('unshadow-unavailable')
  })

  it('取消标记(unhide)没有遮蔽区间 ⇒ marker-not-cancellable;非本插件标记 ⇒ marker-not-found', async () => {
    const session = makeSimpleSession([
      userMessage('u1', 'q1'),
      { type: CARRIER_EVENT_TYPE, surfaceOp: 'append', data: { id: 'retrace-unhide-abc', op: 'unhide', cancels: 0, role: 'user', content: [{ type: 'text', text: 'x' }] } },
      { type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: 'someone-else-marker', role: 'user', content: [{ type: 'text', text: 'x' }] } },
    ])
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, {
      sessionFileFor: async () => '/tmp/s1.zstd',
      trueRestore: async () => ({ ok: true }),
    })
    expect((await opError(api.unshadow({ sessionId: 's1', markerSeq: 2 }))).code).toBe('marker-not-cancellable')
    expect((await opError(api.unshadow({ sessionId: 's1', markerSeq: 3 }))).code).toBe('marker-not-found')
  })

  it('会话文件定位失败 ⇒ session-file-not-found(不猜路径)', async () => {
    const session = makeSimpleSession([
      userMessage('u1', 'q1'),
      { type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: 'retrace-edit-mrk', role: 'user', content: [{ type: 'text', text: 'x' }] } },
    ])
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const api = createEditorApi({}, sessions, agents, () => {}, {
      sessionFileFor: async () => null,
      trueRestore: async () => ({ ok: true }),
    })
    expect((await opError(api.unshadow({ sessionId: 's1', markerSeq: 2 }))).code).toBe('session-file-not-found')
  })
})

/**
 * 真正恢复 · HTTP 通道(POST /api/plugins/retrace/unshadow)。
 *
 * 为什么单列一条:host-core 的一等 op 由 `lib/http.js` 的通用 `api[op]` 分发天然覆盖,
 * 「天然覆盖」是**结论**,不是证据 —— 这里用真 handler 打一发请求,证明路由真的可达、
 * 信封与 harness 通道同形(与 test/op-channel-parity.test.js 的静态判据互补)。
 */
describe('真正恢复 · HTTP 通道(api[op] 通用分发)', () => {
  it('POST /unshadow 打到 host-core 的 unshadow,信封为 {ok:true,value}', async () => {
    const { createRetraceHttpHandler, ROUTE_PREFIX } = await import('../lib/http.js')
    const session = makeSimpleSession([
      userMessage('u1', 'q1'),
      { type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: 'retrace-edit-mrk', role: 'user', content: [{ type: 'text', text: 'x' }] } },
    ])
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const seen = []
    const handler = createRetraceHttpHandler({}, {
      sessions,
      agents,
      seam: makeSeamStub(),
      rollback: {},
      log: () => {},
      hooks: {
        sessionFileFor: async () => '/tmp/s1.zstd',
        trueRestore: async (args) => {
          seen.push(args)
          return { ok: true, alreadyRestored: false, file: args.file, auditSeq: args.auditSeq, surface: { restored: 1, shadowedTotal: 1, stillHidden: [] }, frames: { total: 2, rewritten: [1] } }
        },
      },
    })
    const res = await postJson(handler, `${ROUTE_PREFIX}/unshadow`, { sessionId: 's1', markerSeq: 2, currentSessionId: 'viewer' })
    expect(res.status).toBe(200)
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(true)
    expect(parsed.value.op).toBe(UNSHADOW_OP)
    expect(parsed.value.markerSeq).toBe(2)
    expect(seen).toHaveLength(1)
    expect(seen[0].currentSessionId).toBe('viewer')
  })

  it('失败时信封带可操作 code(HTTP 与 harness 同形,不 500、不吞)', async () => {
    const { createRetraceHttpHandler, ROUTE_PREFIX } = await import('../lib/http.js')
    const session = makeSimpleSession([
      userMessage('u1', 'q1'),
      { type: CARRIER_EVENT_TYPE, surfaceOp: { op: 'replace', start: 0, end: 0 }, sourceEventSeqs: [0], data: { id: 'retrace-edit-mrk', role: 'user', content: [{ type: 'text', text: 'x' }] } },
    ])
    const { sessions, agents } = makeEnv(session, { agent: makeAgent() })
    const handler = createRetraceHttpHandler({}, {
      sessions,
      agents,
      seam: makeSeamStub(),
      rollback: {},
      log: () => {},
      hooks: {
        sessionFileFor: async () => '/tmp/s1.zstd',
        trueRestore: async () => { const error = new Error('请先切走'); error.code = 'session-active'; throw error },
      },
    })
    const res = await postJson(handler, `${ROUTE_PREFIX}/unshadow`, { sessionId: 's1', markerSeq: 2, currentSessionId: 's1' })
    const parsed = JSON.parse(res.body)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('session-active')
    expect(parsed.error.message).toContain('切走')
  })
})

/** seam 打桩(handler 装配需要 setConfig 等;与 test/http.test.js 的 makeSeam 同形)。 */
function makeSeamStub() {
  return {
    setConfig: vi.fn(),
    snapshot: vi.fn(() => ({ enabled: true, versions: [] })),
    readEvent: vi.fn(async () => ({ event: {} })),
    readSurface: vi.fn(async () => ({ nodes: [] })),
    gitStatus: vi.fn(async () => ({ root: '/w', headHash: 'abc', dirty: false, paths: [] })),
    gitInit: vi.fn(async () => ({ ok: true, root: '/w', headHash: 'def' })),
    resolveSnapshot: vi.fn(async () => 'sha1'),
    readSnapshot: vi.fn(async () => new TextEncoder().encode('snapshot text')),
  }
}

/** 极简 POST 打桩(与 test/http.test.js 的 post() 同款时序:先 data 后 end)。 */
function postJson(handler, url, payload) {
  const res = {
    status: 200,
    body: '',
    writeHead(status) { this.status = status },
    end(chunk) { this.body += chunk ?? '' },
    destroy() {},
  }
  let onData = null
  let onEnd = null
  const req = {
    method: 'POST',
    url,
    headers: { 'x-retrace-config': '' },
    setEncoding() {},
    on(event, fn) {
      if (event === 'data') onData = fn
      else if (event === 'end') onEnd = fn
    },
  }
  setTimeout(() => { onData?.(JSON.stringify(payload)); onEnd?.() }, 0)
  return new Promise((resolve, reject) => {
    handler(req, res)
    const started = Date.now()
    const poll = () => {
      if (res.body.length > 0) return resolve(res)
      if (Date.now() - started > 2000) return reject(new Error('POST produced no response'))
      setTimeout(poll, 2)
    }
    poll()
  })
}
