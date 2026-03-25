// packages/factory/src/llm/middleware/cost-tracking.ts
import { estimateCostSafe, TOKEN_RATES } from '@substrate-ai/core'
import type { TokenRates } from '@substrate-ai/core'
import type { LLMRequest, LLMResponse } from '../types.js'
import { deriveProvider, type MiddlewareFn, type CostRecord } from './types.js'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CostTrackingOptions {
  onCost?: (record: CostRecord) => void | Promise<void>
  tokenRates?: TokenRates
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCostTrackingMiddleware(options?: CostTrackingOptions): MiddlewareFn {
  const tokenRates = options?.tokenRates ?? TOKEN_RATES
  const onCost = options?.onCost

  return async (request: LLMRequest, next): Promise<LLMResponse> => {
    const response = await next(request)

    const provider = deriveProvider(request.model)
    const inputTokens = response.usage.inputTokens
    const outputTokens = response.usage.outputTokens
    const costUsd = estimateCostSafe(provider, request.model, inputTokens, outputTokens, tokenRates)

    if (onCost) {
      try {
        await onCost({
          model: request.model,
          provider,
          inputTokens,
          outputTokens,
          costUsd,
          timestamp: Date.now(),
        })
      } catch {
        // Cost tracking is non-critical — swallow errors silently
      }
    }

    return response
  }
}
