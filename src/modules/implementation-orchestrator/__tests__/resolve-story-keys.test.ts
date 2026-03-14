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
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
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

async function createTestDb(): Promise<WasmSqliteDatabaseAdapter> {
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  adapter.execSync(`
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
  return adapter
}

function insertStoryDecision(
  adapter: WasmSqliteDatabaseAdapter,
  key: string,
  runId?: string,
): void {
  adapter.querySync(
    `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value)
     VALUES (?, ?, 'solutioning', 'stories', ?, ?)`,
    [
      crypto.randomUUID(),
      runId ?? null,
      key,
      JSON.stringify({ key, title: `Story ${key}`, description: 'test' }),
    ],
  )
}

function insertEpicShard(
  adapter: WasmSqliteDatabaseAdapter,
  shardKey: string,
  content: string,
  runId?: string,
): void {
  adapter.querySync(
    `INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value)
     VALUES (?, ?, 'solutioning', 'epic-shard', ?, ?)`,
    [crypto.randomUUID(), runId ?? null, shardKey, content],
  )
}

function insertCompletedRun(
  adapter: WasmSqliteDatabaseAdapter,
  completedStories: string[],
): void {
  const state = {
    stories: Object.fromEntries(
      completedStories.map((k) => [k, { phase: 'COMPLETE' }]),
    ),
  }
  adapter.querySync(
    `INSERT INTO pipeline_runs (id, status, token_usage_json) VALUES (?, 'completed', ?)`,
    [crypto.randomUUID(), JSON.stringify(state)],
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveStoryKeys', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    vi.clearAllMocks()
    // Default: no epics.md on disk (fallback level 4 returns [])
    mockExistsSync.mockReturnValue(false)
    adapter = await createTestDb()
  })

  // -------------------------------------------------------------------------
  // Level 1: Explicit keys
  // -------------------------------------------------------------------------

  describe('Level 1: explicit keys', () => {
    it('returns explicit keys immediately without DB queries', async () => {
      const result = await resolveStoryKeys(adapter, '/project', {
        explicit: ['3-1', '3-2'],
      })
      expect(result).toEqual(['3-1', '3-2'])
    })

    it('returns empty explicit array falls through to DB', async () => {
      insertStoryDecision(adapter, '1-1')
      const result = await resolveStoryKeys(adapter, '/project', { explicit: [] })
      expect(result).toEqual(['1-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Level 2: Decisions table (stories)
  // -------------------------------------------------------------------------

  describe('Level 2: decisions table (stories)', () => {
    it('finds story keys from decisions with category=stories', async () => {
      insertStoryDecision(adapter, '1-1')
      insertStoryDecision(adapter, '1-2')
      insertStoryDecision(adapter, '2-1')

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['1-1', '1-2', '2-1'])
    })

    it('extracts N-M prefix from slugged keys like 1-1-capture-baselines', async () => {
      insertStoryDecision(adapter, '1-1-capture-baselines')
      insertStoryDecision(adapter, '2-3-rewrite-synthesis')

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['1-1', '2-3'])
    })

    it('deduplicates keys', async () => {
      insertStoryDecision(adapter, '1-1')
      insertStoryDecision(adapter, '1-1') // duplicate

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['1-1'])
    })

    it('scopes query to pipelineRunId when provided', async () => {
      insertStoryDecision(adapter, '1-1', 'run-a')
      insertStoryDecision(adapter, '2-1', 'run-b')

      const result = await resolveStoryKeys(adapter, '/project', {
        pipelineRunId: 'run-a',
      })
      expect(result).toEqual(['1-1'])
    })

    it('returns sorted keys', async () => {
      insertStoryDecision(adapter, '10-1')
      insertStoryDecision(adapter, '2-1')
      insertStoryDecision(adapter, '1-3')

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['1-3', '2-1', '10-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Level 3: Epic shard decisions
  // -------------------------------------------------------------------------

  describe('Level 3: epic shard decisions', () => {
    it('parses story keys from epic shard markdown content', async () => {
      const epicMarkdown = `
## Epic 1: Foundation
**Story key:** \`1-1-capture-baselines\`
**Story key:** \`1-2-rewrite-synthesis\`
`
      insertEpicShard(adapter, '1', epicMarkdown)

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['1-1', '1-2'])
    })

    it('combines story keys from multiple epic shards', async () => {
      insertEpicShard(adapter, '1', '**Story key:** `1-1-first`')
      insertEpicShard(adapter, '2', '**Story key:** `2-1-second`')

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['1-1', '2-1'])
    })

    it('only uses epic shards when stories decisions are empty', async () => {
      // Level 2 has data — level 3 should not be reached
      insertStoryDecision(adapter, '5-1')
      insertEpicShard(adapter, '1', '**Story key:** `1-1-should-not-appear`')

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['5-1'])
    })

    it('scopes epic shard query to pipelineRunId', async () => {
      insertEpicShard(adapter, '1', '**Story key:** `1-1-first`', 'run-a')
      insertEpicShard(adapter, '2', '**Story key:** `2-1-second`', 'run-b')

      const result = await resolveStoryKeys(adapter, '/project', {
        pipelineRunId: 'run-a',
      })
      expect(result).toEqual(['1-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Level 4: epics.md file on disk
  // -------------------------------------------------------------------------

  describe('Level 4: epics.md file fallback', () => {
    it('falls through to epics.md when DB has no stories or shards', async () => {
      // Mock epics.md existing and having content
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('epics.md')) return true
        return false
      })
      mockReadFileSync.mockReturnValue('**Story key:** `3-1-feature`\n**Story key:** `3-2-config`')

      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual(['3-1', '3-2'])
    })

    it('returns empty array when nothing found at any level', async () => {
      mockExistsSync.mockReturnValue(false)
      const result = await resolveStoryKeys(adapter, '/project')
      expect(result).toEqual([])
    })
  })

  // -------------------------------------------------------------------------
  // filterCompleted
  // -------------------------------------------------------------------------

  describe('filterCompleted', () => {
    it('filters out stories completed in previous pipeline runs', async () => {
      insertStoryDecision(adapter, '1-1')
      insertStoryDecision(adapter, '1-2')
      insertStoryDecision(adapter, '1-3')
      insertCompletedRun(adapter, ['1-1', '1-3'])

      const result = await resolveStoryKeys(adapter, '/project', {
        filterCompleted: true,
      })
      expect(result).toEqual(['1-2'])
    })

    it('does not filter when filterCompleted is false', async () => {
      insertStoryDecision(adapter, '1-1')
      insertCompletedRun(adapter, ['1-1'])

      const result = await resolveStoryKeys(adapter, '/project', {
        filterCompleted: false,
      })
      expect(result).toEqual(['1-1'])
    })
  })

  // -------------------------------------------------------------------------
  // Error resilience
  // -------------------------------------------------------------------------

  describe('error resilience', () => {
    it('handles DB with missing decisions table gracefully', async () => {
      const brokenAdapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
      // No tables created — queries will throw
      mockExistsSync.mockReturnValue(false)

      const result = await resolveStoryKeys(brokenAdapter, '/project')
      expect(result).toEqual([])
      await brokenAdapter.close()
    })

    it('falls through from broken DB to epics.md', async () => {
      const brokenAdapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
      mockExistsSync.mockImplementation((p: string) => {
        if (p.endsWith('epics.md')) return true
        return false
      })
      mockReadFileSync.mockReturnValue('**Story key:** `7-1-fallback`')

      const result = await resolveStoryKeys(brokenAdapter, '/project')
      expect(result).toEqual(['7-1'])
      await brokenAdapter.close()
    })
  })
})
