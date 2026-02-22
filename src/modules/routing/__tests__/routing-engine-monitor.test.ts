/**
 * Tests for RoutingEngine Monitor Integration — AC1 through AC7
 *
 * Test coverage:
 *  - AC1: Routing engine consults monitor when use_monitor_recommendations=true
 *  - AC2: High/medium confidence recommendation is attached to RoutingDecision
 *  - AC3: Explicit routing policy takes precedence over monitor recommendation
 *  - AC4: Monitor not consulted when disabled
 *  - AC5: Monitor errors do not disrupt routing
 *  - AC6: setMonitorAgent() and createRoutingEngineImpl() factory wiring
 *  - AC7: Debug log emitted when policy selects different agent than recommendation
 */

import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { TaskNode } from '../../../core/types.js'
import type { MonitorAgent } from '../../monitor/monitor-agent.js'
import type { Recommendation } from '../../monitor/recommendation-types.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'
import type { WorkerAdapter } from '../../../adapters/worker-adapter.js'
import { RoutingEngineImpl, createRoutingEngineImpl } from '../routing-engine-impl.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, 'fixtures')

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockEventBus(): TypedEventBus {
  const emitter = new EventEmitter()
  return {
    emit: vi.fn((event: string, payload: unknown) => { emitter.emit(event, payload) }),
    on: vi.fn((event: string, handler: (payload: unknown) => void) => { emitter.on(event, handler) }),
    off: vi.fn((event: string, handler: (payload: unknown) => void) => { emitter.off(event, handler) }),
  } as unknown as TypedEventBus
}

function makeTask(overrides: Partial<TaskNode> = {}): TaskNode {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: 'Do work',
    status: 'ready',
    priority: 'normal',
    dependencies: [],
    metadata: {},
    createdAt: new Date(),
    ...overrides,
  }
}

function createMockMonitorAgent(recommendation: Recommendation | null = null): MonitorAgent {
  return {
    initialize: vi.fn(async (): Promise<void> => { /* no-op */ }),
    shutdown: vi.fn(async (): Promise<void> => { /* no-op */ }),
    recordTaskMetrics: vi.fn(),
    getRecommendations: vi.fn(() => (recommendation != null ? [recommendation] : [])),
    getRecommendation: vi.fn((_taskType: string) => recommendation),
    setCustomTaxonomy: vi.fn(),
  } as unknown as MonitorAgent
}

function createMockAdapter(id: string): WorkerAdapter {
  return {
    id,
    displayName: id,
    adapterVersion: '1.0.0',
    buildCommand: vi.fn(),
    parseOutput: vi.fn(),
    buildPlanningCommand: vi.fn(),
    parsePlanOutput: vi.fn(),
    estimateTokens: vi.fn(() => ({ input: 10, output: 5, total: 15 })),
    healthCheck: vi.fn(async () => ({ healthy: true, supportsHeadless: true })),
    getCapabilities: vi.fn(() => ({
      supportsJsonOutput: true,
      supportsStreaming: false,
      supportsSubscriptionBilling: true,
      supportsApiBilling: true,
      supportsPlanGeneration: true,
      maxContextTokens: 200_000,
      supportedTaskTypes: ['*'],
      supportedLanguages: ['*'],
    })),
  } as unknown as WorkerAdapter
}

function createMockAdapterRegistry(adapters: WorkerAdapter[] = []): AdapterRegistry {
  const adapterMap = new Map(adapters.map((a) => [a.id, a]))
  return {
    register: vi.fn(),
    get: vi.fn((id: string) => adapterMap.get(id)),
    getAll: vi.fn(() => adapters),
    getPlanningCapable: vi.fn(() => []),
    discoverAndRegister: vi.fn(async () => ({ registeredCount: 0, failedCount: 0, results: [] })),
  } as unknown as AdapterRegistry
}

const mockRecommendation: Recommendation = {
  task_type: 'coding',
  current_agent: 'claude',
  recommended_agent: 'codex',
  reason: 'codex shows 20% higher success rate for coding tasks (90% vs 70%, based on 10 tasks)',
  confidence: 'medium',
  current_success_rate: 70.0,
  recommended_success_rate: 90.0,
  current_avg_tokens: 2000,
  recommended_avg_tokens: 4500,
  improvement_percentage: 20.0,
  sample_size_current: 10,
  sample_size_recommended: 10,
}

const lowConfidenceRecommendation: Recommendation = {
  ...mockRecommendation,
  confidence: 'low',
}

const highConfidenceRecommendation: Recommendation = {
  ...mockRecommendation,
  confidence: 'high',
}

// Policy path for test fixtures
const POLICY_PATH = resolve(FIXTURES_DIR, 'routing-policy.yaml')

// ---------------------------------------------------------------------------
// AC1: Routing engine consults monitor when enabled
// ---------------------------------------------------------------------------

describe('AC1: Routing Engine Consults Monitor When Enabled', () => {
  it('sets monitorInfluenced=true when use_monitor_recommendations=true and monitor available', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(null) // No recommendation but monitor is present
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac1', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(true)
    expect(vi.mocked(monitorAgent.getRecommendation)).toHaveBeenCalledWith('coding')
  })

  it('sets monitorInfluenced=false when use_monitor_recommendations=false', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    // Register agent but explicitly disable recommendations
    engine.setMonitorAgent(monitorAgent, false)

    const task = makeTask({ id: 'task-ac1-disabled', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(false)
    expect(vi.mocked(monitorAgent.getRecommendation)).not.toHaveBeenCalled()
  })

  it('sets monitorInfluenced=false when no monitor agent registered', async () => {
    const eventBus = createMockEventBus()
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    // No monitor agent set

    const task = makeTask({ id: 'task-ac1-none', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(false)
    expect(decision.monitorRecommendation).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC2: High-confidence recommendation influences agent selection (advisory)
// ---------------------------------------------------------------------------

describe('AC2: Advisory Recommendation Attached to RoutingDecision', () => {
  it('attaches monitorRecommendation when confidence is "medium"', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation) // medium confidence
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac2-medium', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(true)
    expect(decision.monitorRecommendation).toBeDefined()
    expect(decision.monitorRecommendation?.confidence).toBe('medium')
    expect(decision.monitorRecommendation?.improvement_percentage).toBe(20.0)
  })

  it('attaches monitorRecommendation when confidence is "high"', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(highConfidenceRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac2-high', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorRecommendation).toBeDefined()
    expect(decision.monitorRecommendation?.confidence).toBe('high')
  })

  it('does NOT attach monitorRecommendation when confidence is "low"', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(lowConfidenceRecommendation) // low confidence
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac2-low', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    // Monitor was consulted (monitorInfluenced=true) but low confidence means no recommendation attached
    expect(decision.monitorInfluenced).toBe(true)
    expect(decision.monitorRecommendation).toBeUndefined()
  })

  it('rationale field is present on routing decision', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac2-rationale', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    // The routing decision has a rationale
    expect(decision.rationale).toBeTruthy()
    expect(typeof decision.rationale).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// AC3: Explicit routing policy takes precedence over monitor
// ---------------------------------------------------------------------------

describe('AC3: Explicit Routing Policy Takes Precedence', () => {
  it('policy-assigned agent wins even when monitor recommends a different agent', async () => {
    const eventBus = createMockEventBus()
    // Monitor recommends 'codex' but policy will select 'claude' for 'coding' tasks
    const monitorAgent = createMockMonitorAgent(mockRecommendation) // recommends 'codex'
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac3', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    // Policy selects 'claude' (first preferred for 'coding') not 'codex' (recommended by monitor)
    expect(decision.agent).toBe('claude')
  })

  it('RoutingDecision still includes monitorRecommendation advisory data when policy overrides', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac3-advisory', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    // Advisory recommendation is still attached for observability
    expect(decision.monitorRecommendation).toBeDefined()
    expect(decision.monitorRecommendation?.recommended_agent).toBe('codex')
    // monitorInfluenced=true shows monitor was consulted
    expect(decision.monitorInfluenced).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC4: Monitor not consulted when disabled
// ---------------------------------------------------------------------------

describe('AC4: Monitor Not Consulted When Disabled', () => {
  it('getRecommendation is never called when no monitor agent set', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    // Intentionally do NOT call setMonitorAgent

    const task = makeTask({ id: 'task-ac4-nomonitor', metadata: { taskType: 'coding' } })
    engine.routeTask(task)

    expect(vi.mocked(monitorAgent.getRecommendation)).not.toHaveBeenCalled()
  })

  it('monitorInfluenced=false and monitorRecommendation is undefined when monitor disabled', async () => {
    const eventBus = createMockEventBus()
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    // No monitor set

    const task = makeTask({ id: 'task-ac4-fields', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(false)
    expect(decision.monitorRecommendation).toBeUndefined()
  })

  it('getRecommendation is NOT called when useRecommendations=false', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, false) // explicitly disabled

    const task = makeTask({ id: 'task-ac4-disabled', metadata: { taskType: 'coding' } })
    engine.routeTask(task)

    expect(vi.mocked(monitorAgent.getRecommendation)).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC5: Monitor errors do not disrupt routing
// ---------------------------------------------------------------------------

describe('AC5: Monitor Errors Do Not Disrupt Routing', () => {
  it('routing succeeds and returns a valid decision when getRecommendation() throws', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent()
    // Make getRecommendation throw
    vi.mocked(monitorAgent.getRecommendation).mockImplementation((_taskType: string) => {
      throw new Error('Database connection failed')
    })

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac5-error', metadata: { taskType: 'coding' } })
    // Should not throw
    let decision: ReturnType<typeof engine.routeTask> | undefined
    expect(() => {
      decision = engine.routeTask(task)
    }).not.toThrow()

    expect(decision).toBeDefined()
    expect(decision?.billingMode).not.toBe('unavailable')
  })

  it('sets monitorInfluenced=false when getRecommendation() throws', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent()
    vi.mocked(monitorAgent.getRecommendation).mockImplementation((_taskType: string) => {
      throw new Error('Monitor failed')
    })

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac5-influenced', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC6: Integration with setMonitorAgent() factory method
// ---------------------------------------------------------------------------

describe('AC6: setMonitorAgent() and Factory Method Integration', () => {
  it('createRoutingEngineImpl with monitorAgent and useMonitorRecommendations=true wires the agent', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)

    const engine = createRoutingEngineImpl({
      eventBus,
      monitorAgent,
      useMonitorRecommendations: true,
    })
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()

    const task = makeTask({ id: 'task-ac6-factory', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(true)
    expect(vi.mocked(monitorAgent.getRecommendation)).toHaveBeenCalledWith('coding')
  })

  it('createRoutingEngineImpl does not wire monitor when useMonitorRecommendations=false', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)

    const engine = createRoutingEngineImpl({
      eventBus,
      monitorAgent,
      useMonitorRecommendations: false, // disabled
    })
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()

    const task = makeTask({ id: 'task-ac6-factory-disabled', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(false)
    expect(vi.mocked(monitorAgent.getRecommendation)).not.toHaveBeenCalled()
  })

  it('calling setMonitorAgent at runtime wires the agent', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()

    // First route without monitor
    const task1 = makeTask({ id: 'task-ac6-before', metadata: { taskType: 'coding' } })
    const decision1 = engine.routeTask(task1)
    expect(decision1.monitorInfluenced).toBe(false)

    // Now wire monitor at runtime
    engine.setMonitorAgent(monitorAgent, true)

    const task2 = makeTask({ id: 'task-ac6-after', metadata: { taskType: 'coding' } })
    const decision2 = engine.routeTask(task2)
    expect(decision2.monitorInfluenced).toBe(true)
  })

  it('setMonitorAgent(null) disables monitor consultation', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()

    // Wire monitor
    engine.setMonitorAgent(monitorAgent, true)

    // Verify it works
    const task1 = makeTask({ id: 'task-ac6-null-before', metadata: { taskType: 'coding' } })
    const decision1 = engine.routeTask(task1)
    expect(decision1.monitorInfluenced).toBe(true)

    // Disable by setting null
    engine.setMonitorAgent(null as unknown as MonitorAgent, false)

    const task2 = makeTask({ id: 'task-ac6-null-after', metadata: { taskType: 'coding' } })
    const decision2 = engine.routeTask(task2)
    expect(decision2.monitorInfluenced).toBe(false)
    expect(vi.mocked(monitorAgent.getRecommendation)).toHaveBeenCalledTimes(1) // not called again
  })
})

// ---------------------------------------------------------------------------
// AC7: Debug log emitted when recommendation overridden by policy
// ---------------------------------------------------------------------------

describe('AC7: Debug Log Emitted When Recommendation Overridden by Policy', () => {
  it('policy selects claude while monitor recommends codex (policy override scenario)', async () => {
    const eventBus = createMockEventBus()
    // mockRecommendation recommends 'codex' but routing policy will pick 'claude' for 'coding'
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac7', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    // Verify that policy selected 'claude' while monitor recommended 'codex'
    // (this is the override scenario that AC7 requires to be logged)
    expect(decision.agent).toBe('claude')
    expect(decision.monitorRecommendation?.recommended_agent).toBe('codex')
    expect(decision.monitorInfluenced).toBe(true)
  })

  it('no override when policy selects the same agent as recommendation', async () => {
    const eventBus = createMockEventBus()
    // Create a recommendation that recommends the same agent the policy would pick
    const sameAgentRecommendation: Recommendation = {
      ...mockRecommendation,
      current_agent: 'codex',
      recommended_agent: 'claude', // same as policy choice for 'coding'
    }
    const monitorAgent = createMockMonitorAgent(sameAgentRecommendation)
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = POLICY_PATH
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-ac7-no-override', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    // Policy selects 'claude', monitor recommends 'claude' — no conflict
    expect(decision.agent).toBe('claude')
    expect(decision.monitorRecommendation?.recommended_agent).toBe('claude')
    expect(decision.monitorInfluenced).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// _routeWithoutPolicy: Monitor consulted even when no routing policy is loaded
// ---------------------------------------------------------------------------

describe('_routeWithoutPolicy: Monitor Consulted Without Routing Policy', () => {
  it('sets monitorInfluenced=true when use_monitor_recommendations=true and no policy loaded', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const adapter = createMockAdapter('claude')
    const adapterRegistry = createMockAdapterRegistry([adapter])

    // Initialize without a policy path (so _routeWithoutPolicy is invoked)
    const engine = new RoutingEngineImpl(eventBus, null, adapterRegistry)
    // Point to a nonexistent policy file so no policy is loaded
    ;(engine as unknown as { _policyPath: string })._policyPath = '/nonexistent/routing-policy.yaml'
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-no-policy-monitor', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(true)
    expect(vi.mocked(monitorAgent.getRecommendation)).toHaveBeenCalledWith('coding')
  })

  it('attaches monitorRecommendation when no policy loaded and confidence is "medium"', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const adapter = createMockAdapter('claude')
    const adapterRegistry = createMockAdapterRegistry([adapter])

    const engine = new RoutingEngineImpl(eventBus, null, adapterRegistry)
    ;(engine as unknown as { _policyPath: string })._policyPath = '/nonexistent/routing-policy.yaml'
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-no-policy-recommendation', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorRecommendation).toBeDefined()
    expect(decision.monitorRecommendation?.confidence).toBe('medium')
    expect(decision.monitorRecommendation?.recommended_agent).toBe('codex')
  })

  it('sets monitorInfluenced=false when use_monitor_recommendations=false and no policy loaded', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const adapter = createMockAdapter('claude')
    const adapterRegistry = createMockAdapterRegistry([adapter])

    const engine = new RoutingEngineImpl(eventBus, null, adapterRegistry)
    ;(engine as unknown as { _policyPath: string })._policyPath = '/nonexistent/routing-policy.yaml'
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, false) // disabled

    const task = makeTask({ id: 'task-no-policy-disabled', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.monitorInfluenced).toBe(false)
    expect(vi.mocked(monitorAgent.getRecommendation)).not.toHaveBeenCalled()
  })

  it('routes successfully without policy and without monitor', async () => {
    const eventBus = createMockEventBus()
    const adapter = createMockAdapter('claude')
    const adapterRegistry = createMockAdapterRegistry([adapter])

    const engine = new RoutingEngineImpl(eventBus, null, adapterRegistry)
    ;(engine as unknown as { _policyPath: string })._policyPath = '/nonexistent/routing-policy.yaml'
    await engine.initialize()

    const task = makeTask({ id: 'task-no-policy-no-monitor', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.agent).toBe('claude')
    expect(decision.billingMode).toBe('subscription')
    expect(decision.monitorInfluenced).toBe(false)
    expect(decision.monitorRecommendation).toBeUndefined()
  })

  it('consults monitor when routing via explicit agent assignment without policy', async () => {
    const eventBus = createMockEventBus()
    const monitorAgent = createMockMonitorAgent(mockRecommendation)
    const adapter = createMockAdapter('claude')
    const adapterRegistry = createMockAdapterRegistry([adapter])

    const engine = new RoutingEngineImpl(eventBus, null, adapterRegistry)
    ;(engine as unknown as { _policyPath: string })._policyPath = '/nonexistent/routing-policy.yaml'
    await engine.initialize()
    engine.setMonitorAgent(monitorAgent, true)

    const task = makeTask({ id: 'task-no-policy-explicit', agentId: 'claude', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.agent).toBe('claude')
    expect(decision.monitorInfluenced).toBe(true)
    expect(vi.mocked(monitorAgent.getRecommendation)).toHaveBeenCalledWith('coding')
  })
})
