import { describe, it, expect } from 'vitest'
import type {
  ProviderAdapter,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMUsage,
  LLMToolCall,
  LLMToolDefinition,
  LLMContentPart,
  StreamEvent,
  LLMToolCallData,
  LLMToolResult,
} from '../types.js'

// ---------------------------------------------------------------------------
// MockAdapter — implements ProviderAdapter; TypeScript compile-time verification
// ---------------------------------------------------------------------------
class MockAdapter implements ProviderAdapter {
  readonly name = 'mock'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'hello',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: request.model,
      stopReason: 'stop',
      providerMetadata: {},
    }
  }

  async *stream(_request: LLMRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', delta: 'hello' }
    yield { type: 'message_stop', finishReason: { reason: 'stop' } }
  }
}

// ---------------------------------------------------------------------------
// AC1: ProviderAdapter interface
// ---------------------------------------------------------------------------
describe('ProviderAdapter interface (AC1)', () => {
  it('MockAdapter has a string name property', () => {
    const adapter: ProviderAdapter = new MockAdapter()
    expect(typeof adapter.name).toBe('string')
    expect(adapter.name).toBe('mock')
  })

  it('complete() returns a value satisfying LLMResponse shape', async () => {
    const adapter: ProviderAdapter = new MockAdapter()
    const response = await adapter.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    })
    expect(response.content).toBe('hello')
    expect(response.toolCalls).toEqual([])
    expect(response.stopReason).toBe('stop')
    expect(response.model).toBe('test-model')
    expect(response.providerMetadata).toEqual({})
  })

  it('stream() yields StreamEvent objects', async () => {
    const adapter: ProviderAdapter = new MockAdapter()
    const events: StreamEvent[] = []
    for await (const event of adapter.stream({
      model: 'test-model',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    })) {
      events.push(event)
    }
    expect(events).toHaveLength(2)
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(events[0]!.type).toBe('text_delta')
    expect(events[0]!.delta).toBe('hello')
    expect(events[1]!.type).toBe('message_stop')
  })

  it('optional methods (close, initialize, supportsToolChoice) are not required', () => {
    // MockAdapter does not implement optional methods — TypeScript compile-time check
    const adapter: ProviderAdapter = new MockAdapter()
    expect(adapter.close).toBeUndefined()
    expect(adapter.initialize).toBeUndefined()
    expect(adapter.supportsToolChoice).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC2: LLMRequest — required and optional fields
// ---------------------------------------------------------------------------
describe('LLMRequest type (AC2)', () => {
  it('minimal request requires only model and messages', () => {
    const req: LLMRequest = {
      model: 'claude-opus-4-5',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
    }
    expect(req.model).toBe('claude-opus-4-5')
    expect(req.messages).toHaveLength(1)
  })

  it('maximal request accepts all optional fields', () => {
    const tool: LLMToolDefinition = {
      name: 'search',
      description: 'Search the web',
      parameters: { type: 'object', properties: {} },
    }
    const req: LLMRequest = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hi' }] }],
      systemPrompt: 'You are helpful',
      tools: [tool],
      toolChoice: 'auto',
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: 'high',
      metadata: { sessionId: 'abc123' },
      extra: { anthropicVersion: '2023-06-01' },
    }
    expect(req).toMatchObject({
      model: 'gpt-4o',
      systemPrompt: 'You are helpful',
      toolChoice: 'auto',
      maxTokens: 1024,
      temperature: 0.7,
      reasoningEffort: 'high',
    })
    expect(req.extra?.anthropicVersion).toBe('2023-06-01')
  })

  it('toolChoice can be an object with type:function', () => {
    const req: LLMRequest = {
      model: 'test',
      messages: [],
      toolChoice: { type: 'function', name: 'my_tool' },
    }
    expect(req.toolChoice).toEqual({ type: 'function', name: 'my_tool' })
  })
})

// ---------------------------------------------------------------------------
// AC3: LLMResponse — all required fields
// ---------------------------------------------------------------------------
describe('LLMResponse type (AC3)', () => {
  it('response satisfies all six required fields', () => {
    const response: LLMResponse = {
      content: 'The answer is 42',
      toolCalls: [],
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      model: 'claude-opus-4-5',
      stopReason: 'stop',
      providerMetadata: { requestId: 'req_123' },
    }
    expect(response.content).toBeDefined()
    expect(Array.isArray(response.toolCalls)).toBe(true)
    expect(response.usage).toBeDefined()
    expect(response.model).toBeDefined()
    expect(response.stopReason).toBeDefined()
    expect(response.providerMetadata).toBeDefined()
  })

  it('response accepts optional fields without error', () => {
    const response: LLMResponse = {
      content: 'ok',
      toolCalls: [],
      usage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      model: 'test',
      stopReason: 'length',
      providerMetadata: {},
      id: 'msg_abc',
      finishReason: { reason: 'length', raw: 'max_tokens' },
      warnings: [{ message: 'Temperature capped', code: 'TEMP_CAP' }],
    }
    expect(response.id).toBe('msg_abc')
    expect(response.finishReason?.reason).toBe('length')
    expect(response.warnings?.[0]?.message).toBe('Temperature capped')
  })
})

// ---------------------------------------------------------------------------
// AC4: LLMToolCall — parsed arguments
// ---------------------------------------------------------------------------
describe('LLMToolCall type (AC4)', () => {
  it('toolCall contains id, name, and parsed arguments', () => {
    const tc: LLMToolCall = {
      id: 'call_001',
      name: 'get_weather',
      arguments: { location: 'Paris', unit: 'celsius' },
    }
    expect(tc.id).toBe('call_001')
    expect(tc.name).toBe('get_weather')
    expect(tc.arguments.location).toBe('Paris')
  })

  it('rawArguments is optional — omitting it does not cause an error', () => {
    const tc: LLMToolCall = {
      id: 'call_002',
      name: 'search',
      arguments: { query: 'hello' },
    }
    expect(tc.rawArguments).toBeUndefined()
  })

  it('LLMToolCallData embeds the same shape for content parts', () => {
    const data: LLMToolCallData = {
      id: 'tc_1',
      name: 'run_query',
      arguments: { sql: 'SELECT 1' },
      rawArguments: '{"sql":"SELECT 1"}',
    }
    expect(data.rawArguments).toBe('{"sql":"SELECT 1"}')
  })
})

// ---------------------------------------------------------------------------
// AC5: LLMMessage and LLMRole
// ---------------------------------------------------------------------------
describe('LLMMessage and LLMRole types (AC5)', () => {
  it('constructs a user message with text content part', () => {
    const msg: LLMMessage = {
      role: 'user',
      content: [{ kind: 'text', text: 'Hello!' }],
    }
    expect(msg.role).toBe('user')
    expect(Array.isArray(msg.content)).toBe(true)
    expect(msg.content[0]?.kind).toBe('text')
    expect(msg.content[0]?.text).toBe('Hello!')
  })

  it('constructs an assistant message', () => {
    const msg: LLMMessage = {
      role: 'assistant',
      content: [{ kind: 'text', text: 'How can I help?' }],
    }
    expect(msg.role).toBe('assistant')
  })

  it('constructs a tool role message with toolCallId', () => {
    const msg: LLMMessage = {
      role: 'tool',
      content: [
        { kind: 'tool_result', toolResult: { toolCallId: 'c1', content: 'done', isError: false } },
      ],
      toolCallId: 'c1',
    }
    expect(msg.role).toBe('tool')
    expect(msg.toolCallId).toBe('c1')
  })

  it('LLMContentPart accepts tool_call kind with toolCall field', () => {
    const part: LLMContentPart = {
      kind: 'tool_call',
      toolCall: { id: 'tc_1', name: 'my_tool', arguments: {} },
    }
    expect(part.kind).toBe('tool_call')
    expect(part.toolCall?.name).toBe('my_tool')
  })

  it('constructs a system message', () => {
    const msg: LLMMessage = {
      role: 'system',
      content: [{ kind: 'text', text: 'You are a helpful assistant.' }],
    }
    expect(msg.role).toBe('system')
  })
})

// ---------------------------------------------------------------------------
// AC6: LLMUsage token tracking
// ---------------------------------------------------------------------------
describe('LLMUsage type (AC6)', () => {
  it('minimal usage with only required fields', () => {
    const usage: LLMUsage = {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    }
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBe(50)
    expect(usage.totalTokens).toBe(150)
    expect(usage.reasoningTokens).toBeUndefined()
    expect(usage.cacheReadTokens).toBeUndefined()
    expect(usage.cacheWriteTokens).toBeUndefined()
  })

  it('full usage with all optional fields', () => {
    const usage: LLMUsage = {
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
      reasoningTokens: 40,
      cacheReadTokens: 120,
      cacheWriteTokens: 80,
    }
    expect(usage).toMatchObject({
      inputTokens: 200,
      outputTokens: 80,
      totalTokens: 280,
      reasoningTokens: 40,
      cacheReadTokens: 120,
      cacheWriteTokens: 80,
    })
  })
})

// ---------------------------------------------------------------------------
// Additional: LLMToolResult and LLMToolDefinition shape checks
// ---------------------------------------------------------------------------
describe('LLMToolResult and LLMToolDefinition types', () => {
  it('LLMToolResult accepts string content', () => {
    const result: LLMToolResult = {
      toolCallId: 'c1',
      content: 'Paris, 18°C',
      isError: false,
    }
    expect(result.content).toBe('Paris, 18°C')
    expect(result.isError).toBe(false)
  })

  it('LLMToolDefinition has name, description, and parameters', () => {
    const def: LLMToolDefinition = {
      name: 'calculator',
      description: 'Performs arithmetic',
      parameters: { type: 'object', properties: { expr: { type: 'string' } } },
    }
    expect(def.name).toBe('calculator')
    expect(def.parameters.type).toBe('object')
  })
})
