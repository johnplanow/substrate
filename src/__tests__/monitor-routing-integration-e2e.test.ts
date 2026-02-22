/**
 * End-to-end integration tests for Monitor Agent → Routing Engine integration.
 *
 * Uses real MonitorDatabaseImpl (in-memory), real MonitorAgentImpl, and real
 * RoutingEngineImpl to validate the complete monitor → recommendation → routing pipeline.
 *
 * Test scenario:
 *  - Agent A ("claude"): 7/10 successes on "coding" tasks (70% success rate)
 *  - Agent B ("codex"): 9/10 successes on "coding" tasks (90% success rate)
 *  - Monitor should recommend "codex" over "claude" with 20% improvement
 *  - Routing policy selects "claude" (policy takes precedence)
 *  - RoutingDecision includes advisory monitorRecommendation pointing to "codex"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MonitorAgentImpl } from '../modules/monitor/monitor-agent-impl.js'
import { MonitorDatabaseImpl } from '../persistence/monitor-database.js'
import { RoutingEngineImpl } from '../modules/routing/routing-engine-impl.js'
import { createEventBus } from '../core/event-bus.js'
import type { TypedEventBus } from '../core/event-bus.js'
import type { TaskNode } from '../core/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, '../modules/routing/__tests__/fixtures')
const POLICY_PATH = resolve(FIXTURES_DIR, 'routing-policy.yaml')

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'task-e2e-1',
    title: 'E2E Test Task',
    description: 'Integration test task',
    status: 'ready',
    priority: 'normal',
    dependencies: [],
    metadata: {},
    createdAt: new Date(),
    ...overrides,
  }
}

function seedPerformanceData(monitorDb: MonitorDatabaseImpl): void {
  // Agent A ("claude"): 7 successes, 3 failures on "coding" tasks
  for (let i = 0; i < 7; i++) {
    monitorDb.updateAggregates('claude', 'coding', {
      outcome: 'success',
      inputTokens: 2000,
      outputTokens: 0,
      durationMs: 1000,
      cost: 0,
    })
  }
  for (let i = 0; i < 3; i++) {
    monitorDb.updateAggregates('claude', 'coding', {
      outcome: 'failure',
      inputTokens: 500,
      outputTokens: 0,
      durationMs: 500,
      cost: 0,
    })
  }

  // Agent B ("codex"): 9 successes, 1 failure on "coding" tasks
  for (let i = 0; i < 9; i++) {
    monitorDb.updateAggregates('codex', 'coding', {
      outcome: 'success',
      inputTokens: 4000,
      outputTokens: 0,
      durationMs: 2000,
      cost: 0,
    })
  }
  for (let i = 0; i < 1; i++) {
    monitorDb.updateAggregates('codex', 'coding', {
      outcome: 'failure',
      inputTokens: 1000,
      outputTokens: 0,
      durationMs: 500,
      cost: 0,
    })
  }
}

// ---------------------------------------------------------------------------
// E2E Integration Tests
// ---------------------------------------------------------------------------

describe('Monitor → Routing Engine E2E Integration', () => {
  let eventBus: TypedEventBus
  let monitorDb: MonitorDatabaseImpl
  let monitorAgent: MonitorAgentImpl
  let routingEngine: RoutingEngineImpl

  beforeEach(async () => {
    eventBus = createEventBus()
    monitorDb = new MonitorDatabaseImpl(':memory:')

    // Seed performance data before creating the monitor agent
    // so recommendations are immediately available
    seedPerformanceData(monitorDb)

    monitorAgent = new MonitorAgentImpl(eventBus, monitorDb, {
      use_recommendations: true,
      min_sample_size: 10,
      recommendation_threshold_percentage: 5.0,
      recommendation_history_days: 90,
    })
    await monitorAgent.initialize()

    routingEngine = new RoutingEngineImpl(eventBus, null, null)
    ;(routingEngine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await routingEngine.initialize()
  })

  afterEach(async () => {
    await routingEngine.shutdown()
    await monitorAgent.shutdown()
  })

  it('monitorAgent.getRecommendation("coding") returns recommendation for codex', () => {
    const recommendation = monitorAgent.getRecommendation('coding')

    expect(recommendation).not.toBeNull()
    expect(recommendation?.recommended_agent).toBe('codex')
    expect(recommendation?.current_agent).toBe('claude')
    // improvement should be ~20% (90% - 70%)
    expect(recommendation?.improvement_percentage).toBeCloseTo(20, 0)
    // With only 10 samples each (exactly at threshold), confidence should be 'low'
    // (threshold for 'medium' is >= 20 samples)
    expect(recommendation?.confidence).toBe('low')
  })

  it('routes with monitorInfluenced=true when monitor is wired', () => {
    routingEngine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-e2e-wired', metadata: { taskType: 'coding' } })
    const decision = routingEngine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(true)
  })

  it('advisory recommendation is attached when confidence is medium or high', () => {
    // To get medium confidence, we need >= 20 samples per agent
    // Seed additional data to reach medium confidence
    for (let i = 0; i < 10; i++) {
      monitorDb.updateAggregates('claude', 'coding', {
        outcome: 'success',
        inputTokens: 2000,
        outputTokens: 0,
        durationMs: 1000,
        cost: 0,
      })
      monitorDb.updateAggregates('codex', 'coding', {
        outcome: 'success',
        inputTokens: 4000,
        outputTokens: 0,
        durationMs: 2000,
        cost: 0,
      })
    }

    const recommendation = monitorAgent.getRecommendation('coding')
    // Now we have 20+ samples per agent: medium confidence
    expect(recommendation?.confidence).toMatch(/medium|high/)

    routingEngine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-e2e-medium', metadata: { taskType: 'coding' } })
    const decision = routingEngine.routeTask(task)

    // With medium+ confidence, recommendation is attached
    expect(decision.monitorInfluenced).toBe(true)
    expect(decision.monitorRecommendation).toBeDefined()
    expect(decision.monitorRecommendation?.recommended_agent).toBe('codex')
  })

  it('policy agent (claude) wins even when monitor recommends codex (medium+ confidence)', () => {
    // Seed additional data to reach medium confidence
    for (let i = 0; i < 10; i++) {
      monitorDb.updateAggregates('claude', 'coding', {
        outcome: 'success',
        inputTokens: 2000,
        outputTokens: 0,
        durationMs: 1000,
        cost: 0,
      })
      monitorDb.updateAggregates('codex', 'coding', {
        outcome: 'success',
        inputTokens: 4000,
        outputTokens: 0,
        durationMs: 2000,
        cost: 0,
      })
    }

    routingEngine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-e2e-policy-wins', metadata: { taskType: 'coding' } })
    const decision = routingEngine.routeTask(task)

    // Policy selects 'claude' (first preferred for 'coding' in routing-policy.yaml)
    expect(decision.agent).toBe('claude')
    // Monitor recommended 'codex' but policy won
    expect(decision.monitorRecommendation?.recommended_agent).toBe('codex')
    // improvement_percentage should be present
    expect(decision.monitorRecommendation?.improvement_percentage).toBeGreaterThan(0)
  })

  it('routing decision agent matches policy regardless of monitor recommendation', () => {
    // Wire monitor with medium+ confidence data
    for (let i = 0; i < 10; i++) {
      monitorDb.updateAggregates('claude', 'coding', {
        outcome: 'success',
        inputTokens: 2000,
        outputTokens: 0,
        durationMs: 1000,
        cost: 0,
      })
      monitorDb.updateAggregates('codex', 'coding', {
        outcome: 'success',
        inputTokens: 4000,
        outputTokens: 0,
        durationMs: 2000,
        cost: 0,
      })
    }

    routingEngine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-e2e-assert', metadata: { taskType: 'coding' } })
    const decision = routingEngine.routeTask(task)

    // Full assertions as per story spec
    expect(decision.monitorInfluenced).toBe(true)
    expect(decision.monitorRecommendation?.recommended_agent).toBe('codex')
    expect(decision.monitorRecommendation?.improvement_percentage).toBeGreaterThan(0)
    // Policy still takes precedence
    expect(decision.agent).toBe('claude')
  })

  it('monitor not consulted when setMonitorAgent not called (default behavior)', () => {
    // Do NOT call setMonitorAgent
    const task = makeTask({ id: 'task-e2e-default', metadata: { taskType: 'coding' } })
    const decision = routingEngine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(false)
    expect(decision.monitorRecommendation).toBeUndefined()
    // But routing still works
    expect(decision.agent).toBe('claude')
    expect(decision.billingMode).not.toBe('unavailable')
  })

  it('routing works correctly for tasks with no task type (advisory skipped)', () => {
    routingEngine.setMonitorAgent(monitorAgent, true)

    // Task with no taskType metadata
    const task = makeTask({ id: 'task-e2e-no-type', metadata: {} })
    const decision = routingEngine.routeTask(task)

    // Monitor was "consulted" (monitorInfluenced=true) but no recommendation
    // (empty taskType means skip recommendation lookup)
    expect(decision.monitorInfluenced).toBe(true)
    expect(decision.monitorRecommendation).toBeUndefined()
    // Routing still works
    expect(decision.billingMode).not.toBe('unavailable')
  })
})
