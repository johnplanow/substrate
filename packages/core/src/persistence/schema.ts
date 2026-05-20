/**
 * Composition-root for persistence schema initialization.
 *
 * `initSchema(adapter)` calls the per-subsystem `initXxxSchema` functions in
 * the correct order (tables before views; dependencies before dependents).
 *
 * Subsystem ownership (Ship 5, 2026-05 — per-subsystem schema split):
 *   - core-schema.ts        — sessions, tasks, plans, execution log, cost entries, signals, schema_migrations + ready_tasks/session_cost_summary views
 *   - pipeline-schema.ts    — pipeline_runs, decisions, requirements, constraints, artifacts, token_usage, run_metrics, story_metrics
 *   - monitor-schema.ts     — task_metrics, performance_aggregates, routing_recommendations (main DB; monitor.db is separate)
 *   - state-schema.ts       — stories, contracts, metrics, dispatch_log, build_results, review_verdicts, _schema_version (legacy)
 *   - repo-map-schema.ts    — repo_map_symbols, repo_map_meta
 *   - telemetry-schema.ts   — turn_analysis, efficiency_scores, recommendations, category_stats, consumer_stats
 *   - work-graph-schema.ts  — wg_stories, story_dependencies, ready_stories view
 *
 * All per-subsystem inits are idempotent (CREATE TABLE IF NOT EXISTS, INSERT
 * IGNORE seeds, try/catch ALTER ADD COLUMN migrations).
 *
 * Composition root order matters for views:
 *   - `ready_tasks` and `session_cost_summary` (initCoreViews) reference
 *     `tasks` + `sessions` — must run AFTER initCoreSchema.
 *   - `ready_stories` (in initWorkGraphSchema) references wg_stories +
 *     story_dependencies, both defined inside the same function — self-contained.
 */

import type { DatabaseAdapter } from './types.js'
import { initCoreSchema, initCoreViews } from './core-schema.js'
import { initPipelineSchema } from './pipeline-schema.js'
import { initMonitorSchema } from './monitor-schema.js'
import { initStateSchema } from './state-schema.js'
import { initRepoMapSchema } from './repo-map-schema.js'
import { initTelemetrySchema } from './telemetry-schema.js'
import { initWorkGraphSchema } from './work-graph-schema.js'

/**
 * Initialize all persistence tables on the given adapter.
 * Idempotent — safe to call multiple times.
 */
export async function initSchema(adapter: DatabaseAdapter): Promise<void> {
  // 1. Core tables (sessions, tasks, plans, ...) — must be first so the
  //    views below can reference them.
  await initCoreSchema(adapter)

  // 2. Pipeline state (pipeline_runs, decisions, requirements, ...).
  await initPipelineSchema(adapter)

  // 3. Monitor tables on the main DB (task_metrics, performance_aggregates,
  //    routing_recommendations). `.substrate/monitor.db` is a separate DB
  //    managed independently by monitor-database.ts.
  await initMonitorSchema(adapter)

  // 4. Legacy state tables (Ship 1 excised the corresponding writes;
  //    Ship 7 will decide their final fate). Kept for now to preserve
  //    backward-compat with operator commands that still expect them.
  await initStateSchema(adapter)

  // 5. Repo-map tables (used by src/modules/repo-map/storage.ts).
  await initRepoMapSchema(adapter)

  // 6. Telemetry tables (turn_analysis, efficiency_scores, ...).
  await initTelemetrySchema(adapter)

  // 7. Work-graph tables + ready_stories view (Epic 31-1).
  await initWorkGraphSchema(adapter)

  // 8. Core views (ready_tasks, session_cost_summary) — must run LAST so
  //    sessions/tasks/task_dependencies all exist.
  await initCoreViews(adapter)
}

// Re-export the per-subsystem init functions so consumers can call individual
// subsystems if they don't need the full schema. Operator CLI commands that
// only touch one subsystem (e.g. `substrate epic-status` only needs the
// work-graph tables) can import the narrow init function directly.
export { initCoreSchema, initCoreViews } from './core-schema.js'
export { initPipelineSchema } from './pipeline-schema.js'
export { initMonitorSchema } from './monitor-schema.js'
export { initStateSchema } from './state-schema.js'
export { initRepoMapSchema } from './repo-map-schema.js'
export { initTelemetrySchema } from './telemetry-schema.js'
export { initWorkGraphSchema } from './work-graph-schema.js'
