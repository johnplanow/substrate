/**
 * Token rate definitions for cost estimation.
 *
 * Rates are in USD per 1M tokens (industry standard).
 * Covers major providers and models as of Feb 2026.
 *
 * Architecture Section 9: Token Rates & Budget Enforcement.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelRates {
  /** USD per 1M input tokens */
  input_rate: number
  /** USD per 1M output tokens */
  output_rate: number
}

/**
 * Token rate table indexed by provider -> model -> rates.
 */
export type TokenRates = Record<string, Record<string, ModelRates>>

// ---------------------------------------------------------------------------
// Built-in rate table
// ---------------------------------------------------------------------------

/**
 * Default built-in token rates (USD per 1M tokens).
 * Update quarterly as provider pricing changes.
 */
export const TOKEN_RATES: TokenRates = {
  anthropic: {
    'claude-3-opus-20240229': { input_rate: 15.0, output_rate: 75.0 },
    'claude-3-opus': { input_rate: 15.0, output_rate: 75.0 },
    'claude-3-5-sonnet-20241022': { input_rate: 3.0, output_rate: 15.0 },
    'claude-3-5-sonnet-20240620': { input_rate: 3.0, output_rate: 15.0 },
    'claude-3-sonnet-20240229': { input_rate: 3.0, output_rate: 15.0 },
    'claude-3-sonnet': { input_rate: 3.0, output_rate: 15.0 },
    'claude-3-haiku-20240307': { input_rate: 0.25, output_rate: 1.25 },
    'claude-3-haiku': { input_rate: 0.25, output_rate: 1.25 },
    'claude-3-5-haiku-20241022': { input_rate: 0.8, output_rate: 4.0 },
    'claude-3-5-haiku': { input_rate: 0.8, output_rate: 4.0 },
    // Claude 4.x models (Feb 2026 pricing, USD per 1M tokens)
    'claude-opus-4-6': { input_rate: 15.0, output_rate: 75.0 },
    'claude-opus-4': { input_rate: 15.0, output_rate: 75.0 },
    'claude-sonnet-4-6': { input_rate: 3.0, output_rate: 15.0 },
    'claude-sonnet-4': { input_rate: 3.0, output_rate: 15.0 },
    'claude-haiku-4-5': { input_rate: 0.8, output_rate: 4.0 },
    'claude-haiku-4-5-20251001': { input_rate: 0.8, output_rate: 4.0 },
    // Alias: "claude" without version maps to sonnet
    claude: { input_rate: 3.0, output_rate: 15.0 },
  },
  openai: {
    'gpt-4o': { input_rate: 2.5, output_rate: 10.0 },
    'gpt-4o-mini': { input_rate: 0.15, output_rate: 0.6 },
    'gpt-4-turbo': { input_rate: 10.0, output_rate: 30.0 },
    'gpt-4-turbo-preview': { input_rate: 10.0, output_rate: 30.0 },
    'gpt-4': { input_rate: 30.0, output_rate: 60.0 },
    'gpt-3.5-turbo': { input_rate: 0.5, output_rate: 1.5 },
    'gpt-3.5-turbo-0125': { input_rate: 0.5, output_rate: 1.5 },
    // Alias: "codex" maps to gpt-4o
    codex: { input_rate: 2.5, output_rate: 10.0 },
  },
  google: {
    'gemini-1.5-pro': { input_rate: 1.25, output_rate: 5.0 },
    'gemini-1.5-pro-latest': { input_rate: 1.25, output_rate: 5.0 },
    'gemini-1.5-flash': { input_rate: 0.075, output_rate: 0.3 },
    'gemini-1.5-flash-latest': { input_rate: 0.075, output_rate: 0.3 },
    'gemini-1.0-pro': { input_rate: 0.5, output_rate: 1.5 },
    // Alias: "gemini" maps to gemini-1.5-pro
    gemini: { input_rate: 1.25, output_rate: 5.0 },
  },
}

/**
 * Provider aliases: maps CLI agent names to canonical provider names.
 */
export const PROVIDER_ALIASES: Record<string, string> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
}

// ---------------------------------------------------------------------------
// Functions
// ---------------------------------------------------------------------------

/**
 * Resolve a provider alias to its canonical name.
 * Returns the original string if no alias found.
 */
function resolveProvider(provider: string): string {
  return PROVIDER_ALIASES[provider.toLowerCase()] ?? provider.toLowerCase()
}

/**
 * Look up token rates for a provider and model.
 *
 * Performs case-insensitive lookup and resolves provider aliases.
 * Returns null if the provider or model is not found in the rate table.
 *
 * @param provider - Provider name or alias (e.g., 'claude', 'anthropic', 'openai')
 * @param model - Model name (e.g., 'claude-3-opus-20240229', 'gpt-4')
 * @param rateTable - Optional custom rate table; defaults to TOKEN_RATES
 * @returns ModelRates or null if not found
 */
export function getTokenRate(provider: string, model: string, rateTable: TokenRates = TOKEN_RATES): ModelRates | null {
  const canonicalProvider = resolveProvider(provider)
  const providerRates = rateTable[canonicalProvider]
  if (!providerRates) return null

  // Try exact match first
  const exactMatch = providerRates[model]
  if (exactMatch) return exactMatch

  // Try case-insensitive match
  const lowerModel = model.toLowerCase()
  for (const [key, rates] of Object.entries(providerRates)) {
    if (key.toLowerCase() === lowerModel) return rates
  }

  return null
}

/**
 * Estimate the total USD cost for a given number of input and output tokens.
 *
 * Rates are in USD per 1M tokens, so:
 *   cost = (inputTokens * input_rate + outputTokens * output_rate) / 1_000_000
 *
 * @param provider - Provider name or alias
 * @param model - Model name
 * @param inputTokens - Number of input (prompt) tokens
 * @param outputTokens - Number of output (completion) tokens
 * @param rateTable - Optional custom rate table; defaults to TOKEN_RATES
 * @returns Total estimated USD cost
 * @throws {Error} if the provider/model is not in the rate table
 */
export function estimateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  rateTable: TokenRates = TOKEN_RATES,
): number {
  const rates = getTokenRate(provider, model, rateTable)
  if (!rates) {
    throw new Error(
      `Token rates not found for provider="${provider}" model="${model}". ` +
        `Available providers: ${Object.keys(rateTable).join(', ')}`,
    )
  }

  const inputCost = (inputTokens * rates.input_rate) / 1_000_000
  const outputCost = (outputTokens * rates.output_rate) / 1_000_000
  return inputCost + outputCost
}

/**
 * Estimate the cost for a given request, returning 0 if the provider/model is not found.
 * This is the safe (non-throwing) variant for use in cost recording paths.
 *
 * @param provider - Provider name or alias
 * @param model - Model name
 * @param inputTokens - Number of input tokens
 * @param outputTokens - Number of output tokens
 * @param rateTable - Optional custom rate table; defaults to TOKEN_RATES
 * @returns Estimated cost in USD, or 0 if rates are unavailable
 */
export function estimateCostSafe(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  rateTable: TokenRates = TOKEN_RATES,
): number {
  try {
    return estimateCost(provider, model, inputTokens, outputTokens, rateTable)
  } catch {
    return 0
  }
}
