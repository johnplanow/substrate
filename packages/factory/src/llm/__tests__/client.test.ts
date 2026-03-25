// packages/factory/src/llm/__tests__/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LLMClient } from '../client.js'
import type { ProviderAdapter, LLMRequest, LLMResponse } from '../types.js'

function makeMockAdapter(name: string): ProviderAdapter {
  return {
    name,
    complete: vi.fn().mockResolvedValue({
      content: 'ok',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      model: name,
      stopReason: 'stop',
      providerMetadata: {},
    } satisfies LLMResponse),
    stream: vi.fn().mockReturnValue(
      (async function* () {
        yield { type: 'text_delta', delta: 'hello' }
      })(),
    ),
  }
}

const BASE_REQUEST: LLMRequest = {
  model: '',
  messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
}

describe('LLMClient', () => {
  describe('constructor with pre-populated adapters', () => {
    it('registers all provided adapters and routes correctly', async () => {
      const anthropicMock = makeMockAdapter('anthropic')
      const client = new LLMClient({ anthropic: anthropicMock })
      const req = { ...BASE_REQUEST, model: 'claude-sonnet-4-5' }
      await client.complete(req)
      expect(anthropicMock.complete).toHaveBeenCalledWith(req)
    })
  })

  describe('AC1: routing to Anthropic adapter', () => {
    it('routes claude-* models to the anthropic adapter', async () => {
      const anthropicMock = makeMockAdapter('anthropic')
      const client = new LLMClient({ anthropic: anthropicMock })
      const req = { ...BASE_REQUEST, model: 'claude-sonnet-4-5' }
      const result = await client.complete(req)
      expect(anthropicMock.complete).toHaveBeenCalledWith(req)
      expect(result.content).toBe('ok')
    })
  })

  describe('AC2: routing to OpenAI and Gemini adapters', () => {
    let openaiMock: ProviderAdapter
    let geminiMock: ProviderAdapter
    let client: LLMClient

    beforeEach(() => {
      openaiMock = makeMockAdapter('openai')
      geminiMock = makeMockAdapter('gemini')
      client = new LLMClient({ openai: openaiMock, gemini: geminiMock })
    })

    it('routes gpt-* models to the openai adapter', async () => {
      const req = { ...BASE_REQUEST, model: 'gpt-4o' }
      await client.complete(req)
      expect(openaiMock.complete).toHaveBeenCalledWith(req)
    })

    it('routes gemini-* models to the gemini adapter', async () => {
      const req = { ...BASE_REQUEST, model: 'gemini-2.0-flash' }
      await client.complete(req)
      expect(geminiMock.complete).toHaveBeenCalledWith(req)
    })

    it('routes o-series (o3-mini) to the openai adapter', async () => {
      const req = { ...BASE_REQUEST, model: 'o3-mini' }
      await client.complete(req)
      expect(openaiMock.complete).toHaveBeenCalledWith(req)
    })
  })

  describe('AC3: unknown model throws descriptive error', () => {
    it('throws with model name and registered providers in message', async () => {
      const client = new LLMClient({
        anthropic: makeMockAdapter('anthropic'),
        openai: makeMockAdapter('openai'),
      })
      const req = { ...BASE_REQUEST, model: 'unknown-model-xyz' }
      await expect(client.complete(req)).rejects.toThrow('unknown-model-xyz')
    })

    it('lists registered provider names in the error', async () => {
      const client = new LLMClient({
        anthropic: makeMockAdapter('anthropic'),
        openai: makeMockAdapter('openai'),
      })
      const req = { ...BASE_REQUEST, model: 'unknown-model-xyz' }
      await expect(client.complete(req)).rejects.toThrow(/anthropic|openai/)
    })

    it('throws when provider pattern matches but adapter not registered', async () => {
      // Register a pattern pointing to 'gemini' but do NOT register a gemini adapter
      const client = new LLMClient({ anthropic: makeMockAdapter('anthropic') })
      client.registerModelPattern('gemini-*', 'gemini')
      const req = { ...BASE_REQUEST, model: 'gemini-2.0-flash' }
      await expect(client.complete(req)).rejects.toThrow(/gemini/)
    })
  })

  describe('AC4: registerProvider on empty client', () => {
    it('routing works after registerProvider call', async () => {
      const client = new LLMClient()
      const anthropicMock = makeMockAdapter('anthropic')
      client.registerProvider('anthropic', anthropicMock)
      const req = { ...BASE_REQUEST, model: 'claude-haiku-3-5' }
      await client.complete(req)
      expect(anthropicMock.complete).toHaveBeenCalledWith(req)
    })

    it('non-matching model still throws after single registerProvider', async () => {
      const client = new LLMClient()
      client.registerProvider('anthropic', makeMockAdapter('anthropic'))
      const req = { ...BASE_REQUEST, model: 'gpt-4o' }
      // gpt-4o matches openai pattern by default but openai adapter is not registered
      await expect(client.complete(req)).rejects.toThrow(/gpt-4o|openai/)
    })
  })

  describe('AC5: registerModelPattern custom overrides', () => {
    it('routes custom pattern to the registered adapter', async () => {
      const customMock = makeMockAdapter('custom')
      const client = new LLMClient({ custom: customMock })
      client.registerModelPattern('my-model-*', 'custom')
      const req = { ...BASE_REQUEST, model: 'my-model-v1' }
      await client.complete(req)
      expect(customMock.complete).toHaveBeenCalledWith(req)
    })

    it('custom pattern takes precedence over default patterns', async () => {
      const customMock = makeMockAdapter('custom')
      const anthropicMock = makeMockAdapter('anthropic')
      const client = new LLMClient({ custom: customMock, anthropic: anthropicMock })
      // Override 'claude-*' to go to 'custom'
      client.registerModelPattern('claude-*', 'custom')
      const req = { ...BASE_REQUEST, model: 'claude-sonnet-4-5' }
      await client.complete(req)
      expect(customMock.complete).toHaveBeenCalledWith(req)
      expect(anthropicMock.complete).not.toHaveBeenCalled()
    })

    it('custom pattern matching is case-insensitive', async () => {
      const customMock = makeMockAdapter('custom')
      const client = new LLMClient({ custom: customMock })
      client.registerModelPattern('my-model-*', 'custom')
      const req = { ...BASE_REQUEST, model: 'MY-MODEL-V1' }
      await client.complete(req)
      expect(customMock.complete).toHaveBeenCalledWith(req)
    })
  })

  describe('AC6: stream() delegates to correct adapter', () => {
    it('stream routes claude-haiku-3-5 to anthropic adapter', async () => {
      const anthropicMock = makeMockAdapter('anthropic')
      const client = new LLMClient({ anthropic: anthropicMock })
      const req = { ...BASE_REQUEST, model: 'claude-haiku-3-5' }
      const events: unknown[] = []
      for await (const event of client.stream(req)) {
        events.push(event)
      }
      expect(anthropicMock.stream).toHaveBeenCalledWith(req)
      expect(events.length).toBeGreaterThan(0)
    })
  })

  describe('48-5b AC7: use() registers middleware applied to complete()', () => {
    it('middleware receives request and can observe response', async () => {
      const anthropicMock = makeMockAdapter('anthropic')
      const client = new LLMClient({ anthropic: anthropicMock })
      const req = { ...BASE_REQUEST, model: 'claude-sonnet-4-5' }

      const observedModels: string[] = []
      const mw = vi.fn(async (request: LLMRequest, next: (r: LLMRequest) => Promise<LLMResponse>) => {
        observedModels.push(request.model)
        return next(request)
      })

      client.use(mw)
      const result = await client.complete(req)

      expect(mw).toHaveBeenCalledTimes(1)
      expect(observedModels).toContain('claude-sonnet-4-5')
      expect(result.content).toBe('ok')
    })

    it('use() returns this for chaining', () => {
      const client = new LLMClient()
      const mw = vi.fn(async (_req: LLMRequest, next: (r: LLMRequest) => Promise<LLMResponse>) => next(_req))
      const returned = client.use(mw)
      expect(returned).toBe(client)
    })

    it('multiple middlewares execute in correct onion order (first registered = outermost)', async () => {
      const anthropicMock = makeMockAdapter('anthropic')
      const client = new LLMClient({ anthropic: anthropicMock })
      const req = { ...BASE_REQUEST, model: 'claude-sonnet-4-5' }

      const order: string[] = []
      const outerMw = vi.fn(async (request: LLMRequest, next: (r: LLMRequest) => Promise<LLMResponse>) => {
        order.push('outer-before')
        const res = await next(request)
        order.push('outer-after')
        return res
      })
      const innerMw = vi.fn(async (request: LLMRequest, next: (r: LLMRequest) => Promise<LLMResponse>) => {
        order.push('inner-before')
        const res = await next(request)
        order.push('inner-after')
        return res
      })

      client.use(outerMw).use(innerMw)
      await client.complete(req)

      expect(order).toEqual(['outer-before', 'inner-before', 'inner-after', 'outer-after'])
    })
  })
})
