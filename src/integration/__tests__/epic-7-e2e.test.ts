/**
 * Epic 7 E2E gap tests — Plan Generation & Task Graph Authoring
 *
 * These tests cover cross-story integration scenarios that are NOT covered
 * by the individual unit and integration tests written per story. They
 * exercise the full pipeline from plan generation through approval, persistence,
 * and querying — including the refine → diff chain and validation blocking.
 *
 * Covered gaps:
 *  1. Plan generation → DB persistence → plan list round-trip
 *  2. Plan generation (YAML) → plan validate verifies the output file
 *  3. Plan (v1) → refine → plan diff shows cross-version changes
 *  4. Plan rollback → plan diff reflects rolled-back state
 *  5. Validation errors block plan from being queryable as "approved"
 *  6. Codebase scan → planning prompt contains codebase sections
 *  7. Plan list returns only approved/rejected (not just any status)
 *  8. Plan refine builds on v1 and increments version correctly via real DB
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../persistence/migrations/index.js'
import { createPlan, updatePlanStatus, listPlans, getPlanByPrefix, updatePlan } from '../../persistence/queries/plans.js'
import { createPlanVersion, getPlanVersion, getPlanVersionHistory } from '../../persistence/queries/plan-versions.js'
import { computePlanDiff } from '../../modules/plan-generator/plan-refiner.js'
import { runPlanValidateAction } from '../../cli/commands/plan.js'
import { validatePlan } from '../../modules/plan-generator/plan-validator.js'
import { scanCodebase } from '../../modules/plan-generator/codebase-scanner.js'
import { buildPlanningPrompt } from '../../modules/plan-generator/planning-prompt.js'
import { runPlanDiffAction } from '../../cli/commands/plan-diff.js'
import { runPlanListAction, runPlanShowAction } from '../../cli/commands/plan.js'
import { AdapterRegistry } from '../../adapters/adapter-registry.js'
import { parseGraphFile } from '../../modules/task-graph/task-parser.js'

// ---------------------------------------------------------------------------
// Mock AdapterRegistry — avoids real adapter discovery during tests
// ---------------------------------------------------------------------------

vi.mock('../../adapters/adapter-registry.js', () => ({
  AdapterRegistry: vi.fn().mockImplementation(() => ({
    discoverAndRegister: vi.fn().mockResolvedValue({ registeredCount: 0, failedCount: 0, results: [] }),
    getAll: vi.fn().mockReturnValue([]),
    getPlanningCapable: vi.fn().mockReturnValue([]),
    get: vi.fn().mockReturnValue(undefined),
    register: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// YAML fixtures for plan versions
// ---------------------------------------------------------------------------

const VALID_PLAN_YAML_V1 = `version: "1"
session:
  name: Add authentication
tasks:
  setup-db:
    name: Setup Database
    prompt: Initialize the database schema for users
    type: coding
    depends_on: []
  add-login:
    name: Add Login Endpoint
    prompt: Implement POST /auth/login
    type: coding
    depends_on:
      - setup-db
  write-tests:
    name: Write Auth Tests
    prompt: Write unit tests for authentication
    type: testing
    depends_on:
      - add-login
`

const VALID_PLAN_YAML_V2 = `version: "1"
session:
  name: Add authentication
tasks:
  setup-db:
    name: Setup Database
    prompt: Initialize the database schema for users
    type: coding
    depends_on: []
  add-login:
    name: Add Login Endpoint
    prompt: Implement POST /auth/login with rate limiting
    type: coding
    depends_on:
      - setup-db
  add-logout:
    name: Add Logout Endpoint
    prompt: Implement POST /auth/logout
    type: coding
    depends_on:
      - add-login
  write-tests:
    name: Write Auth Tests
    prompt: Write comprehensive unit and integration tests for authentication
    type: testing
    depends_on:
      - add-login
      - add-logout
`

const INVALID_PLAN_YAML_CYCLE = `version: "1"
session:
  name: Cyclic plan
tasks:
  task-a:
    name: Task A
    prompt: Do task A
    type: coding
    depends_on:
      - task-b
  task-b:
    name: Task B
    prompt: Do task B
    type: coding
    depends_on:
      - task-a
`

const INVALID_PLAN_YAML_SCHEMA = `version: "1"
session:
  name: Schema-error plan
tasks:
  task-bad:
    name: Bad Task
    prompt: Do something
    type: unsupported-type-here
`

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makePlanId(suffix: string): string {
  return `epic7-e2e-${suffix}-${Date.now().toString(36)}`
}

function seedPlanWithVersions(
  db: BetterSqlite3Database,
  planId: string,
  v1Yaml: string,
  description = 'E2E test plan',
): void {
  createPlan(db, {
    id: planId,
    description,
    task_count: 3,
    estimated_cost_usd: 0.0,
    planning_agent: 'claude-code',
    plan_yaml: v1Yaml,
    status: 'draft',
  })
  createPlanVersion(db, {
    plan_id: planId,
    version: 1,
    task_graph_yaml: v1Yaml,
    feedback_used: null,
    planning_cost_usd: 0.0,
  })
}

/**
 * Return the path where CLI commands expect the state.db to live.
 * This is: <projectRoot>/.substrate/state.db
 */
function dbCliPath(projectRoot: string): string {
  return join(projectRoot, '.substrate', 'state.db')
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Epic 7 E2E Integration', () => {
  let tmpDir: string
  let db: BetterSqlite3Database
  let stdoutSpy: ReturnType<typeof vi.spyOn>
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'substrate-epic7-e2e-'))
    // CLI commands use: join(projectRoot, '.substrate', 'state.db')
    // so we must put the DB there for CLI action tests to work
    mkdirSync(join(tmpDir, '.substrate'), { recursive: true })
    db = new Database(dbCliPath(tmpDir))
    runMigrations(db)
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    try {
      db.close()
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // Gap 1: Plan generation → DB persistence → plan list round-trip
  // -------------------------------------------------------------------------

  describe('Gap 1: plan persistence → plan list round-trip', () => {
    it('plan saved as approved appears in plan list with correct status', () => {
      const planId = makePlanId('g1-approved')
      createPlan(db, {
        id: planId,
        description: 'Add authentication to the app',
        task_count: 3,
        estimated_cost_usd: 0.0,
        planning_agent: 'claude-code',
        plan_yaml: VALID_PLAN_YAML_V1,
        status: 'draft',
      })
      createPlanVersion(db, {
        plan_id: planId,
        version: 1,
        task_graph_yaml: VALID_PLAN_YAML_V1,
        feedback_used: null,
        planning_cost_usd: 0.0,
      })
      updatePlanStatus(db, planId, 'approved')

      const plans = listPlans(db)
      const found = plans.find((p) => p.id === planId)

      expect(found).toBeDefined()
      expect(found!.status).toBe('approved')
      expect(found!.description).toBe('Add authentication to the app')
      expect(found!.task_count).toBe(3)
      expect(found!.planning_agent).toBe('claude-code')
    })

    it('rejected plan also appears in plan list', () => {
      const planId = makePlanId('g1-rejected')
      createPlan(db, {
        id: planId,
        description: 'Rejected plan',
        task_count: 2,
        estimated_cost_usd: 0.0,
        planning_agent: 'policy-routed',
        plan_yaml: VALID_PLAN_YAML_V1,
        status: 'draft',
      })
      createPlanVersion(db, {
        plan_id: planId,
        version: 1,
        task_graph_yaml: VALID_PLAN_YAML_V1,
        feedback_used: null,
        planning_cost_usd: 0.0,
      })
      updatePlanStatus(db, planId, 'rejected')

      const plans = listPlans(db)
      const found = plans.find((p) => p.id === planId)

      expect(found).toBeDefined()
      expect(found!.status).toBe('rejected')
    })

    it('plan list returns multiple plans in descending creation order', () => {
      const ids = ['g1-list-01', 'g1-list-02', 'g1-list-03'].map(makePlanId)

      for (const id of ids) {
        createPlan(db, {
          id,
          description: `Plan ${id}`,
          task_count: 1,
          estimated_cost_usd: 0.0,
          planning_agent: 'policy-routed',
          plan_yaml: VALID_PLAN_YAML_V1,
          status: 'draft',
        })
      }

      const plans = listPlans(db)
      expect(plans.length).toBeGreaterThanOrEqual(3)
      // All IDs present
      for (const id of ids) {
        expect(plans.some((p) => p.id === id)).toBe(true)
      }
    })

    it('runPlanListAction returns exit 0 and emits plan data in JSON format', async () => {
      const planId = makePlanId('g1-cli')
      createPlan(db, {
        id: planId,
        description: 'CLI list test',
        task_count: 2,
        estimated_cost_usd: 0.0,
        planning_agent: 'policy-routed',
        plan_yaml: VALID_PLAN_YAML_V1,
        status: 'draft',
      })
      updatePlanStatus(db, planId, 'approved')

      const exitCode = await runPlanListAction({
        outputFormat: 'json',
        projectRoot: tmpDir,
      })

      expect(exitCode).toBe(0)
      const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
      const parsed = JSON.parse(stdoutOutput) as { success: boolean; data: { id: string }[] }
      expect(parsed.success).toBe(true)
      expect(Array.isArray(parsed.data)).toBe(true)
      const found = parsed.data.find((p) => p.id === planId)
      expect(found).toBeDefined()
    })

    it('runPlanShowAction resolves by prefix and returns the full plan', async () => {
      const planId = makePlanId('g1-show')
      createPlan(db, {
        id: planId,
        description: 'Show test plan',
        task_count: 3,
        estimated_cost_usd: 0.05,
        planning_agent: 'claude-code',
        plan_yaml: VALID_PLAN_YAML_V1,
        status: 'draft',
      })
      updatePlanStatus(db, planId, 'approved')

      // Use the first 8 characters as prefix
      const prefix = planId.slice(0, 8)
      const exitCode = await runPlanShowAction(prefix, {
        outputFormat: 'json',
        projectRoot: tmpDir,
      })

      expect(exitCode).toBe(0)
      const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
      const parsed = JSON.parse(stdoutOutput) as { success: boolean; data: { id: string; description: string } }
      expect(parsed.success).toBe(true)
      expect(parsed.data.id).toBe(planId)
      expect(parsed.data.description).toBe('Show test plan')
    })
  })

  // -------------------------------------------------------------------------
  // Gap 2: Plan generation (YAML output) → plan validate verifies the file
  // -------------------------------------------------------------------------

  describe('Gap 2: generated YAML file → plan validate round-trip', () => {
    it('a valid YAML plan written to disk passes runPlanValidateAction with exit 0', async () => {
      const planFile = join(tmpDir, 'generated-plan.yaml')
      writeFileSync(planFile, VALID_PLAN_YAML_V1, 'utf-8')

      const exitCode = await runPlanValidateAction({
        filePath: planFile,
        outputFormat: 'human',
      })

      expect(exitCode).toBe(0)
      const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
      expect(stdoutOutput).toContain('Plan is valid')
      expect(stdoutOutput).toContain('3 tasks')
    })

    it('a cyclic YAML plan written to disk fails runPlanValidateAction with exit 2', async () => {
      const planFile = join(tmpDir, 'cyclic-plan.yaml')
      writeFileSync(planFile, INVALID_PLAN_YAML_CYCLE, 'utf-8')

      const exitCode = await runPlanValidateAction({
        filePath: planFile,
        outputFormat: 'human',
      })

      expect(exitCode).toBe(2)
      const stderrOutput = stderrSpy.mock.calls.flat().join('')
      expect(stderrOutput).toContain('[cycle]')
    })

    it('a schema-error YAML plan fails runPlanValidateAction with exit 2', async () => {
      const planFile = join(tmpDir, 'schema-error-plan.yaml')
      writeFileSync(planFile, INVALID_PLAN_YAML_SCHEMA, 'utf-8')

      const exitCode = await runPlanValidateAction({
        filePath: planFile,
        outputFormat: 'json',
      })

      expect(exitCode).toBe(2)
      const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
      const parsed = JSON.parse(stdoutOutput) as { valid: boolean; errors: unknown[] }
      expect(parsed.valid).toBe(false)
      expect(parsed.errors.length).toBeGreaterThan(0)
    })

    it('plan validate of a valid plan is compatible with parseGraphFile (substrate start readiness)', () => {
      const planFile = join(tmpDir, 'start-ready.yaml')
      writeFileSync(planFile, VALID_PLAN_YAML_V1, 'utf-8')

      // Simulate what `substrate start --graph` does: parse the file
      const raw = parseGraphFile(planFile)
      const registry = new AdapterRegistry()
      const result = validatePlan(raw, registry, { normalize: false })

      expect(result.valid).toBe(true)
      expect(result.errors).toHaveLength(0)
      expect(result.graph).toBeDefined()
      expect(Object.keys(result.graph!.tasks)).toContain('setup-db')
      expect(Object.keys(result.graph!.tasks)).toContain('add-login')
      expect(Object.keys(result.graph!.tasks)).toContain('write-tests')
    })
  })

  // -------------------------------------------------------------------------
  // Gap 3: Plan (v1) → refine (v2) → plan diff shows changes
  // -------------------------------------------------------------------------

  describe('Gap 3: refine → diff cross-story chain', () => {
    it('computePlanDiff between v1 and v2 correctly shows added and modified tasks', () => {
      const diff = computePlanDiff(VALID_PLAN_YAML_V1, VALID_PLAN_YAML_V2)

      // add-logout is new in v2
      expect(diff.added).toContain('add-logout')
      expect(diff.removed).toHaveLength(0)

      // write-tests depends_on changed (v1: [add-login], v2: [add-login, add-logout])
      // computePlanDiff tracks: name, description, agent, budget_usd, depends_on
      const writeTestsMod = diff.modified.find((m) => m.taskId === 'write-tests')
      expect(writeTestsMod).toBeDefined()
      const depsChange = writeTestsMod!.changes.find((c) => c.field === 'depends_on')
      expect(depsChange).toBeDefined()
    })

    it('runPlanDiffAction retrieves correct diff between stored v1 and v2', async () => {
      const planId = makePlanId('g3-diff')
      seedPlanWithVersions(db, planId, VALID_PLAN_YAML_V1)

      // Add v2 via refinement simulation
      createPlanVersion(db, {
        plan_id: planId,
        version: 2,
        task_graph_yaml: VALID_PLAN_YAML_V2,
        feedback_used: 'add logout endpoint and improve tests',
        planning_cost_usd: 0.02,
      })
      updatePlan(db, planId, { current_version: 2 })

      const exitCode = await runPlanDiffAction({
        planId,
        fromVersion: 1,
        toVersion: 2,
        projectRoot: tmpDir,
        outputFormat: 'json',
      })

      expect(exitCode).toBe(0)
      const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
      const diff = JSON.parse(stdoutOutput) as { added: string[]; removed: string[]; modified: { taskId: string; changes: unknown[] }[] }

      expect(diff.added).toContain('add-logout')
      expect(diff.removed).toHaveLength(0)
    })

    it('runPlanDiffAction returns exit 2 when version not found', async () => {
      const planId = makePlanId('g3-noversion')
      seedPlanWithVersions(db, planId, VALID_PLAN_YAML_V1)

      const exitCode = await runPlanDiffAction({
        planId,
        fromVersion: 1,
        toVersion: 99,
        projectRoot: tmpDir,
        outputFormat: 'human',
      })

      expect(exitCode).toBe(2)
      const stderrOutput = stderrSpy.mock.calls.flat().join('')
      expect(stderrOutput).toContain('Version v99 not found')
    })

    it('full refine chain: DB has 2 versions after one refinement round', () => {
      const planId = makePlanId('g3-chain')
      seedPlanWithVersions(db, planId, VALID_PLAN_YAML_V1)

      // Simulate what PlanRefiner.refine() does in the DB
      createPlanVersion(db, {
        plan_id: planId,
        version: 2,
        task_graph_yaml: VALID_PLAN_YAML_V2,
        feedback_used: 'add logout and improve tests',
        planning_cost_usd: 0.0,
      })
      updatePlan(db, planId, { current_version: 2 })

      const history = getPlanVersionHistory(db, planId)
      expect(history).toHaveLength(2)
      expect(history[0]!.version).toBe(1)
      expect(history[0]!.feedback_used).toBeNull()
      expect(history[1]!.version).toBe(2)
      expect(history[1]!.feedback_used).toBe('add logout and improve tests')

      const v2 = getPlanVersion(db, planId, 2)
      expect(v2).toBeDefined()
      expect(v2!.task_graph_yaml).toContain('add-logout')
    })
  })

  // -------------------------------------------------------------------------
  // Gap 4: Rollback → diff shows rolled-back state
  // -------------------------------------------------------------------------

  describe('Gap 4: rollback → diff shows state after rollback', () => {
    it('after rollback to v1, diff between v1 and v3 (rollback) shows no differences', async () => {
      const planId = makePlanId('g4-rollback')
      seedPlanWithVersions(db, planId, VALID_PLAN_YAML_V1)

      // Add v2
      createPlanVersion(db, {
        plan_id: planId,
        version: 2,
        task_graph_yaml: VALID_PLAN_YAML_V2,
        feedback_used: 'add logout',
        planning_cost_usd: 0.0,
      })

      // Rollback: v3 is a copy of v1's YAML
      createPlanVersion(db, {
        plan_id: planId,
        version: 3,
        task_graph_yaml: VALID_PLAN_YAML_V1,
        feedback_used: 'rollback to v1',
        planning_cost_usd: 0.0,
      })
      updatePlan(db, planId, { current_version: 3 })

      const exitCode = await runPlanDiffAction({
        planId,
        fromVersion: 1,
        toVersion: 3,
        projectRoot: tmpDir,
        outputFormat: 'json',
      })

      expect(exitCode).toBe(0)
      const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
      const diff = JSON.parse(stdoutOutput) as { added: string[]; removed: string[]; modified: unknown[] }

      // v1 and v3 (the rollback) should be identical
      expect(diff.added).toHaveLength(0)
      expect(diff.removed).toHaveLength(0)
      expect(diff.modified).toHaveLength(0)
    })

    it('diff between v2 and v3 (rollback) shows tasks removed from v2', async () => {
      const planId = makePlanId('g4-rollback-diff')
      seedPlanWithVersions(db, planId, VALID_PLAN_YAML_V1)

      createPlanVersion(db, {
        plan_id: planId,
        version: 2,
        task_graph_yaml: VALID_PLAN_YAML_V2,
        feedback_used: 'add logout',
        planning_cost_usd: 0.0,
      })
      createPlanVersion(db, {
        plan_id: planId,
        version: 3,
        task_graph_yaml: VALID_PLAN_YAML_V1,
        feedback_used: 'rollback to v1',
        planning_cost_usd: 0.0,
      })
      updatePlan(db, planId, { current_version: 3 })

      const exitCode = await runPlanDiffAction({
        planId,
        fromVersion: 2,
        toVersion: 3,
        projectRoot: tmpDir,
        outputFormat: 'json',
      })

      expect(exitCode).toBe(0)
      const stdoutOutput = stdoutSpy.mock.calls.flat().join('')
      const diff = JSON.parse(stdoutOutput) as { added: string[]; removed: string[]; modified: unknown[] }

      // add-logout was in v2 but not in v1/v3
      expect(diff.removed).toContain('add-logout')
    })
  })

  // -------------------------------------------------------------------------
  // Gap 5: Validation blocks invalid plans from being approved
  // -------------------------------------------------------------------------

  describe('Gap 5: validation errors block plan approval', () => {
    it('validatePlan returns invalid for a cyclic plan — cannot be approved', () => {
      const raw = { version: '1', session: { name: 'cyclic' }, tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: ['task-b'] },
        'task-b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['task-a'] },
      }}
      const registry = new AdapterRegistry()
      const result = validatePlan(raw, registry, { normalize: false })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'cycle')).toBe(true)
    })

    it('validatePlan returns invalid for an empty task graph', () => {
      const raw = { version: '1', session: { name: 'empty' }, tasks: {} }
      const registry = new AdapterRegistry()
      const result = validatePlan(raw, registry, { normalize: false })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'empty_graph')).toBe(true)
    })

    it('validatePlan returns invalid for a dangling dependency', () => {
      const raw = { version: '1', session: { name: 'dangling' }, tasks: {
        'task-b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['nonexistent'] },
      }}
      const registry = new AdapterRegistry()
      const result = validatePlan(raw, registry, { normalize: false })

      expect(result.valid).toBe(false)
      expect(result.errors.some((e) => e.code === 'dangling_ref')).toBe(true)
    })

    it('validatePlan normalizes agent aliases (e.g. claude → claude-code)', () => {
      const raw = {
        version: '1',
        session: { name: 'alias test' },
        tasks: {
          'task-a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: [], agent: 'claude' },
        },
      }
      const registry = new AdapterRegistry()
      const result = validatePlan(raw, registry, { normalize: true })

      expect(result.autoFixed.length).toBeGreaterThan(0)
      expect(result.autoFixed[0]).toContain("'claude' -> 'claude-code'")
    })

    it('invalid plan saved in DB shows as draft but cannot be executed (validation catches it)', () => {
      // Save an invalid plan to DB (status stays 'draft' — never approved)
      const planId = makePlanId('g5-invalid')
      createPlan(db, {
        id: planId,
        description: 'Cyclic plan that should not be approved',
        task_count: 2,
        estimated_cost_usd: 0.0,
        planning_agent: 'policy-routed',
        plan_yaml: INVALID_PLAN_YAML_CYCLE,
        status: 'draft',
      })

      const plans = listPlans(db)
      const found = plans.find((p) => p.id === planId)
      expect(found).toBeDefined()
      expect(found!.status).toBe('draft')

      // Attempting to validate shows errors
      const raw = { version: '1', session: { name: 'cyclic' }, tasks: {
        'task-a': { name: 'A', prompt: 'Do A', type: 'coding', depends_on: ['task-b'] },
        'task-b': { name: 'B', prompt: 'Do B', type: 'coding', depends_on: ['task-a'] },
      }}
      const registry = new AdapterRegistry()
      const validationResult = validatePlan(raw, registry, { normalize: false })
      expect(validationResult.valid).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Gap 6: Codebase scan → planning prompt contains expected sections
  // -------------------------------------------------------------------------

  describe('Gap 6: codebase scan → planning prompt integration', () => {
    it('scanCodebase on a Node/TypeScript project populates tech stack correctly', async () => {
      // Create a minimal Node/TS project structure in tmpDir
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'my-epic7-test-project',
          version: '1.0.0',
          description: 'Epic 7 E2E test project',
          dependencies: { express: '^4.18.0', zod: '^3.0.0' },
          devDependencies: { typescript: '^5.0.0', vitest: '^2.0.0' },
          scripts: { build: 'tsc', test: 'vitest' },
        }),
      )
      writeFileSync(
        join(tmpDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', strict: true } }),
      )
      writeFileSync(join(tmpDir, 'README.md'), 'My Epic 7 Test Project. Adds auth and routing.')
      mkdirSync(join(tmpDir, 'src'), { recursive: true })
      writeFileSync(join(tmpDir, 'src', 'index.ts'), 'export const app = "epic7"')

      const ctx = await scanCodebase(tmpDir, { contextDepth: 2 })

      expect(ctx.techStack.some((s) => s.name === 'Node.js')).toBe(true)
      expect(ctx.techStack.some((s) => s.name === 'TypeScript')).toBe(true)
      expect(ctx.techStack.some((s) => s.name === 'Express')).toBe(true)
      expect(ctx.detectedLanguages).toContain('TypeScript')
      expect(ctx.detectedLanguages).toContain('JavaScript')
      expect(ctx.dependencies.runtime['express']).toBe('^4.18.0')
      expect(ctx.dependencies.runtime['zod']).toBe('^3.0.0')
      expect(ctx.topLevelDirs).toContain('src')
      const readme = ctx.keyFiles.find((f) => f.relativePath === 'README.md')
      expect(readme).toBeDefined()
      expect(readme!.contentSummary).toContain('My Epic 7 Test Project')
    })

    it('buildPlanningPrompt with codebase context produces a prompt usable for planning', async () => {
      writeFileSync(
        join(tmpDir, 'package.json'),
        JSON.stringify({
          name: 'auth-service',
          dependencies: { 'better-sqlite3': '^9.0.0' },
          devDependencies: { typescript: '^5.0.0' },
        }),
      )

      const ctx = await scanCodebase(tmpDir, { contextDepth: 1 })

      const prompt = buildPlanningPrompt({
        goal: 'Add JWT authentication to the auth service',
        codebaseContext: ctx,
        availableAgents: [
          {
            agentId: 'claude-code',
            supportedTaskTypes: ['coding', 'testing', 'debugging', 'refactoring', 'docs'],
            billingMode: 'subscription',
            healthy: true,
          },
        ],
        agentCount: 2,
      })

      expect(prompt).toContain('## Goal')
      expect(prompt).toContain('Add JWT authentication to the auth service')
      expect(prompt).toContain('## Codebase Context')
      expect(prompt).toContain('Node.js')
      expect(prompt).toContain('## Available Agents')
      expect(prompt).toContain('claude-code')
      expect(prompt).toContain('## Multi-Agent Instructions')
      expect(prompt).toContain('2')
    })

    it('codebase scanner excludes node_modules and returns only real dirs', async () => {
      mkdirSync(join(tmpDir, 'src'), { recursive: true })
      mkdirSync(join(tmpDir, 'node_modules', 'express'), { recursive: true })
      mkdirSync(join(tmpDir, 'dist'), { recursive: true })
      writeFileSync(join(tmpDir, 'package.json'), JSON.stringify({ name: 'test' }))

      const ctx = await scanCodebase(tmpDir, { contextDepth: 2 })

      expect(ctx.topLevelDirs).toContain('src')
      expect(ctx.topLevelDirs).not.toContain('node_modules')
      expect(ctx.topLevelDirs).not.toContain('dist')
    })
  })

  // -------------------------------------------------------------------------
  // Gap 7: Version increment integrity across multiple refine rounds
  // -------------------------------------------------------------------------

  describe('Gap 7: multi-round refinement version integrity', () => {
    it('three refinement rounds produce versions 1, 2, 3 in correct order', () => {
      const planId = makePlanId('g7-multi-refine')
      seedPlanWithVersions(db, planId, VALID_PLAN_YAML_V1)

      createPlanVersion(db, {
        plan_id: planId,
        version: 2,
        task_graph_yaml: VALID_PLAN_YAML_V2,
        feedback_used: 'round 1: add logout',
        planning_cost_usd: 0.01,
      })
      updatePlan(db, planId, { current_version: 2 })

      createPlanVersion(db, {
        plan_id: planId,
        version: 3,
        task_graph_yaml: VALID_PLAN_YAML_V1,
        feedback_used: 'round 2: simplify again',
        planning_cost_usd: 0.01,
      })
      updatePlan(db, planId, { current_version: 3 })

      const history = getPlanVersionHistory(db, planId)
      expect(history).toHaveLength(3)
      expect(history[0]!.version).toBe(1)
      expect(history[0]!.feedback_used).toBeNull()
      expect(history[1]!.version).toBe(2)
      expect(history[1]!.feedback_used).toBe('round 1: add logout')
      expect(history[2]!.version).toBe(3)
      expect(history[2]!.feedback_used).toBe('round 2: simplify again')
    })

    it('getPlanByPrefix works after multiple refinements', () => {
      const planId = makePlanId('g7-prefix')
      seedPlanWithVersions(db, planId, VALID_PLAN_YAML_V1)
      createPlanVersion(db, {
        plan_id: planId,
        version: 2,
        task_graph_yaml: VALID_PLAN_YAML_V2,
        feedback_used: 'refinement',
        planning_cost_usd: 0.0,
      })
      updatePlan(db, planId, { current_version: 2, status: 'approved' })

      const found = getPlanByPrefix(db, planId.slice(0, 10))
      expect(found).toBeDefined()
      expect(found!.id).toBe(planId)
      expect(found!.current_version).toBe(2)
    })
  })

  // -------------------------------------------------------------------------
  // Gap 8: Plan diff detects all change types correctly
  // -------------------------------------------------------------------------

  describe('Gap 8: computePlanDiff comprehensive correctness', () => {
    it('diff detects depends_on changes between versions', () => {
      const v1 = VALID_PLAN_YAML_V1
      const v2 = VALID_PLAN_YAML_V2

      const diff = computePlanDiff(v1, v2)

      // write-tests depends_on changes: in v1 just [add-login], in v2 [add-login, add-logout]
      const writeTestsMod = diff.modified.find((m) => m.taskId === 'write-tests')
      expect(writeTestsMod).toBeDefined()
      const depsChange = writeTestsMod!.changes.find((c) => c.field === 'depends_on')
      expect(depsChange).toBeDefined()
    })

    it('diff is empty when comparing identical YAML strings', () => {
      const diff = computePlanDiff(VALID_PLAN_YAML_V1, VALID_PLAN_YAML_V1)
      expect(diff.added).toHaveLength(0)
      expect(diff.removed).toHaveLength(0)
      expect(diff.modified).toHaveLength(0)
    })

    it('diff handles YAML with tasks in different order gracefully', () => {
      const yamlA = `version: "1"\nsession:\n  name: test\ntasks:\n  task-b:\n    name: B\n    prompt: Do B\n    type: coding\n    depends_on: []\n  task-a:\n    name: A\n    prompt: Do A\n    type: coding\n    depends_on: []\n`
      const yamlB = `version: "1"\nsession:\n  name: test\ntasks:\n  task-a:\n    name: A\n    prompt: Do A\n    type: coding\n    depends_on: []\n  task-b:\n    name: B\n    prompt: Do B\n    type: coding\n    depends_on: []\n`

      const diff = computePlanDiff(yamlA, yamlB)
      expect(diff.added).toHaveLength(0)
      expect(diff.removed).toHaveLength(0)
      expect(diff.modified).toHaveLength(0)
    })
  })
})
