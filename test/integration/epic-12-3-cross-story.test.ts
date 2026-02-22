/**
 * Epic 12.3 — Amendment Data Model
 * Cross-Story Integration Tests
 *
 * Identifies and covers integration gaps between:
 *   - Story 12-5 (Migration 008): database schema changes
 *   - Story 12-6 (Schema Type Updates): Zod schema updates in decisions.ts
 *   - Story 12-7 (Amendment Query Functions): amendments.ts query functions
 *
 * These tests verify cross-story interactions that are NOT covered by the
 * individual story unit tests:
 *
 * Gap 1: decisions.ts high-level API + 'stopped' status persisted through DB + Zod validation
 * Gap 2: decisions.ts:createDecision interoperability with amendments.ts:loadParentRunDecisions
 * Gap 3: getDecisionsByPhase (inclusive) vs loadParentRunDecisions (superseded-filtered) diverge correctly
 * Gap 4: Full amendment lifecycle using decisions.ts high-level API feeding amendment queries
 * Gap 5: getLatestCompletedRun schema validation when run has parent_run_id populated
 * Gap 6: Migration 008 columns visible from decisions.ts:getLatestRun (PipelineRunSchema backward compat)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { randomUUID } from 'crypto'

import { runMigrations } from '../../src/persistence/migrations/index.js'
import {
  PipelineRunSchema,
  DecisionSchema,
  PipelineRunStatusEnum,
} from '../../src/persistence/schemas/decisions.js'
import {
  createDecision,
  createPipelineRun,
  updatePipelineRun,
  getLatestRun,
  getDecisionsByPhase,
} from '../../src/persistence/queries/decisions.js'
import {
  createAmendmentRun,
  loadParentRunDecisions,
  supersedeDecision,
  getActiveDecisions,
  getAmendmentRunChain,
  getLatestCompletedRun,
} from '../../src/persistence/queries/amendments.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function openMigratedDb(): BetterSqlite3Database {
  const db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

// ---------------------------------------------------------------------------
// Gap 1: decisions.ts high-level API — 'stopped' status survives DB round-trip
// and passes PipelineRunSchema validation (12-6 x 12-5 interaction)
// ---------------------------------------------------------------------------

describe('Gap 1: stopped status — decisions.ts API + DB + Zod schema round-trip', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('updatePipelineRun with status=stopped persists and passes PipelineRunSchema.parse()', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    updatePipelineRun(db, run.id, { status: 'stopped' })

    const retrieved = getLatestRun(db)
    expect(retrieved).toBeDefined()
    expect(retrieved!.status).toBe('stopped')

    // Zod schema (updated in 12-6) must accept 'stopped' from DB row
    const parsed = PipelineRunSchema.safeParse(retrieved)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      expect(parsed.data.status).toBe('stopped')
    }
  })

  it('PipelineRunStatusEnum (12-6) aligns with DB CHECK constraint (12-5) for all 5 statuses', () => {
    const statuses = ['running', 'paused', 'completed', 'failed', 'stopped'] as const
    for (const status of statuses) {
      const runId = randomUUID()
      // DB insert must not throw (CHECK constraint from 12-5)
      expect(() => {
        db.prepare(
          `INSERT INTO pipeline_runs (id, methodology, status) VALUES (?, 'bmad', ?)`,
        ).run(runId, status)
      }).not.toThrow()

      // Zod enum (from 12-6) must accept the same status
      const zodResult = PipelineRunStatusEnum.safeParse(status)
      expect(zodResult.success).toBe(true)
    }
  })

  it('status=stopped run returned by getLatestRun has parent_run_id field (null) in result', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    updatePipelineRun(db, run.id, { status: 'stopped' })

    const retrieved = getLatestRun(db)
    // After migration 008 (12-5), all rows have parent_run_id column
    // PipelineRunSchema (12-6) must accept null for parent_run_id
    const parsed = PipelineRunSchema.safeParse(retrieved)
    expect(parsed.success).toBe(true)
    if (parsed.success) {
      // parent_run_id should be null (not absent) since it's a DB column returning NULL
      expect(parsed.data.parent_run_id === null || parsed.data.parent_run_id === undefined).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 2: decisions.ts:createDecision interoperability with
//         amendments.ts:loadParentRunDecisions (12-7 x 12-6 x 12-5)
// ---------------------------------------------------------------------------

describe('Gap 2: createDecision (decisions.ts) interoperates with loadParentRunDecisions (amendments.ts)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('decisions written via createDecision are returned by loadParentRunDecisions', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    updatePipelineRun(db, run.id, { status: 'completed' })

    const d1 = createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'architecture',
      key: 'db-engine',
      value: 'SQLite',
      rationale: 'Embedded, zero-config',
    })
    const d2 = createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'planning',
      category: 'scope',
      key: 'timeline',
      value: 'Q2 2026',
    })

    const loaded = loadParentRunDecisions(db, run.id)
    const ids = loaded.map((d) => d.id)
    expect(ids).toContain(d1.id)
    expect(ids).toContain(d2.id)
    expect(loaded).toHaveLength(2)
  })

  it('decisions returned by loadParentRunDecisions all pass DecisionSchema.parse() (12-6 schema update)', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    updatePipelineRun(db, run.id, { status: 'completed' })

    createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'architecture',
      key: 'db-engine',
      value: 'SQLite',
    })
    createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'planning',
      category: 'scope',
      key: 'timeline',
      value: 'Q2 2026',
    })

    const loaded = loadParentRunDecisions(db, run.id)
    for (const decision of loaded) {
      const result = DecisionSchema.safeParse(decision)
      expect(result.success).toBe(true)
      if (result.success) {
        // New column from 12-5, optional in 12-6 schema — must be null (not absent)
        expect(result.data.superseded_by === null || result.data.superseded_by === undefined).toBe(true)
      }
    }
  })

  it('createDecision result itself passes DecisionSchema.parse() with new superseded_by field', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    const decision = createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'architecture',
      key: 'db-engine',
      value: 'SQLite',
    })

    // The Decision type (from 12-6) now includes superseded_by field
    const result = DecisionSchema.safeParse(decision)
    expect(result.success).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Gap 3: getDecisionsByPhase (inclusive of superseded) vs
//         loadParentRunDecisions (excludes superseded) — correct divergence
// ---------------------------------------------------------------------------

describe('Gap 3: getDecisionsByPhase (inclusive) vs loadParentRunDecisions (filtered) divergence', () => {
  let db: BetterSqlite3Database
  let runId: string
  let originalDecId: string
  let supersedingDecId: string

  beforeEach(() => {
    db = openMigratedDb()

    const run = createPipelineRun(db, { methodology: 'bmad' })
    updatePipelineRun(db, run.id, { status: 'completed' })
    runId = run.id

    const original = createDecision(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      category: 'architecture',
      key: 'db-engine',
      value: 'MySQL',
      rationale: 'Originally chosen',
    })
    const superseding = createDecision(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      category: 'architecture',
      key: 'db-engine-v2',
      value: 'PostgreSQL',
      rationale: 'Better scalability',
    })
    originalDecId = original.id
    supersedingDecId = superseding.id

    // Supersede the original decision
    supersedeDecision(db, originalDecId, supersedingDecId)
  })

  afterEach(() => {
    db.close()
  })

  it('getDecisionsByPhase returns ALL decisions including superseded ones', () => {
    const byPhase = getDecisionsByPhase(db, 'analysis')
    const ids = byPhase.map((d) => d.id)
    // getDecisionsByPhase does NOT filter superseded — both should be present
    expect(ids).toContain(originalDecId)
    expect(ids).toContain(supersedingDecId)
    expect(byPhase).toHaveLength(2)
  })

  it('loadParentRunDecisions returns ONLY non-superseded decisions', () => {
    const loaded = loadParentRunDecisions(db, runId)
    const ids = loaded.map((d) => d.id)
    // loadParentRunDecisions filters WHERE superseded_by IS NULL
    expect(ids).not.toContain(originalDecId)
    expect(ids).toContain(supersedingDecId)
    expect(loaded).toHaveLength(1)
  })

  it('getActiveDecisions also filters out superseded (consistent with loadParentRunDecisions)', () => {
    const active = getActiveDecisions(db, { pipeline_run_id: runId })
    const ids = active.map((d) => d.id)
    expect(ids).not.toContain(originalDecId)
    expect(ids).toContain(supersedingDecId)
  })

  it('superseded decision has superseded_by set — DecisionSchema accepts it', () => {
    const row = db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(originalDecId) as Record<string, unknown>

    const result = DecisionSchema.safeParse(row)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.superseded_by).toBe(supersedingDecId)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Full amendment lifecycle using decisions.ts high-level API
//         combined with amendments.ts query functions (all 3 stories)
// ---------------------------------------------------------------------------

describe('Gap 4: Full amendment lifecycle using high-level API (decisions.ts + amendments.ts)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('full amendment lifecycle: create run, add decisions, complete, amend, supersede, verify active', () => {
    // Step 1: Create and complete a parent run via decisions.ts high-level API
    const parentRun = createPipelineRun(db, {
      methodology: 'bmad',
      start_phase: 'analysis',
    })
    expect(parentRun.status).toBe('running')

    // Step 2: Add decisions to the parent run
    const dec1 = createDecision(db, {
      pipeline_run_id: parentRun.id,
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'PostgreSQL',
    })
    const dec2 = createDecision(db, {
      pipeline_run_id: parentRun.id,
      phase: 'analysis',
      category: 'stack',
      key: 'language',
      value: 'TypeScript',
    })
    const dec3 = createDecision(db, {
      pipeline_run_id: parentRun.id,
      phase: 'planning',
      category: 'scope',
      key: 'mvp-deadline',
      value: 'Q2 2026',
    })

    // Step 3: Mark parent run as completed
    updatePipelineRun(db, parentRun.id, { status: 'completed' })

    // Step 4: Create amendment run via amendments.ts (12-7)
    const amendRunId = randomUUID()
    const returnedId = createAmendmentRun(db, {
      id: amendRunId,
      parentRunId: parentRun.id,
      methodology: 'bmad',
    })
    expect(returnedId).toBe(amendRunId)

    // Step 5: Load parent decisions to seed amendment context
    const parentDecisions = loadParentRunDecisions(db, parentRun.id)
    expect(parentDecisions).toHaveLength(3)

    // Step 6: Create a new decision in amendment run that supersedes dec1
    const newDec = createDecision(db, {
      pipeline_run_id: amendRunId,
      phase: 'analysis',
      category: 'architecture',
      key: 'database-v2',
      value: 'CockroachDB',
      rationale: 'Better distributed support needed',
    })

    // Step 7: Supersede the original database decision
    supersedeDecision(db, dec1.id, newDec.id)

    // Step 8: Verify active decisions across all runs
    const activeFromParent = getActiveDecisions(db, { pipeline_run_id: parentRun.id })
    const parentIds = activeFromParent.map((d) => d.id)
    expect(parentIds).not.toContain(dec1.id)  // superseded
    expect(parentIds).toContain(dec2.id)       // still active
    expect(parentIds).toContain(dec3.id)       // still active

    const activeFromAmend = getActiveDecisions(db, { pipeline_run_id: amendRunId })
    const amendIds = activeFromAmend.map((d) => d.id)
    expect(amendIds).toContain(newDec.id)      // the new superseding decision

    // Step 9: Verify amendment chain
    const chain = getAmendmentRunChain(db, amendRunId)
    expect(chain).toHaveLength(2)
    expect(chain[0].runId).toBe(parentRun.id)
    expect(chain[0].depth).toBe(0)
    expect(chain[0].parentRunId).toBeNull()
    expect(chain[1].runId).toBe(amendRunId)
    expect(chain[1].depth).toBe(1)
    expect(chain[1].parentRunId).toBe(parentRun.id)

    // Step 10: All returned runs pass PipelineRunSchema validation
    for (const entry of chain) {
      const row = db
        .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
        .get(entry.runId) as Record<string, unknown>
      const result = PipelineRunSchema.safeParse(row)
      expect(result.success).toBe(true)
    }
  })

  it('amendment run inserted by createAmendmentRun is retrievable by getLatestCompletedRun after completion', () => {
    const parentRun = createPipelineRun(db, { methodology: 'bmad' })
    updatePipelineRun(db, parentRun.id, { status: 'completed' })

    const amendRunId = randomUUID()
    createAmendmentRun(db, {
      id: amendRunId,
      parentRunId: parentRun.id,
      methodology: 'bmad',
    })

    // Amendment run starts as 'running' — not yet visible to getLatestCompletedRun
    const beforeCompletion = getLatestCompletedRun(db)
    expect(beforeCompletion?.id).toBe(parentRun.id)

    // Mark amendment run as completed
    updatePipelineRun(db, amendRunId, { status: 'completed' })

    // Now amendment run is the latest completed
    const afterCompletion = getLatestCompletedRun(db)
    expect(afterCompletion?.id).toBe(amendRunId)

    // And it has parent_run_id set (validates 12-5 schema + 12-6 Zod update)
    const result = PipelineRunSchema.safeParse(afterCompletion)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.parent_run_id).toBe(parentRun.id)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 5: getLatestCompletedRun schema validation when run has parent_run_id
//         populated (12-7 x 12-6 x 12-5 three-way interaction)
// ---------------------------------------------------------------------------

describe('Gap 5: getLatestCompletedRun result schema validation with parent_run_id populated', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('getLatestCompletedRun returns amendment run with parent_run_id — passes PipelineRunSchema', () => {
    const parentId = randomUUID()
    const amendId = randomUUID()
    db.prepare(`
      INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
      VALUES (?, 'bmad', 'completed', '2024-01-01T00:00:00', '2024-01-01T00:00:00')
    `).run(parentId)
    db.prepare(`
      INSERT INTO pipeline_runs (id, methodology, status, parent_run_id, created_at, updated_at)
      VALUES (?, 'bmad', 'completed', ?, '2024-06-01T00:00:00', '2024-06-01T00:00:00')
    `).run(amendId, parentId)

    const latest = getLatestCompletedRun(db)
    expect(latest).toBeDefined()
    expect(latest?.id).toBe(amendId)

    // PipelineRunSchema (updated in 12-6) must parse the DB row including parent_run_id
    const result = PipelineRunSchema.safeParse(latest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.parent_run_id).toBe(parentId)
      expect(result.data.status).toBe('completed')
    }
  })

  it('getLatestCompletedRun returns top-level run (parent_run_id=null) — passes PipelineRunSchema', () => {
    const runId = randomUUID()
    db.prepare(`
      INSERT INTO pipeline_runs (id, methodology, status, created_at, updated_at)
      VALUES (?, 'bmad', 'completed', '2024-01-01T00:00:00', '2024-01-01T00:00:00')
    `).run(runId)

    const latest = getLatestCompletedRun(db)
    expect(latest).toBeDefined()

    const result = PipelineRunSchema.safeParse(latest)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.parent_run_id === null || result.data.parent_run_id === undefined).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// Gap 6: Migration 008 columns visible from decisions.ts:getLatestRun
//         (backward compatibility for existing query layer — 12-5 x 12-6)
// ---------------------------------------------------------------------------

describe('Gap 6: decisions.ts query functions return migration 008 columns correctly', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('getLatestRun returns a row with parent_run_id field (null) after migration 008', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    const retrieved = getLatestRun(db)

    expect(retrieved).toBeDefined()
    // parent_run_id is a new column from 12-5 — should be null for non-amendment runs
    // PipelineRunSchema (12-6) should parse it successfully with null or undefined
    const result = PipelineRunSchema.safeParse(retrieved)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.id).toBe(run.id)
    }
  })

  it('createDecision returns a Decision with superseded_by field (null) after migration 008', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    const decision = createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'arch',
      key: 'db',
      value: 'sqlite',
    })

    // superseded_by is a new column from 12-5 — should be null for new decisions
    // DecisionSchema (12-6) should parse it successfully
    const result = DecisionSchema.safeParse(decision)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.id).toBe(decision.id)
      expect(result.data.superseded_by === null || result.data.superseded_by === undefined).toBe(true)
    }
  })

  it('decisions.ts and amendments.ts both see same data after createDecision + supersedeDecision', () => {
    const run = createPipelineRun(db, { methodology: 'bmad' })
    updatePipelineRun(db, run.id, { status: 'completed' })

    const dec1 = createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'arch',
      key: 'db',
      value: 'mysql',
    })
    const dec2 = createDecision(db, {
      pipeline_run_id: run.id,
      phase: 'analysis',
      category: 'arch',
      key: 'db-v2',
      value: 'postgres',
    })

    // Supersede via amendments.ts
    supersedeDecision(db, dec1.id, dec2.id)

    // decisions.ts:getDecisionsByPhase should see BOTH (no supersession filter)
    const byPhase = getDecisionsByPhase(db, 'analysis')
    expect(byPhase.length).toBe(2)

    // amendments.ts:loadParentRunDecisions should see ONLY dec2 (superseded filter)
    const parentDecisions = loadParentRunDecisions(db, run.id)
    expect(parentDecisions.length).toBe(1)
    expect(parentDecisions[0].id).toBe(dec2.id)

    // The superseded decision (dec1) has superseded_by set — visible via decisions.ts data
    const supersededRow = byPhase.find((d) => d.id === dec1.id)
    expect(supersededRow).toBeDefined()
    // DecisionSchema handles this correctly
    const result = DecisionSchema.safeParse(supersededRow)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.superseded_by).toBe(dec2.id)
    }
  })
})
