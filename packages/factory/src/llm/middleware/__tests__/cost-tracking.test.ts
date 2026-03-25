// packages/factory/src/llm/middleware/__tests__/cost-tracking.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createCostTrackingMiddleware } from '../cost-tracking.js'
import type { CostRecord } from '../types.js'
import type { LLMRequest, LLMResponse } from '../../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(model = 'claude-opus-4-6'): LLMRequest {
  return {
    model,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
  }
}

function makeResponse(inputTokens = 100, outputTokens = 50, model = 'claude-opus-4-6'): LLMResponse {
  return {
    content: 'test response',
    toolCalls: [],
    usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens },
    model,
    stopReason: 'stop',
    providerMetadata: {},
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCostTrackingMiddleware', () => {
  it('AC3: onCost is called with correct model, provider, tokens, costUsd', async () => {
    const records: CostRecord[] = []
    const mw = createCostTrackingMiddleware({
      onCost: (r) => { records.push(r) },
    })

    await mw(makeRequest('claude-opus-4-6'), async () => makeResponse(100, 50))

    expect(records).toHaveLength(1)
    const rec = records[0]!
    expect(rec.model).toBe('claude-opus-4-6')
    expect(rec.provider).toBe('anthropic')
    expect(rec.inputTokens).toBe(100)
    expect(rec.outputTokens).toBe(50)
    expect(typeof rec.costUsd).toBe('number')
    expect(typeof rec.timestamp).toBe('number')
  })

  it('AC3: costUsd is positive for known model and 0 for unknown model', async () => {
    const knownRecords: CostRecord[] = []
    const unknownRecords: CostRecord[] = []

    const knownMw = createCostTrackingMiddleware({ onCost: (r) => { knownRecords.push(r) } })
    const unknownMw = createCostTrackingMiddleware({ onCost: (r) => { unknownRecords.push(r) } })

    await knownMw(makeRequest('claude-opus-4-6'), async () => makeResponse(100, 50, 'claude-opus-4-6'))
    await unknownMw(makeRequest('unknown-llm-xyz'), async () => makeResponse(100, 50, 'unknown-llm-xyz'))

    expect(knownRecords[0]!.costUsd).toBeGreaterThan(0)
    expect(unknownRecords[0]!.costUsd).toBe(0)
  })

  it('AC3: error in onCost does NOT propagate', async () => {
    const mw = createCostTrackingMiddleware({
      onCost: () => { throw new Error('cost callback failed') },
    })

    // Should not throw despite onCost throwing
    const response = await mw(makeRequest(), async () => makeResponse())
    expect(response.content).toBe('test response')
  })

  it('AC3: response is returned unchanged after onCost', async () => {
    const mw = createCostTrackingMiddleware({ onCost: vi.fn() })
    const expectedResponse = makeResponse(200, 100)

    const result = await mw(makeRequest(), async () => expectedResponse)

    expect(result).toBe(expectedResponse)
  })

  it('AC3: middleware is a no-op (no crash) when onCost is undefined', async () => {
    const mw = createCostTrackingMiddleware()
    const response = makeResponse()

    const result = await mw(makeRequest(), async () => response)
    expect(result).toBe(response)
  })
})
