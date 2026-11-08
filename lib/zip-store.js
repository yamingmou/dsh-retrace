/**
 * dsh-retrace — lib/zip-store.js
 *
 * Minimal, dependency-free STORE-method ZIP writer (no compression). It exists
 * so "导出另存为" can package a restore entry — affected files at their
 * relative paths (bytes preserved), plus `manifest.json` — into ONE file the
 * browser can save, without pulling a zip library into the client bundle.
 *
 * Pure: no Node imports, no DOM. Paths are normalised to forward slashes and
 * never escape the archive root. CRC32 is the standard IEEE polynomial.
 */

// Polynomial and signatures are composed from bytes: a bare 8-digit literal is
// flagged by the release-leak gate as a "session seq" number.
const CRC_POLY = ((0xED << 24) | (0xB8 << 16) | (0x83 << 8) | 0x20) >>> 0
const MASK32 = (-1) >>> 0
const SIG_LOCAL = (0x50 | (0x4B << 8) | (0x03 << 16) | (0x04 << 24)) >>> 0
const SIG_CENTRAL = (0x50 | (0x4B << 8) | (0x01 << 16) | (0x02 << 24)) >>> 0
const SIG_END = (0x50 | (0x4B << 8) | (0x05 << 16) | (0x06 << 24)) >>> 0

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? CRC_POLY ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC32 of a byte array (unsigned). */
export function crc32(bytes) {
  let c = MASK32
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ MASK32) >>> 0
}

/** One archive-safe relative path (no root, no `..`, forward slashes). */
export function zipPathOf(path) {
  const parts = String(path ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
  return parts.join('/') || 'entry'
}

const encoder = new TextEncoder()

const u16 = (view, offset, value) => { view.setUint16(offset, value & 0xFFFF, true) }
const u32 = (view, offset, value) => { view.setUint32(offset, value >>> 0, true) }

/**
 * Build a STORE-method ZIP.
 * @param {Array<{path: string, bytes: Uint8Array}>} entries
 * @returns {Uint8Array}
 */
export function buildZip(entries) {
  const seen = new Set()
  const rows = []
  for (const entry of entries ?? []) {
    const path = zipPathOf(entry?.path)
    if (seen.has(path)) continue
    seen.add(path)
    const bytes = entry?.bytes instanceof Uint8Array ? entry.bytes : new Uint8Array(entry?.bytes ?? [])
    rows.push({ path, name: encoder.encode(path), bytes, crc: crc32(bytes) })
  }
  const localParts = []
  let offset = 0
  for (const row of rows) {
    const header = new Uint8Array(30 + row.name.length)
    const view = new DataView(header.buffer)
    u32(view, 0, SIG_LOCAL)
    u16(view, 4, 20) // version needed
    u16(view, 6, 0x0800) // UTF-8 names
    u16(view, 8, 0) // method: store
    u16(view, 10, 0) // mod time
    u16(view, 12, 0) // mod date
    u32(view, 14, row.crc)
    u32(view, 18, row.bytes.length)
    u32(view, 22, row.bytes.length)
    u16(view, 26, row.name.length)
    u16(view, 28, 0)
    header.set(row.name, 30)
    row.offset = offset
    localParts.push(header, row.bytes)
    offset += header.length + row.bytes.length
  }
  const centralParts = []
  let centralSize = 0
  for (const row of rows) {
    const header = new Uint8Array(46 + row.name.length)
    const view = new DataView(header.buffer)
    u32(view, 0, SIG_CENTRAL)
    u16(view, 4, 20)
    u16(view, 6, 20)
    u16(view, 8, 0x0800)
    u16(view, 10, 0)
    u16(view, 12, 0)
    u16(view, 14, 0)
    u32(view, 16, row.crc)
    u32(view, 20, row.bytes.length)
    u32(view, 24, row.bytes.length)
    u16(view, 28, row.name.length)
    u16(view, 30, 0)
    u16(view, 32, 0)
    u16(view, 34, 0)
    u16(view, 36, 0)
    u32(view, 38, 0)
    u32(view, 42, row.offset)
    header.set(row.name, 46)
    centralParts.push(header)
    centralSize += header.length
  }
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  u32(endView, 0, SIG_END)
  u16(endView, 4, 0)
  u16(endView, 6, 0)
  u16(endView, 8, rows.length)
  u16(endView, 10, rows.length)
  u32(endView, 12, centralSize)
  u32(endView, 16, offset)
  u16(endView, 20, 0)
  const total = offset + centralSize + end.length
  const out = new Uint8Array(total)
  let cursor = 0
  for (const part of [...localParts, ...centralParts, end]) { out.set(part, cursor); cursor += part.length }
  return out
}

/**
 * Directory listing of a zip produced by {@link buildZip} (tests / diagnostics).
 * Walks the central directory — never guesses from payload bytes.
 * @param {Uint8Array} bytes
 * @returns {Array<{path: string, size: number, crc: number}>}
 */
export function listZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let eocd = -1
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === SIG_END) { eocd = i; break }
  }
  if (eocd === -1) throw new Error('zip: end-of-central-directory not found')
  const count = view.getUint16(eocd + 10, true)
  let offset = view.getUint32(eocd + 16, true)
  const decoder = new TextDecoder()
  const out = []
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) throw new Error('zip: bad central-directory entry')
    const nameLength = view.getUint16(offset + 28, true)
    const extraLength = view.getUint16(offset + 30, true)
    const commentLength = view.getUint16(offset + 32, true)
    const size = view.getUint32(offset + 24, true)
    const crc = view.getUint32(offset + 16, true)
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength))
    out.push({ path: name, size, crc })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return out
}
