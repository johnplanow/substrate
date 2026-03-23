/**
 * Integration tests for TwinPersistenceCoordinator with real event bus and MemoryDatabaseAdapter.
 *
 * Verifies:
 *  1. twin:started event causes insertTwinRun row with status 'running'
 *  2. twin:stopped event updates row to status 'stopped' with non-null stopped_at
 *  3. ports are serialized and deserialized correctly
 *  4. health failures accumulate via recordTwinHealthFailure
 *  5. multiple twins in one run are each tracked separately
 *
 * Story 47-8, Task 4 (AC4, AC5).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabaseAdapter, TypedEventBusImpl } from '@substrate-ai/core'
import type { DatabaseAdapter, TypedEventBus } from '@substrate-ai/core'
import { factorySchema } from '../../../persistence/factory-schema.js'
import {
  createTwinPersistenceCoordinator,
  insertTwinRun,
  recordTwinHealthFailure,
  getTwinRunsForRun,
} from '../../persistence.js'
import type { FactoryEvents } from '../../../events.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush async event-bus handlers by yielding to the macrotask queue. */
const nextTick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let adapter: DatabaseAdapter
let eventBus: TypedEventBus<FactoryEvents>

beforeEach(async () => {
  adapter = createDatabaseAdapter({ backend: 'memory' })
  await factorySchema(adapter)
  eventBus = new TypedEventBusImpl<FactoryEvents>()
  createTwinPersistenceCoordinator(adapter, eventBus)
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TwinPersistenceCoordinator — event-driven persistence', () => {
  it('Test 1 — twin:started emits insertTwinRun row with status running', async () => {
    eventBus.emit('twin:started', {
      twinName: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      healthStatus: 'healthy',
      runId: 'run-001',
    })
    await nextTick()

    const summaries = await getTwinRunsForRun(adapter, 'run-001')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.twin_name).toBe('localstack')
    expect(summaries[0]!.status).toBe('running')
  })

  it('Test 2 — twin:stopped updates row to stopped with non-null stopped_at', async () => {
    eventBus.emit('twin:started', {
      twinName: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      healthStatus: 'healthy',
      runId: 'run-002',
    })
    await nextTick()

    eventBus.emit('twin:stopped', { twinName: 'localstack' })
    await nextTick()

    const summaries = await getTwinRunsForRun(adapter, 'run-002')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.status).toBe('stopped')
    expect(summaries[0]!.stopped_at).not.toBeNull()
  })

  it('Test 3 — ports are serialized and parsed correctly on read', async () => {
    eventBus.emit('twin:started', {
      twinName: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      healthStatus: 'healthy',
      runId: 'run-003',
    })
    await nextTick()

    const summaries = await getTwinRunsForRun(adapter, 'run-003')
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.ports).toHaveLength(1)
    expect(summaries[0]!.ports[0]!.host).toBe(4566)
    expect(summaries[0]!.ports[0]!.container).toBe(4566)
  })

  it('Test 4 — health failures accumulate via recordTwinHealthFailure', async () => {
    const runId = 'run-004'
    await insertTwinRun(adapter, {
      twin_name: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      run_id: runId,
    })

    await recordTwinHealthFailure(adapter, {
      twin_name: 'localstack',
      run_id: runId,
      error_message: 'failure 1',
    })
    await recordTwinHealthFailure(adapter, {
      twin_name: 'localstack',
      run_id: runId,
      error_message: 'failure 2',
    })
    await recordTwinHealthFailure(adapter, {
      twin_name: 'localstack',
      run_id: runId,
      error_message: 'failure 3',
    })

    const summaries = await getTwinRunsForRun(adapter, runId)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]!.health_failure_count).toBe(3)
  })

  it('Test 5 — multiple twins in one run are each tracked separately', async () => {
    const runId = 'run-005'

    eventBus.emit('twin:started', {
      twinName: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      healthStatus: 'healthy',
      runId,
    })
    eventBus.emit('twin:started', {
      twinName: 'wiremock',
      ports: [{ host: 8080, container: 8080 }],
      healthStatus: 'healthy',
      runId,
    })
    await nextTick()

    eventBus.emit('twin:stopped', { twinName: 'localstack' })
    eventBus.emit('twin:stopped', { twinName: 'wiremock' })
    await nextTick()

    const summaries = await getTwinRunsForRun(adapter, runId)
    expect(summaries).toHaveLength(2)

    const names = summaries.map((s) => s.twin_name).sort()
    expect(names).toEqual(['localstack', 'wiremock'])

    for (const summary of summaries) {
      expect(summary.status).toBe('stopped')
    }
  })
})
