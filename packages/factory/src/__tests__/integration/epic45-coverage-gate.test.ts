/**
 * Epic 45 coverage gate — smoke tests for all public convergence API exports.
 * Story 45-10 AC7: validates that all Epic 45 convergence components are
 * importable and callable before the Epic 46 satisfaction scoring layer is added.
 *
 * Expected per-story assertion counts and running total:
 * // 45-1 through 45-4: ~35, 45-5: ~8, 45-6: ~8, 45-7: ~10, 45-8: ~14, 45-9: ~8,
 * // 45-10: ~25 → Total ≥ 108
 */

import { describe, it, expect } from 'vitest'
import { createConvergenceController } from '../../convergence/controller.js'
import { SessionBudgetManager, PipelineBudgetManager } from '../../convergence/budget.js'
import { createPlateauDetector } from '../../convergence/plateau.js'
import { buildRemediationContext, getRemediationContext } from '../../convergence/remediation.js'
import { GraphContext } from '../../graph/context.js'

// ---------------------------------------------------------------------------
// Epic 45 public API smoke tests
// ---------------------------------------------------------------------------

describe('Epic 45 convergence API gate (AC7)', () => {
  it('gate-1: createConvergenceController is exported and returns a controller (story 45-1)', () => {
    const controller = createConvergenceController()
    expect(controller).toBeDefined()
    expect(typeof controller.checkGoalGates).toBe('function')
    expect(typeof controller.resolveRetryTarget).toBe('function')
    expect(typeof controller.recordOutcome).toBe('function')
  })

  it('gate-2: SessionBudgetManager is exported and constructible (story 45-5)', () => {
    const manager = new SessionBudgetManager()
    expect(manager).toBeDefined()
    expect(typeof manager.checkBudget).toBe('function')
    expect(typeof manager.getElapsedMs).toBe('function')
  })

  it('gate-3: PipelineBudgetManager is exported and constructible (story 45-4)', () => {
    const manager = new PipelineBudgetManager()
    expect(manager).toBeDefined()
    expect(typeof manager.checkBudget).toBe('function')
    expect(typeof manager.addCost).toBe('function')
    expect(typeof manager.getTotalCost).toBe('function')
  })

  it('gate-4: createPlateauDetector is exported and returns a detector (story 45-6)', () => {
    const detector = createPlateauDetector()
    expect(detector).toBeDefined()
    expect(typeof detector.recordScore).toBe('function')
    expect(typeof detector.isPlateaued).toBe('function')
    expect(typeof detector.getScores).toBe('function')
  })

  it('gate-5: buildRemediationContext is exported and builds a valid context (story 45-7)', () => {
    const ctx = buildRemediationContext({
      previousFailureReason: 'test failure',
      iterationCount: 1,
      satisfactionScoreHistory: [0.5],
    })
    expect(ctx).toBeDefined()
    expect(ctx.previousFailureReason).toBe('test failure')
    expect(ctx.iterationCount).toBe(1)
    expect(ctx.satisfactionScoreHistory).toEqual([0.5])
  })

  it('gate-6: getRemediationContext returns undefined when no context injected (story 45-7)', () => {
    const context = new GraphContext()
    const result = getRemediationContext(context)
    expect(result).toBeUndefined()
  })
})
