// packages/factory/src/llm/middleware/__tests__/retry.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createRetryMiddleware, isRetryable } from '../retry.js'
import { LLMError, type LLMRequest, type LLMResponse } from '../../types.js'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeRequest(model = 'claude-opus-4-6'): LLMRequest {
  return {
    model,
    messages: [{ role: 'user', content: [{ kind: 'text', text: 'hello' }] }],
  }
}

function makeResponse(): LLMResponse {
  return {
    content: 'ok',
    toolCalls: [],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    model: 'claude-opus-4-6',
    stopReason: 'stop',
    providerMetadata: {},
  }
}

function makeHttpError(statusCode: number, message = `HTTP ${statusCode}`): LLMError {
  return new LLMError(message, statusCode, 'test')
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isRetryable', () => {
  it('returns true for statusCode 500', () => {
    expect(isRetryable(makeHttpError(500))).toBe(true)
  })

  it('returns false for statusCode 400', () => {
    expect(isRetryable(makeHttpError(400))).toBe(false)
  })

  it('returns true for statusCode 429', () => {
    expect(isRetryable(makeHttpError(429))).toBe(true)
  })

  it('returns true for statusCode 502 and 503', () => {
    expect(isRetryable(makeHttpError(502))).toBe(true)
    expect(isRetryable(makeHttpError(503))).toBe(true)
  })

  it('returns false for statusCode 401', () => {
    expect(isRetryable(makeHttpError(401))).toBe(false)
  })

  it('returns false for non-Error values', () => {
    expect(isRetryable('string error')).toBe(false)
    expect(isRetryable(null)).toBe(false)
    expect(isRetryable(new Error('no statusCode'))).toBe(false)
  })
})

describe('createRetryMiddleware', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('AC4: retries twice on 429 then returns success', async () => {
    const mw = createRetryMiddleware({ maxRetries: 2, baseDelayMs: 1000, factor: 2 })
    const next = vi
      .fn()
      .mockRejectedValueOnce(makeHttpError(429))
      .mockRejectedValueOnce(makeHttpError(429))
      .mockResolvedValueOnce(makeResponse())

    const promise = mw(makeRequest(), next)

    // Advance timers for retry delays
    await vi.runAllTimersAsync()

    const result = await promise
    expect(next).toHaveBeenCalledTimes(3)
    expect(result.content).toBe('ok')
  })

  it('AC4: re-throws after maxRetries exhausted', async () => {
    const err = makeHttpError(429)
    const mw = createRetryMiddleware({ maxRetries: 2, baseDelayMs: 100, factor: 2 })
    const next = vi.fn().mockRejectedValue(err)

    // Attach catch handler immediately to avoid unhandled rejection warning
    let caughtError: unknown
    const promise = mw(makeRequest(), next).catch((e) => {
      caughtError = e
    })
    await vi.runAllTimersAsync()
    await promise

    expect(caughtError).toBeDefined()
    expect((caughtError as Error).message).toBe('HTTP 429')
    expect(next).toHaveBeenCalledTimes(3) // 1 initial + 2 retries
  })

  it('AC5: does NOT retry on 400 (immediate re-throw)', async () => {
    const err = makeHttpError(400)
    const mw = createRetryMiddleware({ maxRetries: 2, baseDelayMs: 1000, factor: 2 })
    const next = vi.fn().mockRejectedValue(err)

    await expect(mw(makeRequest(), next)).rejects.toThrow('HTTP 400')
    expect(next).toHaveBeenCalledTimes(1) // No retry
  })

  it('AC5: does NOT retry on 401', async () => {
    const err = makeHttpError(401)
    const mw = createRetryMiddleware({ maxRetries: 2, baseDelayMs: 1000, factor: 2 })
    const next = vi.fn().mockRejectedValue(err)

    await expect(mw(makeRequest(), next)).rejects.toThrow('HTTP 401')
    expect(next).toHaveBeenCalledTimes(1)
  })

  it('AC4: delay between retries uses exponential backoff', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const mw = createRetryMiddleware({ maxRetries: 2, baseDelayMs: 1000, factor: 2 })
    const next = vi
      .fn()
      .mockRejectedValueOnce(makeHttpError(500))
      .mockRejectedValueOnce(makeHttpError(500))
      .mockResolvedValueOnce(makeResponse())

    const promise = mw(makeRequest(), next)
    await vi.runAllTimersAsync()
    await promise

    // Filter to only the retry delay calls (1000ms and 2000ms)
    const delayCalls = setTimeoutSpy.mock.calls
      .map(([, delay]) => delay)
      .filter((d) => d !== undefined && d > 0)

    expect(delayCalls).toContain(1000) // attempt 0: 1000 * 2^0
    expect(delayCalls).toContain(2000) // attempt 1: 1000 * 2^1

    setTimeoutSpy.mockRestore()
  })

  it('AC4: respects custom maxRetries=0 (no retry at all)', async () => {
    const err = makeHttpError(429)
    const mw = createRetryMiddleware({ maxRetries: 0 })
    const next = vi.fn().mockRejectedValue(err)

    await expect(mw(makeRequest(), next)).rejects.toThrow()
    expect(next).toHaveBeenCalledTimes(1) // Only the initial attempt, no retries
  })
})
