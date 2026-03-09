/**
 * Telemetry module public API.
 *
 * Re-exports all public types, schemas, and classes from the telemetry module.
 */

export type {
  NormalizedSpan,
  NormalizedLog,
  TokenCounts,
  ModelPricing,
  NormalizedMetric,
  TelemetryBatch,
  TelemetryPersistenceConfig,
  PruneResult,
  TokensByModelRow,
  ChildSpanSummary,
  TurnAnalysis,
  SemanticCategory,
  Trend,
  TopInvocation,
  CategoryStats,
  ConsumerStats,
  ModelEfficiency,
  SourceEfficiency,
  EfficiencyScore,
  RuleId,
  RecommendationSeverity,
  Recommendation,
  RecommenderContext,
  IRecommender,
} from './types.js'

export {
  ChildSpanSummarySchema,
  TurnAnalysisSchema,
  SemanticCategorySchema,
  TrendSchema,
  TopInvocationSchema,
  CategoryStatsSchema,
  ConsumerStatsSchema,
  ModelEfficiencySchema,
  SourceEfficiencySchema,
  EfficiencyScoreSchema,
  RuleIdSchema,
  RecommendationSeveritySchema,
  RecommendationSchema,
} from './types.js'

export type { ITelemetryPersistence } from './persistence.js'
export { TelemetryPersistence } from './persistence.js'

export { IngestionServer, TelemetryError } from './ingestion-server.js'
export type { IngestionServerOptions } from './ingestion-server.js'

export { EfficiencyScorer, createEfficiencyScorer } from './efficiency-scorer.js'
export { Categorizer } from './categorizer.js'
export { ConsumerAnalyzer } from './consumer-analyzer.js'
export { Recommender } from './recommender.js'
