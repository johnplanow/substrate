/**
 * Tests for Story 13-5: Decomposition Observability.
 *
 * Covers AC1-AC6:
 *   AC1: Decomposition object in run result when story is batched
 *   AC2: Per-batch metrics logged during batch dispatch loop
 *   AC3: Summary log line includes "decomposed: N batches" when batched
 *   AC4: agentVerdict logged when it differs from pipeline verdict
 *   AC5: Token usage records include batch context via metadata JSON
 *   AC6: Non-decomposed stories produce no decomposition metrics
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../../methodology-pack/types.js'
import type { ContextCompiler } from '../../context-compiler/context-compiler.js'
import type { Dispatcher, DispatchHandle, DispatchResult } from '../../agent-dispatch/types.js'
import type { TypedEventBus } from '../../../core/event-bus.js'
import type { OrchestratorConfig } from '../types.js'
import { createImplementationOrchestrator } from '../orchestrator-impl.js'

// ---------------------------------------------------------------------------
// Mock compiled workflow functions
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
vi.mock('../../../persistence/queries/decisions.js', () => ({
  updatePipelineRun: vi.fn(),
  addTokenUsage: vi.fn(),
}))
vi.mock('../../../utils/logger.js', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}))

// Mock node:fs/promises so readFile returns our controlled story content
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Import mocked modules after vi.mock() calls
// ---------------------------------------------------------------------------

import { runCreateStory } from '../../compiled-workflows/create-story.js'
import { runDevStory } from '../../compiled-workflows/dev-story.js'
import { runCodeReview } from '../../compiled-workflows/code-review.js'
import { addTokenUsage } from '../../../persistence/queries/decisions.js'
import { readFile } from 'node:fs/promises'
import { createLogger } from '../../../utils/logger.js'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockAddTokenUsage = vi.mocked(addTokenUsage)
const mockReadFile = vi.mocked(readFile)
const mockCreateLogger = vi.mocked(createLogger)

// ---------------------------------------------------------------------------
// Story content fixtures
// ---------------------------------------------------------------------------

/**
 * A LARGE story with 10 tasks — triggers batched dispatch (scope = 'large')
 */
const LARGE_STORY_CONTENT = `# Story 13-5: Large Story

Status: ready-for-dev

## Story
As a developer, I want batched dispatch.

## Acceptance Criteria
### AC1: Feature One
### AC2: Feature Two
### AC3: Feature Three

## Tasks

- [ ] T1: Implement type extension
- [ ] T2: Update dev-story module
- [ ] T3: Add prompt placeholders
- [ ] T4: Add story analysis calls
- [ ] T5: Implement batch dispatch loop
- [ ] T6: Implement batch failure handling
- [ ] T7: Write tests for large story
- [ ] T8: Write tests for small story
- [ ] T9: Write tests for file accumulation
- [ ] T10: Write tests for batch failure
`

/**
 * A SMALL story with 3 tasks — single dispatch passthrough (scope = 'small')
 */
const SMALL_STORY_CONTENT = `# Story 5-1: Small Story

Status: ready-for-dev

## Story
As a developer, I want a small feature.

## Acceptance Criteria
### AC1: Feature

## Tasks

- [ ] T1: Do task one
- [ ] T2: Do task two
- [ ] T3: Do task three
`

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockDb(): BetterSqlite3Database {
  return {} as BetterSqlite3Database
}

function createMockPack(): MethodologyPack {
  return {
    manifest: {
      name: 'test-pack',
      version: '1.0.0',
      description: 'Test pack',
      phases: [],
      prompts: {},
      constraints: {},
      templates: {},
    },
    getPhases: vi.fn().mockReturnValue([]),
    getPrompt: vi.fn().mockResolvedValue(''),
    getConstraints: vi.fn().mockResolvedValue([]),
    getTemplate: vi.fn().mockResolvedValue(''),
  }
}

function createMockContextCompiler(): ContextCompiler {
  return {
    compile: vi.fn(),
    registerTemplate: vi.fn(),
    getTemplate: vi.fn(),
  } as unknown as ContextCompiler
}

function createMockDispatcher(): Dispatcher {
  const mockResult: DispatchResult<unknown> = {
    id: 'fix-dispatch',
    status: 'completed',
    exitCode: 0,
    output: '',
    parsed: null,
    parseError: null,
    durationMs: 100,
    tokenEstimate: { input: 10, output: 5 },
  }
  const mockHandle: DispatchHandle & { result: Promise<DispatchResult<unknown>> } = {
    id: 'fix-dispatch',
    status: 'completed',
    cancel: vi.fn().mockResolvedValue(undefined),
    result: Promise.resolve(mockResult),
  }
  return {
    dispatch: vi.fn().mockReturnValue(mockHandle),
    getPending: vi.fn().mockReturnValue(0),
    getRunning: vi.fn().mockReturnValue(0),
    shutdown: vi.fn().mockResolvedValue(undefined),
  }
}

function createMockEventBus(): TypedEventBus {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  }
}

function defaultConfig(overrides?: Partial<OrchestratorConfig>): OrchestratorConfig {
  return {
    maxConcurrency: 3,
    maxReviewCycles: 2,
    pipelineRunId: 'test-run-id',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Workflow result factories
// ---------------------------------------------------------------------------

function makeCreateStorySuccess(storyKey = 'test-story', storyFile?: string) {
  return {
    result: 'success' as const,
    story_file: storyFile ?? `/path/to/${storyKey}.md`,
    story_key: storyKey,
    story_title: 'Test Story',
    tokenUsage: { input: 100, output: 50 },
  }
}

function makeDevStorySuccess(filesModified: string[] = ['src/foo.ts'], tokens = { input: 200, output: 100 }) {
  return {
    result: 'success' as const,
    ac_met: ['AC1'],
    ac_failures: [],
    files_modified: filesModified,
    tests: 'pass' as const,
    tokenUsage: tokens,
  }
}

function makeCodeReviewShipIt(agentVerdict?: 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK') {
  return {
    verdict: 'SHIP_IT' as const,
    agentVerdict,
    issues: 0,
    issue_list: [],
    tokenUsage: { input: 150, output: 50 },
  }
}

function makeCodeReviewNeedsMinorFixes(agentVerdict?: 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK') {
  return {
    verdict: 'NEEDS_MINOR_FIXES' as const,
    agentVerdict,
    issues: 1,
    issue_list: [{ severity: 'minor' as const, description: 'minor issue', file: 'src/foo.ts' }],
    tokenUsage: { input: 150, output: 50 },
  }
}

// ---------------------------------------------------------------------------
// Logger capture helper
// ---------------------------------------------------------------------------

/**
 * Capture logger.info calls on a per-test basis.
 * Returns an array of all [metadata, message] pairs logged via logger.info.
 */
function captureLoggerInfoCalls(): Array<[unknown, string]> {
  const calls: Array<[unknown, string]> = []
  mockCreateLogger.mockImplementation(() => ({
    debug: vi.fn(),
    info: vi.fn((...args: unknown[]) => {
      // logger.info(metadata, message) — capture both
      if (args.length >= 2 && typeof args[1] === 'string') {
        calls.push([args[0], args[1]])
      } else if (args.length === 1 && typeof args[0] === 'string') {
        calls.push([{}, args[0]])
      }
    }),
    warn: vi.fn(),
    error: vi.fn(),
  }))
  return calls
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Decomposition Observability (Story 13-5)', () => {
  let db: BetterSqlite3Database
  let pack: MethodologyPack
  let contextCompiler: ContextCompiler
  let dispatcher: Dispatcher
  let eventBus: TypedEventBus
  let config: OrchestratorConfig

  beforeEach(() => {
    vi.clearAllMocks()
    db = createMockDb()
    pack = createMockPack()
    contextCompiler = createMockContextCompiler()
    dispatcher = createMockDispatcher()
    eventBus = createMockEventBus()
    config = defaultConfig()
  })

  // -------------------------------------------------------------------------
  // AC1: Decomposition object in run result
  // -------------------------------------------------------------------------

  describe('AC1: Decomposition object in run result', () => {
    it('includes decomposition metrics when a large story is batched', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch1.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch2.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['13-5'])

      // AC1: decomposition object must be present
      expect(status.decomposition).toBeDefined()
      expect(status.decomposition?.totalTasks).toBe(10)
      expect(status.decomposition?.batchCount).toBe(2)
      expect(status.decomposition?.batchSizes).toEqual([5, 5])
    })

    it('decomposition.batchCount matches actual number of batches dispatched', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['13-5'])

      expect(status.decomposition?.batchCount).toBe(mockRunDevStory.mock.calls.length)
    })

    it('decomposition.totalTasks equals total task count from story analysis', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess())
        .mockResolvedValueOnce(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['13-5'])

      // LARGE_STORY_CONTENT has exactly 10 tasks
      expect(status.decomposition?.totalTasks).toBe(10)
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Per-batch metrics logged
  // -------------------------------------------------------------------------

  describe('AC2: Per-batch metrics are logged', () => {
    it('logs batch metrics info entry for each batch dispatched', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch1.ts'], { input: 200, output: 80 }))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch2.ts'], { input: 210, output: 90 }))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      // Find batch metrics log entries
      const batchMetricsLogs = logInfoCalls.filter(([, msg]) => msg === 'Batch dev-story metrics')

      // AC2: One log entry per batch (2 batches for a 10-task story)
      expect(batchMetricsLogs.length).toBe(2)
    })

    it('logged batch metrics include batchIndex, taskIds, tokensUsed, filesModified, result', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/types.ts'], { input: 300, output: 100 }))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/impl.ts'], { input: 250, output: 90 }))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      const batchMetricsLogs = logInfoCalls.filter(([, msg]) => msg === 'Batch dev-story metrics')
      const firstBatch = batchMetricsLogs[0]?.[0] as Record<string, unknown> | undefined

      expect(firstBatch).toBeDefined()
      expect(firstBatch?.batchIndex).toBe(0)
      expect(firstBatch?.taskIds).toBeDefined()
      expect(Array.isArray(firstBatch?.taskIds)).toBe(true)
      expect(firstBatch?.tokensUsed).toEqual({ input: 300, output: 100 })
      expect(firstBatch?.filesModified).toEqual(['src/types.ts'])
      expect(firstBatch?.result).toBe('success')
      expect(typeof firstBatch?.durationMs).toBe('number')
    })

    it('batch metrics result is "failed" when batch dev-story reports failure', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce({
          result: 'failed' as const,
          ac_met: [],
          ac_failures: ['AC1'],
          files_modified: [],
          tests: 'fail' as const,
          error: 'something failed',
          tokenUsage: { input: 100, output: 0 },
        })
        .mockResolvedValueOnce(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      const batchMetricsLogs = logInfoCalls.filter(([, msg]) => msg === 'Batch dev-story metrics')
      const firstBatch = batchMetricsLogs[0]?.[0] as Record<string, unknown> | undefined

      expect(firstBatch?.result).toBe('failed')
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Summary log line includes "decomposed: N batches"
  // -------------------------------------------------------------------------

  describe('AC3: Summary log line with decomposition info', () => {
    it('summary log includes "decomposed: N batches" when batching was used', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      // Find summary log entry (starts with "Code review completed:")
      const summaryLogs = logInfoCalls.filter(([, msg]) =>
        typeof msg === 'string' && msg.startsWith('Code review completed:'),
      )

      expect(summaryLogs.length).toBeGreaterThan(0)
      const summaryMsg = summaryLogs[0]?.[1] ?? ''
      expect(summaryMsg).toContain('decomposed: 2 batches')
    })

    it('summary log includes file count and token count', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts', 'src/b.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/c.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      const summaryLogs = logInfoCalls.filter(([, msg]) =>
        typeof msg === 'string' && msg.startsWith('Code review completed:'),
      )
      const summaryMsg = summaryLogs[0]?.[1] ?? ''

      // AC3: summary includes file count (3 unique files) and token info
      expect(summaryMsg).toContain('files')
      expect(summaryMsg).toContain('tokens')
    })

    it('summary log does NOT include "decomposed:" for simple (non-batched) stories', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const summaryLogs = logInfoCalls.filter(([, msg]) =>
        typeof msg === 'string' && msg.startsWith('Code review completed:'),
      )
      const summaryMsg = summaryLogs[0]?.[1] ?? ''

      // AC6 / AC3: No decomposition info for simple stories
      expect(summaryMsg).not.toContain('decomposed:')
    })
  })

  // -------------------------------------------------------------------------
  // AC4: agentVerdict logged when it differs from pipeline verdict
  // -------------------------------------------------------------------------

  describe('AC4: Agent verdict vs pipeline verdict in summary log', () => {
    it('logs both verdicts when agentVerdict differs from pipeline verdict', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      // Pipeline verdict is SHIP_IT but agent said NEEDS_MINOR_FIXES (P1 override scenario)
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt('NEEDS_MINOR_FIXES'))

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const summaryLogs = logInfoCalls.filter(([, msg]) =>
        typeof msg === 'string' && msg.startsWith('Code review completed:'),
      )
      const summaryMsg = summaryLogs[0]?.[1] ?? ''

      // AC4: Both pipeline verdict (SHIP_IT) and agent verdict (NEEDS_MINOR_FIXES) appear
      expect(summaryMsg).toContain('SHIP_IT')
      expect(summaryMsg).toContain('NEEDS_MINOR_FIXES')
      expect(summaryMsg).toContain('agent:')
    })

    it('does not include "agent:" when agentVerdict matches pipeline verdict', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      // Both verdicts are SHIP_IT — no override logged
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt('SHIP_IT'))

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const summaryLogs = logInfoCalls.filter(([, msg]) =>
        typeof msg === 'string' && msg.startsWith('Code review completed:'),
      )
      const summaryMsg = summaryLogs[0]?.[1] ?? ''

      // AC4: When verdicts match, no redundant agent annotation
      expect(summaryMsg).not.toContain('agent:')
    })

    it('does not include "agent:" when agentVerdict is undefined', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      // No agentVerdict field (old code path)
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt(undefined))

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const summaryLogs = logInfoCalls.filter(([, msg]) =>
        typeof msg === 'string' && msg.startsWith('Code review completed:'),
      )
      const summaryMsg = summaryLogs[0]?.[1] ?? ''

      expect(summaryMsg).not.toContain('agent:')
    })

    it('logs agentVerdict in summary metadata object for structured logging', async () => {
      const logInfoCalls = captureLoggerInfoCalls()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt('NEEDS_MINOR_FIXES'))

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      const summaryLogs = logInfoCalls.filter(([, msg]) =>
        typeof msg === 'string' && msg.startsWith('Code review completed:'),
      )

      // AC4: structured metadata includes agentVerdict
      const meta = summaryLogs[0]?.[0] as Record<string, unknown> | undefined
      expect(meta?.agentVerdict).toBe('NEEDS_MINOR_FIXES')
      expect(meta?.verdict).toBe('SHIP_IT')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Token usage metadata includes batch context
  // -------------------------------------------------------------------------

  describe('AC5: Token usage records include batch context metadata', () => {
    it('calls addTokenUsage for each batch with batch context in metadata', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts'], { input: 200, output: 80 }))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts'], { input: 210, output: 90 }))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      // AC5: addTokenUsage called once per batch (2 batches)
      expect(mockAddTokenUsage).toHaveBeenCalledTimes(2)
    })

    it('token usage metadata JSON contains storyKey and batchIndex', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts'], { input: 200, output: 80 }))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts'], { input: 210, output: 90 }))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      // AC5: Inspect first addTokenUsage call metadata
      const firstCall = mockAddTokenUsage.mock.calls[0]
      expect(firstCall).toBeDefined()
      const usageInput = firstCall![2]
      expect(usageInput.metadata).toBeDefined()

      const meta = JSON.parse(usageInput.metadata ?? '{}') as Record<string, unknown>
      expect(meta.storyKey).toBe('13-5')
      expect(meta.batchIndex).toBe(0)
      expect(Array.isArray(meta.taskIds)).toBe(true)
    })

    it('token usage metadata contains result field ("success" or "failed")', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts'], { input: 200, output: 80 }))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts'], { input: 210, output: 90 }))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      const firstCall = mockAddTokenUsage.mock.calls[0]
      const meta = JSON.parse(firstCall![2].metadata ?? '{}') as Record<string, unknown>
      expect(['success', 'failed']).toContain(meta.result)
    })

    it('does not call addTokenUsage for batch context on small (non-batched) stories', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // AC6: No batch-context token usage records for simple stories
      expect(mockAddTokenUsage).not.toHaveBeenCalled()
    })

    it('passes the pipelineRunId to addTokenUsage', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts'], { input: 200, output: 80 }))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts'], { input: 210, output: 90 }))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-5'])

      const firstCall = mockAddTokenUsage.mock.calls[0]
      // Second arg is the runId
      expect(firstCall![1]).toBe('test-run-id')
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Non-decomposed stories produce no decomposition metrics
  // -------------------------------------------------------------------------

  describe('AC6: Clean output for simple (non-batched) stories', () => {
    it('does not include decomposition field in status for small story', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      // AC6: decomposition must be absent for simple stories
      expect(status.decomposition).toBeUndefined()
    })

    it('completes without decomposition when readFile fails for analysis', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.state).toBe('COMPLETE')
      // readFile failure forces single dispatch — no decomposition
      expect(status.decomposition).toBeUndefined()
    })

    it('large story decomposition is present but small story decomposition is absent in same run', async () => {
      // Two orchestrators in sequence to test isolation
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const smallOrchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config: defaultConfig({ pipelineRunId: 'small-run' }),
      })

      const smallStatus = await smallOrchestrator.run(['5-1'])
      expect(smallStatus.decomposition).toBeUndefined()

      vi.clearAllMocks()

      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-5'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const largeOrchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config: defaultConfig({ pipelineRunId: 'large-run' }),
      })

      const largeStatus = await largeOrchestrator.run(['13-5'])
      expect(largeStatus.decomposition).toBeDefined()
      expect(largeStatus.decomposition?.batchCount).toBe(2)
    })
  })
})
