/**
 * Unit tests for detectStartPhase() — auto-detect pipeline phase from DB state.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
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

    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      pipeline_run_id TEXT,
      phase TEXT NOT NULL,
      type TEXT NOT NULL,
      path TEXT NOT NULL,
      content_hash TEXT,
      summary TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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

function insertArtifact(
  db: InstanceType<typeof Database>,
  phase: string,
  type: string,
): void {
  db.prepare(
    `INSERT INTO artifacts (id, phase, type, path, summary)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), phase, type, `decision-store://${phase}/${type}`, 'test')
}

function insertStoryDecision(
  db: InstanceType<typeof Database>,
  key: string,
): void {
  db.prepare(
    `INSERT INTO decisions (id, phase, category, key, value)
     VALUES (?, 'solutioning', 'stories', ?, ?)`,
  ).run(crypto.randomUUID(), key, JSON.stringify({ key, title: `Story ${key}` }))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectStartPhase', () => {
  let db: InstanceType<typeof Database>

  beforeEach(() => {
    vi.clearAllMocks()
    mockExistsSync.mockReturnValue(false)
    db = createTestDb()
  })

  it('returns analysis with needsConcept when DB is empty', () => {
    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
    expect(result.reason).toContain('No pipeline state found')
  })

  it('returns implementation when stories exist in decisions table', () => {
    insertStoryDecision(db, '1-1')
    insertStoryDecision(db, '1-2')

    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('implementation')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('2 stories')
  })

  it('returns implementation when stories discoverable from epics.md', () => {
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('epics.md')) return true
      return false
    })
    mockReadFileSync.mockReturnValue('**Story key:** `3-1-feature`\n**Story key:** `3-2-config`')

    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('implementation')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('2 stories')
  })

  it('returns planning when analysis is complete', () => {
    insertArtifact(db, 'analysis', 'product-brief')

    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('planning')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('analysis')
    expect(result.reason).toContain('planning')
  })

  it('returns solutioning when planning is complete', () => {
    insertArtifact(db, 'analysis', 'product-brief')
    insertArtifact(db, 'planning', 'prd')

    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('solutioning')
    expect(result.needsConcept).toBe(false)
    expect(result.reason).toContain('planning')
    expect(result.reason).toContain('solutioning')
  })

  it('returns implementation when solutioning is complete (with stories)', () => {
    insertArtifact(db, 'analysis', 'product-brief')
    insertArtifact(db, 'planning', 'prd')
    insertArtifact(db, 'solutioning', 'stories')
    insertStoryDecision(db, '1-1')

    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('implementation')
    expect(result.needsConcept).toBe(false)
  })

  it('returns solutioning when all phases done but no stories found', () => {
    insertArtifact(db, 'analysis', 'product-brief')
    insertArtifact(db, 'planning', 'prd')
    insertArtifact(db, 'solutioning', 'stories')
    // No actual story decisions — solutioning "completed" but produced nothing usable

    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('solutioning')
    expect(result.reason).toContain('re-running solutioning')
  })

  it('returns analysis when research is complete', () => {
    insertArtifact(db, 'research', 'research-findings')

    const result = detectStartPhase(db, '/project')
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
    expect(result.reason).toContain('research')
    expect(result.reason).toContain('analysis')
  })

  it('skips gaps in phase chain (analysis missing but planning present)', () => {
    // Only planning artifact exists (analysis was skipped or artifact missing)
    // Detection walks forward — analysis has no artifact, so it stops there
    insertArtifact(db, 'planning', 'prd')

    const result = detectStartPhase(db, '/project')
    // Should detect analysis is missing (no product-brief artifact)
    // and recommend starting from analysis
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
  })

  it('handles DB without artifacts table gracefully', () => {
    const brokenDb = new Database(':memory:')
    // Only create decisions table (no artifacts)
    brokenDb.exec(`
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

    const result = detectStartPhase(brokenDb, '/project')
    expect(result.phase).toBe('analysis')
    expect(result.needsConcept).toBe(true)
    brokenDb.close()
  })
})
