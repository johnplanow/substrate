/**
 * Integration test for the critique loop in the architecture phase.
 *
 * Verifies end-to-end dispatch behaviour through step-runner when a step
 * has `critique: true` set (AC1, Story 16-4).
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
  getDecisionsByPhaseForRun,
  getTokenUsageSummary,
} from '../../../persistence/queries/decisions.js'
import { runSteps } from '../step-runner.js'
import type { StepDefinition } from '../step-runner.js'
import type { PhaseDeps } from '../phases/types.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb(): { db: BetterSqlite3Database; tmpDir: string } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'critique-integration-test-'))
  const db = new Database(join(tmpDir, 'test.db'))
  runMigrations(db)
  return { db, tmpDir }
}

function createTestRun(db: BetterSqlite3Database): string {
  const run = createPipelineRun(db, { methodology: 'bmad', start_phase: 'solutioning' })
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
// Integration test
// ---------------------------------------------------------------------------

describe('critique loop integration with step-runner', () => {
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
    const deps = makeDeps(db, dispatcher, pack)

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
    const deps = makeDeps(db, dispatcher, pack)

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
    const deps = makeDeps(db, dispatcher, pack)

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
    const decisions = getDecisionsByPhaseForRun(db, runId, 'solutioning')
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
    const deps = makeDeps(db, dispatcher, pack)

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
})
