/**
 * Unit tests for SdlcCodeReviewHandler (story 43-5).
 *
 * Covers:
 *   AC1 – SHIP_IT / LGTM_WITH_NOTES verdicts map to SUCCESS with preferredLabel: 'SHIP_IT'
 *   AC2 – NEEDS_MINOR_FIXES / NEEDS_MAJOR_REWORK verdicts map to FAILURE with preferredLabel: 'NEEDS_FIXES'
 *   AC3 – dispatchFailed: true maps to escalation FAILURE with no contextUpdates
 *   AC4 – missing storyKey or storyFilePath returns FAILURE without calling runCodeReview
 *   AC5 – optional context fields (filesModified, pipelineRunId, codeReviewIssueList) forwarded correctly
 *   AC6 – telemetry events emitted before and after runCodeReview (in correct order)
 *   AC7 – handler exported from sdlc package handlers directory
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createSdlcCodeReviewHandler,
  type SdlcCodeReviewHandlerOptions,
  type CodeReviewResult,
  type CodeReviewIssue,
  type RunCodeReviewFn,
} from '../sdlc-code-review-handler.js'
import type { TypedEventBus } from '@substrate-ai/core'
import type { SdlcEvents } from '../../events.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Minimal GraphNode for testing — handler does not use node properties. */
const stubNode = { id: 'code-review-node' }

/** Minimal Graph for testing — handler does not use graph. */
const stubGraph = {}

/**
 * Create a mock IGraphContext from plain objects for string, list, and complex values.
 */
function makeContext(
  stringValues: Record<string, string | undefined> = {},
  listValues: Record<string, string[] | undefined> = {},
  objectValues: Record<string, unknown> = {},
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
    get: vi.fn().mockImplementation((key: string): unknown => {
      // Check objectValues first (for complex types), fall back to stringValues
      if (key in objectValues) return objectValues[key]
      return stringValues[key]
    }),
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

/** Sample issue list for testing. */
const sampleIssues: CodeReviewIssue[] = [
  { severity: 'minor', description: 'Missing JSDoc', file: 'foo.ts', line: 10 },
  { severity: 'major', description: 'Unused import', file: 'bar.ts' },
]

/** Default SHIP_IT result from runCodeReview. */
const shipItResult: CodeReviewResult = {
  verdict: 'SHIP_IT',
  issues: 0,
  issue_list: [],
  tokenUsage: { input: 100, output: 50 },
}

/** Default LGTM_WITH_NOTES result from runCodeReview. */
const lgtmWithNotesResult: CodeReviewResult = {
  verdict: 'LGTM_WITH_NOTES',
  issues: 1,
  issue_list: [{ severity: 'minor', description: 'Consider renaming test' }],
  tokenUsage: { input: 100, output: 60 },
}

/** NEEDS_MINOR_FIXES result from runCodeReview. */
const needsMinorFixesResult: CodeReviewResult = {
  verdict: 'NEEDS_MINOR_FIXES',
  issues: 2,
  issue_list: sampleIssues,
  tokenUsage: { input: 100, output: 80 },
}

/** NEEDS_MAJOR_REWORK result from runCodeReview. */
const needsMajorReworkResult: CodeReviewResult = {
  verdict: 'NEEDS_MAJOR_REWORK',
  issues: 3,
  issue_list: [
    ...sampleIssues,
    { severity: 'blocker', description: 'Critical bug', file: 'core.ts', line: 42 },
  ],
  tokenUsage: { input: 100, output: 90 },
}

/** dispatchFailed result from runCodeReview. */
const dispatchFailedResult: CodeReviewResult = {
  verdict: 'SHIP_IT', // verdict is irrelevant when dispatchFailed is true
  issues: 0,
  issue_list: [],
  dispatchFailed: true,
  error: 'agent crash: exit code 1',
  tokenUsage: { input: 0, output: 0 },
}

// ---------------------------------------------------------------------------
// AC1: SHIP_IT and LGTM_WITH_NOTES verdicts → SUCCESS
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — SHIP_IT verdict (AC1)', () => {
  let mockRunCodeReview: ReturnType<typeof vi.fn<RunCodeReviewFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcCodeReviewHandlerOptions

  beforeEach(() => {
    mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    mockEventBus = makeEventBus()
    options = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }
  })

  it('returns SUCCESS with preferredLabel SHIP_IT for SHIP_IT verdict (AC1)', async () => {
    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('SUCCESS')
    expect(result.preferredLabel).toBe('SHIP_IT')
  })

  it('includes correct contextUpdates on SHIP_IT (AC1)', async () => {
    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates?.codeReviewVerdict).toBe('SHIP_IT')
    expect(result.contextUpdates?.codeReviewIssues).toBe(0)
    expect(result.contextUpdates?.codeReviewIssueList).toEqual([])
  })

  it('does not include failureReason on SHIP_IT success (AC1)', async () => {
    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.failureReason).toBeUndefined()
  })
})

describe('createSdlcCodeReviewHandler — LGTM_WITH_NOTES verdict (AC1)', () => {
  it('returns SUCCESS with preferredLabel SHIP_IT for LGTM_WITH_NOTES verdict (AC1)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(lgtmWithNotesResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('SUCCESS')
    expect(result.preferredLabel).toBe('SHIP_IT')
  })

  it('includes correct contextUpdates for LGTM_WITH_NOTES (AC1)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(lgtmWithNotesResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates?.codeReviewVerdict).toBe('LGTM_WITH_NOTES')
    expect(result.contextUpdates?.codeReviewIssues).toBe(1)
    expect(result.contextUpdates?.codeReviewIssueList).toEqual(lgtmWithNotesResult.issue_list)
  })
})

// ---------------------------------------------------------------------------
// AC2: NEEDS_MINOR_FIXES and NEEDS_MAJOR_REWORK → FAILURE with NEEDS_FIXES label
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — NEEDS_MINOR_FIXES verdict (AC2)', () => {
  let mockRunCodeReview: ReturnType<typeof vi.fn<RunCodeReviewFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcCodeReviewHandlerOptions

  beforeEach(() => {
    mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(needsMinorFixesResult)
    mockEventBus = makeEventBus()
    options = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }
  })

  it('returns FAILURE with preferredLabel NEEDS_FIXES for NEEDS_MINOR_FIXES (AC2)', async () => {
    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.preferredLabel).toBe('NEEDS_FIXES')
  })

  it('failureReason contains verdict and issue count for NEEDS_MINOR_FIXES (AC2)', async () => {
    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.failureReason).toBe('NEEDS_MINOR_FIXES: 2 issue(s)')
  })

  it('includes correct contextUpdates for NEEDS_MINOR_FIXES (AC2)', async () => {
    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates?.codeReviewVerdict).toBe('NEEDS_MINOR_FIXES')
    expect(result.contextUpdates?.codeReviewIssues).toBe(2)
    expect(result.contextUpdates?.codeReviewIssueList).toEqual(sampleIssues)
  })
})

describe('createSdlcCodeReviewHandler — NEEDS_MAJOR_REWORK verdict (AC2)', () => {
  it('returns FAILURE with preferredLabel NEEDS_FIXES for NEEDS_MAJOR_REWORK (AC2)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(needsMajorReworkResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.preferredLabel).toBe('NEEDS_FIXES')
  })

  it('failureReason contains verdict and issue count for NEEDS_MAJOR_REWORK (AC2)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(needsMajorReworkResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.failureReason).toBe('NEEDS_MAJOR_REWORK: 3 issue(s)')
  })
})

// ---------------------------------------------------------------------------
// AC3: dispatchFailed: true → escalation FAILURE, no contextUpdates
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — dispatch failure (AC3)', () => {
  it('returns FAILURE with escalation failureReason when dispatchFailed is true (AC3)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(dispatchFailedResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toMatch(/^escalation:/)
    expect(result.failureReason).toContain('code-review dispatch failed')
    expect(result.failureReason).toContain('agent crash: exit code 1')
  })

  it('does not write contextUpdates when dispatchFailed is true (AC3)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(dispatchFailedResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates).toBeUndefined()
  })

  it('includes unknown error fallback when dispatchFailed is true with no error field (AC3)', async () => {
    // Omit `error` rather than setting it to `undefined` (exactOptionalPropertyTypes=true)
    const { error: _omitted, ...rest } = dispatchFailedResult
    const resultNoError: CodeReviewResult = rest
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(resultNoError)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.failureReason).toContain('unknown error')
  })
})

// ---------------------------------------------------------------------------
// AC4: Missing required context fields
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — missing required context (AC4)', () => {
  let mockRunCodeReview: ReturnType<typeof vi.fn<RunCodeReviewFn>>
  let mockEventBus: TypedEventBus<SdlcEvents>
  let options: SdlcCodeReviewHandlerOptions

  beforeEach(() => {
    mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    mockEventBus = makeEventBus()
    options = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }
  })

  it('returns FAILURE when storyKey is missing — without calling runCodeReview (AC4)', async () => {
    const context = makeContext({ storyFilePath: '/stories/43-5.md' }) // no storyKey
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('returns FAILURE when storyFilePath is missing — without calling runCodeReview (AC4)', async () => {
    const context = makeContext({ storyKey: '43-5' }) // no storyFilePath
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyFilePath')
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('returns FAILURE when storyKey is empty string — without calling runCodeReview (AC4)', async () => {
    const context = makeContext({ storyKey: '', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('returns FAILURE when storyFilePath is empty string — without calling runCodeReview (AC4)', async () => {
    const context = makeContext({ storyKey: '43-5', storyFilePath: '' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyFilePath')
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })

  it('mentions both storyKey and storyFilePath when both are missing (AC4)', async () => {
    const context = makeContext({}) // neither storyKey nor storyFilePath
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toContain('storyKey')
    expect(result.failureReason).toContain('storyFilePath')
    expect(mockRunCodeReview).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC5: Optional context pass-through
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — optional context pass-through (AC5)', () => {
  it('forwards filesModified as params.filesModified (AC5)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext(
      { storyKey: '43-5', storyFilePath: '/stories/43-5.md' },
      { filesModified: ['/src/foo.ts', '/src/bar.ts'] },
    )
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunCodeReview.mock.calls[0]?.[1]
    expect(callArgs?.filesModified).toEqual(['/src/foo.ts', '/src/bar.ts'])
  })

  it('forwards pipelineRunId as params.pipelineRunId (AC5)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({
      storyKey: '43-5',
      storyFilePath: '/stories/43-5.md',
      pipelineRunId: 'run-abc-123',
    })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunCodeReview.mock.calls[0]?.[1]
    expect(callArgs?.pipelineRunId).toBe('run-abc-123')
  })

  it('omits pipelineRunId from params when not in context (AC5)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunCodeReview.mock.calls[0]?.[1]
    expect('pipelineRunId' in (callArgs ?? {})).toBe(false)
  })

  it('forwards codeReviewIssueList from context as params.previousIssues (AC5)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const priorIssues: CodeReviewIssue[] = [
      { severity: 'minor', description: 'old issue', file: 'old.ts' },
    ]
    const context = makeContext(
      { storyKey: '43-5', storyFilePath: '/stories/43-5.md' },
      {},
      { codeReviewIssueList: priorIssues },
    )
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunCodeReview.mock.calls[0]?.[1]
    expect(callArgs?.previousIssues).toEqual(priorIssues)
  })

  it('omits filesModified and previousIssues from params when context values are empty (AC5)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const callArgs = mockRunCodeReview.mock.calls[0]?.[1]
    expect('filesModified' in (callArgs ?? {})).toBe(false)
    expect('previousIssues' in (callArgs ?? {})).toBe(false)
  })

  it('calls runCodeReview with deps from options (AC5)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const fakeDeps = { db: {}, pack: {}, dispatcher: {} }
    const options: SdlcCodeReviewHandlerOptions = {
      deps: fakeDeps,
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    expect(mockRunCodeReview).toHaveBeenCalledWith(fakeDeps, expect.objectContaining({ storyKey: '43-5' }))
  })
})

// ---------------------------------------------------------------------------
// AC6: Telemetry events
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — telemetry (AC6)', () => {
  it('emits phase-start before and phase-complete after runCodeReview on success (AC6)', async () => {
    const callOrder: string[] = []

    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockImplementation(async () => {
      callOrder.push('runCodeReview')
      return shipItResult
    })

    const mockEmit = vi.fn().mockImplementation((event: string) => {
      callOrder.push(event)
    })
    const mockEventBus = {
      emit: mockEmit,
      on: vi.fn(),
      off: vi.fn(),
    } as unknown as TypedEventBus<SdlcEvents>

    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    // Verify call order: phase-start → runCodeReview → phase-complete
    expect(callOrder).toEqual([
      'orchestrator:story-phase-start',
      'runCodeReview',
      'orchestrator:story-phase-complete',
    ])
  })

  it('emits phase-start with correct payload (AC6)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCall = emitMock.mock.calls.find(([event]) => event === 'orchestrator:story-phase-start')
    expect(phaseStartCall).toBeDefined()
    expect(phaseStartCall?.[1]).toEqual({ storyKey: '43-5', phase: 'code-review' })
  })

  it('emits phase-complete with storyKey, phase, and result on success (AC6)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(([event]) => event === 'orchestrator:story-phase-complete')
    expect(phaseCompleteCall).toBeDefined()
    expect(phaseCompleteCall?.[1]).toMatchObject({
      storyKey: '43-5',
      phase: 'code-review',
      result: { status: 'SUCCESS', verdict: 'SHIP_IT' },
    })
  })

  it('emits phase-complete with FAILURE status and verdict on NEEDS_MINOR_FIXES (AC6)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(needsMinorFixesResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(([event]) => event === 'orchestrator:story-phase-complete')
    expect(phaseCompleteCall?.[1]).toMatchObject({
      result: { status: 'FAILURE', verdict: 'NEEDS_MINOR_FIXES' },
    })
  })

  it('emits orchestrator:story-phase-complete even when runCodeReview throws (AC6)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockRejectedValue(new Error('unexpected crash'))
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseStartCalls = emitMock.mock.calls.filter(([e]) => e === 'orchestrator:story-phase-start')
    const phaseCompleteCalls = emitMock.mock.calls.filter(([e]) => e === 'orchestrator:story-phase-complete')

    expect(phaseStartCalls).toHaveLength(1)
    expect(phaseCompleteCalls).toHaveLength(1)
  })

  it('emits phase-complete with FAILURE status when runCodeReview throws (AC6)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockRejectedValue(new Error('boom'))
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(([e]) => e === 'orchestrator:story-phase-complete')
    expect(phaseCompleteCall?.[1]).toMatchObject({ result: { status: 'FAILURE' } })
  })

  it('emits phase-complete with undefined verdict when runCodeReview throws (AC6)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockRejectedValue(new Error('boom'))
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCall = emitMock.mock.calls.find(([e]) => e === 'orchestrator:story-phase-complete')
    const resultPayload = (phaseCompleteCall?.[1] as { result: { verdict?: string } })?.result
    expect(resultPayload?.verdict).toBeUndefined()
  })

  it('emits phase-complete even when dispatchFailed is true (AC6)', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockResolvedValue(dispatchFailedResult)
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    await handler(stubNode, context, stubGraph)

    const emitMock = vi.mocked(mockEventBus.emit)
    const phaseCompleteCalls = emitMock.mock.calls.filter(([e]) => e === 'orchestrator:story-phase-complete')
    expect(phaseCompleteCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Unexpected thrown error
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — unexpected thrown error', () => {
  it('returns FAILURE with caught error message when runCodeReview throws', async () => {
    const mockRunCodeReview = vi
      .fn<RunCodeReviewFn>()
      .mockRejectedValue(new Error('unexpected network failure'))
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('unexpected network failure')
  })

  it('converts non-Error throws to string for failureReason', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockRejectedValue('string error')
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.status).toBe('FAILURE')
    expect(result.failureReason).toBe('string error')
  })

  it('does not write contextUpdates when runCodeReview throws', async () => {
    const mockRunCodeReview = vi.fn<RunCodeReviewFn>().mockRejectedValue(new Error('boom'))
    const mockEventBus = makeEventBus()
    const options: SdlcCodeReviewHandlerOptions = {
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: mockRunCodeReview,
    }

    const context = makeContext({ storyKey: '43-5', storyFilePath: '/stories/43-5.md' })
    const handler = createSdlcCodeReviewHandler(options)
    const result = await handler(stubNode, context, stubGraph)

    expect(result.contextUpdates).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC7: Export from sdlc package handlers
// ---------------------------------------------------------------------------

describe('createSdlcCodeReviewHandler — export contract (AC7)', () => {
  it('is a function (factory exported correctly)', () => {
    expect(typeof createSdlcCodeReviewHandler).toBe('function')
  })

  it('returns a function (NodeHandler) when called', () => {
    const mockEventBus = makeEventBus()
    const handler = createSdlcCodeReviewHandler({
      deps: {},
      eventBus: mockEventBus,
      runCodeReview: vi.fn<RunCodeReviewFn>().mockResolvedValue(shipItResult),
    })
    expect(typeof handler).toBe('function')
  })
})
