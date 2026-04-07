/**
 * Unit tests for CostGovernanceChecker — Story 53-3.
 *
 * Covers:
 *   AC1: computeCumulativeCost sums per_story_state cost_usd + run_total
 *   AC2: checkCeiling returns correct status thresholds and percentUsed
 */

import { describe, it, expect } from 'vitest'
import { CostGovernanceChecker } from '../cost-governance.js'
import type { RunManifestData } from '@substrate-ai/sdlc/run-model/types.js'

// ---------------------------------------------------------------------------
// Fixture factory
// ---------------------------------------------------------------------------

function makeManifest(
  perStoryState: Record<string, { cost_usd?: number }>,
  runTotal = 0,
): RunManifestData {
  const now = new Date().toISOString()
  const per_story_state: RunManifestData['per_story_state'] = {}
  for (const [key, val] of Object.entries(perStoryState)) {
    per_story_state[key] = {
      status: 'complete',
      phase: 'COMPLETE',
      started_at: now,
      ...(val.cost_usd !== undefined ? { cost_usd: val.cost_usd } : {}),
    }
  }
  return {
    run_id: 'test-run',
    cli_flags: {},
    story_scope: [],
    supervisor_pid: null,
    supervisor_session_id: null,
    per_story_state,
    recovery_history: [],
    cost_accumulation: {
      per_story: {},
      run_total: runTotal,
    },
    pending_proposals: [],
    generation: 1,
    created_at: now,
    updated_at: now,
  }
}

// ---------------------------------------------------------------------------
// computeCumulativeCost
// ---------------------------------------------------------------------------

describe('CostGovernanceChecker.computeCumulativeCost', () => {
  const checker = new CostGovernanceChecker()

  it('returns 0 for empty per_story_state and zero run_total', () => {
    const manifest = makeManifest({}, 0)
    expect(checker.computeCumulativeCost(manifest)).toBe(0)
  })

  it('sums cost_usd values plus run_total', () => {
    const manifest = makeManifest(
      { '1-1': { cost_usd: 0.10 }, '1-2': { cost_usd: 0.20 }, '1-3': { cost_usd: 0.30 } },
      0.05,
    )
    // 0.10 + 0.20 + 0.30 + 0.05 = 0.65
    expect(checker.computeCumulativeCost(manifest)).toBeCloseTo(0.65, 10)
  })

  it('treats undefined cost_usd as 0', () => {
    const manifest = makeManifest(
      { '1-1': { cost_usd: 0.50 }, '1-2': {} },
      0,
    )
    expect(checker.computeCumulativeCost(manifest)).toBeCloseTo(0.50, 10)
  })
})

// ---------------------------------------------------------------------------
// estimateNextStoryCost
// ---------------------------------------------------------------------------

describe('CostGovernanceChecker.estimateNextStoryCost', () => {
  const checker = new CostGovernanceChecker()

  it('returns 0 when no stories have cost_usd', () => {
    const manifest = makeManifest({ '1-1': {} })
    expect(checker.estimateNextStoryCost(manifest)).toBe(0)
  })

  it('returns average of stories with cost_usd', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 1.00 }, '1-2': { cost_usd: 3.00 } })
    expect(checker.estimateNextStoryCost(manifest)).toBeCloseTo(2.00, 10)
  })

  it('ignores undefined cost_usd when computing average', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 2.00 }, '1-2': {} })
    expect(checker.estimateNextStoryCost(manifest)).toBeCloseTo(2.00, 10)
  })

  it('returns 0 when all stories have cost_usd of 0', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 0 } })
    expect(checker.estimateNextStoryCost(manifest)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// checkCeiling
// ---------------------------------------------------------------------------

describe('CostGovernanceChecker.checkCeiling', () => {
  const checker = new CostGovernanceChecker()
  const CEILING = 5.00

  it('returns ok when cumulative is 0 (0%)', () => {
    const manifest = makeManifest({}, 0)
    const result = checker.checkCeiling(manifest, CEILING)
    expect(result.status).toBe('ok')
    expect(result.percentUsed).toBe(0)
    expect(result.cumulative).toBe(0)
    expect(result.ceiling).toBe(CEILING)
  })

  it('returns ok when cumulative is 3.90 (78%)', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 3.90 } }, 0)
    const result = checker.checkCeiling(manifest, CEILING)
    expect(result.status).toBe('ok')
    expect(result.percentUsed).toBe(78)
  })

  it('returns warning when cumulative is exactly 4.00 (80%)', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 4.00 } }, 0)
    const result = checker.checkCeiling(manifest, CEILING)
    expect(result.status).toBe('warning')
    expect(result.percentUsed).toBe(80)
  })

  it('returns warning when cumulative is 4.20 (84%)', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 4.20 } }, 0)
    const result = checker.checkCeiling(manifest, CEILING)
    expect(result.status).toBe('warning')
    expect(result.percentUsed).toBe(84)
  })

  it('returns exceeded when cumulative is exactly 5.00 (100%)', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 5.00 } }, 0)
    const result = checker.checkCeiling(manifest, CEILING)
    expect(result.status).toBe('exceeded')
    expect(result.percentUsed).toBe(100)
  })

  it('returns exceeded when cumulative is 5.10 (102%)', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 5.10 } }, 0)
    const result = checker.checkCeiling(manifest, CEILING)
    expect(result.status).toBe('exceeded')
    expect(result.percentUsed).toBe(102)
  })

  it('includes estimatedNext in result', () => {
    const manifest = makeManifest({ '1-1': { cost_usd: 1.00 }, '1-2': { cost_usd: 2.00 } }, 0)
    const result = checker.checkCeiling(manifest, CEILING)
    expect(result.estimatedNext).toBeCloseTo(1.50, 10)
  })

  it('percentUsed is rounded to two decimal places', () => {
    // 1.00 / 3.00 = 33.3333...% -> should round to 33.33
    const manifest = makeManifest({ '1-1': { cost_usd: 1.00 } }, 0)
    const result = checker.checkCeiling(manifest, 3.00)
    expect(result.percentUsed).toBe(33.33)
  })
})
