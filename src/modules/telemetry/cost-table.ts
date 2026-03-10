/**
 * Cost table for LLM model pricing.
 *
 * Provides per-million-token rates for known models and an `estimateCost()`
 * function that computes cost from a TokenCounts object.
 *
 * Cache reads use the explicit `cacheReadPerMToken` from the table (already
 * pre-discounted to 10% of input rate for Anthropic models).
 *
 * Returns 0 for unknown models without throwing.
 */

import type { TokenCounts, ModelPricing } from './types.js'

// ---------------------------------------------------------------------------
// COST_TABLE
// ---------------------------------------------------------------------------

/**
 * Per-million-token pricing for known LLM models.
 * All prices are in USD.
 */
export const COST_TABLE: Record<string, ModelPricing> = {
  'claude-3-opus-20240229': {
    inputPerMToken: 15.0,
    outputPerMToken: 75.0,
    cacheReadPerMToken: 1.5,
    cacheCreationPerMToken: 18.75,
  },
  'claude-3-5-sonnet-20241022': {
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheReadPerMToken: 0.3,
    cacheCreationPerMToken: 3.75,
  },
  'claude-3-5-haiku-20241022': {
    inputPerMToken: 0.8,
    outputPerMToken: 4.0,
    cacheReadPerMToken: 0.08,
    cacheCreationPerMToken: 1.0,
  },
  'claude-3-haiku-20240307': {
    inputPerMToken: 0.25,
    outputPerMToken: 1.25,
    cacheReadPerMToken: 0.03,
    cacheCreationPerMToken: 0.3,
  },
  'claude-3-sonnet-20240229': {
    inputPerMToken: 3.0,
    outputPerMToken: 15.0,
    cacheReadPerMToken: 0.3,
    cacheCreationPerMToken: 3.75,
  },
  'gpt-4': {
    inputPerMToken: 30.0,
    outputPerMToken: 60.0,
    cacheReadPerMToken: 3.0,
    cacheCreationPerMToken: 30.0,
  },
  'gpt-4-turbo': {
    inputPerMToken: 10.0,
    outputPerMToken: 30.0,
    cacheReadPerMToken: 1.0,
    cacheCreationPerMToken: 10.0,
  },
  'gpt-3.5-turbo': {
    inputPerMToken: 0.5,
    outputPerMToken: 1.5,
    cacheReadPerMToken: 0.05,
    cacheCreationPerMToken: 0.5,
  },
}

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

/**
 * Resolve a model string to a key in COST_TABLE.
 * Returns the matched key, or undefined if not found.
 *
 * Performs exact match first, then case-insensitive substring match.
 */
export function resolveModel(model: string): string | undefined {
  // Exact match
  if (model in COST_TABLE) {
    return model
  }

  // Case-insensitive exact match
  const lower = model.toLowerCase()
  for (const key of Object.keys(COST_TABLE)) {
    if (key.toLowerCase() === lower) {
      return key
    }
  }

  // Substring match (model string contains the key or key contains the model string)
  for (const key of Object.keys(COST_TABLE)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return key
    }
  }

  return undefined
}

// ---------------------------------------------------------------------------
// estimateCost
// ---------------------------------------------------------------------------

/**
 * Estimate the cost in USD for a set of token counts and a model identifier.
 *
 * - Uses `cacheReadPerMToken` from the table directly (already discounted).
 * - Returns 0 for unknown models without throwing.
 *
 * @param model - Model identifier string (exact or fuzzy match against COST_TABLE)
 * @param tokens - Token counts object
 * @returns Estimated cost in USD
 */
export function estimateCost(model: string, tokens: TokenCounts): number {
  const resolvedKey = resolveModel(model)
  if (resolvedKey === undefined) {
    return 0
  }

  const pricing = COST_TABLE[resolvedKey]
  const perM = 1_000_000

  const inputCost = (tokens.input / perM) * pricing.inputPerMToken
  const outputCost = (tokens.output / perM) * pricing.outputPerMToken
  const cacheReadCost = (tokens.cacheRead / perM) * pricing.cacheReadPerMToken
  const cacheCreationCost = (tokens.cacheCreation / perM) * pricing.cacheCreationPerMToken

  return inputCost + outputCost + cacheReadCost + cacheCreationCost
}
