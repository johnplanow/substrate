/**
 * AC7 — createRoutingEngine imported from @substrate-ai/core (end-to-end)
 *
 * Validates that the package-level export of createRoutingEngine produces a
 * fully functional RoutingEngine that routes tasks and returns a RoutingDecision
 * with a non-empty rationale field, as required by Story 41-4 AC7.
 *
 * All imports intentionally originate from '@substrate-ai/core' to exercise the
 * package export surface (not the monolith shim paths).
 */

import { describe, it, expect, afterEach } from 'vitest'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  createRoutingEngine,
  createRoutingEngineImpl,
  createEventBus,
} from '@substrate-ai/core'
import type {
  CoreEvents,
  IAdapterRegistry,
  IConfigSystem,
  RoutingTask,
  RoutingEngineImpl,
} from '@substrate-ai/core'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = resolve(__dirname, 'fixtures')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAdapterRegistry(ids: string[] = ['claude']): IAdapterRegistry {
  return {
    get: (_id: string) => undefined,
    getAll: () => ids.map((id) => ({ id })),
  }
}

function makeConfigSystem(policyPath: string): IConfigSystem {
  return {
    get(key: string): unknown {
      if (key === 'routing_policy_path') return policyPath
      return undefined
    },
  }
}

// ---------------------------------------------------------------------------
// AC7: createRoutingEngine produces a RoutingDecision with non-empty rationale
// ---------------------------------------------------------------------------

describe('AC7: createRoutingEngine exported from @substrate-ai/core', () => {
  let engine: RoutingEngineImpl | null = null

  afterEach(async () => {
    if (engine !== null) {
      await engine.shutdown()
      engine = null
    }
  })

  it('createRoutingEngine is importable from @substrate-ai/core', () => {
    // Verify the factory function itself is exported and callable
    expect(typeof createRoutingEngine).toBe('function')
  })

  it('returns a RoutingEngine that produces a RoutingDecision with non-empty rationale (no-policy fallback)', () => {
    // Arrange: no policy configured — engine falls back to adapterRegistry
    const eventBus = createEventBus<CoreEvents>()
    const adapterRegistry = makeAdapterRegistry(['claude'])

    const routingEngine = createRoutingEngine({ eventBus, adapterRegistry })

    // Act
    const task: RoutingTask = { id: 'task-ac7-nopolicy', type: 'dev-story' }
    const decision = routingEngine.routeTask(task)

    // Assert — AC7: rationale must be non-empty
    expect(decision.taskId).toBe('task-ac7-nopolicy')
    expect(typeof decision.rationale).toBe('string')
    expect(decision.rationale.length).toBeGreaterThan(0)
  })

  it('returns a RoutingEngine that produces a RoutingDecision with non-empty rationale (policy loaded)', async () => {
    // Arrange: provide a valid policy path via IConfigSystem so the policy is loaded
    const eventBus = createEventBus<CoreEvents>()
    const adapterRegistry = makeAdapterRegistry(['claude'])
    const configSystem = makeConfigSystem(resolve(FIXTURES_DIR, 'routing-policy-minimal.yaml'))

    engine = createRoutingEngineImpl({ eventBus, adapterRegistry, configSystem })
    await engine.initialize()

    // Act
    const task: RoutingTask = { id: 'task-ac7-policy', type: 'dev-story' }
    const decision = engine.routeTask(task)

    // Assert — AC7: rationale must be non-empty; agent and billingMode must be set
    expect(decision.taskId).toBe('task-ac7-policy')
    expect(typeof decision.rationale).toBe('string')
    expect(decision.rationale.length).toBeGreaterThan(0)
    expect(decision.agent).toBeTruthy()
    expect(['subscription', 'api', 'unavailable']).toContain(decision.billingMode)
  })
})
