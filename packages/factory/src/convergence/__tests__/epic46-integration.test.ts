/**
 * epic46-integration.test.ts
 *
 * End-to-end integration tests for Epic 46 Satisfaction Scoring:
 * - Dual-signal Phase 2 agreement tracking (AC2)
 * - Scenario-primary mode advisory events (AC3)
 * - Score persistence roundtrip (AC4)
 * - Multi-iteration score history (AC5)
 * - Factory run listing and upsert semantics (AC6)
 * - Combined end-to-end flow (AC1–AC6)
 *
 * Story 46-8.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { evaluateDualSignal, createDualSignalCoordinator } from '../dual-signal.js'
import type {
  DualSignalVerdict,
  DualSignalResult,
  DualSignalCoordinatorOptions,
} from '../dual-signal.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../../events.js'
import { createDatabaseAdapter } from '@substrate-ai/core'
import { factorySchema } from '../../persistence/factory-schema.js'
import {
  upsertGraphRun,
  insertScenarioResult,
  getScenarioResultsForRun,
  listGraphRuns,
} from '../../persistence/factory-queries.js'
import type { GraphRunInput, ScenarioResultInput } from '../../persistence/factory-queries.js'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { createSatisfactionScorer } from '../../scenarios/scorer.js'
import type { ScenarioRunResult, ScenarioWeights } from '../../scenarios/scorer.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunResult(
  scenarios: Array<{ name: string; status: 'pass' | 'fail' }>,
): ScenarioRunResult {
  const passedCount = scenarios.filter(s => s.status === 'pass').length
  return {
    scenarios: scenarios.map(s => ({
      name: s.name,
      status: s.status,
      exitCode: s.status === 'pass' ? 0 : 1,
      stdout: '',
      stderr: s.status === 'fail' ? 'assertion failed' : '',
      durationMs: 100,
    })),
    summary: {
      total: scenarios.length,
      passed: passedCount,
      failed: scenarios.length - passedCount,
    },
    durationMs: 300,
  }
}

function makeGraphRunInput(id: string, status: string, overrides: Partial<GraphRunInput> = {}): GraphRunInput {
  return {
    id,
    graph_file: 'pipeline.dot',
    graph_goal: 'test goal',
    status,
    started_at: new Date(Date.now() - 1000).toISOString(),
    node_count: 3,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Dual-signal Phase 2 agreement tracking (AC2)
// ---------------------------------------------------------------------------

describe('Dual-signal Phase 2 agreement tracking', () => {
  // 8 agreeing pairs and 2 disagreeing pairs
  // Agreeing: SHIP_IT/score≥0.8 or NEEDS_MAJOR_REWORK/score<0.8
  // Disagreeing: SHIP_IT/score<0.8 or NEEDS_MINOR_FIXES/score≥0.8

  const threshold = 0.8

  it('SHIP_IT with score=0.9 (≥0.8) returns AGREE', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.9, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('SHIP_IT')
  })

  it('SHIP_IT with score=0.85 (≥0.8) returns AGREE', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.85, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('SHIP_IT')
  })

  it('LGTM_WITH_NOTES with score=0.95 (≥0.8) returns AGREE', () => {
    const result = evaluateDualSignal('LGTM_WITH_NOTES', 0.95, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('LGTM_WITH_NOTES')
  })

  it('NEEDS_MAJOR_REWORK with score=0.3 (<0.8) returns AGREE', () => {
    const result = evaluateDualSignal('NEEDS_MAJOR_REWORK', 0.3, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('NEEDS_MAJOR_REWORK')
  })

  it('NEEDS_MAJOR_REWORK with score=0.5 (<0.8) returns AGREE', () => {
    const result = evaluateDualSignal('NEEDS_MAJOR_REWORK', 0.5, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('NEEDS_MAJOR_REWORK')
  })

  it('NEEDS_MINOR_FIXES with score=0.2 (<0.8) returns AGREE', () => {
    const result = evaluateDualSignal('NEEDS_MINOR_FIXES', 0.2, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('NEEDS_MINOR_FIXES')
  })

  it('NEEDS_MINOR_FIXES with score=0.4 (<0.8) returns AGREE', () => {
    const result = evaluateDualSignal('NEEDS_MINOR_FIXES', 0.4, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('NEEDS_MINOR_FIXES')
  })

  it('SHIP_IT with score=1.0 (≥0.8) returns AGREE', () => {
    const result = evaluateDualSignal('SHIP_IT', 1.0, threshold)
    expect(result.agreement).toBe('AGREE')
    expect(result.authoritativeDecision).toBe('SHIP_IT')
  })

  // Disagreeing pair 1: SHIP_IT but score < 0.8
  it('SHIP_IT with score=0.6 (<0.8) returns DISAGREE', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.6, threshold)
    expect(result.agreement).toBe('DISAGREE')
    expect(result.authoritativeDecision).toBe('SHIP_IT')
  })

  // Disagreeing pair 2: NEEDS_MINOR_FIXES but score >= 0.8
  it('NEEDS_MINOR_FIXES with score=0.85 (≥0.8) returns DISAGREE', () => {
    const result = evaluateDualSignal('NEEDS_MINOR_FIXES', 0.85, threshold)
    expect(result.agreement).toBe('DISAGREE')
    expect(result.authoritativeDecision).toBe('NEEDS_MINOR_FIXES')
  })

  it('LGTM_WITH_NOTES is treated as code review pass (codeReviewPassed=true)', () => {
    const result = evaluateDualSignal('LGTM_WITH_NOTES', 0.5, threshold)
    expect(result.codeReviewPassed).toBe(true)
    expect(result.agreement).toBe('DISAGREE')
  })

  it('score === threshold returns scenarioPassed=true (boundary condition)', () => {
    const result = evaluateDualSignal('SHIP_IT', 0.8, threshold)
    expect(result.scenarioPassed).toBe(true)
    expect(result.agreement).toBe('AGREE')
  })
})

// ---------------------------------------------------------------------------
// Scenario-primary mode — advisory events and gate control (AC3)
// ---------------------------------------------------------------------------

describe('Scenario-primary mode — advisory events and gate control', () => {
  let mockBus: TypedEventBus<FactoryEvents>

  beforeEach(() => {
    mockBus = { emit: vi.fn() } as unknown as TypedEventBus<FactoryEvents>
    vi.clearAllMocks()
  })

  it('emits scenario:score-computed with passes=true and scenario:advisory-computed when score passes but code review fails', () => {
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-1')

    const emitMock = vi.mocked(mockBus.emit)

    expect(emitMock).toHaveBeenCalledWith('scenario:score-computed', expect.objectContaining({
      runId: 'run-1',
      passes: true,
      score: 0.9,
      threshold: 0.8,
    }))

    expect(emitMock).toHaveBeenCalledWith('scenario:advisory-computed', expect.objectContaining({
      runId: 'run-1',
      verdict: 'NEEDS_MAJOR_REWORK',
      codeReviewPassed: false,
      score: 0.9,
      threshold: 0.8,
      agreement: 'DISAGREE',
    }))
  })

  it('emits scenario:score-computed with passes=false when score fails (code review passes)', () => {
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('SHIP_IT', 0.6, 'run-2')

    const emitMock = vi.mocked(mockBus.emit)

    expect(emitMock).toHaveBeenCalledWith('scenario:score-computed', expect.objectContaining({
      runId: 'run-2',
      passes: false,
    }))

    expect(emitMock).toHaveBeenCalledWith('scenario:advisory-computed', expect.objectContaining({
      runId: 'run-2',
      agreement: 'DISAGREE',
      codeReviewPassed: true,
    }))
  })

  it('emits advisory-computed with agreement=AGREE when both signals agree', () => {
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('SHIP_IT', 0.85, 'run-3')

    expect(vi.mocked(mockBus.emit)).toHaveBeenCalledWith('scenario:advisory-computed', expect.objectContaining({
      runId: 'run-3',
      agreement: 'AGREE',
    }))
  })

  it('does NOT emit scenario:advisory-computed in default dual-signal mode', () => {
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      // qualityMode not set — defaults to undefined (not scenario-primary)
    })

    coordinator.evaluate('SHIP_IT', 0.9, 'run-4')

    const emitMock = vi.mocked(mockBus.emit)
    const advisoryCalls = emitMock.mock.calls.filter(call => call[0] === 'scenario:advisory-computed')
    expect(advisoryCalls).toHaveLength(0)
  })

  it('threads runId correctly into both emitted event payloads', () => {
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    coordinator.evaluate('NEEDS_MINOR_FIXES', 0.9, 'specific-run-id-xyz')

    const emitMock = vi.mocked(mockBus.emit)
    const scoreCall = emitMock.mock.calls.find(c => c[0] === 'scenario:score-computed')
    const advisoryCall = emitMock.mock.calls.find(c => c[0] === 'scenario:advisory-computed')

    expect(scoreCall?.[1]).toMatchObject({ runId: 'specific-run-id-xyz' })
    expect(advisoryCall?.[1]).toMatchObject({ runId: 'specific-run-id-xyz' })
  })

  it('evaluate() returns a DualSignalResult whose fields match the emitted payload', () => {
    const coordinator = createDualSignalCoordinator({
      eventBus: mockBus,
      threshold: 0.8,
      qualityMode: 'scenario-primary',
    })

    const result = coordinator.evaluate('NEEDS_MAJOR_REWORK', 0.9, 'run-5')

    const emitMock = vi.mocked(mockBus.emit)
    const scoreCall = emitMock.mock.calls.find(c => c[0] === 'scenario:score-computed')
    const payload = scoreCall?.[1] as { score: number; passes: boolean; agreement: string }

    expect(result.score).toBe(payload.score)
    expect(result.scenarioPassed).toBe(payload.passes)
    expect(result.agreement).toBe(payload.agreement)
    expect(result.authoritativeDecision).toBe('NEEDS_MAJOR_REWORK')
  })
})

// ---------------------------------------------------------------------------
// Score persistence roundtrip (AC4, AC5)
// ---------------------------------------------------------------------------

describe('Score persistence roundtrip', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = createDatabaseAdapter({ backend: 'memory' })
    await factorySchema(adapter)
    vi.clearAllMocks()
  })

  it('AC4: inserts and retrieves one scenario result with full breakdown', async () => {
    const runId = 'persist-test-001'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    const breakdown = [{ name: 'critical', passed: true, weight: 3.0, contribution: 0.60 }]
    const input: ScenarioResultInput = {
      run_id: runId,
      node_id: 'scenario-node',
      iteration: 1,
      total_scenarios: 1,
      passed: 1,
      failed: 0,
      satisfaction_score: 0.80,
      threshold: 0.80,
      passes: true,
      details: JSON.stringify(breakdown),
    }

    await insertScenarioResult(adapter, input)
    const rows = await getScenarioResultsForRun(adapter, runId)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.run_id).toBe(runId)
    expect(rows[0]!.satisfaction_score).toBeCloseTo(0.80, 10)
    expect(rows[0]!.passes).toBe(true)
    expect(rows[0]!.threshold).toBeCloseTo(0.80, 10)
    expect(rows[0]!.node_id).toBe('scenario-node')
    expect(rows[0]!.iteration).toBe(1)

    const parsedBreakdown = JSON.parse(rows[0]!.details!)
    expect(parsedBreakdown).toEqual(breakdown)
    expect(parsedBreakdown[0].name).toBe('critical')
    expect(parsedBreakdown[0].passed).toBe(true)
    expect(parsedBreakdown[0].weight).toBe(3.0)
    expect(parsedBreakdown[0].contribution).toBeCloseTo(0.60, 10)
  })

  it('handles empty/null details without parse error on retrieve', async () => {
    const runId = 'persist-test-002'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    const input: ScenarioResultInput = {
      run_id: runId,
      node_id: 'node-1',
      iteration: 1,
      total_scenarios: 2,
      passed: 1,
      failed: 1,
      satisfaction_score: 0.50,
      threshold: 0.80,
      passes: false,
      // No details field
    }

    await insertScenarioResult(adapter, input)
    const rows = await getScenarioResultsForRun(adapter, runId)

    expect(rows).toHaveLength(1)
    expect(rows[0]!.details).toBeNull()
    // Confirm it doesn't throw when attempting to parse (null guard)
    const detail = rows[0]!.details
    expect(() => detail !== null ? JSON.parse(detail) : null).not.toThrow()
  })

  it('AC5: inserts 3 iterations and retrieves in ascending order with correct scores', async () => {
    const runId = 'persist-test-003'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    await insertScenarioResult(adapter, {
      run_id: runId, node_id: 'node-1', iteration: 1,
      total_scenarios: 5, passed: 3, failed: 2,
      satisfaction_score: 0.60, threshold: 0.80, passes: false,
    })
    await insertScenarioResult(adapter, {
      run_id: runId, node_id: 'node-1', iteration: 2,
      total_scenarios: 5, passed: 4, failed: 1,
      satisfaction_score: 0.72, threshold: 0.80, passes: false,
    })
    await insertScenarioResult(adapter, {
      run_id: runId, node_id: 'node-1', iteration: 3,
      total_scenarios: 5, passed: 5, failed: 0,
      satisfaction_score: 0.85, threshold: 0.80, passes: true,
    })

    const rows = await getScenarioResultsForRun(adapter, runId)

    expect(rows).toHaveLength(3)
    // Ascending iteration order
    expect(rows[0]!.iteration).toBe(1)
    expect(rows[1]!.iteration).toBe(2)
    expect(rows[2]!.iteration).toBe(3)
    // Correct scores
    expect(rows[0]!.satisfaction_score).toBeCloseTo(0.60, 10)
    expect(rows[1]!.satisfaction_score).toBeCloseTo(0.72, 10)
    expect(rows[2]!.satisfaction_score).toBeCloseTo(0.85, 10)
    // passes correctness
    expect(rows[0]!.passes).toBe(false)
    expect(rows[1]!.passes).toBe(false)
    expect(rows[2]!.passes).toBe(true)
  })

  it('getScenarioResultsForRun returns empty array for unknown run_id', async () => {
    const rows = await getScenarioResultsForRun(adapter, 'nonexistent-run-000')
    expect(rows).toEqual([])
  })

  it('stores passes=false correctly and coerces integer 0 to boolean false on read', async () => {
    const runId = 'persist-test-004'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    await insertScenarioResult(adapter, {
      run_id: runId, node_id: 'node-1', iteration: 1,
      total_scenarios: 5, passed: 2, failed: 3,
      satisfaction_score: 0.40, threshold: 0.80, passes: false,
    })

    const rows = await getScenarioResultsForRun(adapter, runId)
    expect(rows[0]!.passes).toBe(false)
    expect(typeof rows[0]!.passes).toBe('boolean')
  })

  it('stores passes=true correctly and coerces integer 1 to boolean true on read', async () => {
    const runId = 'persist-test-005'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    await insertScenarioResult(adapter, {
      run_id: runId, node_id: 'node-1', iteration: 1,
      total_scenarios: 5, passed: 5, failed: 0,
      satisfaction_score: 1.0, threshold: 0.80, passes: true,
    })

    const rows = await getScenarioResultsForRun(adapter, runId)
    expect(rows[0]!.passes).toBe(true)
    expect(typeof rows[0]!.passes).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Factory run listing and upsert semantics (AC6)
// ---------------------------------------------------------------------------

describe('Factory run listing and upsert semantics', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = createDatabaseAdapter({ backend: 'memory' })
    await factorySchema(adapter)
    vi.clearAllMocks()
  })

  it('upsertGraphRun overwrites (does not duplicate) on second call with same id', async () => {
    const runId = 'upsert-test-001'

    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'completed', {
      final_outcome: 'SUCCESS',
      completed_at: new Date().toISOString(),
    }))

    const runs = await listGraphRuns(adapter, 10)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.id).toBe(runId)
    expect(runs[0]!.status).toBe('completed')
    expect(runs[0]!.final_outcome).toBe('SUCCESS')
  })

  it('listGraphRuns returns two distinct runs in descending started_at order', async () => {
    const now = Date.now()
    await upsertGraphRun(adapter, {
      id: 'run-older',
      graph_file: 'pipeline.dot',
      status: 'completed',
      started_at: new Date(now - 2000).toISOString(),
    })
    await upsertGraphRun(adapter, {
      id: 'run-newer',
      graph_file: 'pipeline.dot',
      status: 'running',
      started_at: new Date(now - 500).toISOString(),
    })

    const runs = await listGraphRuns(adapter, 10)
    expect(runs).toHaveLength(2)
    expect(runs[0]!.id).toBe('run-newer')
    expect(runs[1]!.id).toBe('run-older')
  })

  it('listGraphRuns with limit=1 returns only the most-recent run', async () => {
    const now = Date.now()
    await upsertGraphRun(adapter, {
      id: 'run-a',
      graph_file: 'pipeline.dot',
      status: 'completed',
      started_at: new Date(now - 3000).toISOString(),
    })
    await upsertGraphRun(adapter, {
      id: 'run-b',
      graph_file: 'pipeline.dot',
      status: 'completed',
      started_at: new Date(now - 1000).toISOString(),
    })
    await upsertGraphRun(adapter, {
      id: 'run-c',
      graph_file: 'pipeline.dot',
      status: 'running',
      started_at: new Date(now).toISOString(),
    })

    const runs = await listGraphRuns(adapter, 1)
    expect(runs).toHaveLength(1)
    expect(runs[0]!.id).toBe('run-c')
  })

  it('listGraphRuns on empty database returns empty array', async () => {
    const runs = await listGraphRuns(adapter, 10)
    expect(runs).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// End-to-end: scoring → persistence → listing (AC1–AC6)
// ---------------------------------------------------------------------------

describe('End-to-end: scoring → persistence → listing', () => {
  let adapter: DatabaseAdapter

  beforeEach(async () => {
    adapter = createDatabaseAdapter({ backend: 'memory' })
    await factorySchema(adapter)
    vi.clearAllMocks()
  })

  it('computes score, persists, retrieves, and satisfaction_score matches', async () => {
    const scorer = createSatisfactionScorer(0.8)
    const weights: ScenarioWeights = { critical: 3.0, 'standard-1': 1.0, 'standard-2': 1.0 }
    const runResult = makeRunResult([
      { name: 'critical', status: 'pass' },
      { name: 'standard-1', status: 'pass' },
      { name: 'standard-2', status: 'fail' },
    ])
    const scoreResult = scorer.compute(runResult, weights)

    const runId = 'e2e-run-001'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    await insertScenarioResult(adapter, {
      run_id: runId,
      node_id: 'scenario-node',
      iteration: 1,
      total_scenarios: 3,
      passed: 2,
      failed: 1,
      satisfaction_score: scoreResult.score,
      threshold: scoreResult.threshold,
      passes: scoreResult.passes,
      details: JSON.stringify(scoreResult.breakdown),
    })

    const rows = await getScenarioResultsForRun(adapter, runId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.satisfaction_score).toBeCloseTo(scoreResult.score, 10)
    expect(rows[0]!.passes).toBe(scoreResult.passes)
  })

  it('run appears in listGraphRuns with status=running after initial insert', async () => {
    const runId = 'e2e-run-002'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    const runs = await listGraphRuns(adapter, 10)
    const run = runs.find(r => r.id === runId)
    expect(run).toBeDefined()
    expect(run!.status).toBe('running')
  })

  it('upsert to completed status updates the run correctly', async () => {
    const runId = 'e2e-run-003'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))

    // Update to completed
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'completed', {
      final_outcome: 'SUCCESS',
      completed_at: new Date().toISOString(),
    }))

    const runs = await listGraphRuns(adapter, 10)
    const run = runs.find(r => r.id === runId)
    expect(run).toBeDefined()
    expect(run!.status).toBe('completed')
    expect(run!.final_outcome).toBe('SUCCESS')

    // Confirm only 1 row (no duplicate)
    const matchingRuns = runs.filter(r => r.id === runId)
    expect(matchingRuns).toHaveLength(1)
  })

  it('breakdown persisted via JSON.stringify survives roundtrip correctly', async () => {
    const scorer = createSatisfactionScorer(0.8)
    const weights: ScenarioWeights = { critical: 3.0, 'standard-1': 1.0, 'standard-2': 1.0 }
    const runResult = makeRunResult([
      { name: 'critical', status: 'pass' },
      { name: 'standard-1', status: 'pass' },
      { name: 'standard-2', status: 'fail' },
    ])
    const scoreResult = scorer.compute(runResult, weights)

    const runId = 'e2e-run-004'
    await upsertGraphRun(adapter, makeGraphRunInput(runId, 'running'))
    await insertScenarioResult(adapter, {
      run_id: runId,
      node_id: 'node-1',
      iteration: 1,
      total_scenarios: 3,
      passed: 2,
      failed: 1,
      satisfaction_score: scoreResult.score,
      threshold: scoreResult.threshold,
      passes: scoreResult.passes,
      details: JSON.stringify(scoreResult.breakdown),
    })

    const rows = await getScenarioResultsForRun(adapter, runId)
    expect(rows).toHaveLength(1)

    const parsedBreakdown = JSON.parse(rows[0]!.details!)
    expect(parsedBreakdown).toHaveLength(scoreResult.breakdown.length)
    for (const [i, expected] of scoreResult.breakdown.entries()) {
      expect(parsedBreakdown[i].name).toBe(expected.name)
      expect(parsedBreakdown[i].passed).toBe(expected.passed)
      expect(parsedBreakdown[i].weight).toBe(expected.weight)
      expect(parsedBreakdown[i].contribution).toBeCloseTo(expected.contribution, 10)
    }
  })
})
