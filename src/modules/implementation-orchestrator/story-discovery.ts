/**
 * story-discovery — Auto-discover pending story keys from epics.md.
 *
 * Provides two exported functions:
 *   - parseStoryKeysFromEpics: Extract N-M story keys from epics.md content
 *   - discoverPendingStoryKeys: Diff epics.md against existing story files
 *
 * Used as a fallback in `substrate auto run` when the requirements table is empty
 * (e.g. projects that ran BMAD manually and skipped the full Substrate pipeline).
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract all story keys (N-M format) from epics.md content.
 *
 * Supports three extraction patterns found in real epics.md files:
 *   1. Explicit key lines:  **Story key:** `7-2-human-turn-loop`  → extracts "7-2"
 *   2. Story headings:      ### Story 7.2: Human Turn Loop        → extracts "7-2"
 *   3. File path refs:      _bmad-output/implementation-artifacts/7-2-human-turn-loop.md → extracts "7-2"
 *
 * Keys are deduplicated and sorted numerically (epic number primary, story number secondary).
 *
 * @param content - Raw string content of epics.md
 * @returns Sorted, deduplicated array of story key strings in "N-M" format
 */
export function parseStoryKeysFromEpics(content: string): string[] {
  if (content.length === 0) return []

  const keys = new Set<string>()

  // Pattern 1: **Story key:** `N-M-optional-slug` or **Story key:** N-M
  const explicitKeyPattern = /\*\*Story key:\*\*\s*`?(\d+-\d+)(?:-[^`\s]*)?`?/g
  let match: RegExpExecArray | null
  while ((match = explicitKeyPattern.exec(content)) !== null) {
    if (match[1] !== undefined) {
      keys.add(match[1])
    }
  }

  // Pattern 2: ### Story N.M: title  or  ### Story N.M title
  const headingPattern = /^###\s+Story\s+(\d+)\.(\d+)/gm
  while ((match = headingPattern.exec(content)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      keys.add(`${match[1]}-${match[2]}`)
    }
  }

  // Pattern 3: file path reference _bmad-output/implementation-artifacts/N-M-slug.md
  const filePathPattern = /_bmad-output\/implementation-artifacts\/(\d+-\d+)-/g
  while ((match = filePathPattern.exec(content)) !== null) {
    if (match[1] !== undefined) {
      keys.add(match[1])
    }
  }

  return sortStoryKeys(Array.from(keys))
}

/**
 * Discover pending story keys by diffing epics.md against existing story files.
 *
 * Algorithm:
 *   1. Read _bmad-output/planning-artifacts/epics.md (falls back to _bmad-output/epics.md)
 *   2. Extract all story keys from epics.md
 *   3. Glob _bmad-output/implementation-artifacts/ for N-M-*.md files
 *   4. Return keys from step 2 that are NOT in step 3 (pending work)
 *
 * Returns an empty array (without error) if epics.md does not exist.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @returns Sorted array of pending story keys in "N-M" format
 */
export function discoverPendingStoryKeys(projectRoot: string): string[] {
  // Locate epics.md
  const epicsPath = findEpicsFile(projectRoot)
  if (epicsPath === undefined) return []

  let content: string
  try {
    content = readFileSync(epicsPath, 'utf-8')
  } catch {
    return []
  }

  const allKeys = parseStoryKeysFromEpics(content)
  if (allKeys.length === 0) return []

  // Collect existing story file keys
  const existingKeys = collectExistingStoryKeys(projectRoot)

  // Pending = all keys minus existing keys
  return allKeys.filter((k) => !existingKeys.has(k))
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Find epics.md from known candidate paths relative to projectRoot.
 */
function findEpicsFile(projectRoot: string): string | undefined {
  const candidates = [
    '_bmad-output/planning-artifacts/epics.md',
    '_bmad-output/epics.md',
  ]
  for (const candidate of candidates) {
    const fullPath = join(projectRoot, candidate)
    if (existsSync(fullPath)) return fullPath
  }
  return undefined
}

/**
 * Collect story keys that already have implementation artifact files.
 * Scans _bmad-output/implementation-artifacts/ for files matching N-M-*.md.
 */
function collectExistingStoryKeys(projectRoot: string): Set<string> {
  const existing = new Set<string>()
  const artifactsDir = join(projectRoot, '_bmad-output', 'implementation-artifacts')

  if (!existsSync(artifactsDir)) return existing

  let entries: ReturnType<typeof readdirSync>
  try {
    entries = readdirSync(artifactsDir)
  } catch {
    return existing
  }

  // Match filenames like N-M-slug.md  (e.g. 7-2-human-turn-loop.md)
  const filePattern = /^(\d+-\d+)-/

  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry.name
    if (!name.endsWith('.md')) continue
    const m = filePattern.exec(name)
    if (m !== null && m[1] !== undefined) {
      existing.add(m[1])
    }
  }

  return existing
}

/**
 * Sort story keys numerically by epic number (primary) then story number (secondary).
 * E.g. ["10-1", "1-2", "2-1"] → ["1-2", "2-1", "10-1"]
 */
function sortStoryKeys(keys: string[]): string[] {
  return keys.slice().sort((a, b) => {
    const [ae, as_] = a.split('-').map(Number)
    const [be, bs] = b.split('-').map(Number)
    const epicDiff = (ae ?? 0) - (be ?? 0)
    if (epicDiff !== 0) return epicDiff
    return (as_ ?? 0) - (bs ?? 0)
  })
}
