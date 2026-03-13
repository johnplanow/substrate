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
import { SyncDatabaseAdapter } from '../../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../../persistence/adapter.js'
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
import { getProjectFindings } from '../../../implementation-orchestrator/project-findings.js'

// Mock getProjectFindings so multi-step tests can control prior findings injection
// Default: returns '' (no findings) — does not affect existing tests
vi.mock('../../../implementation-orchestrator/project-findings.js', () => ({
  getProjectFindings: vi.fn().mockResolvedValue(''),
}))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ db: BetterSqlite3Database; adapter: DatabaseAdapter; tmpDir: string }> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'analysis-multistep-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  const adapter = new SyncDatabaseAdapter(db)
  await initSchema(adapter)
  return { db, adapter, tmpDir }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
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
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack: MethodologyPack,
): PhaseDeps {
  return { db: adapter, pack, contextCompiler: makeContextCompiler(), dispatcher }
}

/**
 * Capture-dispatcher: captures the prompt string passed to dispatch() so tests
 * can assert on what the step-runner assembled for each step.
 */
function makeCaptureDispatcher(results: DispatchResult<unknown>[]): {
  dispatcher: Dispatcher
  capturedPrompts: string[]
} {
  const capturedPrompts: string[] = []
  let callIndex = 0
  const dispatcher: Dispatcher = {
    dispatch: vi.fn().mockImplementation((opts: { prompt: string }) => {
      capturedPrompts.push(opts.prompt)
      const result = results[callIndex] ?? results[results.length - 1]!
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
  return { dispatcher, capturedPrompts }
}

/**
 * Pack with {{prior_findings}} placeholder in step-1-vision template.
 */
function makeMultiStepPackWithFindingsTemplate(): MethodologyPack {
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
              context: [
                { placeholder: 'concept', source: 'param:concept' },
                { placeholder: 'prior_findings', source: 'param:prior_findings' },
              ],
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
        // Include {{prior_findings}} so we can verify replacement
        return Promise.resolve('Analyze vision for: {{concept}} Findings: {{prior_findings}}')
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runAnalysisPhase() multi-step path', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    db = setup.db
    adapter = setup.adapter
    tmpDir = setup.tmpDir
    runId = await createTestRun(adapter)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('uses multi-step path when manifest defines steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
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
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    await runAnalysisPhase(deps, params)

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
    // Step 1 persists: problem_statement, target_users
    // Step 2 persists: core_features, success_metrics, constraints
    expect(decisions.length).toBeGreaterThanOrEqual(5)
  })

  it('registers a product-brief artifact', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.artifact_id).toBeDefined()
    const artifact = await getArtifactByTypeForRun(adapter, runId, 'analysis', 'product-brief')
    expect(artifact).toBeTruthy()
  })

  it('accumulates token usage across both steps', async () => {
    const pack = makeMultiStepPack()
    const dispatcher = makeMultiStepDispatcher()
    const deps = makeDeps(adapter, dispatcher, pack)
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
    const deps = makeDeps(adapter, dispatcher, pack)
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
    const deps = makeDeps(adapter, dispatcher, pack)
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
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.result).toBe('failed')
    expect(result.error).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Multi-step: prior findings injection (AC1, AC2)
// ---------------------------------------------------------------------------

describe('runAnalysisPhase() multi-step path — prior findings injection', () => {
  let db: BetterSqlite3Database
  let adapter: DatabaseAdapter
  let tmpDir: string
  let runId: string

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'analysis-multistep-findings-'))
    const database = new Database(join(tmp, 'test.db'))
    db = database
    adapter = new SyncDatabaseAdapter(database)
    await initSchema(adapter)
    tmpDir = tmp
    const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
    runId = run.id
    // Reset mock to default before each test
    vi.mocked(getProjectFindings).mockResolvedValue('')
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('AC1: assembled step-1-vision prompt contains findings text when findings are present', async () => {
    const findingsText = '**Recurring patterns:** missing error handling\n**Prior stalls:** 2 stall event(s) recorded'
    vi.mocked(getProjectFindings).mockResolvedValue(findingsText)

    const pack = makeMultiStepPackWithFindingsTemplate()
    const visionResult = makeDispatchResult(VISION_OUTPUT, 0)
    const scopeResult = makeDispatchResult(SCOPE_OUTPUT, 1)
    const { dispatcher, capturedPrompts } = makeCaptureDispatcher([visionResult, scopeResult])
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.result).toBe('success')
    // step-1-vision prompt is capturedPrompts[0]
    expect(capturedPrompts[0]).toContain(findingsText)
    expect(capturedPrompts[0]).not.toContain('{{prior_findings}}')
  })

  it('AC2: assembled step-1-vision prompt has no orphaned {{prior_findings}} when store is empty', async () => {
    vi.mocked(getProjectFindings).mockResolvedValue('')

    const pack = makeMultiStepPackWithFindingsTemplate()
    const visionResult = makeDispatchResult(VISION_OUTPUT, 0)
    const scopeResult = makeDispatchResult(SCOPE_OUTPUT, 1)
    const { dispatcher, capturedPrompts } = makeCaptureDispatcher([visionResult, scopeResult])
    const deps = makeDeps(adapter, dispatcher, pack)
    const params: AnalysisPhaseParams = { runId, concept: 'Build a task manager' }

    const result = await runAnalysisPhase(deps, params)

    expect(result.result).toBe('success')
    // {{prior_findings}} placeholder must be replaced (with empty string), not left as-is
    expect(capturedPrompts[0]).not.toContain('{{prior_findings}}')
    // No findings text in the prompt
    expect(capturedPrompts[0]).not.toContain('**Recurring patterns:**')
    expect(capturedPrompts[0]).not.toContain('**Prior stalls:**')
  })
})
