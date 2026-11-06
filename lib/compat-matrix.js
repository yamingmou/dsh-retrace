/**
 * dsh-retrace — compatibility matrix (pure).
 *
 * Why (0.4.140): the host's plugin-compatibility gate only inspects peers named
 * `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*`. Everything else in a plugin's
 * dependency surface — `@deepseek-ai/cordis`, `react`, `zod`, `dsh-log-contract`
 * — is never range-checked by the host: a version-drifted copy loads silently
 * and fails later as a runtime symptom. This module turns that blind spot into
 * explicit, per-item verdicts (PASS / WARN / FAIL / HOST) instead of a skip.
 *
 * Design constraints:
 *  - pure: no fs, no network, no host imports (inputs are plain data);
 *  - deterministic order (sorted names) so diffs and gate output stay stable;
 *  - fail-closed: an uncheckable declaration is never reported as PASS.
 */

/** Peers the host gate owns (mirrors `evaluatePluginCompatibility`). */
export function isHostGateName(name) {
  return name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
}

/** A range that makes the check vacuous (`*`, `x`, `latest`, `>=0.0.0`). */
export function isUnboundedRange(range) {
  if (typeof range !== 'string') return true
  const parts = range.trim().toLowerCase()
  if (parts === '' || parts === '*' || parts === 'x' || parts === 'latest') return true
  return parts.split('||').some((set) => {
    const comparators = set.trim().split(/\s+/).filter(Boolean)
    if (comparators.length === 0) return true
    return comparators.every((c) => /^(>=|<=|>|<|=)?(0|x|\*)(\.(0|x|\*))*$/.test(c.replace(/\s+/g, '')))
  })
}

/** Parse `1.2.3-rc.4+build` into comparable parts; null when unparsable. */
export function parseVersion(input) {
  if (typeof input !== 'string') return null
  const text = input.trim().replace(/^v/, '')
  const match = text.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (match === null) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

const numeric = (part) => (/^\d+$/.test(part) ? Number(part) : null)

/** Semver precedence: numeric identifiers sort before alphanumeric ones. */
function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    if (i >= a.length) return -1
    if (i >= b.length) return 1
    const an = numeric(a[i])
    const bn = numeric(b[i])
    if (an !== null && bn !== null) {
      if (an !== bn) return an < bn ? -1 : 1
      continue
    }
    if (an !== null) return -1
    if (bn !== null) return 1
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** Compare two parsed versions (or two version strings). */
export function compareVersions(a, b) {
  const left = typeof a === 'string' ? parseVersion(a) : a
  const right = typeof b === 'string' ? parseVersion(b) : b
  if (left === null || right === null) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  return comparePre(left.pre, right.pre)
}

/** `^1.2.3` / `~1.2.3` / `>=1.2.3 <2.0.0` / `1.2.3` / `1.2.x` → comparator list. */
function expandComparator(token) {
  const text = token.trim()
  if (text === '' || text === '*' || text === 'x') return []
  const op = text.match(/^(\^|~|>=|<=|>|<|=)?/)?.[1] ?? ''
  const version = parseVersion(text.slice(op.length).replace(/\.(x|\*)$/i, '.0'))
  if (version === null) return null
  const { major, minor, patch } = version
  const atLeast = { op: '>=', version: { major, minor, patch, pre: version.pre } }
  switch (op) {
    case '':
    case '=':
      return [atLeast, { op: '<=', version: { major, minor, patch, pre: version.pre } }]
    case '>':
    case '>=':
    case '<':
    case '<=':
      return [{ op, version: { major, minor, patch, pre: version.pre } }]
    case '~':
      return [atLeast, { op: '<', version: { major, minor: minor + 1, patch: 0, pre: [] } }]
    case '^': {
      // Caret: first non-zero element is the compatibility boundary.
      const upper = major > 0
        ? { major: major + 1, minor: 0, patch: 0, pre: [] }
        : minor > 0
          ? { major: 0, minor: minor + 1, patch: 0, pre: [] }
          : { major: 0, minor: 0, patch: patch + 1, pre: [] }
      return [atLeast, { op: '<', version: upper }]
    }
    default:
      return null
  }
}

function satisfiesSet(version, set) {
  const comparators = set.trim().split(/\s+/).filter(Boolean)
  for (const token of comparators) {
    const expanded = expandComparator(token)
    if (expanded === null) return null
    for (const { op, version: bound } of expanded) {
      const order = compareVersions(version, bound)
      if (order === null) return null
      if (op === '>=' && order < 0) return false
      if (op === '>' && order <= 0) return false
      if (op === '<=' && order > 0) return false
      if (op === '<' && order >= 0) return false
    }
  }
  return true
}

/**
 * Does `version` satisfy `range`? Returns `null` when either side is
 * unparsable — an uncheckable range is NOT a pass (the caller decides the level).
 */
export function satisfies(version, range) {
  const parsed = typeof version === 'string' ? parseVersion(version) : version
  if (parsed === null || typeof range !== 'string') return null
  const sets = range.split('||')
  let sawParseable = false
  for (const set of sets) {
    const result = satisfiesSet(parsed, set)
    if (result === null) continue
    sawParseable = true
    if (result) return true
  }
  return sawParseable ? false : null
}

/** Is `range` a well-formed range this module can evaluate? */
export function isValidRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return false
  if (/^[a-z]+$/i.test(range.trim()) && range.trim().toLowerCase() !== 'x') return false
  return satisfies('0.0.0', range) !== null
}

const LEVELS = ['FAIL', 'WARN', 'HOST', 'PASS']

/**
 * Evaluate the matrix.
 *
 * @param {object} input
 * @param {object} input.pkg                 parsed package.json
 * @param {Record<string,string|null>} [input.installed] resolved versions (null = not resolvable)
 * @param {string[]} [input.imports]         bare package names actually imported by shipped code
 * @param {string|null} [input.nodeVersion]  e.g. `v24.13.0`
 * @returns {{checks: Array<{level:string,rule:string,package:string,message:string}>, summary: object}}
 */
export function evaluateCompatibilityMatrix({ pkg, installed = {}, imports = [], dynamicImports = [], nodeVersion = null } = {}) {
  const checks = []
  const add = (level, rule, name, message) => checks.push({ level, rule, package: name, message })

  if (pkg === null || typeof pkg !== 'object') {
    add('FAIL', 'package', '-', 'package.json is unreadable / not an object')
    return finish(checks)
  }

  const peers = pkg.peerDependencies !== null && typeof pkg.peerDependencies === 'object' ? pkg.peerDependencies : null
  if (peers === null || Object.keys(peers).length === 0) {
    add('FAIL', 'peer-declared', '-', 'no peerDependencies block: the host gate has nothing to evaluate')
  }

  const dependencies = pkg.dependencies !== null && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  const optional = pkg.optionalDependencies !== null && typeof pkg.optionalDependencies === 'object' ? pkg.optionalDependencies : {}
  const dev = pkg.devDependencies !== null && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}

  const checkRange = (kind, name, range) => {
    if (typeof range !== 'string' || range.trim() === '') {
      add('FAIL', kind, name, 'no version range declared')
      return
    }
    if (isUnboundedRange(range)) {
      add('FAIL', kind, name, `unbounded range "${range}" cannot be checked (the gate would be vacuous)`)
      return
    }
    if (satisfies('0.0.0', range) === null) {
      add('FAIL', kind, name, `range "${range}" is not parseable by this matrix checker`)
      return
    }
    const version = installed[name] ?? null
    if (version === null || version === undefined) {
      if (kind === 'dependency') add('FAIL', kind, name, `declared dependency missing from node_modules (range "${range}")`)
      else add('WARN', kind, name, `peer not installed locally: range "${range}" not verified (host provides it)`)
      return
    }
    const result = satisfies(version, range)
    if (result === null) {
      add('FAIL', kind, name, `installed ${version} cannot be compared with range "${range}"`)
      return
    }
    if (!result) add('FAIL', kind, name, `installed ${version} does NOT satisfy "${range}"`)
    else add('PASS', kind, name, `${version} satisfies "${range}"`)
  }

  for (const name of Object.keys(peers ?? {}).sort()) {
    const range = peers[name]
    if (isHostGateName(name)) {
      // Not silent: record that the host gate owns it, and still verify the
      // locally installed copy when one exists (range decoding stays ours).
      const version = installed[name] ?? null
      if (typeof range === 'string' && version !== null && version !== undefined) {
        const result = satisfies(version, range)
        if (result === false) {
          add('FAIL', 'host-peer', name, `host-gate peer, but local ${version} does NOT satisfy "${range}"`)
          continue
        }
      }
      add('HOST', 'host-peer', name, `checked by the host gate (range "${range}"); local copy ${version ?? 'not installed'}`)
      continue
    }
    checkRange('peer-nonhost', name, range)
  }

  for (const name of Object.keys(dependencies).sort()) checkRange('dependency', name, dependencies[name])

  for (const name of Object.keys(optional).sort()) {
    if (installed[name] === undefined || installed[name] === null) add('WARN', 'optional', name, 'optional dependency not installed (declared intent only)')
    else checkRange('optional', name, optional[name])
  }

  const declared = new Set([...Object.keys(peers ?? {}), ...Object.keys(dependencies), ...Object.keys(optional)])
  const staticImports = new Set(imports)
  for (const name of [...new Set(imports)].sort()) {
    if (declared.has(name)) continue
    if (Object.hasOwn(dev, name)) {
      add('FAIL', 'import-undeclared', name, 'imported by shipped code but declared only in devDependencies (will be missing at runtime)')
      continue
    }
    add('FAIL', 'import-undeclared', name, 'imported by shipped code but not declared in peer/dependencies')
  }
  // Dynamic imports are the legitimate "host may not provide it" escape hatch
  // (`import('pkg').catch(() => null)` + graceful degradation). Still NOT
  // silent: an undeclared dynamic import is surfaced as WARN so the decision
  // stays visible, while a hard `from`/static import of the same package FAILs.
  for (const name of [...new Set(dynamicImports)].sort()) {
    if (declared.has(name) || staticImports.has(name)) continue
    add('WARN', 'import-dynamic-undeclared', name, 'dynamically imported and not declared: intentional optional dependency (kept explicit, not skipped)')
  }

  const enginesNode = pkg.engines?.node ?? null
  const matrixNode = pkg.dsh?.compatibility?.node ?? null
  if (enginesNode !== null && matrixNode !== null && enginesNode !== matrixNode) {
    add('FAIL', 'matrix-consistency', 'node', `engines.node "${enginesNode}" contradicts dsh.compatibility.node "${matrixNode}"`)
  }
  if (enginesNode !== null) {
    if (nodeVersion === null || nodeVersion === undefined) add('WARN', 'engine', 'node', `engines.node "${enginesNode}" not verified (no runtime version supplied)`)
    else {
      const result = satisfies(nodeVersion, enginesNode)
      if (result === null) add('FAIL', 'engine', 'node', `runtime ${nodeVersion} vs engines.node "${enginesNode}" is not comparable`)
      else if (result === false) add('FAIL', 'engine', 'node', `runtime ${nodeVersion} does NOT satisfy engines.node "${enginesNode}"`)
      else add('PASS', 'engine', 'node', `runtime ${nodeVersion} satisfies "${enginesNode}"`)
    }
  }

  const matrixDsh = pkg.dsh?.compatibility?.dsh ?? null
  if (matrixDsh === null) {
    add('WARN', 'matrix-consistency', 'dsh', 'no dsh.compatibility.dsh: the supported host line is only implicit in peer ranges')
  } else if (!isValidRange(matrixDsh)) {
    add('FAIL', 'matrix-consistency', 'dsh', `dsh.compatibility.dsh "${matrixDsh}" is not a valid range`)
  } else {
    add('PASS', 'matrix-consistency', 'dsh', `declared host line "${matrixDsh}"`)
  }

  return finish(checks)
}

function finish(checks) {
  const summary = { PASS: 0, WARN: 0, FAIL: 0, HOST: 0, total: checks.length }
  for (const check of checks) summary[check.level] = (summary[check.level] ?? 0) + 1
  summary.ok = summary.FAIL === 0
  return { checks, summary }
}

/** Stable one-line rendering for gate output. */
export function formatCheck(check) {
  const mark = { PASS: '✓', WARN: '⚠', FAIL: '✗', HOST: '·' }[check.level] ?? '?'
  return `${mark} ${check.level.padEnd(4)} ${check.package.padEnd(42)} ${check.message}`
}

export const LEVEL_ORDER = LEVELS
