import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { VersionCache } from '../version-cache.js'
import type { VersionCacheEntry } from '../version-cache.js'

describe('VersionCache full', () => {
  let tempDir: string
  let cache: VersionCache

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'substrate-version-cache-test-'))
    cache = new VersionCache(join(tempDir, 'update-cache.json'), 24 * 60 * 60 * 1000)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns null when cache file does not exist', () => {
    expect(cache.read()).toBeNull()
  })

  it('returns null when cache is expired', () => {
    const ttlMs = 24 * 60 * 60 * 1000
    const c = new VersionCache(join(tempDir, 'update-cache.json'), ttlMs)
    const old = new Date(Date.now() - ttlMs - 1000)
    c.write({ lastChecked: old.toISOString(), latestVersion: '1.1.0', currentVersion: '1.0.0' })
    expect(c.read()).toBeNull()
  })

  it('returns entry when cache is fresh', () => {
    cache.write({
      lastChecked: new Date().toISOString(),
      latestVersion: '1.1.0',
      currentVersion: '1.0.0',
    })
    const result = cache.read()
    expect(result).not.toBeNull()
    expect(result?.latestVersion).toBe('1.1.0')
  })

  it('returns null for invalid JSON', () => {
    writeFileSync(join(tempDir, 'update-cache.json'), 'not json', 'utf-8')
    expect(cache.read()).toBeNull()
  })

  it('returns null when missing required fields', () => {
    writeFileSync(
      join(tempDir, 'update-cache.json'),
      JSON.stringify({ lastChecked: new Date().toISOString() }),
      'utf-8'
    )
    expect(cache.read()).toBeNull()
  })
})
