/**
 * Telemetry module type definitions.
 *
 * Defines all Zod schemas and derived TypeScript types for the telemetry
 * pipeline: normalized OTLP spans and logs, turn analysis, semantic
 * categorization, context consumers, and efficiency scoring.
 *
 * All types are Zod-first: schemas are defined first, TypeScript types
 * are derived via `z.infer<>`, and Zod is used for DB read boundary validation.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// NormalizedSpan
// ---------------------------------------------------------------------------

/**
 * A normalized OTLP span — source-agnostic representation of an LLM API call
 * or tool invocation, as produced by the TelemetryNormalizer (story 27-2).
 */
export interface NormalizedSpan {
  spanId: string
  traceId: string
  parentSpanId?: string
  name: string
  /** Source: 'claude-code' | 'codex' | 'local-llm' | 'unknown' */
  source: string
  model?: string
  provider?: string
  operationName?: string
  storyKey?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  durationMs: number
  /** Unix milliseconds */
  startTime: number
  /** Unix milliseconds */
  endTime?: number
  attributes?: Record<string, unknown>
  events?: unknown[]
}

// ---------------------------------------------------------------------------
// NormalizedLog
// ---------------------------------------------------------------------------

/**
 * A normalized OTLP log record (story 27-2).
 */
export interface NormalizedLog {
  logId: string
  traceId?: string
  spanId?: string
  /** Unix milliseconds */
  timestamp: number
  severity?: string
  body?: string
  eventName?: string
  sessionId?: string
  toolName?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
  model?: string
  storyKey?: string
}

// ---------------------------------------------------------------------------
// TokenCounts
// ---------------------------------------------------------------------------

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

// ---------------------------------------------------------------------------
// ModelPricing
// ---------------------------------------------------------------------------

export interface ModelPricing {
  inputPerMToken: number
  outputPerMToken: number
  cacheReadPerMToken: number
  cacheCreationPerMToken: number
}

// ---------------------------------------------------------------------------
// NormalizedMetric (story 27-3)
// ---------------------------------------------------------------------------

export interface NormalizedMetric {
  metricId: string
  name: string
  value: number
  type: string
  unit?: string
  /** Unix milliseconds */
  timestamp: number
  storyKey?: string
  source?: string
  model?: string
  attributes?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// TelemetryBatch (story 27-3)
// ---------------------------------------------------------------------------

export interface TelemetryBatch {
  spans: NormalizedSpan[]
  logs: NormalizedLog[]
  metrics: NormalizedMetric[]
  committedAt: number
}

// ---------------------------------------------------------------------------
// TelemetryPersistenceConfig (story 27-3)
// ---------------------------------------------------------------------------

export interface TelemetryPersistenceConfig {
  maxAgeDays?: number
}

// ---------------------------------------------------------------------------
// PruneResult (story 27-3)
// ---------------------------------------------------------------------------

export interface PruneResult {
  spans: number
  logs: number
  metrics: number
}

// ---------------------------------------------------------------------------
// TokensByModelRow (story 27-3)
// ---------------------------------------------------------------------------

export interface TokensByModelRow {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  costUsd: number
}

// ---------------------------------------------------------------------------
// ChildSpanSummary / TurnAnalysis (story 27-4)
// ---------------------------------------------------------------------------

export const ChildSpanSummarySchema = z.object({
  spanId: z.string(),
  name: z.string(),
  toolName: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  durationMs: z.number(),
})

export type ChildSpanSummary = z.infer<typeof ChildSpanSummarySchema>

export const TurnAnalysisSchema = z.object({
  spanId: z.string(),
  turnNumber: z.number().int().positive(),
  name: z.string(),
  /** Unix milliseconds */
  timestamp: z.number(),
  /** Source identifier (e.g. 'claude-code', 'unknown') */
  source: z.string(),
  model: z.string().optional(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  /** inputTokens - cacheReadTokens */
  freshTokens: z.number(),
  /** cacheReadTokens / inputTokens, or 0 if inputTokens is 0 */
  cacheHitRate: z.number(),
  costUsd: z.number(),
  durationMs: z.number(),
  /** Running cumulative inputTokens through this turn */
  contextSize: z.number(),
  /** contextSize - prev contextSize (= inputTokens for first turn) */
  contextDelta: z.number(),
  toolName: z.string().optional(),
  /** True if inputTokens > 2 × average inputTokens across all turns */
  isContextSpike: z.boolean(),
  childSpans: z.array(ChildSpanSummarySchema),
})

export type TurnAnalysis = z.infer<typeof TurnAnalysisSchema>

// ---------------------------------------------------------------------------
// SemanticCategory / Trend / CategoryStats / ConsumerStats (story 27-5)
// ---------------------------------------------------------------------------

export const SemanticCategorySchema = z.enum([
  'tool_outputs',
  'file_reads',
  'system_prompts',
  'conversation_history',
  'user_prompts',
  'other',
])

export type SemanticCategory = z.infer<typeof SemanticCategorySchema>

export const TrendSchema = z.enum(['growing', 'stable', 'shrinking'])

export type Trend = z.infer<typeof TrendSchema>

export const TopInvocationSchema = z.object({
  spanId: z.string(),
  name: z.string(),
  toolName: z.string().optional(),
  totalTokens: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
})

export type TopInvocation = z.infer<typeof TopInvocationSchema>

export const CategoryStatsSchema = z.object({
  category: SemanticCategorySchema,
  totalTokens: z.number(),
  percentage: z.number(),
  eventCount: z.number(),
  avgTokensPerEvent: z.number(),
  trend: TrendSchema,
})

export type CategoryStats = z.infer<typeof CategoryStatsSchema>

export const ConsumerStatsSchema = z.object({
  consumerKey: z.string(),
  category: SemanticCategorySchema,
  totalTokens: z.number(),
  percentage: z.number(),
  eventCount: z.number(),
  topInvocations: z.array(TopInvocationSchema).max(20),
})

export type ConsumerStats = z.infer<typeof ConsumerStatsSchema>

// ---------------------------------------------------------------------------
// ModelEfficiency / SourceEfficiency / EfficiencyScore (story 27-6)
// ---------------------------------------------------------------------------

export const ModelEfficiencySchema = z.object({
  model: z.string(),
  cacheHitRate: z.number(),
  avgIoRatio: z.number(),
  costPer1KOutputTokens: z.number(),
})

export type ModelEfficiency = z.infer<typeof ModelEfficiencySchema>

export const SourceEfficiencySchema = z.object({
  source: z.string(),
  compositeScore: z.number(),
  turnCount: z.number(),
})

export type SourceEfficiency = z.infer<typeof SourceEfficiencySchema>

export const EfficiencyScoreSchema = z.object({
  storyKey: z.string(),
  /** Unix milliseconds — when the score was computed */
  timestamp: z.number(),
  /** Composite 0-100 score (weighted average of sub-scores) */
  compositeScore: z.number().int().min(0).max(100),
  /** Cache hit sub-score 0-100 (weight: 40%) */
  cacheHitSubScore: z.number().min(0).max(100),
  /** I/O ratio sub-score 0-100 (weight: 30%) */
  ioRatioSubScore: z.number().min(0).max(100),
  /** Context management sub-score 0-100 (weight: 30%) */
  contextManagementSubScore: z.number().min(0).max(100),
  /** Average cache hit rate across all turns (0-1) */
  avgCacheHitRate: z.number(),
  /** Average I/O ratio across all turns (inputTokens / max(outputTokens, 1)) */
  avgIoRatio: z.number(),
  /** Number of turns flagged as context spikes */
  contextSpikeCount: z.number().int().nonnegative(),
  /** Total number of turns analyzed */
  totalTurns: z.number().int().nonnegative(),
  /** Per-model efficiency breakdown */
  perModelBreakdown: z.array(ModelEfficiencySchema),
  /** Per-source efficiency breakdown */
  perSourceBreakdown: z.array(SourceEfficiencySchema),
})

export type EfficiencyScore = z.infer<typeof EfficiencyScoreSchema>

// ---------------------------------------------------------------------------
// Recommendation / RuleId (story 27-7)
// ---------------------------------------------------------------------------

export const RuleIdSchema = z.enum([
  'biggest_consumers',
  'large_file_reads',
  'expensive_bash',
  'repeated_tool_calls',
  'context_growth_spike',
  'growing_categories',
  'cache_efficiency',
  'per_model_comparison',
])

export type RuleId = z.infer<typeof RuleIdSchema>

export const RecommendationSeveritySchema = z.enum(['critical', 'warning', 'info'])

export type RecommendationSeverity = z.infer<typeof RecommendationSeveritySchema>

export const RecommendationSchema = z.object({
  /** 16-char hex, derived from sha256(ruleId:storyKey:actionTarget:index) */
  id: z.string().length(16),
  storyKey: z.string(),
  sprintId: z.string().optional(),
  ruleId: RuleIdSchema,
  severity: RecommendationSeveritySchema,
  title: z.string(),
  description: z.string(),
  potentialSavingsTokens: z.number().optional(),
  potentialSavingsUsd: z.number().optional(),
  /** Identifies the file, tool, or model the recommendation targets */
  actionTarget: z.string().optional(),
  /** ISO timestamp injected from RecommenderContext.generatedAt */
  generatedAt: z.string(),
})

export type Recommendation = z.infer<typeof RecommendationSchema>

/**
 * Assembled context passed to Recommender.analyze().
 * The caller fetches each field from TelemetryPersistence.
 */
export interface RecommenderContext {
  storyKey: string
  sprintId?: string
  /** ISO timestamp (pinned externally for determinism) */
  generatedAt: string
  turns: TurnAnalysis[]
  categories: CategoryStats[]
  consumers: ConsumerStats[]
  efficiencyScore: EfficiencyScore
  allSpans: NormalizedSpan[]
}

export interface IRecommender {
  analyze(context: RecommenderContext): Recommendation[]
}
