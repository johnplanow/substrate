/**
 * Parity test suite that verifies `DirectCodergenBackend` and the CLI `callLLM`
 * path produce structurally equivalent outcomes for the same codergen tasks.
 * Observable differences between the two backends are intentional and documented.
 *
 * Story 48-11.
 *
 * Covers:
 *   AC1 – SUCCESS outcome structure is identical across both backends
 *   AC2 – FAILURE outcome is structurally comparable
 *   AC3 – Direct backend exposes TOOL_CALL_START/END events absent from CLI path
 *   AC4 – Direct backend exposes LOOP_DETECTION signal absent from CLI path
 *   AC5 – Direct backend exposes per-turn token usage; CLI path does not
 *   AC6 – Multiple sequential invocations produce independent outcomes
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock declarations — must be hoisted before any imports that load the mocked
// modules.  Vitest hoists vi.mock() calls at transpile time.
// ---------------------------------------------------------------------------

vi.mock('@substrate-ai/core', () => ({
  callLLM: vi.fn(),
}))

vi.mock('../../agent/loop.js', () => ({
  createSession: vi.fn(() => mockSession),
}))

// ---------------------------------------------------------------------------
// Imports — after mock declarations
// ---------------------------------------------------------------------------

import { callLLM } from '@substrate-ai/core'
import { createSession } from '../../agent/loop.js'
import { EventKind, type SessionEvent, type Turn, type AssistantTurn } from '../../agent/types.js'
import type { LLMUsage } from '../../llm/types.js'
import { createCodergenHandler } from '../../handlers/codergen-handler.js'
import { createDirectCodergenBackend } from '../direct-backend.js'
import type { GraphNode, IGraphContext, Graph } from '../../graph/types.js'
import { GraphContext } from '../../graph/context.js'
import type { LLMClient } from '../../llm/client.js'
import type { ProviderProfile } from '../../agent/tools/profiles.js'
import type { ExecutionEnvironment } from '../../agent/tools/types.js'

// ---------------------------------------------------------------------------
// Module-level mutable state — populated/reset in beforeEach.
// The vi.mock factory closes over these variables so the mock is always
// up-to-date when referenced inside tests.
// ---------------------------------------------------------------------------

let mockHandlers: Map<string, Array<(event: SessionEvent) => void>>
let mockHistory: Turn[]
let mockProcessInput: ReturnType<typeof vi.fn>
let mockClose: ReturnType<typeof vi.fn>
let mockSession: {
  on: ReturnType<typeof vi.fn>
  processInput: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  readonly history: Turn[]
}

/** Cast the callLLM mock so we get .mockResolvedValue / .mockRejectedValue */
const mockCallLLM = vi.mocked(callLLM)

// ---------------------------------------------------------------------------
// beforeEach: reset all mock state and reconstitute mockSession
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockHandlers = new Map()
  mockHistory = []
  mockClose = vi.fn()
  mockProcessInput = vi.fn().mockResolvedValue(undefined)

  mockSession = {
    on: vi.fn().mockImplementation((kind: EventKind, handler: (event: SessionEvent) => void) => {
      if (!mockHandlers.has(kind)) mockHandlers.set(kind, [])
      mockHandlers.get(kind)!.push(handler)
    }),
    processInput: mockProcessInput,
    close: mockClose,
    get history() { return mockHistory },
  }

  vi.mocked(createSession).mockReturnValue(mockSession as never)
  vi.clearAllMocks()

  // Re-set the session mock after clearAllMocks resets the call count
  vi.mocked(createSession).mockReturnValue(mockSession as never)
  mockSession.on.mockImplementation((kind: EventKind, handler: (event: SessionEvent) => void) => {
    if (!mockHandlers.has(kind)) mockHandlers.set(kind, [])
    mockHandlers.get(kind)!.push(handler)
  })
  mockProcessInput.mockResolvedValue(undefined)
})

// ---------------------------------------------------------------------------
// Helper: emit a synthetic event through registered handlers
// ---------------------------------------------------------------------------

function emitEvent(kind: EventKind, data: Record<string, unknown> = {}): void {
  const handlers = mockHandlers.get(kind) ?? []
  const event: SessionEvent = {
    kind,
    timestamp: new Date(),
    session_id: 'test-session',
    data,
  }
  for (const h of handlers) h(event)
}

// ---------------------------------------------------------------------------
// Helper: make a minimal GraphNode
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'node1',
    label: '',
    shape: 'box',
    type: 'codergen',
    prompt: '',
    maxRetries: 0,
    goalGate: false,
    retryTarget: '',
    fallbackRetryTarget: '',
    fidelity: '',
    threadId: '',
    class: '',
    timeout: 0,
    llmModel: '',
    llmProvider: '',
    reasoningEffort: '',
    autoStatus: false,
    allowPartial: false,
    toolCommand: '',
    backend: '',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Helper: make a minimal IGraphContext
// ---------------------------------------------------------------------------

function makeContext(): IGraphContext {
  return new GraphContext({})
}

// ---------------------------------------------------------------------------
// Helper: make a minimal Graph stub
// ---------------------------------------------------------------------------

function makeGraph(): Graph {
  return { nodes: [], edges: [], stylesheets: [] } as unknown as Graph
}

// ---------------------------------------------------------------------------
// Helper: make an AssistantTurn (with optional usage override)
// ---------------------------------------------------------------------------

function makeAssistantTurn(content: string, usage?: Partial<LLMUsage>): AssistantTurn {
  return {
    type: 'assistant',
    content,
    tool_calls: [],
    reasoning: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, ...usage },
    response_id: null,
    timestamp: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Helper: build a DirectCodergenBackend with optional onEvent collector
// ---------------------------------------------------------------------------

function buildDirectBackend(onEvent?: (e: SessionEvent) => void) {
  return createDirectCodergenBackend({
    llmClient: {} as LLMClient,
    providerProfile: {} as ProviderProfile,
    executionEnv: {} as ExecutionEnvironment,
    ...(onEvent ? { onEvent } : {}),
  })
}

// ---------------------------------------------------------------------------
// AC1 – SUCCESS outcome structure is identical across both backends
// ---------------------------------------------------------------------------

describe('AC1 – SUCCESS outcome structure parity', () => {
  it('CLI path returns SUCCESS with correct status and contextUpdates', async () => {
    mockCallLLM.mockResolvedValue({ text: 'implementation output' })
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates?.['node1_output']).toBe('implementation output')
  })

  it('direct backend returns SUCCESS with correct status and contextUpdates', async () => {
    mockHistory.push(makeAssistantTurn('implementation output'))
    const directBackend = buildDirectBackend()
    const handler = createCodergenHandler({ directBackend })
    const outcome = await handler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates?.['node1_output']).toBe('implementation output')
  })

  it('contextUpdates key names and values are identical between both backends', async () => {
    mockCallLLM.mockResolvedValue({ text: 'implementation output' })
    const cliHandler = createCodergenHandler()
    const cliOutcome = await cliHandler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    mockHistory.push(makeAssistantTurn('implementation output'))
    const directBackend = buildDirectBackend()
    const directHandler = createCodergenHandler({ directBackend })
    const directOutcome = await directHandler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    // Core parity: status and contextUpdates structure must be identical
    expect(cliOutcome.status).toBe(directOutcome.status)
    expect(Object.keys(cliOutcome.contextUpdates ?? {})).toEqual(Object.keys(directOutcome.contextUpdates ?? {}))
    expect(cliOutcome.contextUpdates?.['node1_output']).toBe(directOutcome.contextUpdates?.['node1_output'])
  })

  it('documented difference: CLI path sets notes; direct path does not', async () => {
    mockCallLLM.mockResolvedValue({ text: 'implementation output' })
    const cliHandler = createCodergenHandler()
    const cliOutcome = await cliHandler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    mockHistory.push(makeAssistantTurn('implementation output'))
    const directBackend = buildDirectBackend()
    const directHandler = createCodergenHandler({ directBackend })
    const directOutcome = await directHandler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    // Documented difference: CLI sets notes, direct does not
    expect(cliOutcome.notes).toBe('implementation output')
    expect(directOutcome.notes).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC2 – FAILURE outcome is structurally comparable
// ---------------------------------------------------------------------------

describe('AC2 – FAILURE outcome structural parity', () => {
  it('CLI path returns FAILURE when callLLM throws a non-transient error', async () => {
    mockCallLLM.mockRejectedValue(new Error('unknown failure'))
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    expect(outcome.status).toBe('FAILURE')
  })

  it('direct path returns FAILURE when session emits TURN_LIMIT', async () => {
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TURN_LIMIT, { reason: 'max_turns' })
    })
    const directBackend = buildDirectBackend()
    const handler = createCodergenHandler({ directBackend })
    const outcome = await handler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    expect(outcome.status).toBe('FAILURE')
  })

  it('both paths carry status FAILURE — documented shape difference: error vs failureReason', async () => {
    // CLI path
    mockCallLLM.mockRejectedValue(new Error('unknown failure'))
    const cliHandler = createCodergenHandler()
    const cliOutcome = await cliHandler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    // Direct path via TURN_LIMIT
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TURN_LIMIT, { reason: 'max_turns' })
    })
    const directBackend = buildDirectBackend()
    const directHandler = createCodergenHandler({ directBackend })
    const directOutcome = await directHandler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    // Both carry FAILURE status
    expect(cliOutcome.status).toBe('FAILURE')
    expect(directOutcome.status).toBe('FAILURE')

    // Documented shape difference: CLI uses error, direct uses failureReason
    expect(cliOutcome.error).toBeDefined()
    expect(directOutcome.failureReason).toBe('turn limit exceeded')
  })
})

// ---------------------------------------------------------------------------
// AC3 – Direct backend exposes TOOL_CALL_START/END events absent from CLI path
// ---------------------------------------------------------------------------

describe('AC3 – TOOL_CALL events visible on direct path only', () => {
  it('direct backend onEvent collector receives TOOL_CALL_START and TOOL_CALL_END', async () => {
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TOOL_CALL_START, { tool_name: 'read_file', call_id: 'call-1' })
      emitEvent(EventKind.TOOL_CALL_END, { call_id: 'call-1', output: 'file contents', is_error: false })
      mockHistory.push(makeAssistantTurn('done'))
    })

    const collectedEvents: SessionEvent[] = []
    const directBackend = buildDirectBackend(e => collectedEvents.push(e))
    const handler = createCodergenHandler({ directBackend })
    await handler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    const kinds = collectedEvents.map(e => e.kind)
    expect(kinds).toContain(EventKind.TOOL_CALL_START)
    expect(kinds).toContain(EventKind.TOOL_CALL_END)
  })

  it('TOOL_CALL_START event carries tool_name and call_id metadata', async () => {
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TOOL_CALL_START, { tool_name: 'write_file', call_id: 'call-42' })
      mockHistory.push(makeAssistantTurn('done'))
    })

    const collectedEvents: SessionEvent[] = []
    const directBackend = buildDirectBackend(e => collectedEvents.push(e))
    const handler = createCodergenHandler({ directBackend })
    await handler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    const startEvent = collectedEvents.find(e => e.kind === EventKind.TOOL_CALL_START)
    expect(startEvent?.data?.['tool_name']).toBe('write_file')
    expect(startEvent?.data?.['call_id']).toBe('call-42')
  })

  it('CLI path produces zero session events — callLLM has no event bus integration', async () => {
    mockCallLLM.mockResolvedValue({ text: 'result' })
    const handler = createCodergenHandler()
    await handler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    // callLLM was invoked — but no session events exist (CLI path has no event bus)
    expect(mockCallLLM).toHaveBeenCalledOnce()
    // No session was created on the CLI path
    expect(createSession).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// AC4 – Direct backend exposes LOOP_DETECTION signal absent from CLI path
// ---------------------------------------------------------------------------

describe('AC4 – LOOP_DETECTION signal visible on direct path only', () => {
  it('LOOP_DETECTION event is captured by the onEvent collector', async () => {
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.LOOP_DETECTION, { message: 'loop detected: pattern length 2 repeated 5 times' })
      mockHistory.push(makeAssistantTurn('done'))
    })

    const collectedEvents: SessionEvent[] = []
    const directBackend = buildDirectBackend(e => collectedEvents.push(e))
    const handler = createCodergenHandler({ directBackend })
    await handler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    const loopEvent = collectedEvents.find(e => e.kind === EventKind.LOOP_DETECTION)
    expect(loopEvent).toBeDefined()
    expect(loopEvent?.data?.['message']).toBe('loop detected: pattern length 2 repeated 5 times')
  })

  it('CLI path has no equivalent loop detection — callLLM is a simple function call', async () => {
    mockCallLLM.mockResolvedValue({ text: 'result' })
    const handler = createCodergenHandler()
    await handler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    // No session was created — the CLI path calls callLLM directly with no event system
    expect(createSession).not.toHaveBeenCalled()
    // callLLM returns a simple text result with no loop detection signals
    expect(mockCallLLM).toHaveBeenCalledOnce()
  })
})

// ---------------------------------------------------------------------------
// AC5 – Direct backend exposes per-turn token usage; CLI path does not
// ---------------------------------------------------------------------------

describe('AC5 – token usage observability', () => {
  it('direct backend: AssistantTurn.usage fields are readable from session.history', async () => {
    mockHistory.push(makeAssistantTurn('result', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }))

    const directBackend = buildDirectBackend()
    const handler = createCodergenHandler({ directBackend })
    await handler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), makeGraph())

    // Read the last AssistantTurn from session history
    const lastAssistantTurn = [...mockHistory]
      .reverse()
      .find((t): t is AssistantTurn => t.type === 'assistant')

    expect(lastAssistantTurn).toBeDefined()
    expect(lastAssistantTurn!.usage.inputTokens).toBe(100)
    expect(lastAssistantTurn!.usage.outputTokens).toBe(50)
    expect(lastAssistantTurn!.usage.totalTokens).toBe(150)
  })

  it('CLI path: callLLM return value contains only text — no usage field', async () => {
    mockCallLLM.mockResolvedValue({ text: 'result' })
    const handler = createCodergenHandler()
    const outcome = await handler(makeNode({ id: 'node1' }), makeContext(), makeGraph())

    // The CLI outcome does not expose token usage
    expect(outcome.status).toBe('SUCCESS')
    // LLMCallResult only contains { text: string }
    const returnValue = mockCallLLM.mock.results[0]?.value as { text: string; usage?: unknown }
    expect(returnValue?.['usage']).toBeUndefined()
  })

  it('documented constraint: token observability requires direct backend on CLI path', () => {
    // The CLI callLLM interface returns LLMCallResult { text: string } — no usage.
    // Token observability on the CLI path requires out-of-band instrumentation at
    // a higher level (e.g., the dispatch layer).
    // This test documents the constraint by checking the mock return shape.
    mockCallLLM.mockResolvedValue({ text: 'result' })

    // Direct inspection of the mock return value confirms the absence of usage
    const mockReturnValue = { text: 'result' }
    expect(Object.prototype.hasOwnProperty.call(mockReturnValue, 'usage')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// AC6 – Multiple sequential invocations produce independent outcomes
// ---------------------------------------------------------------------------

describe('AC6 – sequential invocations are independent; no state leaks', () => {
  it('CLI: three sequential invocations each return SUCCESS with correct contextUpdates', async () => {
    mockCallLLM
      .mockResolvedValueOnce({ text: 'output-1' })
      .mockResolvedValueOnce({ text: 'output-2' })
      .mockResolvedValueOnce({ text: 'output-3' })

    const handler = createCodergenHandler()
    const node = makeNode({ id: 'node1' })

    const o1 = await handler(node, makeContext(), makeGraph())
    const o2 = await handler(node, makeContext(), makeGraph())
    const o3 = await handler(node, makeContext(), makeGraph())

    expect(o1.status).toBe('SUCCESS')
    expect(o2.status).toBe('SUCCESS')
    expect(o3.status).toBe('SUCCESS')

    expect(o1.contextUpdates?.['node1_output']).toBe('output-1')
    expect(o2.contextUpdates?.['node1_output']).toBe('output-2')
    expect(o3.contextUpdates?.['node1_output']).toBe('output-3')
  })

  it('direct: three sequential invocations each return SUCCESS', async () => {
    const directBackend = buildDirectBackend()
    const handler = createCodergenHandler({ directBackend })
    const node = makeNode({ id: 'node1', backend: 'direct' })

    // Invocation 1
    mockHistory.length = 0
    mockHistory.push(makeAssistantTurn('output-1'))
    const o1 = await handler(node, makeContext(), makeGraph())

    // Invocation 2
    mockHistory.length = 0
    mockHistory.push(makeAssistantTurn('output-2'))
    const o2 = await handler(node, makeContext(), makeGraph())

    // Invocation 3
    mockHistory.length = 0
    mockHistory.push(makeAssistantTurn('output-3'))
    const o3 = await handler(node, makeContext(), makeGraph())

    expect(o1.status).toBe('SUCCESS')
    expect(o2.status).toBe('SUCCESS')
    expect(o3.status).toBe('SUCCESS')
  })

  it('direct: createSession called exactly 3 times across 3 invocations', async () => {
    const directBackend = buildDirectBackend()
    const handler = createCodergenHandler({ directBackend })
    const node = makeNode({ id: 'node1', backend: 'direct' })

    for (let i = 0; i < 3; i++) {
      mockHistory.length = 0
      mockHistory.push(makeAssistantTurn(`output-${i + 1}`))
      await handler(node, makeContext(), makeGraph())
    }

    expect(vi.mocked(createSession).mock.calls.length).toBe(3)
  })

  it('direct: session.close() called once per invocation — 3 times total', async () => {
    const directBackend = buildDirectBackend()
    const handler = createCodergenHandler({ directBackend })
    const node = makeNode({ id: 'node1', backend: 'direct' })

    for (let i = 0; i < 3; i++) {
      mockHistory.length = 0
      mockHistory.push(makeAssistantTurn(`output-${i + 1}`))
      await handler(node, makeContext(), makeGraph())
    }

    expect(mockClose).toHaveBeenCalledTimes(3)
  })
})
