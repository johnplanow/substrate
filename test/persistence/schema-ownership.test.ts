// @vitest-environment node
/**
 * Ship 6 (schema-unification arc, 2026-05): static ownership contract.
 *
 * Each per-subsystem schema module under packages/core/src/persistence/
 * declares the tables (and views) it owns via an exported readonly array.
 * This test enforces two invariants:
 *
 *   1. **No overlap** — every table name appears in exactly one subsystem's
 *      `tables` array. Adding a CREATE TABLE to two subsystems' DDL without
 *      updating both ownership arrays would surface here. Adding it to one
 *      module's DDL but accidentally declaring it in another's ownership
 *      array would also fail.
 *
 *   2. **Union covers canonical set** — the concatenated `tables` arrays from
 *      all subsystems must equal the canonical table union expected by the
 *      Ship 2 regression gate. Adding a CREATE TABLE without declaring it in
 *      the corresponding `tables` array surfaces as a missing entry in the
 *      union; removing one without updating the canonical set surfaces as a
 *      surplus entry.
 *
 * The Ship 2 regression gate (full-init-integration.test.ts) verifies that
 * the runtime DDL actually produces these tables. Ship 6 is the STATIC
 * counterpart — it catches ownership-declaration drift without needing to
 * spawn Dolt.
 */

import { describe, it, expect } from 'vitest'
import {
  coreSchemaTables,
  coreSchemaViews,
  pipelineSchemaTables,
  monitorSchemaTables,
  stateSchemaTables,
  repoMapSchemaTables,
  telemetrySchemaTables,
  workGraphSchemaTables,
  workGraphSchemaViews,
} from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// Canonical set — must stay aligned with the Ship 2 regression gate.
// If you add a table to a subsystem module, declare it in that module's
// `tables` array AND add it here. Removing a table requires removing it
// from both places.
// ---------------------------------------------------------------------------

const CANONICAL_TABLES = [
  // From schema.sql (pre-Ship-3, now ported to state-schema.ts)
  '_schema_version',
  'build_results',
  'contracts',
  'dispatch_log',
  'metrics',
  'review_verdicts',
  'stories',
  // From telemetry-schema.ts (Epic 27)
  'category_stats',
  'consumer_stats',
  'efficiency_scores',
  'recommendations',
  'turn_analysis',
  // From work-graph-schema.ts (Epic 31-1)
  'story_dependencies',
  'wg_stories',
  // From repo-map-schema.ts (Epic 28-2)
  'repo_map_meta',
  'repo_map_symbols',
  // From core-schema.ts (orchestrator session/task model)
  'artifacts',
  'constraints',
  'cost_entries',
  'decisions',
  'execution_log',
  'plan_versions',
  'plans',
  'requirements',
  'schema_migrations',
  'session_signals',
  'sessions',
  'task_dependencies',
  'tasks',
  // From pipeline-schema.ts
  'pipeline_runs',
  'run_metrics',
  'story_metrics',
  'token_usage',
  // From monitor-schema.ts (main DB; monitor.db is separate)
  'performance_aggregates',
  'routing_recommendations',
  'task_metrics',
].sort()

const CANONICAL_VIEWS = [
  // From work-graph-schema.ts
  'ready_stories',
  // From core-schema.ts (initCoreViews)
  'ready_tasks',
  'session_cost_summary',
].sort()

// Group subsystem ownership arrays by name for clearer error messages.
const SUBSYSTEM_TABLES: Record<string, ReadonlyArray<string>> = {
  'core-schema': coreSchemaTables,
  'pipeline-schema': pipelineSchemaTables,
  'monitor-schema': monitorSchemaTables,
  'state-schema': stateSchemaTables,
  'repo-map-schema': repoMapSchemaTables,
  'telemetry-schema': telemetrySchemaTables,
  'work-graph-schema': workGraphSchemaTables,
}

const SUBSYSTEM_VIEWS: Record<string, ReadonlyArray<string>> = {
  'core-schema (initCoreViews)': coreSchemaViews,
  'work-graph-schema': workGraphSchemaViews,
}

describe('Ship 6: schema ownership contract', () => {
  describe('tables', () => {
    it('every subsystem declares at least one table', () => {
      for (const [name, tables] of Object.entries(SUBSYSTEM_TABLES)) {
        expect(tables.length, `subsystem "${name}" has empty tables array`).toBeGreaterThan(0)
      }
    })

    it('no table is owned by more than one subsystem', () => {
      const ownedBy = new Map<string, string[]>()
      for (const [name, tables] of Object.entries(SUBSYSTEM_TABLES)) {
        for (const table of tables) {
          const existing = ownedBy.get(table) ?? []
          existing.push(name)
          ownedBy.set(table, existing)
        }
      }

      const overlaps: Array<[string, string[]]> = []
      for (const [table, owners] of ownedBy) {
        if (owners.length > 1) overlaps.push([table, owners])
      }

      expect(overlaps, `tables owned by multiple subsystems: ${JSON.stringify(overlaps)}`).toEqual([])
    })

    it('union of all subsystem tables equals the canonical set', () => {
      const union: string[] = []
      for (const tables of Object.values(SUBSYSTEM_TABLES)) {
        union.push(...tables)
      }
      union.sort()

      expect(union).toEqual(CANONICAL_TABLES)
    })
  })

  describe('views', () => {
    it('no view is owned by more than one subsystem', () => {
      const ownedBy = new Map<string, string[]>()
      for (const [name, views] of Object.entries(SUBSYSTEM_VIEWS)) {
        for (const view of views) {
          const existing = ownedBy.get(view) ?? []
          existing.push(name)
          ownedBy.set(view, existing)
        }
      }

      const overlaps: Array<[string, string[]]> = []
      for (const [view, owners] of ownedBy) {
        if (owners.length > 1) overlaps.push([view, owners])
      }

      expect(overlaps, `views owned by multiple subsystems: ${JSON.stringify(overlaps)}`).toEqual([])
    })

    it('union of all subsystem views equals the canonical set', () => {
      const union: string[] = []
      for (const views of Object.values(SUBSYSTEM_VIEWS)) {
        union.push(...views)
      }
      union.sort()

      expect(union).toEqual(CANONICAL_VIEWS)
    })
  })
})
