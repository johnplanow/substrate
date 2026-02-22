/**
 * VersionCache — reads and writes the update-check result cache file.
 *
 * Cache is stored at ~/.substrate/update-cache.json (global, across all projects).
 * TTL defaults to 24 hours. (AC4)
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import os from 'os'
import path from 'path'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Serialized cache entry stored in update-cache.json.
 */
export interface VersionCacheEntry {
  /** ISO 8601 timestamp of the last successful check */
  lastChecked: string
  /** Latest version returned by the npm registry */
  latestVersion: string
  /** The installed version at the time of the check */
  currentVersion: string
}

// ---------------------------------------------------------------------------
// VersionCache class
// ---------------------------------------------------------------------------

/**
 * Manages reading and writing the version check result cache.
 *
 * Write errors are silently swallowed so that a read-only home directory
 * never breaks CLI execution.
 */
export class VersionCache {
  private readonly cachePath: string
  private readonly ttlMs: number

  constructor(
    cachePath: string = path.join(os.homedir(), '.substrate', 'update-cache.json'),
    ttlMs: number = 24 * 60 * 60 * 1000
  ) {
    this.cachePath = cachePath
    this.ttlMs = ttlMs
  }

  /**
   * Read the cache file. Returns null if the file is missing, unreadable, or expired.
   */
  read(): VersionCacheEntry | null {
    try {
      const raw = readFileSync(this.cachePath, 'utf-8')
      const entry = JSON.parse(raw) as VersionCacheEntry

      if (
        typeof entry.lastChecked !== 'string' ||
        typeof entry.latestVersion !== 'string' ||
        typeof entry.currentVersion !== 'string'
      ) {
        return null
      }

      if (this.isExpired(entry)) {
        return null
      }

      return entry
    } catch {
      return null
    }
  }

  /**
   * Write a cache entry to disk. Creates the parent directory if needed.
   * Silently swallows any write errors.
   */
  write(entry: VersionCacheEntry): void {
    try {
      mkdirSync(dirname(this.cachePath), { recursive: true })
      writeFileSync(this.cachePath, JSON.stringify(entry, null, 2), 'utf-8')
    } catch {
      // Silently swallow write errors — a missing cache is handled gracefully
    }
  }

  /**
   * Check whether a cache entry has expired according to the configured TTL.
   */
  isExpired(entry: VersionCacheEntry): boolean {
    const age = Date.now() - new Date(entry.lastChecked).getTime()
    return age > this.ttlMs
  }
}
