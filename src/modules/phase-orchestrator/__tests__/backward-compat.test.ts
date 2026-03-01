/**
 * Backward compatibility tests for Story 16.2 (Multi-Step Phase Decomposition) — AC7.
 *
 * Verifies that deploying multi-step decomposition does NOT break:
 *  1. The existing database schema (decisions, artifacts tables — columns unchanged)
 *  2. Decisions written by old single-dispatch runs are still readable by the
 *     new multi-step query functions (getDecisionsByPhaseForRun, getArtifactByTypeForRun)
 *  3. substrate auto status JSON output schema fields are unchanged (no regressions)
 *
 * These tests intentionally DO NOT invoke the multi-step path — they simulate
 * the legacy single-dispatch write pattern and verify the new code can read it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../persistence/migrations/index.js'
import {
  createPipelineRun,
  createDecision,
  registerArtifact,
  getDecisionsByPhaseForRun,
  getArtifactByTypeForRun,
  getArtifactsByRun,
  getPipelineRunById,
  updatePipelineRun,
} from '../../../persistence/queries/decisions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'compat-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

/**
 * Simulate the OLD single-dispatch analysis write pattern.
 * Writes exactly the 5 BRIEF_FIELDS as individual decisions, then
 * registers a product-brief artifact — replicating what analysis.ts
 * did before multi-step decomposition was introduced.
 */
function writeSingleDispatchAnalysis(db: BetterSqlite3Database, runId: string) {
  const phase = 'analysis'

  createDecision(db, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'problem_statement',
    value: 'Users struggle with fragmented task management across distributed teams.',
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'target_users',
    value: JSON.stringify(['project managers', 'software developers']),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'core_features',
    value: JSON.stringify(['task board', 'assignment', 'progress tracking']),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'success_metrics',
    value: JSON.stringify(['50% reduction in missed deadlines']),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'constraints',
    value: JSON.stringify(['web-only', 'GDPR compliant']),
  })

  registerArtifact(db, {
    pipeline_run_id: runId,
    phase,
    type: 'product-brief',
    path: 'decision-store://analysis/product-brief',
    summary: 'Users struggle with fragmented task management',
  })
}

/**
 * Simulate the OLD single-dispatch architecture write pattern.
 * Writes architecture decisions with key+value (not indexed like the new multi-step path).
 */
function writeSingleDispatchArchitecture(db: BetterSqlite3Database, runId: string) {
  const archDecisions = [
    { key: 'language', value: 'TypeScript', category: 'backend', rationale: 'Type safety' },
    { key: 'database', value: 'SQLite', category: 'backend', rationale: 'Embedded, fast' },
    { key: 'api', value: 'REST', category: 'backend', rationale: 'Standard protocol' },
  ]

  for (const d of archDecisions) {
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: d.key,
      value: d.value,
      rationale: d.rationale,
    })
  }

  registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    type: 'architecture',
    path: 'decision-store://solutioning/architecture',
    summary: '3 architecture decisions',
  })
}

/**
 * Simulate the OLD single-dispatch story write pattern.
 */
function writeSingleDispatchStories(db: BetterSqlite3Database, runId: string) {
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    category: 'epics',
    key: 'epic-1',
    value: JSON.stringify({ title: 'Task Management', description: 'Core task features' }),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    category: 'stories',
    key: '1-1',
    value: JSON.stringify({
      key: '1-1',
      title: 'Create tasks',
      description: 'Users can create new tasks in the board',
      ac: ['User can create a task with title', 'Task appears on the board view'],
      priority: 'must',
    }),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    category: 'stories',
    key: '1-2',
    value: JSON.stringify({
      key: '1-2',
      title: 'View task board',
      description: 'Users can view all tasks on a board',
      ac: ['Board shows all tasks grouped by status'],
      priority: 'must',
    }),
  })

  registerArtifact(db, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    type: 'stories',
    path: 'decision-store://solutioning/stories',
    summary: '1 epics, 2 stories',
  })
}

// ---------------------------------------------------------------------------
// AC7.1 — Database schema columns are unchanged
// ---------------------------------------------------------------------------

describe('AC7: Database schema backward compatibility', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('decisions table has all expected columns', () => {
    const columns = db.prepare('PRAGMA table_info(decisions)').all() as { name: string }[]
    const names = columns.map((c) => c.name)

    expect(names).toContain('id')
    expect(names).toContain('pipeline_run_id')
    expect(names).toContain('phase')
    expect(names).toContain('category')
    expect(names).toContain('key')
    expect(names).toContain('value')
    expect(names).toContain('rationale')
    expect(names).toContain('created_at')
    expect(names).toContain('updated_at')
  })

  it('artifacts table has all expected columns', () => {
    const columns = db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]
    const names = columns.map((c) => c.name)

    expect(names).toContain('id')
    expect(names).toContain('pipeline_run_id')
    expect(names).toContain('phase')
    expect(names).toContain('type')
    expect(names).toContain('path')
    expect(names).toContain('content_hash')
    expect(names).toContain('summary')
    expect(names).toContain('created_at')
  })

  it('pipeline_runs table has all expected columns', () => {
    const columns = db.prepare('PRAGMA table_info(pipeline_runs)').all() as { name: string }[]
    const names = columns.map((c) => c.name)

    expect(names).toContain('id')
    expect(names).toContain('methodology')
    expect(names).toContain('current_phase')
    expect(names).toContain('status')
    expect(names).toContain('config_json')
    expect(names).toContain('token_usage_json')
    expect(names).toContain('created_at')
    expect(names).toContain('updated_at')
  })

  it('decisions table has required indexes', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'")
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)

    expect(names).toContain('idx_decisions_phase')
    expect(names).toContain('idx_decisions_key')
  })

  it('artifacts table has required index', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifacts'")
      .all() as { name: string }[]
    const names = indexes.map((i) => i.name)

    expect(names).toContain('idx_artifacts_phase')
  })

  it('schema migration is idempotent (safe to run multiple times)', () => {
    expect(() => runMigrations(db)).not.toThrow()
    expect(() => runMigrations(db)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC7.2 — Single-dispatch decisions are readable by new multi-step query functions
// ---------------------------------------------------------------------------

describe('AC7: Single-dispatch decisions readable by multi-step query functions', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
    const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
    runId = run.id

    // Write using the OLD single-dispatch patterns
    writeSingleDispatchAnalysis(db, runId)
    writeSingleDispatchArchitecture(db, runId)
    writeSingleDispatchStories(db, runId)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getDecisionsByPhaseForRun reads all single-dispatch analysis decisions', () => {
    const decisions = getDecisionsByPhaseForRun(db, runId, 'analysis')

    // Should have 5 product-brief fields written by single-dispatch analysis
    expect(decisions).toHaveLength(5)
    const keys = decisions.map((d) => d.key)
    expect(keys).toContain('problem_statement')
    expect(keys).toContain('target_users')
    expect(keys).toContain('core_features')
    expect(keys).toContain('success_metrics')
    expect(keys).toContain('constraints')
  })

  it('getDecisionsByPhaseForRun reads all single-dispatch architecture decisions', () => {
    const decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
    const archDecisions = decisions.filter((d) => d.category === 'architecture')

    expect(archDecisions).toHaveLength(3)
    const keys = archDecisions.map((d) => d.key)
    expect(keys).toContain('language')
    expect(keys).toContain('database')
    expect(keys).toContain('api')
  })

  it('getDecisionsByPhaseForRun reads single-dispatch story decisions', () => {
    const decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
    const storyDecisions = decisions.filter((d) => d.category === 'stories')

    expect(storyDecisions).toHaveLength(2)
    expect(storyDecisions.map((d) => d.key)).toContain('1-1')
    expect(storyDecisions.map((d) => d.key)).toContain('1-2')
  })

  it('getArtifactByTypeForRun retrieves product-brief artifact from single-dispatch run', () => {
    const artifact = getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')

    expect(artifact).toBeDefined()
    expect(artifact!.type).toBe('product-brief')
    expect(artifact!.phase).toBe('analysis')
    expect(artifact!.pipeline_run_id).toBe(runId)
    expect(artifact!.path).toBe('decision-store://analysis/product-brief')
  })

  it('getArtifactByTypeForRun retrieves architecture artifact from single-dispatch run', () => {
    const artifact = getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')

    expect(artifact).toBeDefined()
    expect(artifact!.type).toBe('architecture')
    expect(artifact!.phase).toBe('solutioning')
    expect(artifact!.pipeline_run_id).toBe(runId)
  })

  it('getArtifactsByRun returns all single-dispatch artifacts for the run', () => {
    const artifacts = getArtifactsByRun(db, runId)

    // 3 artifacts: product-brief, architecture, stories
    expect(artifacts).toHaveLength(3)
    const types = artifacts.map((a) => a.type)
    expect(types).toContain('product-brief')
    expect(types).toContain('architecture')
    expect(types).toContain('stories')
  })

  it('decisions are scoped to runId — other runs do not interfere', () => {
    // Create a second run with different decisions
    const run2 = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
    createDecision(db, {
      pipeline_run_id: run2.id,
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Completely different problem for run 2',
    })

    // Original run's decisions should be unchanged
    const run1Decisions = getDecisionsByPhaseForRun(db, runId, 'analysis')
    expect(run1Decisions).toHaveLength(5)

    const run1ProblemStatement = run1Decisions.find((d) => d.key === 'problem_statement')
    expect(run1ProblemStatement!.value).toContain('fragmented task management')

    // Run 2 should only have its own decision
    const run2Decisions = getDecisionsByPhaseForRun(db, run2.id, 'analysis')
    expect(run2Decisions).toHaveLength(1)
    expect(run2Decisions[0]!.value).toContain('Completely different problem')
  })

  it('single-dispatch decision values are valid JSON where expected', () => {
    const decisions = getDecisionsByPhaseForRun(db, runId, 'analysis')

    const targetUsersDecision = decisions.find((d) => d.key === 'target_users')
    expect(targetUsersDecision).toBeDefined()

    // Value should be parseable as JSON array
    const parsed = JSON.parse(targetUsersDecision!.value)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toContain('project managers')
  })

  it('pipeline run status transitions work correctly on single-dispatch runs', () => {
    // Simulate completing a legacy run
    updatePipelineRun(db, runId, { status: 'completed', current_phase: 'implementation' })

    const run = getPipelineRunById(db, runId)
    expect(run).toBeDefined()
    expect(run!.status).toBe('completed')
    expect(run!.current_phase).toBe('implementation')
  })
})

// ---------------------------------------------------------------------------
// AC7.3 — auto status JSON output schema fields are unchanged
// ---------------------------------------------------------------------------

describe('AC7: auto status output schema unchanged', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildPipelineStatusOutput produces all required schema fields', async () => {
    // Import the function that produces the JSON status used by agents
    const { buildPipelineStatusOutput } = await import('../../../cli/commands/auto.js')

    const run = createPipelineRun(db, {
      methodology: 'bmad',
      start_phase: 'analysis',
      config_json: JSON.stringify({
        concept: 'Test concept',
        phaseHistory: [
          {
            phase: 'analysis',
            startedAt: '2026-01-01T00:00:00Z',
            completedAt: '2026-01-01T00:01:00Z',
            gateResults: [],
          },
        ],
      }),
    })

    const result = buildPipelineStatusOutput(run, [], 5, 2)

    // Verify all fields that agents depend on are present
    // Note: top-level 'status' is NOT a field — use run's status via getPipelineRunById
    expect(result).toHaveProperty('run_id')
    expect(result).toHaveProperty('current_phase')
    expect(result).toHaveProperty('phases')
    expect(result).toHaveProperty('total_tokens')
    expect(result).toHaveProperty('decisions_count')
    expect(result).toHaveProperty('stories_count')

    // Verify phases sub-structure
    expect(result.phases).toHaveProperty('analysis')
    expect(result.phases).toHaveProperty('planning')
    expect(result.phases).toHaveProperty('solutioning')
    expect(result.phases).toHaveProperty('implementation')

    // Verify each phase has status field
    for (const phaseName of ['analysis', 'planning', 'solutioning', 'implementation'] as const) {
      expect(result.phases[phaseName]).toHaveProperty('status')
    }

    // Verify total_tokens fields
    expect(result.total_tokens).toHaveProperty('input')
    expect(result.total_tokens).toHaveProperty('output')
    expect(result.total_tokens).toHaveProperty('cost_usd')

    // Note: db.close() is handled by afterEach — do NOT close here to avoid
    // double-close errors that break subsequent tests in this describe block.
  })

  it('single-dispatch run status reflects correct counts from decisions written before multi-step', () => {
    const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
    writeSingleDispatchAnalysis(db, run.id)
    writeSingleDispatchArchitecture(db, run.id)
    writeSingleDispatchStories(db, run.id)

    // Query counts the same way auto status does
    const allDecisions = db
      .prepare('SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?')
      .get(run.id) as { cnt: number }
    const storyCount = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ? AND category = 'stories'",
      )
      .get(run.id) as { cnt: number }

    // 5 analysis decisions + 3 arch + 1 epic + 2 stories = 11 total
    expect(allDecisions.cnt).toBe(11)
    // 2 stories (1-1, 1-2)
    expect(storyCount.cnt).toBe(2)
  })
})
