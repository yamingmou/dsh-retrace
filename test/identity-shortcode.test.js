/**
 * 短码侧身份确认单测（R1–R10）。**全部用合成数据**，不读真实基座/短码表
 * （公开产物里也能跑）。
 *
 * 覆盖的不变量（与 lib/identity/shortcode.js 的注释逐条对应）：
 *   身份判定只看 session id；短码可解析到唯一 id；已登记码钉住不变、新会话追加；
 *   不可判必须显式；身份与可用性分栏不合并；只读（纯函数不改入参）。
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  uuidOf, normalizeSessionId, sameSession,
  CANONICAL_CODE_RE, ROOT_PARENT, CODE_LENGTH, isCanonicalCode, foldCode,
  composeCode, extractWsSeq, fnvBadge, LAYERS,
  buildIndex, resolveCode, verifyPair, probeAvailability,
  allocateCodes, deriveCodes, scanSessions, loadIdentityMapEdges,
  recordCodeChange, readCodeChanges, CHANGELOG_FIELDS,
} from '../lib/identity/shortcode.js'
import { workspaceAbbr } from '../lib/platform/session-paths.js'

const A = 'session-00000000-0000-4000-8000-b3323ee89238'
const B = 'session-00000000-0000-4000-8000-4632d755ea9c'
const C = 'session-00000000-0000-4000-8000-816346bd66e8'
const AU = '00000000-0000-4000-8000-b3323ee89238'

/** 合成会话行（形状与 scanSessions 产出一致）。 */
const mk = (id, ws, createdAt, parent = null, path = '/nonexistent') => ({
  id, uuid: uuidOf(id), ws, createdAt, parent, isSeeded: false, path, workspace: `--x-${ws}--`,
})

describe('R1 身份判定只认 session id', () => {
  it('R1 身份判定只看 uuid:传入短码这类非 uuid 判为不可解析', () => {
    expect(sameSession(A, AU).same).toBe(true)
    expect(sameSession(A, B).same).toBe(false)
    const r = sameSession(A, 'dx035dx034')
    expect(r.same).toBe(false)
    expect(r.reason).toBe('one-side-id-unparsable')
  })

  it('规范化保留原值(verbatim)并给出连接键 uuid', () => {
    const n = normalizeSessionId(A)
    expect(n.verbatim).toBe(A)
    expect(n.uuid).toBe('3ef7c70c59a7427b9768ca39706fc2e2')
    expect(n.prefixed).toBe(true)
    expect(normalizeSessionId(AU).prefixed).toBe(false)
    expect(normalizeSessionId('not-an-id')).toBe(null)
  })

  it('规范化是纯函数:normalizeSessionId/uuidOf 不改动入参对象', () => {
    const row = mk(A, 'dx', 123, B)
    const snap = JSON.stringify(row)
    normalizeSessionId(row.id)
    uuidOf(row.id)
    expect(JSON.stringify(row)).toBe(snap)
  })
})

describe('短码规则(长度/字符集/构成)', () => {
  it('规范形固定 10 位且字符集受控', () => {
    for (const c of ['op065op016', 'dx035dx034', 'op072op065', 'wo001FF000', 'do001FF000']) {
      expect(c).toHaveLength(CODE_LENGTH)
      expect(isCanonicalCode(c)).toBe(true)
    }
    expect(CODE_LENGTH).toBe(10)
    expect(ROOT_PARENT).toBe('FF000')
    expect(CANONICAL_CODE_RE.test('op065op016')).toBe(true)
  })

  it('非规范形一律拒绝', () => {
    for (const bad of ['OP065OP016', 'op65op16', 'op065op0166', 'op065-op16', 'op065op01x', '']) {
      expect(isCanonicalCode(bad)).toBe(false)
    }
  })

  it('组码规则:根会话父位为 FF000,有父则接父工作区+父序号', () => {
    expect(composeCode('op', 65, null, null)).toBe('op065FF000')
    expect(composeCode('op', 65, 'op', 16)).toBe('op065op016')
    expect(composeCode('dx', 7, 'op', 3)).toBe('dx007op003')
  })

  it('extractWsSeq 取回工作区与序号,非法码返回 null', () => {
    expect(extractWsSeq('op065op016')).toEqual({ ws: 'op', seq: 65 })
    expect(extractWsSeq('bad')).toBe(null)
  })

  it('工作区缩写:剥掉机器前缀后取前两段首字母', () => {
    // 机器无关:用当前 home 的编码前缀构造输入(函数按 os.homedir() 剥前缀)
    const homeEnc = homedir().replace(/\//g, '-').replace(/^-+/, '').replace(/-+$/, '')
    expect(workspaceAbbr(`--${homeEnc}-opena--`)).toBe('op')
    expect(workspaceAbbr(`--${homeEnc}-workspace`)).toBe('dx')
    expect(workspaceAbbr(`--${homeEnc}-workspace`)).toBe('wo')
    // 不在 home 下的路径走平台前缀分支(Users/home/Volumes/…)
    expect(workspaceAbbr('--Volumes-Data-project--')).toBe('dp')
  })

  it('FNV 兜底确定性且固定 10 位', () => {
    expect(fnvBadge(A)).toBe(fnvBadge(AU))
    expect(fnvBadge(A)).toMatch(/^[0-9a-z]{10}$/)
    expect(fnvBadge('not-an-id')).toBe('')
  })
})

describe('R3 短码 → 唯一 session id', () => {
  const index = buildIndex({
    entries: [
      { code: 'dx035dx034', sessionId: A, source: 'badge-table' },
      { code: 'op065op016', sessionId: B, source: 'badge-table' },
    ],
    sessions: [mk(A, 'dx', 1), mk(B, 'op', 2)],
  })

  it('短码 → 唯一 session id:已登记码解析到登记的会话', () => {
    const r = resolveCode(index, 'dx035dx034')
    expect(r.status).toBe('unique')
    expect(r.sessionId).toBe(A)
    expect(r.reason).toBe('single-claimant')
  })

  it('大小写折叠:FF 根标记的小写写法解析到同一会话', () => {
    const idx = buildIndex({
      entries: [{ code: 'op001FF000', sessionId: A, source: 'badge-table' }],
      sessions: [mk(A, 'op', 1)],
    })
    expect(resolveCode(idx, 'op001FF000').sessionId).toBe(A)
    expect(resolveCode(idx, 'op001ff000').sessionId).toBe(A)
    expect(foldCode('OP001FF000')).toBe('op001ff000')
  })

  it('未登记码与非法形态都显式 unknown(不猜)', () => {
    expect(resolveCode(index, 'zz999zz999').status).toBe('unknown')
    expect(resolveCode(index, 'zz999zz999').reason).toBe('code-not-in-index')
    expect(resolveCode(index, 'not-a-code').reason).toBe('malformed-code')
  })
})

describe('R9 撞码检出与消解(不静默覆盖)', () => {
  it('R9 一码两指 → REFUSED_AMBIGUOUS,不静默择一', () => {
    const index = buildIndex({
      entries: [
        { code: 'dx001FF000', sessionId: A, source: 'badge-table' },
        { code: 'dx001FF000', sessionId: B, source: 'derived:active-base' },
      ],
      sessions: [mk(A, 'dx', 1), mk(B, 'dx', 2)],
    })
    expect(index.collisions).toHaveLength(1)
    expect(index.collisions[0].resolution).toBe('REFUSED_AMBIGUOUS')
    const r = resolveCode(index, 'dx001FF000')
    expect(r.status).toBe('ambiguous')
    expect(r.sessionId).toBe(null)
    expect(r.candidates).toHaveLength(2)
  })

  it('折叠歧义:根标记 FF 与真实 ff 工作区折叠后相撞 → 检出为 ambiguous', () => {
    const index = buildIndex({
      entries: [
        { code: 'dx001FF000', sessionId: A, source: 'badge-table' },
        { code: 'dx001ff000', sessionId: B, source: 'derived:active-base' },
      ],
      sessions: [mk(A, 'dx', 1), mk(B, 'dx', 2)],
    })
    expect(index.collisions).toHaveLength(1)
    expect(resolveCode(index, 'dx001FF000').status).toBe('ambiguous')
  })

  it('一会话多码 → 检出为漂移', () => {
    const index = buildIndex({
      entries: [
        { code: 'dx035dx034', sessionId: A, source: 'badge-table' },
        { code: 'dx025FF000', sessionId: A, source: 'derived:active-base' },
      ],
      sessions: [mk(A, 'dx', 1)],
    })
    expect(index.divergence).toHaveLength(1)
    expect(index.divergence[0].codes).toHaveLength(2)
  })

  it('码指向活动基座外的会话 → 记入 orphanCodes', () => {
    const index = buildIndex({
      entries: [{ code: 'dx009FF000', sessionId: C, source: 'badge-table' }],
      sessions: [mk(A, 'dx', 1)],
    })
    expect(index.orphanCodes).toHaveLength(1)
  })

  it('R9 分配器:已登记码钉住不变,新会话在工作区序号尾部追加', () => {
    const sessions = [mk(A, 'dx', 100), mk(B, 'dx', 200)]
    const { assignments, pinnedConflicts } = allocateCodes({
      sessions,
      pinned: [{ code: 'dx001FF000', sessionId: A }],
    })
    expect(pinnedConflicts).toHaveLength(0)
    expect(assignments.get(uuidOf(A)).code).toBe('dx001FF000')
    expect(assignments.get(uuidOf(A)).kind).toBe('pinned')
    expect(assignments.get(uuidOf(B)).code).toBe('dx002FF000')
    expect(assignments.get(uuidOf(B)).kind).toBe('allocated')
  })

  it('R9 基座换代:重推导会改码,但已登记码仍不变(钉住优先于推导)', () => {
    // 换代后集合只剩 B:若按新集合从零推导,B 会拿到已被 A 登记的 dx001FF000
    const sessions = [mk(B, 'dx', 200)]
    const derived = deriveCodes(sessions)
    expect(derived[uuidOf(B)]).toBe('dx001FF000')
    const { assignments } = allocateCodes({
      sessions,
      pinned: [{ code: 'dx001FF000', sessionId: A }],
    })
    expect(assignments.get(uuidOf(B)).code).not.toBe('dx001FF000')
    expect(assignments.get(uuidOf(B)).code).toBe('dx002FF000')
    expect(assignments.get(uuidOf(B)).kind).toBe('allocated')
  })

  it('分配结果一码一指:码集合大小等于会话数', () => {
    const sessions = [mk(A, 'dx', 1), mk(B, 'dx', 2), mk(C, 'op', 3)]
    const { assignments, taken } = allocateCodes({ sessions, pinned: [{ code: 'dx001FF000', sessionId: A }] })
    const codes = [...assignments.values()].map((x) => x.code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(taken.size).toBe(codes.length)
  })

  it('已登记码之间互撞 → 记录冲突且拒绝覆盖', () => {
    const { pinnedConflicts } = allocateCodes({
      sessions: [mk(A, 'dx', 1), mk(B, 'dx', 2)],
      pinned: [
        { code: 'dx001FF000', sessionId: A },
        { code: 'dx001FF000', sessionId: B },
      ],
    })
    expect(pinnedConflicts).toHaveLength(1)
    expect(pinnedConflicts[0].refused).toBe(uuidOf(B))
  })

  it('无法解析的登记项被隔离,不参与分配', () => {
    const { unparsablePinned } = allocateCodes({
      sessions: [mk(A, 'dx', 1)],
      pinned: [{ code: 'dx001FF000', sessionId: 'not-an-id' }],
    })
    expect(unparsablePinned).toHaveLength(1)
  })

  it('deriveCodes 按 createdAt 排序编号并接父链', () => {
    const codes = deriveCodes([mk(B, 'dx', 200, A), mk(A, 'dx', 100)])
    expect(codes[uuidOf(A)]).toBe('dx001FF000')
    expect(codes[uuidOf(B)]).toBe('dx002dx001')
  })
})

describe('A5 不可判必须显式', () => {
  const index = buildIndex({
    entries: [{ code: 'dx035dx034', sessionId: A, source: 'badge-table' }],
    sessions: [mk(A, 'dx', 1)],
  })

  it('A5 不可判必须显式:码不可解析 → undecidable + 原因', () => {
    const v = verifyPair(index, A, 'zz999zz999', { anchor: { source: 't', at: 'now' } })
    expect(v.identity.verdict).toBe('undecidable')
    expect(v.identity.reason).toMatch(/code-unresolvable/)
  })

  it('session id 不可解析 → undecidable + 原因', () => {
    const v = verifyPair(index, 'not-an-id', 'dx035dx034', { anchor: { source: 't', at: 'now' } })
    expect(v.identity.verdict).toBe('undecidable')
    expect(v.identity.reason).toBe('session-id-unparsable')
  })

  it('歧义码 → undecidable 且列出候选', () => {
    const amb = buildIndex({
      entries: [
        { code: 'dx001FF000', sessionId: A, source: 'badge-table' },
        { code: 'dx001FF000', sessionId: B, source: 'derived:active-base' },
      ],
      sessions: [mk(A, 'dx', 1), mk(B, 'dx', 2)],
    })
    const v = verifyPair(amb, A, 'dx001FF000', { anchor: { source: 't', at: 'now' } })
    expect(v.identity.verdict).toBe('undecidable')
    expect(v.identity.reason).toMatch(/code-ambiguous/)
    expect(v.identity.candidates).toHaveLength(2)
  })
})

describe('R10 身份与可用性分栏', () => {
  it('R10 identity 与 availability 是两个并列字段(顶层同级,不合并)', () => {
    const index = buildIndex({
      entries: [{ code: 'dx035dx034', sessionId: A, source: 'badge-table' }],
      sessions: [mk(A, 'dx', 1)],
    })
    const v = verifyPair(index, A, 'dx035dx034', { anchor: { source: 't', at: 'now' } })
    expect(Object.keys(v)).toEqual(['identity', 'availability', 'anchor'])
    expect(v.identity.layer).toBe(LAYERS.HUMAN)
    expect(v.availability.layer).toBe(LAYERS.RUNTIME)
  })

  it('R10 verifyPair 的身份判定不读取可用性(注入 availability 也不影响判定)', () => {
    const index = buildIndex({
      entries: [{ code: 'dx035dx034', sessionId: A, source: 'badge-table' }],
      sessions: [mk(A, 'dx', 1)],
    })
    const base = verifyPair(index, A, 'dx035dx034', { anchor: { source: 't', at: 'now' } })
    const forced = verifyPair(index, A, 'dx035dx034', {
      anchor: { source: 't', at: 'now' },
      availability: { openable: false, reason: 'forced' },
    })
    expect(forced.identity).toEqual(base.identity)
    expect(forced.availability.openable).toBe(false)
  })

  it('R10 身份一致但文件缺失 → 身份栏仍 consistent,可用性栏独立为 false', () => {
    const index = buildIndex({
      entries: [{ code: 'dx035dx034', sessionId: A, source: 'badge-table' }],
      sessions: [mk(A, 'dx', 1, null, '/nonexistent')],
    })
    const v = verifyPair(index, A, 'dx035dx034', { anchor: { source: 't', at: 'now' } })
    expect(v.identity.verdict).toBe('consistent')
    expect(v.availability.openable).toBe(false)
    expect(v.availability.reason).toBe('file-missing')
  })

  it('R10 身份不一致但文件可读 → 两栏取值可以相反', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-'))
    const file = join(dir, 'session.jsonl')
    writeFileSync(file, JSON.stringify({ id: B, createdAt: 1 }) + '\n')
    const aRow = mk(A, 'dx', 1, null, file)
    const bRow = mk(B, 'dx', 2, null, file)
    const index = buildIndex({
      entries: [{ code: 'dx001FF000', sessionId: B, source: 'badge-table' }],
      sessions: [aRow, bRow],
    })
    const v = verifyPair(index, A, 'dx001FF000', { anchor: { source: 't', at: 'now' } })
    expect(v.identity.verdict).toBe('inconsistent')
    expect(v.availability.openable).toBe(true)
    expect(v.availability.reason).toBe('header-readable')
  })

  it('probeAvailability 对不在基座内的会话显式不可判原因', () => {
    const index = buildIndex({ entries: [], sessions: [mk(A, 'dx', 1)] })
    const r = probeAvailability(index, C)
    expect(r.openable).toBe(false)
    expect(r.reason).toBe('not-present-in-active-base')
    expect(probeAvailability(index, 'not-an-id').reason).toBe('session-id-unparsable')
  })
})

describe('R6 世系覆盖层:身份映射补父边(绝不回退 FF000、绝不写回 header)', () => {
  /** 在一个临时基座里写一个会话(明文 JSON 放进 .zstd 名,默认读取器认明文)。 */
  const writeSession = (root, ws, id, createdAt) => {
    const dir = join(root, ws, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), JSON.stringify({ id, createdAt }) + '\n')
    return join(dir, 'session.v3.jsonl.zstd')
  }
  const mkRoot = () => {
    const root = mkdtempSync(join(tmpdir(), 'sc-root-'))
    // 父会话(有 header 父=None,是根)+ 两个子会话(header 里 parentSession 已丢)
    writeSession(root, '--Volumes-workspace', '00000000-0000-4000-8000-7cac378a5787', 10)
    writeSession(root, '--Volumes-workspace', '00000000-0000-4000-8000-9c9c92612cf7', 20)
    writeSession(root, '--Volumes-workspace', '00000000-0000-4000-8000-f25c8a6c7ca5', 30)
    return root
  }
  const writeIdmap = (pairs) => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-idmap-'))
    const p = join(dir, 'idmap.identity.json')
    writeFileSync(p, JSON.stringify({ idmapVersion: 1, pairs }))
    return p
  }

  it('身份映射补父边:header 无父时父段不回退 FF000(有映射)', () => {
    const root = mkRoot()
    const idmap = writeIdmap([
      // ⚠️ 归一化陷阱:newId 裸 uuid,parentNewId 带 session- 前缀
      { newId: '00000000-0000-4000-8000-9c9c92612cf7', parentNewId: '00000000-0000-4000-8000-7cac378a5787', class: 'A' },
      { newId: '00000000-0000-4000-8000-f25c8a6c7ca5', parentNewId: '00000000-0000-4000-8000-9c9c92612cf7', class: 'A' },
    ])
    const edges = loadIdentityMapEdges(idmap)
    expect(edges.size).toBe(2)
    expect(edges.get(uuidOf('00000000-0000-4000-8000-9c9c92612cf7')).parentUuid)
      .toBe(uuidOf('00000000-0000-4000-8000-7cac378a5787'))

    const { rows } = scanSessions(root, { parentEdges: edges })
    const b = rows.find((r) => r.uuid === uuidOf('00000000-0000-4000-8000-9c9c92612cf7'))
    expect(b.parentSource).toBe('identity-map')
    const codes = deriveCodes(rows)
    // 父段承载父的 (ws,seq),而不是 FF000
    expect(codes[b.uuid]).toBe('dx002dx001')
    expect(codes[b.uuid].endsWith(ROOT_PARENT)).toBe(false)
    // 孙子辈同理,链式不塌
    const c = rows.find((r) => r.uuid === uuidOf('00000000-0000-4000-8000-f25c8a6c7ca5'))
    expect(codes[c.uuid]).toBe('dx003dx002')
  })

  it('身份映射不在场时父段回退 FF000(如实降级,不臆造父边)', () => {
    const root = mkRoot()
    const { rows } = scanSessions(root, { parentEdges: new Map() })
    const b = rows.find((r) => r.uuid === uuidOf('00000000-0000-4000-8000-9c9c92612cf7'))
    expect(b.parent).toBe(null)
    expect(b.parentSource).toBe(null)
    expect(deriveCodes(rows)[b.uuid]).toBe('dx002FF000')
  })

  it('header 父边优先于映射(映射只补位,不改写既有事实)', () => {
    const root = mkdtempSync(join(tmpdir(), 'sc-root-'))
    const dir = join(root, '--Volumes-workspace', '00000000-0000-4000-8000-e6bdd83c17d2')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'),
      JSON.stringify({ id: '00000000-0000-4000-8000-e6bdd83c17d2', createdAt: 5, parentSession: 'session-00000000-0000-4000-8000-7cac378a5787' }) + '\n')
    writeSession(root, '--Volumes-workspace', '00000000-0000-4000-8000-7cac378a5787', 1)
    const idmap = writeIdmap([
      { newId: '00000000-0000-4000-8000-e6bdd83c17d2', parentNewId: '00000000-0000-4000-8000-9c9c92612cf7', class: 'A' },
    ])
    const { rows } = scanSessions(root, { parentEdges: loadIdentityMapEdges(idmap) })
    const d = rows.find((r) => r.uuid === uuidOf('00000000-0000-4000-8000-e6bdd83c17d2'))
    expect(d.parentSource).toBe('header')
    expect(uuidOf(d.parent)).toBe(uuidOf('00000000-0000-4000-8000-7cac378a5787'))
  })

  it('父边来源只读:扫描身份映射不写回会话文件(sha 不变)', () => {
    const root = mkRoot()
    const target = join(root, '--Volumes-workspace', '00000000-0000-4000-8000-9c9c92612cf7', 'session.v3.jsonl.zstd')
    const before = readFileSync(target, 'utf8')
    const idmap = writeIdmap([
      { newId: '00000000-0000-4000-8000-9c9c92612cf7', parentNewId: '00000000-0000-4000-8000-7cac378a5787', class: 'A' },
    ])
    scanSessions(root, { parentEdges: loadIdentityMapEdges(idmap) })
    expect(readFileSync(target, 'utf8')).toBe(before)
    expect(JSON.parse(before.split('\n')[0]).parentSession).toBe(undefined)
  })

  it('已登记父的坐标取自码本身:非登记子会话的父段不回退 FF000(父不在扫描集也成立)', () => {
    const CHILD = 'session-00000000-0000-4000-8000-e6bdd83c17d2'
    const P = 'session-00000000-0000-4000-8000-f2e7d5f6ce25'
    const G = 'session-00000000-0000-4000-8000-603485ac60d1'
    const sessions = [mk(A, 'dx', 100, null), mk(CHILD, 'dx', 500, A)]
    const { assignments } = allocateCodes({
      sessions,
      pinned: [
        { code: 'dx035dx034', sessionId: A },
        { code: 'dx034dx023', sessionId: P },
        { code: 'dx023FF000', sessionId: G },
      ],
    })
    // 丢父的 A 仍持已登记码(不回退 FF000)
    expect(assignments.get(uuidOf(A)).code).toBe('dx035dx034')
    expect(assignments.get(uuidOf(A)).kind).toBe('pinned')
    expect(assignments.get(uuidOf(A)).code.endsWith(ROOT_PARENT)).toBe(false)
    // 非登记子会话的父段取自 A 的已登记码(父坐标从码本身读出,不要求父在扫描集)
    const child = assignments.get(uuidOf(CHILD))
    expect(child.code.endsWith('dx035')).toBe(true)
    expect(child.code.endsWith(ROOT_PARENT)).toBe(false)
  })

  it('身份映射缺失 → 空边集(不抛错,降级为无覆盖层)', () => {
    expect(loadIdentityMapEdges('/nonexistent/idmap.identity.json').size).toBe(0)
  })

  it('自指/无父的映射项被忽略(不制造假父边)', () => {
    const idmap = writeIdmap([
      { newId: '00000000-0000-4000-8000-7cac378a5787', parentNewId: null },
      { newId: '00000000-0000-4000-8000-9c9c92612cf7', parentNewId: 'session-00000000-0000-4000-8000-9c9c92612cf7' },
    ])
    expect(loadIdentityMapEdges(idmap).size).toBe(0)
  })
})

describe('R7 变更留痕', () => {
  it('recordCodeChange 记录 谁/何时/从→到/原因,且不改 session id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-log-'))
    const log = join(dir, 'changelog.jsonl')
    const rec = recordCodeChange(log, {
      actor: 'tester', sessionId: A, from: 'dx001FF000', to: 'dx002FF000', reason: 'renumber',
    })
    expect(rec.sessionId).toBe(A)
    expect(rec.from).toBe('dx001FF000')
    expect(rec.to).toBe('dx002FF000')
    expect(rec.actor).toBe('tester')
    expect(rec.reason).toBe('renumber')
    expect(typeof rec.at).toBe('string')
    const all = readCodeChanges(log)
    expect(all).toHaveLength(1)
    expect(all[0].to).toBe('dx002FF000')
  })

  it('recordCodeChange 缺 actor/reason 或 id 不可解析时抛错', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sc-log-'))
    const log = join(dir, 'changelog.jsonl')
    expect(() => recordCodeChange(log, { actor: '', sessionId: A, to: 'x', reason: 'r' })).toThrow()
    expect(() => recordCodeChange(log, { actor: 'a', sessionId: A, to: 'x', reason: '' })).toThrow()
    expect(() => recordCodeChange(log, { actor: 'a', sessionId: 'nope', to: 'x', reason: 'r' })).toThrow()
  })

  it('留痕字段清单固定', () => {
    expect(CHANGELOG_FIELDS).toEqual(['at', 'actor', 'sessionId', 'from', 'to', 'reason'])
  })

  it('readCodeChanges 对不存在的文件返回空数组', () => {
    expect(readCodeChanges('/nonexistent/changelog.jsonl')).toEqual([])
  })
})
