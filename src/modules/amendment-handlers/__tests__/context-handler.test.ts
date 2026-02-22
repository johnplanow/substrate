/**
 * Unit tests for the AmendmentContextHandler module.
 *
 * All database calls are mocked — no real SQLite database is needed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database } from 'better-sqlite3'

// Mock the amendments query module before importing the handler
vi.mock('../../../persistence/queries/amendments.js', () => ({
  loadParentRunDecisions: vi.fn(),
}))

import { loadParentRunDecisions } from '../../../persistence/queries/amendments.js'
import {
  createAmendmentContextHandler,
  type AmendmentPhaseRunOptions,
  type SupersessionLogEntry,
  type AmendmentContextHandler,
} from '../index.js'
import type { Decision } from '../../../persistence/schemas/decisions.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PARENT_RUN_ID = 'parent-run-uuid-1234'

function makeDecision(overrides: Partial<Decision>): Decision {
  return {
    id: 'decision-uuid-0001',
    pipeline_run_id: PARENT_RUN_ID,
    phase: 'analysis',
    category: 'scope',
    key: 'target_users',
    value: 'enterprise customers',
    rationale: 'Based on market research',
    superseded_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const ANALYSIS_DECISION_1 = makeDecision({
  id: 'dec-analysis-1',
  phase: 'analysis',
  category: 'scope',
  key: 'target_users',
  value: 'enterprise customers',
  rationale: 'Based on market research',
})

const ANALYSIS_DECISION_2 = makeDecision({
  id: 'dec-analysis-2',
  phase: 'analysis',
  category: 'constraints',
  key: 'timeline',
  value: 'Q3 2026',
  rationale: 'Board deadline',
})

const PLANNING_DECISION_1 = makeDecision({
  id: 'dec-planning-1',
  phase: 'planning',
  category: 'architecture',
  key: 'storage',
  value: 'SQLite',
  rationale: 'Embedded DB for local runs',
})

const SOLUTIONING_DECISION_1 = makeDecision({
  id: 'dec-solutioning-1',
  phase: 'solutioning',
  category: 'api',
  key: 'auth_method',
  value: 'JWT',
  rationale: null,
})

const ALL_DECISIONS = [
  ANALYSIS_DECISION_1,
  ANALYSIS_DECISION_2,
  PLANNING_DECISION_1,
  SOLUTIONING_DECISION_1,
]

// Mock DB — never used directly (mocked at module level)
const mockDb = {} as Database

const mockLoadParentRunDecisions = vi.mocked(loadParentRunDecisions)

// ---------------------------------------------------------------------------
// Helper: reset mocks
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks()
  mockLoadParentRunDecisions.mockReturnValue(ALL_DECISIONS)
})

// ---------------------------------------------------------------------------
// AC1: createAmendmentContextHandler() Factory Returns Handler
// ---------------------------------------------------------------------------

describe('createAmendmentContextHandler()', () => {
  it('returns an object with all 4 required methods', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    expect(handler).toHaveProperty('loadContextForPhase')
    expect(handler).toHaveProperty('logSupersession')
    expect(handler).toHaveProperty('getSupersessionLog')
    expect(handler).toHaveProperty('getParentDecisions')

    expect(typeof handler.loadContextForPhase).toBe('function')
    expect(typeof handler.logSupersession).toBe('function')
    expect(typeof handler.getSupersessionLog).toBe('function')
    expect(typeof handler.getParentDecisions).toBe('function')
  })

  it('calls loadParentRunDecisions eagerly at construction time', () => {
    createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    expect(mockLoadParentRunDecisions).toHaveBeenCalledTimes(1)
    expect(mockLoadParentRunDecisions).toHaveBeenCalledWith(mockDb, PARENT_RUN_ID)
  })

  it('does not call loadParentRunDecisions again when handler methods are called', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    handler.loadContextForPhase('analysis')
    handler.getParentDecisions()
    handler.getSupersessionLog()

    // Still only called once at construction
    expect(mockLoadParentRunDecisions).toHaveBeenCalledTimes(1)
  })

  it('propagates errors thrown by loadParentRunDecisions', () => {
    mockLoadParentRunDecisions.mockImplementation(() => {
      throw new Error('Parent run not found: nonexistent-id')
    })

    expect(() => createAmendmentContextHandler(mockDb, 'nonexistent-id')).toThrow(
      'Parent run not found: nonexistent-id',
    )
  })

  it('accepts options parameter without error', () => {
    const options: Partial<AmendmentPhaseRunOptions> = {
      framingConcept: 'Add dark mode support',
      phaseFilter: ['analysis', 'planning'],
    }
    expect(() => createAmendmentContextHandler(mockDb, PARENT_RUN_ID, options)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// AC2: loadContextForPhase() Injects Parent Decisions with Framing Text
// ---------------------------------------------------------------------------

describe('loadContextForPhase()', () => {
  it('returns a string containing the amendment context framing header', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const context = handler.loadContextForPhase('analysis')

    expect(typeof context).toBe('string')
    expect(context).toContain('=== AMENDMENT CONTEXT ===')
    expect(context).toContain('This is an amendment run.')
  })

  it('returns a string containing the framing footer', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const context = handler.loadContextForPhase('analysis')

    expect(context).toContain('=== END AMENDMENT CONTEXT ===')
    expect(context).toContain('When generating new decisions, explicitly note')
  })

  it('includes decisions filtered to the specified phase', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const context = handler.loadContextForPhase('analysis')

    expect(context).toContain('scope/target_users: enterprise customers')
    expect(context).toContain('constraints/timeline: Q3 2026')
  })

  it('does NOT include decisions from other phases', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const context = handler.loadContextForPhase('analysis')

    // Planning and solutioning decisions should not appear
    expect(context).not.toContain('architecture/storage: SQLite')
    expect(context).not.toContain('api/auth_method: JWT')
  })

  it('includes rationale when present', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const context = handler.loadContextForPhase('analysis')

    expect(context).toContain('Rationale: Based on market research')
    expect(context).toContain('Rationale: Board deadline')
  })

  it('includes phase label in the output', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const context = handler.loadContextForPhase('planning')

    expect(context).toContain('[Phase: planning]')
  })

  it('includes the concept statement when framingConcept is provided', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID, {
      framingConcept: 'Add dark mode support',
    })
    const context = handler.loadContextForPhase('analysis')

    expect(context).toContain('Concept being explored: Add dark mode support')
  })

  it('does NOT include concept statement when framingConcept is not provided', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const context = handler.loadContextForPhase('analysis')

    expect(context).not.toContain('Concept being explored:')
  })

  it('returns graceful framing message when no decisions exist for the phase', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    // 'implementation' phase has no decisions in ALL_DECISIONS
    const context = handler.loadContextForPhase('implementation')

    expect(context).toContain('[Phase: implementation]')
    expect(context).toContain('No prior decisions recorded for this phase')
    // Should still have the framing header and footer
    expect(context).toContain('=== AMENDMENT CONTEXT ===')
    expect(context).toContain('=== END AMENDMENT CONTEXT ===')
  })

  it('each phase call is independent and does not affect others', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    const analysisContext = handler.loadContextForPhase('analysis')
    const planningContext = handler.loadContextForPhase('planning')

    expect(analysisContext).toContain('scope/target_users')
    expect(planningContext).toContain('architecture/storage')
    expect(analysisContext).not.toContain('architecture/storage')
    expect(planningContext).not.toContain('scope/target_users')
  })
})

// ---------------------------------------------------------------------------
// AC2 + phaseFilter option
// ---------------------------------------------------------------------------

describe('loadContextForPhase() with phaseFilter option', () => {
  it('limits available decisions to the filtered phases', () => {
    mockLoadParentRunDecisions.mockReturnValue(ALL_DECISIONS)

    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID, {
      phaseFilter: ['analysis'],
    })

    // Planning decisions should not be available even when asked for
    const planningContext = handler.loadContextForPhase('planning')
    expect(planningContext).toContain('No prior decisions recorded for this phase')
  })

  it('does not filter when phaseFilter is empty array', () => {
    mockLoadParentRunDecisions.mockReturnValue(ALL_DECISIONS)

    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID, {
      phaseFilter: [],
    })

    // All decisions should be available
    const planningContext = handler.loadContextForPhase('planning')
    expect(planningContext).toContain('architecture/storage: SQLite')
  })
})

// ---------------------------------------------------------------------------
// AC3: logSupersession() Accumulates In-Memory Events
// ---------------------------------------------------------------------------

describe('logSupersession()', () => {
  function makeEntry(n: number): SupersessionLogEntry {
    return {
      originalDecisionId: `orig-${n}`,
      supersedingDecisionId: `new-${n}`,
      phase: 'analysis',
      key: `key-${n}`,
      reason: `Reason ${n}`,
      loggedAt: `2026-01-0${n}T00:00:00Z`,
    }
  }

  it('accumulates entries in insertion order', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    handler.logSupersession(makeEntry(1))
    handler.logSupersession(makeEntry(2))
    handler.logSupersession(makeEntry(3))

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(3)
    expect(log[0].originalDecisionId).toBe('orig-1')
    expect(log[1].originalDecisionId).toBe('orig-2')
    expect(log[2].originalDecisionId).toBe('orig-3')
  })

  it('starts with an empty log before any logSupersession calls', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    expect(handler.getSupersessionLog()).toHaveLength(0)
  })

  it('accumulates exactly N entries after N calls', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    handler.logSupersession(makeEntry(1))
    expect(handler.getSupersessionLog()).toHaveLength(1)

    handler.logSupersession(makeEntry(2))
    expect(handler.getSupersessionLog()).toHaveLength(2)

    handler.logSupersession(makeEntry(3))
    expect(handler.getSupersessionLog()).toHaveLength(3)
  })

  it('preserves all fields of each SupersessionLogEntry', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const entry: SupersessionLogEntry = {
      originalDecisionId: 'old-dec-uuid',
      supersedingDecisionId: 'new-dec-uuid',
      phase: 'planning',
      key: 'storage',
      reason: 'New architecture decision replaces old one',
      loggedAt: '2026-02-22T12:00:00Z',
    }

    handler.logSupersession(entry)
    const log = handler.getSupersessionLog()

    expect(log[0]).toEqual(entry)
  })
})

// ---------------------------------------------------------------------------
// AC4: getSupersessionLog() Returns Defensive Copy
// ---------------------------------------------------------------------------

describe('getSupersessionLog()', () => {
  it('returns an empty array when no supersessions have been logged', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const log = handler.getSupersessionLog()

    expect(Array.isArray(log)).toBe(true)
    expect(log).toHaveLength(0)
  })

  it('returns a defensive copy — mutations do not affect the internal log', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    handler.logSupersession({
      originalDecisionId: 'orig-1',
      supersedingDecisionId: 'new-1',
      phase: 'analysis',
      key: 'target_users',
      reason: 'Test',
      loggedAt: '2026-01-01T00:00:00Z',
    })

    const log1 = handler.getSupersessionLog()
    expect(log1).toHaveLength(1)

    // Mutate the returned array
    log1.pop()
    expect(log1).toHaveLength(0)

    // Internal log should still have the entry
    const log2 = handler.getSupersessionLog()
    expect(log2).toHaveLength(1)
  })

  it('accumulates entries across multiple phase invocations (AC6)', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    // Simulate different phases logging supersessions
    handler.logSupersession({
      originalDecisionId: 'orig-analysis',
      supersedingDecisionId: 'new-analysis',
      phase: 'analysis',
      key: 'target_users',
      reason: 'Refined scope',
      loggedAt: '2026-01-01T01:00:00Z',
    })
    handler.logSupersession({
      originalDecisionId: 'orig-planning',
      supersedingDecisionId: 'new-planning',
      phase: 'planning',
      key: 'storage',
      reason: 'Architecture changed',
      loggedAt: '2026-01-01T02:00:00Z',
    })
    handler.logSupersession({
      originalDecisionId: 'orig-solutioning',
      supersedingDecisionId: 'new-solutioning',
      phase: 'solutioning',
      key: 'auth_method',
      reason: 'API design pivot',
      loggedAt: '2026-01-01T03:00:00Z',
    })

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(3)
    expect(log.map((e) => e.phase)).toEqual(['analysis', 'planning', 'solutioning'])
  })
})

// ---------------------------------------------------------------------------
// AC5: getParentDecisions() Returns Loaded Decisions
// ---------------------------------------------------------------------------

describe('getParentDecisions()', () => {
  it('returns all decisions loaded at construction time', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const decisions = handler.getParentDecisions()

    expect(decisions).toHaveLength(ALL_DECISIONS.length)
    expect(decisions).toEqual(ALL_DECISIONS)
  })

  it('returns empty array when parent run has zero active decisions', () => {
    mockLoadParentRunDecisions.mockReturnValue([])

    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    const decisions = handler.getParentDecisions()

    expect(Array.isArray(decisions)).toBe(true)
    expect(decisions).toHaveLength(0)
  })

  it('does not re-query the database on subsequent calls', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    handler.getParentDecisions()
    handler.getParentDecisions()
    handler.getParentDecisions()

    // Should have been called only once at construction
    expect(mockLoadParentRunDecisions).toHaveBeenCalledTimes(1)
  })

  it('returns decisions filtered by phaseFilter when provided', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID, {
      phaseFilter: ['analysis'],
    })

    const decisions = handler.getParentDecisions()
    expect(decisions.every((d) => d.phase === 'analysis')).toBe(true)
    expect(decisions).toHaveLength(2) // ANALYSIS_DECISION_1 and ANALYSIS_DECISION_2
  })
})

// ---------------------------------------------------------------------------
// AC6: Handler Usable by All 4 Pipeline Phases
// ---------------------------------------------------------------------------

describe('Handler usability across all pipeline phases', () => {
  it('each phase can call loadContextForPhase() independently', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    const phases = ['analysis', 'planning', 'solutioning', 'implementation'] as const

    for (const phase of phases) {
      const context = handler.loadContextForPhase(phase)
      expect(typeof context).toBe('string')
      expect(context.length).toBeGreaterThan(0)
      expect(context).toContain('=== AMENDMENT CONTEXT ===')
    }
  })

  it('shared handler accumulates supersession log across all phases', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    const phases = ['analysis', 'planning', 'solutioning', 'implementation'] as const

    for (const phase of phases) {
      handler.logSupersession({
        originalDecisionId: `orig-${phase}`,
        supersedingDecisionId: `new-${phase}`,
        phase,
        key: `key-${phase}`,
        reason: `Phase ${phase} change`,
        loggedAt: '2026-02-22T00:00:00Z',
      })
    }

    const log = handler.getSupersessionLog()
    expect(log).toHaveLength(4)
  })
})

// ---------------------------------------------------------------------------
// AC7: Exported Types Match Story Scope
// ---------------------------------------------------------------------------

describe('Exported types', () => {
  it('AmendmentPhaseRunOptions can be constructed with all fields', () => {
    const opts: AmendmentPhaseRunOptions = {
      parentRunId: 'run-123',
      phaseFilter: ['analysis', 'planning'],
      framingConcept: 'Dark mode',
    }
    expect(opts.parentRunId).toBe('run-123')
    expect(opts.phaseFilter).toHaveLength(2)
    expect(opts.framingConcept).toBe('Dark mode')
  })

  it('SupersessionLogEntry can be constructed with all fields', () => {
    const entry: SupersessionLogEntry = {
      originalDecisionId: 'orig',
      supersedingDecisionId: 'new',
      phase: 'analysis',
      key: 'target_users',
      reason: 'Test reason',
      loggedAt: '2026-02-22T00:00:00Z',
    }
    expect(entry.originalDecisionId).toBe('orig')
  })

  it('AmendmentContextHandler is an interface (handler satisfies it)', () => {
    const handler: AmendmentContextHandler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    expect(handler).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// AC8: No Direct Database Writes
// ---------------------------------------------------------------------------

describe('No direct database writes', () => {
  it('loadContextForPhase() does not call any DB method', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)
    // If this doesn't throw when mockDb has no write methods, we're good
    expect(() => handler.loadContextForPhase('analysis')).not.toThrow()
    // loadParentRunDecisions was called only once at construction
    expect(mockLoadParentRunDecisions).toHaveBeenCalledTimes(1)
  })

  it('logSupersession() does not interact with the database', () => {
    const handler = createAmendmentContextHandler(mockDb, PARENT_RUN_ID)

    expect(() =>
      handler.logSupersession({
        originalDecisionId: 'orig',
        supersedingDecisionId: 'new',
        phase: 'analysis',
        key: 'target_users',
        reason: 'test',
        loggedAt: '2026-01-01T00:00:00Z',
      }),
    ).not.toThrow()

    // DB should have been touched only at construction
    expect(mockLoadParentRunDecisions).toHaveBeenCalledTimes(1)
  })
})
