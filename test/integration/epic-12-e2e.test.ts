/**
 * Epic 12 — Amendment Workflow & Developer Tools
 * Cross-module Integration Tests
 *
 * Covers integration gaps between:
 *   1. Migration 008 + Zod schemas + amendment query functions (data layer)
 *   2. Amendment queries + context handler + delta document (amendment pipeline)
 *   3. Stop-after gate + auto amend --stop-after / --from conflict path (CLI)
 *   4. Brainstorm command registration in CLI index.ts (help output)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { randomUUID } from 'crypto'
import { Command } from 'commander'

import { runMigrations } from '../../src/persistence/migrations/index.js'
import {
  DecisionSchema,
  PipelineRunSchema,
  PipelineRunStatusEnum,
} from '../../src/persistence/schemas/decisions.js'
import {
  createAmendmentRun,
  loadParentRunDecisions,
  supersedeDecision,
  getActiveDecisions,
  getAmendmentRunChain,
  getLatestCompletedRun,
} from '../../src/persistence/queries/amendments.js'
import { createAmendmentContextHandler } from '../../src/modules/amendment-handlers/index.js'
import {
  generateDeltaDocument,
  validateDeltaDocument,
  formatDeltaDocument,
} from '../../src/modules/delta-document/index.js'
import {
  validateStopAfterFromConflict,
  VALID_PHASES,
} from '../../src/modules/stop-after/index.js'
import { registerBrainstormCommand } from '../../src/cli/commands/brainstorm.js'

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

/** Insert a pipeline_run using a real UUID for id, for Zod schema compatibility. */
function insertRun(
  db: BetterSqlite3Database,
  id: string,
  status: string = 'completed',
  parentRunId: string | null = null,
): void {
  db.prepare(`
    INSERT INTO pipeline_runs (id, methodology, status, parent_run_id, created_at, updated_at)
    VALUES (?, 'bmad', ?, ?, datetime('now'), datetime('now'))
  `).run(id, status, parentRunId)
}

/** Insert a decision using real UUIDs for id and runId, for Zod schema compatibility. */
function insertDecision(
  db: BetterSqlite3Database,
  id: string,
  runId: string,
  overrides: {
    phase?: string
    category?: string
    key?: string
    value?: string
    rationale?: string
    supersededBy?: string | null
  } = {},
): void {
  const {
    phase = 'analysis',
    category = 'architecture',
    key = 'default-key',
    value = 'default-value',
    rationale = null,
    supersededBy = null,
  } = overrides

  db.prepare(`
    INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, rationale, superseded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
  `).run(id, runId, phase, category, key, value, rationale, supersededBy)
}

// ---------------------------------------------------------------------------
// 1. Data Layer Integration: Migration 008 + Zod schemas + query functions
// ---------------------------------------------------------------------------

describe('Data Layer Integration: Migration 008 + Zod schemas + amendment queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('PipelineRunStatusEnum accepts "stopped" — value added in Migration 008', () => {
    const result = PipelineRunStatusEnum.safeParse('stopped')
    expect(result.success).toBe(true)
  })

  it('PipelineRunStatusEnum rejects unknown statuses', () => {
    const result = PipelineRunStatusEnum.safeParse('unknown-status')
    expect(result.success).toBe(false)
  })

  it('PipelineRunSchema validates a row with parent_run_id (Migration 008 column)', () => {
    const parentId = randomUUID()
    const amendId = randomUUID()
    insertRun(db, parentId, 'completed')
    insertRun(db, amendId, 'running', parentId)

    const row = db
      .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
      .get(amendId) as Record<string, unknown>

    const result = PipelineRunSchema.safeParse(row)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.parent_run_id).toBe(parentId)
    }
  })

  it('PipelineRunSchema validates a row with status="stopped"', () => {
    const runId = randomUUID()
    insertRun(db, runId, 'stopped')

    const row = db
      .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
      .get(runId) as Record<string, unknown>

    const result = PipelineRunSchema.safeParse(row)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe('stopped')
    }
  })

  it('DecisionSchema validates a row with superseded_by (Migration 008 column)', () => {
    const runId = randomUUID()
    const decOrigId = randomUUID()
    const decNewId = randomUUID()
    insertRun(db, runId, 'completed')
    insertDecision(db, decOrigId, runId, { key: 'k-orig' })
    insertDecision(db, decNewId, runId, { key: 'k-new' })
    supersedeDecision(db, decOrigId, decNewId)

    const row = db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(decOrigId) as Record<string, unknown>

    const result = DecisionSchema.safeParse(row)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.superseded_by).toBe(decNewId)
    }
  })

  it('DecisionSchema validates a row with superseded_by = NULL', () => {
    const runId = randomUUID()
    const decId = randomUUID()
    insertRun(db, runId, 'completed')
    insertDecision(db, decId, runId, { key: 'k-active' })

    const row = db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(decId) as Record<string, unknown>

    const result = DecisionSchema.safeParse(row)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.superseded_by).toBeNull()
    }
  })

  it('createAmendmentRun creates a row that passes PipelineRunSchema validation', () => {
    const parentId = randomUUID()
    const newId = randomUUID()
    insertRun(db, parentId, 'completed')
    const returnedId = createAmendmentRun(db, {
      id: newId,
      parentRunId: parentId,
      methodology: 'bmad',
    })

    const row = db
      .prepare('SELECT * FROM pipeline_runs WHERE id = ?')
      .get(returnedId) as Record<string, unknown>

    const result = PipelineRunSchema.safeParse(row)
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.status).toBe('running')
      expect(result.data.parent_run_id).toBe(parentId)
    }
  })

  it('getActiveDecisions returns results that all pass DecisionSchema validation', () => {
    const runId = randomUUID()
    const d1 = randomUUID()
    const d2 = randomUUID()
    const d3 = randomUUID()
    const d4 = randomUUID()
    insertRun(db, runId, 'running')
    insertDecision(db, d1, runId, { phase: 'analysis', key: 'k1', value: 'v1' })
    insertDecision(db, d2, runId, { phase: 'planning', key: 'k2', value: 'v2' })
    insertDecision(db, d3, runId, { phase: 'analysis', key: 'k3', value: 'v3' })
    insertDecision(db, d4, runId, { phase: 'analysis', key: 'k4', value: 'v4' })
    // Supersede d1
    supersedeDecision(db, d1, d4)

    const active = getActiveDecisions(db, { pipeline_run_id: runId })

    expect(active.length).toBeGreaterThan(0)
    for (const d of active) {
      const result = DecisionSchema.safeParse(d)
      expect(result.success).toBe(true)
    }

    // Verify no superseded decisions returned
    const ids = active.map((d) => d.id)
    expect(ids).not.toContain(d1)
    expect(ids).toContain(d2)
  })

  it('getLatestCompletedRun result passes PipelineRunSchema validation', () => {
    const runId = randomUUID()
    insertRun(db, runId, 'completed')

    const run = getLatestCompletedRun(db)
    expect(run).toBeDefined()

    const result = PipelineRunSchema.safeParse(run)
    expect(result.success).toBe(true)
  })

  it('getAmendmentRunChain entries all reference real rows — chain depth matches parent_run_id links', () => {
    const r0 = randomUUID()
    const r1 = randomUUID()
    const r2 = randomUUID()
    insertRun(db, r0, 'completed')
    insertRun(db, r1, 'completed', r0)
    insertRun(db, r2, 'running', r1)

    const chain = getAmendmentRunChain(db, r2)
    expect(chain).toHaveLength(3)

    // Verify each entry's parent_run_id matches the previous entry's runId
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i].parentRunId).toBe(chain[i - 1].runId)
    }

    // Validate root has depth 0
    expect(chain[0].depth).toBe(0)
    expect(chain[0].parentRunId).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// 2. Amendment Pipeline Integration: queries + context handler + delta document
// ---------------------------------------------------------------------------

describe('Amendment Pipeline Integration: queries + context handler + delta document', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('context handler loads real parent decisions from DB and formats phase context', () => {
    // Setup: completed parent run with decisions (using real UUIDs for IDs)
    const parentRunId = randomUUID()
    const d1 = randomUUID()
    const d2 = randomUUID()
    const d3 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, d1, parentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database-choice',
      value: 'PostgreSQL',
      rationale: 'Scalability requirements',
    })
    insertDecision(db, d2, parentRunId, {
      phase: 'analysis',
      category: 'stack',
      key: 'language',
      value: 'TypeScript',
    })
    insertDecision(db, d3, parentRunId, {
      phase: 'planning',
      category: 'scope',
      key: 'mvp-deadline',
      value: 'Q2 2026',
    })

    const handler = createAmendmentContextHandler(db, parentRunId, {
      framingConcept: 'Add Redis caching layer',
    })

    // Verify getParentDecisions returns all 3 decisions
    const decisions = handler.getParentDecisions()
    expect(decisions).toHaveLength(3)

    // Verify loadContextForPhase filters to analysis phase only
    const analysisContext = handler.loadContextForPhase('analysis')
    expect(analysisContext).toContain('AMENDMENT CONTEXT')
    expect(analysisContext).toContain('database-choice')
    expect(analysisContext).toContain('PostgreSQL')
    expect(analysisContext).toContain('language')
    expect(analysisContext).toContain('TypeScript')
    // planning decision should NOT appear in analysis context
    expect(analysisContext).not.toContain('mvp-deadline')
    // Framing concept should appear
    expect(analysisContext).toContain('Add Redis caching layer')
  })

  it('context handler excludes superseded decisions loaded from DB', () => {
    const parentRunId = randomUUID()
    const supD1 = randomUUID()
    const supD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, supD1, parentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'db-type',
      value: 'MySQL',
    })
    insertDecision(db, supD2, parentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'db-type-new',
      value: 'PostgreSQL',
    })
    // Supersede d1 with d2
    supersedeDecision(db, supD1, supD2)

    const handler = createAmendmentContextHandler(db, parentRunId)

    const decisions = handler.getParentDecisions()
    const ids = decisions.map((d) => d.id)
    // Superseded decision should not be included
    expect(ids).not.toContain(supD1)
    expect(ids).toContain(supD2)
  })

  it('context handler supersession log is independent of DB state', () => {
    const parentRunId = randomUUID()
    const logD1 = randomUUID()
    const logD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, logD1, parentRunId, { phase: 'analysis', key: 'k1', value: 'v1' })

    const handler = createAmendmentContextHandler(db, parentRunId)

    // Initial log should be empty
    expect(handler.getSupersessionLog()).toHaveLength(0)

    // Log an entry
    handler.logSupersession({
      originalDecisionId: logD1,
      supersedingDecisionId: logD2,
      phase: 'analysis',
      reason: 'Better approach found',
      loggedAt: new Date().toISOString(),
    })

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(1)
    expect(log[0].originalDecisionId).toBe(logD1)
    expect(log[0].reason).toBe('Better approach found')

    // Verify getSupersessionLog returns a defensive copy
    const log2 = handler.getSupersessionLog()
    log2.push({
      originalDecisionId: 'fake',
      supersedingDecisionId: 'fake2',
      phase: 'planning',
      reason: 'tamper',
      loggedAt: new Date().toISOString(),
    })
    // Original log should still be length 1
    expect(handler.getSupersessionLog()).toHaveLength(1)
  })

  it('delta document generation integrates with real DB decision data', async () => {
    const parentRunId = randomUUID()
    const deltaPd1 = randomUUID()
    const deltaPd2 = randomUUID()
    const deltaAd1 = randomUUID()

    insertRun(db, parentRunId, 'completed')
    insertDecision(db, deltaPd1, parentRunId, {
      phase: 'analysis',
      category: 'arch',
      key: 'db-engine',
      value: 'MySQL',
    })
    insertDecision(db, deltaPd2, parentRunId, {
      phase: 'planning',
      category: 'scope',
      key: 'team-size',
      value: '3',
    })

    // Create amendment run
    const amendmentId = createAmendmentRun(db, {
      id: randomUUID(),
      parentRunId,
      methodology: 'bmad',
    })

    // Insert amendment decisions
    insertDecision(db, deltaAd1, amendmentId, {
      phase: 'analysis',
      category: 'arch',
      key: 'db-engine-new',
      value: 'PostgreSQL',
    })
    // Supersede the parent decision
    supersedeDecision(db, deltaPd1, deltaAd1)

    // Load ALL parent decisions first (before the supersession is reflected in loadParentRunDecisions)
    // Note: loadParentRunDecisions returns only non-superseded decisions.
    // We need the superseded decision separately.
    const supersededRow = db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(deltaPd1) as Parameters<typeof generateDeltaDocument>[0]['supersededDecisions'][0]

    // Load current active parent decisions (deltaPd1 is now excluded; deltaPd2 is active)
    const parentDecisions = loadParentRunDecisions(db, parentRunId)
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentId })
    const supersededDecisions = [supersededRow]

    const doc = await generateDeltaDocument(
      {
        amendmentRunId: amendmentId,
        parentRunId,
        parentDecisions,
        amendmentDecisions,
        supersededDecisions,
        framingConcept: 'Migrate to PostgreSQL',
        runImpactAnalysis: false,
      },
      undefined, // no dispatch needed
    )

    // Validate document structure
    const validation = validateDeltaDocument(doc)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)

    // Verify executive summary references both run IDs
    expect(doc.executiveSummary.text).toContain(amendmentId)
    expect(doc.executiveSummary.text).toContain(parentRunId)
    expect(doc.executiveSummary.wordCount).toBeGreaterThanOrEqual(20)

    // Verify new decisions (amendment decisions not in parent)
    const newDecIds = doc.newDecisions.map((d) => d.id)
    expect(newDecIds).toContain(deltaAd1)

    // Verify superseded decisions
    const supIds = doc.supersededDecisions.map((d) => d.id)
    expect(supIds).toContain(deltaPd1)

    // Verify recommendations are generated
    expect(doc.recommendations.length).toBeGreaterThan(0)
  })

  it('formatDeltaDocument renders valid markdown with all sections', async () => {
    const fmtParentId = randomUUID()
    const fmtPd1 = randomUUID()
    const fmtAd1 = randomUUID()
    const fmtAmendId = randomUUID()

    insertRun(db, fmtParentId, 'completed')
    insertDecision(db, fmtPd1, fmtParentId, {
      phase: 'analysis',
      category: 'arch',
      key: 'pattern',
      value: 'monolith',
    })
    insertDecision(db, fmtAd1, fmtParentId, {
      phase: 'analysis',
      category: 'arch',
      key: 'pattern-new',
      value: 'microservices',
    })
    supersedeDecision(db, fmtPd1, fmtAd1)

    const parentDecisions = loadParentRunDecisions(db, fmtParentId)
    const supersededRow = db
      .prepare('SELECT * FROM decisions WHERE id = ?')
      .get(fmtPd1) as Parameters<typeof generateDeltaDocument>[0]['supersededDecisions'][0]

    const doc = await generateDeltaDocument({
      amendmentRunId: fmtAmendId,
      parentRunId: fmtParentId,
      parentDecisions,
      amendmentDecisions: [
        {
          id: fmtAd1,
          pipeline_run_id: fmtAmendId,
          phase: 'analysis',
          category: 'arch',
          key: 'pattern-new',
          value: 'microservices',
        },
      ],
      supersededDecisions: [supersededRow],
      newStories: ['stories/12-1.md'],
      runImpactAnalysis: false,
    })

    const markdown = formatDeltaDocument(doc)

    // All required sections
    expect(markdown).toContain('# Amendment Delta Report')
    expect(markdown).toContain('## Executive Summary')
    expect(markdown).toContain('## New Decisions')
    expect(markdown).toContain('## Superseded Decisions')
    expect(markdown).toContain('## New Stories')
    expect(markdown).toContain('## Impact Analysis')
    expect(markdown).toContain('## Recommendations')

    // Metadata
    expect(markdown).toContain(fmtAmendId)
    expect(markdown).toContain(fmtParentId)

    // New stories
    expect(markdown).toContain('stories/12-1.md')
  })

  it('full amendment pipeline flow: create run → load context → generate delta → validate', async () => {
    // Step 1: Original completed run with decisions
    const fullParentId = randomUUID()
    const ffD1 = randomUUID()
    const ffD2 = randomUUID()
    const ffAmendD1 = randomUUID()

    insertRun(db, fullParentId, 'completed')
    insertDecision(db, ffD1, fullParentId, {
      phase: 'analysis',
      category: 'auth',
      key: 'auth-mechanism',
      value: 'JWT',
      rationale: 'Stateless auth for API',
    })
    insertDecision(db, ffD2, fullParentId, {
      phase: 'analysis',
      category: 'database',
      key: 'orm',
      value: 'TypeORM',
    })

    // Step 2: Create amendment run
    const amendId = createAmendmentRun(db, {
      id: randomUUID(),
      parentRunId: fullParentId,
      methodology: 'bmad',
      configJson: '{"mode":"amendment"}',
    })

    // Step 3: Create context handler (reads from DB)
    const handler = createAmendmentContextHandler(db, fullParentId, {
      framingConcept: 'Switch to session-based auth',
    })

    // Step 4: Verify context for analysis phase contains parent decisions
    const context = handler.loadContextForPhase('analysis')
    expect(context).toContain('auth-mechanism')
    expect(context).toContain('JWT')
    expect(context).toContain('Switch to session-based auth')

    // Step 5: Insert amendment decision and supersede original
    insertDecision(db, ffAmendD1, amendId, {
      phase: 'analysis',
      category: 'auth',
      key: 'auth-mechanism',
      value: 'session',
      rationale: 'Better user experience',
    })
    supersedeDecision(db, ffD1, ffAmendD1)

    // Step 6: Log the supersession in the handler
    handler.logSupersession({
      originalDecisionId: ffD1,
      supersedingDecisionId: ffAmendD1,
      phase: 'analysis',
      reason: 'Switching to session auth for better UX',
      loggedAt: new Date().toISOString(),
    })

    expect(handler.getSupersessionLog()).toHaveLength(1)

    // Step 7: Generate delta document
    const parentDecisions = loadParentRunDecisions(db, fullParentId)
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendId })

    // ff-d1 is now superseded, so parentDecisions won't include it
    const supersededDecisions = [
      db.prepare('SELECT * FROM decisions WHERE id = ?').get(ffD1),
    ].filter(Boolean) as Parameters<typeof generateDeltaDocument>[0]['supersededDecisions']

    const doc = await generateDeltaDocument({
      amendmentRunId: amendId,
      parentRunId: fullParentId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions,
      runImpactAnalysis: false,
    })

    const validation = validateDeltaDocument(doc)
    expect(validation.valid).toBe(true)

    // The amendment decision should be a "new" decision
    expect(doc.newDecisions.some((d) => d.id === ffAmendD1)).toBe(true)

    // Verify chain is correct
    const chain = getAmendmentRunChain(db, amendId)
    expect(chain).toHaveLength(2)
    expect(chain[0].runId).toBe(fullParentId)
    expect(chain[1].runId).toBe(amendId)
  })
})

// ---------------------------------------------------------------------------
// 3. Stop-After Gate + Amend Command Integration
// ---------------------------------------------------------------------------

describe('Stop-After Gate + Amend Command: --stop-after / --from conflict validation', () => {
  it('validateStopAfterFromConflict: all phases are valid stop-after targets for any from phase at or before them', () => {
    // analysis → analysis: valid (same phase)
    expect(validateStopAfterFromConflict('analysis', 'analysis').valid).toBe(true)

    // planning → analysis: analysis comes before planning in order, so stop=planning from=analysis is valid
    expect(validateStopAfterFromConflict('planning', 'analysis').valid).toBe(true)

    // analysis → planning: stop=analysis comes before from=planning → invalid
    const result = validateStopAfterFromConflict('analysis', 'planning')
    expect(result.valid).toBe(false)
    expect(result.error).toContain('--stop-after analysis')
    expect(result.error).toContain('--from planning')
  })

  it('validateStopAfterFromConflict: every invalid stop-after / from combination returns descriptive error', () => {
    // Build all pairs where stopAfter comes before from
    const phases = VALID_PHASES
    const invalidPairs: Array<[string, string]> = []

    for (let i = 0; i < phases.length; i++) {
      for (let j = i + 1; j < phases.length; j++) {
        // stopAfter=phases[i], from=phases[j] → stopAfter before from → invalid
        invalidPairs.push([phases[i], phases[j]])
      }
    }

    expect(invalidPairs.length).toBeGreaterThan(0)

    for (const [stopAfter, from] of invalidPairs) {
      const result = validateStopAfterFromConflict(
        stopAfter as Parameters<typeof validateStopAfterFromConflict>[0],
        from as Parameters<typeof validateStopAfterFromConflict>[1],
      )
      expect(result.valid).toBe(false)
      expect(result.error).toBeDefined()
      expect(typeof result.error).toBe('string')
    }
  })

  it('validateStopAfterFromConflict: undefined from is always valid', () => {
    for (const phase of VALID_PHASES) {
      const result = validateStopAfterFromConflict(
        phase as Parameters<typeof validateStopAfterFromConflict>[0],
        undefined,
      )
      expect(result.valid).toBe(true)
      expect(result.error).toBeUndefined()
    }
  })

  it('validateStopAfterFromConflict: all same-phase combos are valid', () => {
    for (const phase of VALID_PHASES) {
      const result = validateStopAfterFromConflict(
        phase as Parameters<typeof validateStopAfterFromConflict>[0],
        phase as Parameters<typeof validateStopAfterFromConflict>[1],
      )
      expect(result.valid).toBe(true)
    }
  })
})

// ---------------------------------------------------------------------------
// 4. Brainstorm Command Registration in CLI index.ts (help output)
// ---------------------------------------------------------------------------

describe('Brainstorm Command Registration Integration', () => {
  it('brainstorm command is listed when registered on a program', () => {
    const program = new Command()
    registerBrainstormCommand(program)

    const commandNames = program.commands.map((c) => c.name())
    expect(commandNames).toContain('brainstorm')
  })

  it('brainstorm command description appears in help output', () => {
    const program = new Command()
    program.exitOverride() // prevent process.exit during tests
    registerBrainstormCommand(program)

    const helpText = program.helpInformation()
    expect(helpText).toContain('brainstorm')
  })

  it('brainstorm command --existing option is documented in its own help', () => {
    const program = new Command()
    registerBrainstormCommand(program)

    const brCmd = program.commands.find((c) => c.name() === 'brainstorm')
    expect(brCmd).toBeDefined()

    const brHelp = brCmd!.helpInformation()
    expect(brHelp).toContain('--existing')
  })

  it('brainstorm command --project-root option is documented in its own help', () => {
    const program = new Command()
    registerBrainstormCommand(program)

    const brCmd = program.commands.find((c) => c.name() === 'brainstorm')
    const brHelp = brCmd!.helpInformation()
    expect(brHelp).toContain('--project-root')
  })

  it('brainstorm command --output-path option is documented in its own help', () => {
    const program = new Command()
    registerBrainstormCommand(program)

    const brCmd = program.commands.find((c) => c.name() === 'brainstorm')
    const brHelp = brCmd!.helpInformation()
    expect(brHelp).toContain('--output-path')
  })

  it('registering brainstorm on a program that already has other commands does not conflict', () => {
    const program = new Command()
    // Add a pre-existing command
    program.command('auto').description('existing command')

    expect(() => registerBrainstormCommand(program)).not.toThrow()

    const commandNames = program.commands.map((c) => c.name())
    expect(commandNames).toContain('auto')
    expect(commandNames).toContain('brainstorm')
  })
})
