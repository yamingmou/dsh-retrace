import { describe, it, expect } from 'vitest'
import { DEFAULT_CONFIG, parseRetraceConfig, ROUTE_PREFIX } from '../lib/http.js'

describe('parseRetraceConfig', () => {
  it('returns defaults for missing or empty headers', () => {
    expect(parseRetraceConfig(undefined)).toEqual(DEFAULT_CONFIG)
    expect(parseRetraceConfig('')).toEqual(DEFAULT_CONFIG)
  })

  it('parses a full client config', () => {
    expect(parseRetraceConfig(JSON.stringify({ versioning: false, git: false, retentionLimit: 10 }))).toEqual({
      versioning: false,
      git: false,
      retentionLimit: 10,
    })
  })

  it('merges partial configs onto defaults', () => {
    expect(parseRetraceConfig(JSON.stringify({ versioning: false }))).toEqual({
      ...DEFAULT_CONFIG,
      versioning: false,
    })
  })

  it('rejects malformed JSON and invalid field types', () => {
    expect(parseRetraceConfig('not json')).toEqual(DEFAULT_CONFIG)
    expect(parseRetraceConfig(JSON.stringify({ versioning: 'yes', retentionLimit: -5 }))).toEqual(DEFAULT_CONFIG)
  })
})

describe('ROUTE_PREFIX', () => {
  it('keeps the published route contract', () => {
    expect(ROUTE_PREFIX).toBe('/api/plugins/retrace')
  })
})
