/**
 * Barrel export for telemetry types, Zod schemas, interfaces, and implementations.
 *
 * Story 40-7 added types/schemas.
 * Story 41-6a adds all implementation modules (BatchBuffer, TelemetryNormalizer,
 * TelemetryPipeline, IngestionServer, and pure utility modules).
 */

// Types and Zod schemas (includes OtlpSource, DispatchContext, RawOtlpPayload,
// ITelemetryPersistence, IRecommender, RecommenderContext, ModelPricing, etc.)
export * from './types.js'

// Pure utility modules
export { COST_TABLE, estimateCost, resolveModel } from './cost-table.js'
export { normalizeTimestamp } from './timestamp-normalizer.js'
export { detectSource } from './source-detector.js'
// OtlpSource is already exported from types.js; source-detector re-exports it
// but the barrel export from types.js takes precedence.
export {
  extractTokensFromAttributes,
  extractTokensFromBody,
  mergeTokenCounts,
} from './token-extractor.js'

// BatchBuffer
export { BatchBuffer } from './batch-buffer.js'
export type { BatchBufferOptions } from './batch-buffer.js'

// TelemetryNormalizer
export { TelemetryNormalizer } from './normalizer.js'

// TelemetryPipeline with duck-typed scoring interfaces
export { TelemetryPipeline } from './telemetry-pipeline.js'
export type {
  TelemetryPipelineDeps,
  ITurnAnalyzer,
  ILogTurnAnalyzer,
  ICategorizer,
  IConsumerAnalyzer,
  IEfficiencyScorer,
} from './telemetry-pipeline.js'

// IngestionServer
export { IngestionServer, TelemetryError } from './ingestion-server.js'
export type { IngestionServerOptions } from './ingestion-server.js'
// DispatchContext is already exported from types.js (canonical source);
// ingestion-server re-exports it but barrel deduplication handles this.

// Scoring module implementations (story 41-6b)
export { TurnAnalyzer } from './turn-analyzer.js'
export { LogTurnAnalyzer } from './log-turn-analyzer.js'
export { Categorizer } from './categorizer.js'
export { ConsumerAnalyzer } from './consumer-analyzer.js'
export { EfficiencyScorer, createEfficiencyScorer } from './efficiency-scorer.js'
export { Recommender } from './recommender.js'

// Task baselines (story 41-6b — required by EfficiencyScorer)
export { getBaseline, TASK_BASELINES, DEFAULT_BASELINE } from './task-baselines.js'
export type { TaskBaseline } from './task-baselines.js'
