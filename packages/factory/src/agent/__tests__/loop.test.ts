// packages/factory/src/agent/__tests__/loop.test.ts
// Tests for CodingAgentSession and the core agentic loop.
// Story 48-7: Coding Agent Loop — Core Agentic Loop

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { createSession, CodingAgentSession, convertHistoryToMessages } from '../loop.js'
import { EventKind, SessionState } from '../types.js'
import type { SessionConfig, SessionEvent } from '../types.js'
import type { ProviderProfile } from '../tools/profiles.js'
import type { ExecutionEnvironment, ToolDefinition } from '../tools/types.js'
import type { LLMResponse, LLMUsage } from '../../llm/types.js'
import { LLMClient } from '../../llm/client.js'

// ---------------------------------------------------------------------------
// Test helpers / shared mocks
// ---------------------------------------------------------------------------

function makeUsage(override: Partial<LLMUsage> = {}): LLMUsage {
  return {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    ...override,
  }
}

function makeTextResponse(content = 'Done!'): LLMResponse {
  return {
    content,
    toolCalls: [],
    usage: makeUsage(),
    model: 'test-model',
    stopReason: 'stop',
    providerMetadata: {},
  }
}

function makeToolCallResponse(
  toolName: string,
  callId = 'call1',
  args: Record<string, unknown> = {}
): LLMResponse {
  return {
    content: '',
    toolCalls: [{ id: callId, name: toolName, arguments: args }],
    usage: makeUsage(),
    model: 'test-model',
    stopReason: 'tool_calls',
    providerMetadata: {},
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeToolDefinition(
  name: string,
  executor?: (args: any, env: ExecutionEnvironment) => Promise<string>
): ToolDefinition {
  return {
    name,
    description: `Mock ${name} tool`,
    inputSchema: { type: 'object', properties: {}, required: [] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    executor: executor ?? (vi.fn().mockResolvedValue(`${name} output`) as any),
  }
}

function makeProfile(
  tools: ToolDefinition[] = [],
  overrides: Partial<ProviderProfile> = {}
): ProviderProfile {
  return {
    id: 'test',
    model: 'test-model',
    supports_streaming: false,
    context_window_size: 100_000,
    supports_parallel_tool_calls: true,
    build_system_prompt: vi.fn().mockReturnValue('System prompt'),
    tools: vi.fn().mockReturnValue(tools),
    provider_options: vi.fn().mockReturnValue({}),
    ...overrides,
  } as unknown as ProviderProfile
}

function makeMockClient(completeFn: ReturnType<typeof vi.fn>): LLMClient {
  return { complete: completeFn } as unknown as LLMClient
}

function makeEnv(): ExecutionEnvironment {
  return {
    workdir: '/tmp',
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 }),
  }
}

function makeConfig(overrides: Partial<SessionConfig> = {}): Partial<SessionConfig> {
  return {
    max_turns: 0,
    max_tool_rounds_per_input: 0,
    tool_output_limits: new Map(),
    ...overrides,
  }
}

// Collect all events for specific kinds
function collectEvents(session: CodingAgentSession, ...kinds: EventKind[]): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const kind of kinds) {
    session.on(kind, (e) => events.push(e))
  }
  return events
}

// Collect all events from a session
function collectAllEvents(session: CodingAgentSession): SessionEvent[] {
  const events: SessionEvent[] = []
  for (const kind of Object.values(EventKind)) {
    session.on(kind as EventKind, (e) => events.push(e))
  }
  return events
}

// ---------------------------------------------------------------------------
// Test Suite: createSession
// ---------------------------------------------------------------------------

describe('createSession', () => {
  it('returns a CodingAgentSession instance in IDLE state with a UUID id', () => {
    const session = createSession({
      llmClient: makeMockClient(vi.fn()),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    expect(session).toBeInstanceOf(CodingAgentSession)
    expect(session.state).toBe(SessionState.IDLE)
    expect(session.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it('emits SESSION_START event synchronously during creation', () => {
    // Spy on EventEmitter.prototype.emit before construction
    const emitSpy = vi.spyOn(EventEmitter.prototype, 'emit')

    const session = createSession({
      llmClient: makeMockClient(vi.fn()),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    const startCall = emitSpy.mock.calls.find((args) => args[0] === EventKind.SESSION_START)
    expect(startCall).toBeDefined()
    if (startCall) {
      const event = startCall[1] as SessionEvent
      expect(event.kind).toBe(EventKind.SESSION_START)
      expect(event.session_id).toBe(session.id)
    }

    emitSpy.mockRestore()
  })

  it('returns session with empty history', () => {
    const session = createSession({
      llmClient: makeMockClient(vi.fn()),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })
    expect(session.history).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Test Suite: close()
// ---------------------------------------------------------------------------

describe('session.close()', () => {
  it('transitions state to CLOSED and emits SESSION_END', () => {
    const session = createSession({
      llmClient: makeMockClient(vi.fn()),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    const events: SessionEvent[] = []
    session.on(EventKind.SESSION_END, (e) => events.push(e))

    session.close()

    expect(session.state).toBe(SessionState.CLOSED)
    expect(events).toHaveLength(1)
    expect(events[0]!.kind).toBe(EventKind.SESSION_END)
    expect(events[0]!.session_id).toBe(session.id)
  })
})

// ---------------------------------------------------------------------------
// Test Suite: processInput — natural completion
// ---------------------------------------------------------------------------

describe('processInput — natural completion (no tool calls)', () => {
  it('emits USER_INPUT then ASSISTANT_TEXT_END then PROCESSING_END for text-only response', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse('Hello, world!'))
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    const events = collectAllEvents(session)

    await session.processInput('hi')

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain(EventKind.USER_INPUT)
    expect(kinds).toContain(EventKind.ASSISTANT_TEXT_END)
    expect(kinds).toContain(EventKind.PROCESSING_END)

    // Verify ordering
    const uiIdx = kinds.indexOf(EventKind.USER_INPUT)
    const ateIdx = kinds.indexOf(EventKind.ASSISTANT_TEXT_END)
    const peIdx = kinds.indexOf(EventKind.PROCESSING_END)
    expect(uiIdx).toBeLessThan(ateIdx)
    expect(ateIdx).toBeLessThan(peIdx)
  })

  it('appends UserTurn and AssistantTurn to history', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse('Response'))
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    await session.processInput('my question')

    expect(session.history).toHaveLength(2)
    expect(session.history[0]!.type).toBe('user')
    expect(session.history[1]!.type).toBe('assistant')
  })

  it('returns to IDLE state after processing', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse())
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    await session.processInput('test')
    expect(session.state).toBe(SessionState.IDLE)
  })

  it('calls LLM with a request built from the session (model, systemPrompt, toolChoice)', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse())
    const profile = makeProfile()
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: profile,
      executionEnv: makeEnv(),
    })

    await session.processInput('hello')

    expect(complete).toHaveBeenCalledOnce()
    const req = complete.mock.calls[0]![0]
    expect(req.model).toBe('test-model')
    expect(req.systemPrompt).toBe('System prompt')
    expect(req.toolChoice).toBe('auto')
  })
})

// ---------------------------------------------------------------------------
// Test Suite: processInput — tool call loop
// ---------------------------------------------------------------------------

describe('processInput — one tool call then natural completion', () => {
  it('emits TOOL_CALL_START, TOOL_CALL_END, final ASSISTANT_TEXT_END, PROCESSING_END', async () => {
    const tool = makeToolDefinition('my_tool')
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeToolCallResponse('my_tool'))
      .mockResolvedValueOnce(makeTextResponse('All done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
    })

    const events = collectAllEvents(session)

    await session.processInput('run my tool')

    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain(EventKind.TOOL_CALL_START)
    expect(kinds).toContain(EventKind.TOOL_CALL_END)
    expect(kinds).toContain(EventKind.PROCESSING_END)

    // LLM was called twice (once returning tool call, once returning text)
    expect(complete).toHaveBeenCalledTimes(2)
  })

  it('appends UserTurn, AssistantTurn, ToolResultsTurn, and final AssistantTurn to history', async () => {
    const tool = makeToolDefinition('my_tool')
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeToolCallResponse('my_tool'))
      .mockResolvedValueOnce(makeTextResponse('All done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
    })

    await session.processInput('run my tool')

    expect(session.history).toHaveLength(4)
    expect(session.history[0]!.type).toBe('user')
    expect(session.history[1]!.type).toBe('assistant')
    expect(session.history[2]!.type).toBe('tool_results')
    expect(session.history[3]!.type).toBe('assistant')
  })
})

// ---------------------------------------------------------------------------
// Test Suite: Limit enforcement
// ---------------------------------------------------------------------------

describe('max_tool_rounds_per_input enforcement', () => {
  it('stops after N rounds and emits TURN_LIMIT with correct data', async () => {
    const tool = makeToolDefinition('looping_tool')
    // LLM always returns a tool call (never natural completion)
    const complete = vi.fn().mockResolvedValue(makeToolCallResponse('looping_tool'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
      config: makeConfig({ max_tool_rounds_per_input: 2 }),
    })

    const turnLimitEvents: SessionEvent[] = []
    session.on(EventKind.TURN_LIMIT, (e) => turnLimitEvents.push(e))
    const processingEndEvents: SessionEvent[] = []
    session.on(EventKind.PROCESSING_END, (e) => processingEndEvents.push(e))

    await session.processInput('loop me')

    expect(turnLimitEvents).toHaveLength(1)
    expect(turnLimitEvents[0]!.data.reason).toBe('max_tool_rounds_per_input')
    expect(turnLimitEvents[0]!.data.round).toBe(2)

    // PROCESSING_END emitted after TURN_LIMIT
    expect(processingEndEvents).toHaveLength(1)
    expect(session.state).toBe(SessionState.IDLE)
  })
})

describe('max_turns enforcement', () => {
  it('stops loop when total turn count reaches max_turns and emits TURN_LIMIT', async () => {
    const tool = makeToolDefinition('looping_tool')
    const complete = vi.fn().mockResolvedValue(makeToolCallResponse('looping_tool'))

    // max_turns: 3 — after UserTurn(1) + AssistantTurn(2) + ToolResultsTurn(3) = 3 turns
    // At next iteration start, history.length = 3 >= 3 → TURN_LIMIT
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
      config: makeConfig({ max_turns: 3 }),
    })

    const turnLimitEvents: SessionEvent[] = []
    session.on(EventKind.TURN_LIMIT, (e) => turnLimitEvents.push(e))

    await session.processInput('test')

    expect(turnLimitEvents).toHaveLength(1)
    expect(turnLimitEvents[0]!.data.reason).toBe('max_turns')
    expect(session.state).toBe(SessionState.IDLE)
  })

  it('does not enforce limit when max_turns is 0 (unlimited)', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse())
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
      config: makeConfig({ max_turns: 0 }),
    })

    const turnLimitEvents: SessionEvent[] = []
    session.on(EventKind.TURN_LIMIT, (e) => turnLimitEvents.push(e))

    await session.processInput('test')
    expect(turnLimitEvents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Test Suite: Unknown tool handling
// ---------------------------------------------------------------------------

describe('unknown tool handling', () => {
  it('returns is_error: true without throwing for unknown tool calls', async () => {
    // Profile has NO tools registered
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeToolCallResponse('nonexistent_tool', 'call99'))
      .mockResolvedValueOnce(makeTextResponse())

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([]), // empty tools list
      executionEnv: makeEnv(),
    })

    const toolEndEvents: SessionEvent[] = []
    session.on(EventKind.TOOL_CALL_END, (e) => toolEndEvents.push(e))

    // Should NOT throw
    await expect(session.processInput('call unknown')).resolves.toBeUndefined()

    expect(toolEndEvents).toHaveLength(1)
    expect(toolEndEvents[0]!.data.is_error).toBe(true)
    expect(toolEndEvents[0]!.data.output).toContain('Unknown tool: nonexistent_tool')
  })

  it('records the error in ToolResultsTurn history', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeToolCallResponse('ghost_tool', 'c1'))
      .mockResolvedValueOnce(makeTextResponse())

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([]),
      executionEnv: makeEnv(),
    })

    await session.processInput('call ghost')

    const toolResultsTurn = session.history.find((t) => t.type === 'tool_results')
    expect(toolResultsTurn).toBeDefined()
    if (toolResultsTurn?.type === 'tool_results') {
      expect(toolResultsTurn.results[0]!.is_error).toBe(true)
      expect(toolResultsTurn.results[0]!.content).toContain('Unknown tool: ghost_tool')
    } else {
      throw new Error('Expected tool_results turn')
    }
  })
})

// ---------------------------------------------------------------------------
// Test Suite: TOOL_CALL_END carries full untruncated output
// ---------------------------------------------------------------------------

describe('TOOL_CALL_END full output in event', () => {
  it('event carries full untruncated output when truncation is applied to LLM content', async () => {
    // 'shell' has a 30,000 char default limit
    const largeOutput = 'X'.repeat(35_000)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const shellTool = makeToolDefinition('shell', vi.fn().mockResolvedValue(largeOutput) as any)

    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeToolCallResponse('shell', 'c1'))
      .mockResolvedValueOnce(makeTextResponse())

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([shellTool]),
      executionEnv: makeEnv(),
    })

    const toolEndEvents: SessionEvent[] = []
    session.on(EventKind.TOOL_CALL_END, (e) => toolEndEvents.push(e))

    await session.processInput('run shell')

    // Event output = full untruncated
    expect(toolEndEvents).toHaveLength(1)
    expect(toolEndEvents[0]!.data.output).toBe(largeOutput)
    expect((toolEndEvents[0]!.data.output as string).length).toBe(35_000)

    // History ToolResultsTurn content should be truncated
    const toolResultsTurn = session.history.find((t) => t.type === 'tool_results')
    expect(toolResultsTurn).toBeDefined()
    if (toolResultsTurn?.type === 'tool_results') {
      expect(toolResultsTurn.results[0]!.content).toContain('characters truncated from middle.')
      expect(toolResultsTurn.results[0]!.content.length).toBeLessThan(35_000)
    }
  })
})

// ---------------------------------------------------------------------------
// Test Suite: Parallel vs sequential tool dispatch
// ---------------------------------------------------------------------------

describe('parallel tool call dispatch', () => {
  it('dispatches multiple tool calls concurrently when supports_parallel_tool_calls=true', async () => {
    let activeCount = 0
    let maxActiveCount = 0

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeParallelExecutor = (): ((args: any, env: ExecutionEnvironment) => Promise<string>) =>
      vi.fn().mockImplementation(async () => {
        activeCount++
        maxActiveCount = Math.max(maxActiveCount, activeCount)
        await new Promise((r) => setTimeout(r, 15))
        activeCount--
        return 'output'
      })

    const tool1 = makeToolDefinition('tool1', makeParallelExecutor())
    const tool2 = makeToolDefinition('tool2', makeParallelExecutor())

    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'c1', name: 'tool1', arguments: {} },
          { id: 'c2', name: 'tool2', arguments: {} },
        ],
        usage: makeUsage(),
        model: 'test-model',
        stopReason: 'tool_calls',
        providerMetadata: {},
      })
      .mockResolvedValueOnce(makeTextResponse())

    const profile = makeProfile([tool1, tool2], { supports_parallel_tool_calls: true })
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: profile,
      executionEnv: makeEnv(),
    })

    await session.processInput('run tools in parallel')

    // Parallel: both tools run simultaneously → maxActiveCount = 2
    expect(maxActiveCount).toBe(2)
  })

  it('dispatches tool calls sequentially when supports_parallel_tool_calls=false', async () => {
    const callOrder: string[] = []

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const makeSeqExecutor = (
      name: string
    ): ((args: any, env: ExecutionEnvironment) => Promise<string>) =>
      vi.fn().mockImplementation(async () => {
        callOrder.push(`start_${name}`)
        await new Promise((r) => setTimeout(r, 10))
        callOrder.push(`end_${name}`)
        return 'output'
      })

    const tool1 = makeToolDefinition('tool1', makeSeqExecutor('tool1'))
    const tool2 = makeToolDefinition('tool2', makeSeqExecutor('tool2'))

    const complete = vi
      .fn()
      .mockResolvedValueOnce({
        content: '',
        toolCalls: [
          { id: 'c1', name: 'tool1', arguments: {} },
          { id: 'c2', name: 'tool2', arguments: {} },
        ],
        usage: makeUsage(),
        model: 'test-model',
        stopReason: 'tool_calls',
        providerMetadata: {},
      })
      .mockResolvedValueOnce(makeTextResponse())

    const profile = makeProfile([tool1, tool2], { supports_parallel_tool_calls: false })
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: profile,
      executionEnv: makeEnv(),
    })

    await session.processInput('run tools sequentially')

    // Sequential: tool1 must complete before tool2 starts
    expect(callOrder).toEqual(['start_tool1', 'end_tool1', 'start_tool2', 'end_tool2'])
  })
})

// ---------------------------------------------------------------------------
// Test Suite: convertHistoryToMessages
// ---------------------------------------------------------------------------

describe('convertHistoryToMessages', () => {
  it('converts UserTurn to user role message with text content', () => {
    const history = [{ type: 'user' as const, content: 'hello', timestamp: new Date() }]
    const messages = convertHistoryToMessages(history)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content[0]).toMatchObject({ kind: 'text', text: 'hello' })
  })

  it('converts SteeringTurn to user role message', () => {
    const history = [{ type: 'steering' as const, content: 'steer this', timestamp: new Date() }]
    const messages = convertHistoryToMessages(history)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content[0]).toMatchObject({ kind: 'text', text: 'steer this' })
  })

  it('skips SystemTurn (system prompt passed separately)', () => {
    const history = [{ type: 'system' as const, content: 'system msg', timestamp: new Date() }]
    const messages = convertHistoryToMessages(history)
    expect(messages).toHaveLength(0)
  })

  it('converts ToolResultsTurn to user role with tool_result content parts', () => {
    const history = [
      {
        type: 'tool_results' as const,
        results: [{ tool_call_id: 'c1', content: 'result', is_error: false }],
        timestamp: new Date(),
      },
    ]
    const messages = convertHistoryToMessages(history)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('user')
    expect(messages[0]!.content[0]).toMatchObject({
      kind: 'tool_result',
      toolResult: { toolCallId: 'c1', content: 'result', isError: false },
    })
  })

  it('converts AssistantTurn with tool calls to assistant role with tool_call parts', () => {
    const history = [
      {
        type: 'assistant' as const,
        content: 'Using tool',
        tool_calls: [{ id: 'tc1', name: 'my_tool', arguments: { x: 1 } }],
        reasoning: null,
        usage: makeUsage(),
        response_id: null,
        timestamp: new Date(),
      },
    ]
    const messages = convertHistoryToMessages(history)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.role).toBe('assistant')
    const parts = messages[0]!.content
    expect(parts.some((p) => p.kind === 'text')).toBe(true)
    expect(parts.some((p) => p.kind === 'tool_call')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Test Suite: error handling
// ---------------------------------------------------------------------------

describe('error handling', () => {
  it('emits ERROR event and sets state to CLOSED when LLM throws', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('LLM unavailable'))
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    const errorEvents: SessionEvent[] = []
    session.on(EventKind.ERROR, (e) => errorEvents.push(e))

    await expect(session.processInput('test')).rejects.toThrow('LLM unavailable')

    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]!.data.message).toBe('LLM unavailable')
    expect(session.state).toBe(SessionState.CLOSED)
  })
})

// ---------------------------------------------------------------------------
// Test Suite: steer() — steering injection (Story 48-8)
// ---------------------------------------------------------------------------

describe('steer() — steering injection', () => {
  it('message queued via steer() appears as SteeringTurn before next LLM call', async () => {
    const tool = makeToolDefinition('my_tool')
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeToolCallResponse('my_tool'))
      .mockResolvedValueOnce(makeTextResponse('Done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
    })

    // Queue a steering message before processing starts
    session.steer('please use a different approach')

    await session.processInput('do something')

    // SteeringTurn should appear in history
    const steeringTurns = session.history.filter((t) => t.type === 'steering')
    expect(steeringTurns.length).toBeGreaterThanOrEqual(1)
    const turn = steeringTurns[0]
    expect(turn?.type).toBe('steering')
    if (turn?.type === 'steering') {
      expect(turn.content).toBe('please use a different approach')
    }
  })

  it('STEERING_INJECTED event is emitted with correct content', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse('Done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    const steeringEvents: SessionEvent[] = []
    session.on(EventKind.STEERING_INJECTED, (e) => steeringEvents.push(e))

    session.steer('redirect now')
    await session.processInput('hello')

    expect(steeringEvents).toHaveLength(1)
    expect(steeringEvents[0]!.data.content).toBe('redirect now')
  })

  it('steering message is in history before the next LLM request (correct history position)', async () => {
    const tool = makeToolDefinition('my_tool')

    // Capture what history looks like at each LLM call
    const historySnapshotsAtLLMCall: string[][] = []

    const complete = vi.fn().mockImplementation(() => {
      // Capture the types of turns in history at call time
      historySnapshotsAtLLMCall.push(session.history.map((t) => t.type))
      if (complete.mock.calls.length === 1) {
        return Promise.resolve(makeToolCallResponse('my_tool'))
      }
      return Promise.resolve(makeTextResponse('Done'))
    })

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
    })

    // Steer before the second LLM call (while the tool is executing)
    // We'll queue it before processInput; it will be drained before the first LLM call
    session.steer('steered!')

    await session.processInput('use tool')

    // First LLM call should see the steering turn in history
    expect(historySnapshotsAtLLMCall[0]).toContain('steering')
  })

  it('steer() called while IDLE: message is buffered and injected on next processInput call', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse('OK'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    // Session is IDLE; queue steering
    session.steer('buffered-steer')
    expect(session._steeringQueue).toHaveLength(1)

    const steeringEvents: SessionEvent[] = []
    session.on(EventKind.STEERING_INJECTED, (e) => steeringEvents.push(e))

    await session.processInput('now process')

    // Steering should have been drained
    expect(steeringEvents).toHaveLength(1)
    expect(steeringEvents[0]!.data.content).toBe('buffered-steer')
    expect(session._steeringQueue).toHaveLength(0)
  })

  it('multiple steer() messages are drained FIFO', async () => {
    const complete = vi.fn().mockResolvedValue(makeTextResponse('OK'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    session.steer('first')
    session.steer('second')
    session.steer('third')

    const steeringEvents: SessionEvent[] = []
    session.on(EventKind.STEERING_INJECTED, (e) => steeringEvents.push(e))

    await session.processInput('go')

    expect(steeringEvents).toHaveLength(3)
    expect(steeringEvents[0]!.data.content).toBe('first')
    expect(steeringEvents[1]!.data.content).toBe('second')
    expect(steeringEvents[2]!.data.content).toBe('third')
  })
})

// ---------------------------------------------------------------------------
// Test Suite: _drainSteering (Story 48-8)
// ---------------------------------------------------------------------------

describe('_drainSteering()', () => {
  it('dequeues all messages in FIFO order, appends SteeringTurns, emits STEERING_INJECTED', () => {
    const complete = vi.fn()
    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    const steeringEvents: SessionEvent[] = []
    session.on(EventKind.STEERING_INJECTED, (e) => steeringEvents.push(e))

    session._steeringQueue.push('msg1', 'msg2', 'msg3')
    session._drainSteering()

    // All messages dequeued
    expect(session._steeringQueue).toHaveLength(0)

    // SteeringTurns appended to history
    expect(session.history).toHaveLength(3)
    expect(session.history.every((t) => t.type === 'steering')).toBe(true)
    expect((session.history[0] as import('../types.js').SteeringTurn).content).toBe('msg1')
    expect((session.history[1] as import('../types.js').SteeringTurn).content).toBe('msg2')
    expect((session.history[2] as import('../types.js').SteeringTurn).content).toBe('msg3')

    // Events emitted per message
    expect(steeringEvents).toHaveLength(3)
    expect(steeringEvents[0]!.data.content).toBe('msg1')
    expect(steeringEvents[1]!.data.content).toBe('msg2')
    expect(steeringEvents[2]!.data.content).toBe('msg3')
  })

  it('does nothing when steering queue is empty', () => {
    const session = createSession({
      llmClient: makeMockClient(vi.fn()),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    const steeringEvents: SessionEvent[] = []
    session.on(EventKind.STEERING_INJECTED, (e) => steeringEvents.push(e))

    session._drainSteering()

    expect(session.history).toHaveLength(0)
    expect(steeringEvents).toHaveLength(0)
  })

  it('SteeringTurn has a timestamp (Date instance)', () => {
    const session = createSession({
      llmClient: makeMockClient(vi.fn()),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    session._steeringQueue.push('msg')
    session._drainSteering()

    const turn = session.history[0]
    expect(turn?.type).toBe('steering')
    if (turn?.type === 'steering') {
      expect(turn.timestamp).toBeInstanceOf(Date)
    }
  })
})

// ---------------------------------------------------------------------------
// Test Suite: follow_up() — follow-up queue (Story 48-8)
// ---------------------------------------------------------------------------

describe('follow_up() — follow-up queue', () => {
  it('queued follow-up triggers a new processing cycle after natural completion', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeTextResponse('First response'))
      .mockResolvedValueOnce(makeTextResponse('Second response'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    session.follow_up('follow-up message')

    const userInputEvents: SessionEvent[] = []
    session.on(EventKind.USER_INPUT, (e) => userInputEvents.push(e))

    const processingEndEvents: SessionEvent[] = []
    session.on(EventKind.PROCESSING_END, (e) => processingEndEvents.push(e))

    await session.processInput('initial message')

    // LLM should have been called twice
    expect(complete).toHaveBeenCalledTimes(2)

    // USER_INPUT emitted twice (once per processInput call)
    expect(userInputEvents).toHaveLength(2)
    expect(userInputEvents[0]!.data.content).toBe('initial message')
    expect(userInputEvents[1]!.data.content).toBe('follow-up message')

    // PROCESSING_END emitted exactly once (after follow-up is fully exhausted)
    expect(processingEndEvents).toHaveLength(1)
  })

  it('PROCESSING_END is NOT emitted until all follow-ups are exhausted', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeTextResponse('R1'))
      .mockResolvedValueOnce(makeTextResponse('R2'))
      .mockResolvedValueOnce(makeTextResponse('R3'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    session.follow_up('follow-up-1')
    session.follow_up('follow-up-2')

    const processingEndEvents: SessionEvent[] = []
    session.on(EventKind.PROCESSING_END, (e) => processingEndEvents.push(e))

    await session.processInput('initial')

    expect(complete).toHaveBeenCalledTimes(3)
    expect(processingEndEvents).toHaveLength(1)
  })

  it('follow-up messages are processed FIFO', async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(makeTextResponse('R1'))
      .mockResolvedValueOnce(makeTextResponse('R2'))
      .mockResolvedValueOnce(makeTextResponse('R3'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile(),
      executionEnv: makeEnv(),
    })

    session.follow_up('fu-first')
    session.follow_up('fu-second')

    const inputEvents: SessionEvent[] = []
    session.on(EventKind.USER_INPUT, (e) => inputEvents.push(e))

    await session.processInput('initial')

    expect(inputEvents).toHaveLength(3)
    expect(inputEvents[0]!.data.content).toBe('initial')
    expect(inputEvents[1]!.data.content).toBe('fu-first')
    expect(inputEvents[2]!.data.content).toBe('fu-second')
  })
})

// ---------------------------------------------------------------------------
// Test Suite: Loop detection integration (Story 48-8)
// ---------------------------------------------------------------------------

describe('loop detection integration', () => {
  it('LOOP_DETECTION event is emitted when the same tool is called 10+ times', async () => {
    const tool = makeToolDefinition('looping_tool')
    // LLM returns same tool call many times then completes
    const complete = vi.fn()

    // Return 'looping_tool' call 10 times, then text
    for (let i = 0; i < 10; i++) {
      complete.mockResolvedValueOnce(makeToolCallResponse('looping_tool', `call${i}`, {}))
    }
    complete.mockResolvedValueOnce(makeTextResponse('Done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
      config: makeConfig({ enable_loop_detection: true, loop_detection_window: 10 }),
    })

    const loopEvents: SessionEvent[] = []
    session.on(EventKind.LOOP_DETECTION, (e) => loopEvents.push(e))

    await session.processInput('run loop')

    expect(loopEvents).toHaveLength(1)
    expect(loopEvents[0]!.data.message).toContain('Loop detected')
    expect(loopEvents[0]!.data.message).toContain('10')
    expect(loopEvents[0]!.data.message).toContain('repeating pattern')
  })

  it('LOOP_DETECTION injects SteeringTurn directly into history', async () => {
    const tool = makeToolDefinition('looping_tool')
    const complete = vi.fn()

    for (let i = 0; i < 10; i++) {
      complete.mockResolvedValueOnce(makeToolCallResponse('looping_tool', `call${i}`, {}))
    }
    complete.mockResolvedValueOnce(makeTextResponse('Done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
      config: makeConfig({ enable_loop_detection: true, loop_detection_window: 10 }),
    })

    await session.processInput('run')

    const steeringTurns = session.history.filter((t) => t.type === 'steering')
    const loopWarning = steeringTurns.find(
      (t) => t.type === 'steering' && t.content.includes('Loop detected')
    )
    expect(loopWarning).toBeDefined()
    if (loopWarning?.type === 'steering') {
      expect(loopWarning.content).toContain('repeating pattern')
    }
  })

  it('enable_loop_detection: false suppresses LOOP_DETECTION event even with repeating pattern', async () => {
    const tool = makeToolDefinition('looping_tool')
    const complete = vi.fn()

    for (let i = 0; i < 10; i++) {
      complete.mockResolvedValueOnce(makeToolCallResponse('looping_tool', `call${i}`, {}))
    }
    complete.mockResolvedValueOnce(makeTextResponse('Done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
      config: makeConfig({
        enable_loop_detection: false,
        loop_detection_window: 10,
        max_tool_rounds_per_input: 12, // allow enough rounds
      }),
    })

    const loopEvents: SessionEvent[] = []
    session.on(EventKind.LOOP_DETECTION, (e) => loopEvents.push(e))

    await session.processInput('run no detection')

    expect(loopEvents).toHaveLength(0)
  })

  it('loop detection warning message has correct format', async () => {
    const tool = makeToolDefinition('repeat_tool')
    const windowSize = 6
    const complete = vi.fn()

    for (let i = 0; i < windowSize; i++) {
      complete.mockResolvedValueOnce(makeToolCallResponse('repeat_tool', `c${i}`, {}))
    }
    complete.mockResolvedValueOnce(makeTextResponse('Done'))

    const session = createSession({
      llmClient: makeMockClient(complete),
      providerProfile: makeProfile([tool]),
      executionEnv: makeEnv(),
      config: makeConfig({ enable_loop_detection: true, loop_detection_window: windowSize }),
    })

    const loopEvents: SessionEvent[] = []
    session.on(EventKind.LOOP_DETECTION, (e) => loopEvents.push(e))

    await session.processInput('run')

    expect(loopEvents).toHaveLength(1)
    const expectedMsg = `Loop detected: the last ${windowSize} tool calls follow a repeating pattern. Try a different approach.`
    expect(loopEvents[0]!.data.message).toBe(expectedMsg)
  })
})
