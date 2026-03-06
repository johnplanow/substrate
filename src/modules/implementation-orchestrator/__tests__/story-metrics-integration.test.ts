/**
 * Smoke test: orchestrator writes story-metrics decisions through real DB (Story 21-1 Gap 3).
 *
 * Unlike story-metrics-decisions.test.ts (which calls createDecision directly),
 * this test exercises the full writeStoryMetricsBestEffort path inside the orchestrator
 * by calling run() with mocked workflow runners but a real in-memory SQLite DB.
 *
 * Modules mocked: compiled-workflows (create-story, dev-story, code-review), logger
 * Modules NOT mocked: persistence/queries/decisions, persistence/queries/metrics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import BetterSqlite3 from 'better-sqlite3'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import { runMigrations } from '../../../persistence/migrations/index.js'
import { createPipelineRun, getDecisionsByCategory } from '../../../persistence/queries/decisions.js'
import { STORY_METRICS } from '../../../persistence/schemas/operational.js'

// ---------------------------------------------------------------------------
// Mock only the compiled workflow runners (NOT the persistence layer)
// ---------------------------------------------------------------------------

vi.mock('../../compiled-workflows/create-story.js', () => ({
  runCreateStory: vi.fn(),
}))
vi.mock('../../compiled-workflows/dev-story.js', () => ({
  runDevStory: vi.fn(),
}))
vi.mock('../../compiled-workflows/code-review.js', () => ({
  runCodeReview: vi.fn(),
}))
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))
vi.mock('../../compiled-workflows/index.js', () => ({
  analyzeStoryComplexity: vi.fn().mockReturnValue({ complexity: 'simple', reason: 'test' }),
  planTaskBatches: vi.fn().mockReturnValue([]),
}))
vi.mock('../../../cli/commands/health.js', () => ({
  inspectProcessTree: vi.fn().mockReturnValue({ orchestrator_pid: null, child_pids: [], zombies: [] }),
}))
vi.mock('../../agent-dispatch/dispatcher-impl.js', () => ({
  runBuildVerification: vi.fn().mockReturnValue({ status: 'passed', exitCode: 0 }),
  checkGitDiffFiles: vi.fn().mockReturnValue(['src/some-modified-file.ts']),
}))
vi.mock('node:child_process', () => ({
  execSync: vi.fn().mockReturnValue('src/some-modified-file.ts\n'),
}))

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)

// ---------------------------------------------------------------------------
// Mock factories (same pattern as orchestrator.test.ts)
// ---------------------------------------------------------------------------

function createMockPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack', version: '1.0.0', description: 'Test', phases: [],
      prompts: {}, constraints: {}, templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function createMockContextCompiler(): ContextCompiler {
  return { compile: vi.fn(), registerTemplate: vi.fn(), getTemplate: vi.fn() } as unknown as ContextCompiler
}

function createMockDispatcher(): Dispatcher {
  const mockResult: DispatchResult<unknown> = {
    id: 'mock-dispatch',
    status: 'completed',
    result: undefined,
    tokensUsed: { input: 1000, output: 500 },
    error: undefined,
    startedAt: new Date(),
    completedAt: new Date(),
  }
  return {
    dispatch: vi.fn().mockReturnValue(mockResult),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    getMemoryState: vi.fn().mockReturnValue({ isPressured: false, freeMB: 1024, thresholdMB: 256, pressureLevel: 0 }),
    shutdown: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher
}

function createMockEventBus(): TypedEventBus {
  return { emit: vi.fn(), on: vi.fn(), off: vi.fn() } as unknown as TypedEventBus
}

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

describe('Smoke: orchestrator writes story-metrics decision through real DB', () => {
  let db: BetterSqlite3Database
  let runId: string

  beforeEach(() => {
    db = new BetterSqlite3(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(db)
    const run = createPipelineRun(db, { methodology: 'bmad' })
    runId = run.id

    vi.clearAllMocks()
  })

  it('run() inserts a story-metrics decision when a story completes successfully', async () => {
    // create-story returns a valid story file path
    mockRunCreateStory.mockResolvedValue({
      result: 'success',
      story_file: 'docs/stories/1-1-test.md',
      story_key: '1-1',
      story_title: 'Test story',
    } as any)

    // dev-story succeeds
    mockRunDevStory.mockResolvedValue({
      result: 'success',
      ac_met: ['AC1'],
      ac_failures: [],
      files_modified: ['src/foo.ts'],
      tests: { total: 1, passed: 1, failed: 0 },
    } as any)

    // code-review returns SHIP_IT
    mockRunCodeReview.mockResolvedValue({
      verdict: 'SHIP_IT',
      issues: 0,
      issue_list: [],
      summary: 'Looks good',
    } as any)

    const orchestrator = createImplementationOrchestrator({
      db,
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: { maxConcurrency: 1, maxReviewCycles: 2, pipelineRunId: runId },
    })

    await orchestrator.run(['1-1'])

    // Verify a story-metrics decision was written to the real DB
    const decisions = getDecisionsByCategory(db, STORY_METRICS)
    expect(decisions.length).toBeGreaterThanOrEqual(1)

    const d = decisions.find((dec) => dec.key.startsWith('1-1:'))
    expect(d).toBeDefined()
    expect(d!.category).toBe('story-metrics')
    expect(d!.phase).toBe('implementation')
    expect(d!.pipeline_run_id).toBe(runId)

    const val = JSON.parse(d!.value)
    expect(val).toHaveProperty('wall_clock_seconds')
    expect(val).toHaveProperty('input_tokens')
    expect(val).toHaveProperty('output_tokens')
    expect(val).toHaveProperty('review_cycles')
    expect(val).toHaveProperty('stalled')
    expect(typeof val.wall_clock_seconds).toBe('number')
    expect(val.stalled).toBe(false)
  })

  it('run() inserts story-metrics decision on failure (escalation)', async () => {
    // create-story fails
    mockRunCreateStory.mockRejectedValue(new Error('Simulated create-story failure'))

    const orchestrator = createImplementationOrchestrator({
      db,
      pack: createMockPack(),
      contextCompiler: createMockContextCompiler(),
      dispatcher: createMockDispatcher(),
      eventBus: createMockEventBus(),
      config: { maxConcurrency: 1, maxReviewCycles: 2, pipelineRunId: runId },
    })

    await orchestrator.run(['2-1'])

    const decisions = getDecisionsByCategory(db, STORY_METRICS)
    const d = decisions.find((dec) => dec.key.startsWith('2-1:'))
    expect(d).toBeDefined()

    const val = JSON.parse(d!.value)
    expect(val).toHaveProperty('wall_clock_seconds')
    expect(val).toHaveProperty('review_cycles', 0)
  })
})
