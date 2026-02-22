/**
 * Unit tests for runPlanningPhase().
 *
 * Covers AC1-AC8:
 *   AC1: Compiled planning prompt retrieval via pack.getPrompt('planning')
 *   AC2: Product brief context injection from decision store into {{product_brief}}
 *   AC3: Requirements generation with functional_requirements, non_functional_requirements, user_stories, tech_stack, domain_model, out_of_scope
 *   AC4: Decision store persistence for planning decisions
 *   AC5: Requirements table population via createRequirement()
 *   AC6: Artifact registration with type='prd'
 *   AC7: Token budget compliance (<= 3,500 tokens)
 *   AC8: Failure handling for dispatch errors, timeouts, invalid YAML, missing product brief
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../../persistence/migrations/index.js'
import { createPipelineRun, createDecision, getArtifactByTypeForRun } from '../../../../persistence/queries/decisions.js'
import { runPlanningPhase } from '../planning.js'
import type { PhaseDeps, PlanningPhaseParams, PlanningOutput } from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'planning-phase-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

/**
 * Seed the database with analysis-phase product brief decisions.
 */
function seedProductBrief(db: BetterSqlite3Database, runId: string): void {
  const fields = [
    { key: 'problem_statement', value: 'Users need a way to manage their tasks efficiently.' },
    { key: 'target_users', value: JSON.stringify(['developers', 'teams']) },
    { key: 'core_features', value: JSON.stringify(['task creation', 'task assignment', 'progress tracking']) },
    { key: 'success_metrics', value: JSON.stringify(['50% reduction in missed deadlines', '90% user satisfaction']) },
    { key: 'constraints', value: JSON.stringify(['must run on web browsers', 'GDPR compliant']) },
  ]
  for (const { key, value } of fields) {
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      category: 'product-brief',
      key,
      value,
    })
  }
}

const SAMPLE_PLANNING_OUTPUT: { result: 'success' } & PlanningOutput = {
  result: 'success',
  functional_requirements: [
    { description: 'User can create tasks with title and description', priority: 'must' },
    { description: 'User can assign tasks to team members', priority: 'must' },
    { description: 'User can set task due dates and priorities', priority: 'should' },
  ],
  non_functional_requirements: [
    { description: 'System must respond to task creation within 500ms', category: 'performance' },
    { description: 'System must encrypt all user data at rest', category: 'security' },
  ],
  user_stories: [
    { title: 'Create a task', description: 'As a developer, I want to create tasks so that I can track my work.' },
  ],
  tech_stack: {
    language: 'TypeScript',
    framework: 'Node.js',
    database: 'SQLite',
  },
  domain_model: {
    Task: { fields: ['id', 'title', 'description', 'assignee', 'dueDate'] },
    User: { fields: ['id', 'name', 'email'] },
  },
  out_of_scope: ['Mobile application', 'Offline mode'],
}

function makeDispatchResult(
  overrides: Partial<DispatchResult<typeof SAMPLE_PLANNING_OUTPUT>> = {},
): DispatchResult<typeof SAMPLE_PLANNING_OUTPUT> {
  return {
    id: 'dispatch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: SAMPLE_PLANNING_OUTPUT,
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 500, output: 200 },
    ...overrides,
  }
}

function makeDispatcher(result: DispatchResult<unknown>): Dispatcher {
  const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: result.id,
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(result),
  }
  return {
    dispatch: vi.fn().mockReturnValue(handle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makePack(
  template = 'Generate a PRD for the following product brief:\n\n{{product_brief}}\n\nOutput YAML with all required fields.',
): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [],
      prompts: { planning: 'prompts/planning.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(template),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeDeps(
  db: BetterSqlite3Database,
  dispatcher: Dispatcher,
  pack?: MethodologyPack,
): PhaseDeps {
  return {
    db,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('runPlanningPhase()', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
    runId = createTestRun(db)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // -------------------------------------------------------------------------
  // AC1: Compiled planning prompt retrieval
  // -------------------------------------------------------------------------

  describe('AC1: Compiled planning prompt retrieval', () => {
    it('calls pack.getPrompt("planning") to retrieve the template', async () => {
      seedProductBrief(db, runId)
      const pack = makePack()
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      expect(pack.getPrompt).toHaveBeenCalledWith('planning')
      expect(pack.getPrompt).toHaveBeenCalledTimes(1)
    })

    it('dispatches to claude-code agent with taskType planning', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'claude-code',
          taskType: 'planning',
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Product brief context injection
  // -------------------------------------------------------------------------

  describe('AC2: Product brief context injection', () => {
    it('injects product brief into the {{product_brief}} placeholder', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const dispatchCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      expect(dispatchCall.prompt).not.toContain('{{product_brief}}')
      expect(dispatchCall.prompt).toContain('Product Brief')
    })

    it('includes all five product brief fields in the formatted brief', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const dispatchCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      expect(dispatchCall.prompt).toContain('Problem Statement')
      expect(dispatchCall.prompt).toContain('Target Users')
      expect(dispatchCall.prompt).toContain('Core Features')
      expect(dispatchCall.prompt).toContain('Success Metrics')
      expect(dispatchCall.prompt).toContain('Constraints')
    })

    it('includes problem_statement content in the assembled prompt', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const dispatchCall = vi.mocked(dispatcher.dispatch).mock.calls[0][0]
      expect(dispatchCall.prompt).toContain('Users need a way to manage their tasks efficiently.')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Requirements generation
  // -------------------------------------------------------------------------

  describe('AC3: Requirements generation', () => {
    it('returns success with requirements_count and user_stories_count', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('success')
      expect(result.requirements_count).toBe(5) // 3 FRs + 2 NFRs
      expect(result.user_stories_count).toBe(1)
    })

    it('returns an artifact_id on success', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('success')
      expect(result.artifact_id).toBeDefined()
      expect(typeof result.artifact_id).toBe('string')
    })

    it('returns correct requirements_count matching functional + non-functional', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      // 3 functional + 2 non-functional = 5 total
      expect(result.requirements_count).toBe(
        SAMPLE_PLANNING_OUTPUT.functional_requirements.length +
          SAMPLE_PLANNING_OUTPUT.non_functional_requirements.length,
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Decision store persistence
  // -------------------------------------------------------------------------

  describe('AC4: Decision store persistence', () => {
    it('stores functional requirements as decisions with category=functional-requirements', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning' AND category = 'functional-requirements' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string }>

      expect(decisions).toHaveLength(3)
      expect(decisions[0].key).toBe('FR-0')
      expect(decisions[1].key).toBe('FR-1')
      expect(decisions[2].key).toBe('FR-2')

      const fr0 = JSON.parse(decisions[0].value)
      expect(fr0.description).toBe(SAMPLE_PLANNING_OUTPUT.functional_requirements[0].description)
      expect(fr0.priority).toBe('must')
    })

    it('stores non-functional requirements as decisions with category=non-functional-requirements', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning' AND category = 'non-functional-requirements' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string }>

      expect(decisions).toHaveLength(2)
      expect(decisions[0].key).toBe('NFR-0')
      expect(decisions[1].key).toBe('NFR-1')

      const nfr0 = JSON.parse(decisions[0].value)
      expect(nfr0.description).toBe(SAMPLE_PLANNING_OUTPUT.non_functional_requirements[0].description)
      expect(nfr0.category).toBe('performance')
    })

    it('stores tech stack decisions with category=tech-stack', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning' AND category = 'tech-stack' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string }>

      expect(decisions.length).toBeGreaterThanOrEqual(1)
      const keyMap = Object.fromEntries(decisions.map((d) => [d.key, d.value]))
      expect(keyMap['language']).toBe('TypeScript')
      expect(keyMap['database']).toBe('SQLite')
    })

    it('stores user stories as decisions with category=user-stories', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const decisions = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning' AND category = 'user-stories' ORDER BY key ASC",
        )
        .all(runId) as Array<{ key: string; value: string }>

      expect(decisions).toHaveLength(1)
      expect(decisions[0].key).toBe('US-0')
      const us0 = JSON.parse(decisions[0].value)
      expect(us0.title).toBe('Create a task')
    })

    it('stores domain model as a decision with category=domain-model', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const decision = db
        .prepare(
          "SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning' AND category = 'domain-model' AND key = 'entities' LIMIT 1",
        )
        .get(runId) as { key: string; value: string } | undefined

      expect(decision).toBeDefined()
      const domainModel = JSON.parse(decision!.value)
      expect(domainModel).toHaveProperty('Task')
    })

    it('does NOT store decisions when dispatch fails', async () => {
      seedProductBrief(db, runId)
      const failResult = makeDispatchResult({ status: 'failed', parsed: null, parseError: 'error' })
      const dispatcher = makeDispatcher(failResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const decisions = db
        .prepare("SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning'")
        .all(runId)

      expect(decisions).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Requirements table population
  // -------------------------------------------------------------------------

  describe('AC5: Requirements table population', () => {
    it('creates Requirement records for each functional requirement', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const requirements = db
        .prepare(
          "SELECT * FROM requirements WHERE pipeline_run_id = ? AND source = 'planning-phase' AND type = 'functional' ORDER BY created_at ASC",
        )
        .all(runId) as Array<{ description: string; priority: string; type: string }>

      expect(requirements).toHaveLength(3)
      expect(requirements[0].description).toBe(SAMPLE_PLANNING_OUTPUT.functional_requirements[0].description)
      expect(requirements[0].priority).toBe('must')
      expect(requirements[0].type).toBe('functional')
    })

    it('creates Requirement records for each non-functional requirement with priority=should', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const requirements = db
        .prepare(
          "SELECT * FROM requirements WHERE pipeline_run_id = ? AND source = 'planning-phase' AND type = 'non_functional' ORDER BY created_at ASC",
        )
        .all(runId) as Array<{ description: string; priority: string; type: string }>

      expect(requirements).toHaveLength(2)
      expect(requirements[0].priority).toBe('should')
      expect(requirements[0].type).toBe('non_functional')
    })

    it('total requirement count matches functional + non-functional counts', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      const allRequirements = db
        .prepare("SELECT * FROM requirements WHERE pipeline_run_id = ? AND source = 'planning-phase'")
        .all(runId)

      expect(allRequirements).toHaveLength(result.requirements_count!)
      expect(allRequirements).toHaveLength(5) // 3 FRs + 2 NFRs
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Artifact registration
  // -------------------------------------------------------------------------

  describe('AC6: Artifact registration', () => {
    it('registers a prd artifact with correct phase and type', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      const artifact = db
        .prepare(
          "SELECT * FROM artifacts WHERE pipeline_run_id = ? AND phase = 'planning' AND type = 'prd'",
        )
        .get(runId) as { id: string; phase: string; type: string; path: string; summary: string } | undefined

      expect(artifact).toBeDefined()
      expect(artifact!.phase).toBe('planning')
      expect(artifact!.type).toBe('prd')
      expect(artifact!.path).toBe('decision-store://planning/prd')
      expect(result.artifact_id).toBe(artifact!.id)
    })

    it('artifact summary contains requirement counts', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const artifact = db
        .prepare("SELECT summary FROM artifacts WHERE pipeline_run_id = ? AND type = 'prd'")
        .get(runId) as { summary: string } | undefined

      expect(artifact).toBeDefined()
      expect(artifact!.summary).toContain('FRs')
      expect(artifact!.summary).toContain('NFRs')
      expect(artifact!.summary).toContain('user stories')
    })

    it('artifact can be retrieved by getArtifactByTypeForRun after success', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const artifact = getArtifactByTypeForRun(db, runId, 'planning', 'prd')
      expect(artifact).toBeDefined()
    })

    it('does NOT register artifact when dispatch fails', async () => {
      seedProductBrief(db, runId)
      const failResult = makeDispatchResult({ status: 'failed', parsed: null, parseError: 'bad yaml' })
      const dispatcher = makeDispatcher(failResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const artifacts = db
        .prepare("SELECT * FROM artifacts WHERE pipeline_run_id = ? AND phase = 'planning'")
        .all(runId)

      expect(artifacts).toHaveLength(0)
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Token budget compliance
  // -------------------------------------------------------------------------

  describe('AC7: Token budget compliance', () => {
    it('assembled prompt (with brief product brief) is within 3500 token budget', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      // Should succeed (not fail with prompt_too_long)
      expect(result.result).toBe('success')
    })

    it('returns failed with prompt_too_long when assembled prompt exceeds 3500 tokens', async () => {
      seedProductBrief(db, runId)
      // Template is enormous — way over budget even after brief injection
      const hugTemplate = 'A'.repeat(14_001 * 4) + ' {{product_brief}}'
      const pack = makePack(hugTemplate)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('prompt_too_long')
    })

    it('passes PlanningOutputSchema to the dispatcher', async () => {
      seedProductBrief(db, runId)
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      expect(dispatcher.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          outputSchema: expect.anything(),
        }),
      )
    })
  })

  // -------------------------------------------------------------------------
  // AC8: Failure handling
  // -------------------------------------------------------------------------

  describe('AC8: Failure handling', () => {
    it('returns { result: "failed" } when dispatch status is failed', async () => {
      seedProductBrief(db, runId)
      const failResult = makeDispatchResult({
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'agent error',
      })
      const dispatcher = makeDispatcher(failResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBeDefined()
    })

    it('returns { result: "failed" } when dispatch status is timeout', async () => {
      seedProductBrief(db, runId)
      const timeoutResult = makeDispatchResult({
        status: 'timeout',
        exitCode: -1,
        parsed: null,
        parseError: null,
        durationMs: 300_001,
      })
      const dispatcher = makeDispatcher(timeoutResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('dispatch_timeout')
    })

    it('returns { result: "failed" } with schema_validation_failed when parsed is null', async () => {
      seedProductBrief(db, runId)
      const nullResult = makeDispatchResult({
        status: 'completed',
        parsed: null,
        parseError: 'YAML parse error',
      })
      const dispatcher = makeDispatcher(nullResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('schema_validation_failed')
    })

    it('returns failed when agent reports result: failed in output', async () => {
      seedProductBrief(db, runId)
      const agentFailResult = makeDispatchResult({
        parsed: {
          ...SAMPLE_PLANNING_OUTPUT,
          result: 'failed' as const,
        },
      })
      const dispatcher = makeDispatcher(agentFailResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('agent_reported_failure')
    })

    it('handles pack.getPrompt throwing an error gracefully', async () => {
      seedProductBrief(db, runId)
      const pack = makePack()
      vi.mocked(pack.getPrompt).mockRejectedValue(new Error('Prompt file not found'))
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toContain('Prompt file not found')
    })

    it('returns failed with descriptive error when no product brief decisions exist', async () => {
      // No seedProductBrief call — empty analysis phase
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('missing_product_brief')
      expect(result.details).toContain('analysis phase')
    })

    it('does not store decisions when missing product brief', async () => {
      // No seedProductBrief call
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      await runPlanningPhase(deps, params)

      const decisions = db
        .prepare("SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning'")
        .all(runId)

      expect(decisions).toHaveLength(0)
    })

    it('returns tokenUsage { input: 0, output: 0 } when pack.getPrompt throws', async () => {
      seedProductBrief(db, runId)
      const pack = makePack()
      vi.mocked(pack.getPrompt).mockRejectedValue(new Error('file missing'))
      const dispatcher = makeDispatcher(makeDispatchResult())
      const deps = makeDeps(db, dispatcher, pack)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.tokenUsage.input).toBe(0)
      expect(result.tokenUsage.output).toBe(0)
    })

    it('populates tokenUsage from dispatch result tokenEstimate', async () => {
      seedProductBrief(db, runId)
      const dispatchResult = makeDispatchResult({
        tokenEstimate: { input: 750, output: 300 },
      })
      const dispatcher = makeDispatcher(dispatchResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.tokenUsage.input).toBe(750)
      expect(result.tokenUsage.output).toBe(300)
    })

    it('includes descriptive error details on schema validation failure', async () => {
      seedProductBrief(db, runId)
      const invalidResult = makeDispatchResult({
        status: 'completed',
        parsed: null,
        parseError: 'Missing required field: functional_requirements',
      })
      const dispatcher = makeDispatcher(invalidResult)
      const deps = makeDeps(db, dispatcher)
      const params: PlanningPhaseParams = { runId }

      const result = await runPlanningPhase(deps, params)

      expect(result.result).toBe('failed')
      expect(result.error).toBe('schema_validation_failed')
      expect(result.details).toBeDefined()
    })
  })
})
