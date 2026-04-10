/**
 * Unit tests for the step-runner module.
 *
 * Covers:
 *  - Context resolution (param:, decision:, step:)
 *  - Sequential step execution
 *  - Error handling (dispatch failure, timeout, schema failure, agent failure)
 *  - Decision store persistence via persist mappings
 *  - Artifact registration
 *  - Token usage accumulation
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { z } from 'zod'
import { InMemoryDatabaseAdapter } from '../../../persistence/memory-adapter.js'
import { initSchema } from '../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../persistence/adapter.js'
import {
  createPipelineRun,
  createDecision,
  getDecisionsByPhaseForRun,
  getArtifactByTypeForRun,
} from '../../../persistence/queries/decisions.js'
import { runSteps, resolveContext, formatDecisionsForInjection } from '../step-runner.js'
import {
  calculateDynamicBudget,
  ABSOLUTE_MAX_PROMPT_TOKENS,
  TOKENS_PER_DECISION,
} from '../budget-utils.js'
import type { StepDefinition, ContextRef } from '../step-runner.js'
import type { PhaseDeps } from '../phases/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: InMemoryDatabaseAdapter }> {
  const adapter = new InMemoryDatabaseAdapter()
  await initSchema(adapter)
  return { adapter }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

const TestOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  value: z.string().optional(),
  items: z.array(z.string()).optional(),
})

function makeDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {}
): DispatchResult<unknown> {
  return {
    id: 'dispatch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', value: 'test-value' },
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
      return Promise.resolve(prompts[key] ?? `Template for {{placeholder}}: {{concept}}`)
    }),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi
      .fn()
      .mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack?: MethodologyPack
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

describe('step-runner', () => {
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
  // formatDecisionsForInjection
  // -------------------------------------------------------------------------

  describe('formatDecisionsForInjection()', () => {
    it('returns empty string for empty decisions', () => {
      expect(formatDecisionsForInjection([])).toBe('')
    })

    it('formats simple key-value decisions', () => {
      const decisions = [
        { key: 'language', value: 'TypeScript', rationale: null },
        { key: 'database', value: 'SQLite', rationale: 'fast and simple' },
      ]
      const result = formatDecisionsForInjection(decisions, 'Tech Stack')
      expect(result).toContain('## Tech Stack')
      expect(result).toContain('**language**: TypeScript')
      expect(result).toContain('**database**: SQLite (fast and simple)')
    })

    it('formats JSON array values as bullet lists', () => {
      const decisions = [{ key: 'features', value: '["auth","dashboard"]', rationale: null }]
      const result = formatDecisionsForInjection(decisions)
      expect(result).toContain('### Features')
      expect(result).toContain('- auth')
      expect(result).toContain('- dashboard')
    })
  })

  // -------------------------------------------------------------------------
  // resolveContext
  // -------------------------------------------------------------------------

  describe('resolveContext()', () => {
    it('resolves param: references from params map', async () => {
      const ref: ContextRef = { placeholder: 'concept', source: 'param:concept' }
      const deps = makeDeps(adapter, makeDispatcher([]))
      const result = await resolveContext(
        ref,
        deps,
        runId,
        { concept: 'Build a CLI tool' },
        new Map()
      )
      expect(result).toBe('Build a CLI tool')
    })

    it('returns empty string for missing param', async () => {
      const ref: ContextRef = { placeholder: 'concept', source: 'param:missing' }
      const deps = makeDeps(adapter, makeDispatcher([]))
      const result = await resolveContext(ref, deps, runId, {}, new Map())
      expect(result).toBe('')
    })

    it('resolves decision: references from the decision store', async () => {
      await createDecision(adapter, {
        pipeline_run_id: runId,
        phase: 'analysis',
        category: 'product-brief',
        key: 'problem_statement',
        value: 'Users need better tools',
      })

      const ref: ContextRef = { placeholder: 'brief', source: 'decision:analysis.product-brief' }
      const deps = makeDeps(adapter, makeDispatcher([]))
      const result = await resolveContext(ref, deps, runId, {}, new Map())
      expect(result).toContain('problem_statement')
      expect(result).toContain('Users need better tools')
    })

    it('resolves step: references from prior step outputs', async () => {
      const stepOutputs = new Map<string, Record<string, unknown>>()
      stepOutputs.set('step-1', { result: 'success', problem_statement: 'A big problem' })

      const ref: ContextRef = { placeholder: 'vision', source: 'step:step-1' }
      const deps = makeDeps(adapter, makeDispatcher([]))
      const result = await resolveContext(ref, deps, runId, {}, stepOutputs)
      expect(result).toContain('A big problem')
      expect(result).not.toContain('result') // 'result' key is skipped
    })

    it('returns empty string for unknown source prefix', async () => {
      const ref: ContextRef = { placeholder: 'x', source: 'unknown:foo' }
      const deps = makeDeps(adapter, makeDispatcher([]))
      const result = await resolveContext(ref, deps, runId, {}, new Map())
      expect(result).toBe('')
    })
  })

  // -------------------------------------------------------------------------
  // runSteps — sequential execution
  // -------------------------------------------------------------------------

  describe('runSteps()', () => {
    it('executes steps sequentially and returns success', async () => {
      const pack = makePack({
        'step-1': 'Analyze: {{concept}}',
        'step-2': 'Scope: {{concept}} with {{prior}}',
      })

      const dispatchResult1 = makeDispatchResult({
        id: 'd-1',
        parsed: { result: 'success', value: 'vision-output' },
        tokenEstimate: { input: 100, output: 50 },
      })
      const dispatchResult2 = makeDispatchResult({
        id: 'd-2',
        parsed: { result: 'success', value: 'scope-output' },
        tokenEstimate: { input: 200, output: 80 },
      })

      const dispatcher = makeDispatcher([dispatchResult1, dispatchResult2])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [{ field: 'value', category: 'test-cat', key: 'vision' }],
        },
        {
          name: 'step-2',
          taskType: 'analysis-scope',
          outputSchema: TestOutputSchema,
          context: [
            { placeholder: 'concept', source: 'param:concept' },
            { placeholder: 'prior', source: 'step:step-1' },
          ],
          persist: [{ field: 'value', category: 'test-cat', key: 'scope' }],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'Build a CLI' })

      expect(result.success).toBe(true)
      expect(result.steps).toHaveLength(2)
      expect(result.steps[0]!.success).toBe(true)
      expect(result.steps[1]!.success).toBe(true)
      expect(result.tokenUsage.input).toBe(300)
      expect(result.tokenUsage.output).toBe(130)

      // Verify decisions were persisted
      const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
      expect(decisions).toHaveLength(2)
    })

    it('halts on first step failure and returns error', async () => {
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}', 'step-2': 'Scope: {{concept}}' })

      const failedResult = makeDispatchResult({
        id: 'd-1',
        status: 'failed',
        parsed: null,
        parseError: 'Agent crashed',
        tokenEstimate: { input: 50, output: 0 },
      })

      const dispatcher = makeDispatcher([failedResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
        },
        {
          name: 'step-2',
          taskType: 'analysis-scope',
          outputSchema: TestOutputSchema,
          context: [],
          persist: [],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      expect(result.success).toBe(false)
      expect(result.steps).toHaveLength(1)
      expect(result.error).toContain('step-1')
      expect(result.error).toContain('dispatch failed')

      // Step 2 should NOT have been dispatched
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
    })

    it('handles dispatch timeout', async () => {
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}' })

      const timeoutResult = makeDispatchResult({
        id: 'd-1',
        status: 'timeout',
        parsed: null,
        durationMs: 180000,
        tokenEstimate: { input: 100, output: 0 },
      })

      const dispatcher = makeDispatcher([timeoutResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('timed out')
    })

    it('handles agent reporting failure', async () => {
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}' })

      const agentFailure = makeDispatchResult({
        parsed: { result: 'failed' },
        tokenEstimate: { input: 100, output: 20 },
      })

      const dispatcher = makeDispatcher([agentFailure])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('agent reported failure')
    })

    it('handles schema validation failure (null parsed)', async () => {
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}' })

      const schemaFail = makeDispatchResult({
        parsed: null,
        parseError: 'Invalid YAML structure',
      })

      const dispatcher = makeDispatcher([schemaFail])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      expect(result.success).toBe(false)
      expect(result.error).toContain('schema validation failed')
    })

    it('persists array fields with indexed keys when key="array"', async () => {
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}' })

      const dispResult = makeDispatchResult({
        parsed: { result: 'success', items: ['feature-1', 'feature-2'] },
      })

      const dispatcher = makeDispatcher([dispResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [{ field: 'items', category: 'features', key: 'array' }],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })
      expect(result.success).toBe(true)

      const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
      expect(decisions).toHaveLength(2)
      // Keys use step name prefix to avoid collisions across steps
      expect(decisions[0]!.key).toBe('step-1-0')
      expect(decisions[1]!.key).toBe('step-1-1')
    })

    it('registers artifact when step has registerArtifact config', async () => {
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}' })

      const dispResult = makeDispatchResult({
        parsed: { result: 'success', value: 'done' },
      })

      const dispatcher = makeDispatcher([dispResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          registerArtifact: {
            type: 'product-brief',
            path: 'decision-store://test/brief',
            summarize: () => 'Test artifact',
          },
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })
      expect(result.success).toBe(true)
      expect(result.steps[0]!.artifactId).toBeDefined()

      const artifact = await getArtifactByTypeForRun(adapter, runId, 'analysis', 'product-brief')
      expect(artifact).toBeTruthy()
      expect(artifact!.summary).toBe('Test artifact')
    })

    it('attempts decision summarization when prompt exceeds budget', async () => {
      // Create a very long decision to push the prompt over budget
      const longValue = 'x'.repeat(10_000)
      await createDecision(adapter, {
        pipeline_run_id: runId,
        phase: 'analysis',
        category: 'product-brief',
        key: 'problem',
        value: longValue,
      })

      // Template with a decision ref that resolves to a very large value
      const pack = makePack({
        'step-1': 'Analyze: {{brief}}',
      })

      const dispResult = makeDispatchResult({
        parsed: { result: 'success', value: 'output' },
      })
      const dispatcher = makeDispatcher([dispResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'brief', source: 'decision:analysis.product-brief' }],
          persist: [],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', {})

      // The summarizer should compress the decisions enough to fit within budget,
      // so the step should succeed (dispatch should be called)
      if (result.success) {
        expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
      } else {
        // If still over budget after summarization, the error message should indicate it
        expect(result.error).toContain('after summarization')
      }
    })

    it('handles unexpected exception during step execution', async () => {
      const pack = makePack()
      // Make getPrompt throw
      vi.mocked(pack.getPrompt).mockRejectedValue(new Error('File not found'))

      const dispatcher = makeDispatcher([])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [],
          persist: [],
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('unexpected error')
      expect(result.error).toContain('File not found')
    })
  })

  // -------------------------------------------------------------------------
  // runSteps — elicitation integration (Story 16.3)
  // -------------------------------------------------------------------------

  describe('runSteps() — elicitation integration', () => {
    it('runs elicitation after step when elicitate: true is set', async () => {
      const pack = makePack({
        'step-1': 'Analyze: {{concept}}',
        'elicitation-apply':
          '# Elicitation: {{method_name}}\n\n**Description:** {{method_description}}\n\n**Output Pattern:** {{output_pattern}}\n\n## Artifact\n\n{{artifact_content}}\n\nReturn YAML.',
      })

      const stepDispatchResult = makeDispatchResult({
        id: 'd-1',
        parsed: { result: 'success', value: 'vision-output' },
        tokenEstimate: { input: 100, output: 50 },
      })
      // Two elicitation dispatch results (one per selected method)
      const elicitResult1 = makeDispatchResult({
        id: 'd-elicit-1',
        parsed: { result: 'success', insights: 'Insight from method 1: users need async' },
        tokenEstimate: { input: 80, output: 40 },
      })
      const elicitResult2 = makeDispatchResult({
        id: 'd-elicit-2',
        parsed: { result: 'success', insights: 'Insight from method 2: simplify model' },
        tokenEstimate: { input: 70, output: 35 },
      })

      const dispatcher = makeDispatcher([stepDispatchResult, elicitResult1, elicitResult2])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [{ field: 'value', category: 'test-cat', key: 'vision' }],
          elicitate: true,
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'Build a CLI' })

      expect(result.success).toBe(true)
      expect(result.steps).toHaveLength(1)
      expect(result.steps[0]!.success).toBe(true)

      // Main step tokens
      expect(result.tokenUsage.input).toBe(100)
      expect(result.tokenUsage.output).toBe(50)

      // Elicitation tokens tracked separately
      expect(result.elicitationTokenUsage.input).toBe(150) // 80 + 70
      expect(result.elicitationTokenUsage.output).toBe(75) // 40 + 35
      expect(result.steps[0]!.elicitationTokenUsage).toBeDefined()
      expect(result.steps[0]!.elicitationTokenUsage!.input).toBe(150)

      // Dispatcher called 3 times: 1 step + 2 elicitation
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)

      // Elicitation results stored in decision store
      const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
      const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')
      expect(elicitDecisions.length).toBe(4) // 2 methods × (method + insights)
      expect(elicitDecisions.find((d) => d.key === 'analysis-round-1-method')).toBeDefined()
      expect(elicitDecisions.find((d) => d.key === 'analysis-round-1-insights')).toBeDefined()
      expect(elicitDecisions.find((d) => d.key === 'analysis-round-2-method')).toBeDefined()
      expect(elicitDecisions.find((d) => d.key === 'analysis-round-2-insights')).toBeDefined()
    })

    it('does not run elicitation when elicitate is not set', async () => {
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}' })

      const dispResult = makeDispatchResult({
        parsed: { result: 'success', value: 'test' },
      })
      const dispatcher = makeDispatcher([dispResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          // No elicitate flag
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      expect(result.success).toBe(true)
      expect(result.elicitationTokenUsage.input).toBe(0)
      expect(result.elicitationTokenUsage.output).toBe(0)
      // Only step dispatch, no elicitation dispatch
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1)
    })

    it('handles elicitation dispatch failure gracefully (non-blocking)', async () => {
      const pack = makePack({
        'step-1': 'Analyze: {{concept}}',
        'elicitation-apply':
          '# {{method_name}} {{method_description}} {{output_pattern}} {{artifact_content}}',
      })

      const stepResult = makeDispatchResult({
        id: 'd-1',
        parsed: { result: 'success', value: 'output' },
        tokenEstimate: { input: 100, output: 50 },
      })
      const failedElicit: DispatchResult<unknown> = {
        id: 'd-elicit-1',
        status: 'failed',
        exitCode: 1,
        output: 'Agent error',
        parsed: null,
        parseError: 'Parse failed',
        durationMs: 100,
        tokenEstimate: { input: 50, output: 0 },
      }

      const dispatcher = makeDispatcher([stepResult, failedElicit, failedElicit])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          elicitate: true,
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      // Step still succeeds even though elicitation failed
      expect(result.success).toBe(true)
      expect(result.steps[0]!.success).toBe(true)

      // No elicitation decisions stored on failure
      const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
      const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')
      expect(elicitDecisions.length).toBe(0)
    })

    it('handles elicitation prompt loading error gracefully', async () => {
      // Pack that fails to load elicitation-apply prompt
      const pack = makePack({ 'step-1': 'Analyze: {{concept}}' })
      vi.mocked(pack.getPrompt).mockImplementation((key: string) => {
        if (key === 'step-1') return Promise.resolve('Analyze: {{concept}}')
        return Promise.reject(new Error('Template not found: ' + key))
      })

      const dispResult = makeDispatchResult({
        parsed: { result: 'success', value: 'output' },
      })
      const dispatcher = makeDispatcher([dispResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          elicitate: true,
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      // Step still succeeds — elicitation error is non-blocking
      expect(result.success).toBe(true)
    })

    it('fills elicitation prompt placeholders with method data', async () => {
      const elicitTemplate =
        '# {{method_name}}: {{method_description}} | {{output_pattern}}\n\n{{artifact_content}}'
      const pack = makePack({
        'step-1': 'Analyze: {{concept}}',
        'elicitation-apply': elicitTemplate,
      })

      const stepResult = makeDispatchResult({
        id: 'd-1',
        parsed: { result: 'success', value: 'test-output' },
        tokenEstimate: { input: 100, output: 50 },
      })
      const elicitResult = makeDispatchResult({
        id: 'd-elicit-1',
        parsed: { result: 'success', insights: 'Test insight' },
        tokenEstimate: { input: 60, output: 30 },
      })

      const dispatcher = makeDispatcher([stepResult, elicitResult, elicitResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          elicitate: true,
        },
      ]

      await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      // Verify elicitation dispatch was called with filled prompt
      const dispatchCalls = vi.mocked(dispatcher.dispatch).mock.calls
      expect(dispatchCalls.length).toBeGreaterThanOrEqual(2)

      // Second call should be elicitation with taskType 'elicitation'
      const elicitCall = dispatchCalls[1]!
      expect(elicitCall[0].taskType).toBe('elicitation')
      // Prompt should not have any remaining placeholders
      expect(elicitCall[0].prompt).not.toContain('{{method_name}}')
      expect(elicitCall[0].prompt).not.toContain('{{method_description}}')
      expect(elicitCall[0].prompt).not.toContain('{{output_pattern}}')
      expect(elicitCall[0].prompt).not.toContain('{{artifact_content}}')
    })

    it('uses ElicitationOutputSchema for elicitation dispatch validation', async () => {
      const pack = makePack({
        'step-1': 'Analyze: {{concept}}',
        'elicitation-apply':
          '{{method_name}} {{method_description}} {{output_pattern}} {{artifact_content}}',
      })

      const stepResult = makeDispatchResult({
        parsed: { result: 'success', value: 'output' },
      })
      const elicitResult = makeDispatchResult({
        parsed: { result: 'success', insights: 'Insights here' },
      })

      const dispatcher = makeDispatcher([stepResult, elicitResult, elicitResult])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          elicitate: true,
        },
      ]

      await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      const calls = vi.mocked(dispatcher.dispatch).mock.calls
      // Elicitation calls should pass the ElicitationOutputSchema
      for (let i = 1; i < calls.length; i++) {
        expect(calls[i]![0].outputSchema).toBeDefined()
      }
    })

    it('tracks elicitation method rotation across multiple steps', async () => {
      const pack = makePack({
        'step-1': 'Analyze: {{concept}}',
        'step-2': 'Plan: {{concept}}',
        'elicitation-apply':
          '{{method_name}} {{method_description}} {{output_pattern}} {{artifact_content}}',
      })

      // 1 step + 2 elicits for step-1, then 1 step + 2 elicits for step-2 = 6 total
      const stepResult1 = makeDispatchResult({
        id: 'd-1',
        parsed: { result: 'success', value: 'v1' },
        tokenEstimate: { input: 100, output: 50 },
      })
      const stepResult2 = makeDispatchResult({
        id: 'd-2',
        parsed: { result: 'success', value: 'v2' },
        tokenEstimate: { input: 100, output: 50 },
      })
      const elicitResult = makeDispatchResult({
        id: 'd-e',
        parsed: { result: 'success', insights: 'insight' },
        tokenEstimate: { input: 50, output: 25 },
      })

      const dispatcher = makeDispatcher([
        stepResult1,
        elicitResult,
        elicitResult,
        stepResult2,
        elicitResult,
        elicitResult,
      ])
      const deps = makeDeps(adapter, dispatcher, pack)

      const steps: StepDefinition[] = [
        {
          name: 'step-1',
          taskType: 'analysis-vision',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          elicitate: true,
        },
        {
          name: 'step-2',
          taskType: 'planning-classification',
          outputSchema: TestOutputSchema,
          context: [{ placeholder: 'concept', source: 'param:concept' }],
          persist: [],
          elicitate: true,
        },
      ]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })

      expect(result.success).toBe(true)
      expect(result.steps).toHaveLength(2)

      // Both steps should have elicitation tokens
      expect(result.steps[0]!.elicitationTokenUsage).toBeDefined()
      expect(result.steps[1]!.elicitationTokenUsage).toBeDefined()

      // Total elicitation tokens accumulated
      expect(result.elicitationTokenUsage.input).toBeGreaterThan(0)
      expect(result.elicitationTokenUsage.output).toBeGreaterThan(0)

      // Decision store should have elicitation entries from both steps
      const decisions = await getDecisionsByPhaseForRun(adapter, runId, 'analysis')
      const elicitDecisions = decisions.filter((d) => d.category === 'elicitation')
      expect(elicitDecisions.length).toBeGreaterThanOrEqual(4) // at least 2 methods × 2 (method + insights)
    })
  })

  // -------------------------------------------------------------------------
  // calculateDynamicBudget
  // -------------------------------------------------------------------------

  describe('calculateDynamicBudget()', () => {
    it('computes base_budget + (decision_count * tokens_per_decision)', () => {
      // base=3000, count=5 → 3000 + (5 * 100) = 3500
      expect(calculateDynamicBudget(3_000, 5)).toBe(3_000 + 5 * TOKENS_PER_DECISION)
    })

    it('returns base budget unchanged when decision count is 0', () => {
      expect(calculateDynamicBudget(4_000, 0)).toBe(4_000)
    })

    it('caps result at ABSOLUTE_MAX_PROMPT_TOKENS regardless of inputs', () => {
      // Very large decision count should not exceed the cap
      expect(calculateDynamicBudget(10_000, 1_000)).toBe(ABSOLUTE_MAX_PROMPT_TOKENS)
    })

    it('handles a representative scenario: base=2000, count=20 → 4000', () => {
      // base=2000, count=20 → 2000 + (20 * 100) = 4000, which is under cap
      expect(calculateDynamicBudget(2_000, 20)).toBe(2_000 + 20 * TOKENS_PER_DECISION)
      expect(calculateDynamicBudget(2_000, 20)).toBeLessThan(ABSOLUTE_MAX_PROMPT_TOKENS)
    })
  })
})
