/**
 * dsh-retrace · test/mini-react.js
 *
 * A tiny React-SEMANTICS renderer for the tests that need a real render phase.
 *
 * Why it exists: the white-screen incident (2026-09-15) was a throw inside a
 * `useState` UPDATER — React runs updaters during the NEXT RENDER, so the error
 * is a render-phase error; without an error boundary React unmounts the host's
 * whole tree and the GUI goes blank. A `createElement`-only fake (which never
 * runs an updater, a class component or an error boundary) cannot reproduce or
 * lock that. `react-dom` is NOT a dependency of this repo, so this module models
 * React's DOCUMENTED semantics instead:
 *
 *   - hooks are kept per render ORDER (stable for a deterministic tree),
 *   - pending `useState` updaters run DURING the next render (so a throwing
 *     updater surfaces exactly like on the real machine),
 *   - `useEffect` callbacks run after the render, deps-compared,
 *   - class components whose type declares `getDerivedStateFromError` catch any
 *     render error of their subtree, call `componentDidCatch` and re-render —
 *     React's documented error-boundary contract,
 *   - an uncaught error escapes `flush()`, i.e. it reaches the host root.
 *
 * It is deliberately small and is NOT a general React implementation (no keys,
 * no reconciliation, no concurrent features).
 */

/** @returns {{react: object, mount: Function, flush: Function, tree: Function}} */
export function createMiniReact() {
  let hookIndex = 0
  let slots = []
  let pendingEffects = []
  let rootElement = null
  let rendered = null
  let dirty = false

  class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = this.state ?? {}
    }

    setState(partial) {
      this.state = { ...(this.state ?? {}), ...(typeof partial === 'function' ? partial(this.state ?? {}) : partial) }
      dirty = true
    }
  }

  const react = {
    Component,
    createElement: (type, props, ...children) => ({
      type,
      props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children },
      children,
    }),
    useState: (init) => {
      const i = hookIndex++
      if (!(i in slots)) slots[i] = { value: typeof init === 'function' ? init() : init, queue: [] }
      const slot = slots[i]
      // React applies queued updaters during the render phase → a throw here is a
      // RENDER error (this is the white-screen failure mode).
      if (slot.queue.length > 0) {
        const queue = slot.queue
        slot.queue = []
        for (const next of queue) slot.value = typeof next === 'function' ? next(slot.value) : next
      }
      return [slot.value, (next) => { slot.queue.push(next); dirty = true }]
    },
    useRef: (value) => {
      const i = hookIndex++
      if (!(i in slots)) slots[i] = { current: value }
      return slots[i]
    },
    useEffect: (fn, deps) => {
      const i = hookIndex++
      const previous = slots[i]
      const changed = previous === undefined || deps === undefined || previous.deps === undefined
        || deps.some((dep, k) => dep !== previous.deps[k])
      slots[i] = { deps, fn }
      if (changed) pendingEffects.push(fn)
    },
    useMemo: (fn) => fn(),
    useCallback: (fn) => fn(),
  }

  const renderChild = (element) => {
    if (element === null || element === undefined || element === false || element === true) return null
    if (typeof element === 'string' || typeof element === 'number') return element
    if (Array.isArray(element)) return element.map(renderChild)
    const { type, props } = element
    if (typeof type === 'function') {
      if (type.prototype && typeof type.prototype.render === 'function') {
        const instance = new type(props)
        try {
          return renderChild(instance.render())
        } catch (error) {
          if (typeof type.getDerivedStateFromError !== 'function') throw error
          instance.state = { ...(instance.state ?? {}), ...type.getDerivedStateFromError(error) }
          if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error, { componentStack: '' })
          return renderChild(instance.render())
        }
      }
      return renderChild(type(props))
    }
    return { type, props, children: renderChild(props.children) }
  }

  return {
    react,
    /** Mount (or replace) the root element. */
    mount: (element) => { rootElement = element; dirty = true },
    /** Render until no state update is pending; returns the rendered tree. */
    flush: () => {
      let guard = 0
      do {
        dirty = false
        hookIndex = 0
        pendingEffects = []
        rendered = renderChild(rootElement)
        for (const effect of pendingEffects) effect()
        if (guard++ > 50) break
      } while (dirty)
      return rendered
    },
    tree: () => rendered,
    /** Reset all hook state (a fresh "tab switch"). */
    reset: () => { slots = []; hookIndex = 0; pendingEffects = []; rendered = null; dirty = false },
  }
}

/** Every element in a rendered tree (depth-first). */
export function collectElements(node, out = []) {
  if (Array.isArray(node)) { for (const child of node) collectElements(child, out); return out }
  if (node && typeof node === 'object' && node.type !== undefined) {
    out.push(node)
    collectElements(node.children, out)
  }
  return out
}

/** The concatenated text of a rendered tree. */
export function textOf(node) {
  const parts = []
  const walk = (current) => {
    if (typeof current === 'string' || typeof current === 'number') { parts.push(String(current)); return }
    if (Array.isArray(current)) { for (const child of current) walk(child); return }
    if (current && typeof current === 'object') walk(current.children)
  }
  walk(node)
  return parts.join(' ')
}

/** The first element whose className contains `name`. */
export function findByClass(node, name) {
  return collectElements(node).find((element) => String(element.props?.className ?? '').includes(name))
}
