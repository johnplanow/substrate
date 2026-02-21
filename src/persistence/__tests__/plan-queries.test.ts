/**
 * Unit tests for plan persistence queries.
 *
 * Covers:
 * - createPlan + getPlan roundtrip
 * - createPlanVersion + getPlanVersion + getPlanVersionHistory
 * - updatePlan (status and current_version)
 * - getLatestPlanVersion returns highest version
 * - updatePlan with empty updates is a no-op
 */

import { describe, it, expect, beforeEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../migrations/index.js'
import {
  createPlan,
  getPlan,
  getPlanById,
  updatePlan,
  updatePlanStatus,
  listPlans,
} from '../queries/plans.js'
import {
  createPlanVersion,
  getPlanVersion,
  getPlanVersionHistory,
  getLatestPlanVersion,
} from '../queries/plan-versions.js'

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function openTestDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function makePlan(overrides: Partial<Parameters<typeof createPlan>[1]> = {}) {
  return {
    id: 'test-plan-id-1',
    description: 'Add authentication',
    task_count: 3,
    estimated_cost_usd: 0.5,
    planning_agent: 'claude',
    plan_yaml: 'version: "1"\nsession:\n  name: test\ntasks: {}',
    status: 'draft',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Plan queries tests
// ---------------------------------------------------------------------------

describe('plan queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('createPlan + getPlan roundtrip', () => {
    const plan = makePlan()
    createPlan(db, plan)
    const retrieved = getPlan(db, plan.id)
    expect(retrieved).toBeDefined()
    expect(retrieved?.id).toBe(plan.id)
    expect(retrieved?.description).toBe(plan.description)
    expect(retrieved?.status).toBe('draft')
    expect(retrieved?.planning_agent).toBe('claude')
  })

  it('getPlanById returns the same result as getPlan', () => {
    const plan = makePlan()
    createPlan(db, plan)
    const byId = getPlanById(db, plan.id)
    const byPlan = getPlan(db, plan.id)
    expect(byId).toEqual(byPlan)
  })

  it('getPlan returns undefined for non-existent id', () => {
    const result = getPlan(db, 'nonexistent-id')
    expect(result).toBeUndefined()
  })

  it('updatePlan: updates status', () => {
    const plan = makePlan()
    createPlan(db, plan)
    updatePlan(db, plan.id, { status: 'approved' })
    const retrieved = getPlan(db, plan.id)
    expect(retrieved?.status).toBe('approved')
  })

  it('updatePlan: updates current_version', () => {
    const plan = makePlan()
    createPlan(db, plan)
    updatePlan(db, plan.id, { current_version: 2 })
    const retrieved = getPlan(db, plan.id)
    expect(retrieved?.current_version).toBe(2)
  })

  it('updatePlan: updates both status and current_version', () => {
    const plan = makePlan()
    createPlan(db, plan)
    updatePlan(db, plan.id, { status: 'rejected', current_version: 3 })
    const retrieved = getPlan(db, plan.id)
    expect(retrieved?.status).toBe('rejected')
    expect(retrieved?.current_version).toBe(3)
  })

  it('updatePlan: no-op when no updates provided', () => {
    const plan = makePlan()
    createPlan(db, plan)
    // Should not throw
    expect(() => updatePlan(db, plan.id, {})).not.toThrow()
    const retrieved = getPlan(db, plan.id)
    expect(retrieved?.status).toBe('draft')
  })

  it('updatePlanStatus: updates plan status directly', () => {
    const plan = makePlan()
    createPlan(db, plan)
    updatePlanStatus(db, plan.id, 'approved')
    const retrieved = getPlan(db, plan.id)
    expect(retrieved?.status).toBe('approved')
  })

  it('listPlans: returns plans ordered by created_at DESC', () => {
    createPlan(db, makePlan({ id: 'plan-a', description: 'Plan A' }))
    createPlan(db, makePlan({ id: 'plan-b', description: 'Plan B' }))
    const plans = listPlans(db)
    expect(plans.length).toBeGreaterThanOrEqual(2)
    const ids = plans.map((p) => p.id)
    expect(ids).toContain('plan-a')
    expect(ids).toContain('plan-b')
  })
})

// ---------------------------------------------------------------------------
// Plan version queries tests
// ---------------------------------------------------------------------------

describe('plan version queries', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
    // Insert a parent plan for FK constraints
    createPlan(db, makePlan({ id: 'parent-plan-id' }))
  })

  it('createPlanVersion + getPlanVersion roundtrip', () => {
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 1,
      task_graph_yaml: 'version: "1"\nsession:\n  name: test\ntasks: {}',
      feedback_used: null,
      planning_cost_usd: 0.0,
    })

    const pv = getPlanVersion(db, 'parent-plan-id', 1)
    expect(pv).toBeDefined()
    expect(pv?.plan_id).toBe('parent-plan-id')
    expect(pv?.version).toBe(1)
    expect(pv?.feedback_used).toBeNull()
    expect(pv?.planning_cost_usd).toBe(0.0)
  })

  it('getPlanVersion returns undefined for non-existent version', () => {
    const pv = getPlanVersion(db, 'parent-plan-id', 99)
    expect(pv).toBeUndefined()
  })

  it('getPlanVersionHistory returns versions in ASC order', () => {
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 1,
      task_graph_yaml: 'yaml-v1',
      feedback_used: null,
      planning_cost_usd: 0.0,
    })
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 2,
      task_graph_yaml: 'yaml-v2',
      feedback_used: 'make tasks smaller',
      planning_cost_usd: 0.01,
    })
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 3,
      task_graph_yaml: 'yaml-v3',
      feedback_used: 'add more details',
      planning_cost_usd: 0.02,
    })

    const history = getPlanVersionHistory(db, 'parent-plan-id')
    expect(history).toHaveLength(3)
    expect(history[0].version).toBe(1)
    expect(history[1].version).toBe(2)
    expect(history[2].version).toBe(3)
    expect(history[1].feedback_used).toBe('make tasks smaller')
    expect(history[2].feedback_used).toBe('add more details')
  })

  it('getPlanVersionHistory returns empty array when no versions', () => {
    const history = getPlanVersionHistory(db, 'parent-plan-id')
    expect(history).toHaveLength(0)
  })

  it('getLatestPlanVersion returns highest version number', () => {
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 1,
      task_graph_yaml: 'yaml-v1',
      feedback_used: null,
      planning_cost_usd: 0.0,
    })
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 2,
      task_graph_yaml: 'yaml-v2',
      feedback_used: 'feedback 1',
      planning_cost_usd: 0.0,
    })
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 3,
      task_graph_yaml: 'yaml-v3',
      feedback_used: 'feedback 2',
      planning_cost_usd: 0.0,
    })

    const latest = getLatestPlanVersion(db, 'parent-plan-id')
    expect(latest).toBeDefined()
    expect(latest?.version).toBe(3)
    expect(latest?.task_graph_yaml).toBe('yaml-v3')
  })

  it('getLatestPlanVersion returns undefined when no versions exist', () => {
    const latest = getLatestPlanVersion(db, 'parent-plan-id')
    expect(latest).toBeUndefined()
  })

  it('createPlanVersion stores feedback_used correctly', () => {
    createPlanVersion(db, {
      plan_id: 'parent-plan-id',
      version: 1,
      task_graph_yaml: 'yaml',
      feedback_used: 'some feedback',
      planning_cost_usd: 0.05,
    })

    const pv = getPlanVersion(db, 'parent-plan-id', 1)
    expect(pv?.feedback_used).toBe('some feedback')
    expect(pv?.planning_cost_usd).toBe(0.05)
  })
})
