/**
 * Unit tests for critique-loop.ts (Story 16-4).
 *
 * Covers:
 *  - pass verdict — no refinement dispatched
 *  - needs_work verdict — refinement dispatched
 *  - max iterations — loop terminates at configured limit
 *  - token tracking — critique and refinement tokens tracked separately
 *  - time tracking — totalMs is recorded
 *  - error resilience — critique prompt load failure returns pass (non-blocking)
 *  - decision store — critique results stored with category 'critique'
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import {
  createPipelineRun,
  getDecisionsByPhaseForRun,
} from '../../../persistence/queries/decisions.js'
import { getRawOutputsByPhaseForRun } from '../../../persistence/queries/phase-outputs.js'
import { runCritiqueLoop } from '../critique-loop.js'
import type { CritiqueOptions } from '../critique-loop.js'
import type { PhaseDeps } from '../phases/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: InMemoryDatabaseAdapter }> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return { adapter }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'solutioning' })
  return run.id
}

function makeDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: `dispatch-${Math.random().toString(36).slice(2, 8)}`,
    status: 'completed',
    exitCode: 0,
    output: 'refined artifact content',
    parsed: { verdict: 'pass', issue_count: 0, issues: [] },
    parseError: null,
    durationMs: 500,
    tokenEstimate: { input: 100, output: 50 },
    ...overrides,
  }
}

function makeDispatcher(results: DispatchResult<unknown>[]): Dispatcher {
  let callIndex = 0
  return {
    dispatch: vi.fn().mockImplementation(() => {
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
}

function makePack(prompts: Record<string, string> = {}): MethodologyPack {
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
    getPrompt: vi.fn().mockImplementation((key: string) => {
      if (key in prompts) {
        return Promise.resolve(prompts[key])
      }
      return Promise.resolve(`Template for ${key}: {{artifact_content}} {{project_context}}`)
    }),
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
  pack?: MethodologyPack,
): PhaseDeps {
  return {
    db: adapter,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runCritiqueLoop', () => {
  let adapter: InMemoryDatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    runId = await createTestRun(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  // -------------------------------------------------------------------------
  // Pass verdict
  // -------------------------------------------------------------------------

  it('returns pass verdict immediately when critique gives pass (no refinement dispatched)', async () => {
    const critiqueResult = makeDispatchResult({
      id: 'critique-1',
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      tokenEstimate: { input: 200, output: 80 },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact content', 'solutioning', runId, 'solutioning', deps)

    expect(result.verdict).toBe('pass')
    expect(result.iterations).toBe(1)
    expect(result.remainingIssues).toEqual([])
    // Only 1 dispatch (critique only, no refinement)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
  })

  it('accumulates critique tokens on pass', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      tokenEstimate: { input: 150, output: 60 },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps)

    expect(result.critiqueTokens.input).toBe(150)
    expect(result.critiqueTokens.output).toBe(60)
    expect(result.refinementTokens.input).toBe(0)
    expect(result.refinementTokens.output).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Needs-work verdict with refinement
  // -------------------------------------------------------------------------

  it('dispatches refinement when critique returns needs_work', async () => {
    const critiqueResult = makeDispatchResult({
      id: 'critique-1',
      parsed: {
        verdict: 'needs_work',
        issue_count: 1,
        issues: [{ severity: 'major', category: 'clarity', description: 'Too vague', suggestion: 'Be specific' }],
      },
      tokenEstimate: { input: 200, output: 80 },
    })

    // Second critique after refinement — passes
    const critiqueResult2 = makeDispatchResult({
      id: 'critique-2',
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      tokenEstimate: { input: 180, output: 70 },
    })

    const refineResult = makeDispatchResult({
      id: 'refine-1',
      parsed: null,
      output: 'refined artifact content',
      tokenEstimate: { input: 300, output: 120 },
    })

    // Dispatch order: critique1, refine, critique2
    const dispatcher = makeDispatcher([critiqueResult, refineResult, critiqueResult2])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop(
      'artifact content',
      'solutioning',
      runId,
      'solutioning',
      deps,
      { maxIterations: 2 },
    )

    expect(result.verdict).toBe('pass')
    expect(result.iterations).toBe(2)
    // 3 dispatches: critique, refine, critique
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })

  it('tracks critique and refinement token costs separately', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: {
        verdict: 'needs_work',
        issue_count: 1,
        issues: [{ severity: 'minor', category: 'style', description: 'Bad style', suggestion: 'Fix it' }],
      },
      tokenEstimate: { input: 200, output: 80 },
    })

    const refineResult = makeDispatchResult({
      parsed: null,
      output: 'refined artifact',
      tokenEstimate: { input: 400, output: 150 },
    })

    const critiqueResult2 = makeDispatchResult({
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      tokenEstimate: { input: 190, output: 75 },
    })

    const dispatcher = makeDispatcher([critiqueResult, refineResult, critiqueResult2])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact', 'analysis', runId, 'analysis', deps, { maxIterations: 2 })

    // Critique tokens: 200 + 190 = 390 input, 80 + 75 = 155 output
    expect(result.critiqueTokens.input).toBe(390)
    expect(result.critiqueTokens.output).toBe(155)
    // Refinement tokens: 400 input, 150 output
    expect(result.refinementTokens.input).toBe(400)
    expect(result.refinementTokens.output).toBe(150)
  })

  // -------------------------------------------------------------------------
  // Max iterations
  // -------------------------------------------------------------------------

  it('terminates at maxIterations=1 without refinement on last iteration', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: {
        verdict: 'needs_work',
        issue_count: 2,
        issues: [
          { severity: 'major', category: 'clarity', description: 'Too vague', suggestion: 'Be specific' },
          { severity: 'minor', category: 'style', description: 'Formatting', suggestion: 'Fix indentation' },
        ],
      },
      tokenEstimate: { input: 200, output: 80 },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps, { maxIterations: 1 })

    expect(result.verdict).toBe('needs_work')
    expect(result.iterations).toBe(1)
    expect(result.remainingIssues).toHaveLength(2)
    // Only critique dispatched (no refinement on last iteration)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
  })

  it('terminates at maxIterations=2 with needs_work remaining', async () => {
    const needsWorkResult = makeDispatchResult({
      parsed: {
        verdict: 'needs_work',
        issue_count: 1,
        issues: [{ severity: 'blocker', category: 'completeness', description: 'Missing FR', suggestion: 'Add FR' }],
      },
      tokenEstimate: { input: 200, output: 80 },
    })

    const refineResult = makeDispatchResult({
      parsed: null,
      output: 'refined artifact',
      tokenEstimate: { input: 300, output: 120 },
    })

    // Both iterations return needs_work
    const dispatcher = makeDispatcher([needsWorkResult, refineResult, needsWorkResult])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact', 'planning', runId, 'planning', deps, { maxIterations: 2 })

    expect(result.verdict).toBe('needs_work')
    expect(result.iterations).toBe(2)
    expect(result.remainingIssues).toHaveLength(1)
    expect(result.remainingIssues[0]?.severity).toBe('blocker')
  })

  // -------------------------------------------------------------------------
  // Time tracking
  // -------------------------------------------------------------------------

  it('records total loop time in milliseconds', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps)

    expect(result.totalMs).toBeGreaterThanOrEqual(0)
    expect(typeof result.totalMs).toBe('number')
  })

  // -------------------------------------------------------------------------
  // Decision store
  // -------------------------------------------------------------------------

  it('stores critique verdict and issue count in the decision store (AC7)', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: {
        verdict: 'needs_work',
        issue_count: 1,
        issues: [{ severity: 'major', category: 'security', description: 'No auth', suggestion: 'Add auth' }],
      },
      tokenEstimate: { input: 200, output: 80 },
    })

    // Second critique passes
    const refineResult = makeDispatchResult({
      parsed: null,
      output: 'refined',
      tokenEstimate: { input: 300, output: 100 },
    })

    const critiqueResult2 = makeDispatchResult({
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      tokenEstimate: { input: 150, output: 60 },
    })

    const dispatcher = makeDispatcher([critiqueResult, refineResult, critiqueResult2])
    const deps = makeDeps(adapter, dispatcher)

    await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps, { maxIterations: 2 })

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const critiqueDecisions = decisions.filter((d) => d.category === 'critique')

    // Should have at least verdict and issue_count for iteration 1
    expect(critiqueDecisions.length).toBeGreaterThanOrEqual(2)
    const verdictDecision = critiqueDecisions.find((d) => d.key.includes('verdict'))
    expect(verdictDecision).toBeDefined()
  })

  it('stores issues in the decision store when issues are present', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: {
        verdict: 'needs_work',
        issue_count: 1,
        issues: [{ severity: 'minor', category: 'style', description: 'Bad formatting', suggestion: 'Fix it' }],
      },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const deps = makeDeps(adapter, dispatcher)

    await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps, { maxIterations: 1 })

    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const critiqueDecisions = decisions.filter((d) => d.category === 'critique')
    const issuesDecision = critiqueDecisions.find((d) => d.key.includes('issues'))

    expect(issuesDecision).toBeDefined()
    expect(issuesDecision?.value).toContain('Bad formatting')
  })

  // -------------------------------------------------------------------------
  // Error resilience
  // -------------------------------------------------------------------------

  it('returns pass when critique prompt template fails to load (non-blocking)', async () => {
    const pack = makePack()
    vi.mocked(pack.getPrompt).mockRejectedValue(new Error('Template not found'))

    const dispatcher = makeDispatcher([])
    const deps = makeDeps(adapter, dispatcher, pack)

    const result = await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps)

    // Critique failure is non-blocking — returns pass to allow pipeline to continue
    expect(result.verdict).toBe('pass')
    expect(result.error).toBeDefined()
    expect(result.error).toContain('Template not found')
    // No dispatches (failed before dispatch)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(0)
  })

  it('returns pass when critique dispatch fails (non-blocking)', async () => {
    const failedResult = makeDispatchResult({
      status: 'failed',
      parsed: null,
      parseError: 'Agent failed',
    })

    const dispatcher = makeDispatcher([failedResult])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps)

    expect(result.verdict).toBe('pass')
    expect(result.error).toBeDefined()
  })

  it('returns pass when critique dispatch times out (non-blocking)', async () => {
    const timeoutResult = makeDispatchResult({
      status: 'timeout',
      parsed: null,
    })

    const dispatcher = makeDispatcher([timeoutResult])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps)

    expect(result.verdict).toBe('pass')
    expect(result.error).toBeDefined()
  })

  // -------------------------------------------------------------------------
  // Phase → prompt name mapping
  // -------------------------------------------------------------------------

  it('uses critique-architecture prompt for solutioning phase', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const pack = makePack({
      'critique-architecture': 'Architecture critique: {{artifact_content}}',
    })
    const deps = makeDeps(adapter, dispatcher, pack)

    await runCritiqueLoop('artifact', 'solutioning', runId, 'solutioning', deps)

    expect(pack.getPrompt).toHaveBeenCalledWith('critique-architecture')
  })

  it('uses critique-analysis prompt for analysis phase', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const pack = makePack({
      'critique-analysis': 'Analysis critique: {{artifact_content}}',
    })
    const deps = makeDeps(adapter, dispatcher, pack)

    await runCritiqueLoop('artifact', 'analysis', runId, 'analysis', deps)

    expect(pack.getPrompt).toHaveBeenCalledWith('critique-analysis')
  })

  it('uses critique-planning prompt for planning phase', async () => {
    const critiqueResult = makeDispatchResult({
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
    })

    const dispatcher = makeDispatcher([critiqueResult])
    const pack = makePack({
      'critique-planning': 'Planning critique: {{artifact_content}}',
    })
    const deps = makeDeps(adapter, dispatcher, pack)

    await runCritiqueLoop('artifact', 'planning', runId, 'planning', deps)

    expect(pack.getPrompt).toHaveBeenCalledWith('critique-planning')
  })

  // -------------------------------------------------------------------------
  // G11: phase_outputs capture for critique/refinement dispatches
  // -------------------------------------------------------------------------

  describe('G11: captureStepName writes dispatches to phase_outputs', () => {
    it('captures the critique dispatch output when captureStepName is provided', async () => {
      const critiqueResult = makeDispatchResult({
        id: 'c1',
        output: 'critique verdict text — pass',
        parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      })
      const dispatcher = makeDispatcher([critiqueResult])
      const deps = makeDeps(adapter, dispatcher)

      await runCritiqueLoop('artifact', 'analysis', runId, 'analysis', deps, {
        captureStepName: 'analysis-step-1-vision',
      })

      const rows = await getRawOutputsByPhaseForRun(adapter, runId, 'analysis')
      const critiqueRow = rows.find(
        (r) => r.step_name === 'analysis-step-1-vision:critique:1',
      )
      expect(critiqueRow).toBeDefined()
      expect(critiqueRow?.raw_output).toBe('critique verdict text — pass')
    })

    it('captures critique and refinement output across iterations with :refine suffix', async () => {
      const critiqueResult1 = makeDispatchResult({
        id: 'c1',
        output: 'iter-1 critique needs work',
        parsed: {
          verdict: 'needs_work',
          issue_count: 1,
          issues: [
            {
              severity: 'major',
              category: 'clarity',
              description: 'Too vague',
              suggestion: 'Be specific',
            },
          ],
        },
      })
      const refineResult = makeDispatchResult({
        id: 'r1',
        output: 'refined artifact content',
        parsed: null,
      })
      const critiqueResult2 = makeDispatchResult({
        id: 'c2',
        output: 'iter-2 critique pass',
        parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      })
      const dispatcher = makeDispatcher([critiqueResult1, refineResult, critiqueResult2])
      const deps = makeDeps(adapter, dispatcher)

      await runCritiqueLoop('artifact', 'analysis', runId, 'analysis', deps, {
        maxIterations: 2,
        captureStepName: 'analysis-step-1-vision',
      })

      const rows = await getRawOutputsByPhaseForRun(adapter, runId, 'analysis')
      const critique1 = rows.find(
        (r) => r.step_name === 'analysis-step-1-vision:critique:1',
      )
      const refine1 = rows.find(
        (r) => r.step_name === 'analysis-step-1-vision:critique:1:refine',
      )
      const critique2 = rows.find(
        (r) => r.step_name === 'analysis-step-1-vision:critique:2',
      )

      expect(critique1?.raw_output).toBe('iter-1 critique needs work')
      expect(refine1?.raw_output).toBe('refined artifact content')
      expect(critique2?.raw_output).toBe('iter-2 critique pass')
    })

    it('does not capture when captureStepName is omitted (backward compat)', async () => {
      const critiqueResult = makeDispatchResult({
        output: 'critique text',
        parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      })
      const dispatcher = makeDispatcher([critiqueResult])
      const deps = makeDeps(adapter, dispatcher)

      await runCritiqueLoop('artifact', 'analysis', runId, 'analysis', deps)

      const rows = await getRawOutputsByPhaseForRun(adapter, runId, 'analysis')
      expect(rows).toHaveLength(0)
    })
  })
})
