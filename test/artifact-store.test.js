import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createArtifactStore,
  gcArtifacts,
  objectPath,
  parseRef,
  refFor,
  retraceDomainSpec,
} from '../lib/artifact-store.js'

const roots = []

async function freshRoot() {
  const root = await mkdtemp(join(tmpdir(), 'retrace-artifacts-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('createArtifactStore', () => {
  it('saves and reads bytes back with integrity', async () => {
    const store = createArtifactStore(await freshRoot())
    const bytes = new TextEncoder().encode('hello artifact world')
    const { sha256, sizeBytes, existed } = await store.save(bytes)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(sizeBytes).toBe(bytes.byteLength)
    expect(existed).toBe(false)

    const back = await store.read(sha256)
    expect(Buffer.from(back).toString('utf8')).toBe('hello artifact world')
    // layout: objects/<first2>/<sha>
    expect(store.pathOf(sha256)).toBe(join(store.root, 'objects', sha256.slice(0, 2), sha256))
  })

  it('deduplicates identical bytes (hardlink publish, existed flag)', async () => {
    const store = createArtifactStore(await freshRoot())
    const bytes = new TextEncoder().encode('same content')
    const first = await store.save(bytes)
    const second = await store.save(bytes)
    expect(second.sha256).toBe(first.sha256)
    expect(second.existed).toBe(true)
    expect(await store.list()).toEqual([first.sha256])
  })

  it('rejects a corrupted object on read', async () => {
    const store = createArtifactStore(await freshRoot())
    const { sha256 } = await store.save(new TextEncoder().encode('integrity matters'))
    // Corrupt the stored object behind the store's back.
    await writeFile(store.pathOf(sha256), 'tampered bytes')
    await expect(store.read(sha256)).rejects.toThrow(/integrity/)
  })

  it('lists, removes, and gc-prunes unreferenced objects', async () => {
    const store = createArtifactStore(await freshRoot())
    const a = await store.save(new TextEncoder().encode('object a'))
    const b = await store.save(new TextEncoder().encode('object b'))
    const c = await store.save(new TextEncoder().encode('object c'))
    expect(await store.list()).toEqual([a.sha256, b.sha256, c.sha256].sort())

    await store.remove(b.sha256)
    expect(await store.list()).toEqual([a.sha256, c.sha256].sort())

    const removed = await gcArtifacts(store, new Set([a.sha256]))
    expect(removed).toBe(1)
    expect(await store.list()).toEqual([a.sha256])
  })

  it('is a no-op list on a missing objects dir', async () => {
    const store = createArtifactStore(await freshRoot())
    expect(await store.list()).toEqual([])
  })
})

describe('retraceDomainSpec', () => {
  it('declares the retrace domain (refcounts + global)', () => {
    expect(retraceDomainSpec.name).toBe('retrace')
    expect(retraceDomainSpec.version).toBe(1)
    expect(Object.keys(retraceDomainSpec.tables)).toEqual(['refcounts', 'versiongit'])
    expect(retraceDomainSpec.global).toBeDefined()
    expect(retraceDomainSpec.global.initial).toEqual({ retentionLimit: 50, gitEnabled: true })
    // global must not accept null (storage sentinel), per the domain contract
    expect(retraceDomainSpec.global.schema.safeParse(null).success).toBe(false)
  })
})

describe('references', () => {
  it('round-trips versionId:path references', () => {
    expect(refFor('v12', 'src/a.ts')).toBe('v12:src/a.ts')
    expect(parseRef('v12:src/a.ts')).toEqual({ versionId: 'v12', path: 'src/a.ts' })
    expect(parseRef('noseparator')).toEqual({ versionId: null, path: 'noseparator' })
  })
})

describe('objectPath', () => {
  it('addresses content by sha prefix buckets', () => {
    const sha = 'a'.repeat(64)
    expect(objectPath('/root', sha)).toBe('/root/objects/aa/' + sha)
  })
})
