/**
 * Unit tests for VersionCache.
 *
 * Uses a temporary directory for cache files to avoid touching the real home dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { VersionCache } from '../version-cache.js'
import type { VersionCacheEntry } from '../version-cache.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'substrate-version-cache-test-'))
}

function freshEntry(): VersionCacheEntry {
  return {
    lastChecked: new Date().toISOString(),
    latestVersion: '1.1.0',
    currentVersion: '1.0.0',
  }
}

function expiredEntry(ttlMs: number): VersionCacheEntry {
  const old = new Date(Date.now() - ttlMs - 1000)
  return {
    lastChecked: old.toISOString(),
    latestVersion: '1.1.0',
    currentVersion: '1.0.0',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VersionCache', () => {
  let tempDir: string
  let cachePath: string
  let cache: VersionCache

  beforeEach(() => {
    tempDir = makeTempDir()
    cachePath = join(tempDir, 'update-cache.json')
    cache = new VersionCache(cachePath, 24 * 60 * 60 * 1000)
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // read()
  // -------------------------------------------------------------------------

  describe('read()', () => {
    it('returns null when cache file does not exist', () => {
      expect(cache.read()).toBeNull()
    })

    it('returns null when cache is expired', () => {
      const ttlMs = 24 * 60 * 60 * 1000
      const c = new VersionCache(cachePath, ttlMs)
      c.write(expiredEntry(ttlMs))
      expect(c.read()).toBeNull()
    })

    it('returns entry when cache is fresh', () => {
      const entry = freshEntry()
      cache.write(entry)
      const result = cache.read()
      expect(result).not.toBeNull()
      expect(result?.latestVersion).toBe('1.1.0')
      expect(result?.currentVersion).toBe('1.0.0')
    })

    it('returns null when cache file contains invalid JSON', () => {
      writeFileSync(cachePath, 'not json', 'utf-8')
      expect(cache.read()).toBeNull()
    })

    it('returns null when cache entry is missing required fields', () => {
      writeFileSync(cachePath, JSON.stringify({ lastChecked: new Date().toISOString() }), 'utf-8')
      expect(cache.read()).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // write()
  // -------------------------------------------------------------------------

  describe('write()', () => {
    it('creates parent directory if missing', () => {
      const nestedPath = join(tempDir, 'nested', 'deep', 'update-cache.json')
      const nestedCache = new VersionCache(nestedPath)
      nestedCache.write(freshEntry())
      expect(existsSync(nestedPath)).toBe(true)
    })

    it('serializes to valid JSON', () => {
      const entry = freshEntry()
      cache.write(entry)
      const raw = readFileSync(cachePath, 'utf-8')
      const parsed = JSON.parse(raw) as VersionCacheEntry
      expect(parsed.latestVersion).toBe(entry.latestVersion)
      expect(parsed.currentVersion).toBe(entry.currentVersion)
      expect(parsed.lastChecked).toBe(entry.lastChecked)
    })

    it('silently swallows write errors (read-only path)', () => {
      // Writing to a path that cannot be created should not throw
      const invalidCache = new VersionCache('/proc/invalid/update-cache.json')
      expect(() => invalidCache.write(freshEntry())).not.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // isExpired()
  // -------------------------------------------------------------------------

  describe('isExpired()', () => {
    it('returns false for a freshly-written entry', () => {
      const entry = freshEntry()
      expect(cache.isExpired(entry)).toBe(false)
    })

    it('returns true for an old entry that exceeds TTL', () => {
      const ttlMs = 1000
      const c = new VersionCache(cachePath, ttlMs)
      const entry = expiredEntry(ttlMs)
      expect(c.isExpired(entry)).toBe(true)
    })

    it('returns false for entry just within TTL', () => {
      const ttlMs = 60 * 1000
      const c = new VersionCache(cachePath, ttlMs)
      const entry: VersionCacheEntry = {
        lastChecked: new Date(Date.now() - ttlMs + 5000).toISOString(),
        latestVersion: '1.1.0',
        currentVersion: '1.0.0',
      }
      expect(c.isExpired(entry)).toBe(false)
    })
  })
})
