/**
 * Twin persistence — database query functions and coordinator for twin lifecycle events.
 *
 * Provides:
 *   - Schema types: TwinRunInput, TwinRunRow, TwinRunSummary, TwinHealthFailureInput
 *   - Query functions: insertTwinRun, updateTwinRun, recordTwinHealthFailure, getTwinRunsForRun
 *   - TwinPersistenceCoordinator: subscribes to factory event bus and persists twin lifecycle events
 *
 * Stories 47-7.
 */

import { randomUUID } from 'node:crypto'
import type { DatabaseAdapter, TypedEventBus } from '@substrate-ai/core'
import type { PortMapping } from './types.js'
import type { FactoryEvents } from '../events.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Input for inserting a new twin run record.
 */
export interface TwinRunInput {
  /** Optional custom id — defaults to a new UUID if not provided */
  id?: string
  /** Optional parent factory run id */
  run_id?: string
  /** Name of the twin */
  twin_name: string
  /** Port mappings for this twin */
  ports: PortMapping[]
  /** ISO timestamp for started_at — defaults to current timestamp if not provided */
  started_at?: string
}

/**
 * Row shape mirroring twin_runs table columns.
 */
export interface TwinRunRow {
  id: string
  run_id: string | null
  twin_name: string
  started_at: string
  stopped_at: string | null
  status: string
  ports_json: string | null
}

/**
 * Input for inserting a twin health failure record.
 */
export interface TwinHealthFailureInput {
  twin_name: string
  run_id?: string
  error_message: string
  /** ISO timestamp — defaults to current timestamp if not provided */
  checked_at?: string
}

/**
 * Enriched view of a twin_runs row with parsed ports and health failure count.
 */
export interface TwinRunSummary extends TwinRunRow {
  /** Parsed PortMapping[] from ports_json (empty array if ports_json is null) */
  ports: PortMapping[]
  /** Count of health failures for this twin within the same run_id */
  health_failure_count: number
}

// ---------------------------------------------------------------------------
// insertTwinRun
// ---------------------------------------------------------------------------

/**
 * Insert a new row into twin_runs with status='running'.
 *
 * @returns The id of the inserted row.
 */
export async function insertTwinRun(
  adapter: DatabaseAdapter,
  input: TwinRunInput,
): Promise<string> {
  const id = input.id ?? randomUUID()
  const startedAt = input.started_at ?? new Date().toISOString()
  const portsJson = JSON.stringify(input.ports)

  await adapter.query(
    'INSERT INTO twin_runs (id, run_id, twin_name, started_at, status, ports_json) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.run_id ?? null, input.twin_name, startedAt, 'running', portsJson],
  )

  return id
}

// ---------------------------------------------------------------------------
// updateTwinRun
// ---------------------------------------------------------------------------

/**
 * Update an existing twin_runs row with stop information.
 */
export async function updateTwinRun(
  adapter: DatabaseAdapter,
  id: string,
  patch: { status: string; stopped_at: string },
): Promise<void> {
  await adapter.query(
    'UPDATE twin_runs SET status = ?, stopped_at = ? WHERE id = ?',
    [patch.status, patch.stopped_at, id],
  )
}

// ---------------------------------------------------------------------------
// recordTwinHealthFailure
// ---------------------------------------------------------------------------

/**
 * Insert a row into twin_health_failures for a failed health check.
 */
export async function recordTwinHealthFailure(
  adapter: DatabaseAdapter,
  input: TwinHealthFailureInput,
): Promise<void> {
  const checkedAt = input.checked_at ?? new Date().toISOString()

  await adapter.query(
    'INSERT INTO twin_health_failures (twin_name, run_id, checked_at, error_message) VALUES (?, ?, ?, ?)',
    [input.twin_name, input.run_id ?? null, checkedAt, input.error_message],
  )
}

// ---------------------------------------------------------------------------
// getTwinRunsForRun
// ---------------------------------------------------------------------------

/**
 * Retrieve all twin run summaries for a given run_id, with health failure counts.
 *
 * Uses two portable queries and merges results client-side.
 *
 * @returns Array of TwinRunSummary — empty array if no twins found for this run.
 */
export async function getTwinRunsForRun(
  adapter: DatabaseAdapter,
  runId: string,
): Promise<TwinRunSummary[]> {
  // Query 1: fetch twin run rows for this run
  const rows = await adapter.query<TwinRunRow>(
    'SELECT * FROM twin_runs WHERE run_id = ?',
    [runId],
  )

  // Query 2: fetch health failure counts per twin for this run
  const failureCounts = await adapter.query<{ twin_name: string; cnt: number }>(
    'SELECT twin_name, COUNT(*) as cnt FROM twin_health_failures WHERE run_id = ? GROUP BY twin_name',
    [runId],
  )
  const failureMap = new Map(failureCounts.map((r) => [r.twin_name, r.cnt]))

  return rows.map((row) => ({
    ...row,
    ports: row.ports_json ? (JSON.parse(row.ports_json) as PortMapping[]) : [],
    health_failure_count: failureMap.get(row.twin_name) ?? 0,
  }))
}

// ---------------------------------------------------------------------------
// TwinPersistenceCoordinator
// ---------------------------------------------------------------------------

/**
 * Subscribes to factory event bus twin lifecycle events and persists them to the database.
 *
 * On twin:started — calls insertTwinRun and stores the row id by twin name.
 * On twin:stopped — calls updateTwinRun with status='stopped' and current timestamp.
 */
export class TwinPersistenceCoordinator {
  private readonly _rowIds = new Map<string, string>()

  constructor(
    private readonly _adapter: DatabaseAdapter,
    eventBus: TypedEventBus<FactoryEvents>,
  ) {
    eventBus.on('twin:started', (e) => {
      void insertTwinRun(this._adapter, {
        ...(e.runId !== undefined ? { run_id: e.runId } : {}),
        twin_name: e.twinName,
        ports: e.ports,
      }).then((id) => {
        this._rowIds.set(e.twinName, id)
      })
    })

    eventBus.on('twin:stopped', (e) => {
      const id = this._rowIds.get(e.twinName)
      if (id !== undefined) {
        void updateTwinRun(this._adapter, id, {
          status: 'stopped',
          stopped_at: new Date().toISOString(),
        })
        this._rowIds.delete(e.twinName)
      }
    })

    // Story 47-7 AC2: persist health check failures
    eventBus.on('twin:health-failed', (e) => {
      void recordTwinHealthFailure(this._adapter, {
        twin_name: e.twinName,
        ...(e.runId !== undefined ? { run_id: e.runId } : {}),
        error_message: e.error,
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a TwinPersistenceCoordinator that wires twin lifecycle events to database persistence.
 */
export function createTwinPersistenceCoordinator(
  adapter: DatabaseAdapter,
  eventBus: TypedEventBus<FactoryEvents>,
): TwinPersistenceCoordinator {
  return new TwinPersistenceCoordinator(adapter, eventBus)
}
