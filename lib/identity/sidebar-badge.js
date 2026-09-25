/**
 * dsh-retrace · lib/identity/sidebar-badge.js
 *
 * 侧栏谱系标识**注入层**（侧栏注入）：在既有侧栏行上**增强**（不替换）—— 行内 title 前插
 * `<span class="dsh-rt-badge">[谱系标识]</span>`，让**冷会话不点也能看到谱系标识**。
 *
 * 映射来源（已结论，见 SIDEBAR-MAPPING-VERDICT.md）：
 *   `[role="treeitem"]` → `__reactFiber$*` → `memoizedProps.node?.id`（行组件 `SessionNodeItem({node})`）。
 *   **失败面 = 完全不注入（安全侧）**，不按序猜测（错配比不显示更糟）。
 *   不采用的路线：DOM 属性（行上无 id/data-*，类名是构建哈希）；store 按序（DOM 行序 ≠ store 线性序）。
 *
 * 四条护栏：① fail-soft（异常全吞，界面保持官方形态）② 不静默（去重 clientReport）
 * ③ 开关（关掉即不注册 observer，恢复官方形态、免重启）④ PUBLIC_BUILD 构建期裁剪（公开版不渲染，
 *   同一份代码两种呈现，**不分叉**）。
 * 零写入：只读 document + 只读内置表；不碰会话日志/projcache/codes.json。
 */

const BADGE_CLASS = 'dsh-rt-badge'
const FIBER_PREFIX = '__reactFiber$'
const MAX_UP = 12
/** 官方标题**已自带** `[谱系标识]`（T3 回填过的 56/218 条就是这样）⇒ **不再前置**，否则并排两个。 */
const CODE_PREFIX = /^\[[^\]\s]{4,}\]/

/** 容错取值形状（逐个试，命中即用）。 */
const ID_SHAPES = [
  ['props.node.id', (p) => p?.node?.id],
  ['props.node.sessionId', (p) => p?.node?.sessionId],
  ['props.sessionId', (p) => p?.sessionId],
  ['props.id', (p) => p?.id],
]

/**
 * 从行元素取 session id：**先拿元素上的 `__reactFiber$*`，再沿 `fiber.return`（组件树）向上**。
 *
 * ⚠️ 2026-09-21 真机教训：上一版走的是 **DOM `parentNode`**（那是 DOM 树，不是组件树）⇒
 * 真机全部 miss（走链未命中）。带 `node` 的是 **`SessionNodeItem` 那层组件**，只在 fiber 的
 * `return` 链上。⇒ 本版只走 fiber 链，并在 miss 时给出**可诊断**信息（走了几层/每层 props 键名）。
 * @returns {{id: string|null, depth?: number, shape?: string, diag?: string}}
 */
export function sessionIdOfRow(el) {
  try {
    const key = Object.keys(el ?? {}).find((k) => k.startsWith(FIBER_PREFIX))
    if (key === undefined) return { id: null, diag: 'element-has-no-react-key' }
    let fiber = el[key]
    let depth = 0
    const trail = []
    while (fiber && depth < MAX_UP) {
      const props = fiber.memoizedProps
      for (const [name, pick] of ID_SHAPES) {
        const v = pick(props)
        if (typeof v === 'string' && v !== '') return { id: v, depth, shape: name }
      }
      const keys = props === undefined ? 'no-props' : Object.keys(props).slice(0, 8).join('/')
      // 诊断增强(记录 1547 后续): 突出 `node` 的**类型与键名**（此前只给 '+node'，且日志行被截断在 1~2 层）
      const n = props?.node
      const nodeInfo = n === undefined ? '' : `+node(${n === null ? 'null' : typeof n}):${n === null ? '' : Object.keys(n).slice(0, 6).join('/')}`
      trail.push(`${depth}:{${keys}}${nodeInfo}`)
      fiber = fiber.return
      depth++
    }
    // 紧凑诊断(第4波): 只报**含 node 的层**（最关键），并给总层数 ⇒ 即使上报管线截断也能存活
    const nodeLevels = trail.filter((x) => x.includes('+node'))
    const brief = nodeLevels.length > 0 ? `nodes=[${nodeLevels.slice(0, 3).join(' | ')}]` : 'nodes=none'
    return { id: null, diag: `walked=${depth} ${brief}` }
  } catch (e) { return { id: null, diag: `error:${String(e).slice(0, 60)}` } }
}

/** 找行内的 title span：类名 token 以 `_title` 结尾（构建哈希 `ozLDBG_title` 亦然）。 */
export function titleSpanOf(row) {
  try {
    for (const el of row.querySelectorAll('span')) {
      const cls = String(el.className ?? '')
      if (cls.split(/\s+/).some((c) => c === 'title' || c.endsWith('_title'))) return el
    }
  } catch { /* fail-soft */ }
  return null
}

/**
 * 建注入器。**纯 DOM，不写盘**。
 * @param {object} o
 * @param {Document} o.doc
 * @param {(id:string)=>string|null} o.codeOf 取码函数（拿不到返回 null）
 * @param {(id:string)=>string|null} [o.titleOf] 取名字（**只在官方标题为空时**用；拿不到返回 null）
 * @param {() => boolean} [o.enabled] 开关（false ⇒ 不注册 observer）
 * @param {(op:string,msg:string)=>void} [o.report] 不静默出口（去重由调用方负责）
 * @param {boolean} [o.publicBuild] true ⇒ 不渲染（构建期裁剪的运行时同一开关）
 */
export function createSidebarBadge({ doc, codeOf, titleOf, enabled = () => true, report = () => {}, publicBuild = false } = {}) {
  let observer = null
  let applying = false
  const warnOnce = new Set()

  const lookup = (id) => {
    try { return typeof codeOf === 'function' ? (codeOf(id) || null) : null } catch { return null }
  }
  const lookupTitle = (id) => {
    try { return typeof titleOf === 'function' ? (titleOf(id) || null) : null } catch { return null }
  }
  const warnOnceKey = (k, msg) => { if (warnOnce.has(k)) return; warnOnce.add(k); try { report(k, msg) } catch { /* fail-soft */ } }

  /** 注一行；返回 'injected' | 'skip:...'（纯函数式副作用，异常全吞）。 */
  function injectRow(row, stats) {
    try {
      if (publicBuild) return 'skip:public-build'
      // 逐行幂等闸：行内已有我们的徽标 ⇒ 跳过（防"变两个"）
      if (row.querySelector?.(`.${BADGE_CLASS}`)) return 'skip:already'
      // 第4波(角色A) 2026-09-25: **先按行文本判** —— 标题真值经启动规范化后已自带一份 `[谱系标识]`
      //   ⇒ 命中即跳过（不再走走链）⇒ 既满足"默认显示谱系标识+标题"，也**不再产生 走链未命中**
      const rowText = String(row.textContent ?? '')
      if (/\[[^\]\s]{4,24}\]/.test(rowText)) return 'skip:title-has-code(text)'
      const found = sessionIdOfRow(row)
      const id = found.id
      if (id === null) {
        stats.noId++
        warnOnceKey('walk-miss', `走链未命中（fiber 兜底；**仅聚合报首条**）⇒ 该行不注入（安全侧）｜诊断样例: ${found.diag}`)
        return 'skip:no-id'
      }
      const code = lookup(id)
      if (code === null) { stats.noCode++; warnOnceKey('no-code', '内置表里没有该会话的谱系标识 ⇒ 该行不注入'); return 'skip:no-code' }
      const title = titleSpanOf(row)
      if (title === null) { stats.noTitle++; warnOnceKey('no-title', '行内找不到 title span ⇒ 该行不注入'); return 'skip:no-title' }
      // **码只出一个来源**：官方标题若已自带 `[谱系标识]` ⇒ 直接用官方的，**不再前置**（真机"并排两个"的根因）
      const official = String(title.textContent ?? '').trim()
      if (CODE_PREFIX.test(official)) {
        // 官方标题**只有码、没有名字**（`[xx999xx999]`）⇒ 把我们的名字补上去（官方有真名字则不动）
        const rest = official.replace(CODE_PREFIX, '').trim()
        if (rest !== '') return 'skip:title-has-code'
        const onlyName = lookupTitle(id)
        if (onlyName === null) return 'skip:title-has-code'
        try { title.textContent = `${CODE_PREFIX.exec(official)[0]} ${onlyName}` } catch { /* fail-soft */ }
        return 'skip:title-code-only-filled'
      }
      // 名字：**仅当官方标题为空/缺失**时才用（官方有标题 ⇒ 不动，免与宿主抢显示）
      const name = official === '' ? lookupTitle(id) : null
      const badge = doc.createElement('span')
      badge.className = BADGE_CLASS
      badge.textContent = name === null ? `[${code}]` : `[${code}] ${name}`
      badge.setAttribute('data-dsh-rt-code', code)
      badge.setAttribute('data-dsh-rt-row', id)          // 幂等键：属于哪一行
      title.parentNode?.insertBefore(badge, title)
      // **自触发**：丢弃我们自己造成的 mutation 记录（否则 observer 会为自己的插入再扫一遍）
      try { observer?.takeRecords?.() } catch { /* fail-soft */ }
      stats.injected++
      return 'injected'
    } catch (e) { warnOnceKey('inject-error', `注入异常（已吞）: ${String(e).slice(0, 120)}`); return 'skip:error' }
  }

  /** 当前渲染出的侧栏行 → sessionId（**去重**；与 scan 同一行集合 `[role="treeitem"]`）。
   *  comm(懒加载):客户端据此只请求"可见行"的标题，避免首屏全量 titleMap。fail-soft:取不到返回已收集的。 */
  function visibleIds() {
    const out = []
    const seen = new Set()
    try {
      for (const row of doc.querySelectorAll('[role="treeitem"]')) {
        const found = sessionIdOfRow(row)
        if (found.id !== null && !seen.has(found.id)) { seen.add(found.id); out.push(found.id) }
      }
    } catch { /* fail-soft */ }
    return out
  }

  /** 扫一遍全部行（保活/首扫共用）。 */
  function scan() {
    const stats = { rows: 0, injected: 0, noId: 0, noCode: 0, noTitle: 0, cleaned: 0, nested: 0 }
    const claimed = new Set()
    try {
      // 清理：孤儿徽标（其行已不在 DOM）与同一行里的重复徽标 ⇒ 每行**恒为 1**
      const seen = new Set()
      for (const b of doc.querySelectorAll(`.${BADGE_CLASS}`)) {
        const key = b.getAttribute?.('data-dsh-rt-row') ?? null
        const orphan = typeof b.closest === 'function' && b.closest('[role="treeitem"]') === null
        if (orphan || (key !== null && seen.has(key))) { try { b.remove() } catch { /* fail-soft */ } stats.cleaned++; continue }
        if (key !== null) seen.add(key)
      }
      const finalSeen = new Set()
      for (const b of doc.querySelectorAll(`.${BADGE_CLASS}`)) {
        const k = b.getAttribute?.('data-dsh-rt-row') ?? null
        if (k !== null && finalSeen.has(k)) { try { b.remove() } catch { } stats.cleaned++ } else if (k !== null) finalSeen.add(k)
      }
      for (const row of doc.querySelectorAll('[role="treeitem"]')) {
        stats.rows++
        const found = sessionIdOfRow(row)
        if (found.id !== null && claimed.has(found.id)) {
          stats.nested++
          try { for (const b of row.querySelectorAll(`.${BADGE_CLASS}`)) b.remove() } catch { }
          continue
        }
        const r = injectRow(row, stats)
        if (r === 'injected' && found.id !== null) claimed.add(found.id)
      }
    } catch { /* fail-soft */ }
    return stats
  }

  return {
    scan,
    visibleIds,
    injectRow,
    /** 开：先扫一遍，再挂 MutationObserver **保活**（判据 = 重渲染后仍在）。 */
    start() {
      try {
        if (publicBuild) return false
        if (typeof enabled === 'function' && !enabled()) return false
        scan()
        if (observer === null && typeof MutationObserver !== 'undefined') {
          observer = new MutationObserver((records) => {
            if (applying) return
            // **忽略自身变更**：整条 mutation 只涉及我们的徽标 ⇒ 不必重扫
            const ours = (n) => n?.nodeType === 1 && String(n.className ?? '').split(/\s+/).includes(BADGE_CLASS)
            const selfOnly = Array.isArray(records) && records.length > 0 && records.every((r) =>
              ours(r.target) || [...(r.addedNodes ?? [])].every(ours) && ![...(r.addedNodes ?? [])].some((n) => !ours(n)))
            if (selfOnly) return
            applying = true
            try { scan() } catch { /* fail-soft */ } finally { applying = false }
          })
          observer.observe(doc.body, { childList: true, subtree: true })
        }
        return true
      } catch (e) { warnOnceKey('start-error', `observer 装配失败（已吞）: ${String(e).slice(0, 120)}`); return false }
    },
    /** 关：撤 observer + 抹掉我们插的徽标 ⇒ **恢复官方形态**。 */
    stop() {
      try { observer?.disconnect() } catch { /* fail-soft */ }
      observer = null
      try { for (const el of doc.querySelectorAll(`.${BADGE_CLASS}`)) el.remove() } catch { /* fail-soft */ }
      return true
    },
    get active() { return observer !== null },
  }
}
