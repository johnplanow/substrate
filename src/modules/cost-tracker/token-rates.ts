/**
 * Token rates — shim re-exporting from @substrate-ai/core (Story 41-7).
 *
 * Note: `estimateCost` here is the cost-tracker variant (provider, model, inputTokens, outputTokens, rateTable?).
 * The @substrate-ai/core root barrel exports `estimateCostForProvider` as the alias for this variant,
 * while `estimateCost` at the root barrel is the telemetry version (model, tokens).
 */
export type { ModelRates, TokenRates } from '@substrate-ai/core'
export {
  TOKEN_RATES,
  PROVIDER_ALIASES,
  getTokenRate,
  estimateCostForProvider as estimateCost,
  estimateCostSafe,
} from '@substrate-ai/core'
