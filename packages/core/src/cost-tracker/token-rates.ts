/**
 * Token rate definitions for cost estimation.
 * Migrated to @substrate-ai/core (Story 41-7)
 *
 * Rates are in USD per 1M tokens (industry standard).
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
    // Story 60-9: opus-4-7 added — same rate card as opus-4-6 ($15/$75 per 1M).
    'claude-opus-4-7': { input_rate: 15.0, output_rate: 75.0 },
    'claude-opus-4-6': { input_rate: 15.0, output_rate: 75.0 },
    'claude-opus-4': { input_rate: 15.0, output_rate: 75.0 },
    'claude-sonnet-4-6': { input_rate: 3.0, output_rate: 15.0 },
    'claude-sonnet-4': { input_rate: 3.0, output_rate: 15.0 },
    'claude-haiku-4-5': { input_rate: 0.8, output_rate: 4.0 },
    'claude-haiku-4-5-20251001': { input_rate: 0.8, output_rate: 4.0 },
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
    codex: { input_rate: 2.5, output_rate: 10.0 },
  },
  google: {
    'gemini-1.5-pro': { input_rate: 1.25, output_rate: 5.0 },
    'gemini-1.5-pro-latest': { input_rate: 1.25, output_rate: 5.0 },
    'gemini-1.5-flash': { input_rate: 0.075, output_rate: 0.3 },
    'gemini-1.5-flash-latest': { input_rate: 0.075, output_rate: 0.3 },
    'gemini-1.0-pro': { input_rate: 0.5, output_rate: 1.5 },
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

function resolveProvider(provider: string): string {
  return PROVIDER_ALIASES[provider.toLowerCase()] ?? provider.toLowerCase()
}

export function getTokenRate(provider: string, model: string, rateTable: TokenRates = TOKEN_RATES): ModelRates | null {
  const canonicalProvider = resolveProvider(provider)
  const providerRates = rateTable[canonicalProvider]
  if (!providerRates) return null

  const exactMatch = providerRates[model]
  if (exactMatch) return exactMatch

  const lowerModel = model.toLowerCase()
  for (const [key, rates] of Object.entries(providerRates)) {
    if (key.toLowerCase() === lowerModel) return rates
  }

  return null
}

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
