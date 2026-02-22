/**
 * Unit tests for the decision store schema and persistence queries.
 *
 * Covers:
 * - Migration creates all required tables (AC1)
 * - CRUD for decisions table (AC2)
 * - CRUD for requirements table (AC3)
 * - CRUD for constraints table (AC4)
 * - CRUD for artifacts table (AC5)
 * - CRUD for pipeline_runs table (AC6)
 * - Zod schema validation (AC7)
 * - Token usage tracking and aggregation (AC8)
 */

import { describe, it, expect, beforeEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../migrations/index.js'
import {
  createDecision,
  getDecisionsByPhase,
  getDecisionByKey,
  updateDecision,
  createRequirement,
  listRequirements,
  updateRequirementStatus,
  createConstraint,
  listConstraints,
  registerArtifact,
  getArtifactsByPhase,
  getArtifactByType,
  createPipelineRun,
  updatePipelineRun,
  getLatestRun,
  addTokenUsage,
  getTokenUsageSummary,
} from '../queries/decisions.js'
import {
  CreateDecisionInputSchema,
  CreateRequirementInputSchema,
  CreateConstraintInputSchema,
  RegisterArtifactInputSchema,
  CreatePipelineRunInputSchema,
  AddTokenUsageInputSchema,
  PipelineRunStatusEnum,
  PipelineRunSchema,
  DecisionSchema,
} from '../schemas/decisions.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function openTestDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

// ---------------------------------------------------------------------------
// AC1: Migration creates all tables
// ---------------------------------------------------------------------------

describe('AC1: Migration 007 creates all required tables', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  const expectedTables = [
    'decisions',
    'requirements',
    'constraints',
    'artifacts',
    'pipeline_runs',
    'token_usage',
  ]

  for (const tableName of expectedTables) {
    it(`creates table: ${tableName}`, () => {
      const tableInfo = db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as { name: string }[]
      expect(tableInfo.length).toBeGreaterThan(0)
    })
  }

  it('migration is idempotent (safe to run multiple times)', () => {
    // Running migrations again should not throw
    expect(() => runMigrations(db)).not.toThrow()
  })

  it('creates index idx_decisions_phase', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_decisions_phase')
  })

  it('creates index idx_decisions_key', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='decisions'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_decisions_key')
  })

  it('creates index idx_requirements_type', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='requirements'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_requirements_type')
  })

  it('creates index idx_requirements_status', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='requirements'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_requirements_status')
  })

  it('creates index idx_artifacts_phase', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='artifacts'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_artifacts_phase')
  })

  it('creates index idx_pipeline_runs_status', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pipeline_runs'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_pipeline_runs_status')
  })

  it('creates index idx_token_usage_run', () => {
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='token_usage'")
      .all() as { name: string }[]
    const indexNames = indexes.map((i) => i.name)
    expect(indexNames).toContain('idx_token_usage_run')
  })
})

// ---------------------------------------------------------------------------
// AC2: Decisions table CRUD
// ---------------------------------------------------------------------------

describe('AC2: Decisions table CRUD', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('createDecision inserts a row with auto-generated UUID', () => {
    const decision = createDecision(db, {
      phase: 'analysis',
      category: 'tech-stack',
      key: 'database',
      value: 'sqlite',
      rationale: 'Lightweight, embedded',
    })

    expect(decision.id).toBeDefined()
    expect(decision.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(decision.phase).toBe('analysis')
    expect(decision.category).toBe('tech-stack')
    expect(decision.key).toBe('database')
    expect(decision.value).toBe('sqlite')
  })

  it('createDecision stores created_at timestamp', () => {
    const decision = createDecision(db, {
      phase: 'planning',
      category: 'arch',
      key: 'pattern',
      value: 'layered',
    })
    expect(decision.created_at).toBeDefined()
  })

  it('getDecisionsByPhase returns all decisions for a phase', () => {
    createDecision(db, { phase: 'analysis', category: 'a', key: 'k1', value: 'v1' })
    createDecision(db, { phase: 'analysis', category: 'a', key: 'k2', value: 'v2' })
    createDecision(db, { phase: 'planning', category: 'a', key: 'k3', value: 'v3' })

    const results = getDecisionsByPhase(db, 'analysis')
    expect(results).toHaveLength(2)
    expect(results.every((d) => d.phase === 'analysis')).toBe(true)
  })

  it('getDecisionsByPhase returns empty array when no decisions for phase', () => {
    const results = getDecisionsByPhase(db, 'nonexistent-phase')
    expect(results).toHaveLength(0)
  })

  it('getDecisionByKey returns a single decision by phase+key', () => {
    createDecision(db, { phase: 'analysis', category: 'a', key: 'mykey', value: 'myvalue' })
    const result = getDecisionByKey(db, 'analysis', 'mykey')
    expect(result).toBeDefined()
    expect(result?.key).toBe('mykey')
    expect(result?.value).toBe('myvalue')
  })

  it('getDecisionByKey returns undefined for non-existent key', () => {
    const result = getDecisionByKey(db, 'analysis', 'nokey')
    expect(result).toBeUndefined()
  })

  it('updateDecision updates value and sets updated_at', () => {
    const decision = createDecision(db, {
      phase: 'analysis',
      category: 'a',
      key: 'k',
      value: 'old',
    })

    updateDecision(db, decision.id, { value: 'new', rationale: 'changed' })

    const updated = getDecisionByKey(db, 'analysis', 'k')
    expect(updated?.value).toBe('new')
    expect(updated?.rationale).toBe('changed')
  })

  it('updateDecision is a no-op when no updates provided', () => {
    const decision = createDecision(db, {
      phase: 'analysis',
      category: 'a',
      key: 'k',
      value: 'original',
    })
    expect(() => updateDecision(db, decision.id, {})).not.toThrow()
    const retrieved = getDecisionByKey(db, 'analysis', 'k')
    expect(retrieved?.value).toBe('original')
  })

  it('generates unique UUIDs for each decision', () => {
    const d1 = createDecision(db, { phase: 'analysis', category: 'a', key: 'k1', value: 'v1' })
    const d2 = createDecision(db, { phase: 'analysis', category: 'a', key: 'k2', value: 'v2' })
    expect(d1.id).not.toBe(d2.id)
  })
})

// ---------------------------------------------------------------------------
// AC3: Requirements table CRUD
// ---------------------------------------------------------------------------

describe('AC3: Requirements table CRUD', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('createRequirement inserts with status=active', () => {
    const req = createRequirement(db, {
      source: 'user-interview',
      type: 'functional',
      description: 'The system must allow user login',
      priority: 'must',
    })

    expect(req.id).toBeDefined()
    expect(req.status).toBe('active')
    expect(req.type).toBe('functional')
    expect(req.priority).toBe('must')
  })

  it('listRequirements returns all requirements without filter', () => {
    createRequirement(db, {
      source: 'spec',
      type: 'functional',
      description: 'Feature A',
      priority: 'must',
    })
    createRequirement(db, {
      source: 'spec',
      type: 'non_functional',
      description: 'Performance requirement',
      priority: 'should',
    })

    const results = listRequirements(db)
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('listRequirements filters by type', () => {
    createRequirement(db, {
      source: 's',
      type: 'functional',
      description: 'Func req',
      priority: 'must',
    })
    createRequirement(db, {
      source: 's',
      type: 'non_functional',
      description: 'NFR',
      priority: 'should',
    })

    const results = listRequirements(db, { type: 'functional' })
    expect(results).toHaveLength(1)
    expect(results[0].type).toBe('functional')
  })

  it('listRequirements filters by priority', () => {
    createRequirement(db, {
      source: 's',
      type: 'functional',
      description: 'Must req',
      priority: 'must',
    })
    createRequirement(db, {
      source: 's',
      type: 'functional',
      description: 'Should req',
      priority: 'should',
    })

    const results = listRequirements(db, { priority: 'must' })
    expect(results).toHaveLength(1)
    expect(results[0].priority).toBe('must')
  })

  it('listRequirements filters by status', () => {
    const req = createRequirement(db, {
      source: 's',
      type: 'functional',
      description: 'Req',
      priority: 'must',
    })
    updateRequirementStatus(db, req.id, 'done')

    const active = listRequirements(db, { status: 'active' })
    const done = listRequirements(db, { status: 'done' })

    expect(active.every((r) => r.status === 'active')).toBe(true)
    expect(done.every((r) => r.status === 'done')).toBe(true)
  })

  it('updateRequirementStatus transitions status', () => {
    const req = createRequirement(db, {
      source: 's',
      type: 'functional',
      description: 'Req',
      priority: 'must',
    })
    expect(req.status).toBe('active')

    updateRequirementStatus(db, req.id, 'done')

    const updated = listRequirements(db, { status: 'done' })
    expect(updated.some((r) => r.id === req.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC4: Constraints table CRUD
// ---------------------------------------------------------------------------

describe('AC4: Constraints table CRUD', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('createConstraint inserts a new row', () => {
    const constraint = createConstraint(db, {
      category: 'security',
      description: 'All data must be encrypted at rest',
      source: 'compliance-policy',
    })

    expect(constraint.id).toBeDefined()
    expect(constraint.category).toBe('security')
    expect(constraint.description).toBe('All data must be encrypted at rest')
    expect(constraint.source).toBe('compliance-policy')
  })

  it('listConstraints returns all constraints without filter', () => {
    createConstraint(db, { category: 'security', description: 'Encryption', source: 's' })
    createConstraint(db, { category: 'performance', description: 'Latency limit', source: 's' })

    const results = listConstraints(db)
    expect(results.length).toBeGreaterThanOrEqual(2)
  })

  it('listConstraints filters by category', () => {
    createConstraint(db, { category: 'security', description: 'Enc', source: 's' })
    createConstraint(db, { category: 'performance', description: 'Lat', source: 's' })

    const results = listConstraints(db, { category: 'security' })
    expect(results).toHaveLength(1)
    expect(results[0].category).toBe('security')
  })

  it('listConstraints returns empty array when no constraints match filter', () => {
    const results = listConstraints(db, { category: 'nonexistent' })
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC5: Artifacts table CRUD
// ---------------------------------------------------------------------------

describe('AC5: Artifacts table CRUD', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('registerArtifact inserts a new row', () => {
    const artifact = registerArtifact(db, {
      phase: 'analysis',
      type: 'requirements-doc',
      path: '/output/requirements.md',
      content_hash: 'abc123',
      summary: 'Requirements document',
    })

    expect(artifact.id).toBeDefined()
    expect(artifact.phase).toBe('analysis')
    expect(artifact.type).toBe('requirements-doc')
    expect(artifact.path).toBe('/output/requirements.md')
    expect(artifact.content_hash).toBe('abc123')
  })

  it('getArtifactsByPhase returns all artifacts for a phase', () => {
    registerArtifact(db, { phase: 'analysis', type: 'doc1', path: '/a/1' })
    registerArtifact(db, { phase: 'analysis', type: 'doc2', path: '/a/2' })
    registerArtifact(db, { phase: 'planning', type: 'doc3', path: '/p/3' })

    const results = getArtifactsByPhase(db, 'analysis')
    expect(results).toHaveLength(2)
    expect(results.every((a) => a.phase === 'analysis')).toBe(true)
  })

  it('getArtifactsByPhase returns empty array for unknown phase', () => {
    const results = getArtifactsByPhase(db, 'nonexistent')
    expect(results).toHaveLength(0)
  })

  it('getArtifactByType returns the latest artifact of that type', () => {
    // Insert two artifacts of the same type; the second (later) should be returned
    registerArtifact(db, {
      phase: 'analysis',
      type: 'requirements-doc',
      path: '/output/req-v1.md',
    })
    registerArtifact(db, {
      phase: 'analysis',
      type: 'requirements-doc',
      path: '/output/req-v2.md',
    })

    const latest = getArtifactByType(db, 'analysis', 'requirements-doc')
    expect(latest).toBeDefined()
    expect(latest?.path).toBe('/output/req-v2.md')
  })

  it('getArtifactByType returns undefined for non-existent type', () => {
    const result = getArtifactByType(db, 'analysis', 'no-such-type')
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC6: Pipeline runs table CRUD
// ---------------------------------------------------------------------------

describe('AC6: Pipeline runs table CRUD', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('createPipelineRun inserts with status=running', () => {
    const run = createPipelineRun(db, {
      methodology: 'agile',
      start_phase: 'analysis',
    })

    expect(run.id).toBeDefined()
    expect(run.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    )
    expect(run.status).toBe('running')
    expect(run.methodology).toBe('agile')
    expect(run.created_at).toBeDefined()
  })

  it('updatePipelineRun updates phase and status', () => {
    const run = createPipelineRun(db, { methodology: 'agile' })
    updatePipelineRun(db, run.id, { current_phase: 'planning', status: 'paused' })

    const updated = getLatestRun(db)
    expect(updated?.current_phase).toBe('planning')
    expect(updated?.status).toBe('paused')
  })

  it('updatePipelineRun updates token_usage_json', () => {
    const run = createPipelineRun(db, { methodology: 'waterfall' })
    const usageJson = JSON.stringify({ total: 1000 })
    updatePipelineRun(db, run.id, { token_usage_json: usageJson })

    const updated = getLatestRun(db)
    expect(updated?.token_usage_json).toBe(usageJson)
  })

  it('updatePipelineRun is a no-op when no updates provided', () => {
    const run = createPipelineRun(db, { methodology: 'agile' })
    expect(() => updatePipelineRun(db, run.id, {})).not.toThrow()
  })

  it('getLatestRun returns the most recent pipeline run', () => {
    createPipelineRun(db, { methodology: 'agile' })
    const latest = createPipelineRun(db, { methodology: 'kanban' })

    const result = getLatestRun(db)
    expect(result).toBeDefined()
    // The latest run should have been created after the first
    expect(result?.methodology).toBe('kanban')
    expect(result?.id).toBe(latest.id)
  })

  it('getLatestRun returns undefined when no runs exist', () => {
    const result = getLatestRun(db)
    expect(result).toBeUndefined()
  })

  it('pipeline run status transitions (running -> completed)', () => {
    const run = createPipelineRun(db, { methodology: 'agile' })
    updatePipelineRun(db, run.id, { status: 'completed' })

    const updated = getLatestRun(db)
    expect(updated?.status).toBe('completed')
  })

  it('pipeline run status transitions (running -> failed)', () => {
    const run = createPipelineRun(db, { methodology: 'agile' })
    updatePipelineRun(db, run.id, { status: 'failed' })

    const updated = getLatestRun(db)
    expect(updated?.status).toBe('failed')
  })
})

// ---------------------------------------------------------------------------
// AC7: Zod schema validation
// ---------------------------------------------------------------------------

describe('AC7: Zod schemas validate inputs at persistence boundary', () => {
  it('CreateDecisionInputSchema rejects missing required field (phase)', () => {
    expect(() =>
      CreateDecisionInputSchema.parse({
        category: 'a',
        key: 'k',
        value: 'v',
      }),
    ).toThrow()
  })

  it('CreateDecisionInputSchema rejects empty string for key', () => {
    expect(() =>
      CreateDecisionInputSchema.parse({
        phase: 'analysis',
        category: 'a',
        key: '',
        value: 'v',
      }),
    ).toThrow()
  })

  it('CreateRequirementInputSchema rejects invalid type enum', () => {
    expect(() =>
      CreateRequirementInputSchema.parse({
        source: 'spec',
        type: 'invalid-type',
        description: 'desc',
        priority: 'must',
      }),
    ).toThrow()
  })

  it('CreateRequirementInputSchema rejects invalid priority enum', () => {
    expect(() =>
      CreateRequirementInputSchema.parse({
        source: 'spec',
        type: 'functional',
        description: 'desc',
        priority: 'critical', // not a valid value
      }),
    ).toThrow()
  })

  it('CreateConstraintInputSchema rejects missing source field', () => {
    expect(() =>
      CreateConstraintInputSchema.parse({
        category: 'security',
        description: 'must encrypt',
      }),
    ).toThrow()
  })

  it('RegisterArtifactInputSchema rejects missing path field', () => {
    expect(() =>
      RegisterArtifactInputSchema.parse({
        phase: 'analysis',
        type: 'doc',
      }),
    ).toThrow()
  })

  it('CreatePipelineRunInputSchema rejects missing methodology field', () => {
    expect(() => CreatePipelineRunInputSchema.parse({})).toThrow()
  })

  it('AddTokenUsageInputSchema rejects negative input_tokens', () => {
    expect(() =>
      AddTokenUsageInputSchema.parse({
        phase: 'analysis',
        agent: 'claude',
        input_tokens: -1,
        output_tokens: 0,
        cost_usd: 0,
      }),
    ).toThrow()
  })

  it('CreateDecisionInputSchema accepts valid input', () => {
    const result = CreateDecisionInputSchema.parse({
      phase: 'analysis',
      category: 'tech',
      key: 'db',
      value: 'sqlite',
    })
    expect(result.phase).toBe('analysis')
  })
})

// ---------------------------------------------------------------------------
// AC8: Token usage tracking and aggregation
// ---------------------------------------------------------------------------

describe('AC8: Token usage tracking', () => {
  let db: BetterSqlite3Database
  let runId: string

  beforeEach(() => {
    db = openTestDb()
    const run = createPipelineRun(db, { methodology: 'agile' })
    runId = run.id
  })

  it('addTokenUsage inserts a usage record', () => {
    expect(() =>
      addTokenUsage(db, runId, {
        phase: 'analysis',
        agent: 'claude',
        input_tokens: 100,
        output_tokens: 200,
        cost_usd: 0.05,
      }),
    ).not.toThrow()
  })

  it('getTokenUsageSummary returns aggregated totals by phase and agent', () => {
    addTokenUsage(db, runId, {
      phase: 'analysis',
      agent: 'claude',
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.05,
    })
    addTokenUsage(db, runId, {
      phase: 'analysis',
      agent: 'claude',
      input_tokens: 50,
      output_tokens: 100,
      cost_usd: 0.02,
    })
    addTokenUsage(db, runId, {
      phase: 'planning',
      agent: 'claude',
      input_tokens: 300,
      output_tokens: 400,
      cost_usd: 0.10,
    })

    const summary = getTokenUsageSummary(db, runId)
    expect(summary).toHaveLength(2)

    const analysisSummary = summary.find((s) => s.phase === 'analysis')
    expect(analysisSummary).toBeDefined()
    expect(analysisSummary?.total_input_tokens).toBe(150)
    expect(analysisSummary?.total_output_tokens).toBe(300)
    expect(analysisSummary?.total_cost_usd).toBeCloseTo(0.07, 5)

    const planningSummary = summary.find((s) => s.phase === 'planning')
    expect(planningSummary).toBeDefined()
    expect(planningSummary?.total_input_tokens).toBe(300)
    expect(planningSummary?.total_output_tokens).toBe(400)
  })

  it('getTokenUsageSummary returns empty array when no usage records exist', () => {
    const summary = getTokenUsageSummary(db, runId)
    expect(summary).toHaveLength(0)
  })

  it('getTokenUsageSummary aggregates by agent within phase', () => {
    addTokenUsage(db, runId, {
      phase: 'analysis',
      agent: 'claude',
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.05,
    })
    addTokenUsage(db, runId, {
      phase: 'analysis',
      agent: 'gpt-4',
      input_tokens: 50,
      output_tokens: 75,
      cost_usd: 0.03,
    })

    const summary = getTokenUsageSummary(db, runId)
    expect(summary).toHaveLength(2)

    const claudeSummary = summary.find(
      (s) => s.phase === 'analysis' && s.agent === 'claude',
    )
    const gptSummary = summary.find(
      (s) => s.phase === 'analysis' && s.agent === 'gpt-4',
    )

    expect(claudeSummary?.total_input_tokens).toBe(100)
    expect(gptSummary?.total_input_tokens).toBe(50)
  })

  it('getTokenUsageSummary only includes records for the given runId', () => {
    const run2 = createPipelineRun(db, { methodology: 'kanban' })
    addTokenUsage(db, runId, {
      phase: 'analysis',
      agent: 'claude',
      input_tokens: 100,
      output_tokens: 200,
      cost_usd: 0.05,
    })
    addTokenUsage(db, run2.id, {
      phase: 'analysis',
      agent: 'claude',
      input_tokens: 999,
      output_tokens: 999,
      cost_usd: 9.99,
    })

    const summary = getTokenUsageSummary(db, runId)
    expect(summary).toHaveLength(1)
    expect(summary[0].total_input_tokens).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Story 12-6: Schema type updates for amendment pipeline
// ---------------------------------------------------------------------------

describe('Story 12-6: PipelineRunStatusEnum includes stopped', () => {
  it("parses 'stopped' without throwing", () => {
    expect(() => PipelineRunStatusEnum.parse('stopped')).not.toThrow()
    expect(PipelineRunStatusEnum.parse('stopped')).toBe('stopped')
  })

  it("parses all existing statuses without regression", () => {
    for (const status of ['running', 'paused', 'completed', 'failed'] as const) {
      expect(() => PipelineRunStatusEnum.parse(status)).not.toThrow()
    }
  })

  it("throws ZodError for invalid status value", () => {
    expect(() => PipelineRunStatusEnum.parse('invalid')).toThrow()
    expect(() => PipelineRunStatusEnum.parse('halted')).toThrow()
  })
})

describe('Story 12-6: PipelineRunSchema includes parent_run_id', () => {
  const baseRun = {
    id: '00000000-0000-4000-8000-000000000001',
    methodology: 'bmad',
    status: 'running' as const,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  it('parses successfully without parent_run_id (backward compatibility)', () => {
    const result = PipelineRunSchema.parse(baseRun)
    expect(result.parent_run_id).toBeUndefined()
  })

  it('parses successfully with parent_run_id as null', () => {
    const result = PipelineRunSchema.parse({ ...baseRun, parent_run_id: null })
    expect(result.parent_run_id).toBeNull()
  })

  it('parses successfully with parent_run_id as a valid UUID string', () => {
    const parentId = '00000000-0000-4000-8000-000000000002'
    const result = PipelineRunSchema.parse({ ...baseRun, parent_run_id: parentId })
    expect(result.parent_run_id).toBe(parentId)
  })

  it('throws ZodError when parent_run_id is a number', () => {
    expect(() => PipelineRunSchema.parse({ ...baseRun, parent_run_id: 42 })).toThrow()
  })

  it("parses status 'stopped' within PipelineRunSchema", () => {
    const result = PipelineRunSchema.parse({ ...baseRun, status: 'stopped' })
    expect(result.status).toBe('stopped')
  })
})

describe('Story 12-6: DecisionSchema includes superseded_by', () => {
  const baseDecision = {
    id: '00000000-0000-4000-8000-000000000010',
    pipeline_run_id: '00000000-0000-4000-8000-000000000001',
    phase: 'analysis',
    category: 'tech-stack',
    key: 'database',
    value: 'sqlite',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  it('parses successfully without superseded_by (backward compatibility)', () => {
    const result = DecisionSchema.parse(baseDecision)
    expect(result.superseded_by).toBeUndefined()
  })

  it('parses successfully with superseded_by as null', () => {
    const result = DecisionSchema.parse({ ...baseDecision, superseded_by: null })
    expect(result.superseded_by).toBeNull()
  })

  it('parses successfully with superseded_by as a valid UUID string', () => {
    const amendId = '00000000-0000-4000-8000-000000000020'
    const result = DecisionSchema.parse({ ...baseDecision, superseded_by: amendId })
    expect(result.superseded_by).toBe(amendId)
  })

  it('throws ZodError when superseded_by is a number', () => {
    expect(() => DecisionSchema.parse({ ...baseDecision, superseded_by: 99 })).toThrow()
  })

  it('parses successfully when both superseded_by and rationale are absent', () => {
    const minimalDecision = {
      id: '00000000-0000-4000-8000-000000000011',
      phase: 'planning',
      category: 'arch',
      key: 'pattern',
      value: 'layered',
    }
    const result = DecisionSchema.parse(minimalDecision)
    expect(result.superseded_by).toBeUndefined()
    expect(result.rationale).toBeUndefined()
  })
})
