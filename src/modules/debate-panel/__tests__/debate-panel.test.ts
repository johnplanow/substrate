/**
 * Unit tests for the Debate Panel module.
 *
 * Tests DebatePanelImpl for all tiers (routine, significant, architectural)
 * including tie-break logic, escalation, and decision persistence (AC7).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { DebatePanelImpl, createDebatePanel } from '../debate-panel-impl.js'
import type { PerspectiveGeneratorFn } from '../debate-panel-impl.js'
import type { Perspective, DecisionRequest } from '../types.js'
import type { Dispatcher } from '../../agent-dispatch/types.js'
import { runMigrations } from '../../../persistence/migrations/index.js'

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/** Create a stub Dispatcher (not used when perspectiveGenerator is injected) */
function createMockDispatcher(): Dispatcher {
  return {
    dispatch: vi.fn(),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

/** Create a perspective generator that returns pre-defined perspectives in sequence */
function createSequentialGenerator(perspectives: Perspective[]): PerspectiveGeneratorFn {
  let idx = 0
  return async (_viewpoint: string, _question: string, _context: string): Promise<Perspective> => {
    const p = perspectives[idx % perspectives.length]
    idx++
    return { ...p, viewpoint: _viewpoint }
  }
}

/** Create a perspective generator that always returns a fixed perspective */
function createFixedGenerator(perspective: Omit<Perspective, 'viewpoint'>): PerspectiveGeneratorFn {
  return async (viewpoint, _question, _context) => ({ ...perspective, viewpoint })
}

const BASE_REQUEST: DecisionRequest = {
  tier: 'routine',
  question: 'Should we use TypeScript?',
  context: 'We are building a Node.js backend service.',
}

// ---------------------------------------------------------------------------
// Routine tier tests (AC4)
// ---------------------------------------------------------------------------

describe('DebatePanel — Routine tier (AC4)', () => {
  it('generates single perspective and auto-approves', async () => {
    const generator = createFixedGenerator({
      recommendation: 'Use TypeScript',
      confidence: 0.9,
      risks: ['learning curve'],
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })

    const result = await panel.decide({ ...BASE_REQUEST, tier: 'routine' })

    expect(result.tier).toBe('routine')
    expect(result.perspectives).toHaveLength(1)
    expect(result.decision).toBe('Use TypeScript')
    expect(result.perspectives[0]?.viewpoint).toBe('general')
  })

  it('result includes decision, rationale, tier, perspectives', async () => {
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: createFixedGenerator({
        recommendation: 'Yes',
        confidence: 0.8,
        risks: [],
      }),
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'routine' })

    expect(result).toMatchObject({
      decision: 'Yes',
      tier: 'routine',
    })
    expect(result.rationale).toBeTruthy()
    expect(result.perspectives).toHaveLength(1)
  })

  it('does not include votingRecord for routine decisions', async () => {
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: createFixedGenerator({
        recommendation: 'Proceed',
        confidence: 1.0,
        risks: [],
      }),
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'routine' })
    expect(result.votingRecord).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Significant tier tests (AC5)
// ---------------------------------------------------------------------------

describe('DebatePanel — Significant tier (AC5)', () => {
  it('solicits 3 perspectives by default', async () => {
    const callCount = { count: 0 }
    const generator: PerspectiveGeneratorFn = async (viewpoint) => {
      callCount.count++
      return { viewpoint, recommendation: `rec-${viewpoint}`, confidence: 0.8, risks: [] }
    }
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'significant' })
    // 3 perspectives (no tie-break since all different recs with big margin)
    expect(result.perspectives.length).toBeGreaterThanOrEqual(3)
    expect(result.tier).toBe('significant')
  })

  it('selects winning recommendation via weighted vote', async () => {
    // Two perspectives recommend 'A' (confidence 0.9, 0.8), one recommends 'B' (0.5)
    const perspectives: Perspective[] = [
      { viewpoint: 'simplicity', recommendation: 'A', confidence: 0.9, risks: [] },
      { viewpoint: 'performance', recommendation: 'A', confidence: 0.8, risks: [] },
      { viewpoint: 'maintainability', recommendation: 'B', confidence: 0.5, risks: [] },
    ]
    let idx = 0
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      ...perspectives[idx++],
      viewpoint,
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'significant' })
    expect(result.decision).toBe('A')
    expect(result.votingRecord?.winner).toBe('A')
  })

  it('each perspective includes viewpoint, recommendation, confidence, risks', async () => {
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      viewpoint,
      recommendation: 'Use it',
      confidence: 0.75,
      risks: ['risk-1'],
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'significant' })
    for (const p of result.perspectives) {
      expect(p).toHaveProperty('viewpoint')
      expect(p).toHaveProperty('recommendation')
      expect(p).toHaveProperty('confidence')
      expect(p).toHaveProperty('risks')
    }
  })

  it('includes votingRecord with votes, winner, margin', async () => {
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      viewpoint,
      recommendation: 'Use it',
      confidence: 0.8,
      risks: [],
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'significant' })
    expect(result.votingRecord).toBeDefined()
    expect(result.votingRecord?.votes).toBeDefined()
    expect(result.votingRecord?.winner).toBeDefined()
    expect(typeof result.votingRecord?.margin).toBe('number')
  })

  it('triggers tie-break when margin < 10%', async () => {
    // Create two perspectives with nearly equal scores that will trigger tie-break
    // A: confidence 0.5, B: confidence 0.48 → margin ≈ 0.019 < 0.10
    const perspectives: Perspective[] = [
      { viewpoint: 'simplicity', recommendation: 'A', confidence: 0.5, risks: [] },
      { viewpoint: 'performance', recommendation: 'B', confidence: 0.48, risks: [] },
      { viewpoint: 'maintainability', recommendation: 'C', confidence: 0.02, risks: [] },
    ]
    let idx = 0
    const tieBreakPerspective: Perspective = {
      viewpoint: 'tie-break',
      recommendation: 'A',
      confidence: 0.9,
      risks: [],
    }
    const generator: PerspectiveGeneratorFn = async (viewpoint) => {
      if (viewpoint === 'tie-break') return tieBreakPerspective
      return { ...(perspectives[idx++] ?? perspectives[0]), viewpoint }
    }
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'significant' })
    expect(result.votingRecord?.tieBreak).toBe(true)
    // Should have 4 perspectives (3 original + 1 tie-break)
    expect(result.perspectives.length).toBe(4)
  })

  it('respects custom perspectives count', async () => {
    const calls: string[] = []
    const generator: PerspectiveGeneratorFn = async (viewpoint) => {
      calls.push(viewpoint)
      return { viewpoint, recommendation: 'X', confidence: 0.8, risks: [] }
    }
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    // Request only 2 perspectives
    const result = await panel.decide({
      ...BASE_REQUEST,
      tier: 'significant',
      perspectives: 2,
    })
    expect(result.perspectives.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// Architectural tier tests (AC6)
// ---------------------------------------------------------------------------

describe('DebatePanel — Architectural tier (AC6)', () => {
  it('solicits exactly 5 perspectives with specialized viewpoints', async () => {
    const calls: string[] = []
    const generator: PerspectiveGeneratorFn = async (viewpoint) => {
      calls.push(viewpoint)
      return { viewpoint, recommendation: 'Adopt', confidence: 0.8, risks: [] }
    }
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'architectural' })
    expect(result.perspectives).toHaveLength(5)
    expect(calls).toContain('security')
    expect(calls).toContain('scalability')
    expect(calls).toContain('cost')
    expect(calls).toContain('maintainability')
  })

  it('passes when supermajority > 60%', async () => {
    // All 5 perspectives recommend 'Adopt' → 100% supermajority
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      viewpoint,
      recommendation: 'Adopt',
      confidence: 0.9,
      risks: [],
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'architectural' })
    expect(result.escalated).toBe(false)
    expect(result.decision).toBe('Adopt')
  })

  it('escalates when supermajority is not achieved (≤ 60%)', async () => {
    // 3 recommend 'A' (confidence 0.5 each = 1.5 total)
    // 2 recommend 'B' (confidence 0.9 each = 1.8 total)
    // Total = 3.3, B gets 1.8/3.3 ≈ 54.5% — below 60%
    const perspectives: Perspective[] = [
      { viewpoint: 'security', recommendation: 'A', confidence: 0.5, risks: [] },
      { viewpoint: 'scalability', recommendation: 'A', confidence: 0.5, risks: [] },
      { viewpoint: 'developer-experience', recommendation: 'A', confidence: 0.5, risks: [] },
      { viewpoint: 'cost', recommendation: 'B', confidence: 0.9, risks: [] },
      { viewpoint: 'maintainability', recommendation: 'B', confidence: 0.9, risks: [] },
    ]
    let idx = 0
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      ...(perspectives[idx++] ?? perspectives[0]),
      viewpoint,
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'architectural' })
    expect(result.escalated).toBe(true)
    expect(result.rationale).toContain('Escalated')
  })

  it('includes risks and trade-offs in perspectives', async () => {
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      viewpoint,
      recommendation: 'Do it',
      confidence: 0.85,
      risks: ['risk-A', 'risk-B'],
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'architectural' })
    for (const p of result.perspectives) {
      expect(p.risks).toEqual(['risk-A', 'risk-B'])
    }
  })

  it('includes votingRecord with 5 votes', async () => {
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      viewpoint,
      recommendation: 'Go',
      confidence: 0.8,
      risks: [],
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: generator,
    })
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'architectural' })
    expect(result.votingRecord?.votes).toHaveLength(5)
  })
})

// ---------------------------------------------------------------------------
// Decision persistence tests (AC7)
// ---------------------------------------------------------------------------

describe('DebatePanel — Decision Persistence (AC7)', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = new BetterSqlite3(':memory:')
    runMigrations(db)
  })

  it('persists routine decision to database', async () => {
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      db,
      perspectiveGenerator: createFixedGenerator({
        recommendation: 'Use TypeScript',
        confidence: 0.9,
        risks: [],
      }),
    })
    await panel.decide({ ...BASE_REQUEST, tier: 'routine' })

    const rows = db.prepare("SELECT * FROM decisions WHERE category = 'debate-panel'").all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.value).toBe('Use TypeScript')
    expect(rows[0]?.category).toBe('debate-panel')
  })

  it('stores perspectives and tier in rationale as JSON', async () => {
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      db,
      perspectiveGenerator: createFixedGenerator({
        recommendation: 'Adopt',
        confidence: 0.9,
        risks: ['risk'],
      }),
    })
    await panel.decide({ ...BASE_REQUEST, tier: 'routine' })

    const rows = db.prepare("SELECT * FROM decisions WHERE category = 'debate-panel'").all() as Record<string, unknown>[]
    const rationale = JSON.parse(rows[0]?.rationale as string)
    expect(rationale.tier).toBe('routine')
    expect(Array.isArray(rationale.perspectives)).toBe(true)
  })

  it('uses provided key for the decision record', async () => {
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      db,
      perspectiveGenerator: createFixedGenerator({
        recommendation: 'Yes',
        confidence: 1.0,
        risks: [],
      }),
    })
    await panel.decide({ ...BASE_REQUEST, tier: 'routine', key: 'my-custom-key' })

    const rows = db.prepare("SELECT * FROM decisions WHERE key = 'my-custom-key'").all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
  })

  it('uses provided phase for the decision record', async () => {
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      db,
      perspectiveGenerator: createFixedGenerator({
        recommendation: 'Yes',
        confidence: 1.0,
        risks: [],
      }),
    })
    await panel.decide({ ...BASE_REQUEST, tier: 'routine', phase: 'planning' })

    const rows = db.prepare("SELECT * FROM decisions WHERE phase = 'planning'").all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
  })

  it('does not persist when no db provided', async () => {
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      perspectiveGenerator: createFixedGenerator({
        recommendation: 'Yes',
        confidence: 0.8,
        risks: [],
      }),
    })
    // Should not throw
    const result = await panel.decide({ ...BASE_REQUEST, tier: 'routine' })
    expect(result.decision).toBe('Yes')
  })

  it('persists significant decision with full debate record', async () => {
    const generator: PerspectiveGeneratorFn = async (viewpoint) => ({
      viewpoint,
      recommendation: 'Adopt',
      confidence: 0.8,
      risks: [],
    })
    const panel = createDebatePanel({
      dispatcher: createMockDispatcher(),
      db,
      perspectiveGenerator: generator,
    })
    await panel.decide({ ...BASE_REQUEST, tier: 'significant' })

    const rows = db.prepare("SELECT * FROM decisions WHERE category = 'debate-panel'").all() as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    const rationale = JSON.parse(rows[0]?.rationale as string)
    expect(rationale.tier).toBe('significant')
    expect(rationale.perspectives.length).toBeGreaterThanOrEqual(3)
    expect(rationale.votingRecord).toBeDefined()
  })
})
