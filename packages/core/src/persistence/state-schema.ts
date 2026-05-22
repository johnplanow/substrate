/**
 * Legacy state-table cleanup — pre-2026-Q1 orchestrator state tables.
 *
 * Historical context: `stories`, `contracts`, `metrics`, `dispatch_log`,
 * `build_results`, `review_verdicts` (+ vestigial `_schema_version`) were
 * defined as the substrate-state surface in `schema.sql`. Ship 1 (v0.20.92)
 * excised the corresponding DoltStateStore CRUD methods after auditing every
 * production project (ynab, quant) and finding all six tables empty in
 * production. The Item 7 arc (v0.20.106/v0.20.107) then verified empirically
 * that the orchestrator's `stateStore?` prop was undefined in 100% of
 * production callers, confirming the tables had no writer path at all.
 *
 * Ship 7 (v0.20.98) deleted the vestigial `_schema_version` table the same
 * way; Ship 8 (v0.20.99) extends that pattern to the remaining six legacy
 * tables. This module owns NO tables now — it survives only to drop the
 * legacy tables on existing repos (ynab, quant) at next `substrate run`.
 *
 * Fresh repos never see any of these tables; existing repos lose them on
 * next init via the DROP TABLE IF EXISTS block below.
 *
 * Note: monitor.db's `_schema_version` (in `.substrate/monitor.db`) is
 * intentionally distinct from the substrate-state `_schema_version` we
 * dropped — see monitor-database.ts.
 */

import type { DatabaseAdapter } from './types.js'

const LEGACY_TABLES = [
  '_schema_version',
  'stories',
  'contracts',
  'metrics',
  'dispatch_log',
  'build_results',
  'review_verdicts',
] as const

export async function initStateSchema(adapter: DatabaseAdapter): Promise<void> {
  for (const table of LEGACY_TABLES) {
    try { await adapter.exec(`DROP TABLE IF EXISTS ${table}`) } catch { /* table absent or adapter lacks DROP support */ }
  }
}
