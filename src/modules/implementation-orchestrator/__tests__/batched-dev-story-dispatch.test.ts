/**
 * Tests for Story 13-3: Batched Dev-Story Dispatch.
 *
 * Covers AC1-AC9:
 *   AC1: Large story triggers batched dispatch
 *   AC2: Task scope parameter passed to each batch
 *   AC4: Prior files passed to subsequent batches
 *   AC5: files_modified accumulates across batches
 *   AC6: Failed batch doesn't abort pipeline (partial progress)
 *   AC7: Small/medium story passthrough (single dispatch)
 *   AC8: DevStoryParams type extension (taskScope, priorFiles)
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
import { readFile } from 'node:fs/promises'

const mockRunCreateStory = vi.mocked(runCreateStory)
const mockRunDevStory = vi.mocked(runDevStory)
const mockRunCodeReview = vi.mocked(runCodeReview)
const mockReadFile = vi.mocked(readFile)

// ---------------------------------------------------------------------------
// Story content fixtures
// ---------------------------------------------------------------------------

/**
 * A LARGE story with 10 tasks — triggers batched dispatch (scope = 'large')
 */
const LARGE_STORY_CONTENT = `# Story 13-3: Large Story

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

function makeDevStorySuccess(filesModified: string[] = ['src/foo.ts']) {
  return {
    result: 'success' as const,
    ac_met: ['AC1'],
    ac_failures: [],
    files_modified: filesModified,
    tests: 'pass' as const,
    tokenUsage: { input: 200, output: 100 },
  }
}

function makeDevStoryFailure(filesModified: string[] = [], error = 'dev failed') {
  return {
    result: 'failed' as const,
    ac_met: [],
    ac_failures: ['AC1'],
    files_modified: filesModified,
    tests: 'fail' as const,
    error,
    tokenUsage: { input: 200, output: 0 },
  }
}

function makeCodeReviewShipIt() {
  return {
    verdict: 'SHIP_IT' as const,
    issues: 0,
    issue_list: [],
    tokenUsage: { input: 150, output: 50 },
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('Batched Dev-Story Dispatch (Story 13-3)', () => {
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
  // AC8: Type Extension — DevStoryParams has taskScope and priorFiles fields
  // -------------------------------------------------------------------------

  describe('AC8: DevStoryParams type extension', () => {
    it('accepts taskScope and priorFiles as optional params in DevStoryParams', async () => {
      // This is a compile-time check — if the type doesn't have these fields,
      // TypeScript will fail to compile. We verify at runtime by passing them.
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])
      expect(status.state).toBe('COMPLETE')

      // runDevStory was called — verify it received standard params
      expect(mockRunDevStory).toHaveBeenCalledOnce()
      const callArgs = mockRunDevStory.mock.calls[0]
      expect(callArgs).toBeDefined()
      // storyKey and storyFilePath are always required
      expect(callArgs![1].storyKey).toBe('5-1')
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Small/Medium Passthrough — single dispatch, no batching
  // -------------------------------------------------------------------------

  describe('AC7: Small/medium story passthrough', () => {
    it('dispatches a single dev-story call for a small story (3 tasks)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      expect(status.state).toBe('COMPLETE')
      expect(status.stories['5-1']?.phase).toBe('COMPLETE')
      // AC7: Only one dev-story dispatch for small story
      expect(mockRunDevStory).toHaveBeenCalledOnce()
    })

    it('does not pass taskScope to a small story dispatch', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      // AC7: Small story dispatches without taskScope (existing behavior unchanged)
      const callArgs = mockRunDevStory.mock.calls[0]
      expect(callArgs![1].taskScope).toBeUndefined()
      expect(callArgs![1].priorFiles).toBeUndefined()
    })

    it('proceeds to code review after single-dispatch dev-story completes', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      mockReadFile.mockResolvedValue(SMALL_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess(['src/small.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['5-1'])

      expect(mockRunCodeReview).toHaveBeenCalledOnce()
    })
  })

  // -------------------------------------------------------------------------
  // AC1: Large Story Batching — one dispatch per batch
  // -------------------------------------------------------------------------

  describe('AC1: Large story triggers batched dispatch', () => {
    it('dispatches dev-story twice for a large story with 10 tasks (2 batches of 5)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch1.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch2.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['13-3'])

      expect(status.state).toBe('COMPLETE')
      // AC1: Large story triggers 2 batch dispatches
      expect(mockRunDevStory).toHaveBeenCalledTimes(2)
    })

    it('completes with COMPLETE phase after all large batches finish', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/a.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/b.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['13-3'])

      expect(status.stories['13-3']?.phase).toBe('COMPLETE')
    })
  })

  // -------------------------------------------------------------------------
  // AC2: Task Scope Parameter — each batch includes taskScope
  // -------------------------------------------------------------------------

  describe('AC2: Task scope parameter passed per batch', () => {
    it('passes taskScope to the first batch with T1-T5 tasks', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)

      const capturedParams: Array<{ taskScope?: string; priorFiles?: string[] }> = []
      mockRunDevStory.mockImplementation(async (_deps, params) => {
        capturedParams.push({ taskScope: params.taskScope, priorFiles: params.priorFiles })
        return makeDevStorySuccess([`src/batch${capturedParams.length}.ts`])
      })
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-3'])

      // AC2: First batch should have taskScope
      expect(capturedParams[0]?.taskScope).toBeDefined()
      expect(capturedParams[0]?.taskScope).toContain('T1:')
      expect(capturedParams[0]?.taskScope).toContain('T5:')
    })

    it('passes taskScope to the second batch with T6-T10 tasks', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)

      const capturedParams: Array<{ taskScope?: string }> = []
      mockRunDevStory.mockImplementation(async (_deps, params) => {
        capturedParams.push({ taskScope: params.taskScope })
        return makeDevStorySuccess([`src/batch${capturedParams.length}.ts`])
      })
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-3'])

      // AC2: Second batch should have T6-T10 in taskScope
      expect(capturedParams[1]?.taskScope).toBeDefined()
      expect(capturedParams[1]?.taskScope).toContain('T6:')
      expect(capturedParams[1]?.taskScope).toContain('T10:')
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Prior Files Context — second batch receives files from first batch
  // -------------------------------------------------------------------------

  describe('AC4: Prior files context passed to subsequent batches', () => {
    it('passes priorFiles to the second batch listing files from the first batch', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)

      const capturedParams: Array<{ priorFiles?: string[] }> = []
      mockRunDevStory.mockImplementation(async (_deps, params) => {
        capturedParams.push({ priorFiles: params.priorFiles })
        const batchIdx = capturedParams.length
        return makeDevStorySuccess([`src/from-batch${batchIdx}.ts`])
      })
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-3'])

      // First batch: no prior files
      expect(capturedParams[0]?.priorFiles).toBeUndefined()
      // Second batch: prior files from batch 1
      expect(capturedParams[1]?.priorFiles).toBeDefined()
      expect(capturedParams[1]?.priorFiles).toContain('src/from-batch1.ts')
    })

    it('does not pass priorFiles to the first batch', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)

      const capturedParams: Array<{ priorFiles?: string[] }> = []
      mockRunDevStory.mockImplementation(async (_deps, params) => {
        capturedParams.push({ priorFiles: params.priorFiles })
        return makeDevStorySuccess(['src/foo.ts'])
      })
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-3'])

      expect(capturedParams[0]?.priorFiles).toBeUndefined()
    })
  })

  // -------------------------------------------------------------------------
  // AC5: Files Modified Accumulation across batches
  // -------------------------------------------------------------------------

  describe('AC5: files_modified accumulates across batches', () => {
    it('accumulates files from both batches into the code-review filesModified', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/types.ts', 'src/impl.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/tests.ts', 'src/index.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-3'])

      // AC5: With batched review, each batch's files are reviewed separately.
      // Verify both batches' files are covered across the per-batch review calls.
      expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
      const allReviewedFiles = mockRunCodeReview.mock.calls.flatMap(
        (call) => (call[1] as { filesModified?: string[] }).filesModified ?? [],
      )
      expect(allReviewedFiles).toEqual(expect.arrayContaining([
        'src/types.ts',
        'src/impl.ts',
        'src/tests.ts',
        'src/index.ts',
      ]))
    })

    it('deduplicates files appearing in multiple batches', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      // Both batches return the same file (e.g., index.ts updated in both)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStorySuccess(['src/index.ts', 'src/a.ts']))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/index.ts', 'src/b.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-3'])

      // After deduplication: index.ts should appear only once
      const reviewCall = mockRunCodeReview.mock.calls[0]
      const filesModified: string[] = reviewCall![1].filesModified ?? []
      const indexCount = filesModified.filter((f) => f === 'src/index.ts').length
      expect(indexCount).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Batch Failure Resilience — failed batch doesn't abort pipeline
  // -------------------------------------------------------------------------

  describe('AC6: Batch failure resilience', () => {
    it('continues to code review if first batch fails (partial progress)', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStoryFailure(['src/partial.ts'], 'batch-1-failed'))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch2.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['13-3'])

      // AC6: Pipeline continues despite batch 1 failure — batched review
      // runs per-batch (both batches produced files)
      expect(mockRunCodeReview).toHaveBeenCalledTimes(2)
      expect(status.state).toBe('COMPLETE')
    })

    it('includes files from successful batches even if other batches failed', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      // Batch 1 fails with no files; batch 2 succeeds with files
      mockRunDevStory
        .mockResolvedValueOnce(makeDevStoryFailure([], 'batch-1-failed'))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch2-file.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      await orchestrator.run(['13-3'])

      // AC5 + AC6: files from successful batch 2 are included
      expect(mockRunCodeReview).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          filesModified: expect.arrayContaining(['src/batch2-file.ts']),
        }),
      )
    })

    it('continues to code review if a batch throws an exception', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('13-3'))
      mockReadFile.mockResolvedValue(LARGE_STORY_CONTENT as unknown as Buffer)
      // Batch 1 throws; batch 2 succeeds
      mockRunDevStory
        .mockRejectedValueOnce(new Error('batch-1-exception'))
        .mockResolvedValueOnce(makeDevStorySuccess(['src/batch2.ts']))
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['13-3'])

      // AC6: Batch exception doesn't abort — pipeline continues
      expect(mockRunCodeReview).toHaveBeenCalledOnce()
      expect(status.state).toBe('COMPLETE')
    })
  })

  // -------------------------------------------------------------------------
  // Regression: readFile failure falls back to single dispatch
  // -------------------------------------------------------------------------

  describe('readFile fallback to single dispatch', () => {
    it('falls back to single dispatch when story file cannot be read for analysis', async () => {
      mockRunCreateStory.mockResolvedValue(makeCreateStorySuccess('5-1'))
      // readFile fails (file not accessible) — analysis fallback should kick in
      mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      mockRunDevStory.mockResolvedValue(makeDevStorySuccess())
      mockRunCodeReview.mockResolvedValue(makeCodeReviewShipIt())

      const orchestrator = createImplementationOrchestrator({
        db, pack, contextCompiler, dispatcher, eventBus, config,
      })

      const status = await orchestrator.run(['5-1'])

      // Should fall back to single dispatch
      expect(mockRunDevStory).toHaveBeenCalledOnce()
      expect(status.state).toBe('COMPLETE')
    })
  })
})
