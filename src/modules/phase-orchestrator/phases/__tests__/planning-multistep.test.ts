/**
 * Integration tests for multi-step planning phase decomposition.
 *
 * Verifies that when the manifest defines steps for the planning phase,
 * runPlanningPhase() uses the 3-step path (classification -> FRs -> NFRs)
 * and produces a valid PlanningResult with the same structure as the
 * single-dispatch path.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../../persistence/migrations/index.js'
import {
  createPipelineRun,
  createDecision,
  getDecisionsByPhaseForRun,
  getArtifactByTypeForRun,
} from '../../../../persistence/queries/decisions.js'
import { runPlanningPhase } from '../planning.js'
import type { PhaseDeps, PlanningPhaseParams } from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'planning-multistep-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

function seedAnalysisDecisions(db: BetterSqlite3Database, runId: string): void {
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'analysis',
    category: 'product-brief',
    key: 'problem_statement',
    value: 'Users struggle with fragmented task management across distributed teams.',
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'analysis',
    category: 'product-brief',
    key: 'target_users',
    value: JSON.stringify(['project managers', 'software developers']),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'analysis',
    category: 'product-brief',
    key: 'core_features',
    value: JSON.stringify(['task board', 'assignment', 'progress tracking']),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'analysis',
    category: 'product-brief',
    key: 'success_metrics',
    value: JSON.stringify(['50% reduction in missed deadlines']),
  })
  createDecision(db, {
    pipeline_run_id: runId,
    phase: 'analysis',
    category: 'product-brief',
    key: 'constraints',
    value: JSON.stringify(['web-only', 'GDPR compliant']),
  })
}

// Step outputs
const CLASSIFICATION_OUTPUT = {
  result: 'success' as const,
  project_type: 'web-application',
  vision: 'A unified task management platform for distributed teams with real-time collaboration.',
  key_goals: ['streamline task assignment', 'improve visibility', 'reduce missed deadlines'],
}

const FRS_OUTPUT = {
  result: 'success' as const,
  functional_requirements: [
    { description: 'Users can create tasks with title and description', priority: 'must' as const },
    { description: 'Users can assign tasks to team members', priority: 'must' as const },
    { description: 'Users can view tasks on a board grouped by status', priority: 'must' as const },
    { description: 'Users can track task progress over time', priority: 'should' as const },
  ],
  user_stories: [
    { title: 'Create a task', description: 'As a PM, I want to create tasks quickly.' },
    { title: 'View task board', description: 'As a developer, I want to see all my tasks.' },
  ],
}

const NFRS_OUTPUT = {
  result: 'success' as const,
  non_functional_requirements: [
    { description: 'API responses under 200ms at p95', category: 'performance' },
    { description: 'Support 1000 concurrent users', category: 'scalability' },
    { description: 'GDPR compliance for EU users', category: 'compliance' },
  ],
  tech_stack: { language: 'TypeScript', framework: 'Express', database: 'PostgreSQL' },
  domain_model: { Task: { title: 'string', status: 'string' }, User: { name: 'string' } },
  out_of_scope: ['mobile app', 'real-time chat'],
}

function makeDispatchResult(parsed: unknown, index: number): DispatchResult<unknown> {
  return {
    id: `dispatch-${index}`,
    status: 'completed',
    exitCode: 0,
    output: 'yaml',
    parsed,
    parseError: null,
    durationMs: 500,
    tokenEstimate: { input: 100 + index * 30, output: 50 + index * 15 },
  }
}

function makeMultiStepDispatcher(): Dispatcher {
  let callIndex = 0
  const results = [CLASSIFICATION_OUTPUT, FRS_OUTPUT, NFRS_OUTPUT]
  return {
    dispatch: vi.fn().mockImplementation(() => {
      const parsed = results[callIndex] ?? results[results.length - 1]
      const result = makeDispatchResult(parsed, callIndex)
      callIndex++
      return {
        id: result.id,
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(result),
      }
    }),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function makeMultiStepPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [
        {
          name: 'planning',
          description: 'Planning',
          entryGates: ['product-brief-complete'],
          exitGates: ['prd-complete'],
          artifacts: ['prd'],
          steps: [
            {
              name: 'planning-step-1-classification',
              template: 'planning-step-1-classification',
              context: [{ placeholder: 'product_brief', source: 'decision:analysis.product-brief' }],
              outputCategory: 'classification',
            },
            {
              name: 'planning-step-2-frs',
              template: 'planning-step-2-frs',
              context: [
                { placeholder: 'product_brief', source: 'decision:analysis.product-brief' },
                { placeholder: 'classification', source: 'step:planning-step-1-classification' },
              ],
              outputCategory: 'functional-requirements',
            },
            {
              name: 'planning-step-3-nfrs',
              template: 'planning-step-3-nfrs',
              context: [
                { placeholder: 'product_brief', source: 'decision:analysis.product-brief' },
                { placeholder: 'classification', source: 'step:planning-step-1-classification' },
                { placeholder: 'functional_requirements', source: 'step:planning-step-2-frs' },
              ],
              outputCategory: 'non-functional-requirements',
            },
          ],
        },
      ],
      prompts: {
        'planning-step-1-classification': 'prompts/planning-step-1-classification.md',
        'planning-step-2-frs': 'prompts/planning-step-2-frs.md',
        'planning-step-3-nfrs': 'prompts/planning-step-3-nfrs.md',
      },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockImplementation((key: string) => {
      if (key === 'planning-step-1-classification') {
        return Promise.resolve('Classify project from: {{product_brief}}')
      }
      if (key === 'planning-step-2-frs') {
        return Promise.resolve('Define FRs for: {{product_brief}} with {{classification}}')
      }
      if (key === 'planning-step-3-nfrs') {
        return Promise.resolve('Define NFRs for: {{product_brief}} with {{classification}} and {{functional_requirements}}')
      }
      return Promise.resolve('{{product_brief}}')
    }),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeNoStepsPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [
        {
          name: 'planning',
          description: 'Planning',
          entryGates: [],
          exitGates: ['prd-complete'],
          artifacts: ['prd'],
          // No steps → single-dispatch fallback
        },
      ],
      prompts: { planning: 'prompts/planning.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue('Plan: {{product_brief}}'),
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
  pack: MethodologyPack,
): PhaseDeps {
  return { db, pack, contextCompiler: makeContextCompiler(), dispatcher }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPlanningPhase() multi-step path', () => {
  let db: BetterSqlite3Database
  let tmpDir: string
  let runId: string

  beforeEach(() => {
    const setup = createTestDb()
    db = setup.db
    tmpDir = setup.tmpDir
    runId = createTestRun(db)
    seedAnalysisDecisions(db, runId)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses 3-step path when manifest defines steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = { runId }

    const result = await runPlanningPhase(deps, params)

    expect(result.result).toBe('success')
    // 3 dispatches: classification → FRs → NFRs
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })

  it('persists classification, FR, and NFR decisions', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = { runId }

    await runPlanningPhase(deps, params)

    const decisions = getDecisionsByPhaseForRun(db, runId, 'planning')

    // classification: project_type, vision, key_goals
    const classDecisions = decisions.filter((d) => d.category === 'classification')
    expect(classDecisions.length).toBeGreaterThanOrEqual(3)

    // FRs: 4 functional requirements (array-indexed)
    const frDecisions = decisions.filter((d) => d.category === 'functional-requirements')
    expect(frDecisions.length).toBeGreaterThanOrEqual(4)

    // NFRs: 3 non-functional requirements (array-indexed)
    const nfrDecisions = decisions.filter((d) => d.category === 'non-functional-requirements')
    expect(nfrDecisions.length).toBeGreaterThanOrEqual(3)
  })

  it('registers a prd artifact', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = { runId }

    const result = await runPlanningPhase(deps, params)

    expect(result.artifact_id).toBeDefined()
    const artifact = getArtifactByTypeForRun(db, runId, 'planning', 'prd')
    expect(artifact).toBeTruthy()
  })

  it('accumulates token usage across all 3 steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = { runId }

    const result = await runPlanningPhase(deps, params)

    // Step 0: input=100, output=50; Step 1: input=130, output=65; Step 2: input=160, output=80
    expect(result.tokenUsage.input).toBe(390)
    expect(result.tokenUsage.output).toBe(195)
  })

  it('returns correct requirement counts', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = { runId }

    const result = await runPlanningPhase(deps, params)

    expect(result.result).toBe('success')
    // 4 FRs + 3 NFRs = 7 total requirements
    expect(result.requirements_count).toBe(7)
    // 2 user stories
    expect(result.user_stories_count).toBe(2)
  })

  it('falls back to single-dispatch when no steps defined', async () => {
    const pack = makeNoStepsPack()
    const singleResult = makeDispatchResult(
      {
        result: 'success',
        functional_requirements: [
          { description: 'Create tasks feature for task management', priority: 'must' },
          { description: 'View board for task tracking', priority: 'must' },
          { description: 'Assign tasks to users for collaboration', priority: 'must' },
        ],
        non_functional_requirements: [
          { description: 'API responses under 200ms', category: 'performance' },
          { description: 'GDPR compliance', category: 'compliance' },
        ],
        user_stories: [{ title: 'Create tasks', description: 'As a PM, I want to create tasks.' }],
        tech_stack: { language: 'TypeScript' },
        domain_model: { Task: { title: 'string' } },
        out_of_scope: [],
      },
      0,
    )
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue({
        id: 'dispatch-0',
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(singleResult),
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = { runId }

    const result = await runPlanningPhase(deps, params)

    expect(result.result).toBe('success')
    expect(pack.getPrompt).toHaveBeenCalledWith('planning')
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
  })

  it('falls back to single-dispatch when amendment context provided', async () => {
    const pack = makeMultiStepPack()
    const singleResult = makeDispatchResult(
      {
        result: 'success',
        functional_requirements: [
          { description: 'Task creation with assignment', priority: 'must' },
          { description: 'Board view for team tasks', priority: 'must' },
          { description: 'Progress tracking dashboard', priority: 'should' },
        ],
        non_functional_requirements: [
          { description: 'Sub-200ms response time', category: 'performance' },
          { description: 'GDPR compliance required', category: 'compliance' },
        ],
        user_stories: [{ title: 'Create task', description: 'As a user, create tasks.' }],
        tech_stack: { language: 'TypeScript' },
        domain_model: { Task: { title: 'string' } },
        out_of_scope: [],
      },
      0,
    )
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue({
        id: 'dispatch-0',
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(singleResult),
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = {
      runId,
      amendmentContext: 'Amendment context from parent run',
    }

    const result = await runPlanningPhase(deps, params)

    expect(result.result).toBe('success')
    // Amendment runs use single-dispatch path even when steps are defined
    expect(pack.getPrompt).toHaveBeenCalledWith('planning')
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
  })

  it('returns failure when a step fails', async () => {
    const pack = makeMultiStepPack()
    const dispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue({
        id: 'dispatch-0',
        status: 'completed' as const,
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(makeDispatchResult({ result: 'failed' }, 0)),
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }
    const deps = makeDeps(db, dispatcher, pack)
    const params: PlanningPhaseParams = { runId }

    const result = await runPlanningPhase(deps, params)

    expect(result.result).toBe('failed')
    expect(result.error).toBeDefined()
  })

  it('returns failure when no product brief exists', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    // Create a new run WITHOUT seeding analysis decisions
    const emptyRun = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
    const params: PlanningPhaseParams = { runId: emptyRun.id }

    const result = await runPlanningPhase(deps, params)

    expect(result.result).toBe('failed')
    expect(result.error).toBe('missing_product_brief')
  })
})
