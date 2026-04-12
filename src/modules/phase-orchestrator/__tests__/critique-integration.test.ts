/**
 * Integration test for the critique loop in the architecture phase.
 *
 * Verifies end-to-end dispatch behaviour through step-runner when a step
 * has `critique: true` set (AC1, Story 16-4).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { initSchema } from '../../../persistence/schema.js'
import {
  createPipelineRun,
  getDecisionsByPhaseForRun,
  getTokenUsageSummary,
} from '../../../persistence/queries/decisions.js'
import { getRawOutputsByPhaseForRun } from '../../../persistence/queries/phase-outputs.js'
import { runSteps } from '../step-runner.js'
import type { StepDefinition } from '../step-runner.js'
import type { PhaseDeps } from '../phases/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'

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

const TestOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  architecture_decisions: z.array(z.object({
    category: z.string(),
    key: z.string(),
    value: z.string(),
  })).optional(),
})

function makeDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: `dispatch-${Math.random().toString(36).slice(2, 8)}`,
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', architecture_decisions: [{ category: 'test', key: 'lang', value: 'TS' }] },
    parseError: null,
    durationMs: 1000,
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
      return Promise.resolve(prompts[key] ?? `Template: {{placeholder}}`)
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
// Integration test
// ---------------------------------------------------------------------------

describe('critique loop integration with step-runner', () => {
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

  it('runs critique loop when step has critique: true (AC1)', async () => {
    const pack = makePack({
      'arch-step': 'Architecture: {{concept}}',
      'critique-architecture': 'Review: {{artifact}}', // note: critique loop uses phase 'solutioning' → critique-architecture
      'refine-artifact': 'Refine: {{artifact}} Issues: {{issues}}',
    })

    // Step dispatch result
    const stepResult = makeDispatchResult({
      id: 'step-1',
      parsed: { result: 'success', architecture_decisions: [{ category: 'lang', key: 'runtime', value: 'Node.js' }] },
      tokenEstimate: { input: 100, output: 50 },
    })

    // Critique dispatch result (pass)
    const critiqueResult = makeDispatchResult({
      id: 'critique-1',
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
      tokenEstimate: { input: 200, output: 100 },
    })

    const dispatcher = makeDispatcher([stepResult, critiqueResult])
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps: StepDefinition[] = [{
      name: 'arch-step',
      taskType: 'arch-decisions',
      outputSchema: TestOutputSchema,
      context: [{ placeholder: 'concept', source: 'param:concept' }],
      persist: [],
      critique: true, // This triggers the critique loop
    }]

    const result = await runSteps(steps, deps, runId, 'solutioning', { concept: 'Build a CLI' })

    expect(result.success).toBe(true)
    expect(result.steps).toHaveLength(1)
    // 2 dispatches: step + critique
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(2)

    // Token usage includes critique tokens
    expect(result.tokenUsage.input).toBe(300) // 100 (step) + 200 (critique)
    expect(result.tokenUsage.output).toBe(150) // 50 (step) + 100 (critique)
  })

  it('does NOT run critique loop when step has critique: false/undefined', async () => {
    const pack = makePack({
      'arch-step': 'Architecture: {{concept}}',
    })

    const stepResult = makeDispatchResult({
      parsed: { result: 'success', architecture_decisions: [{ category: 'lang', key: 'runtime', value: 'Node.js' }] },
      tokenEstimate: { input: 100, output: 50 },
    })

    const dispatcher = makeDispatcher([stepResult])
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps: StepDefinition[] = [{
      name: 'arch-step',
      taskType: 'arch-decisions',
      outputSchema: TestOutputSchema,
      context: [{ placeholder: 'concept', source: 'param:concept' }],
      persist: [],
      // No critique flag — should not trigger critique loop
    }]

    const result = await runSteps(steps, deps, runId, 'solutioning', { concept: 'Build a CLI' })

    expect(result.success).toBe(true)
    // Only 1 dispatch (step only, no critique)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
  })

  it('stores critique decisions in decision store during step execution (AC7)', async () => {
    const pack = makePack({
      'arch-step': 'Architecture: {{concept}}',
      'critique-architecture': 'Review: {{artifact}}',
    })

    const stepResult = makeDispatchResult({
      parsed: { result: 'success', architecture_decisions: [{ category: 'lang', key: 'runtime', value: 'Node.js' }] },
    })

    const critiqueResult = makeDispatchResult({
      parsed: {
        verdict: 'needs_work',
        issue_count: 1,
        issues: [{ severity: 'minor', category: 'security', description: 'No auth', suggestion: 'Add auth' }],
      },
    })

    const dispatcher = makeDispatcher([stepResult, critiqueResult])
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps: StepDefinition[] = [{
      name: 'arch-step',
      taskType: 'arch-decisions',
      outputSchema: TestOutputSchema,
      context: [{ placeholder: 'concept', source: 'param:concept' }],
      persist: [],
      critique: true,
    }]

    await runSteps(steps, deps, runId, 'solutioning', { concept: 'CLI' })

    // Verify critique decisions were stored
    const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'solutioning')
    const critiqueDecisions = decisions.filter((d) => d.category === 'critique')
    expect(critiqueDecisions.length).toBeGreaterThanOrEqual(1)
  })

  it('continues pipeline when critique loop throws an error', async () => {
    // Use a direct map to avoid vi.fn recursion issues with originalGetPrompt pattern
    const prompts: Record<string, string> = {
      'arch-step': 'Architecture: {{concept}}',
    }

    const pack = makePack(prompts)

    // Override getPrompt to reject for the critique template but resolve from the map for others
    vi.mocked(pack.getPrompt).mockImplementation((key: string) => {
      if (key === 'critique-architecture') {
        return Promise.reject(new Error('Prompt not found'))
      }
      const template = prompts[key] ?? `Template: {{placeholder}}`
      return Promise.resolve(template)
    })

    const stepResult = makeDispatchResult({
      parsed: { result: 'success' },
    })

    const dispatcher = makeDispatcher([stepResult])
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps: StepDefinition[] = [{
      name: 'arch-step',
      taskType: 'arch-decisions',
      outputSchema: TestOutputSchema,
      context: [{ placeholder: 'concept', source: 'param:concept' }],
      persist: [],
      critique: true,
    }]

    // Should not throw — critique failure is non-blocking
    const result = await runSteps(steps, deps, runId, 'solutioning', { concept: 'CLI' })
    expect(result.success).toBe(true)
  })

  // -------------------------------------------------------------------------
  // G11: critique dispatches are captured in phase_outputs
  // -------------------------------------------------------------------------

  it('writes critique dispatch output to phase_outputs keyed on <step>:critique:<iter> (G11)', async () => {
    const pack = makePack({
      'arch-step': 'Architecture: {{concept}}',
      'critique-architecture': 'Review: {{artifact}}',
      'refine-artifact': 'Refine: {{artifact}} Issues: {{issues}}',
    })

    const stepResult = makeDispatchResult({
      id: 'step-1',
      output: 'main step output',
      parsed: {
        result: 'success',
        architecture_decisions: [{ category: 'lang', key: 'runtime', value: 'Node.js' }],
      },
    })
    const critiqueResult = makeDispatchResult({
      id: 'critique-1',
      output: 'critique pass output text',
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
    })

    const dispatcher = makeDispatcher([stepResult, critiqueResult])
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps: StepDefinition[] = [
      {
        name: 'arch-step',
        taskType: 'arch-decisions',
        outputSchema: TestOutputSchema,
        context: [{ placeholder: 'concept', source: 'param:concept' }],
        persist: [],
        critique: true,
      },
    ]

    await runSteps(steps, deps, runId, 'solutioning', { concept: 'Build a CLI' })

    const rows = await getRawOutputsByPhaseForRun(adapter, runId, 'solutioning')
    // Two rows: the main step dispatch + the critique iteration-1 dispatch
    const main = rows.find((r) => r.step_name === 'arch-step')
    const critique = rows.find((r) => r.step_name === 'arch-step:critique:1')
    expect(main?.raw_output).toBe('main step output')
    expect(critique?.raw_output).toBe('critique pass output text')
  })

  it('captures both critique and refinement outputs when critique returns needs_work (G11)', async () => {
    const pack = makePack({
      'arch-step': 'Architecture: {{concept}}',
      'critique-architecture': 'Review: {{artifact}}',
      'refine-artifact': 'Refine: {{artifact}} Issues: {{issues}}',
    })

    const stepResult = makeDispatchResult({
      id: 'step-1',
      output: 'main step output',
      parsed: {
        result: 'success',
        architecture_decisions: [{ category: 'lang', key: 'runtime', value: 'Node.js' }],
      },
    })
    const critique1 = makeDispatchResult({
      id: 'critique-1',
      output: 'critique-1 needs work',
      parsed: {
        verdict: 'needs_work',
        issue_count: 1,
        issues: [
          {
            severity: 'major',
            category: 'rationale',
            description: 'no rationale given',
            suggestion: 'add rationale',
          },
        ],
      },
    })
    const refine = makeDispatchResult({
      id: 'refine-1',
      output: 'refined artifact body',
      parsed: null,
    })
    const critique2 = makeDispatchResult({
      id: 'critique-2',
      output: 'critique-2 pass',
      parsed: { verdict: 'pass', issue_count: 0, issues: [] },
    })

    const dispatcher = makeDispatcher([stepResult, critique1, refine, critique2])
    const deps = makeDeps(adapter, dispatcher, pack)

    const steps: StepDefinition[] = [
      {
        name: 'arch-step',
        taskType: 'arch-decisions',
        outputSchema: TestOutputSchema,
        context: [{ placeholder: 'concept', source: 'param:concept' }],
        persist: [],
        critique: true,
      },
    ]

    await runSteps(steps, deps, runId, 'solutioning', { concept: 'Build a CLI' })

    const rows = await getRawOutputsByPhaseForRun(adapter, runId, 'solutioning')
    const critique1Row = rows.find((r) => r.step_name === 'arch-step:critique:1')
    const refineRow = rows.find((r) => r.step_name === 'arch-step:critique:1:refine')
    const critique2Row = rows.find((r) => r.step_name === 'arch-step:critique:2')

    expect(critique1Row?.raw_output).toBe('critique-1 needs work')
    expect(refineRow?.raw_output).toBe('refined artifact body')
    expect(critique2Row?.raw_output).toBe('critique-2 pass')
  })
})
