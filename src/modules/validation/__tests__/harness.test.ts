/**
 * Unit tests for CascadeRunner (ValidationHarness implementation).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CascadeRunner } from '../harness.js'
import type {
  CascadeRunnerConfig,
  LevelResult,
  ValidationContext,
  ValidationLevel,
} from '../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLevel(
  level: number,
  name: string,
  result: LevelResult
): ValidationLevel {
  return {
    level,
    name,
    run: vi.fn().mockResolvedValue(result),
  }
}

function passingLevel(level: number, name = `level-${level}`): ValidationLevel {
  return makeLevel(level, name, { passed: true, failures: [], canAutoRemediate: false })
}

function failingLevel(
  level: number,
  canAutoRemediate = false,
  name = `level-${level}`
): ValidationLevel {
  return makeLevel(level, name, {
    passed: false,
    failures: [
      {
        category: 'test',
        description: `Failure at level ${level}`,
        evidence: 'test output',
      },
    ],
    canAutoRemediate,
  })
}

const defaultConfig: CascadeRunnerConfig = {
  projectRoot: '/tmp/test-project',
}

const dummyStory = {
  storyKey: '33-1',
  phase: 'DEV' as const,
  reviewCycles: 0,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CascadeRunner', () => {
  let runner: CascadeRunner

  beforeEach(() => {
    runner = new CascadeRunner(defaultConfig)
  })

  // -------------------------------------------------------------------------
  // AC5 — Plugin-style level registration
  // -------------------------------------------------------------------------
  it('stores registered levels and executes them', async () => {
    const l0 = passingLevel(0)
    const l1 = passingLevel(1)
    runner.registerLevel(l0)
    runner.registerLevel(l1)

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(l0.run).toHaveBeenCalledTimes(1)
    expect(l1.run).toHaveBeenCalledTimes(1)
    expect(result.passed).toBe(true)
  })

  // -------------------------------------------------------------------------
  // All levels pass → ValidationResult.passed = true, highestLevelReached
  // -------------------------------------------------------------------------
  it('returns passed=true and highestLevelReached when all levels pass', async () => {
    runner.registerLevel(passingLevel(0))
    runner.registerLevel(passingLevel(1))
    runner.registerLevel(passingLevel(2))

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.passed).toBe(true)
    expect(result.highestLevelReached).toBe(2)
    expect(result.failures).toHaveLength(0)
    expect(result.remediationContext).toBeNull()
  })

  // -------------------------------------------------------------------------
  // AC3 — Short-circuit on first failure (level 0 fails)
  // -------------------------------------------------------------------------
  it('stops at level 0 when level 0 fails; levels 1+ are not called', async () => {
    const l0 = failingLevel(0)
    const l1 = passingLevel(1)
    const l2 = passingLevel(2)
    runner.registerLevel(l0)
    runner.registerLevel(l1)
    runner.registerLevel(l2)

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.passed).toBe(false)
    expect(l0.run).toHaveBeenCalledTimes(1)
    expect(l1.run).not.toHaveBeenCalled()
    expect(l2.run).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Mid-cascade failure (level 1 fails, level 0 passes)
  // -------------------------------------------------------------------------
  it('stops after level 1 when level 0 passes and level 1 fails', async () => {
    const l0 = passingLevel(0)
    const l1 = failingLevel(1)
    const l2 = passingLevel(2)
    runner.registerLevel(l0)
    runner.registerLevel(l1)
    runner.registerLevel(l2)

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.passed).toBe(false)
    expect(result.highestLevelReached).toBe(1)
    expect(l0.run).toHaveBeenCalledTimes(1)
    expect(l1.run).toHaveBeenCalledTimes(1)
    expect(l2.run).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC6 — maxLevel truncates levels
  // -------------------------------------------------------------------------
  it('only executes levels <= maxLevel when maxLevel is set', async () => {
    const configWithMax: CascadeRunnerConfig = { projectRoot: '/tmp', maxLevel: 1 }
    runner = new CascadeRunner(configWithMax)

    const l0 = passingLevel(0)
    const l1 = passingLevel(1)
    const l2 = passingLevel(2)
    const l3 = passingLevel(3)
    runner.registerLevel(l0)
    runner.registerLevel(l1)
    runner.registerLevel(l2)
    runner.registerLevel(l3)

    await runner.runCascade(dummyStory, null, 1)

    expect(l0.run).toHaveBeenCalledTimes(1)
    expect(l1.run).toHaveBeenCalledTimes(1)
    expect(l2.run).not.toHaveBeenCalled()
    expect(l3.run).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // AC5 — Level ordering is ascending regardless of registration order
  // -------------------------------------------------------------------------
  it('executes levels in ascending order regardless of registration order', async () => {
    const callOrder: number[] = []

    const makeOrderedLevel = (lvl: number): ValidationLevel => ({
      level: lvl,
      name: `level-${lvl}`,
      run: vi.fn().mockImplementation(async () => {
        callOrder.push(lvl)
        return { passed: true, failures: [], canAutoRemediate: false }
      }),
    })

    runner.registerLevel(makeOrderedLevel(2))
    runner.registerLevel(makeOrderedLevel(0))
    runner.registerLevel(makeOrderedLevel(1))

    await runner.runCascade(dummyStory, null, 1)

    expect(callOrder).toEqual([0, 1, 2])
  })

  // -------------------------------------------------------------------------
  // canAutoRemediate reflects the failing level's value (false)
  // -------------------------------------------------------------------------
  it('sets canAutoRemediate=false when failing level has canAutoRemediate=false', async () => {
    runner.registerLevel(failingLevel(0, false))

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.canAutoRemediate).toBe(false)
  })

  // -------------------------------------------------------------------------
  // canAutoRemediate reflects the failing level's value (true)
  // -------------------------------------------------------------------------
  it('sets canAutoRemediate=true when failing level has canAutoRemediate=true', async () => {
    runner.registerLevel(failingLevel(0, true))

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.canAutoRemediate).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Unhandled exception in a level → caught, treated as failure
  // -------------------------------------------------------------------------
  it('catches unhandled exceptions from a level and treats them as failure', async () => {
    const throwingLevel: ValidationLevel = {
      level: 0,
      name: 'throwing-level',
      run: vi.fn().mockRejectedValue(new Error('boom')),
    }
    runner.registerLevel(throwingLevel)

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.passed).toBe(false)
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].evidence).toContain('boom')
  })

  // -------------------------------------------------------------------------
  // AC2 — remediationContext is null when all pass, non-null when any fail
  // -------------------------------------------------------------------------
  it('remediationContext is null when all levels pass', async () => {
    runner.registerLevel(passingLevel(0))
    runner.registerLevel(passingLevel(1))

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.remediationContext).toBeNull()
  })

  it('remediationContext is non-null when any level fails', async () => {
    runner.registerLevel(failingLevel(0))

    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.remediationContext).not.toBeNull()
    expect(result.remediationContext?.level).toBe(0)
    expect(result.remediationContext?.failures).toHaveLength(1)
    expect(result.remediationContext?.retryBudget).toEqual({ spent: 0, remaining: 3 })
    expect(result.remediationContext?.scope).toBe('partial')
  })

  // -------------------------------------------------------------------------
  // Empty runner (no levels registered)
  // -------------------------------------------------------------------------
  it('returns passed=true when no levels are registered', async () => {
    const result = await runner.runCascade(dummyStory, null, 1)

    expect(result.passed).toBe(true)
    expect(result.failures).toHaveLength(0)
    expect(result.remediationContext).toBeNull()
  })

  // -------------------------------------------------------------------------
  // ValidationContext is forwarded to each level
  // -------------------------------------------------------------------------
  it('forwards story, result, attempt, and projectRoot to each level', async () => {
    const capturedContexts: ValidationContext[] = []
    const capturingLevel: ValidationLevel = {
      level: 0,
      name: 'capturing',
      run: vi.fn().mockImplementation(async (ctx: ValidationContext) => {
        capturedContexts.push(ctx)
        return { passed: true, failures: [], canAutoRemediate: false }
      }),
    }
    runner.registerLevel(capturingLevel)

    const customResult = { files: ['a.ts'] }
    await runner.runCascade(dummyStory, customResult, 3)

    expect(capturedContexts).toHaveLength(1)
    expect(capturedContexts[0].story).toBe(dummyStory)
    expect(capturedContexts[0].result).toBe(customResult)
    expect(capturedContexts[0].attempt).toBe(3)
    expect(capturedContexts[0].projectRoot).toBe('/tmp/test-project')
  })
})
