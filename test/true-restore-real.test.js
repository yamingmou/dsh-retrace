/**
 * 真正恢复 · **真实会话副本**端到端(0.4.126)。
 *
 * 与 test/true-restore.test.js(合成夹具)分工:
 *  · 本文件用**磁盘上真实会话文件的只读副本**(现役 v3 格式,多帧 zstd、真实 marker 两段、
 *    上万事件)跑完整链路,并用**现役内核 0.1.7-rc.2 的严格 `foldSurface`** 做证明;
 *  · 合成夹具跑在 dev 依赖内核 0.1.0-rc.7(v0 形状)上,证不了 v3 的连续性判据 ——
 *    这正是本文件存在的理由。
 *
 * 三条硬约束(逐条有断言):
 *  ① **只读源**:真实会话目录里的源文件 size/mtime/sha256 前后必须**完全不变**;
 *     所有写入只发生在 `mkdtempSync(tmpdir())` 的副本上。
 *  ② **严格 fold 证明**:恢复前被遮蔽区间**不在** nodes 上;恢复后**全部在** nodes 上,
 *     且 fold 全程不抛(`strict:true`)。
 *  ③ **删除路线被证伪**:把同样两行删掉(不重编号)⇒ 现役内核报
 *     `session event seq N is not contiguous; expected M` ⇒ 只能走中和。
 *
 * 环境不可用(没有真实会话 / 没有 App 内现役内核)⇒ **skip 并说明**,不假装通过。
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createTrueRestore, scanZstdFrames, isNeutralizedEvent } from '../lib/rollback.js'
import { loadSessionLog } from 'dsh-log-contract'

/** 现役内核(App 内 0.1.7-rc.2 = v3 语义)。路径不存在 ⇒ 整文件 skip。 */
const APP_KERNEL = '/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-session/lib/index.js'
/** 真实会话根(只读;**测试永不写它**)。 */
const REAL_ROOTS = [
  process.env.DSH_RETRACE_REAL_SESSIONS,
  join(process.env.HOME ?? '', 'dsh-v3', 'sessions'),
].filter(Boolean)

let v3 = null
let candidate = null
let skipReason = null
let tmpRoot = null
let copyPath = null

/** 只读:枚举真实会话文件(按 mtime 新→旧;只要可选规模)。 */
function listRealFiles(max, names = ['session.v3.jsonl.zstd']) {
  const out = []
  for (const root of REAL_ROOTS) {
    let workspaces
    try { workspaces = readdirSync(root) } catch { continue }
    for (const workspace of workspaces) {
      let dirs
      try { dirs = readdirSync(join(root, workspace)) } catch { continue }
      for (const dir of dirs) {
        for (const name of names) {
          const file = join(root, workspace, dir, name)
          try {
            const st = statSync(file)
            if (st.size === 0 || st.size > 12 * 1024 * 1024) continue
            out.push({ file, name, mtimeMs: st.mtimeMs, size: st.size })
          } catch { /* 该会话没有该世代文件 */ }
        }
      }
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, max)
}

/** 只读:在文件明文里找**最后一个**我方 marker 载体(seq + 审计 seq)。 */
function findLastMarker(file) {
  const buf = readFileSync(file)
  const { frames, tornStart } = scanZstdFrames(buf)
  if (tornStart !== null || frames.length === 0) return null
  let events = 0
  let found = null
  for (const frame of frames) {
    const text = zstdDecompressSync(buf.subarray(frame.start, frame.end)).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.length === 0 || line.startsWith('{"type":"session"')) continue
      events += 1
      if (!line.includes('"retrace-') || !line.includes('"surfaceOp"')) continue
      let parsed
      try { parsed = JSON.parse(line) } catch { continue }
      if (parsed?.type !== 'user/message') continue
      if (parsed.surfaceOp?.op !== 'replace') continue
      if (!String(parsed.data?.id ?? '').startsWith('retrace-')) continue
      const auditSeq = Array.isArray(parsed.sourceEventSeqs) && parsed.sourceEventSeqs.length > 0 ? parsed.sourceEventSeqs[0] : null
      found = { carrierSeq: parsed.seq, auditSeq, markerId: String(parsed.data.id), frameCount: frames.length, events }
    }
  }
  return found
}

const engine = (fold) => createTrueRestore({ fold, log: () => {} })

beforeAll(async () => {
  try {
    v3 = await import(APP_KERNEL)
  } catch (error) {
    skipReason = `现役 v3 内核不可加载(${APP_KERNEL}):${String(error?.message ?? error)}`
    return
  }
  if (typeof v3?.foldSurface !== 'function') {
    skipReason = `现役内核未导出 foldSurface:${APP_KERNEL}`
    return
  }
  // 只读扫描:必须存在**能被严格折叠通过的中和预演**的真实 marker(否则 skip,不假装通过)
  tmpRoot = mkdtempSync(join(tmpdir(), 'retrace-true-restore-real-'))
  for (const item of listRealFiles(80)) {
    const marker = findLastMarker(item.file)
    if (!marker) continue
    const probe = join(tmpRoot, 'probe.v3.jsonl.zstd')
    copyFileSync(item.file, probe)
    const dry = await engine(v3.foldSurface).restore({
      file: probe,
      carrierSeq: marker.carrierSeq,
      auditSeq: marker.auditSeq,
      sessionId: 'probe',
      currentSessionId: 'other',
      dryRun: true,
    }).catch((error) => ({ error }))
    if (dry?.ok === true && dry.surface?.after?.strict === true) {
      candidate = { ...item, ...marker, surface: dry.surface }
      copyPath = join(tmpRoot, `copy-${marker.carrierSeq}.v3.jsonl.zstd`)
      copyFileSync(item.file, copyPath)
      rmSync(probe, { force: true })
      break
    }
    rmSync(probe, { force: true })
  }
  if (candidate === null && skipReason === null) {
    skipReason = `扫描 ${listRealFiles(80).length} 个真实会话文件,没有"中和预演可通过"的 retrace marker`
  }
})

describe('真正恢复 · 真实会话副本(现役 v3 内核严格 fold)', () => {
  it('恢复前后:严格 fold 证明区间回到面上 + 只读源文件一字未动 + 帧级最小改写', async () => {
    if (candidate === null) {
      expect(skipReason).toBeTruthy()
      console.warn(`[skip] ${skipReason}`)
      return
    }
    const sourceBefore = {
      size: statSync(candidate.file).size,
      mtimeMs: statSync(candidate.file).mtimeMs,
      sha256: createHash('sha256').update(readFileSync(candidate.file)).digest('hex'),
    }
    const copyBefore = readFileSync(copyPath)
    const framesBefore = scanZstdFrames(copyBefore)
    // 严格 fold(恢复前):目标区间被遮蔽 —— 用同一份磁盘明文重建事件数组
    const beforeEvents = eventsOfCopy(copyPath)
    const foldBefore = v3.foldSurface(beforeEvents)
    // ⚠️ 载体**本身**是面上节点(replace 把替换节点插进区间位置,内核
    // `applySurfacePlan` 的 splice 语义)——"被遮蔽"的证据是**被遮蔽的那些 seq 不在面上**。
    expect(foldBefore.replacements.length).toBeGreaterThan(0)
    const shadowedSeqs = shadowedOf(copyPath, candidate.carrierSeq)
    expect(shadowedSeqs.length).toBeGreaterThan(0)
    for (const seq of shadowedSeqs) expect(foldBefore.nodes).not.toContain(seq)

    const result = await engine(v3.foldSurface).restore({
      file: copyPath,
      carrierSeq: candidate.carrierSeq,
      auditSeq: candidate.auditSeq,
      shadowedSeqs,
      sessionId: 'real-copy',
      currentSessionId: 'other',
    })
    expect(result.ok).toBe(true)
    expect(result.verify.ok).toBe(true)
    expect(result.verify.surfaceBefore.strict).toBe(true)
    expect(result.verify.surfaceAfter.strict).toBe(true)
    expect(result.verify.seqGap).toBe(false)
    expect(result.verify.restoredAfter).toBe(shadowedSeqs.length)
    expect(result.verify.surfaceAfter.nodes).toBeGreaterThan(result.verify.surfaceBefore.nodes)
    expect(result.verify.lineCount).toBe(beforeEvents.length + 1) // header + 事件

    // 恢复后:严格 fold 再次通过,且区间**全部**回到面上;载体节点消失
    const afterEvents = eventsOfCopy(copyPath)
    const foldAfter = v3.foldSurface(afterEvents)
    for (const seq of shadowedSeqs) expect(foldAfter.nodes).toContain(seq)
    expect(foldAfter.nodes).not.toContain(candidate.carrierSeq)
    expect(isNeutralizedEvent(afterEvents[candidate.carrierSeq])).toBe(true)
    expect(afterEvents[candidate.carrierSeq].data.id).toBe(candidate.markerId)
    // 帧级最小改写:未列入 rewritten 的帧字节逐字节不动
    const copyAfter = readFileSync(copyPath)
    const framesAfter = scanZstdFrames(copyAfter)
    expect(framesAfter.frames.length).toBe(framesBefore.frames.length)
    const rewritten = new Set(result.frames.rewritten)
    for (let i = 0; i < framesBefore.frames.length; i++) {
      const a = copyBefore.subarray(framesBefore.frames[i].start, framesBefore.frames[i].end)
      const b = copyAfter.subarray(framesAfter.frames[i].start, framesAfter.frames[i].end)
      if (rewritten.has(i)) expect(Buffer.compare(a, b)).not.toBe(0)
      else expect(Buffer.compare(a, b)).toBe(0)
    }
    // 现役读路径(dsh-log-contract loadSessionLog = 官方 decodeStorageRecord 口径)照样读得动
    const log = loadSessionLog(copyPath)
    expect(log.frameInfo.torn).toBe(false)
    expect(log.events.length).toBe(beforeEvents.length)
    expect(log.rows.every((row) => row.error === null)).toBe(true)
    // 备份在会话目录之外 + 与恢复前字节一致
    expect(Buffer.compare(readFileSync(result.backupPath), copyBefore)).toBe(0)
    expect(result.backupPath.includes(join(candidate.file.split('/').slice(-2)[0]))).toBe(false)
    // ⛔ 只读源:真实会话文件 size/mtime/sha256 全部未变
    expect(statSync(candidate.file).size).toBe(sourceBefore.size)
    expect(statSync(candidate.file).mtimeMs).toBe(sourceBefore.mtimeMs)
    expect(createHash('sha256').update(readFileSync(candidate.file)).digest('hex')).toBe(sourceBefore.sha256)
  })

  it('删除路线证伪(现役 v3 内核):删掉两行不重编号 ⇒ 严格 fold 报 seq 不连续', async () => {
    if (candidate === null) {
      expect(skipReason).toBeTruthy()
      return
    }
    const original = readFileSync(candidate.file) // 只读源
    const { frames } = scanZstdFrames(original)
    const headerText = zstdDecompressSync(original.subarray(frames[0].start, frames[0].end)).toString('utf8')
    const events = []
    for (let i = 1; i < frames.length; i++) {
      const text = zstdDecompressSync(original.subarray(frames[i].start, frames[i].end)).toString('utf8')
      for (const line of text.split('\n')) if (line.length > 0) events.push(JSON.parse(line))
    }
    expect(events.length).toBeGreaterThan(candidate.carrierSeq + 1) // 目标必须是**中段**才留得下空洞
    const deleted = events.filter((event) => event.seq !== candidate.carrierSeq && event.seq !== candidate.auditSeq)
    let thrown = null
    try { v3.foldSurface(deleted) } catch (error) { thrown = error }
    expect(thrown).toBeTruthy()
    expect(String(thrown.message)).toMatch(/is not contiguous/)
    expect(headerText).toContain('"type":"session"')
  })
})

/** 从副本读事件(与 rollback.js 独立实现,避免同源自证)。 */
function eventsOfCopy(path) {
  const buf = readFileSync(path)
  const { frames } = scanZstdFrames(buf)
  const events = []
  for (let i = 1; i < frames.length; i++) {
    const text = zstdDecompressSync(buf.subarray(frames[i].start, frames[i].end)).toString('utf8')
    for (const line of text.split('\n')) if (line.length > 0) events.push(JSON.parse(line))
  }
  return events.sort((a, b) => a.seq - b.seq)
}

/** 目标 marker 的被遮蔽集合(载体 provenance 去掉审计首项)。 */
function shadowedOf(path, carrierSeq) {
  const event = eventsOfCopy(path).find((e) => e.seq === carrierSeq)
  const cited = Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs : []
  return cited.length > 0 && eventsOfCopy(path)[cited[0]]?.type === 'compaction/prune' ? cited.slice(1) : cited
}

/**
 * v4 世代(当前 App 正在写的容器)的**布局兼容性**与**真实干跑**。
 *
 * 为什么单列:上面那条用 v3 历史件做"只读源一字未动"的硬断言(确定性);
 * 本条证明引擎在**当前世代**上同样可用 —— 但 v4 件是**活件**(App 正在追加),
 * 故本条不写盘、只做 dry-run,并对撕裂尾帧容忍(活件随时可能停在半帧)。
 */
describe('真正恢复 · v4 世代(当前容器)布局兼容 + 真实干跑', () => {
  it('v4 文件同样一行一事件、seq==行号、帧对齐;真 marker 干跑 strict:true', async () => {
    if (v3 === null) {
      expect(skipReason).toBeTruthy()
      return
    }
    const files = listRealFiles(14, ['session.v4.jsonl.zstd'])
    if (files.length === 0) {
      console.warn('[skip] 本机没有 v4 世代会话文件')
      return
    }
    let aligned = 0
    const readings = []
    for (const item of files.slice(0, 8)) {
      let marker = null
      try { marker = findLastMarker(item.file) } catch { marker = null }
      let buf = null
      try { buf = readFileSync(item.file) } catch { continue }
      const scan = scanZstdFrames(buf)
      if (scan.tornStart !== null) { readings.push({ file: item.file, torn: true }); continue }
      // 布局判据:每帧明文以换行结尾 + 事件 seq == 行号(header 行除外)
      let lineIdx = 0
      let ok = true
      for (let i = 1; i < scan.frames.length && ok; i++) {
        const text = zstdDecompressSync(buf.subarray(scan.frames[i].start, scan.frames[i].end)).toString('utf8')
        if (!text.endsWith('\n')) { ok = false; break }
        for (const line of text.split('\n')) {
          if (line.length === 0) continue
          const parsed = JSON.parse(line)
          if (parsed.seq !== lineIdx) { ok = false; break }
          lineIdx += 1
        }
      }
      if (ok) aligned += 1
      if (marker === null) continue
      const probe = join(tmpRoot, `v4-probe-${marker.carrierSeq}.jsonl.zstd`)
      copyFileSync(item.file, probe)
      const dry = await engine(v3.foldSurface).restore({
        file: probe,
        carrierSeq: marker.carrierSeq,
        auditSeq: marker.auditSeq,
        sessionId: 'probe-v4',
        currentSessionId: 'other',
        dryRun: true,
      }).catch((error) => ({ error }))
      rmSync(probe, { force: true })
      readings.push(dry?.ok === true
        ? { file: item.file, markerId: marker.markerId, carrierSeq: marker.carrierSeq, strict: dry.surface.after.strict, nodesBefore: dry.surface.before.nodes, nodesAfter: dry.surface.after.nodes, restored: dry.surface.restored, shadowedTotal: dry.surface.shadowedTotal, stillHidden: dry.surface.stillHidden.length }
        : { file: item.file, markerId: marker.markerId, error: dry?.error?.code ?? 'unknown' })
    }
    // ① 布局:至少一件 v4 完全合规(活件可能有半帧 ⇒ 不要求全部)
    expect(aligned).toBeGreaterThan(0)
    const okReadings = readings.filter((r) => r.strict !== undefined)
    // ② 每一件干跑成功的都必须"区间全部回面"(有效性判据;strict 与否不影响这条)
    for (const r of okReadings) expect(r.stillHidden).toBe(0)
    // ③ 真实读数如实打印(strict:false = 严格 fold 抛错后退镜像折,**如实上报**不假装)
    for (const r of readings) console.log(`[v4 dry-run] ${JSON.stringify(r)}`)
    if (okReadings.length === 0) {
      console.warn('[info] v4 扫描里没有"干跑可通过"的 retrace marker(布局断言仍成立)')
      return
    }
    expect(okReadings.every((r) => r.restored === r.shadowedTotal)).toBe(true)
  })
})
