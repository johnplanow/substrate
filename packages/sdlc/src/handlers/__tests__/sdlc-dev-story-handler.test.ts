/**
 * Unit tests for SdlcDevStoryHandler (story 43-4).
 *
 * Covers:
 *   AC1 – handler delegates to runDevStory with correct params
 *   AC2 – success result mapped to SUCCESS Outcome with contextUpdates (filesModified, acMet)
 *   AC3 – failure result mapped to FAILURE Outcome with acFailures and filesModified in contextUpdates
 *   AC4 – retry remediation context passed through to runDevStory via priorFiles and taskScope
 *   AC5 – telemetry events emitted before and after runDevStory (in correct order)
 *   AC6 – missing storyKey or storyFilePath returns FAILURE without calling runDevStory
 *   AC7 – handler exported from sdlc package handlers directory
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSdlcDevStoryHandler,
  type SdlcDevStoryHandlerOptions,
  type DevStoryResult,
  type RunDevStoryFn,
} from '../sdlc-dev-story-handler.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { SdlcEvents } from '../../events.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal GraphNode for testing — handler does not use node properties. */
const stubNode = { id: 'dev-story-node' }

/** Minimal Graph for testing — handler does not use graph. */
const stubGraph = {}

/** Create a mock IGraphContext from plain objects for string and list values. */
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

/** Create a mock event bus. */
function makeEventBus() {
  return {
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
  } as unknown as TypedEventBus<SdlcEvents>
}

/** Default success result from runDevStory. */
const successResult: DevStoryResult = {
  result: 'success',
  ac_met: ['AC1', 'AC2', 'AC3'],
  ac_failures: [],
  files_modified: ['/path/to/foo.ts', '/path/to/bar.ts'],
  tests: 'pass',
}

/** Default failure result from runDevStory. */
const failureResult: DevStoryResult = {
  result: 'failed',
  ac_met: ['AC1'],
  ac_failures: ['AC2', 'AC3'],
  files_modified: ['/path/to/foo.ts'],
  tests: 'fail',
  error: 'AC2 test assertions failed',
}

// ---------------------------------------------------------------------------
// AC1 + AC2: Success path
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — success path (AC1, AC2)', () => {
  let mockRunDevStory: ReturnType<typeof vi.fn<RunDevStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcDevStoryHandlerOptions

  beforeEach(() => {
    mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    mockEventBus = makeEventBus()
    options = {
      deps: { db: {}, pack: {}, contextCompiler: {}, dispatcher: {} },
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }
  })

  it('calls runDevStory with correct required params from context (AC1)', async () => {
    const context = makeContext({
      storyKey: '43-4',
      storyFilePath: '/stories/43-4.md',
      pipelineRunId: 'run-001',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(mockRunDevStory).toHaveBeenCalledOnce()
    expect(mockRunDevStory).toHaveBeenCalledWith(
      options.deps,
      expect.objectContaining({
        storyKey: '43-4',
        storyFilePath: '/stories/43-4.md',
        pipelineRunId: 'run-001',
      })
    )
  })

  it('omits pipelineRunId from params when not in context (AC1)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunDevStory.mock.calls[0]?.[1]
    expect(callArgs).toBeDefined()
    expect('pipelineRunId' in (callArgs ?? {})).toBe(false)
  })

  it('returns SUCCESS outcome with filesModified and acMet in contextUpdates (AC2)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('SUCCESS')
    expect(result.contextUpdates?.filesModified).toEqual(['/path/to/foo.ts', '/path/to/bar.ts'])
    expect(result.contextUpdates?.acMet).toEqual(['AC1', 'AC2', 'AC3'])
  })

  it('persists devStoryFilesModified in contextUpdates for retry pass-through (AC2, AC4)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates?.devStoryFilesModified).toEqual([
      '/path/to/foo.ts',
      '/path/to/bar.ts',
    ])
  })

  it('does not return FAILURE on success path (AC2)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).not.toBe('FAILURE')
    expect(result.failureReason).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC3: Failure path
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — failure path (AC3)', () => {
  let mockRunDevStory: ReturnType<typeof vi.fn<RunDevStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcDevStoryHandlerOptions

  beforeEach(() => {
    mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(failureResult)
    mockEventBus = makeEventBus()
    options = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }
  })

  it('returns FAILURE outcome when runDevStory reports failed (AC3)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('AC2 test assertions failed')
  })

  it('includes acFailures in contextUpdates on failure (AC3)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates?.acFailures).toEqual(['AC2', 'AC3'])
  })

  it('includes filesModified in contextUpdates on failure (AC3)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates?.filesModified).toEqual(['/path/to/foo.ts'])
  })

  it('persists devStoryAcFailures and devStoryFilesModified for retry pass-through (AC3, AC4)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates?.devStoryAcFailures).toEqual(['AC2', 'AC3'])
    expect(result.contextUpdates?.devStoryFilesModified).toEqual(['/path/to/foo.ts'])
  })

  it('uses ac_failures to build failureReason when error field is absent (AC3)', async () => {
    const resultNoError: DevStoryResult = {
      result: 'failed',
      ac_met: [],
      ac_failures: ['AC2'],
      files_modified: [],
      tests: 'fail',
    }
    mockRunDevStory.mockResolvedValue(resultNoError)

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('AC2')
  })

  it('uses default failureReason when error and ac_failures are both absent (AC3)', async () => {
    const resultEmpty: DevStoryResult = {
      result: 'failed',
      ac_met: [],
      ac_failures: [],
      files_modified: [],
      tests: 'fail',
    }
    mockRunDevStory.mockResolvedValue(resultEmpty)

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('dev-story workflow failed')
  })
})

// ---------------------------------------------------------------------------
// AC4: Retry remediation context pass-through
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — retry remediation context (AC4)', () => {
  it('passes prior devStoryFilesModified as priorFiles to runDevStory (AC4)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext(
      { storyKey: '43-4', storyFilePath: '/stories/43-4.md' },
      { devStoryFilesModified: ['/path/to/foo.ts', '/path/to/bar.ts'] }
    )
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunDevStory.mock.calls[0]?.[1]
    expect(callArgs?.priorFiles).toEqual(['/path/to/foo.ts', '/path/to/bar.ts'])
  })

  it('constructs taskScope note from prior devStoryAcFailures (AC4)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext(
      { storyKey: '43-4', storyFilePath: '/stories/43-4.md' },
      { devStoryAcFailures: ['AC2', 'AC3'] }
    )
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunDevStory.mock.calls[0]?.[1]
    expect(callArgs?.taskScope).toBe('Prior attempt failed ACs: AC2, AC3')
  })

  it('omits priorFiles and taskScope when no prior context exists (AC4)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunDevStory.mock.calls[0]?.[1]
    expect('priorFiles' in (callArgs ?? {})).toBe(false)
    expect('taskScope' in (callArgs ?? {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC6: Missing required context fields
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — missing required context (AC6)', () => {
  let mockRunDevStory: ReturnType<typeof vi.fn<RunDevStoryFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcDevStoryHandlerOptions

  beforeEach(() => {
    mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    mockEventBus = makeEventBus()
    options = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }
  })

  it('returns FAILURE when storyKey is missing — without calling runDevStory (AC6)', async () => {
    const context = makeContext({ storyFilePath: '/stories/43-4.md' }) // no storyKey
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(mockRunDevStory).not.toHaveBeenCalled()
  })

  it('returns FAILURE when storyFilePath is missing — without calling runDevStory (AC6)', async () => {
    const context = makeContext({ storyKey: '43-4' }) // no storyFilePath
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyFilePath')
    expect(mockRunDevStory).not.toHaveBeenCalled()
  })

  it('returns FAILURE when storyKey is empty string (AC6)', async () => {
    const context = makeContext({ storyKey: '', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(mockRunDevStory).not.toHaveBeenCalled()
  })

  it('returns FAILURE when storyFilePath is empty string (AC6)', async () => {
    const context = makeContext({ storyKey: '43-4', storyFilePath: '' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyFilePath')
    expect(mockRunDevStory).not.toHaveBeenCalled()
  })

  it('mentions both storyKey and storyFilePath when both are missing (AC6)', async () => {
    const context = makeContext({}) // neither storyKey nor storyFilePath
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(result.failureReason).toContain('storyFilePath')
    expect(mockRunDevStory).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Unexpected thrown error
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — unexpected thrown error', () => {
  it('returns FAILURE with caught error message when runDevStory throws (AC3)', async () => {
    const mockRunDevStory = vi
      .fn<RunDevStoryFn>()
      .mockRejectedValue(new Error('unexpected network failure'))
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('unexpected network failure')
  })

  it('converts non-Error throws to string for failureReason', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockRejectedValue('string error')
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('string error')
  })
})

// ---------------------------------------------------------------------------
// AC5: Telemetry events
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — telemetry (AC5)', () => {
  it('emits phase-start before and phase-complete after runDevStory on success (AC5)', async () => {
    const callOrder: string[] = []

    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockImplementation(async () => {
      callOrder.push('runDevStory')
      return successResult
    })

    const mockEmit = vi.fn().mockImplementation((event: string) => {
      callOrder.push(event)
    })
    const mockEventBus = {
      emit: mockEmit,
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TypedEventBus<SdlcEvents>

    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    // Verify call order: phase-start → runDevStory → phase-complete
    expect(callOrder).toEqual([
      'orchestrator:story-phase-start',
      'runDevStory',
      'orchestrator:story-phase-complete',
    ])
  })

  it('emits phase-start with correct payload (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCall = emitMock.mock.calls.find(
      ([event]) => event === 'orchestrator:story-phase-start'
    )
    expect(phaseStartCall).toBeDefined()
    expect(phaseStartCall?.[1]).toEqual({ storyKey: '43-4', phase: 'dev-story' })
  })

  it('emits phase-complete with storyKey, phase, and status in result payload (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(
      ([event]) => event === 'orchestrator:story-phase-complete'
    )
    expect(phaseCompleteCall).toBeDefined()
    expect(phaseCompleteCall?.[1]).toMatchObject({
      storyKey: '43-4',
      phase: 'dev-story',
      result: { status: 'SUCCESS' },
    })
  })

  it('emits orchestrator:story-phase-complete even when runDevStory throws (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockRejectedValue(new Error('boom'))
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCalls = emitMock.mock.calls.filter(
      ([e]) => e === 'orchestrator:story-phase-start'
    )
    const phaseCompleteCalls = emitMock.mock.calls.filter(
      ([e]) => e === 'orchestrator:story-phase-complete'
    )

    expect(phaseStartCalls).toHaveLength(1)
    expect(phaseCompleteCalls).toHaveLength(1)
  })

  it('emits phase-complete with FAILURE status when runDevStory throws (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockRejectedValue(new Error('boom'))
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(
      ([e]) => e === 'orchestrator:story-phase-complete'
    )
    expect(phaseCompleteCall?.[1]).toMatchObject({ result: { status: 'FAILURE' } })
  })

  it('emits phase-complete even when runDevStory returns failure (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(failureResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCalls = emitMock.mock.calls.filter(
      ([e]) => e === 'orchestrator:story-phase-complete'
    )
    expect(phaseCompleteCalls).toHaveLength(1)
  })

  it('includes pipelineRunId in phase-start payload when present in context (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({
      storyKey: '43-4',
      storyFilePath: '/stories/43-4.md',
      pipelineRunId: 'run-abc',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCall = emitMock.mock.calls.find(([e]) => e === 'orchestrator:story-phase-start')
    expect(phaseStartCall?.[1]).toMatchObject({
      storyKey: '43-4',
      phase: 'dev-story',
      pipelineRunId: 'run-abc',
    })
  })

  it('includes pipelineRunId in phase-complete payload when present in context (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({
      storyKey: '43-4',
      storyFilePath: '/stories/43-4.md',
      pipelineRunId: 'run-abc',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(
      ([e]) => e === 'orchestrator:story-phase-complete'
    )
    expect(phaseCompleteCall?.[1]).toMatchObject({
      storyKey: '43-4',
      phase: 'dev-story',
      pipelineRunId: 'run-abc',
    })
  })

  it('omits pipelineRunId from phase-start and phase-complete payloads when not in context (AC5)', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
    }

    const context = makeContext({ storyKey: '43-4', storyFilePath: '/stories/43-4.md' })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCall = emitMock.mock.calls.find(([e]) => e === 'orchestrator:story-phase-start')
    const phaseCompleteCall = emitMock.mock.calls.find(
      ([e]) => e === 'orchestrator:story-phase-complete'
    )
    expect('pipelineRunId' in (phaseStartCall?.[1] ?? {})).toBe(false)
    expect('pipelineRunId' in (phaseCompleteCall?.[1] ?? {})).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Build verification gate
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — build verification gate', () => {
  it('returns FAILURE when buildVerifier reports failed after successful dev-story', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockBuildVerifier = vi
      .fn()
      .mockReturnValue({ status: 'failed', output: 'tsc error: missing export' })
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      buildVerifier: mockBuildVerifier,
    }

    const context = makeContext({
      storyKey: '43-4',
      storyFilePath: '/stories/43-4.md',
      projectRoot: '/test',
    })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('build verification failed')
    expect(mockBuildVerifier).toHaveBeenCalledWith('/test')
  })

  it('returns SUCCESS when buildVerifier passes', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockBuildVerifier = vi.fn().mockReturnValue({ status: 'passed' })
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      buildVerifier: mockBuildVerifier,
    }

    const context = makeContext({
      storyKey: '43-4',
      storyFilePath: '/stories/43-4.md',
      projectRoot: '/test',
    })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('SUCCESS')
  })

  it('skips build verification when buildVerifier is not provided', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      // no buildVerifier
    }

    const context = makeContext({
      storyKey: '43-4',
      storyFilePath: '/stories/43-4.md',
      projectRoot: '/test',
    })
    const handler = createSdlcDevStoryHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('SUCCESS')
  })

  it('emits phase-complete even when build verification fails', async () => {
    const mockRunDevStory = vi.fn<RunDevStoryFn>().mockResolvedValue(successResult)
    const mockBuildVerifier = vi.fn().mockReturnValue({ status: 'failed', output: 'err' })
    const mockEventBus = makeEventBus()
    const options: SdlcDevStoryHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runDevStory: mockRunDevStory,
      buildVerifier: mockBuildVerifier,
    }

    const context = makeContext({
      storyKey: '43-4',
      storyFilePath: '/stories/43-4.md',
      projectRoot: '/test',
    })
    const handler = createSdlcDevStoryHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCalls = emitMock.mock.calls.filter(
      ([e]) => e === 'orchestrator:story-phase-complete'
    )
    expect(phaseCompleteCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// AC7: Export from sdlc package handlers
// ---------------------------------------------------------------------------

describe('createSdlcDevStoryHandler — export contract (AC7)', () => {
  it('is a function (factory exported correctly)', () => {
    expect(typeof createSdlcDevStoryHandler).toBe('function')
  })

  it('returns a function (NodeHandler) when called', () => {
    const mockEventBus = makeEventBus()
    const handler = createSdlcDevStoryHandler({
      deps: {},
      eventBus: mockEventBus,
      runDevStory: vi.fn<RunDevStoryFn>().mockResolvedValue(successResult),
    })
    expect(typeof handler).toBe('function')
  })
})
