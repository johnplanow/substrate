/**
 * Unit tests for detectStartPhase() — auto-detect pipeline phase from DB state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { detectStartPhase } from '../phase-detection.js'

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
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      pipeline_run_id TEXT,
      phase TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      summary TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE pipeline_runs (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      token_usage_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `)
  return adapter
}

function insertArtifact(
  adapter: WasmSqliteDatabaseAdapter,
  phase: string,
  type: string,
): void {
  adapter.querySync(
    `INSERT INTO artifacts (id, phase, type, path, summary)
     VALUES (?, ?, ?, ?, ?)`,
    [crypto.randomUUID(), phase, type, `decision-store://${phase}/${type}`, 'test'],
  )
}

function insertStoryDecision(
  adapter: WasmSqliteDatabaseAdapter,
  key: string,
): void {
  adapter.querySync(
    `INSERT INTO decisions (id, phase, category, key, value)
     VALUES (?, 'solutioning', 'stories', ?, ?)`,
    [crypto.randomUUID(), key, JSON.stringify({ key, title: `Story ${key}` })],
  )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectStartPhase', () => {
  let adapter: WasmSqliteDatabaseAdapter

  beforeEach(async () => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    adapter = await createTestDb()
  })

  it('returns analysis with needsConcept when DB is empty', async () => {
    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
    expect(result.reason).toContain('No pipeline state found')
  })

  it('returns implementation when stories exist in decisions table', async () => {
    insertStoryDecision(adapter, '1-1')
    insertStoryDecision(adapter, '1-2')

    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('implementation')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('2 stories')
  })

  it('returns implementation when stories discoverable from epics.md', async () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      return false
    })
    mockReadFileSync.mockReturnValue('**Story key:** `3-1-feature`\n**Story key:** `3-2-config`')

    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('implementation')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('2 stories')
  })

  it('returns planning when analysis is complete', async () => {
    insertArtifact(adapter, 'analysis', 'product-brief')

    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('planning')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('analysis')
    expect(result.reason).toContain('planning')
  })

  it('returns solutioning when planning is complete', async () => {
    insertArtifact(adapter, 'analysis', 'product-brief')
    insertArtifact(adapter, 'planning', 'prd')

    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('solutioning')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('planning')
    expect(result.reason).toContain('solutioning')
  })

  it('returns implementation when solutioning is complete (with stories)', async () => {
    insertArtifact(adapter, 'analysis', 'product-brief')
    insertArtifact(adapter, 'planning', 'prd')
    insertArtifact(adapter, 'solutioning', 'stories')
    insertStoryDecision(adapter, '1-1')

    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('implementation')
    expect(result.needsConcept).toBe(false)
  })

  it('returns solutioning when all phases done but no stories found', async () => {
    insertArtifact(adapter, 'analysis', 'product-brief')
    insertArtifact(adapter, 'planning', 'prd')
    insertArtifact(adapter, 'solutioning', 'stories')
    // No actual story decisions — solutioning "completed" but produced nothing usable

    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('solutioning')
    expect(result.reason).toContain('re-running solutioning')
  })

  it('returns analysis when research is complete', async () => {
    insertArtifact(adapter, 'research', 'research-findings')

    const result = await detectStartPhase(adapter, '/project')
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
    expect(result.reason).toContain('research')
    expect(result.reason).toContain('analysis')
  })

  it('skips gaps in phase chain (analysis missing but planning present)', async () => {
    // Only planning artifact exists (analysis was skipped or artifact missing)
    // Detection walks forward — analysis has no artifact, so it stops there
    insertArtifact(adapter, 'planning', 'prd')

    const result = await detectStartPhase(adapter, '/project')
    // Should detect analysis is missing (no product-brief artifact)
    // and recommend starting from analysis
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
  })

  it('handles DB without artifacts table gracefully', async () => {
    const brokenAdapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
    // Only create decisions table (no artifacts)
    brokenAdapter.execSync(`
      CREATE TABLE decisions (
        id TEXT PRIMARY KEY, pipeline_run_id TEXT, phase TEXT, category TEXT,
        key TEXT, value TEXT, rationale TEXT, superseded_by TEXT,
        created_at TEXT, updated_at TEXT
      );
      CREATE TABLE pipeline_runs (
        id TEXT PRIMARY KEY, status TEXT, token_usage_json TEXT,
        created_at TEXT, updated_at TEXT
      );
    `)

    const result = await detectStartPhase(brokenAdapter, '/project')
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
    await brokenAdapter.close()
  })
})
