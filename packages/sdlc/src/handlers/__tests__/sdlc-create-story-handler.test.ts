/**
 * Unit tests for SdlcCreateStoryHandler (story 43-3).
 *
 * Covers:
 *   AC1 – handler delegates to runCreateStory with correct params
 *   AC2 – success result mapped to SUCCESS Outcome with contextUpdates
 *   AC3 – failure result mapped to FAILURE Outcome with failureReason
 *   AC4 – telemetry events emitted before and after runCreateStory
 *   AC5 – missing storyKey or epicId returns FAILURE without calling runCreateStory
 *   AC6 – handler exported from sdlc package handlers directory
 *   AC7 – all test cases pass with mocked dependencies
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSdlcCreateStoryHandler,
  type SdlcCreateStoryHandlerOptions,
  type CreateStoryResult,
  type RunCreateStoryFn,
} from '../sdlc-create-story-handler.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { SdlcEvents } from '../../events.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal GraphNode for testing — handler does not use node properties. */
const stubNode = { id: 'test-node' }

/** Minimal Graph for testing — handler does not use graph. */
const stubGraph = {}

/** Create a mock IGraphContext from a plain object of values. */
function makeContext(values: Record<string, string | undefined>) {
  return {
    getString: vi.fn().mockImplementation((key: string, defaultValue?: string): string => {
      const val = values[key]
      if (val === undefined) return defaultValue ?? ''
      return val
    }),
    get: vi.fn().mockImplementation((key: string): unknown => values[key]),
    set: vi.fn(),
  }
}

/** Create a mock event bus. */
function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus<SdlcEvents>
}

/** Default success result from runCreateStory. */
const successResult: CreateStoryResult = {
  result: 'success',
  story_file: '/path/to/story-43-3.md',
  story_key: '43-3',
  story_title: 'SDLC Create-Story Handler',
  tokenUsage: { input: 100, output: 200 },
}

/** Default failure result from runCreateStory. */
const failureResult: CreateStoryResult = {
  result: 'failed',
  error: 'dispatch timed out',
  tokenUsage: { input: 50, output: 0 },
}

// ---------------------------------------------------------------------------
// AC1 + AC2: Success path
// ---------------------------------------------------------------------------

describe('createSdlcCreateStoryHandler — success path (AC1, AC2)', () => {
  let mockRunCreateStory: ReturnType<typeof vi.fn<RunCreateStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcCreateStoryHandlerOptions

  beforeEach(() => {
    mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockResolvedValue(successResult)
    mockEventBus = makeEventBus()
    options = {
      deps: { db: {}, pack: {}, contextCompiler: {}, dispatcher: {} },
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }
  })

  it('calls runCreateStory with correct params from context (AC1)', async () => {
    const context = makeContext({ storyKey: '43-3', epicId: '43', pipelineRunId: 'run-001' })
    const handler = createSdlcCreateStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(mockRunCreateStory).toHaveBeenCalledOnce()
    expect(mockRunCreateStory).toHaveBeenCalledWith(options.deps, {
      epicId: '43',
      storyKey: '43-3',
      pipelineRunId: 'run-001',
    })
  })

  it('passes undefined pipelineRunId when not in context (AC1)', async () => {
    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(mockRunCreateStory).toHaveBeenCalledWith(options.deps, {
      epicId: '43',
      storyKey: '43-3',
      pipelineRunId: undefined,
    })
  })

  it('returns SUCCESS outcome with contextUpdates on success (AC2)', async () => {
    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('SUCCESS')
    expect(result.contextUpdates).toEqual({
      storyFilePath: '/path/to/story-43-3.md',
      storyKey: '43-3',
      storyTitle: 'SDLC Create-Story Handler',
    })
  })

  it('does not return FAILURE on success path (AC2)', async () => {
    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).not.toBe('FAILURE')
    expect(result.failureReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC3: Failure path
// ---------------------------------------------------------------------------

describe('createSdlcCreateStoryHandler — failure path (AC3)', () => {
  let mockRunCreateStory: ReturnType<typeof vi.fn<RunCreateStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcCreateStoryHandlerOptions

  beforeEach(() => {
    mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockResolvedValue(failureResult)
    mockEventBus = makeEventBus()
    options = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }
  })

  it('returns FAILURE outcome when runCreateStory reports failed (AC3)', async () => {
    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('dispatch timed out')
  })

  it('uses details as fallback when error is absent (AC3)', async () => {
    const resultWithDetails: CreateStoryResult = {
      result: 'failed',
      details: 'schema validation failed',
      tokenUsage: { input: 0, output: 0 },
    }
    mockRunCreateStory.mockResolvedValue(resultWithDetails)

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('schema validation failed')
  })

  it('uses default message when both error and details are absent (AC3)', async () => {
    const resultNoMsg: CreateStoryResult = {
      result: 'failed',
      tokenUsage: { input: 0, output: 0 },
    }
    mockRunCreateStory.mockResolvedValue(resultNoMsg)

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('create-story workflow failed')
  })
})

// ---------------------------------------------------------------------------
// AC5: Missing required context
// ---------------------------------------------------------------------------

describe('createSdlcCreateStoryHandler — missing required context (AC5)', () => {
  let mockRunCreateStory: ReturnType<typeof vi.fn<RunCreateStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcCreateStoryHandlerOptions

  beforeEach(() => {
    mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockResolvedValue(successResult)
    mockEventBus = makeEventBus()
    options = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }
  })

  it('returns FAILURE when storyKey is missing — without calling runCreateStory (AC5)', async () => {
    const context = makeContext({ epicId: '43' }) // no storyKey
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(mockRunCreateStory).not.toHaveBeenCalled()
  })

  it('returns FAILURE when epicId is missing — without calling runCreateStory (AC5)', async () => {
    const context = makeContext({ storyKey: '43-3' }) // no epicId
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('epicId')
    expect(mockRunCreateStory).not.toHaveBeenCalled()
  })

  it('returns FAILURE when storyKey is empty string (AC5)', async () => {
    const context = makeContext({ storyKey: '', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(mockRunCreateStory).not.toHaveBeenCalled()
  })

  it('returns FAILURE when epicId is empty string (AC5)', async () => {
    const context = makeContext({ storyKey: '43-3', epicId: '' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('epicId')
    expect(mockRunCreateStory).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Thrown error: runCreateStory throws unexpectedly
// ---------------------------------------------------------------------------

describe('createSdlcCreateStoryHandler — unexpected thrown error', () => {
  it('returns FAILURE with caught message when runCreateStory throws (AC3)', async () => {
    const mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockRejectedValue(
      new Error('unexpected network failure')
    )
    const mockEventBus = makeEventBus()
    const options: SdlcCreateStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('unexpected network failure')
  })

  it('converts non-Error throws to string for failureReason', async () => {
    const mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockRejectedValue('string error')
    const mockEventBus = makeEventBus()
    const options: SdlcCreateStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('string error')
  })
})

// ---------------------------------------------------------------------------
// AC4: Telemetry events
// ---------------------------------------------------------------------------

describe('createSdlcCreateStoryHandler — telemetry (AC4)', () => {
  it('emits phase-start before and phase-complete after runCreateStory on success', async () => {
    const callOrder: string[] = []

    const mockRunCreateStory = vi
      .fn<RunCreateStoryFn>()
      .mockImplementation(async () => {
        callOrder.push('runCreateStory')
        return successResult
      })

    const mockEmit = vi.fn().mockImplementation((event: string) => {
      callOrder.push(event)
    })
    const mockEventBus = { emit: mockEmit, on: vi.fn(), off: vi.fn() } as unknown as TypedEventBus<SdlcEvents>
    const options: SdlcCreateStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    // Verify call order: phase-start → runCreateStory → phase-complete
    expect(callOrder).toEqual([
      'orchestrator:story-phase-start',
      'runCreateStory',
      'orchestrator:story-phase-complete',
    ])
  })

  it('emits phase-start with correct payload (AC4)', async () => {
    const mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCreateStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCall = emitMock.mock.calls.find(([event]) => event === 'orchestrator:story-phase-start')
    expect(phaseStartCall).toBeDefined()
    expect(phaseStartCall?.[1]).toEqual({ storyKey: '43-3', phase: 'create-story' })
  })

  it('emits phase-complete with workflow result payload (AC4)', async () => {
    const mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCreateStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(([event]) => event === 'orchestrator:story-phase-complete')
    expect(phaseCompleteCall).toBeDefined()
    expect(phaseCompleteCall?.[1]).toEqual({
      storyKey: '43-3',
      phase: 'create-story',
      result: successResult,
    })
  })

  it('emits phase-complete even when runCreateStory throws (AC4)', async () => {
    const mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockRejectedValue(
      new Error('boom')
    )
    const mockEventBus = makeEventBus()
    const options: SdlcCreateStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCalls = emitMock.mock.calls.filter(([e]) => e === 'orchestrator:story-phase-start')
    const phaseCompleteCalls = emitMock.mock.calls.filter(([e]) => e === 'orchestrator:story-phase-complete')

    expect(phaseStartCalls).toHaveLength(1)
    expect(phaseCompleteCalls).toHaveLength(1)
  })

  it('emits phase-complete even when runCreateStory returns failure (AC4)', async () => {
    const mockRunCreateStory = vi.fn<RunCreateStoryFn>().mockResolvedValue(failureResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCreateStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: mockRunCreateStory,
    }

    const context = makeContext({ storyKey: '43-3', epicId: '43' })
    const handler = createSdlcCreateStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCalls = emitMock.mock.calls.filter(([e]) => e === 'orchestrator:story-phase-complete')
    expect(phaseCompleteCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// AC6: Export from sdlc package handlers
// ---------------------------------------------------------------------------

describe('createSdlcCreateStoryHandler — export contract (AC6)', () => {
  it('is a function (factory exported correctly)', () => {
    expect(typeof createSdlcCreateStoryHandler).toBe('function')
  })

  it('returns a function (NodeHandler) when called', () => {
    const mockEventBus = makeEventBus()
    const handler = createSdlcCreateStoryHandler({
      deps: {},
      eventBus: mockEventBus,
      runCreateStory: vi.fn<RunCreateStoryFn>().mockResolvedValue(successResult),
    })
    expect(typeof handler).toBe('function')
  })
})
