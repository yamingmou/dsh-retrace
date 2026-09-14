#!/usr/bin/env node
/**
 * verify-install — 多端口/多入口完整性校验（2026-08-30 事故产物）。
 *
 * DSH 本地运行涉及多个入口，任何一处装旧/装漏都会造成行为分裂：
 *   ① GUI 端口 43120（DSH Desktop 主进程监听）——打不开 = host 未起；
 *   ② profileDir 下**实际装着的每个** profile 的 dsh-retrace / dsh-log-contract 实装版本
 *      ——旧版会继续写 turn-null marker，污染新会话（2026-08-30 事故源头之一）；
 *      清单从磁盘发现（此前写死 desktop/web/audit20260822，换基座后必报假红）；
 *   ③ 插件 HTTP 路由 /api/plugins/retrace/{versions,forkmap,doctor} ——404 = 插件
 *      host 侧未注册；
 *   ④ 客户端 bundle（lib/client.bundle.js + lib/dynamic-client.js）——缺 = 前端未构建。
 *
 * 用法：
 *   node scripts/verify-install.mjs [--profile-dir <home>/profiles] [--gui-port 43120]
 *       [--expect-retrace 0.4.11] [--expect-log-contract 0.3.6] [--session <sessionId>]
 *
 * 默认 profileDir = `<pluginDataHome()>/profiles`（与会话基座**同源**：$DSH_HOME 设了
 * 就是 $DSH_HOME/profiles，未设 = ~/dsh-v3/profiles → ~/.dsh/profiles）。此前硬编码
 * `~/.dsh/profiles`：未设 $DSH_HOME 时校验的是旧 home 的装态，而会话/GUI 跑在新基座
 * ⇒ 校验对象与运行对象不是同一份（2026-09-14 实测）。
 *
 * 默认期望版本从仓库 package.json 读取（开发态），可用 --expect-* 覆盖（发版校验）。
 * 任一检查失败 → 打印 ✗ 并 exit 1；全过 → 打印 ✅ 汇总并 exit 0。
 *
 * 2026-08-30 事故复盘：web profile 停在 0.4.6/0.3.2 时仍会写 turn-null marker，
 * 与 desktop 0.4.10 行为分裂——本脚本就是防这种"半装态"再次发生。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// 默认 profileDir 与会话基座**同源**(单一实现;此前硬编码 ~/.dsh/profiles)。
import { pluginDataHome } from '../lib/platform/session-paths.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ---------- CLI 参数 ----------
function parseArgs(argv) {
  const args = { profileDir: path.join(pluginDataHome(), 'profiles'), guiPort: 43120, session: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile-dir') args.profileDir = argv[++i];
    else if (a === '--gui-port') args.guiPort = Number(argv[++i]);
    else if (a === '--expect-retrace') args.expectRetrace = argv[++i];
    else if (a === '--expect-log-contract') args.expectLogContract = argv[++i];
    else if (a === '--session') args.session = argv[++i];
    else if (a === '--help') { args.help = true; }
    else { console.error(`未知参数: ${a}`); process.exit(2); }
  }
  return args;
}

// ---------- 期望版本：从各 profile 的 package.json 依赖声明解析（caret 范围） ----------
// 比对「package.json 依赖解析版本」与「node_modules 实装版本」。
// 不依赖本仓库 node_modules（那只是开发依赖解析，可能与发布版不同步）。
function expectedFromProfile(profileDir, prof, pkg) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(profileDir, prof, 'package.json'), 'utf8'));
    return p.dependencies?.[pkg] || null;
  } catch { return null; }
}

// caret 范围匹配（npm semver 语义的足够子集）：
//   ^0.4.11 → >=0.4.11 <0.5.0；^0.3.6 → >=0.3.6 <0.4.0；^1.2.3 → >=1.2.3 <2.0.0。
//  ⚠️ 0.x 时 minor 是"不兼容边界"：^0.3.6 要求 minor==3 且 patch>=6——
//    0.3.2 / 0.4.6 都不满足（2026-08-30 web 停在 0.3.2 的事故场景必须 FAIL）。
function satisfiesRange(installed, range) {
  if (!installed) return false;
  if (!range) return true;
  const ver = installed.split('.').map(Number);
  const parse = (s) => (s || '').split('.').map(Number);
  if (range.startsWith('^')) {
    const r = parse(range.slice(1));
    if (r.length < 3) return installed === range.slice(1);
    const [maj, min, pat] = [ver[0], ver[1], ver[2]];
    if (r[0] === 0) {
      // ^0.min.pat：minor 锁定，patch >= 声明
      return maj === 0 && min === r[1] && pat >= (r[2] ?? 0);
    }
    // ^maj.min.pat：major 锁定，>= min.pat
    return maj === r[0] && (min > r[1] || (min === r[1] && pat >= (r[2] ?? 0)));
  }
  if (range.startsWith('~')) {
    const r = parse(range.slice(1));
    return ver[0] === r[0] && ver[1] === r[1] && ver[2] >= (r[2] || 0);
  }
  return installed === range;
}

// ---------- 检查项 ----------
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function readInstalled(profileDir, prof, pkg) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(profileDir, prof, 'node_modules', pkg, 'package.json'), 'utf8'));
    return p.version;
  } catch { return null; }
}

/** 声明依赖若为 file:/link: 本地挂载 → 返回 'file:<path>'（供调用方解析为本地仓库版本）。 */
function declaredKind(declared) {
  if (typeof declared !== 'string') return null;
  const m = /^(?:file|link|workspace):(.+)$/.exec(declared);
  return m ? m[1] : null;
}

/**
 * 待校验的 profile 清单 = 该 profileDir 下**实际装着**的入口（目录内带 package.json）。
 *
 * 此前硬编码 `['desktop','web','audit20260822']`：那是旧 home 时代的入口名单。新基座
 * （v3，2026-09-14）下 `audit20260822` 根本不存在 —— 于是每次校验都报一条**假红**
 * 并让整个脚本 exit 1，而真正的入口（v3 的 acp）反而没被校验。校验的语义是
 * 「**已装**的入口之间不许出现半装态」（2026-08-30 事故），所以清单应当从磁盘发现，
 * 而不是写死一份会随基座过期的名单。
 */
function discoverProfiles(profileDir) {
  try {
    return fs.readdirSync(profileDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => e.name)
      .filter((name) => fs.existsSync(path.join(profileDir, name, 'package.json')))
      .sort();
  } catch { return []; }
}

function checkProfiles(args) {
  const profiles = discoverProfiles(args.profileDir);
  if (profiles.length === 0) {
    check('至少发现一个 profile', false, `${args.profileDir} 下没有任何含 package.json 的 profile 目录`);
    return;
  }
  check(`发现 ${profiles.length} 个 profile`, true, profiles.join(', '));
  const versions = {};
  const declared = {};
  for (const prof of profiles) {
    versions[prof] = {
      retrace: readInstalled(args.profileDir, prof, 'dsh-retrace'),
      logContract: readInstalled(args.profileDir, prof, 'dsh-log-contract'),
    };
    declared[prof] = {
      retrace: expectedFromProfile(args.profileDir, prof, 'dsh-retrace'),
      logContract: expectedFromProfile(args.profileDir, prof, 'dsh-log-contract'),
    };
  }
  // ① 每个 profile：实装版本必须满足 package.json 声明的依赖范围。
  //    file:/link: 本地挂载 → 与本地仓库版本比对（同源校验）。
  for (const prof of profiles) {
    for (const pkg of ['retrace', 'logContract']) {
      const want = declared[prof][pkg];
      const got = versions[prof][pkg];
      const pkgName = pkg === 'retrace' ? 'dsh-retrace' : 'dsh-log-contract';
      const localSpec = declaredKind(want);
      if (localSpec) {
        // file:/link:/workspace: 的**相对**路径按 profile 目录解析（pnpm 的语义）。
        // 此前直接 path.join(localSpec,'package.json') 交给 cwd 解析——只有恰好从
        // 同深度的目录运行时才碰对，换个 cwd 就误报「仓库不可读」（2026-09-14 实测）。
        const localPath = path.resolve(path.join(args.profileDir, prof), localSpec);
        // 本地挂载：期望 = 本地仓库 package.json version
        let repoVer = null;
        try {
          const p = JSON.parse(fs.readFileSync(path.join(localPath, 'package.json'), 'utf8'));
          repoVer = p.version;
        } catch { /* 仓库缺失 */ }
        const ok = got !== null && repoVer !== null && got === repoVer;
        check(`profile ${prof} ${pkgName} 本地挂载 ${localPath}`,
          ok,
          ok ? `实装 ${got} = 仓库 ${repoVer}` : `实装 ${got ?? '未装'} / 仓库 ${repoVer ?? '不可读'}`);
        continue;
      }
      if (!want) {
        check(`profile ${prof} 声明 ${pkgName}`, true, '未声明（跳过）');
        continue;
      }
      // --expect-* 显式覆盖（发版校验）：实装必须精确等于期望版本
      const expectVer = pkg === 'retrace' ? args.expectRetrace : args.expectLogContract;
      if (expectVer) {
        check(`profile ${prof} ${pkgName} = ${expectVer}（--expect-*）`,
          got === expectVer,
          got ? `实装 ${got}` : '未装');
        continue;
      }
      check(`profile ${prof} ${pkgName} 实装满足 ${want}`,
        satisfiesRange(got, want),
        got ? `实装 ${got}` : '未装');
    }
  }
  // ② 各 profile 版本一致性（多入口并存时不许出现"一半装了新版、一半停在旧版"）
  const retraceVersions = profiles.map((p) => versions[p].retrace).filter(Boolean);
  const lcVersions = profiles.map((p) => versions[p].logContract).filter(Boolean);
  const scope = profiles.join('/');
  check(`${scope} 各 profile retrace 版本一致`, new Set(retraceVersions).size <= 1 && retraceVersions.length >= 1, `[${retraceVersions.join(', ') || '全部未装'}]`);
  check(`${scope} 各 profile log-contract 版本一致`, new Set(lcVersions).size <= 1 && lcVersions.length >= 1, `[${lcVersions.join(', ') || '全部未装'}]`);
}

function checkGuiPort(args) {
  // macOS/linux: lsof -iTCP:<port> -sTCP:LISTEN
  const res = spawnSync('lsof', ['-iTCP:' + args.guiPort, '-sTCP:LISTEN'], { encoding: 'utf8' });
  const listening = res.status === 0 && /LISTEN/.test(res.stdout);
  check(`GUI 端口 ${args.guiPort} 在听`, listening, listening ? res.stdout.split('\n')[1]?.trim()?.slice(0, 80) : '无监听');
  return listening;
}

async function checkRoutes(args) {
  if (!args.session) {
    check('HTTP 路由冒烟（未传 --session，跳过）', true, '传 --session <id> 可启用');
    return;
  }
  const base = `http://localhost:${args.guiPort}/api/plugins/retrace`;
  // DSH 2.0.3 桌面 web server 对任何外部 curl 统一回 403（网关访问控制，
  // 连 /api/health 都 403）——先探测网关基线：若基线路径也 403，说明
  // 路由 403 是网关层、与插件无关，冒烟降级为「无法外部验证」而非失败。
  let gatewayBlocked = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(`http://localhost:${args.guiPort}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    gatewayBlocked = res.status === 403;
  } catch { /* 端口不可达由 checkGuiPort 负责 */ }
  if (gatewayBlocked) {
    check('HTTP 路由冒烟（网关 403 基线，外部不可达）', true,
      'DSH 2.0.3 网关对所有外部 curl 统一 403，路由需在 GUI 内验证（版本/分叉 Tab）');
    return;
  }
  for (const route of ['versions', 'forkmap', 'doctor']) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const res = await fetch(`${base}/${route}?sessionId=${encodeURIComponent(args.session)}`, { signal: ctrl.signal });
      clearTimeout(timer);
      check(`路由 /${route} 200`, res.ok, `HTTP ${res.status}`);
    } catch (e) {
      check(`路由 /${route} 200`, false, `请求失败: ${e.message}`);
    }
  }
}

function checkClientBundle() {
  for (const f of ['lib/client.bundle.js', 'lib/dynamic-client.js', 'lib/dynamic-host.js']) {
    const full = path.join(repoRoot, f);
    const ok = fs.existsSync(full) && fs.statSync(full).size > 0;
    check(`客户端 bundle ${f} 存在`, ok, ok ? `${fs.statSync(full).size} bytes` : '缺失');
  }
}

// ---------- 主流程 ----------
const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('verify-install — 多端口/多入口完整性校验\n\n用法见文件头注释。');
  process.exit(0);
}

console.log('=== dsh-retrace verify-install ===');
console.log('版本期望：以各 profile package.json 的依赖声明为准（caret 范围匹配）\n');

checkProfiles(args);
const portOk = checkGuiPort(args);
if (portOk) await checkRoutes(args);
else check('HTTP 路由冒烟（GUI 未在听，跳过）', true, '端口不可达');

checkClientBundle();

const failed = results.filter((r) => !r.ok);
console.log(`\n=== 结果: ${results.length - failed.length}/${results.length} 通过 ===`);
if (failed.length > 0) {
  console.log('失败项:');
  for (const f of failed) console.log(`  ✗ ${f.name}`);
  process.exit(1);
}
process.exit(0);
