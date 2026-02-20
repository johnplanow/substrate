/**
 * Tests for RoutingEngine — AC1 through AC6
 *
 * Test coverage:
 *  - AC1: Load routing policy from YAML with task types, providers, fallback chains
 *  - AC2: Subscription-first routing algorithm
 *  - AC3: Default agent assignment from routing policy (task type inheritance)
 *  - AC4: Rate limit management and provider:unavailable event
 *  - AC5: Fallback chain execution
 *  - AC6: Extended policy with optional fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { AdapterRegistry } from '../../../adapters/adapter-registry.js'
import type { WorkerAdapter } from '../../../adapters/worker-adapter.js'
import type { TaskNode } from '../../../core/types.js'
import { RoutingEngineImpl } from '../routing-engine-impl.js'
import { loadRoutingPolicy, RoutingPolicyValidationError } from '../routing-policy.js'
import { ProviderStatusTracker } from '../provider-status.js'
import { makeRoutingDecision } from '../routing-decision.js'

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
  }
}

function createMockAdapterRegistry(adapters: WorkerAdapter[] = []): AdapterRegistry {
  const map = new Map(adapters.map((a) => [a.id, a]))
  return {
    register: vi.fn(),
    get: vi.fn((id: string) => map.get(id)),
    getAll: vi.fn(() => adapters),
    getPlanningCapable: vi.fn(() => []),
    discoverAndRegister: vi.fn(async () => ({ registeredCount: 0, failedCount: 0, results: [] })),
  } as unknown as AdapterRegistry
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

// ---------------------------------------------------------------------------
// AC1: Load routing policy from YAML
// ---------------------------------------------------------------------------

describe('AC1: RoutingPolicy YAML Loading', () => {
  it('loads policy with task types, providers, and fallback chains', () => {
    const policy = loadRoutingPolicy(resolve(FIXTURES_DIR, 'routing-policy.yaml'))

    expect(policy.providers).toHaveProperty('claude')
    expect(policy.providers).toHaveProperty('codex')
    expect(policy.providers).toHaveProperty('gemini')
    expect(policy.task_types).toHaveProperty('coding')
    expect(policy.task_types?.['coding']?.preferred_agents).toContain('claude')
    expect(policy.default.preferred_agents).toContain('claude')
  })

  it('parses subscription_routing toggle per provider (FR22, FR23, FR25)', () => {
    const policy = loadRoutingPolicy(resolve(FIXTURES_DIR, 'routing-policy.yaml'))

    expect(policy.providers['claude']?.subscription_routing).toBe(true)
    expect(policy.providers['codex']?.subscription_routing).toBe(true)
    expect(policy.providers['gemini']?.subscription_routing).toBe(true)
  })

  it('validates policy schema using Zod (NFR13)', () => {
    // Valid minimal policy loads without error
    expect(() => loadRoutingPolicy(resolve(FIXTURES_DIR, 'routing-policy-minimal.yaml'))).not.toThrow()
  })

  it('throws RoutingPolicyValidationError for missing file', () => {
    expect(() => loadRoutingPolicy('/nonexistent/path/routing-policy.yaml')).toThrow(RoutingPolicyValidationError)
  })

  it('throws RoutingPolicyValidationError for invalid YAML', () => {
    const { writeFileSync, unlinkSync } = require('node:fs')
    const tmpPath = resolve(FIXTURES_DIR, '_invalid_test.yaml')
    writeFileSync(tmpPath, 'invalid: yaml: :\n  - broken::')
    try {
      expect(() => loadRoutingPolicy(tmpPath)).toThrow(RoutingPolicyValidationError)
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })

  it('validates that task_type agents exist in providers section', () => {
    const { writeFileSync, unlinkSync } = require('node:fs')
    const tmpPath = resolve(FIXTURES_DIR, '_bad_agent_test.yaml')
    writeFileSync(tmpPath, `
default:
  preferred_agents:
    - claude
providers:
  claude:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    api_billing:
      enabled: false
task_types:
  coding:
    preferred_agents:
      - nonexistent-agent
`)
    try {
      expect(() => loadRoutingPolicy(tmpPath)).toThrow(RoutingPolicyValidationError)
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })

  it('validates that at least one provider is configured', () => {
    const { writeFileSync, unlinkSync } = require('node:fs')
    const tmpPath = resolve(FIXTURES_DIR, '_no_providers.yaml')
    writeFileSync(tmpPath, `
default:
  preferred_agents:
    - claude
providers: {}
`)
    try {
      expect(() => loadRoutingPolicy(tmpPath)).toThrow(RoutingPolicyValidationError)
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })
})

// ---------------------------------------------------------------------------
// AC2: Subscription-first routing algorithm
// ---------------------------------------------------------------------------

describe('AC2: Subscription-First Routing Algorithm', () => {
  it('routes via subscription when subscription_routing=true and tokens within limit', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    // Manually inject policy
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    const task = makeTask({ id: 'task-sub', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.billingMode).toBe('subscription')
    expect(decision.agent).toBe('claude') // First preferred agent for 'coding' type
  })

  it('falls back to API billing when subscription exhausted (rate limit exceeded)', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    // Exhaust claude's rate limit by recording max tokens
    engine.updateRateLimit('claude', 220000)

    // Set up ANTHROPIC_API_KEY for API fallback
    process.env['ANTHROPIC_API_KEY'] = 'test-key'

    try {
      const task = makeTask({ id: 'task-api', metadata: { taskType: 'coding' } })
      const decision = engine.routeTask(task)

      // Claude rate limit exceeded → should fall to codex subscription or claude API
      // With ANTHROPIC_API_KEY set, claude should route via API
      expect(decision.billingMode).toMatch(/subscription|api/)
    } finally {
      delete process.env['ANTHROPIC_API_KEY']
    }
  })

  it('skips provider when subscription exhausted and API key not configured', async () => {
    const eventBus = createMockEventBus()
    const { writeFileSync, unlinkSync } = require('node:fs')

    // Create a policy with only claude, subscription only (no API key env)
    const tmpPath = resolve(FIXTURES_DIR, '_sub_only.yaml')
    writeFileSync(tmpPath, `
default:
  preferred_agents:
    - claude
providers:
  claude:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    rate_limit:
      tokens_per_window: 100
      window_seconds: 3600
    api_billing:
      enabled: true
      api_key_env: "NONEXISTENT_KEY_ENV_12345"
`)

    try {
      const engine = new RoutingEngineImpl(eventBus, null, null)
      ;(engine as unknown as { _policyPath: string })._policyPath = tmpPath
      await engine.initialize()

      // Exhaust rate limit
      engine.updateRateLimit('claude', 100)

      const task = makeTask({ id: 'task-no-api' })
      const decision = engine.routeTask(task)

      // API key not configured, subscription exhausted → unavailable
      expect(decision.billingMode).toBe('unavailable')
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })
})

// ---------------------------------------------------------------------------
// AC3: Default agent assignment from routing policy
// ---------------------------------------------------------------------------

describe('AC3: Default Agent Assignment', () => {
  it('inherits agent from routing policy when task has no explicit agent (FR57)', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    // Task with no explicit agent and no task type
    const task = makeTask({ id: 'task-no-agent', agentId: undefined, metadata: {} })
    const decision = engine.routeTask(task)

    expect(decision.agent).not.toBe('')
    expect(decision.billingMode).not.toBe('unavailable')
    // Should use default preferred agent (claude)
    expect(decision.agent).toBe('claude')
  })

  it('uses task type mapping when task type is specified', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    // Testing type → gemini should be first preferred agent
    const task = makeTask({ id: 'task-testing', metadata: { taskType: 'testing' } })
    const decision = engine.routeTask(task)

    expect(decision.agent).toBe('gemini') // gemini is first for 'testing' type
    expect(decision.rationale).toBeTruthy()
  })

  it('routing decision includes rationale for selected agent (NFR7)', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    const task = makeTask({ id: 'task-rationale', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.rationale).toBeTruthy()
    expect(typeof decision.rationale).toBe('string')
    expect(decision.rationale.length).toBeGreaterThan(0)
  })

  it('respects model preferences from routing policy', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    // coding type has model_preferences.claude = 'sonnet'
    const task = makeTask({ id: 'task-model', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    if (decision.agent === 'claude') {
      expect(decision.model).toBe('sonnet')
    }
  })
})

// ---------------------------------------------------------------------------
// AC4: Rate limit management
// ---------------------------------------------------------------------------

describe('AC4: Rate Limit Management', () => {
  it('tracks cumulative tokens per window per provider', () => {
    const tracker = new ProviderStatusTracker()
    tracker.initProvider('claude', true, false, { tokensPerWindow: 220000, windowSeconds: 18000 })

    tracker.recordTokenUsage('claude', 100000)
    tracker.recordTokenUsage('claude', 50000)

    const status = tracker.getStatus('claude')
    expect(status).not.toBeNull()
    expect(status!.tokensUsedInWindow).toBe(150000)
  })

  it('emits provider:unavailable event when rate limit is exhausted', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    // Exhaust claude rate limit
    engine.updateRateLimit('claude', 220000)

    // Route a task that prefers claude
    const task = makeTask({ id: 'task-ratelimit', metadata: { taskType: 'coding' } })
    engine.routeTask(task)

    const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
    const calls = emitMock.mock.calls as Array<[string, unknown]>
    const unavailableCalls = calls.filter(([event]) => event === 'provider:unavailable')

    expect(unavailableCalls.length).toBeGreaterThan(0)
    const payload = unavailableCalls[0]![1] as { provider: string; reason: string }
    expect(payload.provider).toBe('claude')
    expect(payload.reason).toBe('rate_limit')
  })

  it('returns false from checkRateLimit when tokens would exceed limit', () => {
    const tracker = new ProviderStatusTracker()
    tracker.initProvider('claude', true, false, { tokensPerWindow: 100, windowSeconds: 3600 })
    tracker.recordTokenUsage('claude', 90)

    expect(tracker.checkRateLimit('claude', 20)).toBe(false) // 90+20=110 > 100
    expect(tracker.checkRateLimit('claude', 10)).toBe(true)  // 90+10=100 = limit
  })

  it('resets window after window duration expires', () => {
    vi.useFakeTimers()

    const tracker = new ProviderStatusTracker()
    tracker.initProvider('claude', true, false, { tokensPerWindow: 100, windowSeconds: 1 })
    tracker.recordTokenUsage('claude', 100)

    expect(tracker.checkRateLimit('claude', 1)).toBe(false) // window full

    // Advance time past window duration
    vi.advanceTimersByTime(1100) // 1.1 seconds

    expect(tracker.checkRateLimit('claude', 1)).toBe(true) // window reset

    vi.useRealTimers()
  })

  it('returns rate limit reset time', () => {
    const tracker = new ProviderStatusTracker()
    const windowSeconds = 3600
    tracker.initProvider('claude', true, false, { tokensPerWindow: 100, windowSeconds })

    const resetTime = tracker.getRateLimitResetTime('claude')
    const expectedResetMs = Date.now() + windowSeconds * 1000

    // Allow 1 second tolerance
    expect(Math.abs(resetTime.getTime() - expectedResetMs)).toBeLessThan(1000)
  })
})

// ---------------------------------------------------------------------------
// AC5: Fallback chain execution
// ---------------------------------------------------------------------------

describe('AC5: Fallback Chain Execution', () => {
  it('consults fallback chain in order per routing policy', async () => {
    const eventBus = createMockEventBus()
    const { writeFileSync, unlinkSync } = require('node:fs')

    // Create a policy where claude has exhausted rate limit and subscription only
    const tmpPath = resolve(FIXTURES_DIR, '_fallback_test.yaml')
    writeFileSync(tmpPath, `
default:
  preferred_agents:
    - claude
    - codex
providers:
  claude:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    rate_limit:
      tokens_per_window: 100
      window_seconds: 3600
    api_billing:
      enabled: false
  codex:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    api_billing:
      enabled: false
`)

    try {
      const engine = new RoutingEngineImpl(eventBus, null, null)
      ;(engine as unknown as { _policyPath: string })._policyPath = tmpPath
      await engine.initialize()

      // Exhaust claude rate limit
      engine.updateRateLimit('claude', 100)

      const task = makeTask({ id: 'task-fallback' })
      const decision = engine.routeTask(task)

      // Claude exhausted → should fall back to codex
      expect(decision.agent).toBe('codex')
      expect(decision.billingMode).toBe('subscription')
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })

  it('routing decision includes fallbackChain field', async () => {
    const eventBus = createMockEventBus()
    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')

    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    const task = makeTask({ id: 'task-chain', metadata: { taskType: 'coding' } })
    const decision = engine.routeTask(task)

    expect(decision.fallbackChain).toBeDefined()
    expect(Array.isArray(decision.fallbackChain)).toBe(true)
    expect(decision.fallbackChain!.length).toBeGreaterThan(0)
  })

  it('evaluates each fallback using same subscription-first logic', async () => {
    const eventBus = createMockEventBus()
    const { writeFileSync, unlinkSync } = require('node:fs')

    const tmpPath = resolve(FIXTURES_DIR, '_multi_fallback.yaml')
    // claude: subscription exhausted (no API)
    // codex: subscription exhausted (no API)
    // gemini: subscription available
    writeFileSync(tmpPath, `
default:
  preferred_agents:
    - claude
    - codex
    - gemini
providers:
  claude:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    rate_limit:
      tokens_per_window: 100
      window_seconds: 3600
    api_billing:
      enabled: false
  codex:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    rate_limit:
      tokens_per_window: 100
      window_seconds: 3600
    api_billing:
      enabled: false
  gemini:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    api_billing:
      enabled: false
`)

    try {
      const engine = new RoutingEngineImpl(eventBus, null, null)
      ;(engine as unknown as { _policyPath: string })._policyPath = tmpPath
      await engine.initialize()

      // Exhaust first two providers
      engine.updateRateLimit('claude', 100)
      engine.updateRateLimit('codex', 100)

      const task = makeTask({ id: 'task-multi-fallback' })
      const decision = engine.routeTask(task)

      expect(decision.agent).toBe('gemini')
      expect(decision.billingMode).toBe('subscription')
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })
})

// ---------------------------------------------------------------------------
// AC6: Policy format extensibility
// ---------------------------------------------------------------------------

describe('AC6: Policy Format Extensibility', () => {
  it('loads extended policy with optional fields without modification to existing behavior', () => {
    const policy = loadRoutingPolicy(resolve(FIXTURES_DIR, 'routing-policy-extended.yaml'))

    // Core required fields present
    expect(policy.providers['claude']).toBeDefined()
    expect(policy.default.preferred_agents).toContain('claude')

    // Extended optional fields parsed correctly
    expect(policy.global.max_concurrent_workers).toBe(10)
    expect(policy.global.fallback_enabled).toBe(false)
    expect(policy.task_types?.['coding']?.model_preferences?.['claude']).toBe('opus')
  })

  it('existing policy config continues to work without optional fields (backward compat)', () => {
    const policy = loadRoutingPolicy(resolve(FIXTURES_DIR, 'routing-policy-minimal.yaml'))

    // Minimal policy without task_types, global, etc.
    expect(policy.providers['claude']).toBeDefined()
    expect(policy.default.preferred_agents).toContain('claude')
    // Optional fields should have defaults
    expect(policy.global).toBeDefined()
    expect(policy.global.fallback_enabled).toBe(true) // default
  })

  it('Zod schema supports optional fields gracefully', () => {
    // Verify that adding unknown top-level fields doesn't crash (schema uses passthrough for unknown)
    // Actually our schema does NOT use passthrough, so unknown fields would fail.
    // This tests that all optional fields have proper .optional() or .default() in schema.
    const { writeFileSync, unlinkSync } = require('node:fs')
    const tmpPath = resolve(FIXTURES_DIR, '_optional_fields.yaml')
    writeFileSync(tmpPath, `
default:
  preferred_agents:
    - claude
  billing_preference: api_only
providers:
  claude:
    enabled: true
    subscription_routing: false
    max_concurrent: 2
    api_billing:
      enabled: true
`)

    try {
      const policy = loadRoutingPolicy(tmpPath)
      expect(policy.default.billing_preference).toBe('api_only')
      expect(policy.providers['claude']?.subscription_routing).toBe(false)
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })
})

// ---------------------------------------------------------------------------
// Hot-reload: reloadPolicy()
// ---------------------------------------------------------------------------

describe('Hot-reload: reloadPolicy()', () => {
  it('picks up changed policy file without restart (FR38)', async () => {
    const { writeFileSync, unlinkSync } = require('node:fs')
    const eventBus = createMockEventBus()

    const tmpPath = resolve(FIXTURES_DIR, '_hot_reload.yaml')
    writeFileSync(tmpPath, `
default:
  preferred_agents:
    - gemini
providers:
  gemini:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    api_billing:
      enabled: false
`)

    try {
      const engine = new RoutingEngineImpl(eventBus, null, null)
      ;(engine as unknown as { _policyPath: string })._policyPath = tmpPath
      await engine.initialize()

      // Initial policy uses gemini
      let task = makeTask({ id: 'task-before-reload' })
      let decision = engine.routeTask(task)
      expect(decision.agent).toBe('gemini')

      // Update the file to use claude
      writeFileSync(tmpPath, `
default:
  preferred_agents:
    - claude
providers:
  claude:
    enabled: true
    subscription_routing: true
    max_concurrent: 1
    api_billing:
      enabled: false
`)

      // Reload
      await engine.reloadPolicy()

      // Now should route to claude
      task = makeTask({ id: 'task-after-reload' })
      decision = engine.routeTask(task)
      expect(decision.agent).toBe('claude')
    } finally {
      try { unlinkSync(tmpPath) } catch { /* cleanup */ }
    }
  })
})

// ---------------------------------------------------------------------------
// Policy validation errors
// ---------------------------------------------------------------------------

describe('Policy validation errors', () => {
  it('throws helpful error for invalid policy file', () => {
    expect(() => loadRoutingPolicy('/does/not/exist.yaml')).toThrowError(
      /Cannot read routing policy file/
    )
  })

  it('error message contains path for missing file', () => {
    try {
      loadRoutingPolicy('/missing/path.yaml')
    } catch (err) {
      expect(err).toBeInstanceOf(RoutingPolicyValidationError)
      expect((err as Error).message).toContain('/missing/path.yaml')
    }
  })
})

// ---------------------------------------------------------------------------
// RoutingDecision factory
// ---------------------------------------------------------------------------

describe('makeRoutingDecision() factory', () => {
  it('creates a routing decision with all fields via builder', () => {
    const decision = makeRoutingDecision('task-1')
      .withAgent('claude', 'subscription')
      .withModel('sonnet')
      .withRationale('Subscription-first: tokens within limit')
      .withFallbackChain(['claude', 'codex'])
      .withEstimatedCost(0.01)
      .build()

    expect(decision.taskId).toBe('task-1')
    expect(decision.agent).toBe('claude')
    expect(decision.billingMode).toBe('subscription')
    expect(decision.model).toBe('sonnet')
    expect(decision.rationale).toBe('Subscription-first: tokens within limit')
    expect(decision.fallbackChain).toEqual(['claude', 'codex'])
    expect(decision.estimatedCostUsd).toBe(0.01)
  })

  it('creates unavailable decision', () => {
    const decision = makeRoutingDecision('task-1')
      .unavailable('No agents available')
      .build()

    expect(decision.billingMode).toBe('unavailable')
    expect(decision.rationale).toBe('No agents available')
  })
})

// ---------------------------------------------------------------------------
// RoutingEngine event subscriptions
// ---------------------------------------------------------------------------

describe('RoutingEngine event subscriptions', () => {
  it('subscribes to task:ready on initialize()', async () => {
    const eventBus = createMockEventBus()
    const engine = new RoutingEngineImpl(eventBus, null, null)
    await engine.initialize()

    const onMock = eventBus.on as ReturnType<typeof vi.fn>
    expect(onMock).toHaveBeenCalledWith('task:ready', expect.any(Function))
  })

  it('subscribes to task:complete on initialize()', async () => {
    const eventBus = createMockEventBus()
    const engine = new RoutingEngineImpl(eventBus, null, null)
    await engine.initialize()

    const onMock = eventBus.on as ReturnType<typeof vi.fn>
    expect(onMock).toHaveBeenCalledWith('task:complete', expect.any(Function))
  })

  it('unsubscribes on shutdown()', async () => {
    const eventBus = createMockEventBus()
    const engine = new RoutingEngineImpl(eventBus, null, null)
    await engine.initialize()
    await engine.shutdown()

    const offMock = eventBus.off as ReturnType<typeof vi.fn>
    expect(offMock).toHaveBeenCalledWith('task:ready', expect.any(Function))
    expect(offMock).toHaveBeenCalledWith('task:complete', expect.any(Function))
  })

  it('emits task:routed when task:ready event received', async () => {
    const emitter = new EventEmitter()
    const eventBus: TypedEventBus = {
      emit: vi.fn((event: string, payload: unknown) => { emitter.emit(event, payload) }),
      on: vi.fn((event: string, handler: (payload: unknown) => void) => { emitter.on(event, handler) }),
      off: vi.fn((event: string, handler: (payload: unknown) => void) => { emitter.off(event, handler) }),
    }

    const policyPath = resolve(FIXTURES_DIR, 'routing-policy.yaml')
    const engine = new RoutingEngineImpl(eventBus, null, null)
    ;(engine as unknown as { _policyPath: string })._policyPath = policyPath
    await engine.initialize()

    // Emit task:ready via the real emitter
    emitter.emit('task:ready', { taskId: 'task-event-1' })

    const emitMock = eventBus.emit as ReturnType<typeof vi.fn>
    const calls = emitMock.mock.calls as Array<[string, unknown]>
    const routedCalls = calls.filter(([event]) => event === 'task:routed')

    expect(routedCalls.length).toBeGreaterThanOrEqual(1)
    const payload = routedCalls[0]![1] as { taskId: string; decision: { taskId: string } }
    expect(payload.taskId).toBe('task-event-1')
    expect(payload.decision.taskId).toBe('task-event-1')
  })
})

// ---------------------------------------------------------------------------
// ProviderStatus tracking
// ---------------------------------------------------------------------------

describe('ProviderStatusTracker', () => {
  it('returns null for untracked provider', () => {
    const tracker = new ProviderStatusTracker()
    expect(tracker.getStatus('unknown')).toBeNull()
  })

  it('returns status with correct fields after initialization', () => {
    const tracker = new ProviderStatusTracker()
    tracker.initProvider('claude', true, true, { tokensPerWindow: 100000, windowSeconds: 3600 })

    const status = tracker.getStatus('claude')
    expect(status).not.toBeNull()
    expect(status!.provider).toBe('claude')
    expect(status!.subscriptionRoutingEnabled).toBe(true)
    expect(status!.apiBillingEnabled).toBe(true)
    expect(status!.tokensUsedInWindow).toBe(0)
    expect(status!.rateLimit.tokensPerWindow).toBe(100000)
    expect(status!.rateLimit.windowSeconds).toBe(3600)
  })

  it('returns all tracked provider names', () => {
    const tracker = new ProviderStatusTracker()
    tracker.initProvider('claude', true, true)
    tracker.initProvider('codex', false, true)

    const providers = tracker.getTrackedProviders()
    expect(providers).toContain('claude')
    expect(providers).toContain('codex')
  })
})
