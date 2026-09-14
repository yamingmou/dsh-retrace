/**
 * lib/platform/session-paths.js —— 会话基座/文件名/短码表落点/插件数据家的单一实现。
 *
 * 判据(2026-09-14 口径统一:未设 $DSH_HOME 时**新基座优先于旧 home**,与 archive
 * 侧生成器(内部短码生成脚本)resolveHome() 逐字同序):
 *   ① $DSH_HOME 优先(设了就只认它);
 *   ② 未设 $DSH_HOME 且两基座都在 → 选 ~/dsh-v3(口径统一后的新行为;旧行为选 ~/.dsh);
 *   ③ 未设 $DSH_HOME 且只有 ~/.dsh → 兜底旧 home;
 *   ④ 同一会话目录两种文件名并存 → 取 mtime 新者,平局按数组序(新基座优先);
 *   ⑤ pluginDataHome(插件数据家)与会话基座**同源**(设了 $DSH_HOME 逐字一致;
 *      未设则 = 活动基座父目录)——钉住"存储不再分裂到旧 home"。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SESSION_FILE_NAMES,
  sessionRoots,
  activeSessionsRoot,
  pluginDataHome,
  pickSessionFile,
  sessionFilePath,
  listSessionFiles,
  matchSessionFiles,
  badgeTableCandidates,
  resolveBadgeTablePath,
} from '../lib/platform/session-paths.js'

const V3 = 'session.v3.jsonl.zstd'
const V0 = 'session.jsonl.zstd'
const T0 = 1_700_000_000_000

const made = []
function tmpRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'sess-paths-'))
  made.push(dir)
  return dir
}
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }) })

/** 造一个会话文件;mtime 显式给定(便于测 mtime 取新/平局)。 */
function mkSession(home, base, ws, sid, name, mtimeMs = T0) {
  const dir = join(home, base, 'sessions', ws, sid)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, `{"id":"${sid}"}\n`)
  utimesSync(file, new Date(mtimeMs), new Date(mtimeMs))
  return file
}

describe('sessionRoots / activeSessionsRoot', () => {
  it('候选顺序:$DSH_HOME 优先,新基座次之,旧 home 兜底(有序去重)', () => {
    expect(sessionRoots({ home: '/H', dshHome: '/X' })).toEqual([
      '/X/sessions',
      join('/H', 'dsh-v3', 'sessions'),
      join('/H', '.dsh', 'sessions'),
    ])
    expect(sessionRoots({ home: '/H', dshHome: null })).toEqual([
      join('/H', 'dsh-v3', 'sessions'),
      join('/H', '.dsh', 'sessions'),
    ])
  })

  it('DSH_HOME 与旧 home 同为一个目录时去重', () => {
    expect(sessionRoots({ home: '/H', dshHome: '/H/.dsh' })).toEqual([
      join('/H', '.dsh', 'sessions'),
      join('/H', 'dsh-v3', 'sessions'),
    ])
  })

  it('活动基座 = 候选里第一个真实存在的 sessions 目录(两基座都在 → 新基座)', () => {
    const home = tmpRoot()
    mkSession(home, 'dsh-v3', '--w--', 'v3only', V3)
    // 只有新基座存在 → 新基座
    expect(activeSessionsRoot({ home, dshHome: null })).toBe(join(home, 'dsh-v3', 'sessions'))
    // 两基座都在 → 新基座优先(2026-09-14 口径统一;此前旧 home 优先)
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    expect(activeSessionsRoot({ home, dshHome: null })).toBe(join(home, 'dsh-v3', 'sessions'))
    // 设了 DSH_HOME → 它排第一
    const other = tmpRoot()
    mkSession(other, '', '--w--', 'x1', V3)
    expect(activeSessionsRoot({ home, dshHome: other })).toBe(join(other, 'sessions'))
  })

  it('只有旧 home 存在 → 兜底 ~/.dsh(与生成器 resolveHome 的兜底一致)', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    expect(activeSessionsRoot({ home, dshHome: null })).toBe(join(home, '.dsh', 'sessions'))
  })

  it('候选都不存在:未设 DSH_HOME → 兜底旧 home;设了 → 仍以 DSH_HOME 为首选', () => {
    const home = tmpRoot()
    expect(activeSessionsRoot({ home, dshHome: null })).toBe(join(home, '.dsh', 'sessions'))
    const dsh = tmpRoot()
    expect(activeSessionsRoot({ home, dshHome: dsh })).toBe(join(dsh, 'sessions'))
  })
})

describe('pickSessionFile', () => {
  it('两种文件名都认;并存取 mtime 较新者', () => {
    const dir = tmpRoot()
    const older = join(dir, V0)
    const newer = join(dir, V3)
    writeFileSync(older, '{}\n'); utimesSync(older, new Date(T0), new Date(T0))
    writeFileSync(newer, '{}\n'); utimesSync(newer, new Date(T0 + 5000), new Date(T0 + 5000))
    expect(pickSessionFile(dir)).toBe(newer)
    // 反向:旧文件更新 → 取旧文件(不按名字硬选新基座)
    utimesSync(older, new Date(T0 + 9000), new Date(T0 + 9000))
    expect(pickSessionFile(dir)).toBe(older)
  })

  it('mtime 平局时按数组序,新基座优先', () => {
    const dir = tmpRoot()
    const a = join(dir, V3)
    const b = join(dir, V0)
    writeFileSync(b, '{}\n'); utimesSync(b, new Date(T0), new Date(T0))
    writeFileSync(a, '{}\n'); utimesSync(a, new Date(T0), new Date(T0))
    expect(pickSessionFile(dir)).toBe(a)
    expect(SESSION_FILE_NAMES[0]).toBe(V3)
  })

  it('都没命中返回 null', () => {
    expect(pickSessionFile(tmpRoot())).toBe(null)
  })
})

describe('sessionFilePath(① / $DSH_HOME ② / 新基座优先 ③ / 旧 home 兜底)', () => {
  it('① DSH_HOME 设了 → 只在 DSH_HOME 下解析', () => {
    const home = tmpRoot()
    const dsh = tmpRoot()
    const inOld = mkSession(home, '.dsh', '--w--', 'same', V0)
    const inDsh = mkSession(dsh, '', '--w--', 'same', V3)
    expect(inOld).not.toBe(inDsh) // 防呆:两个不同文件
    expect(sessionFilePath('same', { home, dshHome: dsh })).toBe(inDsh)
  })

  it('② 未设 DSH_HOME 且两基座都有该会话 → 新基座优先(口径统一后的行为变更)', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'both', V0)
    const inV3 = mkSession(home, 'dsh-v3', '--w--', 'both', V3)
    expect(sessionFilePath('both', { home, dshHome: null })).toBe(inV3)
  })

  it('③ 未设 DSH_HOME 且只有旧 home 有该会话 → 兜底旧 home', () => {
    const home = tmpRoot()
    const inOld = mkSession(home, '.dsh', '--w--', 'oldonly', V0)
    expect(sessionFilePath('oldonly', { home, dshHome: null })).toBe(inOld)
  })

  it('③b 未设 DSH_HOME 且会话只在 v3 → 命中新基座', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'someother', V0) // 旧 home 存在,但没有目标会话
    const inV3 = mkSession(home, 'dsh-v3', '--w--', 'v3only', V3)
    expect(sessionFilePath('v3only', { home, dshHome: null })).toBe(inV3)
  })

  it('会话不存在 → null', () => {
    expect(sessionFilePath('nope', { home: tmpRoot(), dshHome: null })).toBe(null)
  })

  it('默认读 process.env.DSH_HOME(显式不传 dshHome)', () => {
    const prev = process.env.DSH_HOME
    const dsh = tmpRoot()
    const f = mkSession(dsh, '', '--w--', 'envhit', V3)
    try {
      process.env.DSH_HOME = dsh
      expect(sessionFilePath('envhit')).toBe(f)
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

describe('listSessionFiles', () => {
  it('枚举根下每个会话(并存取 mtime 新者),根不存在返回 []', () => {
    const home = tmpRoot()
    const v0 = mkSession(home, '.dsh', '--a--', 's1', V0, T0)
    const v3 = mkSession(home, '.dsh', '--a--', 's1', V3, T0 + 1000)
    const only = mkSession(home, '.dsh', '--b--', 's2', V0)
    mkdirSync(join(home, '.dsh', 'sessions', '--notasession--'), { recursive: true }) // 无会话文件的目录
    const got = listSessionFiles(join(home, '.dsh', 'sessions')).sort((a, b) => a.workspace.localeCompare(b.workspace))
    expect(got).toEqual([
      { workspace: '--a--', id: 's1', file: v3 },
      { workspace: '--b--', id: 's2', file: only },
    ])
    expect(got.map((g) => g.file)).not.toContain(v0)
    expect(listSessionFiles(join(home, 'no-such-root'))).toEqual([])
  })
})

describe('matchSessionFiles(id / 前缀 / session-<id>)', () => {
  it('三种 key 都命中,每个会话目录取 mtime 新者;无命中返回 []', () => {
    const home = tmpRoot()
    const byDir = mkSession(home, '.dsh', '--a--', 'session-abz98765', V0, T0)
    const byId = mkSession(home, '.dsh', '--b--', 'abz98765', V3, T0 + 1000)
    const got = matchSessionFiles('abz', { home, dshHome: null })
      .sort((x, y) => x.dir.localeCompare(y.dir))
    expect(got.map((g) => g.dir)).toEqual(['abz98765', 'session-abz98765'])
    expect(got.map((g) => g.file)).toEqual([byId, byDir])
    expect(matchSessionFiles('session-abz98765', { home, dshHome: null })).toHaveLength(1)
    expect(matchSessionFiles('zzz', { home, dshHome: null })).toEqual([])
  })
})

describe('badgeTableCandidates / resolveBadgeTablePath', () => {
  it('覆写 env 排第一;规范落点(插件数据家下)次之;基座旁兜底', () => {
    // 短码表是**用户自备数据**,不是代码 ⇒ 代码里不得出现任何私有目录名。
    // 规范落点 = <pluginDataHome>/dsh-retrace/codes.json(与会话基座同源)。
    const canonical = join(pluginDataHome({ home: '/H' }), 'dsh-retrace', 'codes.json')
    const c = badgeTableCandidates({ home: '/H', override: '/O/t.json' })
    expect(c[0]).toBe('/O/t.json')
    expect(c[1]).toBe(canonical)
    expect(c).toEqual([...new Set(c)])
    expect(badgeTableCandidates({ home: '/H', override: null })[0]).toBe(canonical)
  })

  it('取第一个存在的落点;**只读**(不写文件)', () => {
    const home = tmpRoot()
    const dataHome = pluginDataHome({ home })
    const canonical = join(dataHome, 'dsh-retrace', 'codes.json')
    mkdirSync(join(dataHome, 'dsh-retrace'), { recursive: true })
    writeFileSync(canonical, '{"codes":{}}\n')
    expect(resolveBadgeTablePath({ home, override: null })).toBe(canonical)
    const override = join(home, 'override.json')
    writeFileSync(override, '{"codes":{}}\n')
    expect(resolveBadgeTablePath({ home, override })).toBe(override)
    // 候选都不存在 → 返回首选(调用方读取失败自行兜底),不抛错
    const empty = tmpRoot()
    expect(resolveBadgeTablePath({ home: empty, override: null }))
      .toBe(join(pluginDataHome({ home: empty }), 'dsh-retrace', 'codes.json'))
  })
})

/**
 * pluginDataHome —— 插件数据家(快照 / 存储根 / profiles 默认落点)与会话基座**同源**。
 * 变更点:未设 $DSH_HOME 且两基座都在时,插件数据家由旧行为 ~/.dsh 改为 ~/dsh-v3
 * (改前 = 官方 resolveDshHome 口径,数据落旧 home 而会话读新基座 ⇒ 存储分裂)。
 */
describe('pluginDataHome(插件数据家:与会话基座同源)', () => {
  it('① DSH_HOME 设了 → 逐字用它(含 ~ 展开/resolve,与官方 resolveDshHome 的 env 分支一致)', () => {
    // 向后兼容:设了 env 时行为与改前(官方 resolveDshHome)**逐字一致**。
    expect(pluginDataHome({ home: '/H', dshHome: '/X' })).toBe('/X')
    // 目录不存在也照样返回(官方同样不检查存在性)
    expect(pluginDataHome({ home: '/H', dshHome: join('/no', 'such', 'home') })).toBe('/no/such/home')
    // ~ / 相对路径规范化 = 官方 expandHomePath + resolve
    expect(pluginDataHome({ home: '/H', dshHome: '~/x' })).toBe(join(homedir(), 'x'))
    expect(pluginDataHome({ home: '/H', dshHome: '~' })).toBe(resolve(homedir()))
    expect(pluginDataHome({ home: '/H', dshHome: 'rel-home' })).toBe(resolve('rel-home'))
    // 设了 env 就**不**看基座(即使两基座都在)
    const home = tmpRoot()
    mkSession(home, 'dsh-v3', '--w--', 'v3one', V3)
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    expect(pluginDataHome({ home, dshHome: '/X' })).toBe('/X')
  })

  it('② 未设 DSH_HOME 且两基座都在 → 数据家 = 会话基座(~/{dsh-v3}),不再分裂到旧 home', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    mkSession(home, 'dsh-v3', '--w--', 'v3one', V3)
    const sessionBase = dirname(activeSessionsRoot({ home, dshHome: null }))
    expect(sessionBase).toBe(join(home, 'dsh-v3'))
    expect(pluginDataHome({ home, dshHome: null })).toBe(join(home, 'dsh-v3'))
    // 同源不变式(活动基座存在 ⇒ 数据家 === 会话基座)
    expect(pluginDataHome({ home, dshHome: null })).toBe(sessionBase)
    // 改前行为(官方口径)是旧 home —— 显式对照,防回归到 ~/.dsh
    expect(pluginDataHome({ home, dshHome: null })).not.toBe(join(home, '.dsh'))
  })

  it('③ 未设 DSH_HOME 且只有 ~/.dsh → 两边都兜底旧 home(与读端同基座)', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'oldonly', V0)
    expect(activeSessionsRoot({ home, dshHome: null })).toBe(join(home, '.dsh', 'sessions'))
    expect(pluginDataHome({ home, dshHome: null })).toBe(join(home, '.dsh'))
  })

  it('④ 还没有 sessions/(全新基座):存在 ~/dsh-v3 目录 → 仍选新基座;都不在 → 兜底 ~/.dsh', () => {
    const home = tmpRoot()
    expect(pluginDataHome({ home, dshHome: null })).toBe(join(home, '.dsh')) // 全空
    mkdirSync(join(home, 'dsh-v3'), { recursive: true })                    // 只有裸基座目录
    expect(pluginDataHome({ home, dshHome: null })).toBe(join(home, 'dsh-v3'))
    const other = tmpRoot()
    mkdirSync(join(other, '.dsh'), { recursive: true })
    expect(pluginDataHome({ home: other, dshHome: null })).toBe(join(other, '.dsh'))
  })

  it('⑤ 同源不变式(存在任一 sessions/ ⇒ 数据家 === 会话基座父目录):遍历候选存在组合', () => {
    for (const bases of [['dsh-v3'], ['.dsh'], ['dsh-v3', '.dsh']]) {
      const home = tmpRoot()
      for (const b of bases) mkSession(home, b, '--w--', `s-${b}`, V3)
      const opts = { home, dshHome: null }
      expect(pluginDataHome(opts)).toBe(dirname(activeSessionsRoot(opts)))
    }
  })

  it('⑥ 默认读 process.env.DSH_HOME;空白 env = 未设(与官方 resolveDshHome 同)', () => {
    const prev = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = '/env/home'
      expect(pluginDataHome({ home: '/H' })).toBe('/env/home')
      process.env.DSH_HOME = '   '
      expect(pluginDataHome({ home: '/H' })).toBe(join('/H', '.dsh'))
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

/**
 * 口径守卫(源码级):三个"插件数据落点"不得再各自 import 官方 home resolver
 * (@deepseek-ai/dsh-home-paths 只认 $DSH_HOME → ~/.dsh,不认识 ~/dsh-v3)。
 * 行为测不到它们(看门狗/versioning 默认路径只在无注入的装配里生效),故钉源码。
 */
describe('插件数据落点口径守卫:只走 pluginDataHome()', () => {
  const repo = dirname(dirname(fileURLToPath(import.meta.url)))
  for (const rel of ['lib/watchdog.js', 'lib/versioning.js', 'scripts/verify-install.mjs']) {
    it(`${rel} 用 pluginDataHome,且不 import @deepseek-ai/dsh-home-paths / resolveDshHome`, () => {
      const src = readFileSync(join(repo, rel), 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') // 去掉注释里的说明文字
      expect(code).not.toMatch(/from\s+['"]@deepseek-ai\/dsh-home-paths['"]/)
      expect(code).not.toMatch(/\bresolveDshHome\b/)
      expect(code).toMatch(/pluginDataHome\s*\(/)
      expect(code).toMatch(/pluginDataHome/)
    })
  }
})

