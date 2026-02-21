/**
 * Unit tests for PlanRefiner and related helpers.
 *
 * Covers:
 * - computePlanDiff: identical YAMLs → empty diff
 * - computePlanDiff: added task detected
 * - computePlanDiff: removed task detected
 * - computePlanDiff: modified task field detected
 * - computePlanDiff: depends_on changes detected
 * - PlanRefiner.refine: plan not found throws
 * - PlanRefiner.refine: no versions throws
 * - PlanRefiner.refine: happy path creates new version + emits events
 * - PlanRefiner.refine: planning error emits refinement-failed + rethrows
 * - buildRefinementPrompt: includes history and new feedback
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createPlan } from '../../../persistence/queries/plans.js'
import { createPlanVersion } from '../../../persistence/queries/plan-versions.js'
import {
  computePlanDiff,
  PlanRefiner,
  countTasksInYaml,
} from '../plan-refiner.js'
import { buildRefinementPrompt } from '../planning-prompt.js'
import { PlanError } from '../plan-generator.js'

// ---------------------------------------------------------------------------
// Test YAML fixtures
// ---------------------------------------------------------------------------

const YAML_V1 = `
version: "1"
session:
  name: test plan
tasks:
  setup-database:
    name: Setup Database
    description: Initialize the database
    prompt: Setup the database
    type: coding
    depends_on: []
    agent: claude
  write-tests:
    name: Write Tests
    description: Write unit tests
    prompt: Write tests
    type: testing
    depends_on:
      - setup-database
`

const YAML_V2_ADDED = `
version: "1"
session:
  name: test plan
tasks:
  setup-database:
    name: Setup Database
    description: Initialize the database
    prompt: Setup the database
    type: coding
    depends_on: []
    agent: claude
  write-tests:
    name: Write Tests
    description: Write unit tests
    prompt: Write tests
    type: testing
    depends_on:
      - setup-database
  add-auth:
    name: Add Authentication
    description: Implement OAuth
    prompt: Add OAuth
    type: coding
    depends_on:
      - setup-database
`

const YAML_V2_REMOVED = `
version: "1"
session:
  name: test plan
tasks:
  setup-database:
    name: Setup Database
    description: Initialize the database
    prompt: Setup the database
    type: coding
    depends_on: []
    agent: claude
`

const YAML_V2_MODIFIED = `
version: "1"
session:
  name: test plan
tasks:
  setup-database:
    name: Setup Database
    description: Initialize the database
    prompt: Setup the database
    type: coding
    depends_on: []
    agent: codex
  write-tests:
    name: Write Tests
    description: Write comprehensive unit tests
    prompt: Write tests
    type: testing
    depends_on:
      - setup-database
`

// ---------------------------------------------------------------------------
// Helper to open in-memory DB
// ---------------------------------------------------------------------------

function openTestDb(): BetterSqlite3Database {
  const db = new BetterSqlite3(':memory:')
  db.pragma('foreign_keys = ON')
  runMigrations(db)
  return db
}

function seedPlan(db: BetterSqlite3Database, planId: string, yaml: string) {
  createPlan(db, {
    id: planId,
    description: 'Test plan',
    task_count: 2,
    estimated_cost_usd: 0.5,
    planning_agent: 'claude',
    plan_yaml: yaml,
    status: 'draft',
  })
  createPlanVersion(db, {
    plan_id: planId,
    version: 1,
    task_graph_yaml: yaml,
    feedback_used: null,
    planning_cost_usd: 0.0,
  })
}

// ---------------------------------------------------------------------------
// computePlanDiff tests
// ---------------------------------------------------------------------------

describe('computePlanDiff', () => {
  it('returns empty diff for identical YAMLs', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V1)
    expect(diff.added).toHaveLength(0)
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  it('detects added tasks', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V2_ADDED)
    expect(diff.added).toContain('add-auth')
    expect(diff.removed).toHaveLength(0)
    expect(diff.modified).toHaveLength(0)
  })

  it('detects removed tasks', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V2_REMOVED)
    expect(diff.removed).toContain('write-tests')
    expect(diff.added).toHaveLength(0)
  })

  it('detects modified tasks (agent field changed)', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V2_MODIFIED)
    const modifiedTask = diff.modified.find((m) => m.taskId === 'setup-database')
    expect(modifiedTask).toBeDefined()
    const agentChange = modifiedTask?.changes.find((c) => c.field === 'agent')
    expect(agentChange).toBeDefined()
    expect(agentChange?.from).toBe('claude')
    expect(agentChange?.to).toBe('codex')
  })

  it('detects modified tasks (description field changed)', () => {
    const diff = computePlanDiff(YAML_V1, YAML_V2_MODIFIED)
    const modifiedWriteTests = diff.modified.find((m) => m.taskId === 'write-tests')
    expect(modifiedWriteTests).toBeDefined()
    const descChange = modifiedWriteTests?.changes.find((c) => c.field === 'description')
    expect(descChange).toBeDefined()
    expect(descChange?.from).toBe('Write unit tests')
    expect(descChange?.to).toBe('Write comprehensive unit tests')
  })

  it('handles malformed YAML gracefully', () => {
    const diff = computePlanDiff('not valid yaml: [', YAML_V1)
    // Should not throw; tasks from invalid yaml are treated as empty
    expect(diff).toBeDefined()
    expect(diff.added).toBeDefined()
    expect(diff.removed).toBeDefined()
    expect(diff.modified).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// countTasksInYaml tests
// ---------------------------------------------------------------------------

describe('countTasksInYaml', () => {
  it('returns correct task count', () => {
    expect(countTasksInYaml(YAML_V1)).toBe(2)
  })

  it('returns 0 for malformed YAML', () => {
    expect(countTasksInYaml('not: valid: yaml: [')).toBe(0)
  })

  it('returns 0 for empty string', () => {
    expect(countTasksInYaml('')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// buildRefinementPrompt tests
// ---------------------------------------------------------------------------

describe('buildRefinementPrompt', () => {
  it('includes current YAML, feedback history, and new feedback', () => {
    const prompt = buildRefinementPrompt({
      currentYaml: YAML_V1,
      feedbackHistory: ['make tasks smaller', 'add more detail'],
      newFeedback: 'add auth tasks',
      availableAgents: ['claude', 'codex'],
    })

    expect(prompt).toContain(YAML_V1)
    expect(prompt).toContain('Round 1: make tasks smaller')
    expect(prompt).toContain('Round 2: add more detail')
    expect(prompt).toContain('add auth tasks')
    expect(prompt).toContain('claude')
    expect(prompt).toContain('codex')
  })

  it('omits feedback history section when no prior feedback', () => {
    const prompt = buildRefinementPrompt({
      currentYaml: YAML_V1,
      feedbackHistory: [],
      newFeedback: 'initial refinement',
    })

    expect(prompt).not.toContain('Prior Refinement Feedback')
    expect(prompt).toContain('initial refinement')
  })

  it('includes output format instruction', () => {
    const prompt = buildRefinementPrompt({
      currentYaml: YAML_V1,
      feedbackHistory: [],
      newFeedback: 'test',
    })
    expect(prompt).toContain('Output Format')
    expect(prompt).toContain('complete, updated task graph YAML')
  })
})

// ---------------------------------------------------------------------------
// PlanRefiner.refine tests
// ---------------------------------------------------------------------------

describe('PlanRefiner.refine', () => {
  let db: BetterSqlite3Database

  beforeEach(() => {
    db = openTestDb()
  })

  it('throws when plan not found', async () => {
    const mockGenerator = {
      generate: vi.fn(),
    }

    const refiner = new PlanRefiner({
      db,
      planGenerator: mockGenerator as any,
    })

    await expect(refiner.refine('nonexistent-plan', 'feedback')).rejects.toThrow(
      'Plan not found: nonexistent-plan',
    )
  })

  it('throws when no versions found', async () => {
    // Insert plan without any version
    createPlan(db, {
      id: 'plan-no-versions',
      description: 'test',
      task_count: 0,
      estimated_cost_usd: 0,
      planning_agent: 'claude',
      plan_yaml: '',
      status: 'draft',
    })

    const mockGenerator = {
      generate: vi.fn(),
    }

    const refiner = new PlanRefiner({
      db,
      planGenerator: mockGenerator as any,
    })

    await expect(refiner.refine('plan-no-versions', 'feedback')).rejects.toThrow(
      'No versions found for plan: plan-no-versions',
    )
  })

  it('happy path: creates new version and emits events', async () => {
    const planId = 'plan-happy-path'
    seedPlan(db, planId, YAML_V1)

    // Mock generator to return the V2 YAML (with an added task)
    const mockGenerator = {
      generate: vi.fn().mockImplementation(async ({ outputPath }: { outputPath: string }) => {
        // Write the mock YAML to the output path
        const { writeFileSync } = await import('fs')
        writeFileSync(outputPath, YAML_V2_ADDED, 'utf-8')
        return { success: true, taskCount: 3 }
      }),
    }

    const events: { event: string; payload: Record<string, unknown> }[] = []
    const refiner = new PlanRefiner({
      db,
      planGenerator: mockGenerator as any,
      tempDir: '/tmp',
    })

    const result = await refiner.refine(planId, 'add auth tasks', (event, payload) => {
      events.push({ event, payload })
    })

    expect(result.newVersion).toBe(2)
    expect(result.taskCount).toBe(3)
    expect(result.updatedYaml).toContain('add-auth')

    // Check events
    const refiningEvent = events.find((e) => e.event === 'plan:refining')
    expect(refiningEvent).toBeDefined()
    expect(refiningEvent?.payload.planId).toBe(planId)
    expect(refiningEvent?.payload.feedback).toBe('add auth tasks')
    expect(refiningEvent?.payload.currentVersion).toBe(1)

    const refinedEvent = events.find((e) => e.event === 'plan:refined')
    expect(refinedEvent).toBeDefined()
    expect(refinedEvent?.payload.newVersion).toBe(2)

    // Check DB state
    const { getPlanVersion, getPlanVersionHistory } = await import('../../../persistence/queries/plan-versions.js')
    const v2 = getPlanVersion(db, planId, 2)
    expect(v2).toBeDefined()
    expect(v2?.feedback_used).toBe('add auth tasks')

    const history = getPlanVersionHistory(db, planId)
    expect(history).toHaveLength(2)
  })

  it('emits plan:refinement-failed and rethrows PlanError on planning error', async () => {
    const planId = 'plan-error-case'
    seedPlan(db, planId, YAML_V1)

    const mockGenerator = {
      generate: vi.fn().mockResolvedValue({ success: false, error: 'adapter failed' }),
    }

    const events: { event: string; payload: Record<string, unknown> }[] = []
    const refiner = new PlanRefiner({
      db,
      planGenerator: mockGenerator as any,
      tempDir: '/tmp',
    })

    await expect(
      refiner.refine(planId, 'bad feedback', (event, payload) => {
        events.push({ event, payload })
      }),
    ).rejects.toThrow()

    const failedEvent = events.find((e) => e.event === 'plan:refinement-failed')
    expect(failedEvent).toBeDefined()
    expect(failedEvent?.payload.planId).toBe(planId)
    expect(String(failedEvent?.payload.error)).toContain('adapter failed')
  })

  it('includes feedbackHistory in subsequent refinements', async () => {
    const planId = 'plan-history'
    seedPlan(db, planId, YAML_V1)

    // Add v2 with feedback
    createPlanVersion(db, {
      plan_id: planId,
      version: 2,
      task_graph_yaml: YAML_V2_ADDED,
      feedback_used: 'first feedback round',
      planning_cost_usd: 0.0,
    })

    // Update current_version to 2
    const { updatePlan } = await import('../../../persistence/queries/plans.js')
    updatePlan(db, planId, { current_version: 2 })

    let capturedGoal = ''
    const mockGenerator = {
      generate: vi.fn().mockImplementation(async ({ goal, outputPath }: { goal: string; outputPath: string }) => {
        capturedGoal = goal
        const { writeFileSync } = await import('fs')
        writeFileSync(outputPath, YAML_V1, 'utf-8')
        return { success: true, taskCount: 2 }
      }),
    }

    const refiner = new PlanRefiner({
      db,
      planGenerator: mockGenerator as any,
      tempDir: '/tmp',
    })

    await refiner.refine(planId, 'second feedback round')

    // The goal passed to the generator should include the feedback history
    expect(capturedGoal).toContain('first feedback round')
    expect(capturedGoal).toContain('second feedback round')
    expect(capturedGoal).toContain('Prior Refinement Feedback')
  })
})
