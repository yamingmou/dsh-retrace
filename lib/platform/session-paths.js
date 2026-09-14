/**
 * dsh-retrace — lib/platform/session-paths.js
 *
 * 会话文件落点的**单一实现**(2026-09-14)。此前 dsh.js(两处)/watchdog.js/
 * archaeology-cli.js 与实测脚本各自硬编码 `join(homedir(), '.dsh', 'sessions')`:
 * 基座换代(旧 home → 新基座)时"各写一份"必然分叉,读端会扫错基座,把短码序号、
 * 遮蔽范围一起算错。这里收敛成一份,所有读端只从这里取。
 *
 * 判据(2026-09-14 口径统一,与短码表生成器的
 * resolveHome() **逐字同序**):
 *   · sessions 根候选顺序 = [$DSH_HOME/sessions(设了才排第一), ~/dsh-v3/sessions
 *     (新基座, 存在即优先 —— 迁移已完成,当前现实是 v3), ~/.dsh/sessions(旧 home,
 *     兜底)];**活动基座** = 候选里第一个真实存在的目录(两套会话表混扫会把序号
 *     算错,故只取一个);都不存在时:设了 $DSH_HOME 仍以它为首选,未设则兜底旧 home。
 *     ⚠️ 行为变更:未设 $DSH_HOME 且两基座都在时,由「旧 home 优先」改为「新基座
 *     优先」(旧行为会读到 ~/.dsh 的历史/迁移残留表;未设 $DSH_HOME 本就是非常态)。
 *   · 会话文件名两种都认:session.v3.jsonl.zstd(新基座)/ session.jsonl.zstd(旧基座);
 *     同一会话目录两者并存时取 **mtime 较新**的一份(写入端只续写当前基座那份,旧残档
 *     停在早期时间;mtime 平局时按 SESSION_FILE_NAMES 顺序,即新基座优先)。
 *   · 短码表落点(另一类"固定落点",与基座同批收敛)= 覆写 env → 规范落点
 *     (生成器默认输出)→ 基座旁,取第一个存在者。
 *   · **插件数据家**(pluginDataHome,2026-09-14 补)= 插件自有数据(watchdog 快照、
 *     versioning 存储根、verify-install 的 profiles 默认落点)的 home,口径与
 *     **会话基座同源**。官方 `@deepseek-ai/dsh-home-paths` 的 `resolveDshHome()`
 *     只认 `$DSH_HOME → ~/.dsh`,不认识 `~/dsh-v3`;三者原先各自调它 ⇒ 未设
 *     `$DSH_HOME` 且两基座都在时「会话读 ~/dsh-v3、快照/存储写 ~/.dsh」(存储分裂)。
 *     判据见 pluginDataHome()。
 *
 * 可测试/可复现:所有函数都接受 `{ home, dshHome }` 覆写(默认取 os.homedir() /
 * process.env.DSH_HOME),显式传 `dshHome: null` 即"当作未设 DSH_HOME",测试无需
 * 改进程环境。
 */
import { accessSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

/** 两种会话文件名(数组顺序 = mtime 平局时的优先级:新基座在前)。 */
export const SESSION_FILE_NAMES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']
export const V3_SESSION_FILE = SESSION_FILE_NAMES[0]
export const V0_SESSION_FILE = SESSION_FILE_NAMES[1]

/** 短码表落点覆写变量(生成器 `--table` 的读端对应物)。 */
export const BADGE_TABLE_ENV = 'DSH_RETRACE_BADGE_TABLE'

/** 解析生效的 home(显式覆写 → os.homedir())。 */
function homeOf(opts) {
  return opts.home ?? homedir()
}

/** 解析生效的 DSH_HOME:`undefined` = 读环境;显式 null/'' = 当作未设。 */
function dshHomeOf(opts) {
  if (opts.dshHome !== undefined) return opts.dshHome || null
  return process.env.DSH_HOME || null
}

/**
 * 官方 `resolveDshHome()` 的路径规范化语义(逐字等价):`~` / `~/` / `~\` 按 OS home
 * 展开,再 `resolve()` 绝对化。设了 $DSH_HOME 时本模块要**与官方 resolver 行为一致**
 * (向后兼容),故这里不做"自己的"路径猜测,只照抄官方三条分支。
 */
function normalizeHome(p) {
  if (p === '~') return resolve(homedir())
  if (p.startsWith('~/') || p.startsWith('~\\')) return resolve(join(homedir(), p.slice(2)))
  return resolve(p)
}

/** sessions 根候选(有序去重):$DSH_HOME 优先,新基座次之,旧 home 兜底。 */
export function sessionRoots(opts = {}) {
  const home = homeOf(opts)
  const dshHome = dshHomeOf(opts)
  const cands = []
  if (dshHome) cands.push(join(dshHome, 'sessions'))
  cands.push(join(home, 'dsh-v3', 'sessions'))
  cands.push(join(home, '.dsh', 'sessions'))
  return [...new Set(cands)]
}

/**
 * 活动基座根:候选里第一个存在的 sessions 目录。
 * 都不存在时与生成器 resolveHome() 对齐:设了 $DSH_HOME 仍以它为首选(生成器会因
 * sessions/ 缺失而拒绝执行,读端保持宽容、不静默换基座);未设则兜底旧 home。
 */
export function activeSessionsRoot(opts = {}) {
  const roots = sessionRoots(opts)
  for (const r of roots) {
    try { accessSync(r); return r } catch { /* 试下一个候选 */ }
  }
  return dshHomeOf(opts) ? roots[0] : join(homeOf(opts), '.dsh', 'sessions')
}

/**
 * **插件数据家**(plugin data home)= 插件自有数据(快照 / 存储根 / profiles 落点)的
 * home,口径**与会话基座同源**(不是"官方家目录")。
 *
 * 为什么取"同源"口径而不是官方 `resolveDshHome()`:官方只认
 * `$DSH_HOME → ~/.dsh`,不认识 `~/dsh-v3`。插件数据若走官方口径,未设 `$DSH_HOME`
 * 且两基座都在时就会「会话读 `~/dsh-v3`、快照/存储写 `~/.dsh`」——数据自洽(读写同一
 * resolver)但**存储分裂**,回滚/GC/核对看到的不是会话所在的那一份(2026-09-14 实测)。
 *
 * 判据(有序,先命中先返回):
 *   ① `$DSH_HOME` 设了(非空白)→ **逐字用它**:`normalizeHome()` 与官方
 *      `resolveDshHome()` 的 env 分支完全相同(`~`/`~/` 展开 + `resolve()` 绝对化;
 *      空白视作未设,同官方)。⇒ 设了 env 时行为与改前**逐字一致**。
 *   ② 未设 → 取**活动会话基座**的父目录(判据 = `<base>/sessions` 存在,与
 *      `activeSessionsRoot()` 同一候选序与同一存在判据)⇒ 只要存在任一 sessions/
 *      目录,`pluginDataHome() === dirname(activeSessionsRoot())`(**同源不变式**,测试钉住)。
 *   ③ 没有任何 sessions/(全新基座,会话读端也还没落地)→ 仍按同一候选序取"存在的
 *      基座目录"(`~/dsh-v3` → `~/.dsh`),让插件数据跟着新基座走;都不存在 → 兜底
 *      `~/.dsh`(与 `activeSessionsRoot()` 的兜底一致)。
 *
 * 已知边界(如实记录,非本函数职责):会话侧的 `dshHomeOf()` 把空白 `DSH_HOME` 当作
 * **设了**(`'   '` 仍是真值);本函数按官方契约把空白当未设。空白 env 是退化态。
 */
export function pluginDataHome(opts = {}) {
  const dshHome = dshHomeOf(opts)
  if (dshHome && dshHome.trim().length > 0) return normalizeHome(dshHome)
  // ② 活动会话基座(同一候选序 + 同一存在判据:<base>/sessions)
  for (const root of sessionRoots({ ...opts, dshHome: null })) {
    try { accessSync(root); return dirname(root) } catch { /* 试下一个候选 */ }
  }
  // ③ 还没有 sessions/:按基座目录存在性同一候选序(新基座 → 旧 home)
  const home = homeOf(opts)
  for (const base of [join(home, 'dsh-v3'), join(home, '.dsh')]) {
    try { accessSync(base); return base } catch { /* 试下一个候选 */ }
  }
  return join(home, '.dsh')
}

/** 单会话目录里挑会话文件:两种名都认,并存取 mtime 新者;都没命中返回 null。 */
export function pickSessionFile(sessionDir) {
  let best = null
  let bestM = -Infinity
  for (const name of SESSION_FILE_NAMES) {
    const p = join(sessionDir, name)
    try {
      const m = statSync(p).mtimeMs
      if (m > bestM) { bestM = m; best = p }
    } catch { /* 该名不存在,试下一个 */ }
  }
  return best
}

/**
 * 找 DSH 会话文件路径:按候选根逐个工作区探测两种文件名。
 * 候选有序 ⇒ 设了 $DSH_HOME 就只在 $DSH_HOME 下找;未设时先在新基座找,新基座
 * 没有该会话再兜底到旧 home(单会话不混扫,跨基座同名会话以先命中者为准)。
 * @returns {string|null} 文件路径(找不到返回 null)
 */
export function sessionFilePath(sessionId, opts = {}) {
  for (const root of sessionRoots(opts)) {
    let workspaces
    try { workspaces = readdirSync(root) } catch { continue }
    for (const workspace of workspaces) {
      const hit = pickSessionFile(join(root, workspace, String(sessionId)))
      if (hit) return hit
    }
  }
  return null
}

/**
 * 按 **id / id 前缀 / 目录名**(`<want>` 或 `session-<want>`)在候选根里找会话文件。
 * 证据脚本要的前缀检索(如某个短码前缀)与"多命中取第一个"都保留在单一实现里,
 * 脚本不再各自拼 `join(root, ws, dir, 'session.jsonl.zstd')`。
 * @returns {Array<{root:string, workspace:string, dir:string, file:string}>} 有序命中
 */
export function matchSessionFiles(want, opts = {}) {
  const out = []
  const key = String(want)
  for (const root of sessionRoots(opts)) {
    let workspaces
    try { workspaces = readdirSync(root) } catch { continue }
    for (const workspace of workspaces) {
      let dirs
      try { dirs = readdirSync(join(root, workspace)) } catch { continue }
      for (const dir of dirs) {
        if (dir !== key && !dir.startsWith(key) && !dir.startsWith(`session-${key}`)) continue
        const file = pickSessionFile(join(root, workspace, dir))
        if (file) out.push({ root, workspace, dir, file })
      }
    }
  }
  return out
}

/**
 * 枚举一个 sessions 根下的全部会话文件(读端公共骨架:短码推导/证据脚本共用)。
 * 每个会话目录只出一个条目(两种文件名并存时取 mtime 新者)。
 * @returns {Array<{workspace:string, id:string, file:string}>}
 */
export function listSessionFiles(root = activeSessionsRoot()) {
  const out = []
  let workspaces
  try { workspaces = readdirSync(root) } catch { return out }
  for (const workspace of workspaces) {
    const wsDir = join(root, workspace)
    let ids
    try { ids = readdirSync(wsDir) } catch { continue }
    for (const id of ids) {
      const file = pickSessionFile(join(wsDir, id))
      if (file) out.push({ workspace, id, file })
    }
  }
  return out
}

/**
 * 工作区目录名 → 2 位缩写（短码的工作区段，**单一实现**）。
 *
 * 会话目录名是**工作区绝对路径**把 `/` 换成 `-`、首尾再各加 `--`
 * （`/Users/<user>/proj` → `--Users-<user>-proj--`）。缩写口径：先剥掉
 * **机器相关前缀**（用户 home），再剥掉平台前缀（Users、home、Volumes 等），
 * 最后取剩下前两段的首字母；只有一段时取其前两个字符。
 *
 * ⚠️ 这里**不得**写死任何具体用户名 —— 旧实现硬编码了某一台机器的用户名，
 * 换台机器就会把工作区缩写算错（进而是错误的短码）。home 由 `os.homedir()`
 * 推出，因此本函数在任何机器上自洽。
 *
 * 归并到本模块（2026-09-14）：短码侧 `lib/identity/shortcode.js` 也要用它
 * （给不在表里的会话分配新号），而短码的工作区段与既有表**同一口径**才不出错；
 * 两份实现会在换机器时分叉 ⇒ 收敛成一份（`lib/adapter/dsh.js` 改为 import）。
 */
export function workspaceAbbr(workspace) {
  const raw = String(workspace ?? '')
  const encoded = raw.replace(/^--/, '').replace(/--$/, '')
  let rest = encoded
  const homeEnc = homedir().replace(/\//g, '-').replace(/^-+/, '').replace(/-+$/, '')
  if (homeEnc && (rest === homeEnc || rest.startsWith(homeEnc + '-'))) {
    rest = rest.slice(homeEnc.length).replace(/^-+/, '')
  } else {
    rest = rest.replace(/^-*(?:Users|home|Volumes|private|var|tmp)-/i, '')
  }
  const parts = rest.split('-').filter(Boolean)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toLowerCase()
  return (parts[0] ?? encoded).slice(0, 2).toLowerCase()
}

/**
 * 短码表候选(有序去重):覆写 env → 插件数据家下的规范落点 → 基座旁的旧落点。
 *
 * ⚠️ 这里**不得**出现任何私有目录名:短码表是**数据**(用户自备),不是代码。
 * 表的位置由 `$DSH_RETRACE_CODE_TABLE`（或 `opts.override`）指定;没指定时读
 * `<pluginDataHome>/dsh-retrace/codes.json`（本插件自己的数据家,与会话同源）。
 * `homeOf(opts)` 只用于"基座旁"这类**可推断**的落点,不做任何私有路径硬编码。
 */
export function badgeTableCandidates(opts = {}) {
  const home = homeOf(opts)
  const override = opts.override !== undefined ? opts.override : process.env[BADGE_TABLE_ENV]
  const cands = []
  if (override) cands.push(override)
  cands.push(join(pluginDataHome(opts), 'dsh-retrace', 'codes.json'))
  cands.push(join(home, '.dsh', '会话短码表.json'))
  cands.push(join(home, 'dsh-v3', '会话短码表.json'))
  return [...new Set(cands)]
}

/**
 * 取第一个存在的短码表落点(都不在 → 返回首选:调用方读取失败即自行兜底,
 * 行为与"钉死单一路径"时代一致)。**只读**——本模块不写任何表。
 */
export function resolveBadgeTablePath(opts = {}) {
  const cands = badgeTableCandidates(opts)
  for (const c of cands) {
    try { accessSync(c); return c } catch { /* 试下一个候选 */ }
  }
  return cands[0]
}

/** 身份映射(会话 id 迁移表)落点覆写变量。 */
export const IDENTITY_MAP_ENV = 'DSH_RETRACE_IDMAP'

/**
 * 身份映射候选(有序去重):覆写 env → 插件数据家下的规范落点。
 *
 * ⚠️ 同短码表:这里**不得**出现任何私有目录名 —— 映射表是**数据**(用户自备),
 * 不是代码。落点由 `$DSH_RETRACE_IDMAP`(或 `opts.override`)指定。
 */
export function identityMapCandidates(opts = {}) {
  const override = opts.override !== undefined ? opts.override : process.env[IDENTITY_MAP_ENV]
  const cands = []
  if (override) cands.push(override)
  cands.push(join(pluginDataHome(opts), 'dsh-retrace', 'idmap.identity.json'))
  return [...new Set(cands)]
}

/**
 * 取第一个存在的身份映射落点(都不在 → 返回首选;调用方读取失败即视为"无映射",
 * 行为与"没有这份数据"一致)。**只读**。
 */
export function resolveIdentityMapPath(opts = {}) {
  const cands = identityMapCandidates(opts)
  for (const c of cands) {
    try { accessSync(c); return c } catch { /* 试下一个候选 */ }
  }
  return cands[0]
}
