/**
 * Unit tests for VersionManagerImpl.
 *
 * Uses mocked UpdateChecker and VersionCache to avoid network/disk I/O.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { VersionManagerImpl } from '../version-manager-impl.js'
import type { VersionCache } from '../version-cache.js'
import type { VersionCacheEntry } from '../version-cache.js'
import type { UpdateChecker } from '../update-checker.js'

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function buildMockCache(entry: VersionCacheEntry | null = null): VersionCache {
  return {
    read: vi.fn(() => entry),
    write: vi.fn(),
    isExpired: vi.fn((e: VersionCacheEntry) => false),
  } as unknown as VersionCache
}

function buildMockChecker(latestVersion = '1.1.0'): UpdateChecker {
  return {
    fetchLatestVersion: vi.fn().mockResolvedValue(latestVersion),
    isBreaking: vi.fn((current: string, latest: string) => {
      const cMajor = parseInt(current.split('.')[0] ?? '0', 10)
      const lMajor = parseInt(latest.split('.')[0] ?? '0', 10)
      return lMajor > cMajor
    }),
    getChangelog: vi.fn((v: string) => `https://example.com/releases/v${v}`),
  } as unknown as UpdateChecker
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VersionManagerImpl', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // getCurrentVersion
  // -------------------------------------------------------------------------

  describe('getCurrentVersion()', () => {
    it('returns a valid semver string', () => {
      const manager = new VersionManagerImpl()
      const version = manager.getCurrentVersion()
      // Must match semver format x.y.z
      expect(version).toMatch(/^\d+\.\d+\.\d+/)
    })
  })

  // -------------------------------------------------------------------------
  // checkForUpdates
  // -------------------------------------------------------------------------

  describe('checkForUpdates()', () => {
    it('returns cached result without calling fetchLatestVersion when cache is fresh', async () => {
      const cachedEntry: VersionCacheEntry = {
        lastChecked: new Date().toISOString(),
        latestVersion: '1.1.0',
        currentVersion: '1.0.0',
      }
      const mockCache = buildMockCache(cachedEntry)
      const mockChecker = buildMockChecker()

      const manager = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })
      const result = await manager.checkForUpdates()

      expect(result.latestVersion).toBe('1.1.0')
      expect(result.updateAvailable).toBe(true)
      expect(mockChecker.fetchLatestVersion).not.toHaveBeenCalled()
    })

    it('calls fetchLatestVersion and writes cache when cache is expired (null)', async () => {
      const mockCache = buildMockCache(null)
      const mockChecker = buildMockChecker('1.2.0')

      const manager = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })
      const result = await manager.checkForUpdates()

      expect(mockChecker.fetchLatestVersion).toHaveBeenCalledWith('substrate-ai')
      expect(mockCache.write).toHaveBeenCalled()
      expect(result.latestVersion).toBe('1.2.0')
      expect(result.updateAvailable).toBe(true)
    })

    it('returns updateAvailable: false when SUBSTRATE_NO_UPDATE_CHECK=1', async () => {
      vi.stubEnv('SUBSTRATE_NO_UPDATE_CHECK', '1')

      const mockCache = buildMockCache(null)
      const mockChecker = buildMockChecker()
      const manager = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })

      const result = await manager.checkForUpdates()

      expect(result.updateAvailable).toBe(false)
      expect(mockChecker.fetchLatestVersion).not.toHaveBeenCalled()
    })

    it('returns updateAvailable: false when updateCheckEnabled is false (AC5: update_check: false in config)', async () => {
      const mockCache = buildMockCache(null)
      const mockChecker = buildMockChecker()
      const manager = new VersionManagerImpl({
        cache: mockCache,
        updateChecker: mockChecker,
        updateCheckEnabled: false,
      })

      const result = await manager.checkForUpdates()

      expect(result.updateAvailable).toBe(false)
      expect(mockChecker.fetchLatestVersion).not.toHaveBeenCalled()
    })

    it('bypasses cache when forceRefresh is true', async () => {
      const cachedEntry = {
        lastChecked: new Date().toISOString(),
        latestVersion: '1.0.0',
        currentVersion: '1.0.0',
      }
      const mockCache = buildMockCache(cachedEntry)
      const mockChecker = buildMockChecker('1.2.0')

      const manager = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })
      const result = await manager.checkForUpdates(true)

      // Should have fetched from npm even though cache was fresh
      expect(mockChecker.fetchLatestVersion).toHaveBeenCalledWith('substrate-ai')
      expect(result.latestVersion).toBe('1.2.0')
    })

    it('returns updateAvailable: false when no update exists (same version)', async () => {
      const manager = new VersionManagerImpl()
      const currentVersion = manager.getCurrentVersion()

      const cachedEntry: VersionCacheEntry = {
        lastChecked: new Date().toISOString(),
        latestVersion: currentVersion,
        currentVersion,
      }
      const mockCache = buildMockCache(cachedEntry)
      const mockChecker = buildMockChecker(currentVersion)
      const m2 = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })

      const result = await m2.checkForUpdates()
      expect(result.updateAvailable).toBe(false)
    })

    it('returns updateAvailable: false on network failure (never blocks CLI)', async () => {
      const mockCache = buildMockCache(null)
      const mockChecker = buildMockChecker()
      ;(mockChecker.fetchLatestVersion as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('ECONNREFUSED')
      )

      const manager = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })
      const result = await manager.checkForUpdates()

      expect(result.updateAvailable).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // getUpgradePreview
  // -------------------------------------------------------------------------

  describe('getUpgradePreview()', () => {
    it('sets breaking changes when major version increases', () => {
      // Provide a mock that returns current version 1.x.x
      const mockCache = buildMockCache(null)
      const mockChecker = buildMockChecker('2.0.0')
      ;(mockChecker.isBreaking as ReturnType<typeof vi.fn>).mockImplementation(
        (current: string, latest: string) => {
          return parseInt(latest.split('.')[0] ?? '0', 10) > parseInt(current.split('.')[0] ?? '0', 10)
        }
      )

      const manager = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })
      const preview = manager.getUpgradePreview('2.0.0')

      expect(preview.breakingChanges.length).toBeGreaterThan(0)
      expect(preview.toVersion).toBe('2.0.0')
    })

    it('has empty breakingChanges for minor/patch bumps', () => {
      const mockCache = buildMockCache(null)
      const mockChecker = buildMockChecker('0.2.0')
      ;(mockChecker.isBreaking as ReturnType<typeof vi.fn>).mockReturnValue(false)

      const manager = new VersionManagerImpl({ cache: mockCache, updateChecker: mockChecker })
      const preview = manager.getUpgradePreview('0.2.0')

      expect(preview.breakingChanges).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // isConfigCompatible / isTaskGraphCompatible
  // -------------------------------------------------------------------------

  describe('isConfigCompatible()', () => {
    it('returns true for supported config version "1"', () => {
      const manager = new VersionManagerImpl()
      expect(manager.isConfigCompatible('1')).toBe(true)
    })

    it('returns false for unsupported config version "99"', () => {
      const manager = new VersionManagerImpl()
      expect(manager.isConfigCompatible('99')).toBe(false)
    })
  })

  describe('isTaskGraphCompatible()', () => {
    it('returns true for supported task graph version "1"', () => {
      const manager = new VersionManagerImpl()
      expect(manager.isTaskGraphCompatible('1')).toBe(true)
    })

    it('returns false for unsupported task graph version "99"', () => {
      const manager = new VersionManagerImpl()
      expect(manager.isTaskGraphCompatible('99')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // migrateConfiguration / migrateTaskGraphFormat
  // -------------------------------------------------------------------------

  describe('migrateConfiguration()', () => {
    it('returns a MigrationResult (success: true when same version)', () => {
      const manager = new VersionManagerImpl()
      const result = manager.migrateConfiguration('1', '1')
      expect(result.success).toBe(true)
      expect(result.fromVersion).toBe('1')
      expect(result.toVersion).toBe('1')
    })
  })

  describe('migrateTaskGraphFormat()', () => {
    it('returns a MigrationResult', () => {
      const manager = new VersionManagerImpl()
      const result = manager.migrateTaskGraphFormat('1', '1', '/fake/path')
      expect(result.success).toBe(true)
    })
  })
})
