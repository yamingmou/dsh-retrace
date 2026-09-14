/**
 * dsh-retrace — lib/identity/shortcode.js
 *
 * 短码侧（人机协作层）的唯一权威实现。要求：身份确认 R1–R10。
 *
 * 地基（两个识别符的分工，不得混）：
 *   session id  = 官方原生 `header.id`（权威身份，内部流通确认）；
 *   短码        = 本模块产出（辅助标识，人机交互与协作）。
 *   ⇒ 内部流通以 session id 为准；人机协作以短码为准；**短码必须可解析到 session id**。
 *
 * 本模块的三条硬约束（违反即视为 bug）：
 *   1. **只读**：不写会话文件、不改 `id`/`createdAt`/`parentSession`/`isSeeded`。
 *   2. **身份判定永不读短码**：`sameSession()` 只比较规范化 session id。
 *   3. **身份与可用性分栏**：`identity` 与 `availability` 是两个并列字段，永不合并。
 *
 * 短码规则（构成 / 长度 / 字符集）：
 *   规范形  canonical = /^[a-z]{2}[0-9]{3}(?:[a-z]{2}[0-9]{3}|FF[0-9]{3})$/
 *           构成 = 工作区2 + 本会话序号3 + 父工作区2 + 父序号3；根会话父位 = FF000。
 *   长度    固定 10 字符。
 *   字符集  小写字母 + 数字；根标记 `FF` 为**唯一**大写例外。
 *   查询    大小写不敏感（`FF`/`ff` 折叠）；但折叠若产生歧义必须检出。
 *   兜底    FNV-1a64(uuid) → base36 → 10 位（既有兜底，保留为最后一级）。
 *
 * 落点（会话基座 / 短码表 / 工作区缩写）**全部**取自
 * `lib/platform/session-paths.js` 单一实现——本模块不硬编码任何本机路径或用户名。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, appendFileSync, statSync } from 'node:fs'
import {
  listSessionFiles,
  activeSessionsRoot,
  resolveBadgeTablePath,
  resolveIdentityMapPath,
  workspaceAbbr,
} from '../platform/session-paths.js'

// ─────────────────────────────────────────────────────────────────────────────
// 1. session id 规范化（id 是权威；规范化只是**连接键**，不修改原值）
// ─────────────────────────────────────────────────────────────────────────────

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const SESSION_PREFIX_RE = /^session-/

/**
 * 取 id 的 uuid 段（小写、无连字符）= 跨层连接键。
 * 兼容两种承载形态：`session-<uuid>` 与裸 `<uuid>`（实测两种在会话目录里并存）。
 * @param {string} id
 * @returns {string} 32 位小写 hex；无法提取返回 ''
 */
export function uuidOf(id) {
  const m = String(id ?? '').match(UUID_RE)
  if (m) return m[0].replace(/-/g, '').toLowerCase()
  const cleaned = String(id ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase()
  return cleaned.length >= 32 ? cleaned.slice(0, 32) : ''
}

/**
 * 规范化 session id：**只用于比较/连接**，绝不回写。
 * @param {string} id
 * @returns {{uuid: string, verbatim: string, prefixed: boolean}|null}
 */
export function normalizeSessionId(id) {
  const verbatim = String(id ?? '').trim()
  const uuid = uuidOf(verbatim)
  if (!uuid) return null
  return { uuid, verbatim, prefixed: SESSION_PREFIX_RE.test(verbatim) }
}

/**
 * 唯一身份判据：是否同一会话。
 * 只比较规范化 uuid；**不看短码、不看标题、不看文件路径、不看可用性**。
 * @param {string} a
 * @param {string} b
 * @returns {{same: boolean, a: object|null, b: object|null, reason: string}}
 */
export function sameSession(a, b) {
  const na = normalizeSessionId(a)
  const nb = normalizeSessionId(b)
  if (!na || !nb) {
    return { same: false, a: na, b: nb, reason: na || nb ? 'one-side-id-unparsable' : 'both-sides-id-unparsable' }
  }
  return { same: na.uuid === nb.uuid, a: na, b: nb, reason: na.uuid === nb.uuid ? 'same-uuid' : 'different-uuid' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 短码规则（长度/字符集/构成）
// ─────────────────────────────────────────────────────────────────────────────

/** 规范短码：工作区2 + 序号3 + (父工作区2+父序号3 | FF000)。固定 10 位。 */
export const CANONICAL_CODE_RE = /^[a-z]{2}[0-9]{3}(?:[a-z]{2}[0-9]{3}|FF[0-9]{3})$/
/** 根父标记（唯一大写例外）。 */
export const ROOT_PARENT = 'FF000'
export const CODE_LENGTH = 10

/** 是否规范语义短码（可被人不歧义引用）。 */
export function isCanonicalCode(code) {
  return CANONICAL_CODE_RE.test(String(code ?? ''))
}

/**
 * 短码折叠（查询用，大小写不敏感）。
 * 折叠会把 `FF` 变成 `ff`；若真实存在 `ff` 工作区，折叠即产生歧义 → 必须检出。
 */
export function foldCode(code) {
  return String(code ?? '').trim().toLowerCase()
}

/** 由 (本会话 ws,seq) + (父 ws,seq|null) 组码。 */
export function composeCode(selfWs, selfSeq, parentWs, parentSeq) {
  const pad = (n) => String(n).padStart(3, '0')
  const self = `${selfWs}${pad(selfSeq)}`
  if (parentWs == null || parentSeq == null) return `${self}${ROOT_PARENT}`
  return `${self}${parentWs}${pad(parentSeq)}`
}

/** 从规范短码取出 (工作区, 序号)。 */
export function extractWsSeq(code) {
  const c = String(code ?? '')
  if (!isCanonicalCode(c)) return null
  return { ws: c.slice(0, 2), seq: Number(c.slice(2, 5)) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. FNV 兜底短码（最后一级；与语义短码**空间不同**但形状可能偶然相撞）
// ─────────────────────────────────────────────────────────────────────────────

function fnv1a64(text) {
  let hash = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i))
    hash = (hash * prime) & mask
  }
  return hash
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'

function toBase36(value) {
  if (value < 0n) value = -value
  if (value === 0n) return '0'
  let out = ''
  let v = value
  while (v > 0n) { out = BASE36[Number(v % 36n)] + out; v /= 36n }
  return out
}

/** FNV-1a64(uuid) → base36 → 固定 10 位。 */
export function fnvBadge(sessionId) {
  const uuid = uuidOf(sessionId)
  if (!uuid) return ''
  return toBase36(fnv1a64(uuid)).padStart(10, '0').slice(0, 10)
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 会话扫描（**只读**；落点走 platform/session-paths.js 单一实现）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 默认 header 读取器：明文直接 parse；zstd 交给系统 `zstdcat`。
 * 运行时（宿主）应注入 `dsh-log-contract` 的 `readSessionHeader`（进程内解码、
 * 无需外部二进制），本默认值服务于独立 CLI / 无依赖场景。
 * @param {string} file
 * @returns {object|null}
 */
export function defaultReadHeader(file) {
  try {
    const head = readFileSync(file)
    if (head.length < 4 || head.readUInt32LE(0) !== 0xfd2fb528) {
      const line = head.toString('utf8').split('\n').find((l) => l.trim().length > 0)
      return line ? JSON.parse(line) : null
    }
    const out = execFileSync('zstdcat', [file], { maxBuffer: 1 << 28 }).toString('utf8')
    const line = out.split('\n').find((l) => l.trim().length > 0)
    return line ? JSON.parse(line) : null
  } catch {
    return null
  }
}

/**
 * 读身份映射（会话 id 迁移表）的**父边** → Map<uuid, {parentUuid, parentRaw, klass, origin}>。
 *
 * 为什么需要它：基座换代把少数会话的 `header.parentSession` 丢了（实测 3 个）。
 * 短码的**父段**也吃父边，父缺失就回退 `FF000` —— 这些会话的短码会因此与已登记码
 * 错位（实测这 3 个恰好都带已登记码）。
 *
 * 因此父边有**两个来源**，按可信度排序取用：
 *   ① `header.parentSession`（会话文件自身的事实，权威）；
 *   ② 身份映射的 `pairs[].parentNewId`（**覆盖层**，只在 ① 缺失时补位）。
 * 本模块只读，不写回任何会话文件，也不改写 header（改了会破坏官方 list/resume）。
 *
 * 归一化陷阱：`newId` 与 `parentNewId` 的前缀形态是**混的**（部分带 `session-`，
 * 部分裸 uuid），一律经 `uuidOf()` 归一再 join —— 直接用原串查表会假报未命中。
 *
 * @param {string} [path]
 * @returns {Map<string, {parentUuid:string,parentRaw:string,klass:string|null,origin:string|null}>}
 */
export function loadIdentityMapEdges(path = resolveIdentityMapPath()) {
  const edges = new Map()
  if (!existsSync(path)) return edges
  let pairs
  try { pairs = JSON.parse(readFileSync(path, 'utf8')).pairs ?? [] } catch { return edges }
  for (const p of pairs) {
    const self = uuidOf(p?.newId)
    if (!self) continue
    const parent = uuidOf(p?.parentNewId)
    if (!parent || parent === self) continue
    if (!edges.has(self)) {
      edges.set(self, {
        parentUuid: parent,
        parentRaw: String(p.parentNewId),
        klass: p.class ?? null,
        origin: p.origin ?? null,
      })
    }
  }
  return edges
}

/**
 * 扫描**一个** sessions 根下全部会话 header。**只读**，不写任何文件。
 *
 * 只扫一个根（活动基座）：两套会话表混扫会把序号算错（见 session-paths 的口径）。
 * @param {string} root
 * @param {{readHeader?: Function, parentEdges?: Map}} [opts]
 * @returns {{rows: Array, errors: Array}}
 */
export function scanSessions(root, opts = {}) {
  const read = opts.readHeader ?? defaultReadHeader
  const parentEdges = opts.parentEdges ?? null
  const rows = []
  const errors = []
  if (!existsSync(root)) return { rows, errors: [{ root, error: 'root-missing' }] }
  for (const { workspace, id, file } of listSessionFiles(root)) {
    const header = read(file)
    if (!header || typeof header.id !== 'string') { errors.push({ file, error: 'header-unreadable' }); continue }
    const headerParent = typeof header.parentSession === 'string' ? header.parentSession : null
    // 父边：header 优先；缺失时用身份映射（覆盖层）补位，并如实标注来源
    const edge = !headerParent && parentEdges ? parentEdges.get(uuidOf(header.id)) : null
    rows.push({
      id: header.id,                 // 权威身份：verbatim header.id（不改）
      uuid: uuidOf(header.id),
      createdAt: header.createdAt,
      parent: headerParent ?? edge?.parentRaw ?? null,
      parentSource: headerParent ? 'header' : (edge ? 'identity-map' : null),
      isSeeded: header.isSeeded ?? null,
      workspace,
      ws: workspaceAbbr(workspace),
      path: file,
      dirId: id,
      root,
    })
  }
  return { rows, errors }
}

/**
 * 按「工作区 + createdAt 序号 + 父链」**从零推导**语义短码。
 *
 * ⚠️ 推导结果取决于**当前会话集合**：基座换代导致集合变化时，序号会整体平移。
 * 因此它只用于「给未登记会话配号」的输入，**不得**用来覆盖已登记（pinned）的码
 * —— 覆盖会静默改指到别的会话。见 `allocateCodes`。
 */
export function deriveCodes(rows) {
  const byWs = {}
  for (const r of rows) (byWs[r.ws] ??= []).push(r)
  const seqOf = new Map()
  for (const ws of Object.keys(byWs)) {
    byWs[ws].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    byWs[ws].forEach((r, i) => seqOf.set(r.uuid, { ws, seq: i + 1 }))
  }
  const codes = {}
  for (const r of rows) {
    const self = seqOf.get(r.uuid)
    if (!self) continue
    const parent = r.parent ? seqOf.get(uuidOf(r.parent)) : null
    codes[r.uuid] = composeCode(self.ws, self.seq, parent?.ws ?? null, parent?.seq ?? null)
  }
  return codes
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. 索引与冲突检出（一码一指 / 可解析 / 撞码检出）——**只报不覆盖**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 由多个来源建索引。来源只用于**溯源展示**，绝不用于改写身份或覆盖冲突。
 * @param {{entries: Array<{code:string, sessionId:string, source:string, rank?:number}>, sessions: Array}} input
 */
export function buildIndex({ entries, sessions }) {
  const byUuid = new Map()          // uuid → 会话行（权威身份锚）
  for (const s of sessions ?? []) {
    const n = normalizeSessionId(s.id)
    if (!n) continue
    if (!byUuid.has(n.uuid)) byUuid.set(n.uuid, s)
  }

  const codeToUuid = new Map()      // 折叠码 → Map<uuid, sources[]>
  const uuidToCodes = new Map()     // uuid → Map<折叠码, sources[]>
  const collisions = []             // 一码多指（严重）
  const orphanCodes = []            // 码指向的会话不在扫描集
  const unparsable = []

  for (const e of entries ?? []) {
    const n = normalizeSessionId(e.sessionId)
    if (!n) { unparsable.push(e); continue }
    if (!isCanonicalCode(e.code) && !/^[0-9a-z]{10}$/.test(String(e.code))) {
      unparsable.push(e); continue
    }
    const key = foldCode(e.code)
    if (!codeToUuid.has(key)) codeToUuid.set(key, new Map())
    const claimers = codeToUuid.get(key)
    if (!claimers.has(n.uuid)) claimers.set(n.uuid, [])
    claimers.get(n.uuid).push({ code: e.code, source: e.source, rank: e.rank ?? 0 })

    if (!uuidToCodes.has(n.uuid)) uuidToCodes.set(n.uuid, new Map())
    const codes = uuidToCodes.get(n.uuid)
    if (!codes.has(key)) codes.set(key, [])
    codes.get(key).push({ code: e.code, source: e.source })

    if (!byUuid.has(n.uuid)) orphanCodes.push({ code: e.code, sessionId: e.sessionId, source: e.source })
  }

  for (const [key, claimers] of codeToUuid) {
    if (claimers.size > 1) {
      collisions.push({
        code: key,
        claimants: [...claimers.entries()].map(([uuid, srcs]) => ({
          uuid, sessionId: byUuid.get(uuid)?.id ?? null, sources: srcs.map((s) => s.source),
        })),
        resolution: 'REFUSED_AMBIGUOUS',   // 不静默覆盖：交给调用方显式消解
      })
    }
  }

  // 一会话多码（同一时刻应当一码一指）
  const divergence = []
  for (const [uuid, codes] of uuidToCodes) {
    if (codes.size > 1) {
      divergence.push({
        uuid,
        sessionId: byUuid.get(uuid)?.id ?? null,
        codes: [...codes.entries()].map(([key, srcs]) => ({ code: key, sources: srcs.map((s) => s.source) })),
      })
    }
  }

  return { byUuid, codeToUuid, uuidToCodes, collisions, divergence, orphanCodes, unparsable }
}

/**
 * 短码 → 唯一 session id。**不可判必须显式输出**，不默认通过。
 * @returns {{status:'unique'|'ambiguous'|'unknown', sessionId:string|null, candidates:Array, reason:string}}
 */
export function resolveCode(index, code) {
  const key = foldCode(code)
  if (!isCanonicalCode(String(code).trim()) && !/^[0-9a-z]{10}$/.test(key)) {
    return { status: 'unknown', sessionId: null, candidates: [], reason: 'malformed-code' }
  }
  const claimers = index.codeToUuid.get(key)
  if (!claimers || claimers.size === 0) {
    return { status: 'unknown', sessionId: null, candidates: [], reason: 'code-not-in-index' }
  }
  if (claimers.size > 1) {
    return {
      status: 'ambiguous', sessionId: null,
      candidates: [...claimers.keys()].map((uuid) => ({ uuid, sessionId: index.byUuid.get(uuid)?.id ?? null })),
      reason: 'code-maps-to-multiple-sessions',
    }
  }
  const uuid = [...claimers.keys()][0]
  // 权威身份 = verbatim header.id（若该会话在扫描集中）；否则回落到登记值
  const sessionId = index.byUuid.get(uuid)?.id ?? uuid
  return { status: 'unique', sessionId, uuid, candidates: [], reason: 'single-claimant' }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. 身份确认（含分栏的可用性）
// ─────────────────────────────────────────────────────────────────────────────

export const LAYERS = {
  HEADER: 'logical-header-layer',
  RUNTIME: 'runtime-visible-layer',
  HUMAN: 'human-collaboration-layer',
}

/**
 * 给定 (session id, 短码) 判定 一致 / 不一致 / 不可判。
 *
 * `identity` 与 `availability` **分栏陈述**，本函数绝不把两者相乘。
 *
 * @param {object} index buildIndex 结果
 * @param {string} sessionId
 * @param {string} code
 * @param {object} opts { anchor, availability, readHeader }
 */
export function verifyPair(index, sessionId, code, opts = {}) {
  const anchor = opts.anchor ?? { source: 'unspecified', at: new Date().toISOString() }
  const idNorm = normalizeSessionId(sessionId)

  // ── 身份判定（只看 id 与码，不看可用性）──
  let identity
  if (!idNorm) {
    identity = { verdict: 'undecidable', reason: 'session-id-unparsable', layer: LAYERS.HEADER }
  } else {
    const res = resolveCode(index, code)
    if (res.status === 'unknown') {
      identity = { verdict: 'undecidable', reason: `code-unresolvable:${res.reason}`, layer: LAYERS.HUMAN, code }
    } else if (res.status === 'ambiguous') {
      identity = { verdict: 'undecidable', reason: `code-ambiguous:${res.reason}`, layer: LAYERS.HUMAN, code, candidates: res.candidates }
    } else {
      const same = res.uuid === idNorm.uuid
      identity = {
        verdict: same ? 'consistent' : 'inconsistent',
        reason: same ? 'code-resolves-to-same-uuid' : 'code-resolves-to-different-uuid',
        layer: LAYERS.HUMAN,
        code,
        codeResolvesTo: res.sessionId,
        givenSessionId: idNorm.verbatim,
        uuid: idNorm.uuid,
      }
    }
  }

  // ── 可用性（能否打开/续跑）——独立分栏，绝不参与上面的判定 ──
  const availability = opts.availability ?? probeAvailability(index, sessionId, opts)

  return { identity, availability, anchor }
}

/**
 * 可用性探测（独立栏）：**不是**身份判据。
 * 只看「当前运行时能否打开该会话文件 / header 能否解析」。
 */
export function probeAvailability(index, sessionId, opts = {}) {
  const read = opts.readHeader ?? defaultReadHeader
  const n = normalizeSessionId(sessionId)
  if (!n) return { openable: false, reason: 'session-id-unparsable', layer: LAYERS.RUNTIME }
  const row = index.byUuid.get(n.uuid)
  if (!row) return { openable: false, reason: 'not-present-in-active-base', layer: LAYERS.RUNTIME }
  if (!existsSync(row.path)) return { openable: false, reason: 'file-missing', layer: LAYERS.RUNTIME }
  const h = read(row.path)
  if (!h) return { openable: false, reason: 'header-unreadable', layer: LAYERS.RUNTIME, path: row.path }
  return {
    openable: true,
    reason: 'header-readable',
    layer: LAYERS.RUNTIME,
    path: row.path,
    bytes: statSync(row.path).size,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 分配与消解——已登记码「钉住」，新会话另配新号
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 短码分配器：**已登记(pinned)的码永不变**，新会话只在工作区序号尾部追加新号。
 *
 * 为什么需要它：短码表是按**登记时那份会话集合**的 createdAt 顺序编号的；
 * 基座换代/会话增删后集合变化，**若按当前基座重新推导，既有码会整体平移并改指到
 * 别的会话**（实测样本里绝大多数既有码会变，其中一部分直接撞上别人的已登记码）。
 * 故运行时**绝不**用推导结果覆盖已登记码，只「钉住旧码 + 新会话追加」。
 *
 * 稳定性边界（如实记录）：追加式分配对**新增**会话稳定（新会话序号更大，不扰动更早的）；
 * 但对**删除**更早的会话不稳定（其后未登记的会话会前移）。要让分配结果永久稳定，
 * 需把分配结果**持久化**成已登记码（即走变更留痕），本函数不做持久化。
 *
 * @param {object} input { sessions, pinned }
 * @returns {{assignments: Map, pinnedConflicts: Array, taken: Map, unparsablePinned: Array}}
 */
export function allocateCodes({ sessions = [], pinned = [] } = {}) {
  const taken = new Map()            // foldedCode → uuid
  const pinnedByUuid = new Map()     // uuid → code（钉住）
  const pinnedConflicts = []
  const unparsablePinned = []

  for (const p of pinned) {
    const n = normalizeSessionId(p.sessionId)
    if (!n) { unparsablePinned.push(p); continue }
    const key = foldCode(p.code)
    if (taken.has(key) && taken.get(key) !== n.uuid) {
      // 已登记码之间就撞了：只报，不覆盖（交给人工/留痕显式裁决）
      pinnedConflicts.push({ code: p.code, keep: taken.get(key), refused: n.uuid })
      continue
    }
    taken.set(key, n.uuid)
    pinnedByUuid.set(n.uuid, String(p.code))
  }

  // 每个工作区的下一个可用序号 = 该区已登记码的最大序号 + 1
  const nextSeq = {}
  for (const code of pinnedByUuid.values()) {
    const w = extractWsSeq(code)
    if (w) nextSeq[w.ws] = Math.max(nextSeq[w.ws] ?? 0, w.seq + 1)
  }

  const slot = new Map()   // uuid → code 字符串（pinned）或 {ws, seq}
  for (const [uuid, code] of pinnedByUuid) slot.set(uuid, code)

  const byWs = {}
  for (const s of sessions) {
    if (pinnedByUuid.has(s.uuid)) continue
    (byWs[s.ws] ??= []).push(s)
  }
  for (const ws of Object.keys(byWs)) {
    byWs[ws].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
    for (const s of byWs[ws]) {
      const seq = nextSeq[ws] ?? 1
      nextSeq[ws] = seq + 1
      slot.set(s.uuid, { ws, seq })
    }
  }

  const assignments = new Map()
  for (const s of sessions) {
    const v = slot.get(s.uuid)
    if (v === undefined) continue
    if (typeof v === 'string') { assignments.set(s.uuid, { code: v, kind: 'pinned', note: null }); continue }
    const self = `${v.ws}${String(v.seq).padStart(3, '0')}`
    let parentPart = ROOT_PARENT
    let note = null
    if (s.parent) {
      const pc = slot.get(uuidOf(s.parent))
      if (typeof pc === 'string') parentPart = pc.slice(0, 5)
      else if (pc && pc.ws) parentPart = `${pc.ws}${String(pc.seq).padStart(3, '0')}`
      else note = 'parent-not-in-base'
    }
    const code = `${self}${parentPart}`
    const key = foldCode(code)
    if (taken.has(key) && taken.get(key) !== s.uuid) {
      // 理论上追加式分配走不到这里；真撞上就拒绝而不是覆盖
      assignments.set(s.uuid, { code, kind: 'COLLISION-REFUSED', note: `collides-with:${taken.get(key)}` })
    } else {
      taken.set(key, s.uuid)
      assignments.set(s.uuid, { code, kind: 'allocated', note })
    }
  }

  return { assignments, pinnedConflicts, taken, unparsablePinned }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. 变更留痕：谁 / 何时 / 从→到 / 原因；**不得连带改 session id**
// ─────────────────────────────────────────────────────────────────────────────

export const CHANGELOG_FIELDS = ['at', 'actor', 'sessionId', 'from', 'to', 'reason']

/**
 * 记录一次短码变更。sessionId 只作为**被绑定对象**记录，从不被本函数修改。
 * @returns {object} 写入的记录
 */
export function recordCodeChange(path, { actor, sessionId, from, to, reason, at = new Date().toISOString() }) {
  if (!actor) throw new Error('recordCodeChange: actor required')
  if (!reason) throw new Error('recordCodeChange: reason required')
  const n = normalizeSessionId(sessionId)
  if (!n) throw new Error('recordCodeChange: sessionId unparsable')
  const record = { at, actor, sessionId: n.verbatim, from: from ?? null, to, reason }
  appendFileSync(path, JSON.stringify(record) + '\n')
  return record
}

/** 读变更留痕（只读）。 */
export function readCodeChanges(path) {
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 装载：短码表（已登记）+ 活动基座（待配号）→ 一码一指的赋值
// ─────────────────────────────────────────────────────────────────────────────

/** 读短码表 → 已登记项。**键形态原样保留**，归一只用于连接。 */
export function loadTableEntries(path = resolveBadgeTablePath()) {
  if (!existsSync(path)) return []
  try {
    const codes = JSON.parse(readFileSync(path, 'utf8')).codes ?? {}
    return Object.entries(codes).map(([k, v]) => ({ code: v, sessionId: k, source: 'badge-table' }))
  } catch {
    return []
  }
}

/**
 * 装载宇宙：活动基座会话（只一个根）+ 短码表 + 身份映射父边。
 * @param {object} [opts] { root, tablePath, idmapPath, readHeader, parentEdges }
 * @returns {{sessions:Array, pinned:Array, entries:Array, tablePath:string, idmapPath:string, root:string, errors:Array}}
 */
export function loadUniverse(opts = {}) {
  const root = opts.root ?? activeSessionsRoot()
  const tablePath = opts.tablePath ?? resolveBadgeTablePath()
  const idmapPath = opts.idmapPath ?? resolveIdentityMapPath()
  const parentEdges = opts.parentEdges ?? loadIdentityMapEdges(idmapPath)
  const { rows, errors } = scanSessions(root, { ...opts, parentEdges })
  const pinned = loadTableEntries(tablePath)
  return { sessions: rows, pinned, entries: pinned, tablePath, idmapPath, parentEdges, root, errors }
}

/**
 * 短码解析器（宿主装配用）：把「已登记码 + 新会话配号」解成 `uuid → code`，
 * 首次调用时同步构建并缓存。**只读**。
 *
 * 同步（而非 async）是刻意的：同步/异步两个调用点若各走一套逻辑，同一会话会拿到
 * 两个不同的码。这里两个调用点共用同一个缓存。
 */
export function createShortcodeResolver(opts = {}) {
  let state = null
  const build = () => {
    const uni = loadUniverse(opts)
    const { assignments, pinnedConflicts } = allocateCodes({ sessions: uni.sessions, pinned: uni.pinned })
    const byUuid = new Map()
    for (const [uuid, a] of assignments) byUuid.set(uuid, a)
    return { byUuid, uni, pinnedConflicts }
  }
  return {
    /** @returns {string|null} 规范短码；无法判定时 null（调用方自行兜底） */
    codeOf(sessionId) {
      const n = normalizeSessionId(sessionId)
      if (!n) return null
      state ??= build()
      return state.byUuid.get(n.uuid)?.code ?? null
    },
    /** 丢掉缓存（会话增删后调用）。 */
    refresh() { state = null },
    /** 诊断快照（只读）。 */
    stats() {
      state ??= build()
      const kinds = {}
      for (const a of state.byUuid.values()) kinds[a.kind] = (kinds[a.kind] ?? 0) + 1
      return {
        root: state.uni.root,
        tablePath: state.uni.tablePath,
        sessions: state.uni.sessions.length,
        pinned: state.uni.pinned.length,
        kinds,
        pinnedConflicts: state.pinnedConflicts.length,
      }
    },
  }
}
