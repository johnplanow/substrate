/**
 * story-discovery — Unified story key resolution for all pipeline entry points.
 *
 * Provides:
 *   - resolveStoryKeys: Single entry point for all story enumeration with fallback chain
 *   - parseStoryKeysFromEpics: Extract N-M story keys from epics.md content
 *   - discoverPendingStoryKeys: Diff epics.md against existing story files
 *
 * resolveStoryKeys implements a 4-level fallback chain:
 *   1. Explicit --stories flag (if provided)
 *   2. Decisions table: category='stories', phase='solutioning'
 *   3. Epic shard decisions: parse story keys from epic-shard decision values
 *   4. epics.md file on disk (via discoverPendingStoryKeys)
 *
 * Used by `substrate run`, `substrate run --from`, and `substrate resume`.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ResolveStoryKeysOptions {
  /** Explicit story keys from --stories flag. Bypasses all DB/file discovery. */
  explicit?: string[]
  /** Scope DB queries to a specific pipeline run (used by resume). */
  pipelineRunId?: string
  /** Filter out stories already completed in previous pipeline runs. */
  filterCompleted?: boolean
  /** Scope discovery to a single epic number (e.g., 27). Filters all levels. */
  epicNumber?: number
}

/**
 * Unified story key resolution with a 4-level fallback chain.
 *
 * 1. Explicit keys (from --stories flag) — returned as-is
 * 2. Decisions table (category='stories', phase='solutioning')
 * 3. Epic shard decisions (category='epic-shard') — parsed with parseStoryKeysFromEpics
 * 4. epics.md file on disk (via discoverPendingStoryKeys)
 *
 * Optionally filters out completed stories when filterCompleted is set.
 *
 * @returns Sorted, deduplicated array of story keys in "N-M" format
 */
export function resolveStoryKeys(
  db: BetterSqlite3Database,
  projectRoot: string,
  opts?: ResolveStoryKeysOptions,
): string[] {
  // Level 1: Explicit --stories flag
  if (opts?.explicit !== undefined && opts.explicit.length > 0) {
    return opts.explicit
  }

  let keys: string[] = []

  // Level 2: Decisions table — category='stories', phase='solutioning'
  // This is where solutioning.ts stores each story with its key directly.
  try {
    const query = opts?.pipelineRunId !== undefined
      ? `SELECT key FROM decisions WHERE phase = 'solutioning' AND category = 'stories' AND pipeline_run_id = ? ORDER BY created_at ASC`
      : `SELECT key FROM decisions WHERE phase = 'solutioning' AND category = 'stories' ORDER BY created_at ASC`

    const params = opts?.pipelineRunId !== undefined ? [opts.pipelineRunId] : []
    const rows = db.prepare(query).all(...params) as Array<{ key: string }>

    for (const row of rows) {
      if (/^\d+-\d+/.test(row.key)) {
        // Extract just the N-M prefix from keys like "1-1-capture-baselines"
        const match = /^(\d+-\d+)/.exec(row.key)
        if (match !== null) keys.push(match[1])
      }
    }
  } catch {
    // DB query failed — fall through to next level
  }

  // Level 3: Epic shard decisions — parse story keys from the shard markdown content
  if (keys.length === 0) {
    try {
      const query = opts?.pipelineRunId !== undefined
        ? `SELECT value FROM decisions WHERE category = 'epic-shard' AND pipeline_run_id = ? ORDER BY created_at ASC`
        : `SELECT value FROM decisions WHERE category = 'epic-shard' ORDER BY created_at ASC`

      const params = opts?.pipelineRunId !== undefined ? [opts.pipelineRunId] : []
      const shardRows = db.prepare(query).all(...params) as Array<{ value: string }>

      const allContent = shardRows.map((r) => r.value).join('\n')
      if (allContent.length > 0) {
        keys = parseStoryKeysFromEpics(allContent)
      }
    } catch {
      // DB query failed — fall through to next level
    }
  }

  // Level 4: epics.md file on disk
  if (keys.length === 0) {
    keys = discoverPendingStoryKeys(projectRoot, opts?.epicNumber)
  }

  // Epic scope filter: if epicNumber is set, filter keys from Levels 2/3 to that epic
  if (opts?.epicNumber !== undefined && keys.length > 0) {
    const prefix = `${opts.epicNumber}-`
    keys = keys.filter((k) => k.startsWith(prefix))
  }

  // Optional: filter out completed stories
  if (opts?.filterCompleted === true && keys.length > 0) {
    const completedKeys = getCompletedStoryKeys(db)
    keys = keys.filter((k) => !completedKeys.has(k))
  }

  return sortStoryKeys([...new Set(keys)])
}

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

  // Pattern 2: ### Story N.M: title  or  ### Story N-M: title  (dot or dash separator)
  const headingPattern = /^###\s+Story\s+(\d+)[.\-](\d+)/gm
  while ((match = headingPattern.exec(content)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      keys.add(`${match[1]}-${match[2]}`)
    }
  }

  // Pattern 4: Inline story references like "Story 26-1: title" (in story maps, sprint plans)
  const inlineStoryPattern = /Story\s+(\d+)-(\d+)[:\s]/g
  while ((match = inlineStoryPattern.exec(content)) !== null) {
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
export function discoverPendingStoryKeys(projectRoot: string, epicNumber?: number): string[] {
  let allKeys: string[] = []

  if (epicNumber !== undefined) {
    // Scoped: scan only the specific epic file
    const epicFiles = findEpicFiles(projectRoot)
    const targetPattern = new RegExp(`^epic-${epicNumber}[^0-9]`)
    const matched = epicFiles.filter((f) => targetPattern.test(f.split('/').pop()!))
    for (const epicFile of matched) {
      try {
        const content = readFileSync(epicFile, 'utf-8')
        const keys = parseStoryKeysFromEpics(content)
        allKeys.push(...keys)
      } catch {
        // skip unreadable files
      }
    }
    allKeys = sortStoryKeys([...new Set(allKeys)])
  } else {
    // Try consolidated epics.md first
    const epicsPath = findEpicsFile(projectRoot)
    if (epicsPath !== undefined) {
      try {
        const content = readFileSync(epicsPath, 'utf-8')
        allKeys = parseStoryKeysFromEpics(content)
      } catch {
        // fall through to individual epic files
      }
    }

    // If no keys from epics.md, scan individual epic-*.md files
    if (allKeys.length === 0) {
      const epicFiles = findEpicFiles(projectRoot)
      for (const epicFile of epicFiles) {
        try {
          const content = readFileSync(epicFile, 'utf-8')
          const keys = parseStoryKeysFromEpics(content)
          allKeys.push(...keys)
        } catch {
          // skip unreadable files
        }
      }
      allKeys = sortStoryKeys([...new Set(allKeys)])
    }
  }

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
 * Find epic files from known candidate paths relative to projectRoot.
 *
 * Checks for:
 *   1. epics.md (consolidated epic file)
 *   2. Individual epic-*.md files in planning-artifacts/
 *
 * Returns a single path for epics.md, or undefined if not found.
 * For individual epic files, use findEpicFiles() instead.
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
 * Find individual epic-*.md files in the planning artifacts directory.
 * Returns paths sorted alphabetically.
 */
function findEpicFiles(projectRoot: string): string[] {
  const planningDir = join(projectRoot, '_bmad-output', 'planning-artifacts')
  if (!existsSync(planningDir)) return []

  try {
    const entries = readdirSync(planningDir, { encoding: 'utf-8' })
    return entries
      .filter((e) => /^epic-\d+.*\.md$/.test(e))
      .sort()
      .map((e) => join(planningDir, e))
  } catch {
    return []
  }
}

/**
 * Collect story keys that already have implementation artifact files.
 * Scans _bmad-output/implementation-artifacts/ for files matching N-M-*.md.
 */
function collectExistingStoryKeys(projectRoot: string): Set<string> {
  const existing = new Set<string>()
  const artifactsDir = join(projectRoot, '_bmad-output', 'implementation-artifacts')

  if (!existsSync(artifactsDir)) return existing

  let entries: string[]
  try {
    entries = readdirSync(artifactsDir, { encoding: 'utf-8' })
  } catch {
    return existing
  }

  // Match filenames like N-M-slug.md  (e.g. 7-2-human-turn-loop.md)
  const filePattern = /^(\d+-\d+)-/

  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    const m = filePattern.exec(entry)
    if (m !== null && m[1] !== undefined) {
      existing.add(m[1])
    }
  }

  return existing
}

/**
 * Collect story keys already completed in previous pipeline runs.
 * Scans pipeline_runs with status='completed' and extracts story keys
 * with phase='COMPLETE' from their token_usage_json state.
 */
function getCompletedStoryKeys(db: BetterSqlite3Database): Set<string> {
  const completed = new Set<string>()
  try {
    const rows = db
      .prepare(
        `SELECT token_usage_json FROM pipeline_runs WHERE status = 'completed' AND token_usage_json IS NOT NULL`,
      )
      .all() as Array<{ token_usage_json: string }>

    for (const row of rows) {
      try {
        const state = JSON.parse(row.token_usage_json) as {
          stories?: Record<string, { phase: string }>
        }
        if (state.stories !== undefined) {
          for (const [key, s] of Object.entries(state.stories)) {
            if (s.phase === 'COMPLETE') {
              completed.add(key)
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    }
  } catch {
    // ignore query errors
  }
  return completed
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
