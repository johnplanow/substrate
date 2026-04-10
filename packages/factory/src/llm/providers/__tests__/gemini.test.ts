// packages/factory/src/llm/providers/__tests__/gemini.test.ts
// Unit tests for GeminiAdapter — covers AC1 through AC7.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeminiAdapter } from '../gemini.js'
import type { LLMRequest } from '../../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

const MOCK_GEMINI_RESPONSE = {
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: 'Hello, world!' }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
  },
}

function makeMinimalRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'gemini-3-flash-preview',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hi' }] }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC1: Adapter Construction and Authentication
// ---------------------------------------------------------------------------

describe('GeminiAdapter — AC1: Construction and Authentication', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['GEMINI_API_KEY']
    delete process.env['GOOGLE_API_KEY']
    vi.unstubAllGlobals()
  })

  it('constructs with GEMINI_API_KEY from environment', () => {
    const adapter = new GeminiAdapter()
    expect(adapter.name).toBe('gemini')
  })

  it('falls back to GOOGLE_API_KEY when GEMINI_API_KEY is absent', () => {
    delete process.env['GEMINI_API_KEY']
    process.env['GOOGLE_API_KEY'] = 'test-google-key'
    expect(() => new GeminiAdapter()).not.toThrow()
  })

  it('throws when neither GEMINI_API_KEY nor GOOGLE_API_KEY is present', () => {
    delete process.env['GEMINI_API_KEY']
    expect(() => new GeminiAdapter()).toThrow('GEMINI_API_KEY')
  })

  it('uses explicit apiKey option over environment variable', () => {
    process.env['GEMINI_API_KEY'] = 'env-key'
    // Should not throw — explicit key takes precedence
    expect(() => new GeminiAdapter({ apiKey: 'explicit-key' })).not.toThrow()
  })

  it('uses key query parameter in URL (not Authorization header)', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter({ apiKey: 'my-api-key' })
    await adapter.complete(makeMinimalRequest())
    const [url, init] = vi.mocked(fetch).mock.calls[0]!
    expect(String(url)).toContain('key=my-api-key')
    expect((init as RequestInit).headers).not.toHaveProperty('Authorization')
  })
})

// ---------------------------------------------------------------------------
// AC2: System Prompt Extraction to systemInstruction
// ---------------------------------------------------------------------------

describe('GeminiAdapter — AC2: System Prompt to systemInstruction', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['GEMINI_API_KEY']
    vi.unstubAllGlobals()
  })

  it('sends systemPrompt as systemInstruction with text part', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()
    await adapter.complete(makeMinimalRequest({ systemPrompt: 'You are helpful.' }))

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      systemInstruction?: { parts: Array<{ text: string }> }
      contents: Array<{ role: string }>
    }
    expect(body.systemInstruction?.parts[0]?.text).toBe('You are helpful.')
  })

  it('does not include a system-role entry in contents', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()
    await adapter.complete(makeMinimalRequest({ systemPrompt: 'Be concise.' }))

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      contents: Array<{ role: string }>
    }
    expect(body.contents.every((c) => c.role !== 'system')).toBe(true)
  })

  it('omits systemInstruction when systemPrompt is not set', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()
    await adapter.complete(makeMinimalRequest())

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      systemInstruction?: unknown
    }
    expect(body.systemInstruction).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC3: Message Array Translation to Gemini contents Format
// ---------------------------------------------------------------------------

describe('GeminiAdapter — AC3: Message Translation to contents', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['GEMINI_API_KEY']
    vi.unstubAllGlobals()
  })

  it('translates user messages to role "user" with text parts', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()
    await adapter.complete(
      makeMinimalRequest({
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      contents: Array<{ role: string; parts: Array<{ text?: string }> }>
    }
    expect(body.contents[0]?.role).toBe('user')
    expect(body.contents[0]?.parts[0]?.text).toBe('Hello')
  })

  it('translates assistant messages to role "model"', async () => {
    const assistantResponse = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hi' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 },
    }
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(assistantResponse))
    const adapter = new GeminiAdapter()
    await adapter.complete(
      makeMinimalRequest({
        messages: [
          { role: 'user', content: [{ kind: 'text', text: 'Hi' }] },
          { role: 'assistant', content: [{ kind: 'text', text: 'Hello back' }] },
          { role: 'user', content: [{ kind: 'text', text: 'Thanks' }] },
        ],
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      contents: Array<{ role: string }>
    }
    expect(body.contents[1]?.role).toBe('model')
  })

  it('translates tool-result messages to role "user" with functionResponse', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()

    await adapter.complete(
      makeMinimalRequest({
        messages: [
          { role: 'user', content: [{ kind: 'text', text: 'What is the weather?' }] },
          {
            role: 'assistant',
            content: [
              {
                kind: 'tool_call',
                toolCall: {
                  id: 'call_abc123',
                  name: 'get_weather',
                  arguments: { location: 'NYC' },
                },
              },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                kind: 'tool_result',
                toolResult: {
                  toolCallId: 'call_abc123',
                  content: '{"temp": 72, "unit": "F"}',
                  isError: false,
                },
              },
            ],
          },
        ],
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      contents: Array<{
        role: string
        parts: Array<{ functionResponse?: { name: string; response: Record<string, unknown> } }>
      }>
    }

    const toolResultContent = body.contents[2]
    expect(toolResultContent?.role).toBe('user')
    expect(toolResultContent?.parts[0]?.functionResponse?.name).toBe('get_weather')
    expect(toolResultContent?.parts[0]?.functionResponse?.response).toEqual({ temp: 72, unit: 'F' })
  })
})

// ---------------------------------------------------------------------------
// AC4: Synthetic Tool Call ID Generation
// ---------------------------------------------------------------------------

describe('GeminiAdapter — AC4: Synthetic Tool Call ID Generation', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['GEMINI_API_KEY']
    vi.unstubAllGlobals()
  })

  it('generates synthetic IDs starting with "call_" for each function call', async () => {
    const responseWithTools = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'search', args: { query: 'AI' } } },
              { functionCall: { name: 'fetch', args: { url: 'https://example.com' } } },
            ],
          },
          // No finishReason — function calls present
        },
      ],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(responseWithTools))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.toolCalls).toHaveLength(2)
    expect(result.toolCalls[0]!.id).toMatch(/^call_/)
    expect(result.toolCalls[1]!.id).toMatch(/^call_/)
  })

  it('generates distinct synthetic IDs for multiple function calls', async () => {
    const responseWithTools = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { functionCall: { name: 'tool_a', args: {} } },
              { functionCall: { name: 'tool_b', args: {} } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(responseWithTools))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.toolCalls[0]!.id).not.toBe(result.toolCalls[1]!.id)
  })

  it('preserves function name and arguments in LLMToolCall', async () => {
    const responseWithTool = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'my_func', args: { key: 'value', num: 42 } } }],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(responseWithTool))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.toolCalls[0]!.name).toBe('my_func')
    expect(result.toolCalls[0]!.arguments).toEqual({ key: 'value', num: 42 })
  })
})

// ---------------------------------------------------------------------------
// AC5: complete() Returns Normalized LLMResponse with Correct Stop Reason
// ---------------------------------------------------------------------------

describe('GeminiAdapter — AC5: complete() Stop Reason and Content', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['GEMINI_API_KEY']
    vi.unstubAllGlobals()
  })

  it('maps finishReason STOP to stopReason "stop" with correct content', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'This is the answer.' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.stopReason).toBe('stop')
    expect(result.content).toBe('This is the answer.')
  })

  it('maps finishReason MAX_TOKENS to stopReason "length"', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Partial...' }] },
          finishReason: 'MAX_TOKENS',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 100 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.stopReason).toBe('length')
  })

  it('maps finishReason SAFETY to stopReason "content_filter"', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [] },
          finishReason: 'SAFETY',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.stopReason).toBe('content_filter')
  })

  it('maps finishReason RECITATION to stopReason "content_filter"', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [] },
          finishReason: 'RECITATION',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 0 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.stopReason).toBe('content_filter')
  })

  it('infers stopReason "tool_calls" when functionCall parts present and no finishReason', async () => {
    const response = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'search', args: { q: 'test' } } }],
          },
          // No finishReason
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.stopReason).toBe('tool_calls')
  })

  it('overrides stop reason to "tool_calls" when functionCall parts are present even with STOP', async () => {
    const response = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ functionCall: { name: 'do_thing', args: {} } }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.stopReason).toBe('tool_calls')
  })

  it('filters out thought parts from content', async () => {
    const response = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{ text: 'Thinking...', thought: true }, { text: 'Visible answer.' }],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.content).toBe('Visible answer.')
    expect(result.content).not.toContain('Thinking...')
  })

  it('throws on non-2xx HTTP status with error message', async () => {
    const errorBody = { error: { message: 'API key invalid' } }
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(errorBody, 401))

    const adapter = new GeminiAdapter()
    await expect(adapter.complete(makeMinimalRequest())).rejects.toThrow('[gemini] 401')
  })
})

// ---------------------------------------------------------------------------
// AC6: Usage Token Extraction
// ---------------------------------------------------------------------------

describe('GeminiAdapter — AC6: Usage Token Extraction', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['GEMINI_API_KEY']
    vi.unstubAllGlobals()
  })

  it('extracts basic token counts from usageMetadata', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Hi' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        totalTokenCount: 150,
      },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.usage.inputTokens).toBe(100)
    expect(result.usage.outputTokens).toBe(50)
    expect(result.usage.totalTokens).toBe(150)
  })

  it('includes reasoningTokens when thoughtsTokenCount is present and > 0', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Result' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 300,
        cachedContentTokenCount: 50,
      },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.usage.reasoningTokens).toBe(300)
    expect(result.usage.cacheReadTokens).toBe(50)
  })

  it('omits reasoningTokens when thoughtsTokenCount is absent', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Result' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        // no thoughtsTokenCount
      },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.usage.reasoningTokens).toBeUndefined()
    expect(result.usage.cacheReadTokens).toBeUndefined()
  })

  it('omits reasoningTokens when thoughtsTokenCount is 0', async () => {
    const response = {
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'Result' }] },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 0,
      },
    }

    vi.mocked(fetch).mockResolvedValue(makeMockResponse(response))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.usage.reasoningTokens).toBeUndefined()
  })

  it('does not include cacheWriteTokens (Gemini caching is automatic)', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()
    const result = await adapter.complete(makeMinimalRequest())

    expect(result.usage.cacheWriteTokens).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// AC7: Tool Definition Translation and Tool Choice Mapping
// ---------------------------------------------------------------------------

describe('GeminiAdapter — AC7: Tool Definition and Tool Choice Mapping', () => {
  beforeEach(() => {
    process.env['GEMINI_API_KEY'] = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['GEMINI_API_KEY']
    vi.unstubAllGlobals()
  })

  it('wraps tool definitions in functionDeclarations array', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()

    await adapter.complete(
      makeMinimalRequest({
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            parameters: { type: 'object', properties: { q: { type: 'string' } } },
          },
        ],
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      tools?: Array<{ functionDeclarations: Array<{ name: string }> }>
    }
    expect(body.tools).toHaveLength(1)
    expect(body.tools![0]!.functionDeclarations).toHaveLength(1)
    expect(body.tools![0]!.functionDeclarations[0]!.name).toBe('search')
  })

  it('maps toolChoice "auto" to AUTO mode', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()

    await adapter.complete(
      makeMinimalRequest({
        tools: [{ name: 'foo', description: 'desc', parameters: {} }],
        toolChoice: 'auto',
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      toolConfig?: { functionCallingConfig: { mode: string } }
    }
    expect(body.toolConfig?.functionCallingConfig.mode).toBe('AUTO')
  })

  it('maps toolChoice "none" to NONE mode', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()

    await adapter.complete(
      makeMinimalRequest({
        tools: [{ name: 'foo', description: 'desc', parameters: {} }],
        toolChoice: 'none',
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      toolConfig?: { functionCallingConfig: { mode: string } }
    }
    expect(body.toolConfig?.functionCallingConfig.mode).toBe('NONE')
  })

  it('maps toolChoice "required" to ANY mode', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()

    await adapter.complete(
      makeMinimalRequest({
        tools: [{ name: 'foo', description: 'desc', parameters: {} }],
        toolChoice: 'required',
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      toolConfig?: { functionCallingConfig: { mode: string } }
    }
    expect(body.toolConfig?.functionCallingConfig.mode).toBe('ANY')
  })

  it('maps specific function toolChoice to ANY mode with allowedFunctionNames', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()

    await adapter.complete(
      makeMinimalRequest({
        tools: [{ name: 'foo', description: 'desc', parameters: {} }],
        toolChoice: { type: 'function', name: 'foo' },
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      toolConfig?: {
        functionCallingConfig: {
          mode: string
          allowedFunctionNames?: string[]
        }
      }
    }
    expect(body.toolConfig?.functionCallingConfig.mode).toBe('ANY')
    expect(body.toolConfig?.functionCallingConfig.allowedFunctionNames).toEqual(['foo'])
  })

  it('omits toolConfig when toolChoice is undefined', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()

    await adapter.complete(
      makeMinimalRequest({
        tools: [{ name: 'foo', description: 'desc', parameters: {} }],
        // No toolChoice
      })
    )

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as {
      toolConfig?: unknown
    }
    expect(body.toolConfig).toBeUndefined()
  })
})
