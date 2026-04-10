/**
 * Unit tests for DirectCodergenBackend.
 *
 * Covers:
 *   AC1 – session is created and processInput called with the prompt
 *   AC2 – natural completion maps to SUCCESS with final assistant text
 *   AC3 – TURN_LIMIT event maps to FAILURE
 *   AC4 – per-turn events forwarded via onEvent callback
 *   AC6 – errors from processInput mapped to FAILURE; session.close() always called
 *
 * Story 48-10.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventKind, type SessionEvent, type Turn, type AssistantTurn } from '../../agent/types.js'
import { createDirectCodergenBackend } from '../direct-backend.js'
import type { GraphNode, IGraphContext } from '../../graph/types.js'
import type { LLMClient } from '../../llm/client.js'
import type { ProviderProfile } from '../../agent/tools/profiles.js'
import type { ExecutionEnvironment } from '../../agent/tools/types.js'

// ---------------------------------------------------------------------------
// Mock createSession — must be declared before imports are resolved
// ---------------------------------------------------------------------------

// Module-level mutable state populated in beforeEach; the vi.mock factory
// closes over these variables so the mock is always up-to-date.
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

vi.mock('../../agent/loop.js', () => ({
  createSession: vi.fn(() => mockSession),
}))

// Import the mocked createSession AFTER vi.mock (hoisting ensures the mock is applied).
import { createSession } from '../../agent/loop.js'

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
// Helper: make a minimal GraphNode with backend=''
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
  const store = new Map<string, unknown>()
  return {
    get: (key: string) => store.get(key),
    set: (key: string, value: unknown) => {
      store.set(key, value)
    },
    getString: (key: string, defaultValue = '') => {
      const v = store.get(key)
      return v !== undefined ? String(v) : defaultValue
    },
    getNumber: (key: string, defaultValue = 0) => {
      const v = store.get(key)
      if (v === undefined) return defaultValue
      const n = Number(v)
      return isNaN(n) ? defaultValue : n
    },
    getBoolean: (key: string, defaultValue = false) => {
      const v = store.get(key)
      return v !== undefined ? Boolean(v) : defaultValue
    },
    applyUpdates: (updates: Record<string, unknown>) => {
      for (const [k, val] of Object.entries(updates)) store.set(k, val)
    },
    snapshot: () => Object.fromEntries(store),
    clone: () => makeContext(),
  }
}

// ---------------------------------------------------------------------------
// Helper: build a minimal AssistantTurn
// ---------------------------------------------------------------------------

function makeAssistantTurn(content: string): AssistantTurn {
  return {
    type: 'assistant',
    content,
    tool_calls: [],
    reasoning: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    response_id: null,
    timestamp: new Date(),
  }
}

// ---------------------------------------------------------------------------
// Minimal mock dependency objects (values pass through to mocked createSession)
// ---------------------------------------------------------------------------

const fakeLLMClient = {} as LLMClient
const fakeProviderProfile = {} as ProviderProfile
const fakeExecutionEnv = {} as ExecutionEnvironment

// ---------------------------------------------------------------------------
// beforeEach: reset all mock state
// ---------------------------------------------------------------------------

beforeEach(() => {
  mockHandlers = new Map()
  mockHistory = []
  mockClose = vi.fn()
  // Default: natural completion, no events emitted
  mockProcessInput = vi.fn().mockResolvedValue(undefined)

  mockSession = {
    on: vi.fn().mockImplementation((kind: EventKind, handler: (event: SessionEvent) => void) => {
      if (!mockHandlers.has(kind)) mockHandlers.set(kind, [])
      mockHandlers.get(kind)!.push(handler)
    }),
    processInput: mockProcessInput,
    close: mockClose,
    get history() {
      return mockHistory
    },
  }

  vi.mocked(createSession).mockReturnValue(mockSession as never)
})

// ---------------------------------------------------------------------------
// AC1 – createSession and processInput called correctly
// ---------------------------------------------------------------------------

describe('AC1 – session creation and processInput', () => {
  it('calls createSession with llmClient, providerProfile, executionEnv', async () => {
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    await backend.run(makeNode(), 'test prompt', makeContext())
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        llmClient: fakeLLMClient,
        providerProfile: fakeProviderProfile,
        executionEnv: fakeExecutionEnv,
      })
    )
  })

  it('calls processInput with the exact prompt passed to run()', async () => {
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    await backend.run(makeNode(), 'my specific prompt', makeContext())
    expect(mockProcessInput).toHaveBeenCalledWith('my specific prompt')
  })

  it('passes config option to createSession when provided', async () => {
    const config = { max_turns: 10 }
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
      config,
    })
    await backend.run(makeNode(), 'prompt', makeContext())
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ config }))
  })
})

// ---------------------------------------------------------------------------
// AC2 – Natural completion maps to SUCCESS
// ---------------------------------------------------------------------------

describe('AC2 – natural completion → SUCCESS', () => {
  it('returns SUCCESS with contextUpdates from final assistant turn content', async () => {
    mockHistory.push(makeAssistantTurn('done'))
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    const outcome = await backend.run(makeNode({ id: 'node1' }), 'prompt', makeContext())
    expect(outcome).toEqual({
      status: 'SUCCESS',
      contextUpdates: { node1_output: 'done' },
    })
  })

  it('uses the last assistant turn when multiple turns exist', async () => {
    mockHistory.push(makeAssistantTurn('first response'))
    mockHistory.push({ type: 'user', content: 'follow up', timestamp: new Date() })
    mockHistory.push(makeAssistantTurn('final response'))
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    const outcome = await backend.run(makeNode({ id: 'myNode' }), 'prompt', makeContext())
    expect(outcome).toEqual({
      status: 'SUCCESS',
      contextUpdates: { myNode_output: 'final response' },
    })
  })

  it('returns SUCCESS with no contextUpdates when history has no assistant turn', async () => {
    // history is empty — no assistant turn
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    const outcome = await backend.run(makeNode(), 'prompt', makeContext())
    expect(outcome.status).toBe('SUCCESS')
    expect(outcome.contextUpdates).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC3 – TURN_LIMIT event maps to FAILURE
// ---------------------------------------------------------------------------

describe('AC3 – TURN_LIMIT event → FAILURE', () => {
  it('returns FAILURE with "turn limit exceeded" when TURN_LIMIT is emitted', async () => {
    // Configure processInput to fire TURN_LIMIT before resolving
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TURN_LIMIT, { reason: 'max_turns' })
    })
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    const outcome = await backend.run(makeNode(), 'prompt', makeContext())
    expect(outcome).toEqual({ status: 'FAILURE', failureReason: 'turn limit exceeded' })
  })

  it('TURN_LIMIT from max_tool_rounds_per_input also returns FAILURE', async () => {
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TURN_LIMIT, { reason: 'max_tool_rounds_per_input' })
    })
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    const outcome = await backend.run(makeNode(), 'prompt', makeContext())
    expect(outcome).toEqual({ status: 'FAILURE', failureReason: 'turn limit exceeded' })
  })
})

// ---------------------------------------------------------------------------
// AC4 – Per-turn events forwarded via onEvent callback
// ---------------------------------------------------------------------------

describe('AC4 – onEvent callback receives session events', () => {
  it('forwards TOOL_CALL_START and TOOL_CALL_END events to onEvent', async () => {
    const onEvent = vi.fn()
    // Emit TOOL_CALL_START and TOOL_CALL_END during processInput
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TOOL_CALL_START, { tool_name: 'read_file', call_id: '1' })
      emitEvent(EventKind.TOOL_CALL_END, { call_id: '1', output: 'file contents', is_error: false })
      // Natural completion
      mockHistory.push(makeAssistantTurn('done'))
    })
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
      onEvent,
    })
    await backend.run(makeNode(), 'prompt', makeContext())

    // onEvent should have been called at least for TOOL_CALL_START and TOOL_CALL_END
    const receivedKinds = (onEvent.mock.calls as Array<[SessionEvent]>).map(([e]) => e.kind)
    expect(receivedKinds).toContain(EventKind.TOOL_CALL_START)
    expect(receivedKinds).toContain(EventKind.TOOL_CALL_END)
  })

  it('forwards LOOP_DETECTION event to onEvent', async () => {
    const onEvent = vi.fn()
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.LOOP_DETECTION, { message: 'loop detected' })
      mockHistory.push(makeAssistantTurn('done'))
    })
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
      onEvent,
    })
    await backend.run(makeNode(), 'prompt', makeContext())

    const receivedKinds = (onEvent.mock.calls as Array<[SessionEvent]>).map(([e]) => e.kind)
    expect(receivedKinds).toContain(EventKind.LOOP_DETECTION)
  })

  it('subscribes to all EventKind values when onEvent is provided', async () => {
    const onEvent = vi.fn()
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
      onEvent,
    })
    await backend.run(makeNode(), 'prompt', makeContext())

    // session.on should have been called for every EventKind value
    const registeredKinds = (mockSession.on.mock.calls as Array<[EventKind, unknown]>).map(
      ([k]) => k
    )
    for (const kind of Object.values(EventKind)) {
      expect(registeredKinds).toContain(kind)
    }
  })

  it('does not subscribe to all EventKind values when onEvent is not provided', async () => {
    // No onEvent — only the TURN_LIMIT handler should be registered
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    await backend.run(makeNode(), 'prompt', makeContext())

    const registeredKinds = (mockSession.on.mock.calls as Array<[EventKind, unknown]>).map(
      ([k]) => k
    )
    // Only TURN_LIMIT handler should be registered
    expect(registeredKinds).toEqual([EventKind.TURN_LIMIT])
  })
})

// ---------------------------------------------------------------------------
// AC6 – Errors propagate as FAILURE; session.close() always called
// ---------------------------------------------------------------------------

describe('AC6 – error handling and session.close() guarantee', () => {
  it('returns FAILURE when processInput throws an Error', async () => {
    mockProcessInput.mockRejectedValue(new Error('api timeout'))
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    const outcome = await backend.run(makeNode(), 'prompt', makeContext())
    expect(outcome).toEqual({ status: 'FAILURE', failureReason: 'api timeout' })
  })

  it('returns FAILURE when processInput throws a non-Error value', async () => {
    mockProcessInput.mockRejectedValue('string error')
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    const outcome = await backend.run(makeNode(), 'prompt', makeContext())
    expect(outcome).toEqual({ status: 'FAILURE', failureReason: 'string error' })
  })

  it('does NOT rethrow the error', async () => {
    mockProcessInput.mockRejectedValue(new Error('network failure'))
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    // If run() rethrows, this would throw and fail the test
    await expect(backend.run(makeNode(), 'prompt', makeContext())).resolves.toEqual(
      expect.objectContaining({ status: 'FAILURE' })
    )
  })

  it('calls session.close() when processInput throws', async () => {
    mockProcessInput.mockRejectedValue(new Error('network failure'))
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    await backend.run(makeNode(), 'prompt', makeContext())
    expect(mockClose).toHaveBeenCalledOnce()
  })

  it('calls session.close() on success', async () => {
    mockHistory.push(makeAssistantTurn('output'))
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    await backend.run(makeNode(), 'prompt', makeContext())
    expect(mockClose).toHaveBeenCalledOnce()
  })

  it('calls session.close() on TURN_LIMIT', async () => {
    mockProcessInput.mockImplementation(async () => {
      emitEvent(EventKind.TURN_LIMIT, { reason: 'max_turns' })
    })
    const backend = createDirectCodergenBackend({
      llmClient: fakeLLMClient,
      providerProfile: fakeProviderProfile,
      executionEnv: fakeExecutionEnv,
    })
    await backend.run(makeNode(), 'prompt', makeContext())
    expect(mockClose).toHaveBeenCalledOnce()
  })
})
