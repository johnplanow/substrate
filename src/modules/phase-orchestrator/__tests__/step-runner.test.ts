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
import Database from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { z } from 'zod'
import { runMigrations } from '../../../persistence/migrations/index.js'
import {
  createPipelineRun,
  createDecision,
  getDecisionsByPhaseForRun,
  getArtifactByTypeForRun,
} from '../../../persistence/queries/decisions.js'
import {
  runSteps,
  resolveContext,
  formatDecisionsForInjection,
} from '../step-runner.js'
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

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'step-runner-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

const TestOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  value: z.string().optional(),
  items: z.array(z.string()).optional(),
})

function makeDispatchResult(
  overrides: Partial<DispatchResult<unknown>> = {},
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
// Tests
// ---------------------------------------------------------------------------

describe('step-runner', () => {
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
      const decisions = [
        { key: 'features', value: '["auth","dashboard"]', rationale: null },
      ]
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
    it('resolves param: references from params map', () => {
      const ref: ContextRef = { placeholder: 'concept', source: 'param:concept' }
      const deps = makeDeps(db, makeDispatcher([]))
      const result = resolveContext(ref, deps, runId, { concept: 'Build a CLI tool' }, new Map())
      expect(result).toBe('Build a CLI tool')
    })

    it('returns empty string for missing param', () => {
      const ref: ContextRef = { placeholder: 'concept', source: 'param:missing' }
      const deps = makeDeps(db, makeDispatcher([]))
      const result = resolveContext(ref, deps, runId, {}, new Map())
      expect(result).toBe('')
    })

    it('resolves decision: references from the decision store', () => {
      createDecision(db, {
        pipeline_run_id: runId,
        phase: 'analysis',
        category: 'product-brief',
        key: 'problem_statement',
        value: 'Users need better tools',
      })

      const ref: ContextRef = { placeholder: 'brief', source: 'decision:analysis.product-brief' }
      const deps = makeDeps(db, makeDispatcher([]))
      const result = resolveContext(ref, deps, runId, {}, new Map())
      expect(result).toContain('problem_statement')
      expect(result).toContain('Users need better tools')
    })

    it('resolves step: references from prior step outputs', () => {
      const stepOutputs = new Map<string, Record<string, unknown>>()
      stepOutputs.set('step-1', { result: 'success', problem_statement: 'A big problem' })

      const ref: ContextRef = { placeholder: 'vision', source: 'step:step-1' }
      const deps = makeDeps(db, makeDispatcher([]))
      const result = resolveContext(ref, deps, runId, {}, stepOutputs)
      expect(result).toContain('A big problem')
      expect(result).not.toContain('result') // 'result' key is skipped
    })

    it('returns empty string for unknown source prefix', () => {
      const ref: ContextRef = { placeholder: 'x', source: 'unknown:foo' }
      const deps = makeDeps(db, makeDispatcher([]))
      const result = resolveContext(ref, deps, runId, {}, new Map())
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
      const deps = makeDeps(db, dispatcher, pack)

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
      const decisions = getDecisionsByPhaseForRun(db, runId, 'analysis')
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
      const deps = makeDeps(db, dispatcher, pack)

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
      const deps = makeDeps(db, dispatcher, pack)

      const steps: StepDefinition[] = [{
        name: 'step-1',
        taskType: 'analysis-vision',
        outputSchema: TestOutputSchema,
        context: [{ placeholder: 'concept', source: 'param:concept' }],
        persist: [],
      }]

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
      const deps = makeDeps(db, dispatcher, pack)

      const steps: StepDefinition[] = [{
        name: 'step-1',
        taskType: 'analysis-vision',
        outputSchema: TestOutputSchema,
        context: [{ placeholder: 'concept', source: 'param:concept' }],
        persist: [],
      }]

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
      const deps = makeDeps(db, dispatcher, pack)

      const steps: StepDefinition[] = [{
        name: 'step-1',
        taskType: 'analysis-vision',
        outputSchema: TestOutputSchema,
        context: [{ placeholder: 'concept', source: 'param:concept' }],
        persist: [],
      }]

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
      const deps = makeDeps(db, dispatcher, pack)

      const steps: StepDefinition[] = [{
        name: 'step-1',
        taskType: 'analysis-vision',
        outputSchema: TestOutputSchema,
        context: [{ placeholder: 'concept', source: 'param:concept' }],
        persist: [{ field: 'items', category: 'features', key: 'array' }],
      }]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })
      expect(result.success).toBe(true)

      const decisions = getDecisionsByPhaseForRun(db, runId, 'analysis')
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
      const deps = makeDeps(db, dispatcher, pack)

      const steps: StepDefinition[] = [{
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
      }]

      const result = await runSteps(steps, deps, runId, 'analysis', { concept: 'CLI' })
      expect(result.success).toBe(true)
      expect(result.steps[0]!.artifactId).toBeDefined()

      const artifact = getArtifactByTypeForRun(db, runId, 'analysis', 'product-brief')
      expect(artifact).toBeTruthy()
      expect(artifact!.summary).toBe('Test artifact')
    })

    it('attempts decision summarization when prompt exceeds budget', async () => {
      // Create a very long decision to push the prompt over budget
      const longValue = 'x'.repeat(10_000)
      createDecision(db, {
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
      const deps = makeDeps(db, dispatcher, pack)

      const steps: StepDefinition[] = [{
        name: 'step-1',
        taskType: 'analysis-vision',
        outputSchema: TestOutputSchema,
        context: [{ placeholder: 'brief', source: 'decision:analysis.product-brief' }],
        persist: [],
      }]

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
      const deps = makeDeps(db, dispatcher, pack)

      const steps: StepDefinition[] = [{
        name: 'step-1',
        taskType: 'analysis-vision',
        outputSchema: TestOutputSchema,
        context: [],
        persist: [],
      }]

      const result = await runSteps(steps, deps, runId, 'analysis', {})

      expect(result.success).toBe(false)
      expect(result.error).toContain('unexpected error')
      expect(result.error).toContain('File not found')
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
