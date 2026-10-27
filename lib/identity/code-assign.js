/**
 * dsh-retrace — lib/identity/code-assign.js
 *
 * 新建会话的**谱系标识自动分配 + 持久化**（单一路径，写侧）。
 *
 * 背景：谱系标识表（codes.json）此前是静态表，新会话没有码，需要人工回填。
 * 本模块在 `session/created` 时给**新会话**按既有分配器
 * （`lib/identity/shortcode.js#allocateCodes`，规则 = 工作区2 + 序号3 + 父工作区2 +
 * 父序号3，根父 FF000）配号，并**原子**写表。四条硬约束：
 *
 *   1. **不改已有码**：表里已有的键一律不动；键已存在 ⇒ 视为"已登记"，直接返回；
 *      算出来的码已被别的会话登记 ⇒ 拒绝（不覆盖别人的码），降级为日志。
 *   2. **写入原子**：同目录临时文件 + `renameSync` 原子替换，不产生半截表；
 *      临时文件失败/成功都清理。
 *   3. **无写权限降级**：读不了/写不了/坏表/非规范码 ⇒ 返回 `degraded` **并记日志**，
 *      绝不抛错崩宿主（谱系标识侧故障不得影响主功能）。
 *   4. **写完回读复验**：分配码必须能再次解析到同一 session id（写入即验证）。
 *
 * 读侧（`createShortcodeResolver`）与本模块共用 `loadUniverse` / `allocateCodes`，
 * 保证"写进去的码"与"读出来的码"同源、同规则、同序号口径。
 *
 * 与谱系标识表**生成器**的关系：**规则一致**
 * （工作区2+序号3+父工作区2+父序号3，父缺失 = FF000），但本模块**不重算整张表**——
 * 生成器的整表重算在基座换代后会成片改指（实测），所以自动分配只做
 * 「钉住已登记码 + 新会话在序号尾部追加」这一条安全路径。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  allocateCodes,
  isCanonicalCode,
  loadTableEntriesSafe,
  loadUniverse,
  normalizeSessionId,
  uuidOf,
} from './shortcode.js'
import { workspaceAbbr } from '../platform/session-paths.js'

/** 自动分配的运行时开关（`0` ⇒ 关；默认开）。 */
export const AUTO_CODE_ENV = 'DSH_RETRACE_AUTO_CODE'

/** 诊断行默认出口：降级必须"说出来"，但不得影响主流程。 */
const defaultLog = (line) => { try { console.error(line) } catch { /* 诊断行自身出错不影响 */ } }

const msgOf = (error) => String(error && error.message ? error.message : error).slice(0, 160)

/**
 * 工作区绝对路径 → 会话目录名编码（去掉首斜杠、路径分隔符换成 `-`、首尾各补 `--`）。
 * 与 `lib/platform/session-paths.js#workspaceAbbr` 的输入口径一致（目录名形态）。
 * @param {string} cwd 工作区绝对路径
 * @returns {string} 空串 = 无法编码
 */
export function encodeWorkspaceDir(cwd) {
  const raw = String(cwd ?? '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
  if (raw === '') return ''
  return `--${raw.replace(/\//g, '-')}--`
}

/**
 * 由会话 header（宿主 `session.header`：version/id/createdAt/cwd/parentSession/isSeeded）
 * 构造分配器需要的会话行。`createdAt` 是毫秒数（与 `scanSessions` 口径一致）。
 * @param {{sessionId?: string, header?: object|null, now?: number}} input
 * @returns {{id:string, uuid:string, createdAt:number, parent:string|null, workspace:string|null, ws:string, isSeeded:boolean|null, path:null}|null}
 */
export function sessionRowFromHeader({ sessionId, header = null, now = Date.now() } = {}) {
  const h = header && typeof header === 'object' ? header : {}
  const id = typeof h.id === 'string' && h.id !== '' ? h.id : String(sessionId ?? '')
  const uuid = uuidOf(id)
  if (!uuid) return null
  const workspace = typeof h.cwd === 'string' && h.cwd !== '' ? encodeWorkspaceDir(h.cwd) : null
  if (!workspace) return null
  const createdAtRaw = Number(h.createdAt)
  const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw >= 0 ? createdAtRaw : now
  return {
    id,
    uuid,
    createdAt,
    parent: typeof h.parentSession === 'string' && h.parentSession !== '' ? h.parentSession : null,
    workspace,
    ws: workspaceAbbr(workspace),
    isSeeded: h.isSeeded ?? null,
    path: null,
  }
}

/**
 * 原子写一条**新登记码**到谱系标识表（CAS 重试）。
 *
 * - 表缺失 ⇒ 新建最小表 `{ version: 1, updated, codes }`；
 * - 表存在 ⇒ 保留既有顶层字段（只追加 `codes` 键、更新 `updated`）与全部既有码；
 * - 键已存在：同码 = 幂等成功；异码 = 拒绝（不改已有码）；
 * - 码已被别的会话登记 = 拒绝（不覆盖别人）；
 * - **跨进程并发**：读整表 → 改 → tmp 写入 → **rename 前再读一次当前文件**，
 *   与本次读到的原文比对；变了（另一实例/生成器在这窗口里写过）⇒ 删 tmp、重试整轮
 *   （最多 3 次），而不是把读到的旧表写回去（旧实现会丢更新/覆盖他人新登记码）。
 *   注：比对到 rename 之间仍有极窄的检查-使用窗口（单机代码级无跨进程锁），
 *   极端并发下仍可丢一次更新；写完的回读复验 + 人工核对是兜底（视为已知边界）。
 * - 失败一律返回 `{ok:false,error}`，不抛错（由调用方降级为日志）。
 *
 * @param {string} tablePath
 * @param {{sessionId:string, code:string, now?:number}} input
 * @returns {{ok:boolean, idempotent?:boolean, error?:string}}
 */
export function persistCode(tablePath, { sessionId, code, now = Date.now() } = {}) {
  try {
    if (!tablePath) return { ok: false, error: 'no-table-path' }
    if (!sessionId) return { ok: false, error: 'no-session-id' }
    if (!isCanonicalCode(code)) return { ok: false, error: `non-canonical-code:${String(code)}` }

    const MAX_ATTEMPTS = 3
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      // ── 读当前表（原文一并记住，供 CAS 比对） ──
      let raw = null
      let table = { version: 1, codes: {} }
      if (existsSync(tablePath)) {
        try { raw = readFileSync(tablePath, 'utf8') } catch (error) { return { ok: false, error: `table-unreadable:${msgOf(error)}` } }
        let parsed
        try { parsed = JSON.parse(raw) } catch (error) { return { ok: false, error: `table-malformed:${msgOf(error)}` } }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, error: 'table-bad-shape' }
        if (parsed.codes === undefined) parsed.codes = {}
        if (parsed.codes === null || typeof parsed.codes !== 'object' || Array.isArray(parsed.codes)) return { ok: false, error: 'table-codes-bad-shape' }
        table = parsed
      }

      // 不改已有码：同码幂等；异码拒绝（绝不覆盖）
      if (Object.prototype.hasOwnProperty.call(table.codes, sessionId)) {
        return table.codes[sessionId] === code ? { ok: true, idempotent: true } : { ok: false, error: 'existing-code-differs' }
      }
      const taken = Object.entries(table.codes).find(([, c]) => String(c) === code)
      if (taken) return { ok: false, error: `code-already-registered:${taken[0]}` }

      table.codes[sessionId] = code
      if (typeof table.version !== 'number') table.version = 1
      table.updated = new Date(now).toISOString()

      mkdirSync(dirname(tablePath), { recursive: true })
      const tmp = `${tablePath}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      try {
        writeFileSync(tmp, JSON.stringify(table, null, 2) + '\n')
        // ── CAS：写 tmp 之后、rename 之前再读一次；原文变了 ⇒ 本轮作废、重试 ──
        let currentRaw = null
        try { currentRaw = readFileSync(tablePath, 'utf8') } catch (error) { currentRaw = error && error.code === 'ENOENT' ? null : undefined }
        if (currentRaw === undefined) return { ok: false, error: 'table-recheck-failed' }
        if (currentRaw !== raw) {
          try { rmSync(tmp, { force: true }) } catch { /* 忽略清理失败 */ }
          if (attempt < MAX_ATTEMPTS - 1) continue
          return { ok: false, error: 'concurrent-update' }
        }
        renameSync(tmp, tablePath)
        return { ok: true }
      } finally {
        try { if (existsSync(tmp)) rmSync(tmp, { force: true }) } catch { /* 临时件清理失败不改变结果 */ }
      }
    }
    return { ok: false, error: 'concurrent-update' }
  } catch (error) {
    return { ok: false, error: `write-failed:${msgOf(error)}` }
  }
}

/**
 * 新建会话时自动配号 + 落表（**同步**：整段无 await ⇒ 同一事件循环里不会被其它分配穿插，
 * 读-改-写不会互相覆盖）。
 *
 * @param {object} input
 * @param {string} input.sessionId              会话 id（`session-<uuid>` 或裸 uuid）
 * @param {object|null} [input.sessionHeader]  宿主 `session.header`（取 id/createdAt/cwd/parentSession）
 * @param {string} input.tablePath             谱系标识表落点
 * @param {string} [input.sessionsRoot]        活动会话基座（默认由 session-paths 解析）
 * @param {Function} [input.readHeader]        会话 header 读取器（默认 shortcode.defaultReadHeader）
 * @param {Function} [input.log]               降级日志出口（默认 console.error；生产注入宿主 logger）
 * @param {number} [input.now]                 时间源（测试注入）
 * @param {object} [input.env]                 环境（测试注入；读 DSH_RETRACE_AUTO_CODE）
 * @returns {{status:'allocated'|'existing'|'degraded'|'skipped', code?:string, note?:string|null, verified?:boolean, error?:string, reason?:string, tablePath?:string}}
 */
export function assignCodeOnCreate({
  sessionId,
  sessionHeader = null,
  tablePath,
  sessionsRoot,
  readHeader,
  log = defaultLog,
  now = Date.now(),
  env = process.env,
} = {}) {
  const say = (line) => { try { log(`retrace: 新会话自动配号 → ${line}`) } catch { /* 日志出口自身出错不影响 */ } }
  try {
    if (env && env[AUTO_CODE_ENV] === '0') return { status: 'skipped', reason: 'disabled-by-env' }
    if (!tablePath) { say('降级：未解析到谱系标识表落点（不影响主功能）'); return { status: 'degraded', error: 'no-table-path' } }
    const uuid = uuidOf(sessionId) || uuidOf(sessionHeader && sessionHeader.id)
    if (!uuid) return { status: 'skipped', reason: 'unparsable-session-id' }

    // 宇宙 = 活动基座（只读扫一次）+ 已登记表；读基线不可用/坏表 ⇒ 降级（不盲写）
    const uni = loadUniverse({ root: sessionsRoot, tablePath, readHeader, parentEdges: new Map() })
    if (uni.tableError) { say(`降级：谱系标识表有问题（${uni.tableError}），不写`); return { status: 'degraded', error: `table-error:${uni.tableError}` } }
    const existing = uni.pinned.find((e) => normalizeSessionId(e.sessionId)?.uuid === uuid)
    if (existing) return { status: 'existing', code: existing.code }

    const baseRow = uni.sessions.find((s) => s.uuid === uuid) ?? null
    // 优先用宿主 header（会话文件可能尚未落盘）；cwd 拿不到时退回基座扫描行
    const headerRow = sessionRowFromHeader({ sessionId, header: sessionHeader, now })
    const row = headerRow ?? baseRow
    if (!row || !row.ws) { say(`降级：拿不到新会话的工作区/序号输入（${sessionId}），不写`); return { status: 'degraded', error: 'workspace-unknown' } }
    const mergedRow = { ...row, path: baseRow?.path ?? row.path ?? null }

    const sessions = [...uni.sessions.filter((s) => s.uuid !== uuid), mergedRow]
    const { assignments, pinnedConflicts } = allocateCodes({ sessions, pinned: uni.pinned })
    if (pinnedConflicts.length) say(`注意：表内已有登记码冲突 ${pinnedConflicts.length} 处（只报警，不改既有码）`)
    const a = assignments.get(uuid)
    if (!a) { say(`降级：分配器没有给出号（${sessionId}），不写`); return { status: 'degraded', error: 'no-assignment' } }
    if (a.kind === 'pinned') return { status: 'existing', code: a.code }
    if (a.kind === 'COLLISION-REFUSED') { say(`降级：算出的码与已登记码相撞（${a.note ?? 'unknown'}），拒绝覆盖`); return { status: 'degraded', error: `collision:${a.note ?? 'unknown'}` } }

    const written = persistCode(tablePath, { sessionId: mergedRow.id, code: a.code, now })
    if (!written.ok) { say(`降级：写表失败（${written.error}），本会话先用内存码 ${a.code}，不影响主功能`); return { status: 'degraded', error: written.error, code: a.code } }
    if (written.idempotent) return { status: 'existing', code: a.code }

    // 回读复验：分配码必须能再次解析到同一 session id（写进去 ≠ 读得出 = 失败）
    const verify = loadTableEntriesSafe(tablePath)
    const verified = !verify.error && verify.entries.some((e) => normalizeSessionId(e.sessionId)?.uuid === uuid && e.code === a.code)
    if (!verified) { say(`降级：写入后回读复验失败（${verify.error ?? 'code/session 不匹配'}），需要人工核对 ${tablePath}`); return { status: 'allocated', code: a.code, note: a.note ?? null, verified: false, error: verify.error ?? 'verify-mismatch', tablePath } }
    say(`已分配 ${a.code}（${mergedRow.id}${a.note ? `，${a.note}` : ''}）并原子落表 ${tablePath}`)
    return { status: 'allocated', code: a.code, note: a.note ?? null, verified: true, tablePath }
  } catch (error) {
    say(`降级：${msgOf(error)}（不影响主功能）`)
    return { status: 'degraded', error: msgOf(error) }
  }
}
