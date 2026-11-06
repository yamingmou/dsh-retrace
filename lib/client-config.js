/**
 * dsh-retrace — client settings store (single source of truth).
 *
 * Why this module exists (settings parity, 0.4.140):
 *  1. **One set of bounds.** The retention input used to advertise `min: 5,
 *     max: 500, step: 5` while the handler clamped `1..1000`: a value typed as
 *     `800` was accepted by the handler but is unreachable with the arrows, and
 *     `1` was reachable by typing but outside the advertised range. Bounds are
 *     exported here and used by BOTH the input attributes and the clamp, so the
 *     two can never drift again (`RETENTION_MIN/MAX/STEP`).
 *  2. **Cross-tab sync.** `setConfig` used to merge the patch onto the in-memory
 *     cache and write the result back. Two settings tabs open ⇒ the second one
 *     silently rewrites the first one's changes with its stale snapshot. The
 *     store now re-reads storage before every write (`read() → merge`), re-reads
 *     after the write (`write → refresh`), and installs a `storage` listener so
 *     a change made in another tab reaches this tab's subscribers.
 *
 * Storage is injectable (`createConfigStore({ storage, target })`) so the store
 * can be tested without a DOM; the browser default degrades to a memory-only
 * store when `localStorage` is unavailable (private mode / quota / test env).
 */

export const CONFIG_KEY = 'dsh-retrace:config'
/** Config keys of renamed-away plugin names, read as a fallback on first load. */
export const LEGACY_CONFIG_KEYS = ['dsh-message-editor:config']
export const CONFIG_VERSION = 3

/**
 * Retention bounds — the ONLY place these numbers may appear.
 *
 * The number input used to advertise `5..500` while the handler clamped
 * `1..1000`: the stepper could not reach a value the handler accepted, and a
 * value the handler accepted was outside the advertised range. Both sides now
 * read THESE constants (the input's min/max/step attributes and
 * `clampRetention`), so they cannot drift again. `5..500 step 5` is the range
 * users already saw in the markup; stored outliers are normalized on load.
 */
export const RETENTION_MIN = 5
export const RETENTION_MAX = 500
export const RETENTION_STEP = 5
export const RETENTION_DEFAULT = 50

export const CONFIG_DEFAULTS = Object.freeze({
  version: CONFIG_VERSION,
  showOriginalInput: true,
  // `editFromScratch`/`hideShadowed` are kept as fields (migration + legacy
  // readers) even though the UI no longer exposes a switch for them.
  editFromScratch: false,
  hideShadowed: true,
  versioning: true,
  git: true,
  retentionLimit: RETENTION_DEFAULT,
  prewrite: true,
  closeGuard: false,
  summary: false,
})

/**
 * Clamp a raw retention input into `[RETENTION_MIN, RETENTION_MAX]` AND snap it
 * onto the same step grid the number input's arrows use (`MIN + k*STEP`), so a
 * typed off-grid value (e.g. `7`) cannot make the stepper jump inconsistently.
 *
 * Empty / non-numeric input falls back to the default (the old handler's
 * `Number(x) || 50` behaviour) instead of clamping to the minimum.
 */
export function clampRetention(raw) {
  if (raw === undefined || raw === null || raw === '') return RETENTION_DEFAULT
  const value = Number(raw)
  if (!Number.isFinite(value)) return RETENTION_DEFAULT
  const clamped = Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, value))
  const snapped = RETENTION_MIN + Math.round((clamped - RETENTION_MIN) / RETENTION_STEP) * RETENTION_STEP
  return Math.min(RETENTION_MAX, Math.max(RETENTION_MIN, snapped))
}

/**
 * Pre-v3 migration: the destructive default `editFromScratch: true` is always
 * reset to false; `hideShadowed` is reset to true for configs written under the
 * interim v2 defaults. Every other customization is preserved — and the
 * retention value is normalized so a hand-edited outlier cannot survive a load.
 */
export function migrateConfig(parsed) {
  const source = parsed !== null && typeof parsed === 'object' ? parsed : {}
  const version = typeof source.version === 'number' ? source.version : 1
  const merged = version >= CONFIG_VERSION
    ? { ...CONFIG_DEFAULTS, ...source }
    : {
        ...CONFIG_DEFAULTS,
        ...source,
        version: CONFIG_VERSION,
        editFromScratch: CONFIG_DEFAULTS.editFromScratch,
        hideShadowed: CONFIG_DEFAULTS.hideShadowed,
      }
  return { ...merged, retentionLimit: clampRetention(merged.retentionLimit) }
}

function defaultStorage() {
  try {
    // `localStorage` throws a ReferenceError in Node without the webstorage
    // flag and in sandboxed renderers; that is a normal degradation, not a bug.
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function defaultTarget() {
  try {
    return typeof window === 'undefined' ? null : window
  } catch {
    return null
  }
}

const sameConfig = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Build a settings store over an injectable storage + event target.
 * Returns `{ get, set, read, subscribe, sync, key }`; `sync()` installs the
 * cross-tab listener and returns its disposer (safe to call without a target).
 */
export function createConfigStore({ storage = defaultStorage(), target = defaultTarget() } = {}) {
  const listeners = new Set()
  let cache = read()

  /** Read storage, migrating and normalizing; persist a normalized migration. */
  function read() {
    try {
      const raw = storage === null ? null : storage.getItem(CONFIG_KEY)
      if (raw !== null && raw !== undefined) {
        const parsed = raw ? JSON.parse(raw) : {}
        const migrated = migrateConfig(parsed)
        const storedVersion = typeof parsed.version === 'number' ? parsed.version : 1
        const needsRewrite = storedVersion < CONFIG_VERSION || !sameConfig(migrated, parsed)
        if (needsRewrite && storage !== null) {
          try { storage.setItem(CONFIG_KEY, JSON.stringify(migrated)) } catch { /* quota/unavailable: keep the in-memory value */ }
        }
        return migrated
      }
      for (const legacyKey of LEGACY_CONFIG_KEYS) {
        const legacyRaw = storage === null ? null : storage.getItem(legacyKey)
        if (legacyRaw !== null && legacyRaw !== undefined) {
          const migrated = migrateConfig(legacyRaw ? JSON.parse(legacyRaw) : {})
          try { storage.setItem(CONFIG_KEY, JSON.stringify(migrated)) } catch { /* quota/unavailable */ }
          return migrated
        }
      }
      return { ...CONFIG_DEFAULTS }
    } catch {
      // Corrupt JSON is a real state (hand-edited / half-written): fall back to
      // defaults for this load, but leave the bad value in place for diagnosis.
      return { ...CONFIG_DEFAULTS }
    }
  }

  /** @returns {boolean} whether the value reached storage. */
  function persist(value) {
    if (storage === null) return false
    try {
      storage.setItem(CONFIG_KEY, JSON.stringify(value))
      return true
    } catch {
      return false
    }
  }

  function notify() {
    for (const listener of listeners) {
      try {
        listener(cache)
      } catch (error) {
        // A subscriber must never take the store down (or silently vanish).
        try { console.error('[dsh-retrace] config listener failed:', error?.message ?? error) } catch { /* no console */ }
      }
    }
  }

  function get() {
    return cache
  }

  /** Normalize every write, so no caller can persist an out-of-bounds value. */
  function normalizePatch(patch) {
    const next = { ...(patch !== null && typeof patch === 'object' ? patch : {}) }
    if ('retentionLimit' in next) next.retentionLimit = clampRetention(next.retentionLimit)
    return next
  }

  function set(patch) {
    // Merge onto the CURRENT persisted state, not onto a possibly stale cache:
    // another tab may have written since this tab last read.
    const base = storage === null ? cache : read()
    const next = { ...base, ...normalizePatch(patch) }
    const persisted = persist(next)
    // Write-then-refresh: adopt what storage actually holds after our write.
    cache = persisted ? read() : next
    notify()
    return cache
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') return () => {}
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }

  /**
   * Cross-tab sync: `storage` fires only in OTHER tabs, so this cannot loop
   * with our own writes. `event.key === null` means `localStorage.clear()`.
   */
  function sync() {
    if (target === null || typeof target.addEventListener !== 'function') return () => {}
    const onStorage = (event) => {
      const key = event?.key
      // `key === null` is `localStorage.clear()`: re-read rather than guess.
      if (key !== CONFIG_KEY && key !== null && !LEGACY_CONFIG_KEYS.includes(key)) return
      const next = read()
      if (sameConfig(next, cache)) return
      cache = next
      notify()
    }
    target.addEventListener('storage', onStorage)
    return () => {
      if (typeof target.removeEventListener === 'function') target.removeEventListener('storage', onStorage)
    }
  }

  return { get, set, read, subscribe, sync, key: CONFIG_KEY }
}

/** The renderer-wide store (module singleton; one per client instance). */
export const configStore = createConfigStore()
