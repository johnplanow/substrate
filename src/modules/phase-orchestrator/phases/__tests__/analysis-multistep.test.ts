/**
 * Integration tests for multi-step analysis phase decomposition.
 *
 * Verifies that when the manifest defines steps for the analysis phase,
 * runAnalysisPhase() uses the 2-step path (vision → scope) and produces
 * a valid AnalysisResult with the same structure as the single-dispatch path.
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
  getDecisionsByPhaseForRun,
  getArtifactByTypeForRun,
} from '../../../../persistence/queries/decisions.js'
import { runAnalysisPhase } from '../analysis.js'
import type { PhaseDeps, AnalysisPhaseParams } from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'analysis-multistep-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

const VISION_OUTPUT = {
  result: 'success' as const,
  problem_statement: 'Users struggle with task management across distributed teams.',
  target_users: ['project managers', 'software developers'],
}

const SCOPE_OUTPUT = {
  result: 'success' as const,
  core_features: ['task board', 'assignment', 'progress tracking'],
  success_metrics: ['50% reduction in missed deadlines'],
  constraints: ['web-only', 'GDPR compliant'],
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
    tokenEstimate: { input: 100 + index * 50, output: 50 + index * 20 },
  }
}

function makeMultiStepDispatcher(): Dispatcher {
  let callIndex = 0
  const results = [VISION_OUTPUT, SCOPE_OUTPUT]
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
          name: 'analysis',
          description: 'Analysis',
          entryGates: [],
          exitGates: ['product-brief-complete'],
          artifacts: ['product-brief'],
          steps: [
            {
              name: 'analysis-step-1-vision',
              template: 'analysis-step-1-vision',
              context: [{ placeholder: 'concept', source: 'param:concept' }],
              outputCategory: 'product-brief',
            },
            {
              name: 'analysis-step-2-scope',
              template: 'analysis-step-2-scope',
              context: [
                { placeholder: 'concept', source: 'param:concept' },
                { placeholder: 'vision_output', source: 'step:analysis-step-1-vision' },
              ],
              outputCategory: 'product-brief',
            },
          ],
        },
      ],
      prompts: {
        'analysis-step-1-vision': 'prompts/analysis-step-1-vision.md',
        'analysis-step-2-scope': 'prompts/analysis-step-2-scope.md',
      },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockImplementation((key: string) => {
      if (key === 'analysis-step-1-vision') {
        return Promise.resolve('Analyze vision for: {{concept}}')
      }
      if (key === 'analysis-step-2-scope') {
        return Promise.resolve('Define scope for: {{concept}} given {{vision_output}}')
      }
      return Promise.resolve('{{concept}}')
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
          name: 'analysis',
          description: 'Analysis',
          entryGates: [],
          exitGates: ['product-brief-complete'],
          artifacts: ['product-brief'],
          // No steps → single-dispatch fallback
        },
      ],
      prompts: { analysis: 'prompts/analysis.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue('Analyze: {{concept}}'),
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

describe('runAnalysisPhase() multi-step path', () => {
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

  it('uses multi-step path when manifest defines steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.result).toBe('success')
    expect(result.product_brief).toBeDefined()
    expect(result.product_brief!.problem_statement).toBe(VISION_OUTPUT.problem_statement)
    expect(result.product_brief!.target_users).toEqual(VISION_OUTPUT.target_users)
    expect(result.product_brief!.core_features).toEqual(SCOPE_OUTPUT.core_features)
    expect(result.product_brief!.success_metrics).toEqual(SCOPE_OUTPUT.success_metrics)
    expect(result.product_brief!.constraints).toEqual(SCOPE_OUTPUT.constraints)

    // Both steps should have been dispatched
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2)
  })

  it('persists product brief decisions to the decision store', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    await runAnalysisPhase(deps, params)

    const decisions = getDecisionsByPhaseForRun(db, runId, 'analysis')
    // Step 1 persists: problem_statement, target_users
    // Step 2 persists: core_features, success_metrics, constraints
    expect(decisions.length).toBeGreaterThanOrEqual(5)
  })

  it('registers a product-brief artifact', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.artifact_id).toBeDefined()
    const artifact = getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')
    expect(artifact).toBeTruthy()
  })

  it('accumulates token usage across both steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(db, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    // Step 0: input=100, output=50; Step 1: input=150, output=70
    expect(result.tokenUsage.input).toBe(250)
    expect(result.tokenUsage.output).toBe(120)
  })

  it('falls back to single-dispatch when no steps defined', async () => {
    const pack = makeNoStepsPack()
    const singleResult = makeDispatchResult(
      {
        result: 'success',
        product_brief: {
          problem_statement: 'A big problem statement with enough text.',
          target_users: ['devs'],
          core_features: ['feature-1'],
          success_metrics: ['metric-1'],
          constraints: [],
        },
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
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.result).toBe('success')
    // Should call getPrompt('analysis'), NOT step template names
    expect(pack.getPrompt).toHaveBeenCalledWith('analysis')
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
  })

  it('falls back to single-dispatch when amendment context provided', async () => {
    const pack = makeMultiStepPack()
    const singleResult = makeDispatchResult(
      {
        result: 'success',
        product_brief: {
          problem_statement: 'Amended problem statement with enough detail.',
          target_users: ['devs'],
          core_features: ['feature-1'],
          success_metrics: ['metric-1'],
          constraints: [],
        },
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
    const params: AnalysisPhaseParams = {
      runId,
      concept: 'Build a task manager',
      amendmentContext: 'Some amendment context from parent run',
    }

    const result = await runAnalysisPhase(deps, params)

    expect(result.result).toBe('success')
    // Amendment runs use single-dispatch path even when steps are defined
    expect(pack.getPrompt).toHaveBeenCalledWith('analysis')
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
  })

  it('returns failure when a step fails', async () => {
    const pack = makeMultiStepPack()
    // First step returns failure
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
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.result).toBe('failed')
    expect(result.error).toBeDefined()
  })
})
