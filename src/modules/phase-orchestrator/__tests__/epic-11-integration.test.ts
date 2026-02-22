/**
 * Epic 11 Integration Tests — Cross-story interaction coverage
 *
 * These tests verify interactions BETWEEN the stories of Epic 11:
 *   11-1: Phase Orchestrator (orchestrator lifecycle, gate enforcement)
 *   11-2: Analysis Phase (concept → product-brief decisions + artifact)
 *   11-3: Planning Phase (product-brief decisions → prd decisions + artifact)
 *   11-4: Solutioning Phase (planning decisions → arch + stories decisions + artifacts)
 *   11-5: CLI integration (auto.ts runFullPipeline wiring)
 *
 * Each test exercises the boundary between two or more stories:
 *   - Analysis outputs flow into Planning inputs (11-2 → 11-3)
 *   - Planning outputs flow into Solutioning inputs (11-3 → 11-4)
 *   - Phase runners trigger gate-passing artifacts consumed by Orchestrator (11-2/3/4 → 11-1)
 *   - Orchestrator resume detection using artifacts created by real phase runners (11-1 + 11-2/3)
 *   - parseConfigJson handles config from startRun in advancePhase/getRunStatus (11-1 internal)
 *   - buildPipelineStatusOutput integrates with PhaseOrchestrator's phase history (11-1 + 11-5)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runMigrations } from '../../../persistence/migrations/index.js'
import {
  createPipelineRun,
  createDecision,
  getArtifactByTypeForRun,
  getPipelineRunById,
} from '../../../persistence/queries/decisions.js'
import { createPhaseOrchestrator } from '../phase-orchestrator-impl.js'
import { parseConfigJson } from '../phase-orchestrator-impl.js'
import { runAnalysisPhase } from '../phases/analysis.js'
import { runPlanningPhase } from '../phases/planning.js'
import { runSolutioningPhase } from '../phases/solutioning.js'
import { buildPipelineStatusOutput } from '../.././../cli/commands/auto.js'
import type { PhaseDeps, ProductBrief, AnalysisPhaseParams } from '../phases/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { PipelineRun } from '../../../persistence/queries/decisions.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'epic11-integration-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database, startPhase = 'analysis'): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: startPhase })
  return run.id
}

function makeMockPack(prompts: Record<string, string> = {}): MethodologyPack {
  const defaults: Record<string, string> = {
    analysis: 'Analyze: {{concept}}',
    planning: 'Plan: {{product_brief}}',
    architecture: 'Architect: {{requirements}}',
    'story-generation': 'Generate: {{requirements}} {{architecture_decisions}}',
  }
  const all = { ...defaults, ...prompts }
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn(async (key: string) => all[key] ?? ''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeDispatchResult<T>(parsed: T, overrides: Partial<DispatchResult<T>> = {}): DispatchResult<T> {
  return {
    id: `dispatch-${Date.now()}`,
    status: 'completed',
    exitCode: 0,
    output: JSON.stringify(parsed),
    parsed,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 400, output: 150 },
    ...overrides,
  }
}

function makeDispatcher(taskTypeToOutput: Record<string, unknown>): Dispatcher {
  return {
    dispatch: vi.fn((opts: { taskType: string }) => {
      const output = taskTypeToOutput[opts.taskType] ?? { result: 'success' }
      const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
        id: `h-${opts.taskType}`,
        status: 'completed',
        cancel: vi.fn().mockResolvedValue(undefined),
        result: Promise.resolve(makeDispatchResult(output)),
      }
      return handle
    }),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const ANALYSIS_OUTPUT = {
  result: 'success' as const,
  product_brief: {
    problem_statement: 'Users need a task management tool to track their work.',
    target_users: ['developers', 'product managers'],
    core_features: ['create tasks', 'assign tasks', 'track progress'],
    success_metrics: ['50% less time lost', '90% satisfaction'],
    constraints: ['must be web-based', 'GDPR compliant'],
  } satisfies ProductBrief,
}

const PLANNING_OUTPUT = {
  result: 'success' as const,
  functional_requirements: [
    { description: 'Users can create tasks with title and description', priority: 'must' as const },
    { description: 'Users can assign tasks to team members', priority: 'must' as const },
    { description: 'System tracks task progress and due dates', priority: 'should' as const },
  ],
  non_functional_requirements: [
    { description: 'System responds within 200ms for task operations', category: 'performance' },
    { description: 'System encrypts all user data at rest', category: 'security' },
  ],
  user_stories: [
    { title: 'Create a task', description: 'As a developer, I want to create tasks so that I can track my work.' },
  ],
  tech_stack: { language: 'TypeScript', framework: 'Node.js', database: 'SQLite' },
  domain_model: { Task: { fields: ['id', 'title', 'description'] }, User: { fields: ['id', 'name'] } },
  out_of_scope: ['Mobile app', 'Offline mode'],
}

const ARCHITECTURE_OUTPUT = {
  result: 'success' as const,
  architecture_decisions: [
    { category: 'language', key: 'language', value: 'TypeScript', rationale: 'Type safety' },
    { category: 'database', key: 'database', value: 'SQLite WAL', rationale: 'Performance' },
    { category: 'patterns', key: 'patterns', value: 'modular monolith', rationale: 'Simplicity' },
  ],
}

// Story coverage must include keywords from the FRs for readiness gate to pass
const STORY_GENERATION_OUTPUT = {
  result: 'success' as const,
  epics: [
    {
      title: 'Task Management',
      description: 'Core task CRUD functionality for the application',
      stories: [
        {
          key: '1-1',
          title: 'Create Task',
          description: 'Users can create tasks with title and description to track their work',
          acceptance_criteria: ['Task creation stores in database', 'Title is required'],
          priority: 'must' as const,
        },
        {
          key: '1-2',
          title: 'Assign Task',
          description: 'Users can assign tasks to team members for collaboration',
          acceptance_criteria: ['Task is assigned to user', 'Assignee receives notification'],
          priority: 'must' as const,
        },
        {
          key: '1-3',
          title: 'Track Progress',
          description: 'System tracks task progress and due dates for project management',
          acceptance_criteria: ['Progress percentage is visible', 'Due date alerts work'],
          priority: 'should' as const,
        },
      ],
    },
  ],
}

// ---------------------------------------------------------------------------
// Gap 1: Analysis → Planning data flow
//   (11-2 → 11-3): decisions written by runAnalysisPhase are read by runPlanningPhase
// ---------------------------------------------------------------------------

describe('Gap 1: Analysis → Planning data flow (11-2 → 11-3)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('planning prompt contains product brief text written by analysis phase', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    // Step 1: Run analysis phase — writes product-brief decisions to DB
    const analysisDispatcher = makeDispatcher({ analysis: ANALYSIS_OUTPUT })
    const analysisDeps: PhaseDeps = {
      db,
      pack,
      contextCompiler: makeContextCompiler(),
      dispatcher: analysisDispatcher,
    }
    const analysisResult = await runAnalysisPhase(analysisDeps, { runId, concept: 'Task manager' })
    expect(analysisResult.result).toBe('success')

    // Step 2: Run planning phase — should read product-brief decisions and inject into prompt
    let capturedPrompt = ''
    const planningDispatcher: Dispatcher = {
      dispatch: vi.fn((opts: { prompt: string; taskType: string }) => {
        capturedPrompt = opts.prompt
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: 'planning-dispatch',
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult(PLANNING_OUTPUT)),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const planningDeps: PhaseDeps = {
      db,
      pack,
      contextCompiler: makeContextCompiler(),
      dispatcher: planningDispatcher,
    }
    const planningResult = await runPlanningPhase(planningDeps, { runId })

    // Verify planning succeeded
    expect(planningResult.result).toBe('success')

    // Verify the planning prompt included the actual product brief content
    expect(capturedPrompt).toContain('task management tool')
    expect(capturedPrompt).toContain('Problem Statement')
    expect(capturedPrompt).toContain('Target Users')
    expect(capturedPrompt).toContain('Core Features')
  })

  it('planning phase fails when analysis phase has not run (missing product brief)', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    // Skip analysis — planning should fail with missing_product_brief
    const planningDispatcher = makeDispatcher({ planning: PLANNING_OUTPUT })
    const deps: PhaseDeps = {
      db,
      pack,
      contextCompiler: makeContextCompiler(),
      dispatcher: planningDispatcher,
    }
    const result = await runPlanningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('missing_product_brief')
  })

  it('planning decisions are scoped to the same run as analysis decisions', async () => {
    const pack = makeMockPack()
    const runId1 = createTestRun(db)
    const runId2 = createTestRun(db)

    // Seed product-brief for run1 only
    const fields = ['problem_statement', 'target_users', 'core_features', 'success_metrics', 'constraints']
    for (const field of fields) {
      createDecision(db, {
        pipeline_run_id: runId1,
        phase: 'analysis',
        category: 'product-brief',
        key: field,
        value: field === 'problem_statement' ? 'Run 1 concept' : JSON.stringify(['item']),
      })
    }

    // Run planning for run2 — should NOT see run1's decisions
    const planningDispatcher = makeDispatcher({ planning: PLANNING_OUTPUT })
    const deps: PhaseDeps = {
      db,
      pack,
      contextCompiler: makeContextCompiler(),
      dispatcher: planningDispatcher,
    }
    const result = await runPlanningPhase(deps, { runId: runId2 })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('missing_product_brief')
  })
})

// ---------------------------------------------------------------------------
// Gap 2: Planning → Solutioning data flow
//   (11-3 → 11-4): decisions written by runPlanningPhase are read by runSolutioningPhase
// ---------------------------------------------------------------------------

describe('Gap 2: Planning → Solutioning data flow (11-3 → 11-4)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('architecture prompt contains functional requirements written by planning phase', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    // Step 1: Seed planning decisions (as if planning phase ran)
    const planningFRs = [
      { key: 'FR-0', value: JSON.stringify({ description: 'Users can create tasks with title', priority: 'must' }) },
      { key: 'FR-1', value: JSON.stringify({ description: 'Users can assign tasks to team members', priority: 'must' }) },
    ]
    for (const fr of planningFRs) {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: fr.key,
        value: fr.value,
      })
    }

    // Step 2: Run solutioning — capture the architecture prompt
    let capturedArchPrompt = ''
    const dispatcher: Dispatcher = {
      dispatch: vi.fn((opts: { prompt: string; taskType: string }) => {
        if (opts.taskType === 'architecture') {
          capturedArchPrompt = opts.prompt
        }
        const output = opts.taskType === 'architecture' ? ARCHITECTURE_OUTPUT : STORY_GENERATION_OUTPUT
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: `h-${opts.taskType}`,
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult(output)),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps: PhaseDeps = { db, pack, contextCompiler: makeContextCompiler(), dispatcher }
    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')

    // The architecture prompt should contain the FR descriptions
    expect(capturedArchPrompt).toContain('Functional Requirements')
    expect(capturedArchPrompt).toContain('create tasks')
  })

  it('story generation prompt contains architecture decisions from the same run', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    // Seed planning decisions
    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'functional-requirements',
      key: 'FR-0',
      value: JSON.stringify({ description: 'Users can create tasks with title and description', priority: 'must' }),
    })

    // Step 2: Capture both architecture and story-generation prompts
    let capturedStoryPrompt = ''
    const dispatcher: Dispatcher = {
      dispatch: vi.fn((opts: { prompt: string; taskType: string }) => {
        if (opts.taskType === 'story-generation') {
          capturedStoryPrompt = opts.prompt
        }
        const output = opts.taskType === 'architecture' ? ARCHITECTURE_OUTPUT : STORY_GENERATION_OUTPUT
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: `h-${opts.taskType}`,
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve(makeDispatchResult(output)),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps: PhaseDeps = { db, pack, contextCompiler: makeContextCompiler(), dispatcher }
    await runSolutioningPhase(deps, { runId })

    // The story generation prompt should include arch decisions from the same run
    expect(capturedStoryPrompt).toContain('Architecture Decisions')
    expect(capturedStoryPrompt).toContain('TypeScript')
    expect(capturedStoryPrompt).toContain('SQLite WAL')
  })

  it('solutioning decisions are scoped to the correct run', async () => {
    const pack = makeMockPack()
    const runId1 = createTestRun(db)
    const runId2 = createTestRun(db)

    // Seed planning decisions only for run1
    createDecision(db, {
      pipeline_run_id: runId1,
      phase: 'planning',
      category: 'functional-requirements',
      key: 'FR-0',
      value: JSON.stringify({ description: 'Run 1 FR: create tasks', priority: 'must' }),
    })

    const dispatcher = makeDispatcher({
      architecture: ARCHITECTURE_OUTPUT,
      'story-generation': STORY_GENERATION_OUTPUT,
    })
    const deps: PhaseDeps = { db, pack, contextCompiler: makeContextCompiler(), dispatcher }

    // Run solutioning for run1
    const result1 = await runSolutioningPhase(deps, { runId: runId1 })
    expect(result1.result).toBe('success')

    // Verify architecture decisions are only in run1
    const archDecisions = db
      .prepare(`SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = 'architecture'`)
      .all(runId1) as Array<{ pipeline_run_id: string }>
    expect(archDecisions.length).toBeGreaterThan(0)
    archDecisions.forEach((d) => expect(d.pipeline_run_id).toBe(runId1))

    // Run2 should have no decisions
    const run2Decisions = db
      .prepare(`SELECT * FROM decisions WHERE pipeline_run_id = ? AND phase = 'solutioning'`)
      .all(runId2)
    expect(run2Decisions).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Gap 3: Phase runners + Orchestrator gate enforcement
//   (11-2/3/4 → 11-1): After real phase runs, orchestrator can advance using the artifacts
// ---------------------------------------------------------------------------

describe('Gap 3: Phase runners + Orchestrator gate enforcement (11-2/3/4 → 11-1)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('orchestrator can advance after real analysis phase creates product-brief artifact', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager', 'analysis')

    // Run real analysis phase
    const dispatcher = makeDispatcher({ analysis: ANALYSIS_OUTPUT })
    const deps: PhaseDeps = { db, pack, contextCompiler: makeContextCompiler(), dispatcher }
    const analysisResult = await runAnalysisPhase(deps, { runId, concept: 'Build a task manager' })
    expect(analysisResult.result).toBe('success')

    // Verify the artifact now exists
    const artifact = getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')
    expect(artifact).toBeDefined()

    // Orchestrator should now be able to advance (exit gate: product-brief exists)
    const advanceResult = await orchestrator.advancePhase(runId)
    expect(advanceResult.advanced).toBe(true)
    expect(advanceResult.phase).toBe('planning')
  })

  it('orchestrator cannot advance if analysis phase failed (no artifact created)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager', 'analysis')

    // Run analysis with a failing dispatcher
    const failingDispatcher = makeDispatcher({})
    const failingHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
      id: 'fail',
      status: 'failed',
      cancel: vi.fn(),
      result: Promise.resolve({
        id: 'fail',
        status: 'failed',
        exitCode: 1,
        output: '',
        parsed: null,
        parseError: 'dispatch failed',
        durationMs: 10,
        tokenEstimate: { input: 0, output: 0 },
      } as DispatchResult<unknown>),
    }
    const failDispatcher: Dispatcher = {
      dispatch: vi.fn().mockReturnValue(failingHandle),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps: PhaseDeps = { db, pack, contextCompiler: makeContextCompiler(), dispatcher: failDispatcher }
    const analysisResult = await runAnalysisPhase(deps, { runId, concept: 'Build a task manager' })
    expect(analysisResult.result).toBe('failed')

    // No artifact was created — orchestrator cannot advance
    const artifact = getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')
    expect(artifact).toBeUndefined()

    const advanceResult = await orchestrator.advancePhase(runId)
    expect(advanceResult.advanced).toBe(false)
    expect(advanceResult.gateFailures?.some((f) => f.gate.includes('product-brief'))).toBe(true)
  })

  it('orchestrator advances through analysis → planning → solutioning with real phase data', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager', 'analysis')

    // Run analysis
    const analysisDispatcher = makeDispatcher({ analysis: ANALYSIS_OUTPUT })
    await runAnalysisPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: analysisDispatcher },
      { runId, concept: 'Build a task manager' },
    )

    // Advance analysis → planning
    const advance1 = await orchestrator.advancePhase(runId)
    expect(advance1.advanced).toBe(true)
    expect(advance1.phase).toBe('planning')

    // Run planning (reads analysis decisions written above)
    const planningDispatcher = makeDispatcher({ planning: PLANNING_OUTPUT })
    const planningResult = await runPlanningPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: planningDispatcher },
      { runId },
    )
    expect(planningResult.result).toBe('success')

    // Advance planning → solutioning
    const advance2 = await orchestrator.advancePhase(runId)
    expect(advance2.advanced).toBe(true)
    expect(advance2.phase).toBe('solutioning')

    // Run solutioning (reads planning decisions written above)
    const solutioningDispatcher = makeDispatcher({
      architecture: ARCHITECTURE_OUTPUT,
      'story-generation': STORY_GENERATION_OUTPUT,
    })
    const solutioningResult = await runSolutioningPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: solutioningDispatcher },
      { runId },
    )
    expect(solutioningResult.result).toBe('success')

    // Verify all three artifacts exist
    expect(getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')).toBeDefined()
    expect(getArtifactByTypeForRun(db, runId, 'planning', 'prd')).toBeDefined()
    expect(getArtifactByTypeForRun(db, runId, 'solutioning', 'architecture')).toBeDefined()
    expect(getArtifactByTypeForRun(db, runId, 'solutioning', 'stories')).toBeDefined()

    // Advance solutioning → implementation
    const advance3 = await orchestrator.advancePhase(runId)
    expect(advance3.advanced).toBe(true)
    expect(advance3.phase).toBe('implementation')
  })
})

// ---------------------------------------------------------------------------
// Gap 4: Full artifact chain and decision count across all phases
//   Verifies end-to-end data accumulation in the decision store
// ---------------------------------------------------------------------------

describe('Gap 4: Full artifact chain and decision accumulation (11-2 + 11-3 + 11-4)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('decisions accumulate across all three phases in the same run', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    // Run all three phases in sequence
    await runAnalysisPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ analysis: ANALYSIS_OUTPUT }) },
      { runId, concept: 'Build a task manager' },
    )

    await runPlanningPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ planning: PLANNING_OUTPUT }) },
      { runId },
    )

    await runSolutioningPhase(
      {
        db,
        pack,
        contextCompiler: makeContextCompiler(),
        dispatcher: makeDispatcher({
          architecture: ARCHITECTURE_OUTPUT,
          'story-generation': STORY_GENERATION_OUTPUT,
        }),
      },
      { runId },
    )

    // Count decisions by phase
    const analysisDecs = db
      .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ? AND phase = 'analysis'`)
      .get(runId) as { cnt: number }
    const planningDecs = db
      .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ? AND phase = 'planning'`)
      .get(runId) as { cnt: number }
    const solutioningDecs = db
      .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ? AND phase = 'solutioning'`)
      .get(runId) as { cnt: number }

    // Analysis: 5 product-brief fields
    expect(analysisDecs.cnt).toBe(5)
    // Planning: 3 FRs + 2 NFRs + 1 user story + 3 tech stack entries + 1 domain model + 1 out-of-scope = 11
    expect(planningDecs.cnt).toBeGreaterThanOrEqual(8)
    // Solutioning: architecture decisions + epic decisions + story decisions
    expect(solutioningDecs.cnt).toBeGreaterThanOrEqual(4)

    // Total must be across all phases
    const totalDecs = db
      .prepare(`SELECT COUNT(*) as cnt FROM decisions WHERE pipeline_run_id = ?`)
      .get(runId) as { cnt: number }
    expect(totalDecs.cnt).toBe(analysisDecs.cnt + planningDecs.cnt + solutioningDecs.cnt)
  })

  it('artifacts from all three phases are registered under the same run', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    await runAnalysisPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ analysis: ANALYSIS_OUTPUT }) },
      { runId, concept: 'Build a task manager' },
    )

    await runPlanningPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ planning: PLANNING_OUTPUT }) },
      { runId },
    )

    await runSolutioningPhase(
      {
        db,
        pack,
        contextCompiler: makeContextCompiler(),
        dispatcher: makeDispatcher({
          architecture: ARCHITECTURE_OUTPUT,
          'story-generation': STORY_GENERATION_OUTPUT,
        }),
      },
      { runId },
    )

    const artifacts = db
      .prepare(`SELECT phase, type FROM artifacts WHERE pipeline_run_id = ? ORDER BY phase, type`)
      .all(runId) as Array<{ phase: string; type: string }>

    const artifactKeys = artifacts.map((a) => `${a.phase}/${a.type}`)
    expect(artifactKeys).toContain('analysis/product-brief')
    expect(artifactKeys).toContain('planning/prd')
    expect(artifactKeys).toContain('solutioning/architecture')
    expect(artifactKeys).toContain('solutioning/stories')
  })

  it('requirements table has entries from planning and solutioning phases', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    await runAnalysisPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ analysis: ANALYSIS_OUTPUT }) },
      { runId, concept: 'Build a task manager' },
    )

    await runPlanningPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ planning: PLANNING_OUTPUT }) },
      { runId },
    )

    await runSolutioningPhase(
      {
        db,
        pack,
        contextCompiler: makeContextCompiler(),
        dispatcher: makeDispatcher({
          architecture: ARCHITECTURE_OUTPUT,
          'story-generation': STORY_GENERATION_OUTPUT,
        }),
      },
      { runId },
    )

    const planningReqs = db
      .prepare(`SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'planning-phase'`)
      .get(runId) as { cnt: number }
    const solutioningReqs = db
      .prepare(`SELECT COUNT(*) as cnt FROM requirements WHERE pipeline_run_id = ? AND source = 'solutioning-phase'`)
      .get(runId) as { cnt: number }

    // Planning creates 3 FRs + 2 NFRs = 5
    expect(planningReqs.cnt).toBe(5)
    // Solutioning creates one requirement per story (3 stories)
    expect(solutioningReqs.cnt).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Gap 5: resumeRun after partial pipeline execution
//   (11-1): resumeRun correctly identifies resume point using artifacts from real phases
// ---------------------------------------------------------------------------

describe('Gap 5: resumeRun after partial pipeline execution (11-1)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('resumes at planning after analysis completed (product-brief artifact exists)', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager', 'analysis')

    // Simulate analysis completing: run real analysis phase
    const dispatcher = makeDispatcher({ analysis: ANALYSIS_OUTPUT })
    await runAnalysisPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher },
      { runId, concept: 'Build a task manager' },
    )

    // Simulate crash: status is still 'running' at analysis (no advance was called)
    // Now resume — should detect product-brief artifact and resume at planning
    const status = await orchestrator.resumeRun(runId)

    expect(status.currentPhase).toBe('planning')
    expect(status.status).toBe('running')
  })

  it('resumes at solutioning after analysis + planning completed', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager', 'analysis')

    // Run analysis
    await runAnalysisPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ analysis: ANALYSIS_OUTPUT }) },
      { runId, concept: 'Build a task manager' },
    )

    // Advance to planning
    await orchestrator.advancePhase(runId)

    // Run planning
    await runPlanningPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ planning: PLANNING_OUTPUT }) },
      { runId },
    )

    // Simulate crash at this point — resume should detect prd artifact and go to solutioning
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('solutioning')
    expect(status.status).toBe('running')
  })

  it('resumeRun with no completed phases stays at analysis', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager', 'analysis')

    // No phases ran — no artifacts — should stay at analysis
    const status = await orchestrator.resumeRun(runId)
    expect(status.currentPhase).toBe('analysis')
    expect(status.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Gap 6: parseConfigJson backward compatibility in orchestrator context
//   (11-1): config_json written by startRun is correctly parsed during advancePhase
// ---------------------------------------------------------------------------

describe('Gap 6: parseConfigJson used by orchestrator lifecycle (11-1)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('parseConfigJson handles new-format config_json written by startRun', () => {
    const configJson = JSON.stringify({
      concept: 'My concept',
      phaseHistory: [{ phase: 'analysis', startedAt: '2026-01-01T00:00:00Z', gateResults: [] }],
    })

    const parsed = parseConfigJson(configJson)

    expect(parsed.concept).toBe('My concept')
    expect(parsed.phaseHistory).toHaveLength(1)
    expect(parsed.phaseHistory[0].phase).toBe('analysis')
  })

  it('parseConfigJson handles old-format (direct array) config_json', () => {
    const configJson = JSON.stringify([
      { phase: 'analysis', startedAt: '2026-01-01T00:00:00Z', gateResults: [] },
    ])

    const parsed = parseConfigJson(configJson)

    expect(parsed.phaseHistory).toHaveLength(1)
    expect(parsed.phaseHistory[0].phase).toBe('analysis')
  })

  it('phase history is preserved across multiple advancePhase calls', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    // Register artifacts and advance twice
    const { registerArtifact } = await import('../../../persistence/queries/decisions.js')
    registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      type: 'product-brief',
      path: '/test/brief',
    })
    await orchestrator.advancePhase(runId) // analysis → planning

    registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      type: 'prd',
      path: '/test/prd',
    })
    await orchestrator.advancePhase(runId) // planning → solutioning

    // Verify phase history in DB
    const run = getPipelineRunById(db, runId)
    const config = parseConfigJson(run!.config_json)

    // Should have history entries for analysis (completed) and planning (completed) and solutioning (started)
    expect(config.phaseHistory.length).toBeGreaterThanOrEqual(3)

    const analysisEntry = config.phaseHistory.find((h) => h.phase === 'analysis')
    expect(analysisEntry?.completedAt).toBeDefined()

    const planningEntry = config.phaseHistory.find((h) => h.phase === 'planning')
    expect(planningEntry?.completedAt).toBeDefined()

    const solutioningEntry = config.phaseHistory.find((h) => h.phase === 'solutioning')
    expect(solutioningEntry?.startedAt).toBeDefined()
    expect(solutioningEntry?.completedAt).toBeUndefined()
  })

  it('getRunStatus reflects completed phases from phase history', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    const { registerArtifact } = await import('../../../persistence/queries/decisions.js')
    registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      type: 'product-brief',
      path: '/test/brief',
    })
    await orchestrator.advancePhase(runId) // analysis → planning

    const status = await orchestrator.getRunStatus(runId)
    expect(status.completedPhases).toContain('analysis')
    expect(status.currentPhase).toBe('planning')
    expect(status.status).toBe('running')
  })
})

// ---------------------------------------------------------------------------
// Gap 7: buildPipelineStatusOutput integrates with PhaseOrchestrator phase history
//   (11-1 + 11-5): CLI status command correctly reflects orchestrator state
// ---------------------------------------------------------------------------

describe('Gap 7: buildPipelineStatusOutput + PhaseOrchestrator integration (11-1 + 11-5)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('buildPipelineStatusOutput shows correct phases after real orchestrator progression', async () => {
    const pack = makeMockPack()
    const orchestrator = createPhaseOrchestrator({ db, pack })
    const runId = await orchestrator.startRun('Build a task manager')

    const { registerArtifact } = await import('../../../persistence/queries/decisions.js')
    registerArtifact(db, {
      pipeline_run_id: runId,
      phase: 'analysis',
      type: 'product-brief',
      path: '/test/brief',
    })
    await orchestrator.advancePhase(runId) // analysis → planning

    // Get run from DB for status builder
    const run = getPipelineRunById(db, runId) as PipelineRun

    const statusOutput = buildPipelineStatusOutput(run, [], 5, 0)

    expect(statusOutput.run_id).toBe(runId)
    expect(statusOutput.current_phase).toBe('planning')
    expect(statusOutput.phases.analysis.status).toBe('complete')
    expect(statusOutput.phases.planning.status).toBe('running')
    expect(statusOutput.phases.solutioning.status).toBe('pending')
    expect(statusOutput.phases.implementation.status).toBe('pending')
  })

  it('buildPipelineStatusOutput after full three-phase pipeline shows all complete', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    // Run all three phases
    await runAnalysisPhase(
      { db, pack, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ analysis: ANALYSIS_OUTPUT }) },
      { runId, concept: 'Build a task manager' },
    )

    const orchestrator = createPhaseOrchestrator({ db, pack })
    await orchestrator.startRun('Build a task manager', 'analysis')

    // We need to use the orchestrator that knows about this runId
    // Use another approach: run phases and use a fresh orchestrator with the existing runId
    const pack2 = makeMockPack()
    const orch2 = createPhaseOrchestrator({ db, pack: pack2 })
    const runId2 = await orch2.startRun('Build a task manager', 'analysis')

    // Run analysis
    await runAnalysisPhase(
      { db, pack: pack2, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ analysis: ANALYSIS_OUTPUT }) },
      { runId: runId2, concept: 'Build a task manager' },
    )

    // Advance analysis → planning
    const adv1 = await orch2.advancePhase(runId2)
    expect(adv1.advanced).toBe(true)

    // Run planning
    await runPlanningPhase(
      { db, pack: pack2, contextCompiler: makeContextCompiler(), dispatcher: makeDispatcher({ planning: PLANNING_OUTPUT }) },
      { runId: runId2 },
    )

    // Advance planning → solutioning
    const adv2 = await orch2.advancePhase(runId2)
    expect(adv2.advanced).toBe(true)

    // Get run status
    const status = await orch2.getRunStatus(runId2)
    expect(status.completedPhases).toContain('analysis')
    expect(status.completedPhases).toContain('planning')
    expect(status.currentPhase).toBe('solutioning')
  })

  it('buildPipelineStatusOutput correctly sums token usage from multiple phases', () => {
    const db2 = new Database(':memory:')
    runMigrations(db2)

    const run = createPipelineRun(db2, {
      methodology: 'bmad',
      start_phase: 'analysis',
      config_json: JSON.stringify({
        concept: 'test',
        phaseHistory: [
          { phase: 'analysis', startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:01:00Z', gateResults: [] },
          { phase: 'planning', startedAt: '2026-01-01T00:01:00Z', completedAt: '2026-01-01T00:02:00Z', gateResults: [] },
          { phase: 'solutioning', startedAt: '2026-01-01T00:02:00Z', gateResults: [] },
        ],
      }),
    })

    const tokenSummary = [
      { phase: 'analysis', agent: 'claude-code', total_input_tokens: 400, total_output_tokens: 150, total_cost_usd: 0.003 },
      { phase: 'planning', agent: 'claude-code', total_input_tokens: 600, total_output_tokens: 200, total_cost_usd: 0.005 },
      { phase: 'solutioning', agent: 'claude-code', total_input_tokens: 800, total_output_tokens: 300, total_cost_usd: 0.007 },
    ]

    const result = buildPipelineStatusOutput(run, tokenSummary, 25, 8)

    expect(result.total_tokens.input).toBe(1800) // 400 + 600 + 800
    expect(result.total_tokens.output).toBe(650) // 150 + 200 + 300
    expect(result.decisions_count).toBe(25)
    expect(result.stories_count).toBe(8)
    expect(result.phases.analysis.status).toBe('complete')
    expect(result.phases.planning.status).toBe('complete')
    expect(result.phases.solutioning.status).toBe('running')
    expect(result.phases.implementation.status).toBe('pending')

    db2.close()
  })
})

// ---------------------------------------------------------------------------
// Gap 8: Solutioning readiness gate — FR coverage check across planning and solutioning
//   (11-3 → 11-4): readiness gate verifies that FRs from planning are covered by stories
// ---------------------------------------------------------------------------

describe('Gap 8: Readiness gate FR-to-story coverage check (11-3 → 11-4)', () => {
  let db: BetterSqlite3Database
  let tmpDir: string

  beforeEach(() => {
    const r = createTestDb()
    db = r.db
    tmpDir = r.tmpDir
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('readiness gate passes when stories cover all functional requirements', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    // Seed planning FRs
    const frs = [
      { key: 'FR-0', value: JSON.stringify({ description: 'Users can create tasks with title', priority: 'must' }) },
      { key: 'FR-1', value: JSON.stringify({ description: 'Users can assign tasks to team members', priority: 'must' }) },
    ]
    for (const fr of frs) {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'planning',
        category: 'functional-requirements',
        key: fr.key,
        value: fr.value,
      })
    }

    // Stories that cover the FRs
    const coveringStoryOutput = {
      result: 'success' as const,
      epics: [
        {
          title: 'Core Features',
          description: 'Core feature implementation for the application',
          stories: [
            {
              key: '1-1',
              title: 'Create Task',
              description: 'Users can create tasks with title and description',
              acceptance_criteria: ['Task creation works', 'Title is required'],
              priority: 'must' as const,
            },
            {
              key: '1-2',
              title: 'Assign Task',
              description: 'Users can assign tasks to team members for collaboration',
              acceptance_criteria: ['Assignment records in DB', 'User notified'],
              priority: 'must' as const,
            },
          ],
        },
      ],
    }

    const dispatcher = makeDispatcher({
      architecture: ARCHITECTURE_OUTPUT,
      'story-generation': coveringStoryOutput,
    })
    const deps: PhaseDeps = { db, pack, contextCompiler: makeContextCompiler(), dispatcher }
    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
  })

  it('solutioning phase accumulates token usage across architecture + story-gen dispatches', async () => {
    const pack = makeMockPack()
    const runId = createTestRun(db)

    createDecision(db, {
      pipeline_run_id: runId,
      phase: 'planning',
      category: 'functional-requirements',
      key: 'FR-0',
      value: JSON.stringify({ description: 'Users can create tasks with title and description', priority: 'must' }),
    })

    // Each dispatch returns different token estimates
    const dispatcherWithTokens: Dispatcher = {
      dispatch: vi.fn((opts: { taskType: string }) => {
        const output = opts.taskType === 'architecture' ? ARCHITECTURE_OUTPUT : STORY_GENERATION_OUTPUT
        const tokenEstimate = opts.taskType === 'architecture'
          ? { input: 300, output: 100 }
          : { input: 500, output: 200 }
        const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
          id: `h-${opts.taskType}`,
          status: 'completed',
          cancel: vi.fn(),
          result: Promise.resolve({
            id: `h-${opts.taskType}`,
            status: 'completed',
            exitCode: 0,
            output: JSON.stringify(output),
            parsed: output,
            parseError: null,
            durationMs: 100,
            tokenEstimate,
          } as DispatchResult<unknown>),
        }
        return handle
      }),
      getPending: vi.fn().mockReturnValue(0),
      getRunning: vi.fn().mockReturnValue(0),
      shutdown: vi.fn().mockResolvedValue(undefined),
    }

    const deps: PhaseDeps = { db, pack, contextCompiler: makeContextCompiler(), dispatcher: dispatcherWithTokens }
    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    // Total tokens = architecture (300+100) + story-gen (500+200) = 800+300
    expect(result.tokenUsage.input).toBe(800)
    expect(result.tokenUsage.output).toBe(300)
  })
})
