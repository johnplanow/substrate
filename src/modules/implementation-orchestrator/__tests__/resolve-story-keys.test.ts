/**
 * Unit tests for resolveStoryKeys() — the unified story key resolution function.
 *
 * Tests the 4-level fallback chain:
 *   1. Explicit --stories flag
 *   2. Decisions table (category='stories', phase='solutioning')
 *   3. Epic shard decisions (category='epic-shard')
 *   4. epics.md file on disk
 *
 * Also tests:
 *   - pipelineRunId scoping
 *   - filterCompleted behavior
 *   - DB error resilience
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { resolveStoryKeys } from '../story-discovery.js'

// Mock node:fs for discoverPendingStoryKeys fallback
const mockExistsSync = vi.fn()
const mockReadFileSync = vi.fn()
const mockReaddirSync = vi.fn()

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): InstanceType<typeof Database> {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE decisions (
      id TEXT PRIMARY KEY,
      pipeline_run_id TEXT,
      phase TEXT NOT NULL,
      category TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      rationale TEXT,
      superseded_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      token_usage_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `)
  return db
}

function insertStoryDecision(
  db: InstanceType<typeof Database>,
  key: string,
  runId?: string,
): void {
  db.prepare(
    `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value)
     VALUES (?, ?, 'solutioning', 'stories', ?, ?)`,
  ).run(
    crypto.randomUUID(),
    runId ?? null,
    key,
    JSON.stringify({ key, title: `Story ${key}`, description: 'test' }),
  )
}

function insertEpicShard(
  db: InstanceType<typeof Database>,
  shardKey: string,
  content: string,
  runId?: string,
): void {
  db.prepare(
    `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value)
     VALUES (?, ?, 'solutioning', 'epic-shard', ?, ?)`,
  ).run(crypto.randomUUID(), runId ?? null, shardKey, content)
}

function insertCompletedRun(
  db: InstanceType<typeof Database>,
  completedStories: string[],
): void {
  const state = {
    stories: Object.fromEntries(
      completedStories.map((k) => [k, { phase: 'COMPLETE' }]),
    ),
  }
  db.prepare(
    `INSERT INTO pipeline_runs (id, status, token_usage_json) VALUES (?, 'completed', ?)`,
  ).run(crypto.randomUUID(), JSON.stringify(state))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveStoryKeys', () => {
  let db: InstanceType<typeof Database>

  beforeEach(() => {
    vi.clearAllMocks()
    // Default: no epics.md on disk (fallback level 4 returns [])
    mockExistsSync.mockReturnValue(false)
    db = createTestDb()
  })

  // -------------------------------------------------------------------------
  // Level 1: Explicit keys
  // -------------------------------------------------------------------------

  describe('Level 1: explicit keys', () => {
    it('returns explicit keys immediately without DB queries', () => {
      const result = resolveStoryKeys(db, '/project', {
        explicit: ['3-1', '3-2'],
      })
      expect(result).toEqual(['3-1', '3-2'])
    })

    it('returns empty explicit array falls through to DB', () => {
      insertStoryDecision(db, '1-1')
      const result = resolveStoryKeys(db, '/project', { explicit: [] })
      expect(result).toEqual(['1-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Level 2: Decisions table (stories)
  // -------------------------------------------------------------------------

  describe('Level 2: decisions table (stories)', () => {
    it('finds story keys from decisions with category=stories', () => {
      insertStoryDecision(db, '1-1')
      insertStoryDecision(db, '1-2')
      insertStoryDecision(db, '2-1')

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['1-1', '1-2', '2-1'])
    })

    it('extracts N-M prefix from slugged keys like 1-1-capture-baselines', () => {
      insertStoryDecision(db, '1-1-capture-baselines')
      insertStoryDecision(db, '2-3-rewrite-synthesis')

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['1-1', '2-3'])
    })

    it('deduplicates keys', () => {
      insertStoryDecision(db, '1-1')
      insertStoryDecision(db, '1-1') // duplicate

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['1-1'])
    })

    it('scopes query to pipelineRunId when provided', () => {
      insertStoryDecision(db, '1-1', 'run-a')
      insertStoryDecision(db, '2-1', 'run-b')

      const result = resolveStoryKeys(db, '/project', {
        pipelineRunId: 'run-a',
      })
      expect(result).toEqual(['1-1'])
    })

    it('returns sorted keys', () => {
      insertStoryDecision(db, '10-1')
      insertStoryDecision(db, '2-1')
      insertStoryDecision(db, '1-3')

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['1-3', '2-1', '10-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Level 3: Epic shard decisions
  // -------------------------------------------------------------------------

  describe('Level 3: epic shard decisions', () => {
    it('parses story keys from epic shard markdown content', () => {
      const epicMarkdown = `
## Epic 1: Foundation
**Story key:** \`1-1-capture-baselines\`
**Story key:** \`1-2-rewrite-synthesis\`
`
      insertEpicShard(db, '1', epicMarkdown)

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['1-1', '1-2'])
    })

    it('combines story keys from multiple epic shards', () => {
      insertEpicShard(db, '1', '**Story key:** `1-1-first`')
      insertEpicShard(db, '2', '**Story key:** `2-1-second`')

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['1-1', '2-1'])
    })

    it('only uses epic shards when stories decisions are empty', () => {
      // Level 2 has data — level 3 should not be reached
      insertStoryDecision(db, '5-1')
      insertEpicShard(db, '1', '**Story key:** `1-1-should-not-appear`')

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['5-1'])
    })

    it('scopes epic shard query to pipelineRunId', () => {
      insertEpicShard(db, '1', '**Story key:** `1-1-first`', 'run-a')
      insertEpicShard(db, '2', '**Story key:** `2-1-second`', 'run-b')

      const result = resolveStoryKeys(db, '/project', {
        pipelineRunId: 'run-a',
      })
      expect(result).toEqual(['1-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Level 4: epics.md file on disk
  // -------------------------------------------------------------------------

  describe('Level 4: epics.md file fallback', () => {
    it('falls through to epics.md when DB has no stories or shards', () => {
      // Mock epics.md existing and having content
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('epics.md')) return true
        return false
      })
      mockReadFileSync.mockReturnValue('**Story key:** `3-1-feature`\n**Story key:** `3-2-config`')

      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual(['3-1', '3-2'])
    })

    it('returns empty array when nothing found at any level', () => {
      mockExistsSync.mockReturnValue(false)
      const result = resolveStoryKeys(db, '/project')
      expect(result).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // filterCompleted
  // -------------------------------------------------------------------------

  describe('filterCompleted', () => {
    it('filters out stories completed in previous pipeline runs', () => {
      insertStoryDecision(db, '1-1')
      insertStoryDecision(db, '1-2')
      insertStoryDecision(db, '1-3')
      insertCompletedRun(db, ['1-1', '1-3'])

      const result = resolveStoryKeys(db, '/project', {
        filterCompleted: true,
      })
      expect(result).toEqual(['1-2'])
    })

    it('does not filter when filterCompleted is false', () => {
      insertStoryDecision(db, '1-1')
      insertCompletedRun(db, ['1-1'])

      const result = resolveStoryKeys(db, '/project', {
        filterCompleted: false,
      })
      expect(result).toEqual(['1-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Error resilience
  // -------------------------------------------------------------------------

  describe('error resilience', () => {
    it('handles DB with missing decisions table gracefully', () => {
      const brokenDb = new Database(':memory:')
      // No tables created — queries will throw
      mockExistsSync.mockReturnValue(false)

      const result = resolveStoryKeys(brokenDb, '/project')
      expect(result).toEqual([])
      brokenDb.close()
    })

    it('falls through from broken DB to epics.md', () => {
      const brokenDb = new Database(':memory:')
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('epics.md')) return true
        return false
      })
      mockReadFileSync.mockReturnValue('**Story key:** `7-1-fallback`')

      const result = resolveStoryKeys(brokenDb, '/project')
      expect(result).toEqual(['7-1'])
      brokenDb.close()
    })
  })
})
