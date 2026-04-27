/**
 * story-discovery — Unified story key resolution for all pipeline entry points.
 *
 * Provides:
 *   - resolveStoryKeys: Single entry point for all story enumeration with fallback chain
 *   - parseStoryKeysFromEpics: Extract N-M story keys from epics.md content
 *   - discoverPendingStoryKeys: Diff epics.md against existing story files
 *
 * resolveStoryKeys implements a 5-level fallback chain:
 *   1. Explicit --stories flag (if provided)
 *   1.5. ready_stories SQL view (if work graph is populated; story 31-3)
 *   2. Decisions table: category='stories', phase='solutioning'
 *   3. Epic shard decisions: parse story keys from epic-shard decision values
 *   4. epics.md file on disk (via discoverPendingStoryKeys)
 *
 * Used by `substrate run`, `substrate run --from`, and `substrate resume`.
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseAdapter } from '../../persistence/adapter.js'

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
 * Unified story key resolution with a 5-level fallback chain.
 *
 * 1. Explicit keys (from --stories flag) — returned as-is
 * 1.5. ready_stories SQL view — when work graph is populated (story 31-3)
 * 2. Decisions table (category='stories', phase='solutioning')
 * 3. Epic shard decisions (category='epic-shard') — parsed with parseStoryKeysFromEpics
 * 4. epics.md file on disk (via discoverPendingStoryKeys)
 *
 * Optionally filters out completed stories when filterCompleted is set.
 *
 * @returns Sorted, deduplicated array of story keys in "N-M" format
 */
export async function resolveStoryKeys(
  db: DatabaseAdapter,
  projectRoot: string,
  opts?: ResolveStoryKeysOptions,
): Promise<string[]> {
  // Level 1: Explicit --stories flag
  // Topologically sort by inter-story dependencies from the epics document
  // so that prerequisite stories are dispatched before their dependents.
  if (opts?.explicit !== undefined && opts.explicit.length > 0) {
    return topologicalSortByDependencies(opts.explicit, projectRoot)
  }

  let keys: string[] = []

  // Level 1.5: ready_stories SQL view — when work graph is populated (story 31-3)
  // If the view returns results, use those and skip Levels 2-4.
  const readyKeys = await db.queryReadyStories()
  if (readyKeys.length > 0) {
    // Apply epic scope filter if requested
    let filteredKeys = readyKeys
    if (opts?.epicNumber !== undefined) {
      const prefix = `${opts.epicNumber}-`
      filteredKeys = filteredKeys.filter((k) => k.startsWith(prefix))
    }
    // Apply completed filter if requested
    if (opts?.filterCompleted === true && filteredKeys.length > 0) {
      const completedKeys = await getCompletedStoryKeys(db)
      filteredKeys = filteredKeys.filter((k) => !completedKeys.has(k))
    }
    // Startup reconciliation: exclude stories that already have committed
    // implementation artifacts. These were completed in a prior run or manual
    // commit but the work graph wasn't updated. Also reconcile wg_stories
    // status so ready_stories stays accurate for future queries.
    const existingArtifacts = collectExistingStoryKeys(projectRoot)
    const alreadyDone = filteredKeys.filter((k) => existingArtifacts.has(k))
    if (alreadyDone.length > 0) {
      filteredKeys = filteredKeys.filter((k) => !existingArtifacts.has(k))
      // Best-effort: update wg_stories status to 'complete' for reconciled stories
      for (const key of alreadyDone) {
        db.query(
          `UPDATE wg_stories SET status = 'complete', completed_at = ? WHERE story_key = ? AND status <> 'complete'`,
          [new Date().toISOString(), key],
        ).catch(() => { /* best-effort */ })
      }
    }
    return sortStoryKeys([...new Set(filteredKeys)])
  }

  // Level 2: Decisions table — category='stories', phase='solutioning'
  // This is where solutioning.ts stores each story with its key directly.
  try {
    const sql = opts?.pipelineRunId !== undefined
      ? "SELECT `key` FROM decisions WHERE phase = 'solutioning' AND category = 'stories' AND pipeline_run_id = ? ORDER BY created_at ASC"
      : "SELECT `key` FROM decisions WHERE phase = 'solutioning' AND category = 'stories' ORDER BY created_at ASC"

    const params = opts?.pipelineRunId !== undefined ? [opts.pipelineRunId] : []
    const rows = await db.query<{ key: string }>(sql, params)

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
      const sql = opts?.pipelineRunId !== undefined
        ? `SELECT value FROM decisions WHERE category = 'epic-shard' AND pipeline_run_id = ? ORDER BY created_at ASC`
        : `SELECT value FROM decisions WHERE category = 'epic-shard' ORDER BY created_at ASC`

      const params = opts?.pipelineRunId !== undefined ? [opts.pipelineRunId] : []
      const shardRows = await db.query<{ value: string }>(sql, params)

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
    const completedKeys = await getCompletedStoryKeys(db)
    keys = keys.filter((k) => !completedKeys.has(k))
  }

  // Startup reconciliation: exclude stories with existing implementation
  // artifacts (Levels 2/3 don't check artifacts — Level 4 already does via
  // discoverPendingStoryKeys, but this catch-all covers all fallback paths).
  if (keys.length > 0) {
    const existingArtifacts = collectExistingStoryKeys(projectRoot)
    keys = keys.filter((k) => !existingArtifacts.has(k))
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

  // Pattern 1: **Story key:** `N-Ma-optional-slug` or **Story key:** N-Ma
  const explicitKeyPattern = /\*\*Story key:\*\*\s*`?([A-Za-z0-9]+-[A-Za-z0-9]+)(?:-[^`\s]*)?`?/g
  let match: RegExpExecArray | null
  while ((match = explicitKeyPattern.exec(content)) !== null) {
    if (match[1] !== undefined) {
      keys.add(match[1])
    }
  }

  // Pattern 2: ### Story N-Ma: title  or  ### Story N.M: title  (dot or dash separator)
  // Captures letter suffixes like 1-1a, 1-2b, and non-numeric prefixes like NEW-26, E5
  const headingPattern = /^###\s+Story\s+([A-Za-z0-9]+)[.\-]([A-Za-z0-9]+)/gm
  while ((match = headingPattern.exec(content)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      keys.add(`${match[1]}-${match[2]}`)
    }
  }

  // Pattern 4: Inline story references like "Story 26-1: title" or "Story 1-1a: title"
  const inlineStoryPattern = /Story\s+([A-Za-z0-9]+)-([A-Za-z0-9]+)[:\s]/g
  while ((match = inlineStoryPattern.exec(content)) !== null) {
    if (match[1] !== undefined && match[2] !== undefined) {
      keys.add(`${match[1]}-${match[2]}`)
    }
  }

  // Pattern 3: file path reference _bmad-output/implementation-artifacts/KEY-slug.md
  const filePathPattern = /_bmad-output\/implementation-artifacts\/([A-Za-z0-9]+-[A-Za-z0-9]+)-/g
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

  // Supplement with sprint-status.yaml if it exists (catches NEW-*, E-* keys not in epics.md)
  const sprintKeys = parseStoryKeysFromSprintStatus(projectRoot)
  if (sprintKeys.length > 0) {
    const merged = new Set(allKeys)
    for (const k of sprintKeys) merged.add(k)
    allKeys = sortStoryKeys([...merged])
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
export function findEpicsFile(projectRoot: string): string | undefined {
  // Check exact candidates first
  const candidates = [
    '_bmad-output/planning-artifacts/epics.md',
    '_bmad-output/epics.md',
  ]
  for (const candidate of candidates) {
    const fullPath = join(projectRoot, candidate)
    if (existsSync(fullPath)) return fullPath
  }

  // Glob for consolidated epics files (e.g. epics-and-stories-*.md)
  const planningDir = join(projectRoot, '_bmad-output', 'planning-artifacts')
  if (existsSync(planningDir)) {
    try {
      const entries = readdirSync(planningDir, { encoding: 'utf-8' })
      const match = entries
        .filter((e) => /^epics[-.].*\.md$/i.test(e) && !(/^epic-\d+/.test(e)))
        .sort()
      if (match.length > 0) return join(planningDir, match[0])
    } catch {
      // fall through
    }
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
 * Story 61-3: find the epic file relevant to a specific story.
 *
 * Sibling to `findEpicsFile` for the verification path
 * (`assembleVerificationContext` populates `sourceEpicContent` from this).
 * `findEpicsFile` only checks the consolidated convention (`epics.md`)
 * → returns undefined for projects using per-epic files (substrate's own
 * planning artifacts), causing `SourceAcFidelityCheck` to silently skip
 * with a `source-ac-source-unavailable` warn — exactly what happened on
 * the 60-12 redispatch (run 4700c6e8, 2026-04-27).
 *
 * Story 61-3 v2 (post-round-3): the v1 implementation honored
 * findEpicsFile's returned path without verifying it contained the
 * requested story. substrate's own findEpicsFile glob-matches
 * `epics-and-stories-*.md` files, so for projects with stale consolidated
 * files (substrate has `epics-and-stories-software-factory.md` for old
 * epics 40-50) the function returned that path → caller's
 * extractStorySection found nothing for new stories → sourceEpicContent
 * stayed undefined. This rev verifies file contains the story (via the
 * SAME `### Story X:` heading match the caller uses) before returning,
 * and falls through to per-epic search if not.
 *
 * Lookup order:
 *   1. Consolidated epics.md (existing findEpicsFile path) — return ONLY
 *      if file content contains a `### Story <storyKey>:` heading.
 *   2. Per-epic file `epic-<epicNum>-*.md` derived from storyKey's first
 *      numeric segment (e.g. storyKey '60-12' → epicNum '60' →
 *      `epic-60-*.md`). Per-epic files contain the entire epic so a
 *      filename match is sufficient (no content verification needed —
 *      mirrors readEpicShardFromFile in create-story.ts).
 *
 * Returns the matched path, or undefined if no file contains the story.
 */
export function findEpicFileForStory(
  projectRoot: string,
  storyKey: string,
): string | undefined {
  // Consolidated path: only return if the file actually contains the
  // requested story. The check uses the same separator-tolerant heading
  // match as create-story's extractStorySection (Story 60-6's regex)
  // so consolidated and per-epic paths agree on what counts as "contains".
  const consolidated = findEpicsFile(projectRoot)
  if (consolidated !== undefined) {
    if (fileContainsStory(consolidated, storyKey)) return consolidated
    // Fall through to per-epic search — consolidated file exists but
    // doesn't have this story (likely a stale planning artifact for a
    // different epic family).
  }

  // Per-epic fallback: derive epicNum from storyKey's first numeric segment.
  // storyKey shapes seen in production: '60-12', '1.10c', '52-7', '1-9'.
  const epicNumMatch = /^(\d+)/.exec(storyKey)
  if (!epicNumMatch) return undefined
  const epicNum = epicNumMatch[1]!

  const planningDir = join(projectRoot, '_bmad-output', 'planning-artifacts')
  if (!existsSync(planningDir)) return undefined

  try {
    const entries = readdirSync(planningDir, { encoding: 'utf-8' })
    const perEpicPattern = new RegExp(`^epic-${epicNum}-.*\\.md$`)
    const matches = entries.filter((e) => perEpicPattern.test(e)).sort()
    if (matches.length > 0) {
      return join(planningDir, matches[0]!)
    }
  } catch {
    // fall through
  }
  return undefined
}

/**
 * Story 61-3 v2: check whether a file's content contains a story heading
 * matching the storyKey, with the same separator tolerance as
 * `extractStorySection` (Story 60-6) so both call sites agree.
 *
 * Cheap to call (one synchronous read, one regex test); gracefully
 * returns false on any I/O error.
 */
function fileContainsStory(filePath: string, storyKey: string): boolean {
  try {
    const content = readFileSync(filePath, 'utf-8')
    // Separator-tolerant: split on [-._ ] and rejoin with same class so
    // `1-10c` matches `### Story 1.10c:`. Mirrors create-story.ts:376-401
    // (Story 58-5 / 60-6).
    const parts = storyKey.split(/[-._ ]/)
    const normalized = parts
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('[-._ ]')
    const headingPattern = new RegExp(`^###\\s+Story\\s+${normalized}[:\\s]`, 'm')
    return headingPattern.test(content)
  } catch {
    return false
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

  // Match filenames like N-Ma-slug.md  (e.g. 7-2-human-turn-loop.md, 1-1a-turborepo.md)
  const filePattern = /^([A-Za-z0-9]+-[A-Za-z0-9]+)-/

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
 * Parse story keys from sprint-status.yaml.
 * Reads the development_status map and extracts keys that match the
 * alphanumeric story key pattern (e.g., 1-1a, NEW-26, E5-accessibility).
 * Filters out epic status entries (epic-N) and retrospective entries.
 */
function parseStoryKeysFromSprintStatus(projectRoot: string): string[] {
  const candidates = [
    join(projectRoot, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
    join(projectRoot, '_bmad-output', 'sprint-status.yaml'),
  ]
  const statusPath = candidates.find((p) => existsSync(p))
  if (!statusPath) return []

  try {
    const content = readFileSync(statusPath, 'utf-8')
    const keys: string[] = []
    // Match YAML keys that look like story identifiers (alphanumeric-alphanumeric-optional-slug)
    // but filter out epic-N, retrospective, and metadata entries
    const linePattern = /^\s{2}([A-Za-z0-9]+-[A-Za-z0-9]+(?:-[A-Za-z0-9-]*)?)\s*:/gm
    let match: RegExpExecArray | null
    while ((match = linePattern.exec(content)) !== null) {
      const fullKey = match[1]!
      // Skip epic status entries and retrospectives
      if (/^epic-\d+$/.test(fullKey)) continue
      if (fullKey.includes('retrospective')) continue
      // Extract the short story key (first two segments): "1-1a-turborepo-..." → "1-1a"
      const segments = fullKey.split('-')
      if (segments.length >= 2) {
        keys.push(`${segments[0]}-${segments[1]}`)
      }
    }
    return [...new Set(keys)]
  } catch {
    return []
  }
}

/**
 * Collect story keys already completed in previous pipeline runs.
 * Scans pipeline_runs with status='completed' and extracts story keys
 * with phase='COMPLETE' from their token_usage_json state.
 */
async function getCompletedStoryKeys(db: DatabaseAdapter): Promise<Set<string>> {
  const completed = new Set<string>()
  try {
    const rows = await db.query<{ token_usage_json: string }>(
      `SELECT token_usage_json FROM pipeline_runs WHERE status = 'completed' AND token_usage_json IS NOT NULL`,
    )

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
 * Sort story keys: numeric keys first (by epic then story number),
 * then alphabetic-prefix keys (NEW-*, E-*) sorted lexicographically.
 * E.g. ["10-1", "1-2a", "1-2", "NEW-26", "E5-acc"] → ["1-2", "1-2a", "10-1", "E5-acc", "NEW-26"]
 */
function sortStoryKeys(keys: string[]): string[] {
  return keys.slice().sort((a, b) => {
    const aParts = a.split('-')
    const bParts = b.split('-')
    const aNum = Number(aParts[0])
    const bNum = Number(bParts[0])
    // Both numeric prefix: sort by epic number then story segment
    if (!isNaN(aNum) && !isNaN(bNum)) {
      if (aNum !== bNum) return aNum - bNum
      // Compare second segment: try numeric, fall back to string
      const aStory = Number(aParts[1])
      const bStory = Number(bParts[1])
      if (!isNaN(aStory) && !isNaN(bStory) && aStory !== bStory) return aStory - bStory
      return (aParts[1] ?? '').localeCompare(bParts[1] ?? '')
    }
    // Non-numeric prefixes sort after numeric
    if (!isNaN(aNum)) return -1
    if (!isNaN(bNum)) return 1
    // Both non-numeric: lexicographic
    return a.localeCompare(b)
  })
}

/**
 * Parse inter-story dependencies from the consolidated epics document.
 *
 * Scans for patterns like:
 *   ### Story 50-2: Title
 *   **Dependencies:** 50-1
 *
 * Returns a Map where key=storyKey, value=Set of dependency keys.
 * Only returns dependencies that are within the provided storyKeys set
 * (external dependencies to other epics are ignored for ordering purposes).
 */
export function parseEpicsDependencies(
  projectRoot: string,
  storyKeys: Set<string>,
): Map<string, Set<string>> {
  const deps = new Map<string, Set<string>>()

  const epicsPath = findEpicsFile(projectRoot)
  if (epicsPath === undefined) return deps

  let content: string
  try {
    content = readFileSync(epicsPath, 'utf-8')
  } catch {
    return deps
  }

  // Match story heading followed by dependencies line
  // ### Story N-M: Title
  // ... (any lines)
  // **Dependencies:** X-Y, X-Z
  const storyPattern = /^###\s+Story\s+(\d+)-(\d+)[:\s]/gm
  const depPattern = /^\*\*Dependencies:\*\*\s*(.+)$/gm

  // Build a list of (storyKey, lineIndex) pairs
  const storyPositions: { key: string; pos: number }[] = []
  let match: RegExpExecArray | null
  while ((match = storyPattern.exec(content)) !== null) {
    storyPositions.push({ key: `${match[1]}-${match[2]}`, pos: match.index })
  }

  // For each story, find the next **Dependencies:** line before the next story heading
  for (let i = 0; i < storyPositions.length; i++) {
    const story = storyPositions[i]
    const nextStoryPos = i + 1 < storyPositions.length
      ? storyPositions[i + 1].pos
      : content.length
    const section = content.slice(story.pos, nextStoryPos)

    depPattern.lastIndex = 0
    const depMatch = depPattern.exec(section)
    if (depMatch === null || /^none$/i.test(depMatch[1].trim())) continue

    const depText = depMatch[1]
    const storyDeps = new Set<string>()

    // Handle "50-1 through 50-9" range syntax
    const rangeMatch = /(\d+)-(\d+)\s+through\s+\1-(\d+)/i.exec(depText)
    if (rangeMatch !== null) {
      const epic = rangeMatch[1]
      const start = Number(rangeMatch[2])
      const end = Number(rangeMatch[3])
      for (let n = start; n <= end; n++) {
        const depKey = `${epic}-${n}`
        if (storyKeys.has(depKey)) storyDeps.add(depKey)
      }
    } else {
      // Handle comma-separated: "50-1, 50-4, 50-5"
      const keyPattern = /(\d+-\d+[a-z]?)/g
      let km: RegExpExecArray | null
      while ((km = keyPattern.exec(depText)) !== null) {
        const depKey = km[1]
        if (storyKeys.has(depKey)) storyDeps.add(depKey)
      }
    }

    if (storyDeps.size > 0) {
      deps.set(story.key, storyDeps)
    }
  }

  return deps
}

/**
 * Topologically sort explicit story keys by inter-story dependencies.
 *
 * Parses the consolidated epics document for dependency metadata, builds
 * a DAG, and returns keys in dependency-first order using Kahn's algorithm.
 * Stories with no dependencies come first; stories that depend on others
 * are placed after their prerequisites.
 *
 * Falls back to numeric sort if no epics document exists or no
 * dependencies are found among the provided keys.
 */
export function topologicalSortByDependencies(
  keys: string[],
  projectRoot: string,
): string[] {
  if (keys.length <= 1) return keys

  const keySet = new Set(keys)
  const deps = parseEpicsDependencies(projectRoot, keySet)

  // No dependencies found — fall back to numeric sort
  if (deps.size === 0) return sortStoryKeys(keys)

  // Kahn's algorithm: topological sort producing waves
  const inDegree = new Map<string, number>()
  const successors = new Map<string, Set<string>>()

  for (const key of keys) {
    inDegree.set(key, 0)
    successors.set(key, new Set())
  }

  // Build edges: dependency → dependent
  for (const [dependent, depSet] of deps) {
    if (!keySet.has(dependent)) continue
    for (const dep of depSet) {
      if (!keySet.has(dep)) continue
      successors.get(dep)!.add(dependent)
      inDegree.set(dependent, (inDegree.get(dependent) ?? 0) + 1)
    }
  }

  const result: string[] = []
  const processed = new Set<string>()

  while (processed.size < keys.length) {
    // Collect all keys with in-degree 0
    const wave: string[] = []
    for (const key of keys) {
      if (!processed.has(key) && (inDegree.get(key) ?? 0) === 0) {
        wave.push(key)
      }
    }

    if (wave.length === 0) {
      // Cycle detected — add remaining keys in numeric order
      for (const key of sortStoryKeys(keys)) {
        if (!processed.has(key)) result.push(key)
      }
      break
    }

    // Sort wave numerically for deterministic ordering within a tier
    for (const key of sortStoryKeys(wave)) {
      result.push(key)
      processed.add(key)
      for (const succ of successors.get(key) ?? []) {
        inDegree.set(succ, (inDegree.get(succ) ?? 0) - 1)
      }
    }
  }

  return result
}
