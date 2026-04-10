// packages/factory/src/llm/middleware/retry.ts
import { LLMError, type LLMRequest, type LLMResponse } from '../types.js'
import type { MiddlewareFn } from './types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface RetryOptions {
  maxRetries?: number
  baseDelayMs?: number
  factor?: number
}

// ---------------------------------------------------------------------------
// Retryable check
// ---------------------------------------------------------------------------

/**
 * Returns true if the error represents a retryable HTTP status code.
 * Retryable: 429 (rate-limit), 500 (server error), 502 (bad gateway), 503 (service unavailable).
 * Non-retryable: 400, 401, 403, 404, and other 4xx codes.
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof LLMError) {
    return err.statusCode === 429 || err.statusCode >= 500
  }
  return false
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRetryMiddleware(options?: RetryOptions): MiddlewareFn {
  const maxRetries = options?.maxRetries ?? 2
  const baseDelayMs = options?.baseDelayMs ?? 1000
  const factor = options?.factor ?? 2

  return async (request: LLMRequest, next): Promise<LLMResponse> => {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next(request)
      } catch (err) {
        lastError = err
        if (!isRetryable(err) || attempt === maxRetries) throw err
        await new Promise<void>((resolve) =>
          setTimeout(resolve, baseDelayMs * Math.pow(factor, attempt))
        )
      }
    }
    throw lastError
  }
}
