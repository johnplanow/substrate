/**
 * Recommendation Types — shim re-exporting from @substrate-ai/core (Story 41-7).
 *
 * Note: `Recommendation` here is the monitor's interface (distinct from telemetry's Zod-inferred type).
 * It is accessible from @substrate-ai/core as `MonitorRecommendation` (the alias resolves the conflict).
 */
export type {
  ConfidenceLevel,
  MonitorRecommendation as Recommendation,
  RecommendationFilters,
  RecommendationExport,
} from '@substrate-ai/core'
export { createRecommendation } from '@substrate-ai/core'
