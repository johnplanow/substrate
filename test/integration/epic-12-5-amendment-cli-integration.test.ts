/**
 * Epic 12.5 — Amendment CLI (substrate auto amend)
 * Cross-Story Integration Tests
 *
 * Covers integration gaps between:
 *   - Story 12-9: Delta Document Generator
 *   - Story 12-10: Auto Amend Subcommand (runAmendCommand, runPostPhaseSupersessionDetection)
 *
 * Key integration paths tested:
 *   1. Supersession detection → delta document: decisions superseded by
 *      runPostPhaseSupersessionDetection() appear in the generated delta document
 *   2. Context handler → delta document: handler.getParentDecisions() and
 *      getSupersessionLog() correctly feed generateDeltaDocument() inputs
 *   3. Delta document generation with real DB decisions: full path from
 *      amendment run creation → active decisions → delta doc → validation
 *   4. formatDeltaDocument output validity: generated delta docs pass
 *      validateDeltaDocument() and contain all required Markdown sections
 *   5. runPostPhaseSupersessionDetection(): integration with real DB decisions
 *      and handler.logSupersession() in-memory state
 *
 * All tests use real in-memory SQLite databases with migrations applied.
 * No phase runners invoked — integration is at the query + module boundary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { randomUUID } from 'crypto'

import { runMigrations } from '../../src/persistence/migrations/index.js'
import {
  createAmendmentRun,
  loadParentRunDecisions,
  supersedeDecision,
  getActiveDecisions,
} from '../../src/persistence/queries/amendments.js'
import { createAmendmentContextHandler } from '../../src/modules/amendment-handlers/index.js'
import {
  generateDeltaDocument,
  validateDeltaDocument,
  formatDeltaDocument,
} from '../../src/modules/delta-document/index.js'
import { runPostPhaseSupersessionDetection } from '../../src/cli/commands/auto.js'

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

function insertDecision(
  db: BetterSqlite3Database,
  id: string,
  runId: string,
  overrides: {
    phase?: string
    category?: string
    key?: string
    value?: string
    rationale?: string | null
  } = {},
): void {
  const {
    phase = 'analysis',
    category = 'architecture',
    key = 'default-key',
    value = 'default-value',
    rationale = null,
  } = overrides
  db.prepare(`
    INSERT INTO decisions (id, pipeline_run_id, phase, category, key, value, rationale, superseded_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, datetime('now'), datetime('now'))
  `).run(id, runId, phase, category, key, value, rationale)
}

// ---------------------------------------------------------------------------
// 1. Supersession Detection → Delta Document Integration
// ---------------------------------------------------------------------------

describe('Supersession Detection → Delta Document Integration (Stories 12-9 + 12-10)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('decisions superseded by runPostPhaseSupersessionDetection appear in the delta document supersededDecisions', async () => {
    // Setup: completed parent run with decisions
    const parentRunId = randomUUID()
    const parentD1 = randomUUID()
    const parentD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentD1, parentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'MySQL',
      rationale: 'Initial choice',
    })
    insertDecision(db, parentD2, parentRunId, {
      phase: 'analysis',
      category: 'stack',
      key: 'language',
      value: 'JavaScript',
    })

    // Create amendment run
    const amendmentRunId = randomUUID()
    createAmendmentRun(db, {
      id: amendmentRunId,
      parentRunId,
      methodology: 'bmad',
    })

    // Insert amendment decision that replaces parentD1
    const amendD1 = randomUUID()
    insertDecision(db, amendD1, amendmentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'PostgreSQL',
      rationale: 'Better performance',
    })

    // Create context handler
    const handler = createAmendmentContextHandler(db, parentRunId, {
      framingConcept: 'Upgrade database',
    })

    // Run supersession detection (as runAmendCommand does after each phase)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    // Verify in-memory supersession log was updated
    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(1)
    expect(log[0].originalDecisionId).toBe(parentD1)
    expect(log[0].supersedingDecisionId).toBe(amendD1)

    // Verify DB was updated: parentD1 should now be superseded
    const parentD1Row = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(parentD1) as { superseded_by: string | null }
    expect(parentD1Row.superseded_by).toBe(amendD1)

    // Build delta document inputs as runAmendCommand does
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })
    const parentDecisions = handler.getParentDecisions()
    const supersessionLog = handler.getSupersessionLog()
    const supersededDecisionIds = new Set(supersessionLog.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions,
      framingConcept: 'Upgrade database',
      runImpactAnalysis: false,
    })

    // The superseded decision should appear in the delta document
    const supIds = doc.supersededDecisions.map((d) => d.id)
    expect(supIds).toContain(parentD1)

    // The amendment decision should appear as a new decision
    const newDecIds = doc.newDecisions.map((d) => d.id)
    expect(newDecIds).toContain(amendD1)

    // parentD2 should NOT be in superseded decisions
    expect(supIds).not.toContain(parentD2)
  })

  it('multiple supersessions across phases all appear in delta document', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID() // analysis decision
    const pD2 = randomUUID() // planning decision
    const pD3 = randomUUID() // solutioning decision
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'MySQL' })
    insertDecision(db, pD2, parentRunId, { phase: 'planning', category: 'scope', key: 'deadline', value: 'Q1' })
    insertDecision(db, pD3, parentRunId, { phase: 'solutioning', category: 'api', key: 'protocol', value: 'REST' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    // Amendment decisions that supersede parent decisions
    const aD1 = randomUUID()
    const aD2 = randomUUID()
    const aD3 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'PostgreSQL' })
    insertDecision(db, aD2, amendmentRunId, { phase: 'planning', category: 'scope', key: 'deadline', value: 'Q2' })
    insertDecision(db, aD3, amendmentRunId, { phase: 'solutioning', category: 'api', key: 'protocol', value: 'GraphQL' })

    const handler = createAmendmentContextHandler(db, parentRunId)

    // Simulate post-phase supersession detection for each phase
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'planning', handler)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'solutioning', handler)

    // All 3 original decisions should be superseded
    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(3)

    const logOriginalIds = log.map((e) => e.originalDecisionId)
    expect(logOriginalIds).toContain(pD1)
    expect(logOriginalIds).toContain(pD2)
    expect(logOriginalIds).toContain(pD3)

    // Build delta doc
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })
    const parentDecisions = handler.getParentDecisions()
    const supersededDecisionIds = new Set(log.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions,
      runImpactAnalysis: false,
    })

    // All 3 superseded decisions should appear
    const supIds = doc.supersededDecisions.map((d) => d.id)
    expect(supIds).toContain(pD1)
    expect(supIds).toContain(pD2)
    expect(supIds).toContain(pD3)

    // 3 new decisions
    expect(doc.newDecisions).toHaveLength(3)
  })

  it('no supersessions means empty supersededDecisions and recommendations reflect no supersessions', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'SQLite' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    // Amendment adds a new decision (different key — no supersession)
    const aD1 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, { phase: 'analysis', category: 'cache', key: 'provider', value: 'Redis' })

    const handler = createAmendmentContextHandler(db, parentRunId)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    // No supersession should have occurred (different key)
    expect(handler.getSupersessionLog()).toHaveLength(0)

    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })
    const parentDecisions = handler.getParentDecisions()

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions: [], // no supersessions
      runImpactAnalysis: false,
    })

    expect(doc.supersededDecisions).toHaveLength(0)
    expect(doc.newDecisions).toHaveLength(1)
    expect(doc.newDecisions[0].id).toBe(aD1)

    // Recommendations should mention new decisions but not superseded ones
    const recs = doc.recommendations.join(' ')
    expect(recs).toContain('new decision')
    expect(recs).not.toContain('superseded decision')
  })
})

// ---------------------------------------------------------------------------
// 2. Context Handler → Delta Document Integration
// ---------------------------------------------------------------------------

describe('Context Handler → Delta Document: handler feeds generateDeltaDocument correctly', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('handler.getParentDecisions() returns correct input for new decisions computation', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    const pD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'SQLite' })
    insertDecision(db, pD2, parentRunId, { phase: 'planning', category: 'scope', key: 'size', value: 'small' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    // Amendment adds a new decision and carries over pD2 (same ID)
    const aD1 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, { phase: 'analysis', category: 'cache', key: 'redis', value: 'yes' })

    const handler = createAmendmentContextHandler(db, parentRunId)
    const parentDecisions = handler.getParentDecisions()
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions: [],
      runImpactAnalysis: false,
    })

    // aD1 is new (not in parent); pD1/pD2 IDs are not in amendment decisions
    const newDecIds = doc.newDecisions.map((d) => d.id)
    expect(newDecIds).toContain(aD1)
    expect(newDecIds).not.toContain(pD1)
    expect(newDecIds).not.toContain(pD2)
  })

  it('supersession log entries correctly map to parentDecisions for delta document supersededDecisions field', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    const pD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'MySQL' })
    insertDecision(db, pD2, parentRunId, { phase: 'planning', category: 'scope', key: 'size', value: 'medium' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    const aD1 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'PostgreSQL' })

    const handler = createAmendmentContextHandler(db, parentRunId)
    // Manually log a supersession (as runPostPhaseSupersessionDetection would)
    supersedeDecision(db, pD1, aD1)
    handler.logSupersession({
      originalDecisionId: pD1,
      supersedingDecisionId: aD1,
      phase: 'analysis',
      key: 'db',
      reason: 'Database upgrade',
      loggedAt: new Date().toISOString(),
    })

    // Build supersededDecisions from handler state (matching runAmendCommand logic)
    const parentDecisions = handler.getParentDecisions()
    const supersessionLog = handler.getSupersessionLog()
    const supersededDecisionIds = new Set(supersessionLog.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))

    // pD1 should be in supersededDecisions (it was logged)
    // Note: parentDecisions are loaded eagerly before supersession, so pD1 IS in parentDecisions
    expect(supersededDecisions.some((d) => d.id === pD1)).toBe(true)
    // pD2 should NOT be in supersededDecisions
    expect(supersededDecisions.some((d) => d.id === pD2)).toBe(false)

    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions,
      runImpactAnalysis: false,
    })

    // Superseded decisions section should contain pD1
    expect(doc.supersededDecisions.some((d) => d.id === pD1)).toBe(true)
    expect(doc.supersededDecisions.some((d) => d.id === pD2)).toBe(false)
  })

  it('handler is constructed from DB state at creation time — later DB changes do not affect getParentDecisions()', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    const pD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, { phase: 'analysis', category: 'arch', key: 'k1', value: 'v1' })

    // Create handler before pD2 is inserted
    const handler = createAmendmentContextHandler(db, parentRunId)

    // Insert pD2 AFTER handler creation
    insertDecision(db, pD2, parentRunId, { phase: 'analysis', category: 'arch', key: 'k2', value: 'v2' })

    // Handler was created before pD2 — it should NOT include pD2
    const decisions = handler.getParentDecisions()
    const ids = decisions.map((d) => d.id)
    expect(ids).toContain(pD1)
    expect(ids).not.toContain(pD2) // eagerly loaded at construction, pD2 not yet present
  })
})

// ---------------------------------------------------------------------------
// 3. Full Amendment Pipeline → Delta Document → Validation Integration
// ---------------------------------------------------------------------------

describe('Full Amendment Pipeline: amendment run → delta doc → validation', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('generated delta document from a real DB run passes validateDeltaDocument()', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    const pD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'MySQL',
      rationale: 'Legacy system compatibility',
    })
    insertDecision(db, pD2, parentRunId, {
      phase: 'planning',
      category: 'scope',
      key: 'timeline',
      value: 'Q3 2026',
    })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, {
      id: amendmentRunId,
      parentRunId,
      methodology: 'bmad',
      configJson: JSON.stringify({ concept: 'Migrate to PostgreSQL' }),
    })

    const aD1 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'PostgreSQL',
      rationale: 'Better JSON support and performance',
    })

    const handler = createAmendmentContextHandler(db, parentRunId, {
      framingConcept: 'Migrate to PostgreSQL',
    })
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const parentDecisions = handler.getParentDecisions()
    const supersessionLog = handler.getSupersessionLog()
    const supersededDecisionIds = new Set(supersessionLog.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions,
      framingConcept: 'Migrate to PostgreSQL',
      runImpactAnalysis: false,
    })

    // Delta document must pass validation
    const validation = validateDeltaDocument(doc)
    expect(validation.valid).toBe(true)
    expect(validation.errors).toHaveLength(0)

    // Executive summary must have >= 20 words
    expect(doc.executiveSummary.wordCount).toBeGreaterThanOrEqual(20)
    expect(doc.executiveSummary.text).toContain(amendmentRunId)
    expect(doc.executiveSummary.text).toContain(parentRunId)
    expect(doc.executiveSummary.text).toContain('Migrate to PostgreSQL')
  })

  it('delta document recommendations reflect actual delta data from DB', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'old-value' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    const aD1 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'new-value' })

    const handler = createAmendmentContextHandler(db, parentRunId)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const parentDecisions = handler.getParentDecisions()
    const supersessionLog = handler.getSupersessionLog()
    const supersededDecisionIds = new Set(supersessionLog.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions,
      runImpactAnalysis: false,
    })

    // With 1 superseded and 1 new decision, recommendations should mention both
    const recs = doc.recommendations.join('\n')
    expect(recs.length).toBeGreaterThan(0)
    // Should have a recommendation about superseded decisions
    expect(recs).toContain('superseded')
    // Should have a recommendation about new decisions
    expect(recs).toContain('new decision')
  })
})

// ---------------------------------------------------------------------------
// 4. formatDeltaDocument Output Validity Integration
// ---------------------------------------------------------------------------

describe('formatDeltaDocument: Markdown output is well-formed with real DB data', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('formatted delta document has all required Markdown sections with real DB decisions', async () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'SQLite',
      rationale: 'Simple embedded DB',
    })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    const aD1 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'PostgreSQL',
      rationale: 'Production scale',
    })

    const handler = createAmendmentContextHandler(db, parentRunId, { framingConcept: 'Scale up' })
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const parentDecisions = handler.getParentDecisions()
    const supersessionLog = handler.getSupersessionLog()
    const supersededDecisionIds = new Set(supersessionLog.map((s) => s.originalDecisionId))
    const supersededDecisions = parentDecisions.filter((d) => supersededDecisionIds.has(d.id))
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions,
      newStories: ['stories/12-9.md', 'stories/12-10.md'],
      framingConcept: 'Scale up',
      runImpactAnalysis: false,
    })

    const markdown = formatDeltaDocument(doc)

    // Required headings
    expect(markdown).toContain('# Amendment Delta Report')
    expect(markdown).toContain('## Executive Summary')
    expect(markdown).toContain('## New Decisions')
    expect(markdown).toContain('## Superseded Decisions')
    expect(markdown).toContain('## New Stories')
    expect(markdown).toContain('## Impact Analysis')
    expect(markdown).toContain('## Recommendations')

    // Metadata in header
    expect(markdown).toContain(amendmentRunId)
    expect(markdown).toContain(parentRunId)

    // New stories listed
    expect(markdown).toContain('stories/12-9.md')
    expect(markdown).toContain('stories/12-10.md')

    // New decisions table with actual data
    expect(markdown).toContain('PostgreSQL')

    // Superseded decisions table
    expect(markdown).toContain('SQLite')

    // Document is non-trivially large
    expect(markdown.length).toBeGreaterThan(500)
  })

  it('formatted document has stable structure regardless of decision count', async () => {
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    // No decisions — empty parent run

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })
    // No amendment decisions either

    const handler = createAmendmentContextHandler(db, parentRunId)
    const parentDecisions = handler.getParentDecisions()
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions: [],
      runImpactAnalysis: false,
    })

    const markdown = formatDeltaDocument(doc)

    // All sections still present even when empty
    expect(markdown).toContain('# Amendment Delta Report')
    expect(markdown).toContain('## Executive Summary')
    expect(markdown).toContain('No new decisions were made in this amendment run.')
    expect(markdown).toContain('No parent decisions were superseded in this amendment run.')
    expect(markdown).toContain('No new stories were created in this amendment run.')
    expect(markdown).toContain('No impact analysis findings available.')

    // Document still validates
    const validation = validateDeltaDocument(doc)
    expect(validation.valid).toBe(true)
  })

  it('formatted document correctly groups impact findings by confidence level', async () => {
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    const aD1 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'k', value: 'v' })

    const parentDecisions: Parameters<typeof generateDeltaDocument>[0]['parentDecisions'] = []
    const amendmentDecisions = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })

    // Mock dispatch that returns known impact findings
    const mockDispatch = async (_prompt: string): Promise<string> => {
      return JSON.stringify([
        { confidence: 'HIGH', area: 'Architecture', description: 'Critical change', relatedDecisionIds: [aD1] },
        { confidence: 'LOW', area: 'Performance', description: 'Minor impact', relatedDecisionIds: [] },
        { confidence: 'MEDIUM', area: 'API Surface', description: 'May affect clients', relatedDecisionIds: [aD1] },
      ])
    }

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions,
      amendmentDecisions,
      supersededDecisions: [],
      runImpactAnalysis: true,
    }, mockDispatch)

    const markdown = formatDeltaDocument(doc)

    expect(markdown).toContain('### HIGH Confidence')
    expect(markdown).toContain('### MEDIUM Confidence')
    expect(markdown).toContain('### LOW Confidence')
    expect(markdown).toContain('Critical change')
    expect(markdown).toContain('May affect clients')
    expect(markdown).toContain('Minor impact')
  })
})

// ---------------------------------------------------------------------------
// 5. runPostPhaseSupersessionDetection Integration with Real DB
// ---------------------------------------------------------------------------

describe('runPostPhaseSupersessionDetection: real DB + handler state integration', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('correctly identifies matching decisions by phase + category + key tuple', () => {
    const parentRunId = randomUUID()
    const pMatchD = randomUUID() // matches by phase/category/key
    const pNoMatchD = randomUUID() // different key — should not supersede
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pMatchD, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'MySQL' })
    insertDecision(db, pNoMatchD, parentRunId, { phase: 'analysis', category: 'arch', key: 'cache', value: 'Redis' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    // Amendment decision matches pMatchD by phase/category/key
    const aMatchD = randomUUID()
    insertDecision(db, aMatchD, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'PostgreSQL' })

    const handler = createAmendmentContextHandler(db, parentRunId)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(1) // Only pMatchD was superseded
    expect(log[0].originalDecisionId).toBe(pMatchD)
    expect(log[0].supersedingDecisionId).toBe(aMatchD)

    // pNoMatchD should NOT be superseded
    const pNoMatchRow = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(pNoMatchD) as { superseded_by: string | null }
    expect(pNoMatchRow.superseded_by).toBeNull()
  })

  it('only processes decisions from the specified phase — cross-phase decisions are not superseded', () => {
    const parentRunId = randomUUID()
    const pAnalysisD = randomUUID()
    const pPlanningD = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pAnalysisD, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'MySQL' })
    insertDecision(db, pPlanningD, parentRunId, { phase: 'planning', category: 'arch', key: 'db', value: 'MySQL' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    // Amendment has an analysis decision with matching key
    const aD = randomUUID()
    insertDecision(db, aD, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'PostgreSQL' })

    const handler = createAmendmentContextHandler(db, parentRunId)

    // Run supersession detection ONLY for 'analysis' phase
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(1) // Only analysis-phase decision superseded

    // Planning decision should NOT be superseded
    const pPlanningRow = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(pPlanningD) as { superseded_by: string | null }
    expect(pPlanningRow.superseded_by).toBeNull()
  })

  it('errors in individual supersedeDecision() calls do not halt the detection loop', () => {
    const parentRunId = randomUUID()
    const pD1 = randomUUID()
    const pD2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pD1, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'MySQL' })
    insertDecision(db, pD2, parentRunId, { phase: 'analysis', category: 'stack', key: 'lang', value: 'JS' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    // Amendment decisions that supersede both parent decisions
    const aD1 = randomUUID()
    const aD2 = randomUUID()
    insertDecision(db, aD1, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'PostgreSQL' })
    insertDecision(db, aD2, amendmentRunId, { phase: 'analysis', category: 'stack', key: 'lang', value: 'TS' })

    // Pre-supersede pD1 to trigger an error on the second call to supersedeDecision for pD1
    supersedeDecision(db, pD1, aD1)

    const handler = createAmendmentContextHandler(db, parentRunId)

    // This should NOT throw even though pD1 is already superseded
    expect(() => runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)).not.toThrow()

    // pD2 should still have been superseded despite the error for pD1
    const pD2Row = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(pD2) as { superseded_by: string | null }
    expect(pD2Row.superseded_by).toBe(aD2)
  })

  it('returns void and handler state updates correctly across multiple phase calls', () => {
    const parentRunId = randomUUID()
    const pA = randomUUID() // analysis
    const pB = randomUUID() // planning
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, pA, parentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'MySQL' })
    insertDecision(db, pB, parentRunId, { phase: 'planning', category: 'scope', key: 'deadline', value: 'Q1' })

    const amendmentRunId = randomUUID()
    createAmendmentRun(db, { id: amendmentRunId, parentRunId, methodology: 'bmad' })

    const aA = randomUUID()
    const aB = randomUUID()
    insertDecision(db, aA, amendmentRunId, { phase: 'analysis', category: 'arch', key: 'db', value: 'PostgreSQL' })
    insertDecision(db, aB, amendmentRunId, { phase: 'planning', category: 'scope', key: 'deadline', value: 'Q2' })

    const handler = createAmendmentContextHandler(db, parentRunId)

    const result1 = runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)
    expect(result1).toBeUndefined()
    expect(handler.getSupersessionLog()).toHaveLength(1)

    const result2 = runPostPhaseSupersessionDetection(db, amendmentRunId, 'planning', handler)
    expect(result2).toBeUndefined()
    expect(handler.getSupersessionLog()).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// 6. Executive Summary Word Count Boundary Integration
// ---------------------------------------------------------------------------

describe('Executive Summary word count validation with real amendment run IDs', () => {
  it('auto-generated summary always has >= 20 words for typical inputs', async () => {
    // Use real UUIDs to simulate actual amendment run IDs (they are long strings)
    const amendmentRunId = randomUUID()
    const parentRunId = randomUUID()

    const doc = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions: [],
      amendmentDecisions: [],
      supersededDecisions: [],
      runImpactAnalysis: false,
    })

    // With UUIDs as IDs, the summary text should have >= 20 words
    expect(doc.executiveSummary.wordCount).toBeGreaterThanOrEqual(20)
    const validation = validateDeltaDocument(doc)
    expect(validation.valid).toBe(true)
  })

  it('auto-generated summary with framingConcept has even more words', async () => {
    const amendmentRunId = randomUUID()
    const parentRunId = randomUUID()

    const docWithConcept = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions: [],
      amendmentDecisions: [],
      supersededDecisions: [],
      framingConcept: 'Add multi-tenant support for enterprise customers',
      runImpactAnalysis: false,
    })

    const docWithoutConcept = await generateDeltaDocument({
      amendmentRunId,
      parentRunId,
      parentDecisions: [],
      amendmentDecisions: [],
      supersededDecisions: [],
      runImpactAnalysis: false,
    })

    // With concept, summary should have more words
    expect(docWithConcept.executiveSummary.wordCount).toBeGreaterThan(
      docWithoutConcept.executiveSummary.wordCount,
    )
    // Both should pass validation
    expect(validateDeltaDocument(docWithConcept).valid).toBe(true)
    expect(validateDeltaDocument(docWithoutConcept).valid).toBe(true)
  })
})
