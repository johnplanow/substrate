/**
 * Unit tests for the retry-with-gap-analysis flow in runSolutioningPhase().
 *
 * T12: Tests the retry mechanism triggered when readiness returns NEEDS_WORK
 * with blocker findings (AC6).
 *
 * Key behaviors under test:
 *  - Retry is triggered only when NEEDS_WORK has ≥1 blocker findings
 *  - Retry prompt includes gap analysis with blocker descriptions
 *  - Retry dispatches with taskType='story-generation'
 *  - Findings are stored in decision store before retry
 *  - Event emitted for NEEDS_WORK before retry
 *  - Max 1 retry (2 total readiness checks)
 *  - Retry READY → success
 *  - Retry NOT_READY → failure ('readiness_check_failed')
 *  - Retry NEEDS_WORK → failure ('readiness_check_failed')
 *  - Retry story generation itself failing → 'story_generation_retry_failed'
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createWasmSqliteAdapter } from '../../../../persistence/wasm-sqlite-adapter.js'
import { initSchema } from '../../../../persistence/schema.js'
import type { DatabaseAdapter } from '../../../../persistence/adapter.js'
import {
  createPipelineRun,
  createDecision,
} from '../../../../persistence/queries/decisions.js'
import { runSolutioningPhase } from '../solutioning.js'
import type {
  PhaseDeps,
  ArchitectureDecision,
  EpicDefinition,
} from '../types.js'
import type { MethodologyPack } from '../../../methodology-pack/types.js'
import type { ContextCompiler } from '../../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../../core/event-bus.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function createTestDb(): Promise<{ adapter: DatabaseAdapter }> {
  const adapter = await createWasmSqliteAdapter()
  await initSchema(adapter)
  return { adapter }
}

async function createTestRun(adapter: DatabaseAdapter): Promise<string> {
  const run = await createPipelineRun(adapter, { methodology: 'bmad', start_phase: 'analysis' })
  return run.id
}

async function seedPlanningRequirements(adapter: DatabaseAdapter, runId: string): Promise<void> {
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'functional-requirements',
    key: 'FR-0',
    value: JSON.stringify({ description: 'User can create tasks with title and description', priority: 'must' }),
  })
  await createDecision(adapter, {
    pipeline_run_id: runId,
    phase: 'planning',
    category: 'functional-requirements',
    key: 'FR-1',
    value: JSON.stringify({ description: 'User can set task due dates', priority: 'should' }),
  })
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const SAMPLE_ARCHITECTURE_DECISIONS: ArchitectureDecision[] = [
  { category: 'language', key: 'language', value: 'TypeScript', rationale: 'Type safety' },
  { category: 'database', key: 'database', value: 'SQLite', rationale: 'Simplicity' },
]

const BASE_EPICS: EpicDefinition[] = [
  {
    title: 'Task Management',
    description: 'Basic task operations',
    stories: [
      {
        key: '1-1',
        title: 'Create task',
        description: 'A basic story',
        acceptance_criteria: ['Story has AC'],
        priority: 'must',
      },
    ],
  },
]

const IMPROVED_EPICS: EpicDefinition[] = [
  {
    title: 'Task Management',
    description: 'Full task lifecycle including due dates',
    stories: [
      {
        key: '1-1',
        title: 'Create task with title and description',
        description: 'User can create tasks. Supports task creation with all fields.',
        acceptance_criteria: [
          'Given user is logged in, When they click Create, Then a new task form appears',
        ],
        priority: 'must',
      },
      {
        key: '1-2',
        title: 'Set task due dates',
        description: 'User can set due dates on tasks for scheduling.',
        acceptance_criteria: [
          'Given user views a task, When they pick a date, Then the date is saved',
        ],
        priority: 'should',
      },
    ],
  },
]

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeArchDispatchResult(overrides: Partial<DispatchResult<unknown>> = {}): DispatchResult<unknown> {
  return {
    id: 'dispatch-arch-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', architecture_decisions: SAMPLE_ARCHITECTURE_DECISIONS },
    parseError: null,
    durationMs: 1000,
    tokenEstimate: { input: 400, output: 150 },
    ...overrides,
  }
}

function makeStoryDispatchResult(
  epics = BASE_EPICS,
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  return {
    id: 'dispatch-story-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { result: 'success', epics },
    parseError: null,
    durationMs: 2000,
    tokenEstimate: { input: 600, output: 300 },
    ...overrides,
  }
}

function makeReadinessDispatchResult(
  verdict: 'READY' | 'NEEDS_WORK' | 'NOT_READY' = 'READY',
  blockerCount = 0,
  blockerDescriptions?: string[],
  overrides: Partial<DispatchResult<unknown>> = {},
): DispatchResult<unknown> {
  const findings: Array<{
    category: string
    severity: string
    description: string
    affected_items: string[]
  }> = []

  for (let i = 0; i < blockerCount; i++) {
    const desc = blockerDescriptions?.[i] ?? `FR-${i} is not covered by any story`
    findings.push({
      category: 'fr_coverage',
      severity: 'blocker',
      description: desc,
      affected_items: [`FR-${i}`],
    })
  }

  const coverageScore = verdict === 'READY' ? 100 : verdict === 'NEEDS_WORK' ? 65 : 25

  return {
    id: 'dispatch-readiness-001',
    status: 'completed',
    exitCode: 0,
    output: 'yaml output',
    parsed: { verdict, coverage_score: coverageScore, findings },
    parseError: null,
    durationMs: 500,
    tokenEstimate: { input: 200, output: 100 },
    ...overrides,
  }
}

function makeSequentialDispatcher(results: DispatchResult<unknown>[]): Dispatcher {
  let callIndex = 0
  const dispatch = vi.fn().mockImplementation(() => {
    const result = results[callIndex] ?? results[results.length - 1]
    callIndex++
    const handle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
      id: result.id,
      status: 'completed',
      cancel: vi.fn().mockResolvedValue(undefined),
      result: Promise.resolve(result),
    }
    return handle
  })
  return {
    dispatch,
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

const DEFAULT_READINESS_TEMPLATE =
  'Review:\nFR: {{functional_requirements}}\nNFR: {{non_functional_requirements}}\nArch: {{architecture_decisions}}\nStories: {{stories}}\n{{ux_decisions}}'

function makePack(
  archTemplate = 'Generate architecture for:\n\n{{requirements}}\n\nOutput YAML.',
  storyTemplate = 'Generate stories for:\n\n{{requirements}}\n\n{{architecture_decisions}}\n\n{{gap_analysis}}\n\nOutput YAML.',
  readinessTemplate = DEFAULT_READINESS_TEMPLATE,
): MethodologyPack {
  const getPrompt = vi.fn().mockImplementation((name: string) => {
    if (name === 'architecture') return Promise.resolve(archTemplate)
    if (name === 'story-generation') return Promise.resolve(storyTemplate)
    if (name === 'readiness-check') return Promise.resolve(readinessTemplate)
    return Promise.resolve('')
  })
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test',
      phases: [],
      prompts: { architecture: 'prompts/architecture.md', 'story-generation': 'prompts/story-generation.md' },
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt,
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function makeContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn().mockResolvedValue({ prompt: '', tokenCount: 0, sections: [], truncated: false }),
  } as unknown as ContextCompiler
}

function makeEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function makeDeps(
  adapter: DatabaseAdapter,
  dispatcher: Dispatcher,
  pack?: MethodologyPack,
  eventBus?: TypedEventBus,
): PhaseDeps {
  return {
    db: adapter,
    pack: pack ?? makePack(),
    contextCompiler: makeContextCompiler(),
    dispatcher,
    eventBus,
  }
}

// ---------------------------------------------------------------------------
// Test suite: Retry trigger conditions
// ---------------------------------------------------------------------------

describe('Retry flow: trigger conditions (AC6)', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    runId = await createTestRun(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('does NOT trigger retry when NEEDS_WORK has zero blockers (only 3 dispatches)', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 0), // no blockers → no retry
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })

  it('triggers retry when NEEDS_WORK has 1 blocker (5 dispatches total)', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1), // 1 blocker → retry
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // arch + story + readiness(NEEDS_WORK) + story(retry) + readiness(retry)
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(5)
  })

  it('triggers retry when NEEDS_WORK has multiple blockers', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 3), // 3 blockers
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(5)
  })

  it('does NOT trigger retry for NOT_READY verdict (3 dispatches, immediate fail)', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 2),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    expect(dispatcher.dispatch).toHaveBeenCalledTimes(3)
  })

  it('does NOT trigger second retry — max 1 retry enforced (5 dispatches max)', async () => {
    await seedPlanningRequirements(adapter, runId)
    // Even if retry readiness returns NEEDS_WORK again, no second retry
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1), // first check: NEEDS_WORK with blocker
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1), // retry check: still NEEDS_WORK
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // Only 5 dispatches: arch + story + readiness + story-retry + readiness-retry
    expect(dispatcher.dispatch).toHaveBeenCalledTimes(5)
  })
})

// ---------------------------------------------------------------------------
// Test suite: Gap analysis prompt construction
// ---------------------------------------------------------------------------

describe('Retry flow: gap analysis prompt construction (AC6)', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    runId = await createTestRun(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('retry story dispatch contains gap analysis section header', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    // 4th dispatch (index 3) is the retry story generation
    const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[3][0]
    expect(retryCall.prompt).toContain('Gap Analysis')
  })

  it('retry story dispatch prompt includes blocker finding description', async () => {
    await seedPlanningRequirements(adapter, runId)
    const blockerDesc = 'FR-0 (User can create tasks) is not covered by any story'
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1, [blockerDesc]),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[3][0]
    expect(retryCall.prompt).toContain(blockerDesc)
  })

  it('retry story dispatch prompt includes all blocker finding descriptions', async () => {
    await seedPlanningRequirements(adapter, runId)
    const blocker1 = 'FR-0 not covered'
    const blocker2 = 'FR-1 not covered'
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 2, [blocker1, blocker2]),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[3][0]
    expect(retryCall.prompt).toContain(blocker1)
    expect(retryCall.prompt).toContain(blocker2)
  })

  it('retry story dispatch uses taskType=story-generation', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[3][0]
    expect(retryCall.taskType).toBe('story-generation')
  })

  it('retry story dispatch uses claude-code agent', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[3][0]
    expect(retryCall.agent).toBe('claude-code')
  })

  it('retry prompt no longer contains gap_analysis placeholder (it was replaced)', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const retryCall = vi.mocked(dispatcher.dispatch).mock.calls[3][0]
    // Template placeholder should be replaced with actual gap analysis content
    expect(retryCall.prompt).not.toContain('{{gap_analysis}}')
  })
})

// ---------------------------------------------------------------------------
// Test suite: Decision store state before retry
// ---------------------------------------------------------------------------

describe('Retry flow: decision store state (AC6, AC7)', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    runId = await createTestRun(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('stores NEEDS_WORK findings in decision store before retry', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 2), // 2 blockers
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const findings = await adapter.query<{ key: string; value: string }>(
      "SELECT * FROM decisions WHERE pipeline_run_id = ? AND category = 'readiness-findings' ORDER BY key ASC",
      [runId],
    )

    // Both blocker findings should be stored
    expect(findings.length).toBeGreaterThanOrEqual(2)
    expect(findings[0].key).toBe('finding-1')
    expect(findings[1].key).toBe('finding-2')
  })

  it('stored NEEDS_WORK findings have correct severity=blocker', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    await runSolutioningPhase(deps, { runId })

    const findings = await adapter.query<{ value: string }>(
      "SELECT value FROM decisions WHERE pipeline_run_id = ? AND category = 'readiness-findings' AND key = 'finding-1'",
      [runId],
    )
    const finding = findings[0]

    expect(finding).toBeDefined()
    const parsed = JSON.parse(finding!.value) as { severity: string }
    expect(parsed.severity).toBe('blocker')
  })

  it('emits NEEDS_WORK event before retry', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const eventBus = makeEventBus()
    const deps = makeDeps(adapter, dispatcher, undefined, eventBus)

    await runSolutioningPhase(deps, { runId })

    // Should have emitted NEEDS_WORK event before retry, then READY after retry
    const emitCalls = vi.mocked(eventBus.emit).mock.calls
    const needsWorkEvents = emitCalls.filter(
      (call) =>
        call[0] === 'solutioning:readiness-check' &&
        (call[1] as { verdict: string }).verdict === 'NEEDS_WORK',
    )
    expect(needsWorkEvents.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Test suite: Retry outcomes
// ---------------------------------------------------------------------------

describe('Retry flow: retry outcomes (AC6)', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    runId = await createTestRun(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('returns success with readiness_passed=true when retry readiness returns READY', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.readiness_passed).toBe(true)
  })

  it('returns 3 artifact IDs when retry succeeds (arch + orig-story + retry-story)', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.artifact_ids).toBeDefined()
    expect(result.artifact_ids!.length).toBeGreaterThanOrEqual(3)
  })

  it('returns failure with error=readiness_check_failed when retry readiness returns NOT_READY', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 1),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('readiness_check_failed')
    expect(result.readiness_passed).toBe(false)
  })

  it('returns failure with error=readiness_check_failed when retry readiness returns NEEDS_WORK', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1), // first check: NEEDS_WORK
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1), // retry check: still NEEDS_WORK
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('readiness_check_failed')
    expect(result.readiness_passed).toBe(false)
  })

  it('details field of retry-failed result mentions the retry verdict and coverage', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NOT_READY', 1),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.details).toContain('maximum retries')
  })

  it('returns failure with error=story_generation_retry_failed when retry story dispatch fails', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(BASE_EPICS, {
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'Retry story generation agent failed',
      }),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('story_generation_retry_failed')
    expect(result.readiness_passed).toBe(false)
  })

  it('returns failure with readiness_check_error when retry readiness dispatch fails', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS),
      // Retry readiness check fails (dispatch status=failed)
      makeReadinessDispatchResult('READY', 0, [], {
        status: 'failed',
        exitCode: 1,
        parsed: null,
        parseError: 'Readiness agent failed on retry',
      }),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('failed')
    expect(result.error).toBe('readiness_check_error')
  })

  it('retry success includes epic and story counts from retry epics', async () => {
    await seedPlanningRequirements(adapter, runId)
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(),
      makeStoryDispatchResult(),
      makeReadinessDispatchResult('NEEDS_WORK', 1),
      makeStoryDispatchResult(IMPROVED_EPICS), // 1 epic, 2 stories
      makeReadinessDispatchResult('READY'),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    expect(result.epics).toBe(1)
    expect(result.stories).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Test suite: Retry token usage accumulation
// ---------------------------------------------------------------------------

describe('Retry flow: token usage accumulation', () => {
  let adapter: DatabaseAdapter
  let runId: string

  beforeEach(async () => {
    const setup = await createTestDb()
    adapter = setup.adapter
    runId = await createTestRun(adapter)
  })

  afterEach(async () => {
    await adapter.close()
  })

  it('accumulates token usage from retry story generation dispatch', async () => {
    await seedPlanningRequirements(adapter, runId)
    const retryStoryResult = makeStoryDispatchResult(IMPROVED_EPICS, {
      tokenEstimate: { input: 750, output: 350 },
    })
    const dispatcher = makeSequentialDispatcher([
      makeArchDispatchResult(), // input: 400, output: 150
      makeStoryDispatchResult(BASE_EPICS, { tokenEstimate: { input: 600, output: 300 } }),
      makeReadinessDispatchResult('NEEDS_WORK', 1, [], {
        tokenEstimate: { input: 200, output: 80 },
      }),
      retryStoryResult,
      makeReadinessDispatchResult('READY', 0, [], {
        tokenEstimate: { input: 180, output: 70 },
      }),
    ])
    const deps = makeDeps(adapter, dispatcher)

    const result = await runSolutioningPhase(deps, { runId })

    expect(result.result).toBe('success')
    // Input: 400 + 600 + 200 + 750 + 180 = 2130
    expect(result.tokenUsage.input).toBe(2130)
    // Output: 150 + 300 + 80 + 350 + 70 = 950
    expect(result.tokenUsage.output).toBe(950)
  })
})
