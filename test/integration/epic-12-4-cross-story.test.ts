/**
 * Epic 12.4 — Per-Phase Amendment Handlers
 * Cross-Story Integration Tests
 *
 * Identifies and covers integration gaps between:
 *   - Story 12-8: AmendmentContextHandler module
 *   - Story 12-11: Phase runner amendmentContext injection
 *   - Story 12-12: Amendment supersession writeback (runPostPhaseSupersessionDetection)
 *
 * All tests use real in-memory SQLite databases with migrations applied.
 * Phase runners are tested with real DB state; dispatcher is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
import {
  createDecision,
  createPipelineRun,
} from '../../src/persistence/queries/decisions.js'
import { createAmendmentContextHandler } from '../../src/modules/amendment-handlers/index.js'
import { runPostPhaseSupersessionDetection } from '../../src/cli/commands/auto.js'
import { runAnalysisPhase } from '../../src/modules/phase-orchestrator/phases/analysis.js'
import { runPlanningPhase } from '../../src/modules/phase-orchestrator/phases/planning.js'
import type { PhaseDeps, ProductBrief } from '../../src/modules/phase-orchestrator/phases/types.js'
import type { MethodologyPack } from '../../src/modules/methodology-pack/types.js'
import type { ContextCompiler } from '../../src/modules/context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../src/modules/agent-dispatch/types.js'

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

const SAMPLE_BRIEF: ProductBrief = {
  problem_statement: 'Users need task management.',
  target_users: ['developers'],
  core_features: ['task creation', 'assignment'],
  success_metrics: ['90% adoption'],
  constraints: ['GDPR compliant'],
}

function makeDispatchResult(
  parsed: unknown,
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: 'dispatch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 100, output: 50 },
    ...overrides,
  }
}

function makeDispatcher(result: DispatchResult<unknown>): Dispatcher {
  const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: result.id,
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(result),
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makePack(
  analysisTemplate = 'Analyze the concept: {{concept}}\nProvide product brief.',
  planningTemplate = 'Plan based on: {{product_brief}}\nProvide requirements.',
): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [],
      prompts: { analysis: 'prompts/analysis.md', planning: 'prompts/planning.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockImplementation((name: string) => {
      if (name === 'analysis') return Promise.resolve(analysisTemplate)
      if (name === 'planning') return Promise.resolve(planningTemplate)
      return Promise.resolve('')
    }),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({
      prompt: '',
      tokenCount: 0,
      sections: [],
      truncated: false,
    }),
  } as unknown as ContextCompiler
}

function makeDeps(
  db: BetterSqlite3Database,
  dispatcher: Dispatcher,
  pack?: MethodologyPack,
): PhaseDeps {
  return {
    db,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

// ---------------------------------------------------------------------------
// Gap 1: runPostPhaseSupersessionDetection cross-story integration
// (12-8 AmendmentContextHandler + 12-12 Supersession Writeback)
// No existing test covers this function with real DB state.
// ---------------------------------------------------------------------------

describe('Gap 1: runPostPhaseSupersessionDetection with real DB (12-8 + 12-12)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('supersedes parent decisions when amendment decisions share the same (phase, category, key)', () => {
    // Setup parent run with decisions
    const parentRunId = randomUUID()
    const parentDecId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Original problem statement',
    })

    // Setup amendment run with overlapping decision
    const amendmentRunId = randomUUID()
    const amendmentDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    insertDecision(db, amendmentDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Updated problem statement',
    })

    // Create handler and run supersession detection
    const handler = createAmendmentContextHandler(db, parentRunId)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    // Verify parent decision is now superseded in DB
    const parentRow = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(parentDecId) as { superseded_by: string | null }

    expect(parentRow.superseded_by).toBe(amendmentDecId)
  })

  it('logs supersession entry in handler in-memory log after detection', () => {
    const parentRunId = randomUUID()
    const parentDecId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'enterprise customers',
    })

    const amendmentRunId = randomUUID()
    const amendmentDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    insertDecision(db, amendmentDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'small businesses',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)
    expect(handler.getSupersessionLog()).toHaveLength(0)

    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(1)
    expect(log[0].originalDecisionId).toBe(parentDecId)
    expect(log[0].supersedingDecisionId).toBe(amendmentDecId)
    expect(log[0].phase).toBe('analysis')
    expect(log[0].key).toBe('target_users')
  })

  it('does not supersede when amendment decision is in a different phase', () => {
    const parentRunId = randomUUID()
    const parentDecId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'enterprise customers',
    })

    const amendmentRunId = randomUUID()
    const amendmentDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    // Insert a PLANNING decision (different phase)
    insertDecision(db, amendmentDecId, amendmentRunId, {
      phase: 'planning',
      category: 'scope',
      key: 'target_users',
      value: 'small businesses',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)
    // Run detection for analysis phase — should not match the planning amendment decision
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(0)

    const parentRow = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(parentDecId) as { superseded_by: string | null }
    expect(parentRow.superseded_by).toBeNull()
  })

  it('does not supersede when keys differ between parent and amendment decisions', () => {
    const parentRunId = randomUUID()
    const parentDecId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'database',
      value: 'MySQL',
    })

    const amendmentRunId = randomUUID()
    const amendmentDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    // Different key
    insertDecision(db, amendmentDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'architecture',
      key: 'cache',
      value: 'Redis',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(0)
  })

  it('supersedes multiple decisions in a single phase detection pass', () => {
    const parentRunId = randomUUID()
    const parentDecId1 = randomUUID()
    const parentDecId2 = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentDecId1, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'enterprise',
    })
    insertDecision(db, parentDecId2, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'timeline',
      value: 'Q3 2026',
    })

    const amendmentRunId = randomUUID()
    const amendDecId1 = randomUUID()
    const amendDecId2 = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    insertDecision(db, amendDecId1, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'small businesses',
    })
    insertDecision(db, amendDecId2, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'timeline',
      value: 'Q4 2026',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(2)

    const parentRow1 = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(parentDecId1) as { superseded_by: string | null }
    const parentRow2 = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(parentDecId2) as { superseded_by: string | null }
    expect(parentRow1.superseded_by).toBe(amendDecId1)
    expect(parentRow2.superseded_by).toBe(amendDecId2)
  })

  it('does not include already-superseded decisions in parent snapshot loaded by handler', () => {
    // This tests that the handler snapshot (AC5 of 12-8) only contains non-superseded decisions,
    // so runPostPhaseSupersessionDetection can never attempt to re-supersede an already-superseded decision.
    const parentRunId = randomUUID()
    const parentDecId = randomUUID()
    const supersedingInParentId = randomUUID()
    insertRun(db, parentRunId, 'completed')

    // Insert a decision that gets superseded WITHIN the parent run
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'enterprise',
    })
    // The superseding decision has a different key to avoid collision with amendment decisions
    insertDecision(db, supersedingInParentId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users_v2',
      value: 'large enterprises',
    })
    // Pre-supersede parentDecId
    supersedeDecision(db, parentDecId, supersedingInParentId)

    // Handler is created AFTER the supersession — it should not load parentDecId
    const handler = createAmendmentContextHandler(db, parentRunId)
    const parentDecisions = handler.getParentDecisions()
    const parentDecIds = parentDecisions.map((d) => d.id)

    // Superseded decision should not be in the handler snapshot
    expect(parentDecIds).not.toContain(parentDecId)
    // The superseding decision within the parent run IS in the snapshot (it's active)
    expect(parentDecIds).toContain(supersedingInParentId)

    // Create amendment run with a decision that only matches the original superseded key
    const amendmentRunId = randomUUID()
    const amendDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    insertDecision(db, amendDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users', // This key is NOT in parentDecisions (parentDecId was superseded)
      value: 'small businesses',
    })

    // Running detection should not throw and should not match parentDecId (not in snapshot)
    expect(() => {
      runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)
    }).not.toThrow()

    // No match was found because parentDecId is not in the handler's parent decisions
    expect(handler.getSupersessionLog()).toHaveLength(0)
  })

  it('is idempotent across multiple calls for different phases', () => {
    const parentRunId = randomUUID()
    const analysisDecId = randomUUID()
    const planningDecId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, analysisDecId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'users',
      value: 'enterprise',
    })
    insertDecision(db, planningDecId, parentRunId, {
      phase: 'planning',
      category: 'arch',
      key: 'storage',
      value: 'SQLite',
    })

    const amendmentRunId = randomUUID()
    const amendAnalysisDecId = randomUUID()
    const amendPlanningDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    insertDecision(db, amendAnalysisDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'users',
      value: 'sme',
    })
    insertDecision(db, amendPlanningDecId, amendmentRunId, {
      phase: 'planning',
      category: 'arch',
      key: 'storage',
      value: 'PostgreSQL',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)

    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'planning', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(2)
    expect(log.map((e) => e.phase)).toContain('analysis')
    expect(log.map((e) => e.phase)).toContain('planning')
  })
})

// ---------------------------------------------------------------------------
// Gap 2: Amendment context injection into phase runners (12-8 + 12-11)
// Individual unit tests mock each other; this tests the actual data flow.
// ---------------------------------------------------------------------------

describe('Gap 2: Amendment context injection into runAnalysisPhase (12-8 + 12-11)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('analysis phase receives amendment context string when provided', async () => {
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, randomUUID(), parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'enterprise customers',
      rationale: 'Market research',
    })

    const handler = createAmendmentContextHandler(db, parentRunId, {
      framingConcept: 'Add Redis caching',
    })
    const amendmentContext = handler.loadContextForPhase('analysis')

    // Verify context is non-empty and contains expected content
    expect(amendmentContext).toContain('=== AMENDMENT CONTEXT ===')
    expect(amendmentContext).toContain('target_users')
    expect(amendmentContext).toContain('enterprise customers')
    expect(amendmentContext).toContain('Add Redis caching')

    // Create amendment run and execute analysis phase with amendment context
    const amendmentRunId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)

    const run = db
      .prepare('SELECT id FROM pipeline_runs WHERE id = ?')
      .get(amendmentRunId) as { id: string }
    expect(run).toBeDefined()

    // Capture what the dispatcher receives
    let capturedPrompt = ''
    const mockDispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
        capturedPrompt = prompt
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: 'dispatch-001',
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult({
            result: 'success',
            product_brief: SAMPLE_BRIEF,
          })),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps = makeDeps(db, mockDispatcher)
    const result = await runAnalysisPhase(deps, {
      runId: amendmentRunId,
      concept: 'Add Redis caching layer',
      amendmentContext,
    })

    expect(result.result).toBe('success')
    // The prompt should contain the amendment context framing
    expect(capturedPrompt).toContain('AMENDMENT CONTEXT')
    expect(capturedPrompt).toContain('target_users')
  })

  it('analysis phase without amendment context does not inject framing block', async () => {
    const runId = randomUUID()
    insertRun(db, runId, 'running')

    let capturedPrompt = ''
    const mockDispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
        capturedPrompt = prompt
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: 'dispatch-001',
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult({
            result: 'success',
            product_brief: SAMPLE_BRIEF,
          })),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps = makeDeps(db, mockDispatcher)
    const result = await runAnalysisPhase(deps, {
      runId,
      concept: 'Build task manager',
      // No amendmentContext
    })

    expect(result.result).toBe('success')
    expect(capturedPrompt).not.toContain('AMENDMENT CONTEXT')
  })

  it('analysis phase with empty string amendmentContext does not inject framing block', async () => {
    const runId = randomUUID()
    insertRun(db, runId, 'running')

    let capturedPrompt = ''
    const mockDispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
        capturedPrompt = prompt
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: 'dispatch-001',
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult({
            result: 'success',
            product_brief: SAMPLE_BRIEF,
          })),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps = makeDeps(db, mockDispatcher)
    const result = await runAnalysisPhase(deps, {
      runId,
      concept: 'Build task manager',
      amendmentContext: '', // explicit empty string
    })

    expect(result.result).toBe('success')
    expect(capturedPrompt).not.toContain('AMENDMENT CONTEXT')
  })
})

// ---------------------------------------------------------------------------
// Gap 3: Planning phase amendment context injection (12-8 + 12-11)
// ---------------------------------------------------------------------------

describe('Gap 3: Amendment context injection into runPlanningPhase (12-8 + 12-11)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('planning phase receives amendment context when provided', async () => {
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, randomUUID(), parentRunId, {
      phase: 'planning',
      category: 'arch',
      key: 'storage',
      value: 'SQLite',
    })

    const handler = createAmendmentContextHandler(db, parentRunId, {
      framingConcept: 'Migrate to PostgreSQL',
    })
    const amendmentContext = handler.loadContextForPhase('planning')
    expect(amendmentContext).toContain('storage')
    expect(amendmentContext).toContain('Migrate to PostgreSQL')

    // Create an amendment run with product-brief decisions to satisfy planning phase
    const amendmentRunId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)

    // Insert analysis decisions to satisfy planning phase requirement
    const briefFields = [
      { key: 'problem_statement', value: 'Need task manager' },
      { key: 'target_users', value: '["developers"]' },
      { key: 'core_features', value: '["tasks"]' },
      { key: 'success_metrics', value: '["50% adoption"]' },
      { key: 'constraints', value: '["GDPR"]' },
    ]
    for (const field of briefFields) {
      insertDecision(db, randomUUID(), amendmentRunId, {
        phase: 'analysis',
        category: 'product-brief',
        key: field.key,
        value: field.value,
      })
    }

    let capturedPrompt = ''
    const mockDispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
        capturedPrompt = prompt
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: 'dispatch-001',
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult({
            result: 'success',
            functional_requirements: [{ description: 'User can create tasks', priority: 'must' }],
            non_functional_requirements: [{ description: 'Fast response time', category: 'performance' }],
            user_stories: [{ title: 'Task creation', description: 'As a user, I want to create tasks' }],
            tech_stack: { language: 'TypeScript' },
            domain_model: { Task: { fields: ['id', 'title'] } },
            out_of_scope: [],
          })),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps = makeDeps(db, mockDispatcher)
    const result = await runPlanningPhase(deps, {
      runId: amendmentRunId,
      amendmentContext,
    })

    expect(result.result).toBe('success')
    expect(capturedPrompt).toContain('AMENDMENT CONTEXT')
    expect(capturedPrompt).toContain('Migrate to PostgreSQL')
  })

  it('planning phase without amendment context succeeds without framing block', async () => {
    const runId = randomUUID()
    insertRun(db, runId, 'running')

    // Insert analysis decisions to satisfy planning phase requirement
    const briefFields = [
      { key: 'problem_statement', value: 'Need task manager' },
      { key: 'target_users', value: '["developers"]' },
      { key: 'core_features', value: '["tasks"]' },
      { key: 'success_metrics', value: '["50% adoption"]' },
      { key: 'constraints', value: '["GDPR"]' },
    ]
    for (const field of briefFields) {
      insertDecision(db, randomUUID(), runId, {
        phase: 'analysis',
        category: 'product-brief',
        key: field.key,
        value: field.value,
      })
    }

    let capturedPrompt = ''
    const mockDispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(({ prompt }: { prompt: string }) => {
        capturedPrompt = prompt
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: 'dispatch-001',
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult({
            result: 'success',
            functional_requirements: [{ description: 'User can create tasks', priority: 'must' }],
            non_functional_requirements: [{ description: 'Fast', category: 'performance' }],
            user_stories: [{ title: 'Task creation', description: 'As a user...' }],
            tech_stack: { language: 'TypeScript' },
            domain_model: { Task: { fields: ['id'] } },
            out_of_scope: [],
          })),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps = makeDeps(db, mockDispatcher)
    const result = await runPlanningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(capturedPrompt).not.toContain('AMENDMENT CONTEXT')
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Full amendment pipeline flow (12-8 + 12-11 + 12-12 integrated)
// Analysis phase → supersession detection → decision store state
// ---------------------------------------------------------------------------

describe('Gap 4: Full amendment pipeline: analysis → supersession writeback → active decisions (12-8 + 12-11 + 12-12)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('after analysis phase + supersession detection: parent decisions are superseded, amendment decisions are active', async () => {
    // Step 1: Create a completed parent run with decisions
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    const parentDecId = randomUUID()
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'product-brief',
      key: 'problem_statement',
      value: 'Old problem statement',
    })

    // Step 2: Create amendment run
    const amendmentRunId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)

    // Step 3: Create handler and load context
    const handler = createAmendmentContextHandler(db, parentRunId, {
      framingConcept: 'New feature',
    })
    const amendmentContext = handler.loadContextForPhase('analysis')

    // Step 4: Run analysis phase with amendment context — mocked to return a success with overlapping key
    const mockDispatcher: Dispatcher = {
      dispatch: vi.fn().mockImplementation(() => {
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: 'dispatch-001',
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult({
            result: 'success',
            product_brief: SAMPLE_BRIEF,
          })),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps = makeDeps(db, mockDispatcher)
    const analysisResult = await runAnalysisPhase(deps, {
      runId: amendmentRunId,
      concept: 'New feature concept',
      amendmentContext,
    })

    expect(analysisResult.result).toBe('success')

    // Step 5: Run supersession detection — the analysis phase creates a new product-brief/problem_statement decision
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    // Step 6: Verify supersession state
    // The parent's problem_statement decision should now be superseded
    const parentRow = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(parentDecId) as { superseded_by: string | null }

    expect(parentRow.superseded_by).not.toBeNull()

    // Active decisions for parent run should NOT include the superseded one
    const activeParentDecisions = getActiveDecisions(db, { pipeline_run_id: parentRunId })
    const activeParentIds = activeParentDecisions.map((d) => d.id)
    expect(activeParentIds).not.toContain(parentDecId)

    // Active decisions for amendment run should include the new problem_statement
    const activeAmendDecisions = getActiveDecisions(db, {
      pipeline_run_id: amendmentRunId,
      phase: 'analysis',
      category: 'product-brief',
    })
    expect(activeAmendDecisions.length).toBeGreaterThan(0)
    const activeKeys = activeAmendDecisions.map((d) => d.key)
    expect(activeKeys).toContain('problem_statement')

    // Supersession log should have one entry
    const log = handler.getSupersessionLog()
    expect(log.length).toBeGreaterThan(0)
    const problemStatementEntry = log.find((e) => e.key === 'problem_statement')
    expect(problemStatementEntry).toBeDefined()
    expect(problemStatementEntry?.phase).toBe('analysis')
  })

  it('loadParentRunDecisions excludes decisions superseded by amendment writeback', () => {
    const parentRunId = randomUUID()
    const parentDecId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target',
      value: 'original',
    })

    const amendmentRunId = randomUUID()
    const amendDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    insertDecision(db, amendDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target',
      value: 'updated',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    // After supersession writeback, loadParentRunDecisions should exclude the superseded one
    const freshParentDecisions = loadParentRunDecisions(db, parentRunId)
    const freshIds = freshParentDecisions.map((d) => d.id)
    expect(freshIds).not.toContain(parentDecId)
    // But the amendment decision (in amendment run) should be accessible
    const amendActive = getActiveDecisions(db, { pipeline_run_id: amendmentRunId })
    expect(amendActive.map((d) => d.id)).toContain(amendDecId)
  })
})

// ---------------------------------------------------------------------------
// Gap 5: Amendment context handler context isolation across phases (12-8)
// Tests that context for one phase does not bleed into another phase's context.
// ---------------------------------------------------------------------------

describe('Gap 5: Phase context isolation in handler with real DB decisions (12-8)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('analysis context does not contain planning decisions, planning context does not contain analysis decisions', () => {
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')

    // Analysis decision
    insertDecision(db, randomUUID(), parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'enterprise customers',
    })

    // Planning decision
    insertDecision(db, randomUUID(), parentRunId, {
      phase: 'planning',
      category: 'arch',
      key: 'storage',
      value: 'SQLite',
    })

    // Solutioning decision
    insertDecision(db, randomUUID(), parentRunId, {
      phase: 'solutioning',
      category: 'api',
      key: 'auth',
      value: 'JWT',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)

    const analysisCtx = handler.loadContextForPhase('analysis')
    const planningCtx = handler.loadContextForPhase('planning')
    const solutioningCtx = handler.loadContextForPhase('solutioning')

    // Analysis context: only analysis decisions
    expect(analysisCtx).toContain('target_users')
    expect(analysisCtx).not.toContain('storage')
    expect(analysisCtx).not.toContain('auth')

    // Planning context: only planning decisions
    expect(planningCtx).toContain('storage')
    expect(planningCtx).not.toContain('target_users')
    expect(planningCtx).not.toContain('auth')

    // Solutioning context: only solutioning decisions
    expect(solutioningCtx).toContain('auth')
    expect(solutioningCtx).not.toContain('target_users')
    expect(solutioningCtx).not.toContain('storage')
  })

  it('phaseFilter limits available decisions across all loadContextForPhase calls', () => {
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')

    insertDecision(db, randomUUID(), parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target_users',
      value: 'enterprise',
    })
    insertDecision(db, randomUUID(), parentRunId, {
      phase: 'planning',
      category: 'arch',
      key: 'storage',
      value: 'SQLite',
    })

    // Create handler filtered to analysis only
    const handler = createAmendmentContextHandler(db, parentRunId, {
      phaseFilter: ['analysis'],
    })

    // Even when requesting planning context, no planning decisions should appear (they were filtered at construction)
    const planningCtx = handler.loadContextForPhase('planning')
    expect(planningCtx).toContain('No prior decisions recorded for this phase')
    expect(planningCtx).not.toContain('storage')

    // Analysis context should have the analysis decision
    const analysisCtx = handler.loadContextForPhase('analysis')
    expect(analysisCtx).toContain('target_users')
  })
})

// ---------------------------------------------------------------------------
// Gap 6: Supersession detection + handler getParentDecisions consistency (12-8 + 12-12)
// Handler is created BEFORE amendment run decisions exist.
// This tests the handler's snapshot behavior vs. the live DB state after detection.
// ---------------------------------------------------------------------------

describe('Gap 6: Handler snapshot vs. live DB state consistency (12-8 + 12-12)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openMigratedDb()
  })

  afterEach(() => {
    db.close()
  })

  it('handler getParentDecisions reflects decisions at creation time, not after supersession', () => {
    const parentRunId = randomUUID()
    const parentDecId = randomUUID()
    insertRun(db, parentRunId, 'completed')
    insertDecision(db, parentDecId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target',
      value: 'original',
    })

    // Create handler (eager load at construction time)
    const handler = createAmendmentContextHandler(db, parentRunId)

    // Before supersession: handler has the decision
    expect(handler.getParentDecisions().map((d) => d.id)).toContain(parentDecId)

    // Now create an amendment decision and supersede the parent decision
    const amendmentRunId = randomUUID()
    const amendDecId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)
    insertDecision(db, amendDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'target',
      value: 'updated',
    })
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)

    // After supersession: handler STILL returns the snapshot (not re-queried)
    // This is the documented behavior (AC5 of 12-8: cached at construction time)
    const decisionsAfter = handler.getParentDecisions()
    expect(decisionsAfter.map((d) => d.id)).toContain(parentDecId)

    // But the DB reflects the new state (superseded_by is set)
    const dbRow = db
      .prepare('SELECT superseded_by FROM decisions WHERE id = ?')
      .get(parentDecId) as { superseded_by: string | null }
    expect(dbRow.superseded_by).toBe(amendDecId)

    // The in-memory supersession log DOES reflect the supersession
    const log = handler.getSupersessionLog()
    expect(log.map((e) => e.originalDecisionId)).toContain(parentDecId)
  })

  it('supersession log accurately tracks all supersessions across multiple detection calls', () => {
    const parentRunId = randomUUID()
    insertRun(db, parentRunId, 'completed')

    const parentAnalysisDecId = randomUUID()
    const parentPlanningDecId = randomUUID()
    insertDecision(db, parentAnalysisDecId, parentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'users',
      value: 'enterprise',
    })
    insertDecision(db, parentPlanningDecId, parentRunId, {
      phase: 'planning',
      category: 'arch',
      key: 'db',
      value: 'SQLite',
    })

    const amendmentRunId = randomUUID()
    insertRun(db, amendmentRunId, 'running', parentRunId)

    const amendAnalysisDecId = randomUUID()
    const amendPlanningDecId = randomUUID()
    insertDecision(db, amendAnalysisDecId, amendmentRunId, {
      phase: 'analysis',
      category: 'scope',
      key: 'users',
      value: 'SME',
    })
    insertDecision(db, amendPlanningDecId, amendmentRunId, {
      phase: 'planning',
      category: 'arch',
      key: 'db',
      value: 'PostgreSQL',
    })

    const handler = createAmendmentContextHandler(db, parentRunId)

    // Simulate the amendment phase loop running supersession for each phase
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'analysis', handler)
    runPostPhaseSupersessionDetection(db, amendmentRunId, 'planning', handler)

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(2)

    const analysisEntry = log.find((e) => e.phase === 'analysis')
    const planningEntry = log.find((e) => e.phase === 'planning')

    expect(analysisEntry).toBeDefined()
    expect(analysisEntry?.originalDecisionId).toBe(parentAnalysisDecId)
    expect(analysisEntry?.supersedingDecisionId).toBe(amendAnalysisDecId)

    expect(planningEntry).toBeDefined()
    expect(planningEntry?.originalDecisionId).toBe(parentPlanningDecId)
    expect(planningEntry?.supersedingDecisionId).toBe(amendPlanningDecId)
  })
})
