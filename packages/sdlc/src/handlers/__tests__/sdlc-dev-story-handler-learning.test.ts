/**
 * Unit tests for SdlcDevStoryHandler — learning loop integration (Story 53-8).
 *
 * Covers:
 *   AC1 — classifyAndPersist is called with correct StoryFailureContext on failure
 *   AC2 — FindingsInjector.inject is called before dispatch with correct InjectionContext
 *   AC4 — retireContradictedFindings is called on success with modified files
 *   AC5 — DB errors in learning calls are caught and handler still returns valid outcome
 *   AC6 — pipeline:finding-captured is emitted after successful classifyAndPersist
 */

// ---------------------------------------------------------------------------
// Mock node:fs BEFORE importing handler (readFileSync is used for story content)
// ---------------------------------------------------------------------------

vi.mock('node:fs', () => ({
  readFileSync: vi
    .fn()
    .mockReturnValue('# Story 53-8\n\n## Target files\n\nsrc/foo.ts\npackages/sdlc/src/bar.ts'),
}))

// ---------------------------------------------------------------------------
// Mock learning modules BEFORE importing handler
// ---------------------------------------------------------------------------

vi.mock('../../learning/finding-classifier.js', () => ({
  classifyAndPersist: vi.fn(),
}))

vi.mock('../../learning/findings-injector.js', () => ({
  FindingsInjector: {
    inject: vi.fn(),
  },
  extractTargetFilesFromStoryContent: vi
    .fn()
    .mockReturnValue(['src/foo.ts', 'packages/sdlc/src/bar.ts']),
}))

vi.mock('../../learning/finding-lifecycle.js', () => ({
  FindingLifecycleManager: {
    retireContradictedFindings: vi.fn(),
  },
}))

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSdlcDevStoryHandler,
  type SdlcDevStoryHandlerOptions,
  type DevStoryResult,
  type RunDevStoryFn,
} from '../sdlc-dev-story-handler.js'
import type { TypedEventBus, DatabaseAdapter } from '@substrate-ai/core'
import type { SdlcEvents } from '../../events.js'
import { classifyAndPersist } from '../../learning/finding-classifier.js'
import { FindingsInjector } from '../../learning/findings-injector.js'
import { FindingLifecycleManager } from '../../learning/finding-lifecycle.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const stubNode = { id: 'dev-story-node' }
const stubGraph = {}

function makeContext(
  stringValues: Record<string, string | undefined>,
  listValues: Record<string, string[] | undefined> = {}
) {
  return {
    getString: vi.fn().mockImplementation((key: string, defaultValue?: string): string => {
      const val = stringValues[key]
      if (val === undefined) return defaultValue ?? ''
      return val
    }),
    getList: vi.fn().mockImplementation((key: string): string[] => {
      return listValues[key] ?? []
    }),
    get: vi.fn().mockImplementation((key: string): unknown => stringValues[key]),
    set: vi.fn(),
  }
}

function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus<SdlcEvents>
}

function makeMockDb(): DatabaseAdapter {
  return {
    backendType: 'memory',
    query: vi.fn().mockResolvedValue([]),
    exec: vi.fn().mockResolvedValue(undefined),
    transaction: vi.fn(async (fn: (db: DatabaseAdapter) => Promise<unknown>) =>
      fn({
        backendType: 'memory',
        query: vi.fn().mockResolvedValue([]),
        exec: vi.fn(),
        transaction: vi.fn(),
        close: vi.fn(),
        queryReadyStories: vi.fn().mockResolvedValue([]),
      } as unknown as DatabaseAdapter)
    ),
    close: vi.fn().mockResolvedValue(undefined),
    queryReadyStories: vi.fn().mockResolvedValue([]),
  } as unknown as DatabaseAdapter
}

/** A finding returned by classifyAndPersist mock. */
const mockFinding = {
  id: '00000000-0000-0000-0000-000000000001',
  run_id: 'run-001',
  story_key: '53-8',
  root_cause: 'test-failure' as const,
  affected_files: ['src/foo.ts'],
  description: 'Tests failed after story dispatch',
  confidence: 'high' as const,
  created_at: '2026-04-06T00:00:00.000Z',
  expires_after_runs: 5,
}

const successResult: DevStoryResult = {
  result: 'success',
  ac_met: ['AC1', 'AC2'],
  ac_failures: [],
  files_modified: ['src/foo.ts', 'src/bar.ts'],
  tests: 'pass',
}

const failureResult: DevStoryResult = {
  result: 'failed',
  ac_met: [],
  ac_failures: ['AC2'],
  files_modified: ['src/foo.ts'],
  tests: 'fail',
  error: 'test assertions failed',
}

// ---------------------------------------------------------------------------
// AC1: classifyAndPersist called on failure path
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — classifyAndPersist on failure (AC1)', () => {
  let mockRunDevStory: ReturnType<typeof vi.fn<RunDevStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let mockDb: DatabaseAdapter
  let options: SdlcDevStoryHandlerOptions

  beforeEach(() => {
    vi.clearAllMocks()
    mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(failureResult)
    mockEventBus = makeEventBus()
    mockDb = makeMockDb()
    vi.mocked(classifyAndPersist).mockResolvedValue(mockFinding)
    vi.mocked(FindingsInjector.inject).mockResolvedValue('')
    options = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      db: mockDb,
    }
  })

  it('calls classifyAndPersist with correct storyKey and runId on failure (AC1)', async () => {
    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(classifyAndPersist).toHaveBeenCalledOnce()
    const [ctx, db] = vi.mocked(classifyAndPersist).mock.calls[0]!
    expect(ctx.storyKey).toBe('53-8')
    expect(ctx.runId).toBe('run-001')
    expect(db).toBe(mockDb)
  })

  it('passes affectedFiles from files_modified to classifyAndPersist (AC1)', async () => {
    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const [ctx] = vi.mocked(classifyAndPersist).mock.calls[0]!
    expect(ctx.affectedFiles).toEqual(['src/foo.ts'])
  })

  it('passes testsFailed=true when tests are fail (AC1)', async () => {
    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const [ctx] = vi.mocked(classifyAndPersist).mock.calls[0]!
    expect(ctx.testsFailed).toBe(true)
  })

  it('still returns FAILURE outcome even when classifyAndPersist throws (AC5)', async () => {
    vi.mocked(classifyAndPersist).mockRejectedValue(new Error('DB connection failed'))

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('test assertions failed')
  })

  it('does not call classifyAndPersist when db is null (AC5)', async () => {
    options = { ...options, db: null }

    const context = makeContext({ storyKey: '53-8', storyFilePath: '/stories/53-8.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(classifyAndPersist).not.toHaveBeenCalled()
  })

  it('does not call classifyAndPersist when db is omitted (AC5)', async () => {
    const { db: _db, ...optionsWithoutDb } = options
    const handler = createSdlcDevStoryHandler(optionsWithoutDb)

    const context = makeContext({ storyKey: '53-8', storyFilePath: '/stories/53-8.md' })
    await handler(stubNode, context, stubGraph)

    expect(classifyAndPersist).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC6: pipeline:finding-captured emitted after successful classifyAndPersist
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — pipeline:finding-captured event (AC6)', () => {
  let mockRunDevStory: ReturnType<typeof vi.fn<RunDevStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let mockDb: DatabaseAdapter
  let options: SdlcDevStoryHandlerOptions

  beforeEach(() => {
    vi.clearAllMocks()
    mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(failureResult)
    mockEventBus = makeEventBus()
    mockDb = makeMockDb()
    vi.mocked(classifyAndPersist).mockResolvedValue(mockFinding)
    vi.mocked(FindingsInjector.inject).mockResolvedValue('')
    options = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      db: mockDb,
    }
  })

  it('emits pipeline:finding-captured with storyKey, runId, and rootCause (AC6)', async () => {
    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const findingCapturedCall = emitMock.mock.calls.find(([e]) => e === 'pipeline:finding-captured')
    expect(findingCapturedCall).toBeDefined()
    expect(findingCapturedCall?.[1]).toEqual({
      storyKey: '53-8',
      runId: 'run-001',
      rootCause: 'test-failure',
    })
  })

  it('does not emit pipeline:finding-captured when classifyAndPersist throws (AC5, AC6)', async () => {
    vi.mocked(classifyAndPersist).mockRejectedValue(new Error('DB error'))

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const findingCapturedCalls = emitMock.mock.calls.filter(
      ([e]) => e === 'pipeline:finding-captured'
    )
    expect(findingCapturedCalls).toHaveLength(0)
  })

  it('does not emit pipeline:finding-captured on success path (AC6)', async () => {
    mockRunDevStory.mockResolvedValue(successResult)
    vi.mocked(FindingLifecycleManager.retireContradictedFindings).mockResolvedValue(undefined)

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const findingCapturedCalls = emitMock.mock.calls.filter(
      ([e]) => e === 'pipeline:finding-captured'
    )
    expect(findingCapturedCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC4: retireContradictedFindings called on success path
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — retireContradictedFindings on success (AC4)', () => {
  let mockRunDevStory: ReturnType<typeof vi.fn<RunDevStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let mockDb: DatabaseAdapter
  let options: SdlcDevStoryHandlerOptions

  beforeEach(() => {
    vi.clearAllMocks()
    mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    mockEventBus = makeEventBus()
    mockDb = makeMockDb()
    vi.mocked(FindingLifecycleManager.retireContradictedFindings).mockResolvedValue(undefined)
    vi.mocked(FindingsInjector.inject).mockResolvedValue('')
    options = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      db: mockDb,
    }
  })

  it('calls retireContradictedFindings with modifiedFiles and runId on success (AC4)', async () => {
    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(FindingLifecycleManager.retireContradictedFindings).toHaveBeenCalledOnce()
    const [successCtx, db] = vi.mocked(FindingLifecycleManager.retireContradictedFindings).mock
      .calls[0]!
    expect(successCtx.modifiedFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
    expect(successCtx.runId).toBe('run-001')
    expect(db).toBe(mockDb)
  })

  it('still returns SUCCESS even when retireContradictedFindings throws (AC5)', async () => {
    vi.mocked(FindingLifecycleManager.retireContradictedFindings).mockRejectedValue(
      new Error('DB write failed')
    )

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('SUCCESS')
  })

  it('does not call retireContradictedFindings when db is null (AC5)', async () => {
    options = { ...options, db: null }

    const context = makeContext({ storyKey: '53-8', storyFilePath: '/stories/53-8.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(FindingLifecycleManager.retireContradictedFindings).not.toHaveBeenCalled()
  })

  it('does not call retireContradictedFindings on failure path (AC4)', async () => {
    mockRunDevStory.mockResolvedValue(failureResult)
    vi.mocked(classifyAndPersist).mockResolvedValue(mockFinding)

    const context = makeContext({ storyKey: '53-8', storyFilePath: '/stories/53-8.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(FindingLifecycleManager.retireContradictedFindings).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC2: FindingsInjector.inject called before dispatch
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — FindingsInjector.inject pre-dispatch (AC2)', () => {
  let mockRunDevStory: ReturnType<typeof vi.fn<RunDevStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let mockDb: DatabaseAdapter
  let options: SdlcDevStoryHandlerOptions

  beforeEach(() => {
    vi.clearAllMocks()
    mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    mockEventBus = makeEventBus()
    mockDb = makeMockDb()
    vi.mocked(FindingsInjector.inject).mockResolvedValue('')
    vi.mocked(FindingLifecycleManager.retireContradictedFindings).mockResolvedValue(undefined)
    options = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      db: mockDb,
    }
  })

  it('calls FindingsInjector.inject with correct runId before dispatch (AC2)', async () => {
    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-abc',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(FindingsInjector.inject).toHaveBeenCalledOnce()
    const [db, injCtx] = vi.mocked(FindingsInjector.inject).mock.calls[0]!
    expect(db).toBe(mockDb)
    expect(injCtx.storyKey).toBe('53-8')
    expect(injCtx.runId).toBe('run-abc')
  })

  it('FindingsInjector.inject is called before runDevStory (AC2)', async () => {
    const callOrder: string[] = []
    vi.mocked(FindingsInjector.inject).mockImplementation(async () => {
      callOrder.push('inject')
      return ''
    })
    mockRunDevStory.mockImplementation(async () => {
      callOrder.push('runDevStory')
      return successResult
    })

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(callOrder[0]).toBe('inject')
    expect(callOrder[1]).toBe('runDevStory')
  })

  it('prepends non-empty findingsPrompt to devStoryParams (AC2)', async () => {
    vi.mocked(FindingsInjector.inject).mockResolvedValue(
      'Prior run findings (most relevant first):\n\n[build-failure] Directive: Build failed after story dispatch'
    )

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunDevStory.mock.calls[0]?.[1]
    expect(callArgs?.findingsPrompt).toContain('[build-failure]')
  })

  it('omits findingsPrompt when inject returns empty string (AC2)', async () => {
    vi.mocked(FindingsInjector.inject).mockResolvedValue('')

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunDevStory.mock.calls[0]?.[1]
    expect('findingsPrompt' in (callArgs ?? {})).toBe(false)
  })

  it('still dispatches when FindingsInjector.inject throws (AC5)', async () => {
    vi.mocked(FindingsInjector.inject).mockRejectedValue(new Error('DB error'))

    const context = makeContext({
      storyKey: '53-8',
      storyFilePath: '/stories/53-8.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(mockRunDevStory).toHaveBeenCalledOnce()
    expect(result.status).toBe('SUCCESS')
  })

  it('does not call FindingsInjector.inject when db is null (AC5)', async () => {
    options = { ...options, db: null }

    const context = makeContext({ storyKey: '53-8', storyFilePath: '/stories/53-8.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(FindingsInjector.inject).not.toHaveBeenCalled()
  })
})
