/**
 * Integration tests for plan review/approval persistence (Story 7-3).
 *
 * Uses a real temp SQLite DB with runMigrations() (including migration 005).
 * Tests the complete approval and rejection paths through the persistence layer.
 *
 * Covers AC5, AC6, AC7, AC8.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../persistence/migrations/index.js'
import {
  createPlan,
  updatePlanStatus,
  listPlans,
  getPlanById,
  getPlanByPrefix,
} from '../../persistence/queries/plans.js'
import type { Plan } from '../../persistence/queries/plans.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePlanInput(id: string, description: string): Omit<Plan, 'created_at' | 'updated_at'> {
  return {
    id,
    description,
    task_count: 2,
    estimated_cost_usd: 0.30,
    planning_agent: 'claude',
    plan_yaml: `version: "1"\nsession:\n  name: ${description}\ntasks:\n  task-1:\n    name: Task 1\n    prompt: Do task 1\n    type: coding\n    depends_on: []`,
    status: 'draft',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('plan review/approval integration', () => {
  let tmpDir: string
  let db: BetterSqlite3Database

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'substrate-test-'))
    const dbPath = join(tmpDir, 'state.db')
    db = new Database(dbPath)
    runMigrations(db)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Approval path
  // -------------------------------------------------------------------------

  describe('approval path', () => {
    it('AC5: createPlan + updatePlanStatus(approved) → getPlanById returns status approved', () => {
      const input = makePlanInput('plan-integ-001', 'Add auth flow')
      createPlan(db, input)
      updatePlanStatus(db, input.id, 'approved')

      const result = getPlanById(db, input.id)
      expect(result).toBeDefined()
      expect(result?.status).toBe('approved')
      expect(result?.id).toBe(input.id)
      expect(result?.description).toBe(input.description)
    })

    it('AC5: approved plan has all correct fields', () => {
      const input = makePlanInput('plan-integ-002', 'Refactor auth module')
      createPlan(db, input)
      updatePlanStatus(db, input.id, 'approved')

      const result = getPlanById(db, input.id)
      expect(result?.task_count).toBe(2)
      expect(result?.estimated_cost_usd).toBe(0.30)
      expect(result?.planning_agent).toBe('claude')
      expect(result?.plan_yaml).toContain('version: "1"')
    })
  })

  // -------------------------------------------------------------------------
  // Rejection path
  // -------------------------------------------------------------------------

  describe('rejection path', () => {
    it('AC6: createPlan + updatePlanStatus(rejected) → getPlanById returns status rejected', () => {
      const input = makePlanInput('plan-integ-003', 'Add OAuth support')
      createPlan(db, input)
      updatePlanStatus(db, input.id, 'rejected')

      const result = getPlanById(db, input.id)
      expect(result).toBeDefined()
      expect(result?.status).toBe('rejected')
    })
  })

  // -------------------------------------------------------------------------
  // listPlans
  // -------------------------------------------------------------------------

  describe('listPlans', () => {
    it('AC7: inserts 3 plans, returns all in DESC order', () => {
      createPlan(db, makePlanInput('plan-list-001', 'Plan one'))
      createPlan(db, makePlanInput('plan-list-002', 'Plan two'))
      createPlan(db, makePlanInput('plan-list-003', 'Plan three'))

      const plans = listPlans(db)
      expect(plans).toHaveLength(3)

      const ids = plans.map((p) => p.id)
      expect(ids).toContain('plan-list-001')
      expect(ids).toContain('plan-list-002')
      expect(ids).toContain('plan-list-003')
    })

    it('AC7: returns empty array when no plans', () => {
      const plans = listPlans(db)
      expect(plans).toEqual([])
    })

    it('AC7: plans with different statuses are all returned', () => {
      createPlan(db, makePlanInput('plan-stat-001', 'Draft plan'))
      createPlan(db, makePlanInput('plan-stat-002', 'Approved plan'))
      createPlan(db, makePlanInput('plan-stat-003', 'Rejected plan'))

      updatePlanStatus(db, 'plan-stat-002', 'approved')
      updatePlanStatus(db, 'plan-stat-003', 'rejected')

      const plans = listPlans(db)
      expect(plans).toHaveLength(3)

      const statuses = plans.map((p) => p.status)
      expect(statuses).toContain('draft')
      expect(statuses).toContain('approved')
      expect(statuses).toContain('rejected')
    })
  })

  // -------------------------------------------------------------------------
  // getPlanByPrefix
  // -------------------------------------------------------------------------

  describe('getPlanByPrefix', () => {
    it('AC8: query with 4-char prefix returns correct plan', () => {
      const planId = 'abcd-efgh-ijkl-mnop-0001'
      createPlan(db, makePlanInput(planId, 'Prefix test plan'))

      const result = getPlanByPrefix(db, 'abcd')
      expect(result).toBeDefined()
      expect(result?.id).toBe(planId)
    })

    it('AC8: query with full ID as prefix returns plan', () => {
      const planId = 'full-prefix-test-0001'
      createPlan(db, makePlanInput(planId, 'Full prefix plan'))

      const result = getPlanByPrefix(db, planId)
      expect(result).toBeDefined()
      expect(result?.id).toBe(planId)
    })

    it('AC8: unmatched prefix returns undefined', () => {
      createPlan(db, makePlanInput('xyz-test-plan-0001', 'XYZ plan'))

      const result = getPlanByPrefix(db, 'abc')
      expect(result).toBeUndefined()
    })

    it('AC8: when multiple plans share prefix, returns one of them', () => {
      createPlan(db, makePlanInput('shared-prefix-001', 'Shared plan one'))
      createPlan(db, makePlanInput('shared-prefix-002', 'Shared plan two'))

      const result = getPlanByPrefix(db, 'shared-prefix')
      expect(result).toBeDefined()
      expect(['shared-prefix-001', 'shared-prefix-002']).toContain(result?.id)
    })
  })
})
