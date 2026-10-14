/**
 * lib/platform/session-paths.js —— 会话基座/文件名/谱系标识表落点/插件数据家的单一实现。
 *
 * 规则(口径统一:未设 $DSH_HOME 时**配置基座优先于旧 home**,与 archive
 * 侧生成器(内部谱系标识生成脚本)resolveHome() 逐字同序):
 *   ① $DSH_HOME 优先(设了就只认它);
 *   ② 未设 $DSH_HOME 且配置基座($DSH_SESSION_BASES)与 ~/.dsh 都在 → 选配置基座
 *      (口径统一后的新行为;旧行为选 ~/.dsh);
 *   ③ 未设 $DSH_HOME 且只有 ~/.dsh → 兜底旧 home;
 *   ④ 同一会话目录多代文件名并存 → 取 mtime 新者,平局按数组序(世代高者优先:v4 → v3 → v0);
 *   ⑤ pluginDataHome(插件数据家)与会话基座**同源**(设了 $DSH_HOME 逐字一致;
 *      未设则 = 活动基座父目录)——钉住"存储不再分裂到旧 home"。
 *   ⑥ **机器自有的非常规基座一律来自配置**(`$DSH_SESSION_BASES`,逗号分隔,条目可写
 *      绝对路径或 `~`/`~/`),源码里不出现任何具体本机目录名;未配置 ⇒ 该类基座缺席。
 */
import { describe, it, expect, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SESSION_FILE_NAMES,
  SESSION_BASES_ENV,
  extraSessionBases,
  sessionBases,
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

const V4 = 'session.v4.jsonl.zstd'
const V3 = 'session.v3.jsonl.zstd'
const V0 = 'session.jsonl.zstd'
const T0 = 1_700_000_000_000

/** 额外基座:中性目录名,一律经 `$DSH_SESSION_BASES` 配置进实现(不写死在源码里)。 */
const EXTRA_NAME = 'x-base'
const EXTRA = `~/${EXTRA_NAME}`
const extraDir = (home) => join(home, EXTRA_NAME)

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

describe('extraSessionBases / sessionBases(配置驱动的额外基座)', () => {
  it('未配置 ⇒ 空 ⇒ 只剩 $DSH_HOME 与 ~/.dsh 两个通用基座', () => {
    expect(extraSessionBases({ home: '/H', sessionBases: null })).toEqual([])
    expect(sessionBases({ home: '/H', dshHome: null, sessionBases: null })).toEqual([join('/H', '.dsh')])
    expect(sessionRoots({ home: '/H', dshHome: null, sessionBases: null })).toEqual([join('/H', '.dsh', 'sessions')])
  })

  it('逗号分隔:去空白、丢空项、去重;`~` 按注入的 home 展开,绝对路径原样', () => {
    const opts = { home: '/H', sessionBases: ` /A , ${EXTRA} ,${EXTRA},, /A ` }
    expect(extraSessionBases(opts)).toEqual(['/A', join('/H', EXTRA_NAME)])
  })

  it('顺序即优先级:$DSH_HOME 居首,配置基座次之,~/.dsh 兜底', () => {
    expect(sessionBases({ home: '/H', dshHome: '/X', sessionBases: `/A,${EXTRA}` }))
      .toEqual(['/X', '/A', join('/H', EXTRA_NAME), join('/H', '.dsh')])
  })

  it(`默认读 process.env.${SESSION_BASES_ENV}(显式不传 sessionBases)`, () => {
    const prev = process.env[SESSION_BASES_ENV]
    try {
      process.env[SESSION_BASES_ENV] = `/E1,${EXTRA}`
      expect(extraSessionBases({ home: '/H' })).toEqual(['/E1', join('/H', EXTRA_NAME)])
      process.env[SESSION_BASES_ENV] = '   '
      expect(extraSessionBases({ home: '/H' })).toEqual([])
    } finally {
      if (prev === undefined) delete process.env[SESSION_BASES_ENV]
      else process.env[SESSION_BASES_ENV] = prev
    }
  })
})

describe('sessionRoots / activeSessionsRoot', () => {
  it('候选顺序:$DSH_HOME 优先,配置基座次之,旧 home 兜底(有序去重)', () => {
    expect(sessionRoots({ home: '/H', dshHome: '/X', sessionBases: EXTRA })).toEqual([
      '/X/sessions',
      join('/H', EXTRA_NAME, 'sessions'),
      join('/H', '.dsh', 'sessions'),
    ])
    expect(sessionRoots({ home: '/H', dshHome: null, sessionBases: EXTRA })).toEqual([
      join('/H', EXTRA_NAME, 'sessions'),
      join('/H', '.dsh', 'sessions'),
    ])
  })

  it('DSH_HOME 与旧 home 同为一个目录时去重', () => {
    expect(sessionRoots({ home: '/H', dshHome: '/H/.dsh', sessionBases: EXTRA })).toEqual([
      join('/H', '.dsh', 'sessions'),
      join('/H', EXTRA_NAME, 'sessions'),
    ])
  })

  it('活动基座 = 候选里第一个真实存在的 sessions 目录(两基座都在 → 配置基座)', () => {
    const home = tmpRoot()
    mkSession(home, EXTRA_NAME, '--w--', 'extraonly', V3)
    // 只有配置基座存在 → 配置基座
    expect(activeSessionsRoot({ home, dshHome: null, sessionBases: EXTRA }))
      .toBe(join(extraDir(home), 'sessions'))
    // 两基座都在 → 配置基座优先(口径统一;此前旧 home 优先)
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    expect(activeSessionsRoot({ home, dshHome: null, sessionBases: EXTRA }))
      .toBe(join(extraDir(home), 'sessions'))
    // 设了 DSH_HOME → 它排第一
    const other = tmpRoot()
    mkSession(other, '', '--w--', 'x1', V3)
    expect(activeSessionsRoot({ home, dshHome: other, sessionBases: EXTRA })).toBe(join(other, 'sessions'))
  })

  it('只有旧 home 存在 → 兜底 ~/.dsh(与生成器 resolveHome 的兜底一致)', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    expect(activeSessionsRoot({ home, dshHome: null, sessionBases: EXTRA })).toBe(join(home, '.dsh', 'sessions'))
  })

  it('候选都不存在:未设 DSH_HOME → 兜底旧 home;设了 → 仍以 DSH_HOME 为首选', () => {
    const home = tmpRoot()
    expect(activeSessionsRoot({ home, dshHome: null, sessionBases: EXTRA })).toBe(join(home, '.dsh', 'sessions'))
    const dsh = tmpRoot()
    expect(activeSessionsRoot({ home, dshHome: dsh, sessionBases: EXTRA })).toBe(join(dsh, 'sessions'))
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
    // 旧断言 `SESSION_FILE_NAMES[0] === V3` 已不成立:实现补了 **v4 世代**
    // （lib/platform/session-paths.js，依据
    // ⇒ 平局时数组序里**世代最高者**优先,首位是 v4 而不是 v3。
    const c = join(dir, V4)
    writeFileSync(c, '{}\n'); utimesSync(c, new Date(T0), new Date(T0))
    expect(pickSessionFile(dir)).toBe(c)
    expect(SESSION_FILE_NAMES[0]).toBe(V4)
    // v4 不在时,同一数组序继续取 v3（原断言要锁的语义仍在,只是往后挪了一代）
    rmSync(c)
    expect(pickSessionFile(dir)).toBe(a)
    expect(SESSION_FILE_NAMES[1]).toBe(V3)
  })

  it('都没命中返回 null', () => {
    expect(pickSessionFile(tmpRoot())).toBe(null)
  })
})

describe('sessionFilePath(① / $DSH_HOME ② / 配置基座优先 ③ / 旧 home 兜底)', () => {
  it('① DSH_HOME 设了 → 只在 DSH_HOME 下解析', () => {
    const home = tmpRoot()
    const dsh = tmpRoot()
    const inOld = mkSession(home, '.dsh', '--w--', 'same', V0)
    const inDsh = mkSession(dsh, '', '--w--', 'same', V3)
    expect(inOld).not.toBe(inDsh) // 防呆:两个不同文件
    expect(sessionFilePath('same', { home, dshHome: dsh, sessionBases: EXTRA })).toBe(inDsh)
  })

  it('② 未设 DSH_HOME 且两基座都有该会话 → 配置基座优先(口径统一后的行为变更)', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'both', V0)
    const inExtra = mkSession(home, EXTRA_NAME, '--w--', 'both', V3)
    expect(sessionFilePath('both', { home, dshHome: null, sessionBases: EXTRA })).toBe(inExtra)
  })

  it('③ 未设 DSH_HOME 且只有旧 home 有该会话 → 兜底旧 home', () => {
    const home = tmpRoot()
    const inOld = mkSession(home, '.dsh', '--w--', 'oldonly', V0)
    expect(sessionFilePath('oldonly', { home, dshHome: null, sessionBases: null })).toBe(inOld)
  })

  it('③b 未设 DSH_HOME 且会话只在配置基座 → 命中配置基座', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'someother', V0) // 旧 home 存在,但没有目标会话
    const inExtra = mkSession(home, EXTRA_NAME, '--w--', 'extraonly', V3)
    expect(sessionFilePath('extraonly', { home, dshHome: null, sessionBases: EXTRA })).toBe(inExtra)
  })

  it('③c 未配置额外基座且会话只在旧 home 之外 → 找不到(null,不猜路径)', () => {
    const home = tmpRoot()
    mkSession(home, EXTRA_NAME, '--w--', 'extraonly', V3)
    expect(sessionFilePath('extraonly', { home, dshHome: null, sessionBases: null })).toBe(null)
  })

  it('会话不存在 → null', () => {
    expect(sessionFilePath('nope', { home: tmpRoot(), dshHome: null, sessionBases: null })).toBe(null)
  })

  it('默认读 process.env.DSH_HOME(显式不传 dshHome)', () => {
    const prev = process.env.DSH_HOME
    const dsh = tmpRoot()
    const f = mkSession(dsh, '', '--w--', 'envhit', V3)
    try {
      process.env.DSH_HOME = dsh
      expect(sessionFilePath('envhit', { sessionBases: null })).toBe(f)
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
    const got = matchSessionFiles('abz', { home, dshHome: null, sessionBases: null })
      .sort((x, y) => x.dir.localeCompare(y.dir))
    expect(got.map((g) => g.dir)).toEqual(['abz98765', 'session-abz98765'])
    expect(got.map((g) => g.file)).toEqual([byId, byDir])
    expect(matchSessionFiles('session-abz98765', { home, dshHome: null, sessionBases: null })).toHaveLength(1)
    expect(matchSessionFiles('zzz', { home, dshHome: null, sessionBases: null })).toEqual([])
  })
})

describe('badgeTableCandidates / resolveBadgeTablePath', () => {
  it('覆写 env 排第一;规范落点(插件数据家下)次之;基座旁兜底', () => {
    // 谱系标识表是**用户自备数据**,不是代码 ⇒ 代码里不得出现任何私有目录名。
    // 规范落点 = <pluginDataHome>/dsh-retrace/codes.json(与会话基座同源)。
    const canonical = join(pluginDataHome({ home: '/H', dshHome: null, sessionBases: null }), 'dsh-retrace', 'codes.json')
    const c = badgeTableCandidates({ home: '/H', override: '/O/t.json', dshHome: null, sessionBases: EXTRA })
    expect(c[0]).toBe('/O/t.json')
    expect(c[1]).toBe(canonical)
    expect(c).toEqual([...new Set(c)])
    // 配置基座旁的旧落点也在候选里(与会话基座同源,不是写死的目录名)
    expect(c).toContain(join('/H', EXTRA_NAME, '会话短码表.json'))
    expect(badgeTableCandidates({ home: '/H', override: null, dshHome: null, sessionBases: null })[0]).toBe(canonical)
  })

  it('取第一个存在的落点;**只读**(不写文件)', () => {
    // ⚠️ 本用例**必须**显式传 `dshHome: null`:pluginDataHome() 的实现是 `$DSH_HOME` 优先,
    // 不传就退回读进程环境 ⇒ 设了 `DSH_HOME` 时 dataHome 会解析成**活家**,
    // 下面的 writeFileSync 就把用户真谱系标识表覆盖成空表。
    // (回归:全量测试不得触碰真实插件数据目录)
    const home = tmpRoot()
    const dataHome = pluginDataHome({ home, dshHome: null, sessionBases: null })
    const canonical = join(dataHome, 'dsh-retrace', 'codes.json')
    mkdirSync(join(dataHome, 'dsh-retrace'), { recursive: true })
    writeFileSync(canonical, '{"codes":{}}\n')
    expect(resolveBadgeTablePath({ home, override: null, dshHome: null, sessionBases: null })).toBe(canonical)
    const override = join(home, 'override.json')
    writeFileSync(override, '{"codes":{}}\n')
    expect(resolveBadgeTablePath({ home, override, dshHome: null, sessionBases: null })).toBe(override)
    // 候选都不存在 → 返回首选(调用方读取失败自行兜底),不抛错
    const empty = tmpRoot()
    expect(resolveBadgeTablePath({ home: empty, override: null, dshHome: null, sessionBases: null }))
      .toBe(join(pluginDataHome({ home: empty, dshHome: null, sessionBases: null }), 'dsh-retrace', 'codes.json'))
  })
})

/**
 * pluginDataHome —— 插件数据家(快照 / 存储根 / profiles 默认落点)与会话基座**同源**。
 * 变更点:未设 $DSH_HOME 且配置基座与 ~/.dsh 都在时,插件数据家由旧行为 ~/.dsh 改为
 * 配置基座(改前 = 官方 resolveDshHome 口径,数据落旧 home 而会话读配置基座 ⇒ 存储分裂)。
 */
describe('pluginDataHome(插件数据家:与会话基座同源)', () => {
  it('① DSH_HOME 设了 → 逐字用它(含 ~ 展开/resolve,与官方 resolveDshHome 的 env 分支一致)', () => {
    // 向后兼容:设了 env 时行为与改前(官方 resolveDshHome)**逐字一致**。
    expect(pluginDataHome({ home: '/H', dshHome: '/X', sessionBases: null })).toBe('/X')
    // 目录不存在也照样返回(官方同样不检查存在性)
    expect(pluginDataHome({ home: '/H', dshHome: join('/no', 'such', 'home'), sessionBases: null })).toBe('/no/such/home')
    // ~ / 相对路径规范化 = 官方 expandHomePath + resolve
    expect(pluginDataHome({ home: '/H', dshHome: '~/x', sessionBases: null })).toBe(join(homedir(), 'x'))
    expect(pluginDataHome({ home: '/H', dshHome: '~', sessionBases: null })).toBe(resolve(homedir()))
    expect(pluginDataHome({ home: '/H', dshHome: 'rel-home', sessionBases: null })).toBe(resolve('rel-home'))
    // 设了 env 就**不**看基座(即使两基座都在)
    const home = tmpRoot()
    mkSession(home, EXTRA_NAME, '--w--', 'extraone', V3)
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    expect(pluginDataHome({ home, dshHome: '/X', sessionBases: EXTRA })).toBe('/X')
  })

  it('② 未设 DSH_HOME 且两基座都在 → 数据家 = 会话基座(配置基座),不再分裂到旧 home', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'old1', V0)
    mkSession(home, EXTRA_NAME, '--w--', 'extraone', V3)
    const sessionBase = dirname(activeSessionsRoot({ home, dshHome: null, sessionBases: EXTRA }))
    expect(sessionBase).toBe(extraDir(home))
    expect(pluginDataHome({ home, dshHome: null, sessionBases: EXTRA })).toBe(extraDir(home))
    // 同源不变式(活动基座存在 ⇒ 数据家 === 会话基座)
    expect(pluginDataHome({ home, dshHome: null, sessionBases: EXTRA })).toBe(sessionBase)
    // 改前行为(官方口径)是旧 home —— 显式对照,防回归到 ~/.dsh
    expect(pluginDataHome({ home, dshHome: null, sessionBases: EXTRA })).not.toBe(join(home, '.dsh'))
  })

  it('③ 未设 DSH_HOME 且只有 ~/.dsh → 两边都兜底旧 home(与读端同基座)', () => {
    const home = tmpRoot()
    mkSession(home, '.dsh', '--w--', 'oldonly', V0)
    expect(activeSessionsRoot({ home, dshHome: null, sessionBases: EXTRA })).toBe(join(home, '.dsh', 'sessions'))
    expect(pluginDataHome({ home, dshHome: null, sessionBases: EXTRA })).toBe(join(home, '.dsh'))
  })

  it('④ 还没有 sessions/(全新基座):配置基座目录存在 → 仍选配置基座;都不在 → 兜底 ~/.dsh', () => {
    const home = tmpRoot()
    expect(pluginDataHome({ home, dshHome: null, sessionBases: null })).toBe(join(home, '.dsh')) // 全空
    mkdirSync(extraDir(home), { recursive: true })                            // 只有裸基座目录
    expect(pluginDataHome({ home, dshHome: null, sessionBases: EXTRA })).toBe(extraDir(home))
    const other = tmpRoot()
    mkdirSync(join(other, '.dsh'), { recursive: true })
    expect(pluginDataHome({ home: other, dshHome: null, sessionBases: null })).toBe(join(other, '.dsh'))
  })

  it('⑤ 同源不变式(存在任一 sessions/ ⇒ 数据家 === 会话基座父目录):遍历候选存在组合', () => {
    for (const bases of [[EXTRA_NAME], ['.dsh'], [EXTRA_NAME, '.dsh']]) {
      const home = tmpRoot()
      for (const b of bases) mkSession(home, b, '--w--', `s-${b}`, V3)
      const opts = { home, dshHome: null, sessionBases: EXTRA }
      expect(pluginDataHome(opts)).toBe(dirname(activeSessionsRoot(opts)))
    }
  })

  it('⑥ 默认读 process.env.DSH_HOME;空白 env = 未设(与官方 resolveDshHome 同)', () => {
    const prev = process.env.DSH_HOME
    try {
      process.env.DSH_HOME = '/env/home'
      expect(pluginDataHome({ home: '/H', sessionBases: null })).toBe('/env/home')
      process.env.DSH_HOME = '   '
      expect(pluginDataHome({ home: '/H', sessionBases: null })).toBe(join('/H', '.dsh'))
    } finally {
      if (prev === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = prev
    }
  })
})

/**
 * 口径守卫(源码级):三个"插件数据落点"不得再各自 import 官方 home resolver
 * (@deepseek-ai/dsh-home-paths 只认 $DSH_HOME → ~/.dsh,不认识配置基座)。
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
