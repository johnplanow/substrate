/**
 * Backward compatibility tests for Story 16.2 (Multi-Step Phase Decomposition) — AC7.
 *
 * Verifies that deploying multi-step decomposition does NOT break:
 *  1. The existing database schema (decisions, artifacts tables — columns unchanged)
 *  2. Decisions written by old single-dispatch runs are still readable by the
 *     new multi-step query functions (getDecisionsByPhaseForRun, getArtifactByTypeForRun)
 *  3. substrate status JSON output schema fields are unchanged (no regressions)
 *
 * These tests intentionally DO NOT invoke the multi-step path — they simulate
 * the legacy single-dispatch write pattern and verify the new code can read it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createWasmSqliteAdapter, WasmSqliteDatabaseAdapter } from '../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
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

async function createTestDb(): Promise<{ adapter: WasmSqliteDatabaseAdapter; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'compat-test-'))
  const adapter = await createWasmSqliteAdapter() as WasmSqliteDatabaseAdapter
  await initSchema(adapter)
  return { adapter, tmpDir }
}

/**
 * Simulate the OLD single-dispatch analysis write pattern.
 * Writes exactly the 5 BRIEF_FIELDS as individual decisions, then
 * registers a product-brief artifact — replicating what analysis.ts
 * did before multi-step decomposition was introduced.
 */
async function writeSingleDispatchAnalysis(adapter: DatabaseAdapter, runId: string) {
  const phase = 'analysis'

  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'problem_statement',
    value: 'Users struggle with fragmented task management across distributed teams.',
  })
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'target_users',
    value: JSON.stringify(['project managers', 'software developers']),
  })
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'core_features',
    value: JSON.stringify(['task board', 'assignment', 'progress tracking']),
  })
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'success_metrics',
    value: JSON.stringify(['50% reduction in missed deadlines']),
  })
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase,
    category: 'product-brief',
    key: 'constraints',
    value: JSON.stringify(['web-only', 'GDPR compliant']),
  })

  await registerArtifact(adapter, {
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
async function writeSingleDispatchArchitecture(adapter: DatabaseAdapter, runId: string) {
  const archDecisions = [
    { key: 'language', value: 'TypeScript', category: 'backend', rationale: 'Type safety' },
    { key: 'database', value: 'SQLite', category: 'backend', rationale: 'Embedded, fast' },
    { key: 'api', value: 'REST', category: 'backend', rationale: 'Standard protocol' },
  ]

  for (const d of archDecisions) {
    await createDecision(adapter, {
      pipeline_run_id: runId,
      phase: 'solutioning',
      category: 'architecture',
      key: d.key,
      value: d.value,
      rationale: d.rationale,
    })
  }

  await registerArtifact(adapter, {
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
async function writeSingleDispatchStories(adapter: DatabaseAdapter, runId: string) {
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'solutioning',
    category: 'epics',
    key: 'epic-1',
    value: JSON.stringify({ title: 'Task Management', description: 'Core task features' }),
  })
  await createDecision(adapter, {
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
  await createDecision(adapter, {
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

  await registerArtifact(adapter, {
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
  let adapter: WasmSqliteDatabaseAdapter
  let tmpDir: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    tmpDir = setup.tmpDir
  })

  afterEach(async () => {
    await adapter.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('decisions table has all expected columns', () => {
    const columns = adapter.querySync<{ name: string }>('PRAGMA table_info(decisions)')
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
    const columns = adapter.querySync<{ name: string }>('PRAGMA table_info(artifacts)')
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
    const columns = adapter.querySync<{ name: string }>('PRAGMA table_info(pipeline_runs)')
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
    const indexes = adapter.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'",
    )
    const names = indexes.map((i) => i.name)

    expect(names).toContain('idx_decisions_phase')
    expect(names).toContain('idx_decisions_key')
  })

  it('artifacts table has required index', () => {
    const indexes = adapter.querySync<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifacts'",
    )
    const names = indexes.map((i) => i.name)

    expect(names).toContain('idx_artifacts_phase')
  })

  it('schema migration is idempotent (safe to run multiple times)', async () => {
    await expect(initSchema(adapter)).resolves.not.toThrow()
    await expect(initSchema(adapter)).resolves.not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC7.2 — Single-dispatch decisions are readable by new multi-step query functions
// ---------------------------------------------------------------------------

describe('AC7: Single-dispatch decisions readable by multi-step query functions', () => {
  let adapter: WasmSqliteDatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
    runId = run.id

    // Write using the OLD single-dispatch patterns
    await writeSingleDispatchAnalysis(adapter, runId)
    await writeSingleDispatchArchitecture(adapter, runId)
    await writeSingleDispatchStories(adapter, runId)
  })

  afterEach(async () => {
    await adapter.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('getDecisionsByPhaseForRun reads all single-dispatch analysis decisions', async () => {
    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')

    // Should have 5 product-brief fields written by single-dispatch analysis
    expect(decisions).toHaveLength(5)
    const keys = decisions.map((d) => d.key)
    expect(keys).toContain('problem_statement')
    expect(keys).toContain('target_users')
    expect(keys).toContain('core_features')
    expect(keys).toContain('success_metrics')
    expect(keys).toContain('constraints')
  })

  it('getDecisionsByPhaseForRun reads all single-dispatch architecture decisions', async () => {
    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const archDecisions = decisions.filter((d) => d.category === 'architecture')

    expect(archDecisions).toHaveLength(3)
    const keys = archDecisions.map((d) => d.key)
    expect(keys).toContain('language')
    expect(keys).toContain('database')
    expect(keys).toContain('api')
  })

  it('getDecisionsByPhaseForRun reads single-dispatch story decisions', async () => {
    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const storyDecisions = decisions.filter((d) => d.category === 'stories')

    expect(storyDecisions).toHaveLength(2)
    expect(storyDecisions.map((d) => d.key)).toContain('1-1')
    expect(storyDecisions.map((d) => d.key)).toContain('1-2')
  })

  it('getArtifactByTypeForRun retrieves product-brief artifact from single-dispatch run', async () => {
    const artifact = await getArtifactByTypeForRun(adapter, runId, 'analysis', 'product-brief')

    expect(artifact).toBeDefined()
    expect(artifact!.type).toBe('product-brief')
    expect(artifact!.phase).toBe('analysis')
    expect(artifact!.pipeline_run_id).toBe(runId)
    expect(artifact!.path).toBe('decision-store://analysis/product-brief')
  })

  it('getArtifactByTypeForRun retrieves architecture artifact from single-dispatch run', async () => {
    const artifact = await getArtifactByTypeForRun(adapter, runId, 'solutioning', 'architecture')

    expect(artifact).toBeDefined()
    expect(artifact!.type).toBe('architecture')
    expect(artifact!.phase).toBe('solutioning')
    expect(artifact!.pipeline_run_id).toBe(runId)
  })

  it('getArtifactsByRun returns all single-dispatch artifacts for the run', async () => {
    const artifacts = await getArtifactsByRun(adapter, runId)

    // 3 artifacts: product-brief, architecture, stories
    expect(artifacts).toHaveLength(3)
    const types = artifacts.map((a) => a.type)
    expect(types).toContain('product-brief')
    expect(types).toContain('architecture')
    expect(types).toContain('stories')
  })

  it('decisions are scoped to runId — other runs do not interfere', async () => {
    // Create a second run with different decisions
    const run2 = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
    await createDecision(adapter, {
      pipeline_run_id: run2.id,
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Completely different problem for run 2',
    })

    // Original run's decisions should be unchanged
    const run1Decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    expect(run1Decisions).toHaveLength(5)

    const run1ProblemStatement = run1Decisions.find((d) => d.key === 'problem_statement')
    expect(run1ProblemStatement!.value).toContain('fragmented task management')

    // Run 2 should only have its own decision
    const run2Decisions = await getDecisionsByPhaseForRun(adapter, run2.id, 'analysis')
    expect(run2Decisions).toHaveLength(1)
    expect(run2Decisions[0]!.value).toContain('Completely different problem')
  })

  it('single-dispatch decision values are valid JSON where expected', async () => {
    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')

    const targetUsersDecision = decisions.find((d) => d.key === 'target_users')
    expect(targetUsersDecision).toBeDefined()

    // Value should be parseable as JSON array
    const parsed = JSON.parse(targetUsersDecision!.value)
    expect(Array.isArray(parsed)).toBe(true)
    expect(parsed).toContain('project managers')
  })

  it('pipeline run status transitions work correctly on single-dispatch runs', async () => {
    // Simulate completing a legacy run
    await updatePipelineRun(adapter, runId, { status: 'completed', current_phase: 'implementation' })

    const run = await getPipelineRunById(adapter, runId)
    expect(run).toBeDefined()
    expect(run!.status).toBe('completed')
    expect(run!.current_phase).toBe('implementation')
  })
})

// ---------------------------------------------------------------------------
// AC7.3 — auto status JSON output schema fields are unchanged
// ---------------------------------------------------------------------------

describe('AC7: auto status output schema unchanged', () => {
  let adapter: WasmSqliteDatabaseAdapter
  let tmpDir: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    tmpDir = setup.tmpDir
  })

  afterEach(async () => {
    await adapter.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildPipelineStatusOutput produces all required schema fields', async () => {
    // Import the function that produces the JSON status used by agents
    const { buildPipelineStatusOutput } = await import('../../../cli/commands/pipeline-shared.js')

    const run = await createPipelineRun(adapter, {
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
  }, 30_000)

  it('single-dispatch run status reflects correct counts from decisions written before multi-step', async () => {
    const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
    await writeSingleDispatchAnalysis(adapter, run.id)
    await writeSingleDispatchArchitecture(adapter, run.id)
    await writeSingleDispatchStories(adapter, run.id)

    // Query counts the same way auto status does
    const allDecisionsRows = adapter.querySync<{ cnt: number }>(
      'SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?',
      [run.id],
    )
    const storyCountRows = adapter.querySync<{ cnt: number }>(
      "SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ? AND category = 'stories'",
      [run.id],
    )
    const allDecisions = allDecisionsRows[0]!
    const storyCount = storyCountRows[0]!

    // 5 analysis decisions + 3 arch + 1 epic + 2 stories = 11 total
    expect(allDecisions.cnt).toBe(11)
    // 2 stories (1-1, 1-2)
    expect(storyCount.cnt).toBe(2)
  })
})
