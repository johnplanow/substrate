/**
 * Unit tests for twin persistence — twin_runs, twin_health_failures tables and
 * the TwinPersistenceCoordinator.
 *
 * Story 47-7, Tasks 1–7.
 *
 * All tests use createDatabaseAdapter({ backend: 'memory' }) — no Dolt, no Docker, no network.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createDatabaseAdapter, TypedEventBusImpl } from '@substrate-ai/core'
import type { DatabaseAdapter } from '@substrate-ai/core'
import { factorySchema } from '../../persistence/factory-schema.js'
import {
  insertTwinRun,
  updateTwinRun,
  recordTwinHealthFailure,
  getTwinRunsForRun,
  TwinPersistenceCoordinator,
  createTwinPersistenceCoordinator,
} from '../persistence.js'
import type { TwinRunRow } from '../persistence.js'
import type { FactoryEvents } from '../../events.js'

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

let adapter: DatabaseAdapter

beforeEach(async () => {
  adapter = createDatabaseAdapter({ backend: 'memory' })
  await factorySchema(adapter)
})

// ---------------------------------------------------------------------------
// AC1: twin_runs table is created by factorySchema
// ---------------------------------------------------------------------------

describe('AC1: twin_runs table', () => {
  it('exists after factorySchema — INSERT succeeds', async () => {
    await expect(
      adapter.query(
        "INSERT INTO twin_runs (id, twin_name, started_at, status) VALUES ('t1', 'localstack', '2026-01-01T00:00:00.000Z', 'running')"
      )
    ).resolves.toBeDefined()
  })

  it('has ports_json column (nullable)', async () => {
    await adapter.query(
      "INSERT INTO twin_runs (id, twin_name, started_at, status, ports_json) VALUES ('t2', 'wiremock', '2026-01-01T00:00:00.000Z', 'running', NULL)"
    )
    const rows = await adapter.query<{ ports_json: string | null }>(
      "SELECT ports_json FROM twin_runs WHERE id = 't2'"
    )
    expect(rows[0]?.ports_json).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC2: twin_health_failures table is created by factorySchema
// ---------------------------------------------------------------------------

describe('AC2: twin_health_failures table', () => {
  it('exists after factorySchema — INSERT succeeds', async () => {
    await expect(
      adapter.query(
        "INSERT INTO twin_health_failures (twin_name, checked_at, error_message) VALUES ('localstack', '2026-01-01T00:00:00.000Z', 'connect ECONNREFUSED')"
      )
    ).resolves.toBeDefined()
  })

  it('supports querying by twin_name via idx_twin_health_failures_twin', async () => {
    await adapter.query(
      "INSERT INTO twin_health_failures (twin_name, checked_at, error_message) VALUES ('wiremock', '2026-01-01T00:00:00.000Z', 'timeout')"
    )
    const rows = await adapter.query<{ error_message: string }>(
      "SELECT error_message FROM twin_health_failures WHERE twin_name = 'wiremock'"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.error_message).toBe('timeout')
  })
})

// ---------------------------------------------------------------------------
// AC1 + AC2: idempotency
// ---------------------------------------------------------------------------

describe('idempotency', () => {
  it('calling factorySchema twice does not throw', async () => {
    await expect(factorySchema(adapter)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC3: insertTwinRun
// ---------------------------------------------------------------------------

describe('AC3: insertTwinRun', () => {
  it('inserts a row and returns a valid UUID-format id', async () => {
    const id = await insertTwinRun(adapter, {
      twin_name: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
    })
    expect(typeof id).toBe('string')
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('serializes ports correctly and row is readable', async () => {
    const id = await insertTwinRun(adapter, {
      twin_name: 'localstack',
      ports: [
        { host: 4566, container: 4566 },
        { host: 4572, container: 4572 },
      ],
    })
    const rows = await adapter.query<TwinRunRow>('SELECT * FROM twin_runs WHERE id = ?', [id])
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.twin_name).toBe('localstack')
    expect(row.status).toBe('running')
    const ports = JSON.parse(row.ports_json!) as Array<{ host: number; container: number }>
    expect(ports).toHaveLength(2)
    expect(ports[0]?.host).toBe(4566)
    expect(ports[1]?.host).toBe(4572)
  })

  it('stores run_id when provided', async () => {
    const id = await insertTwinRun(adapter, {
      twin_name: 'wiremock',
      ports: [],
      run_id: 'factory-run-abc',
    })
    const rows = await adapter.query<TwinRunRow>('SELECT * FROM twin_runs WHERE id = ?', [id])
    expect(rows[0]?.run_id).toBe('factory-run-abc')
  })

  it('sets status to running by default', async () => {
    const id = await insertTwinRun(adapter, {
      twin_name: 'localstack',
      ports: [],
    })
    const rows = await adapter.query<TwinRunRow>('SELECT status FROM twin_runs WHERE id = ?', [id])
    expect(rows[0]?.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// AC4: updateTwinRun
// ---------------------------------------------------------------------------

describe('AC4: updateTwinRun', () => {
  it('sets stopped_at and status on an existing row', async () => {
    const id = await insertTwinRun(adapter, {
      twin_name: 'localstack',
      ports: [],
    })
    const stoppedAt = '2026-03-23T12:00:00.000Z'
    await updateTwinRun(adapter, id, { status: 'stopped', stopped_at: stoppedAt })

    const rows = await adapter.query<TwinRunRow>('SELECT * FROM twin_runs WHERE id = ?', [id])
    expect(rows[0]?.status).toBe('stopped')
    expect(rows[0]?.stopped_at).toBe(stoppedAt)
  })
})

// ---------------------------------------------------------------------------
// AC5: recordTwinHealthFailure
// ---------------------------------------------------------------------------

describe('AC5: recordTwinHealthFailure', () => {
  it('inserts a row with checked_at and error_message', async () => {
    await recordTwinHealthFailure(adapter, {
      twin_name: 'localstack',
      run_id: 'run-123',
      error_message: 'connect ECONNREFUSED 127.0.0.1:4566',
    })

    const rows = await adapter.query<{
      twin_name: string
      error_message: string
      run_id: string | null
    }>(
      "SELECT twin_name, error_message, run_id FROM twin_health_failures WHERE twin_name = 'localstack'"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.twin_name).toBe('localstack')
    expect(rows[0]?.error_message).toBe('connect ECONNREFUSED 127.0.0.1:4566')
    expect(rows[0]?.run_id).toBe('run-123')
  })

  it('sets checked_at to current time when not provided', async () => {
    const before = new Date().toISOString()
    await recordTwinHealthFailure(adapter, {
      twin_name: 'wiremock',
      error_message: 'timeout',
    })
    const after = new Date().toISOString()

    const rows = await adapter.query<{ checked_at: string }>(
      "SELECT checked_at FROM twin_health_failures WHERE twin_name = 'wiremock'"
    )
    expect(new Date(rows[0]?.checked_at ?? '').getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime()
    )
    expect(new Date(rows[0]?.checked_at ?? '').getTime()).toBeLessThanOrEqual(
      new Date(after).getTime()
    )
  })
})

// ---------------------------------------------------------------------------
// AC6: getTwinRunsForRun
// ---------------------------------------------------------------------------

describe('AC6: getTwinRunsForRun', () => {
  it('returns empty array when run_id has no twins', async () => {
    const result = await getTwinRunsForRun(adapter, 'nonexistent-run-id')
    expect(result).toEqual([])
  })

  it('returns summary with correct health_failure_count', async () => {
    const runId = 'run-abc-123'
    await insertTwinRun(adapter, {
      twin_name: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      run_id: runId,
    })
    // Record 2 health failures
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

    const summaries = await getTwinRunsForRun(adapter, runId)
    expect(summaries).toHaveLength(1)
    expect(summaries[0]?.twin_name).toBe('localstack')
    expect(summaries[0]?.health_failure_count).toBe(2)
  })

  it('parses ports_json back to PortMapping[]', async () => {
    const runId = 'run-ports-test'
    await insertTwinRun(adapter, {
      twin_name: 'localstack',
      ports: [
        { host: 4566, container: 4566 },
        { host: 4572, container: 4572 },
      ],
      run_id: runId,
    })

    const summaries = await getTwinRunsForRun(adapter, runId)
    expect(summaries).toHaveLength(1)
    const ports = summaries[0]!.ports
    expect(ports).toHaveLength(2)
    expect(ports[0]).toEqual({ host: 4566, container: 4566 })
    expect(ports[1]).toEqual({ host: 4572, container: 4572 })
  })

  it('returns empty ports array when ports_json is null', async () => {
    const runId = 'run-no-ports'
    // Insert directly with null ports_json
    await adapter.query(
      "INSERT INTO twin_runs (id, run_id, twin_name, started_at, status) VALUES ('no-ports-id', ?, 'no-ports-twin', '2026-01-01T00:00:00.000Z', 'running')",
      [runId]
    )

    const summaries = await getTwinRunsForRun(adapter, runId)
    expect(summaries[0]?.ports).toEqual([])
  })

  it('returns health_failure_count=0 when no failures recorded', async () => {
    const runId = 'run-no-failures'
    await insertTwinRun(adapter, {
      twin_name: 'wiremock',
      ports: [],
      run_id: runId,
    })
    const summaries = await getTwinRunsForRun(adapter, runId)
    expect(summaries[0]?.health_failure_count).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// AC7: TwinPersistenceCoordinator
// ---------------------------------------------------------------------------

/**
 * Poll the DB until predicate returns true, up to maxAttempts * intervalMs.
 * This provides deterministic synchronization for async event-bus handlers that
 * fire void Promise chains — avoiding fragile fixed-delay timeouts.
 */
async function pollUntil(
  predicate: () => Promise<boolean>,
  maxAttempts = 100,
  intervalMs = 1
): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    if (await predicate()) return
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('pollUntil: timed out waiting for condition')
}

describe('AC7: TwinPersistenceCoordinator', () => {
  it('twin:started triggers insertTwinRun — row is present in DB', async () => {
    const bus = new TypedEventBusImpl<FactoryEvents>()
    new TwinPersistenceCoordinator(adapter, bus)

    bus.emit('twin:started', {
      twinName: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      healthStatus: 'healthy',
      runId: 'run-coord-1',
    })

    // Poll until the row appears — deterministic, no fixed-delay timeout
    await pollUntil(async () => {
      const rows = await adapter.query<TwinRunRow>(
        "SELECT * FROM twin_runs WHERE twin_name = 'localstack'"
      )
      return rows.length > 0
    })

    const rows = await adapter.query<TwinRunRow>(
      "SELECT * FROM twin_runs WHERE twin_name = 'localstack'"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('running')
    expect(rows[0]?.run_id).toBe('run-coord-1')
  })

  it('twin:stopped triggers updateTwinRun — status becomes stopped', async () => {
    const bus = new TypedEventBusImpl<FactoryEvents>()
    new TwinPersistenceCoordinator(adapter, bus)

    bus.emit('twin:started', {
      twinName: 'localstack',
      ports: [{ host: 4566, container: 4566 }],
      healthStatus: 'healthy',
      runId: 'run-coord-2',
    })

    // Poll until insertTwinRun has completed and _rowIds is populated
    // (guards against twin:stopped firing before the row id is stored)
    await pollUntil(async () => {
      const rows = await adapter.query<TwinRunRow>(
        "SELECT * FROM twin_runs WHERE twin_name = 'localstack'"
      )
      return rows.length > 0
    })

    bus.emit('twin:stopped', { twinName: 'localstack' })

    // Poll until updateTwinRun has committed the stopped status
    await pollUntil(async () => {
      const rows = await adapter.query<TwinRunRow>(
        "SELECT status FROM twin_runs WHERE twin_name = 'localstack'"
      )
      return rows[0]?.status === 'stopped'
    })

    const rows = await adapter.query<TwinRunRow>(
      "SELECT * FROM twin_runs WHERE twin_name = 'localstack'"
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('stopped')
    expect(rows[0]?.stopped_at).toBeTruthy()
  })

  it('twin:health-failed triggers recordTwinHealthFailure (47-7 AC2)', async () => {
    const bus = new TypedEventBusImpl<FactoryEvents>()
    new TwinPersistenceCoordinator(adapter, bus)

    bus.emit('twin:health-failed', {
      twinName: 'wiremock',
      error: 'connection refused on port 8080',
      runId: 'run-health-1',
    })

    // Poll until the health failure record is persisted
    await pollUntil(async () => {
      const rows = await adapter.query<{ twin_name: string; error_message: string }>(
        "SELECT * FROM twin_health_failures WHERE twin_name = 'wiremock'"
      )
      return rows.length > 0
    })

    const rows = await adapter.query<{
      twin_name: string
      error_message: string
      run_id: string | null
    }>("SELECT * FROM twin_health_failures WHERE twin_name = 'wiremock'")
    expect(rows).toHaveLength(1)
    expect(rows[0]?.error_message).toBe('connection refused on port 8080')
    expect(rows[0]?.run_id).toBe('run-health-1')
  })

  it('createTwinPersistenceCoordinator factory function returns a coordinator instance', () => {
    const bus = new TypedEventBusImpl<FactoryEvents>()
    const coordinator = createTwinPersistenceCoordinator(adapter, bus)
    expect(coordinator).toBeInstanceOf(TwinPersistenceCoordinator)
  })
})
