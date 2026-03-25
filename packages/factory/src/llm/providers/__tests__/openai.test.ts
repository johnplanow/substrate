// packages/factory/src/llm/providers/__tests__/openai.test.ts
// Unit tests for OpenAIAdapter — covers AC1 through AC7.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIAdapter } from '../openai.js'
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

function makeSuccessResponse(overrides: Partial<{
  id: string
  model: string
  status: string
  output: unknown[]
  usage: unknown
}> = {}): unknown {
  return {
    id: 'resp_test_1',
    model: 'gpt-5.2',
    status: 'completed',
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Hello there!' }],
      },
    ],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
    },
    ...overrides,
  }
}

function makeMinimalRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'gpt-5.2',
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hi' }] }],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('OpenAIAdapter', () => {
  beforeEach(() => {
    process.env['OPENAI_API_KEY'] = 'sk-test-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env['OPENAI_API_KEY']
    delete process.env['OPENAI_BASE_URL']
    delete process.env['OPENAI_ORG_ID']
    delete process.env['OPENAI_PROJECT_ID']
    vi.unstubAllGlobals()
  })

  // -------------------------------------------------------------------------
  // AC1: Construction and Authentication
  // -------------------------------------------------------------------------

  describe('AC1: Construction and Authentication', () => {
    it('constructs with OPENAI_API_KEY from environment', () => {
      const adapter = new OpenAIAdapter()
      expect(adapter.name).toBe('openai')
    })

    it('throws when no API key is found', () => {
      delete process.env['OPENAI_API_KEY']
      expect(() => new OpenAIAdapter()).toThrow('OPENAI_API_KEY')
    })

    it('explicit apiKey option overrides env var', async () => {
      const adapter = new OpenAIAdapter({ apiKey: 'sk-explicit-key' })
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      await adapter.complete(makeMinimalRequest())
      const callArgs = vi.mocked(fetch).mock.calls[0]
      expect(callArgs).toBeDefined()
      const headers = callArgs![1]?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer sk-explicit-key')
    })

    it('reads OPENAI_BASE_URL from environment', async () => {
      process.env['OPENAI_BASE_URL'] = 'https://custom.api.example.com/v1'
      const adapter = new OpenAIAdapter()
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      await adapter.complete(makeMinimalRequest())
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string
      expect(url).toBe('https://custom.api.example.com/v1/responses')
    })

    it('strips trailing slash from baseUrl', async () => {
      const adapter = new OpenAIAdapter({ baseUrl: 'https://api.openai.com/v1/' })
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      await adapter.complete(makeMinimalRequest())
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string
      expect(url).toBe('https://api.openai.com/v1/responses')
    })

    it('includes OpenAI-Organization header when orgId is provided', async () => {
      process.env['OPENAI_ORG_ID'] = 'org-test-123'
      const adapter = new OpenAIAdapter()
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      await adapter.complete(makeMinimalRequest())
      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>
      expect(headers['OpenAI-Organization']).toBe('org-test-123')
    })

    it('includes OpenAI-Project header when projectId is provided', async () => {
      const adapter = new OpenAIAdapter({ projectId: 'proj-abc' })
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      await adapter.complete(makeMinimalRequest())
      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>
      expect(headers['OpenAI-Project']).toBe('proj-abc')
    })
  })

  // -------------------------------------------------------------------------
  // AC2: System prompt → instructions field
  // -------------------------------------------------------------------------

  describe('AC2: System prompt extraction to instructions', () => {
    it('sends systemPrompt as instructions field and omits it from input array', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
        systemPrompt: 'You are a helpful assistant.',
      })
      const callArgs = vi.mocked(fetch).mock.calls[0]
      const body = JSON.parse(callArgs![1]!.body as string) as Record<string, unknown>
      expect(body['instructions']).toBe('You are a helpful assistant.')
      const input = body['input'] as Array<{ role?: string }>
      expect(input.every(item => item.role !== 'system')).toBe(true)
    })

    it('does not set instructions when systemPrompt is absent', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete(makeMinimalRequest())
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'instructions')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // AC3: Message array translation
  // -------------------------------------------------------------------------

  describe('AC3: Message array translation to Responses API input format', () => {
    it('translates user messages to { type:"message", role:"user" } with input_text content', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello world' }] }],
      })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      const input = body['input'] as Array<Record<string, unknown>>
      expect(input).toHaveLength(1)
      expect(input[0]).toMatchObject({ type: 'message', role: 'user' })
      const content = input[0]!['content'] as Array<{ type: string; text: string }>
      expect(content[0]).toMatchObject({ type: 'input_text', text: 'Hello world' })
    })

    it('translates tool-result messages to function_call_output', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'tool',
            toolCallId: 'call_abc_123',
            content: [{ kind: 'text', text: 'Result data' }],
          },
        ],
      })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      const input = body['input'] as Array<Record<string, unknown>>
      expect(input[0]).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_abc_123',
        output: 'Result data',
      })
    })

    it('extracts toolCallId from tool_result content part when msg.toolCallId is absent', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [
          {
            role: 'tool',
            content: [
              {
                kind: 'tool_result',
                toolResult: { toolCallId: 'call_from_part', content: 'tool output', isError: false },
              },
            ],
          },
        ],
      })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      const input = body['input'] as Array<Record<string, unknown>>
      expect(input[0]).toMatchObject({
        type: 'function_call_output',
        call_id: 'call_from_part',
        output: 'tool output',
      })
    })

    it('translates assistant messages to { type:"message", role:"assistant" } with output_text content', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [
          { role: 'user', content: [{ kind: 'text', text: 'Question' }] },
          { role: 'assistant', content: [{ kind: 'text', text: 'Answer' }] },
        ],
      })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      const input = body['input'] as Array<Record<string, unknown>>
      expect(input[1]).toMatchObject({ type: 'message', role: 'assistant' })
      const content = input[1]!['content'] as Array<{ type: string; text: string }>
      expect(content[0]).toMatchObject({ type: 'output_text', text: 'Answer' })
    })

    it('skips system-role messages from input array', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [
          { role: 'system', content: [{ kind: 'text', text: 'System context' }] },
          { role: 'user', content: [{ kind: 'text', text: 'Hello' }] },
        ],
      })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      const input = body['input'] as Array<{ role?: string }>
      expect(input.every(item => item.role !== 'system')).toBe(true)
      expect(input).toHaveLength(1)
    })
  })

  // -------------------------------------------------------------------------
  // AC4: Tool definitions and tool choice
  // -------------------------------------------------------------------------

  describe('AC4: Tool definition and tool choice translation', () => {
    it('translates tool definitions to Responses API format', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Use a tool' }] }],
        tools: [
          {
            name: 'get_weather',
            description: 'Get current weather',
            parameters: { type: 'object', properties: { location: { type: 'string' } } },
          },
        ],
        toolChoice: 'required',
      })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      const tools = body['tools'] as Array<Record<string, unknown>>
      expect(tools[0]).toMatchObject({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get current weather',
        },
      })
      expect(body['tool_choice']).toBe('required')
    })

    it('maps object toolChoice { type:"function", name } to correct format', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({
        model: 'gpt-5.2',
        messages: [{ role: 'user', content: [{ kind: 'text', text: 'Pick a tool' }] }],
        tools: [{ name: 'my_tool', description: 'A tool', parameters: {} }],
        toolChoice: { type: 'function', name: 'my_tool' },
      })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['tool_choice']).toEqual({ type: 'function', function: { name: 'my_tool' } })
    })

    it('omits tool_choice field when toolChoice is undefined', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete(makeMinimalRequest())
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'tool_choice')).toBe(false)
    })

    it('maps "auto" toolChoice to "auto"', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({ ...makeMinimalRequest(), toolChoice: 'auto' })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['tool_choice']).toBe('auto')
    })
  })

  // -------------------------------------------------------------------------
  // AC5: complete() returns normalized LLMResponse
  // -------------------------------------------------------------------------

  describe('AC5: complete() returns normalized LLMResponse', () => {
    it('returns correct content, model, and stopReason for a text response', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        model: 'gpt-5.2',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Hello there!' }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.content).toBe('Hello there!')
      expect(response.model).toBe('gpt-5.2')
      expect(response.stopReason).toBe('stop')
      expect(response.toolCalls).toHaveLength(0)
    })

    it('parses function_call output items into toolCalls with id, name, arguments', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_xyz_789',
            name: 'get_weather',
            arguments: '{"location":"Paris","unit":"celsius"}',
          },
        ],
        usage: { input_tokens: 15, output_tokens: 10 },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.toolCalls).toHaveLength(1)
      const tc = response.toolCalls[0]!
      expect(tc.id).toBe('call_xyz_789')
      expect(tc.name).toBe('get_weather')
      expect(tc.arguments).toEqual({ location: 'Paris', unit: 'celsius' })
      expect(tc.rawArguments).toBe('{"location":"Paris","unit":"celsius"}')
      expect(response.stopReason).toBe('tool_calls')
    })

    it('maps incomplete status with max_output_tokens to "length" stopReason', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        status: 'incomplete',
        output: [],
        usage: { input_tokens: 5, output_tokens: 100 },
      })))
      // We need incomplete_details in the response
      const incompleteBody = {
        id: 'resp_test',
        model: 'gpt-5.2',
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [],
        usage: { input_tokens: 5, output_tokens: 100 },
      }
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(incompleteBody))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.stopReason).toBe('length')
    })

    it('concatenates text from multiple output_text items', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse({
        id: 'resp_multi',
        model: 'gpt-5.2',
        status: 'completed',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: 'Hello ' },
              { type: 'output_text', text: 'world!' },
            ],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3 },
      }))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.content).toBe('Hello world!')
    })

    it('throws on non-2xx HTTP status', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(
        { error: { message: 'Invalid API key' } },
        401
      ))
      const adapter = new OpenAIAdapter()
      await expect(adapter.complete(makeMinimalRequest())).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // AC6: Usage token extraction including reasoning and cache tokens
  // -------------------------------------------------------------------------

  describe('AC6: Usage token extraction', () => {
    it('correctly maps inputTokens, outputTokens, and totalTokens', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        usage: { input_tokens: 100, output_tokens: 50 },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.usage.inputTokens).toBe(100)
      expect(response.usage.outputTokens).toBe(50)
      expect(response.usage.totalTokens).toBe(150)
    })

    it('extracts reasoningTokens from output_tokens_details', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        usage: {
          input_tokens: 200,
          output_tokens: 80,
          output_tokens_details: { reasoning_tokens: 500 },
        },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.usage.reasoningTokens).toBe(500)
    })

    it('omits reasoningTokens when output_tokens_details is absent', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        usage: { input_tokens: 50, output_tokens: 20 },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(Object.prototype.hasOwnProperty.call(response.usage, 'reasoningTokens')).toBe(false)
    })

    it('extracts cacheReadTokens from input_tokens_details.cached_tokens', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        usage: {
          input_tokens: 300,
          output_tokens: 60,
          input_tokens_details: { cached_tokens: 150 },
        },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.usage.cacheReadTokens).toBe(150)
    })

    it('omits cacheReadTokens when input_tokens_details is absent', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        usage: { input_tokens: 50, output_tokens: 20 },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(Object.prototype.hasOwnProperty.call(response.usage, 'cacheReadTokens')).toBe(false)
    })

    it('omits cacheWriteTokens (OpenAI uses automatic server-side caching)', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse({
        usage: { input_tokens: 100, output_tokens: 40 },
      })))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(Object.prototype.hasOwnProperty.call(response.usage, 'cacheWriteTokens')).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // AC7: Reasoning effort pass-through
  // -------------------------------------------------------------------------

  describe('AC7: Reasoning effort pass-through', () => {
    it('includes reasoning.effort in request body when reasoningEffort is set', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({ ...makeMinimalRequest(), reasoningEffort: 'high' })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['reasoning']).toEqual({ effort: 'high' })
    })

    it('omits reasoning field entirely when reasoningEffort is undefined', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete(makeMinimalRequest()) // no reasoningEffort
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'reasoning')).toBe(false)
    })

    it('supports "low" reasoning effort', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({ ...makeMinimalRequest(), reasoningEffort: 'low' })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['reasoning']).toEqual({ effort: 'low' })
    })

    it('supports "medium" reasoning effort', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({ ...makeMinimalRequest(), reasoningEffort: 'medium' })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['reasoning']).toEqual({ effort: 'medium' })
    })
  })

  // -------------------------------------------------------------------------
  // Additional: Request body field mapping
  // -------------------------------------------------------------------------

  describe('Request body field mapping', () => {
    it('maps maxTokens to max_output_tokens', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({ ...makeMinimalRequest(), maxTokens: 2048 })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['max_output_tokens']).toBe(2048)
    })

    it('maps temperature to request body', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({ ...makeMinimalRequest(), temperature: 0.7 })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['temperature']).toBe(0.7)
    })

    it('merges provider-namespaced extra.openai fields into request body', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete({ ...makeMinimalRequest(), extra: { openai: { custom_field: 'custom_value' } } })
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string) as Record<string, unknown>
      expect(body['custom_field']).toBe('custom_value')
    })

    it('sends POST to /responses endpoint', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete(makeMinimalRequest())
      const url = vi.mocked(fetch).mock.calls[0]?.[0] as string
      expect(url).toMatch(/\/responses$/)
      const opts = vi.mocked(fetch).mock.calls[0]?.[1]
      expect(opts?.method).toBe('POST')
    })

    it('sets Authorization header with Bearer token', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse(makeSuccessResponse()))
      const adapter = new OpenAIAdapter()
      await adapter.complete(makeMinimalRequest())
      const headers = vi.mocked(fetch).mock.calls[0]?.[1]?.headers as Record<string, string>
      expect(headers['Authorization']).toBe('Bearer sk-test-key')
    })
  })

  // -------------------------------------------------------------------------
  // Defensive: malformed tool call arguments
  // -------------------------------------------------------------------------

  describe('Defensive parsing', () => {
    it('sets arguments to {} when tool call arguments are invalid JSON', async () => {
      vi.mocked(fetch).mockResolvedValue(makeMockResponse({
        id: 'resp_test',
        model: 'gpt-5.2',
        status: 'completed',
        output: [
          {
            type: 'function_call',
            call_id: 'call_bad',
            name: 'bad_tool',
            arguments: 'not valid json',
          },
        ],
        usage: { input_tokens: 5, output_tokens: 3 },
      }))
      const adapter = new OpenAIAdapter()
      const response = await adapter.complete(makeMinimalRequest())
      expect(response.toolCalls[0]!.arguments).toEqual({})
      expect(response.toolCalls[0]!.rawArguments).toBe('not valid json')
    })
  })
})
