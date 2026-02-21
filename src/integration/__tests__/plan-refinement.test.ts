/**
 * Integration tests for plan refinement version tracking (Story 7-4).
 *
 * Uses a real temp SQLite DB with runMigrations(). Tests the complete
 * create-plan → create-version → refine flow through the persistence layer.
 *
 * Covers AC1, AC2, AC3.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createPlan, getPlanById, updatePlan } from '../../persistence/queries/plans.js'
import {
  createPlanVersion,
  getPlanVersion,
  getPlanVersionHistory,
  getLatestPlanVersion,
} from '../../persistence/queries/plan-versions.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePlanInput(id: string) {
  return {
    id,
    description: 'Add authentication to the app',
    task_count: 3,
    estimated_cost_usd: 0.25,
    planning_agent: 'claude',
    plan_yaml: 'version: "1"\ntasks:\n  task-1:\n    name: Task 1\n    prompt: Do it\n    type: coding\n    depends_on: []',
    status: 'draft' as const,
    current_version: 1,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan refinement version tracking integration', () => {
  let tmpDir: string
  let db: BetterSqlite3Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'substrate-plan-refine-test-'))
    db = new Database(join(tmpDir, 'state.db'))
    runMigrations(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('AC1: createPlan + createPlanVersion stores version 1', () => {
    const planId = 'plan-test-0001-0000-0000-000000000001'
    createPlan(db, makePlanInput(planId))
    createPlanVersion(db, {
      plan_id: planId,
      version: 1,
      task_graph_yaml: 'version: "1"\ntasks: {}',
      feedback_used: null,
      planning_cost_usd: 0.0,
    })

    const version = getPlanVersion(db, planId, 1)
    expect(version).toBeDefined()
    expect(version!.plan_id).toBe(planId)
    expect(version!.version).toBe(1)
  })

  it('AC2: getLatestPlanVersion returns version 1 after initial save', () => {
    const planId = 'plan-test-0002-0000-0000-000000000002'
    createPlan(db, makePlanInput(planId))
    createPlanVersion(db, {
      plan_id: planId,
      version: 1,
      task_graph_yaml: 'version: "1"\ntasks: {}',
      feedback_used: null,
      planning_cost_usd: 0.0,
    })

    const latest = getLatestPlanVersion(db, planId)
    expect(latest).toBeDefined()
    expect(latest!.version).toBe(1)
  })

  it('AC3: refine creates version 2 and version history contains both', () => {
    const planId = 'plan-test-0003-0000-0000-000000000003'
    createPlan(db, makePlanInput(planId))
    createPlanVersion(db, {
      plan_id: planId,
      version: 1,
      task_graph_yaml: 'version: "1"\ntasks: {}',
      feedback_used: null,
      planning_cost_usd: 0.0,
    })

    // Simulate refinement: add version 2 with feedback
    createPlanVersion(db, {
      plan_id: planId,
      version: 2,
      task_graph_yaml: 'version: "1"\ntasks:\n  task-1:\n    name: Added Task\n    prompt: Do more\n    type: coding\n    depends_on: []',
      feedback_used: 'Please add more detail to the tasks',
      planning_cost_usd: 0.05,
    })
    updatePlan(db, planId, { current_version: 2 })

    const history = getPlanVersionHistory(db, planId)
    expect(history).toHaveLength(2)
    expect(history[0]!.version).toBe(1)
    expect(history[1]!.version).toBe(2)
    expect(history[1]!.feedback_used).toBe('Please add more detail to the tasks')

    const latest = getLatestPlanVersion(db, planId)
    expect(latest!.version).toBe(2)

    const plan = getPlanById(db, planId)
    expect(plan!.current_version).toBe(2)
  })

  it('AC1: getLatestPlanVersion returns undefined when no versions exist', () => {
    const planId = 'plan-test-0004-0000-0000-000000000004'
    createPlan(db, makePlanInput(planId))

    const latest = getLatestPlanVersion(db, planId)
    expect(latest).toBeUndefined()
  })
})
