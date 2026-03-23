/**
 * End-to-end assembly tests for Epic 47 — Digital Twin Foundation.
 *
 * Assembles all Epic 47 components in a single test environment:
 *  - TwinRegistry (in-memory, mock coordinator)
 *  - TwinPersistenceCoordinator → MemoryDatabaseAdapter
 *  - TwinHealthMonitor (no real health URL — no timers fired)
 *  - ScenarioRunner with injected twinCoordinator and twinHealthMonitor
 *
 * Verifies:
 *  1. Full pipeline — scenario passes, twin:stopped persisted to DB
 *  2. Full pipeline — scenario fails, stop still called
 *  3. No twins in manifest — no coordinator methods called
 *
 * Story 47-8, Task 5 (AC6).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createDatabaseAdapter, TypedEventBusImpl } from '@substrate-ai/core'
import type { DatabaseAdapter, TypedEventBus } from '@substrate-ai/core'
import { factorySchema } from '../../../persistence/factory-schema.js'
import { createTwinPersistenceCoordinator, getTwinRunsForRun } from '../../persistence.js'
import { createTwinHealthMonitor } from '../../health-monitor.js'
import type { TwinDefinition } from '../../index.js'
import { createScenarioRunner } from '../../../scenarios/runner.js'
import type { TwinCoordinator } from '../../../scenarios/runner.js'
import type { FactoryEvents } from '../../../events.js'
import { makeMockTwinManager, makeTmpScenario } from './helpers.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush async event-bus handlers by yielding to the macrotask queue. */
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A TwinDefinition without a healthcheck URL — prevents health monitor from scheduling polls. */
function makeLocalstackNoHealthcheck(): TwinDefinition {
  return {
    name: 'localstack',
    image: 'localstack/localstack:latest',
    ports: [{ host: 4566, container: 4566 }],
    environment: { SERVICES: 's3' },
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let adapter: DatabaseAdapter
let eventBus: TypedEventBus<FactoryEvents>
let cleanupFn: (() => void) | null = null
const TEST_RUN_ID = 'e2e-run-001'

beforeEach(async () => {
  adapter = createDatabaseAdapter({ backend: 'memory' })
  await factorySchema(adapter)
  eventBus = new TypedEventBusImpl<FactoryEvents>()
  createTwinPersistenceCoordinator(adapter, eventBus)
  cleanupFn = null
})

afterEach(() => {
  cleanupFn?.()
  cleanupFn = null
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('e2e assembly — all Epic 47 components', () => {
  it('Test 1 — full pipeline, scenario passes, twin:stopped persisted to DB', async () => {
    const mockManager = makeMockTwinManager()

    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockImplementation(async () => {
        await (mockManager.start as ReturnType<typeof vi.fn>)([])
        // Emit twin:started so TwinPersistenceCoordinator can insert the run record
        eventBus.emit('twin:started', {
          twinName: 'localstack',
          ports: [{ host: 4566, container: 4566 }],
          healthStatus: 'healthy',
          runId: TEST_RUN_ID,
        })
        return { LOCALSTACK_URL: 'http://localhost:4566' }
      }),
      stopTwins: vi.fn().mockImplementation(async () => {
        await (mockManager.stop as ReturnType<typeof vi.fn>)()
      }),
    }

    // Real health monitor with no health URL — no intervals scheduled
    const healthMonitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 60000 })
    healthMonitor.start([makeLocalstackNoHealthcheck()])

    const runner = createScenarioRunner({
      twinCoordinator: coordinator,
      twinHealthMonitor: healthMonitor,
    })

    const { manifest, cleanup } = makeTmpScenario(['localstack'], 0)
    cleanupFn = cleanup

    const result = await runner.run(manifest, process.cwd())
    expect(result.summary.passed).toBe(1)

    // Wait for insertTwinRun to complete (fired by twin:started during startTwins)
    await nextTick()

    // Manually emit twin:stopped (simulating what a real TwinManager.stop() would emit)
    eventBus.emit('twin:stopped', { twinName: 'localstack' })
    await nextTick()

    const summaries = await getTwinRunsForRun(adapter, TEST_RUN_ID)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.status).toBe('stopped')

    healthMonitor.stop()
  })

  it('Test 2 — full pipeline, scenario fails, stopTwins still called once', async () => {
    const mockManager = makeMockTwinManager()

    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockImplementation(async () => {
        await (mockManager.start as ReturnType<typeof vi.fn>)([])
        return {}
      }),
      stopTwins: vi.fn().mockImplementation(async () => {
        await (mockManager.stop as ReturnType<typeof vi.fn>)()
      }),
    }

    const healthMonitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 60000 })
    healthMonitor.start([makeLocalstackNoHealthcheck()])

    const runner = createScenarioRunner({
      twinCoordinator: coordinator,
      twinHealthMonitor: healthMonitor,
    })

    const { manifest, cleanup } = makeTmpScenario(['localstack'], 1)
    cleanupFn = cleanup

    const result = await runner.run(manifest, process.cwd())

    expect(result.summary.failed).toBe(1)
    expect(mockManager.stop).toHaveBeenCalledTimes(1)

    healthMonitor.stop()
  })

  it('Test 3 — no twins in manifest, no coordinator methods called', async () => {
    const mockManager = makeMockTwinManager()

    const coordinator: TwinCoordinator = {
      startTwins: vi.fn().mockResolvedValue({}),
      stopTwins: vi.fn().mockResolvedValue(undefined),
    }

    const healthMonitor = createTwinHealthMonitor(eventBus, { monitorIntervalMs: 60000 })

    const runner = createScenarioRunner({
      twinCoordinator: coordinator,
      twinHealthMonitor: healthMonitor,
    })

    // Manifest with no twins field
    const { manifest, cleanup } = makeTmpScenario(undefined, 0)
    cleanupFn = cleanup

    const result = await runner.run(manifest, process.cwd())

    expect(result.summary.total).toBe(1)
    expect(mockManager.start).not.toHaveBeenCalled()
    expect(mockManager.stop).not.toHaveBeenCalled()
    expect(coordinator.startTwins).not.toHaveBeenCalled()
    expect(coordinator.stopTwins).not.toHaveBeenCalled()

    healthMonitor.stop()
  })
})
