/**
 * 侧栏谱系标识注入层（侧栏注入）——含**四条阴性对照**。
 * 护栏：fail-soft / 不静默 / 开关 / PUBLIC_BUILD 构建期裁剪；渲染=增强不替换 + MutationObserver 保活。
 */
import { describe, it, expect } from 'vitest'
import { createSidebarBadge, sessionIdOfRow, titleSpanOf } from '../lib/identity/sidebar-badge.js'

// ── 最小假 DOM（只覆盖本模块用到的面）────────────────────────────────────
function el(tag) {
  const e = {
    tagName: tag.toUpperCase(), className: '', children: [], parentNode: null, textContent: '', attrs: {},
    setAttribute(k, v) { this.attrs[k] = v },
    getAttribute(k) { return this.attrs[k] ?? null },
    closest(sel) {
      let n = this
      while (n) { if (sel === '[role="treeitem"]' && n.attrs?.role === 'treeitem') return n; n = n.parentNode }
      return null
    },
    remove() { this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null },
    insertBefore(n, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, n); n.parentNode = this },
    appendChild(n) { this.children.push(n); n.parentNode = this; return n },
    _all(out = []) { for (const c of this.children) { out.push(c); c._all(out) } return out },
    querySelectorAll(sel) {
      const all = this._all()
      if (sel === 'span') return all.filter((x) => x.tagName === 'SPAN')
      if (sel === '[role="treeitem"]') return all.filter((x) => x.attrs.role === 'treeitem')
      return all.filter((x) => String(x.className).split(/\s+/).includes(sel.replace(/^\./, '')))
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] ?? null },
  }
  return e
}
/** 造一行：role=treeitem > span.title（可选带 fiber.node.id） */
function makeRow(sessionId) {
  const row = el('div'); row.setAttribute('role', 'treeitem')
  const title = el('span'); title.className = 'ozLDBG_title'; title.textContent = '某会话'
  row.appendChild(title)
  if (sessionId) row.marker = sessionId
  return row
}
/**
 * 把 session id 挂成**真机形状**：元素上只有 `__reactFiber$*`；`node` 在**组件树祖先**
 * （`fiber.return`）的 `memoizedProps` 上 —— 行元素自己那层**没有** node（这正是上一版 miss 的原因）。
 */
function attachFiber(row, id, shape = 'node.id') {
  const owner = { memoizedProps: shape === 'node.id' ? { node: { id } } : { node: { sessionId: id } } }
  const rowFiber = { memoizedProps: { role: 'treeitem' }, return: owner }   // 行层无 node
  row['__reactFiber$abc'] = rowFiber
}
/** 旧的"错形状"：元素父节点上找 fiber（复刻上一版 bug）——应**取不到**。 */
function attachBadFiberOnDomParent(row, id) { row.parentNode = { '\u005f\u005freactFiber$x': { memoizedProps: { node: { id } } } } }
function tree(...rows) { const body = el('div'); for (const r of rows) body.appendChild(r); return { body, doc: { body, createElement: el, querySelectorAll: (s) => body.querySelectorAll(s) } } }

describe('sidebar-badge 注入层', () => {
  it('正常：有 fiber id + 表里有码 ⇒ 在 title **前**插入 [谱系标识]（增强不替换）', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc, body } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null) })
    const st = inst.scan()
    expect(st.injected).toBe(1)
    const badge = row.querySelector('.dsh-rt-badge')
    expect(badge).not.toBeNull()
    expect(badge.textContent).toBe('[zz999zz999]')
    expect(badge.attrs['data-dsh-rt-code']).toBe('zz999zz999')
    // 增强：title span 仍在，且徽标在它**之前**
    expect(row.children.indexOf(badge)).toBeLessThan(row.children.indexOf(row.querySelector('.ozLDBG_title')))
    expect(body).toBeTruthy()
  })

  it('幂等：同一行扫两次只插一个徽标', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null) })
    inst.scan(); inst.scan()
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
  })

  it('保活（判据）：重渲染把我们的徽标抹掉后，再扫一次它**回来**', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null) })
    inst.scan()
    expect(row.querySelector('.dsh-rt-badge')).not.toBeNull()
    // 模拟宿主重渲染：行内子节点被重建（我们的徽标消失，title 换成新的）
    row.children = []
    const t2 = el('span'); t2.className = 'ozLDBG_title'; row.appendChild(t2)
    expect(row.querySelector('.dsh-rt-badge')).toBeNull()
    inst.scan()                                     // observer 会做的事
    expect(row.querySelector('.dsh-rt-badge')).not.toBeNull()
  })

  it('★阴性对照①：取不到 fiber ⇒ **不注入**（绝不猜、绝不错配）', () => {
    const row = makeRow()                            // 无 fiber
    const { doc } = tree(row)
    const st = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null) }).scan()
    expect(st.injected).toBe(0)
    expect(st.noId).toBe(1)
    expect(row.querySelector('.dsh-rt-badge')).toBeNull()
  })

  it('★阴性对照②：**取不到映射**（缓存空 / badgeMap 失败 / 无 codeOf）⇒ **不注入**', () => {
    const row = makeRow(); attachFiber(row, 'sid-unknown')
    const { doc } = tree(row)
    // 新数据源：取不到映射（缓存空 / badgeMap 失败）⇒ 不注入
    for (const codeOf of [() => null, () => { throw new Error('badgeMap failed') }, undefined]) {
      const st = createSidebarBadge({ doc, codeOf }).scan()
      expect(st.injected).toBe(0)
    }
    expect(row.querySelector('.dsh-rt-badge')).toBeNull()
  })

  it('★阴性对照③：开关关掉 ⇒ start() 不注册 observer（恢复官方形态）', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null), enabled: () => false })
    expect(inst.start()).toBe(false)
    expect(inst.active).toBe(false)
    expect(row.querySelector('.dsh-rt-badge')).toBeNull()
    // 开→关：stop() 必须把我们插的抹掉（官方形态）
    const inst2 = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null), enabled: () => true })
    inst2.scan()
    expect(row.querySelector('.dsh-rt-badge')).not.toBeNull()
    inst2.stop()
    expect(row.querySelector('.dsh-rt-badge')).toBeNull()
  })

  it('★阴性对照④：PUBLIC_BUILD ⇒ **不渲染**（公开版、同一份代码两种呈现）', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null), publicBuild: true })
    expect(inst.scan().injected).toBe(0)
    expect(inst.start()).toBe(false)
    expect(row.querySelector('.dsh-rt-badge')).toBeNull()
  })

  it('fail-soft：注入抛错被吞掉，界面保持官方形态且**不抛给调用方**', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc } = tree(row)
    // 让 titleSpanOf 内部炸：querySelectorAll 抛
    row.querySelectorAll = () => { throw new Error('boom') }
    const inst = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-1' ? 'zz999zz999' : null), report: () => {} })
    expect(() => inst.scan()).not.toThrow()
  })

  it('不静默：取不到 fiber 会经 report 出口报一次（去重）', () => {
    const row = makeRow()
    const { doc } = tree(row)
    const seen = []
    createSidebarBadge({ doc, codeOf: () => null, report: (op, msg) => seen.push(`${op}:${msg}`) }).scan()
    expect(seen.length).toBe(1)
    expect(seen[0]).toContain('取不到 session id')
  })

  it('容错形状：node.sessionId 也认（不只是 node.id）', () => {
    const row = makeRow(); attachFiber(row, 'sid-2', 'node.sessionId')
    const { doc } = tree(row)
    const st = createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-2' ? 'zz999zz999' : null) }).scan()
    expect(st.injected).toBe(1)
  })

  it('★阴性对照①-b：node 只在 **DOM 父节点** 的 fiber 上（上一版的错走法）⇒ **不注入**', () => {
    const row = makeRow()
    attachBadFiberOnDomParent(row, 'sid-1')          // DOM 树上有 fiber，组件树链上没有
    const { doc } = tree(row)
    const st = createSidebarBadge({ doc, codeOf: () => 'zz999zz999' }).scan()
    expect(st.injected).toBe(0)
    expect(st.noId).toBe(1)
  })

  it('诊断：miss 时给出"走了几层 + 每层 props 键名"（下一次日志能定位断在哪层）', () => {
    const row = makeRow()
    row['__reactFiber$abc'] = { memoizedProps: { role: 'treeitem' }, return: { memoizedProps: { foo: 1, node: {} } } }
    const seen = []
    createSidebarBadge({ doc: tree(row).doc, codeOf: () => 'zz999zz999', report: (op, msg) => seen.push(msg) }).scan()
    expect(seen.length).toBe(1)
    expect(seen[0]).toContain('walked=')
    expect(seen[0]).toContain('role')
  })

  it('★阴性对照⑤（真机"变两个"）：模拟点击/重渲染后重复插入 ⇒ 徽标数**恒为 1**', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: () => 'zz999zz999' })
    inst.scan()
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
    // 先把我们的徽标抹掉，再造"重复插入"：直接塞两个
    row.querySelectorAll('.dsh-rt-badge')[0].remove()
    inst.scan()                                      // 正常补回 1 个
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
    const dup1 = el('span'); dup1.className = 'dsh-rt-badge'; dup1.attrs['data-dsh-rt-row'] = 'sid-1'
    const dup2 = el('span'); dup2.className = 'dsh-rt-badge'; dup2.attrs['data-dsh-rt-row'] = 'sid-1'
    row.appendChild(dup1); row.appendChild(dup2)
    expect(row.querySelectorAll('.dsh-rt-badge').length).toBeGreaterThan(1)
    const st = inst.scan()                           // 幂等闸 + 重复清理
    expect(st.cleaned).toBeGreaterThanOrEqual(1)
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
  })

  it('孤儿清理：徽标脱离行（宿主重建子树）⇒ 被抹掉，不会残留', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc, body } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: () => 'zz999zz999' })
    inst.scan()
    const badge = row.querySelectorAll('.dsh-rt-badge')[0]
    row.children = row.children.filter((c) => c !== badge)   // 从行里摘出（成孤儿）
    badge.parentNode = body; body.appendChild(badge)
    expect(badge.closest('[role="treeitem"]')).toBeNull()
    inst.scan()
    expect(doc.querySelectorAll('.dsh-rt-badge').length).toBe(1)   // 只剩行里那个新的
  })

  it('名字：官方标题为**空**且 names 有 ⇒ 渲染 `[谱系标识] 名字`', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    row.querySelector('.ozLDBG_title').textContent = ''          // 官方标题为空
    const { doc } = tree(row)
    createSidebarBadge({ doc, codeOf: () => 'zz999zz999', titleOf: () => '插件开发—开发' }).scan()
    expect(row.querySelector('.dsh-rt-badge').textContent).toBe('[zz999zz999] 插件开发—开发')
  })

  it('名字：**官方有标题 ⇒ 不动**（只显示谱系标识，免与宿主抢显示）', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')              // 官方标题 '某会话'
    const { doc } = tree(row)
    createSidebarBadge({ doc, codeOf: () => 'zz999zz999', titleOf: () => '插件开发—开发' }).scan()
    expect(row.querySelector('.dsh-rt-badge').textContent).toBe('[zz999zz999]')
    expect(row.querySelector('.ozLDBG_title').textContent).toBe('某会话')
  })

  it('★names 缺项（拿不到名字）⇒ **只显示谱系标识**，不伪造', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    row.querySelector('.ozLDBG_title').textContent = ''
    const { doc } = tree(row)
    for (const titleOf of [() => null, () => { throw new Error('titleMap failed') }, undefined]) {
      const r2 = makeRow(); attachFiber(r2, 'sid-1'); r2.querySelector('.ozLDBG_title').textContent = ''
      createSidebarBadge({ doc: tree(r2).doc, codeOf: () => 'zz999zz999', titleOf }).scan()
      expect(r2.querySelector('.dsh-rt-badge').textContent).toBe('[zz999zz999]')
    }
    expect(doc).toBeTruthy()
  })

  it('★PUBLIC_BUILD 仍不渲染谱系标识与名字（裁剪语义未变）', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    row.querySelector('.ozLDBG_title').textContent = ''
    const { doc } = tree(row)
    createSidebarBadge({ doc, codeOf: () => 'zz999zz999', titleOf: () => '插件开发—开发', publicBuild: true }).scan()
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(0)
    expect(row.querySelector('.ozLDBG_title').textContent).toBe('')
  })

  it('★根本原因②（真机"并排两个"）：官方标题**已自带 [谱系标识]** ⇒ **不前置**，码只出现一次', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const t = row.querySelector('.ozLDBG_title')
    t.textContent = '[zz999zz999] 插件开发—开发'          // 官方标题已带码（T3 回填过）
    const { doc } = tree(row)
    const st = createSidebarBadge({ doc, codeOf: () => 'zz999zz999', titleOf: () => '插件开发—开发' }).scan()
    expect(st.injected).toBe(0)
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(0)
    // 该行里"码"只出现一次 —— 就是官方标题里那一个
    expect((t.textContent.match(/zz999zz999/g) ?? []).length).toBe(1)
  })

  it('★阴性对照①（嵌套 treeitem）：一行内嵌两个 treeitem、fiber 同 id ⇒ 该行徽标**恒为 1**', () => {
    const outer = makeRow(); outer.querySelector('.ozLDBG_title').textContent = ''
    attachFiber(outer, 'sid-1')
    const inner = makeRow(); inner.querySelector('.ozLDBG_title').textContent = ''
    attachFiber(inner, 'sid-1')
    outer.appendChild(inner)                               // inner 嵌在 outer 里
    const { doc } = tree(outer)
    const inst = createSidebarBadge({ doc, codeOf: () => 'zz999zz999' })
    const st = inst.scan()
    expect(doc.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)   // **只留最外层那一个**
    expect(st.nested).toBeGreaterThanOrEqual(1)
    expect(outer.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
  })

  it('★嵌套对照（反向）：两个**不同** id ⇒ 各 1 个、互不影响', () => {
    const a = makeRow(); a.querySelector('.ozLDBG_title').textContent = ''
    attachFiber(a, 'sid-a')
    const b = makeRow(); b.querySelector('.ozLDBG_title').textContent = ''
    attachFiber(b, 'sid-b')
    const { doc } = tree(a, b)
    createSidebarBadge({ doc, codeOf: (id) => (id === 'sid-a' ? 'zz999zz999' : 'yy111yy111') }).scan()
    expect(a.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
    expect(b.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
    expect(a.querySelector('.dsh-rt-badge').textContent).toBe('[zz999zz999]')
    expect(b.querySelector('.dsh-rt-badge').textContent).toBe('[yy111yy111]')
  })

  it('★阴性对照③（重渲染残留）：注一次 → 模拟点击/重渲染（行子节点重建）→ 再 scan ⇒ **恒为 1**', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const { doc } = tree(row)
    const inst = createSidebarBadge({ doc, codeOf: () => 'zz999zz999' })
    inst.scan()
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)
    // 真机时序：点击 → 宿主重建行内子节点（我们的徽标成孤儿被丢弃，或残留）
    const stale = row.querySelectorAll('.dsh-rt-badge')[0]
    const t2 = el('span'); t2.className = 'ozLDBG_title'; t2.textContent = ''
    row.children = [stale, t2]                             // 徽标**残留**在行里（模拟"旧节点没被清"）
    inst.scan()
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(1)   // 幂等闸挡住，仍是 1
  })

  it('★名字（放宽）：官方标题**只有码没名字** ⇒ 补上我们的名字', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const t = row.querySelector('.ozLDBG_title'); t.textContent = '[zz999zz999]'
    const { doc } = tree(row)
    createSidebarBadge({ doc, codeOf: () => 'zz999zz999', titleOf: () => '插件开发—开发' }).scan()
    expect(t.textContent).toBe('[zz999zz999] 插件开发—开发')
    expect(row.querySelectorAll('.dsh-rt-badge')).toHaveLength(0)   // 仍不前置第二个徽标
  })

  it('★名字（放宽的反向对照）：官方标题 = **[谱系标识] 真名** ⇒ **完全不动**', () => {
    const row = makeRow(); attachFiber(row, 'sid-1')
    const t = row.querySelector('.ozLDBG_title'); t.textContent = '[zz999zz999] 插件开发—开发'
    const { doc } = tree(row)
    createSidebarBadge({ doc, codeOf: () => 'zz999zz999', titleOf: () => '别的名字' }).scan()
    expect(t.textContent).toBe('[zz999zz999] 插件开发—开发')
  })

  it('标题 span 识别：认类名 token 以 `_title` 结尾（构建哈希）', () => {
    const row = makeRow()
    expect(titleSpanOf(row)).toBe(row.children[0])
    expect(sessionIdOfRow(row).id).toBe(null)
  })
})
