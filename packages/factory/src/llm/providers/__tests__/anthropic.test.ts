// packages/factory/src/llm/providers/__tests__/anthropic.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'
import type { LLMRequest } from '../../types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockFetch(response: object, status = 200, headers: Record<string, string> = {}): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
    json: () => Promise.resolve(response),
  } as unknown as Response)
}

const MOCK_RESPONSE = {
  id: 'msg_123',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello, world!' }],
  model: 'claude-sonnet-4-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
}

const MINIMAL_REQUEST: LLMRequest = {
  model: 'claude-sonnet-4-5',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
}

// ---------------------------------------------------------------------------
// AC1: Complete Request Returns Normalized LLMResponse
// ---------------------------------------------------------------------------
describe('AC1: complete() returns normalized LLMResponse', () => {
  it('returns LLMResponse with all required fields on success', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)

    expect(response.content).toBe('Hello, world!')
    expect(response.stopReason).toBe('stop')
    expect(response.usage.inputTokens).toBe(10)
    expect(response.usage.outputTokens).toBe(5)
    expect(response.usage.totalTokens).toBe(15)
    expect(response.model).toBe('claude-sonnet-4-5')
    expect(Array.isArray(response.toolCalls)).toBe(true)
    expect(response.providerMetadata).toBeDefined()
  })

  it('stores raw response in providerMetadata.raw', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)

    expect(response.providerMetadata.raw).toEqual(MOCK_RESPONSE)
  })

  it('sends POST to /v1/messages endpoint', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete(MINIMAL_REQUEST)

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/v1/messages'),
      expect.objectContaining({ method: 'POST' })
    )
  })
})

// ---------------------------------------------------------------------------
// AC2: Strict Message Alternation Enforcement
// ---------------------------------------------------------------------------
describe('AC2: message alternation enforcement', () => {
  it('merges consecutive user messages into one', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: [{ kind: 'text', text: 'First message' }] },
        { role: 'user', content: [{ kind: 'text', text: 'Second message' }] },
      ],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.messages).toHaveLength(1)
    expect(callBody.messages[0].role).toBe('user')
    expect(callBody.messages[0].content).toHaveLength(2)
    expect(callBody.messages[0].content[0].text).toBe('First message')
    expect(callBody.messages[0].content[1].text).toBe('Second message')
  })

  it('does not merge alternating user/assistant/user messages', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'user', content: [{ kind: 'text', text: 'User 1' }] },
        { role: 'assistant', content: [{ kind: 'text', text: 'Assistant 1' }] },
        { role: 'user', content: [{ kind: 'text', text: 'User 2' }] },
      ],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.messages).toHaveLength(3)
    expect(callBody.messages[0].role).toBe('user')
    expect(callBody.messages[1].role).toBe('assistant')
    expect(callBody.messages[2].role).toBe('user')
  })
})

// ---------------------------------------------------------------------------
// AC3: max_tokens Default Injection
// ---------------------------------------------------------------------------
describe('AC3: max_tokens default injection', () => {
  it('sets max_tokens to 4096 when maxTokens is not specified', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete(MINIMAL_REQUEST)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.max_tokens).toBe(4096)
  })

  it('uses the provided maxTokens value when specified', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({ ...MINIMAL_REQUEST, maxTokens: 1024 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.max_tokens).toBe(1024)
  })
})

// ---------------------------------------------------------------------------
// AC4: 429 Retry with Exponential Backoff
// ---------------------------------------------------------------------------
describe('AC4: 429 retry with exponential backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries on 429 and returns successful response', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: { get: (k: string) => k.toLowerCase() === 'retry-after' ? '0' : null },
        json: () => Promise.resolve({}),
      } as unknown as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve(MOCK_RESPONSE),
      } as unknown as Response)

    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const completePromise = adapter.complete(MINIMAL_REQUEST)
    // Advance timers to handle the backoff sleep
    await vi.runAllTimersAsync()

    const response = await completePromise
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(response.content).toBe('Hello, world!')
  })

  it('throws after max retries (3 consecutive 429s)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: { get: (k: string) => k.toLowerCase() === 'retry-after' ? '0' : null },
      json: () => Promise.resolve({}),
    } as unknown as Response)

    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const completePromise = adapter.complete(MINIMAL_REQUEST)
    // Attach rejection handler BEFORE running timers to avoid unhandled rejection warning
    const assertion = expect(completePromise).rejects.toThrow('[anthropic] Rate limit exceeded after 3 retries')
    await vi.runAllTimersAsync()
    await assertion
    // 4 calls total: initial + 3 retries
    expect(mockFetch).toHaveBeenCalledTimes(4)
  })
})

// ---------------------------------------------------------------------------
// AC5: Automatic Prompt Caching
// ---------------------------------------------------------------------------
describe('AC5: automatic prompt caching via cache_control', () => {
  it('adds cache_control to last system block when systemPrompt is present', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      ...MINIMAL_REQUEST,
      systemPrompt: 'You are a helpful assistant.',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    const lastBlock = callBody.system[callBody.system.length - 1]
    expect(lastBlock.cache_control).toEqual({ type: 'ephemeral' })
  })

  it('includes prompt-caching-2024-07-31 in anthropic-beta header when caching is injected', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      ...MINIMAL_REQUEST,
      systemPrompt: 'You are a helpful assistant.',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callHeaders = (mockFetch as any).mock.calls[0][1].headers as Record<string, string>
    expect(callHeaders['anthropic-beta']).toContain('prompt-caching-2024-07-31')
  })

  it('does NOT inject cache_control when auto_cache is false', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      ...MINIMAL_REQUEST,
      systemPrompt: 'You are a helpful assistant.',
      extra: { anthropic: { auto_cache: false } },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    const lastBlock = callBody.system[callBody.system.length - 1]
    expect(lastBlock.cache_control).toBeUndefined()
  })

  it('does NOT include anthropic-beta header when no caching is injected and auto_cache is false', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      ...MINIMAL_REQUEST,
      systemPrompt: 'Prompt',
      extra: { anthropic: { auto_cache: false } },
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callHeaders = (mockFetch as any).mock.calls[0][1].headers as Record<string, string>
    expect(callHeaders['anthropic-beta']).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC6: Tool Definition Translation
// ---------------------------------------------------------------------------
describe('AC6: tool definition translation and toolChoice handling', () => {
  it('translates LLMToolDefinition to Anthropic format with input_schema', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      ...MINIMAL_REQUEST,
      tools: [
        {
          name: 'search',
          description: 'Search the web',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
      ],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.tools).toHaveLength(1)
    expect(callBody.tools[0].name).toBe('search')
    expect(callBody.tools[0].description).toBe('Search the web')
    expect(callBody.tools[0].input_schema).toEqual({ type: 'object', properties: { query: { type: 'string' } } })
  })

  it('omits tools from request body when toolChoice is "none"', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      ...MINIMAL_REQUEST,
      tools: [
        { name: 'search', description: 'Search', parameters: {} },
      ],
      toolChoice: 'none',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.tools).toBeUndefined()
    expect(callBody.tool_choice).toBeUndefined()
  })

  it('maps toolChoice "required" to { type: "any" }', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      ...MINIMAL_REQUEST,
      tools: [{ name: 'search', description: 'Search', parameters: {} }],
      toolChoice: 'required',
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.tool_choice).toEqual({ type: 'any' })
  })
})

// ---------------------------------------------------------------------------
// AC7: Stop Reason and Usage Mapping
// ---------------------------------------------------------------------------
describe('AC7: stop reason and usage mapping', () => {
  it('maps stop_reason "tool_use" to stopReason "tool_calls"', async () => {
    const toolUseResponse = {
      ...MOCK_RESPONSE,
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          id: 'call_001',
          name: 'search',
          input: { query: 'hello' },
        },
      ],
    }
    const mockFetch = makeMockFetch(toolUseResponse)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)

    expect(response.stopReason).toBe('tool_calls')
  })

  it('populates cacheReadTokens and cacheWriteTokens from response usage', async () => {
    const cacheResponse = {
      ...MOCK_RESPONSE,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 200,
      },
    }
    const mockFetch = makeMockFetch(cacheResponse)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)

    expect(response.usage.cacheReadTokens).toBe(500)
    expect(response.usage.cacheWriteTokens).toBe(200)
    expect(response.usage.inputTokens).toBe(100)
    expect(response.usage.outputTokens).toBe(50)
  })

  it('maps stop_reason "max_tokens" to stopReason "length"', async () => {
    const maxTokensResponse = { ...MOCK_RESPONSE, stop_reason: 'max_tokens' }
    const mockFetch = makeMockFetch(maxTokensResponse)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)
    expect(response.stopReason).toBe('length')
  })

  it('maps stop_reason "end_turn" to stopReason "stop"', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE) // stop_reason: end_turn
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)
    expect(response.stopReason).toBe('stop')
  })

  it('maps unknown stop_reason to "other"', async () => {
    const unknownResponse = { ...MOCK_RESPONSE, stop_reason: 'unknown_future_reason' }
    const mockFetch = makeMockFetch(unknownResponse)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)
    expect(response.stopReason).toBe('other')
  })
})

// ---------------------------------------------------------------------------
// Additional edge case tests
// ---------------------------------------------------------------------------
describe('AnthropicAdapter additional behavior', () => {
  it('sets correct headers including x-api-key and anthropic-version', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'my-secret-key', fetch: mockFetch })

    await adapter.complete(MINIMAL_REQUEST)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const headers = (mockFetch as any).mock.calls[0][1].headers as Record<string, string>
    expect(headers['x-api-key']).toBe('my-secret-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('extracts tool calls from response content', async () => {
    const responseWithToolUse = {
      ...MOCK_RESPONSE,
      stop_reason: 'tool_use',
      content: [
        { type: 'tool_use', id: 'tc_001', name: 'calculator', input: { expr: '2+2' } },
      ],
    }
    const mockFetch = makeMockFetch(responseWithToolUse)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    const response = await adapter.complete(MINIMAL_REQUEST)
    expect(response.toolCalls).toHaveLength(1)
    const tc = response.toolCalls[0]!
    expect(tc.id).toBe('tc_001')
    expect(tc.name).toBe('calculator')
    expect(tc.arguments).toEqual({ expr: '2+2' })
    expect(tc.rawArguments).toBe('{"expr":"2+2"}')
  })

  it('throws with status and message on non-2xx error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      headers: { get: () => null },
      json: () => Promise.resolve({ error: { message: 'invalid model' } }),
    } as unknown as Response)

    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })
    await expect(adapter.complete(MINIMAL_REQUEST)).rejects.toThrow('[anthropic] 400: invalid model')
  })

  it('filters system messages from messages array (handled via system param)', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })

    await adapter.complete({
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: [{ kind: 'text', text: 'You are helpful.' }] },
        { role: 'user', content: [{ kind: 'text', text: 'Hello' }] },
      ],
    })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const callBody = JSON.parse((mockFetch as any).mock.calls[0][1].body as string)
    expect(callBody.messages).toHaveLength(1)
    expect(callBody.messages[0].role).toBe('user')
  })

  it('stream() throws not-yet-implemented error', async () => {
    const adapter = new AnthropicAdapter({ apiKey: 'test-key' })
    const iter = adapter.stream(MINIMAL_REQUEST)[Symbol.asyncIterator]()
    await expect(iter.next()).rejects.toThrow('streaming not yet implemented')
  })

  it('uses custom baseUrl when provided', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({
      apiKey: 'test-key',
      baseUrl: 'https://my-proxy.example.com',
      fetch: mockFetch,
    })

    await adapter.complete(MINIMAL_REQUEST)

    expect(mockFetch).toHaveBeenCalledWith(
      'https://my-proxy.example.com/v1/messages',
      expect.any(Object)
    )
  })
})
