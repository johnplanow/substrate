/**
 * Telemetry module type definitions for @substrate-ai/core.
 *
 * Extracted from src/modules/telemetry/types.ts, src/modules/telemetry/telemetry-pipeline.ts,
 * src/modules/telemetry/persistence.ts, and src/modules/telemetry/ingestion-server.ts.
 *
 * Defines all Zod schemas and derived TypeScript types for the telemetry
 * pipeline: normalized OTLP spans and logs, turn analysis, semantic
 * categorization, context consumers, efficiency scoring, and persistence interfaces.
 *
 * All types are Zod-first: schemas are defined first, TypeScript types
 * are derived via `z.infer<>`, and Zod is used for DB read boundary validation.
 */

import { z } from 'zod'

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
  /** Task type from dispatch context (Story 30-1) */
  taskType?: string
  /** Pipeline phase from dispatch context (Story 30-1) */
  phase?: string
  /** Dispatch ID from dispatch context (Story 30-1) */
  dispatchId?: string
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
  /** Task type from dispatch context (Story 30-1) */
  taskType: z.string().optional(),
  /** Pipeline phase from dispatch context (Story 30-1) */
  phase: z.string().optional(),
  /** Dispatch ID from dispatch context (Story 30-1) */
  dispatchId: z.string().optional(),
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
  /** Cache hit sub-score 0-100 (weight: 25%) */
  cacheHitSubScore: z.number().min(0).max(100),
  /** I/O ratio sub-score 0-100 (weight: 25%) */
  ioRatioSubScore: z.number().min(0).max(100),
  /** Context management sub-score 0-100 (weight: 25%) */
  contextManagementSubScore: z.number().min(0).max(100),
  /** Token density sub-score 0-100 (weight: 25%) — Story 35-4 */
  tokenDensitySubScore: z.number().min(0).max(100).default(0),
  /** Average cache hit rate across all turns (0-1) */
  avgCacheHitRate: z.number(),
  /** Average I/O ratio across all turns (inputTokens / max(outputTokens, 1)) */
  avgIoRatio: z.number(),
  /** Number of turns flagged as context spikes */
  contextSpikeCount: z.number().int().nonnegative(),
  /** Total number of turns analyzed */
  totalTurns: z.number().int().nonnegative(),
  /** Number of cold-start turns excluded from scoring — Story 35-3 */
  coldStartTurnsExcluded: z.number().int().nonnegative().default(0),
  /** Per-model efficiency breakdown */
  perModelBreakdown: z.array(ModelEfficiencySchema),
  /** Per-source efficiency breakdown */
  perSourceBreakdown: z.array(SourceEfficiencySchema),
  /** Dispatch ID — present only for per-dispatch scores (Story 30-3) */
  dispatchId: z.string().optional(),
  /** Task type from dispatch context — present only for per-dispatch scores (Story 30-3) */
  taskType: z.string().optional(),
  /** Pipeline phase from dispatch context — present only for per-dispatch scores (Story 30-3) */
  phase: z.string().optional(),
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
  'cache_delta_regression',
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

// ---------------------------------------------------------------------------
// EfficiencyProfile (story 27-8)
// ---------------------------------------------------------------------------

export const EfficiencyProfileSchema = z.object({
  storyKey: z.string(),
  generatedAt: z.string(),
  efficiencyScore: EfficiencyScoreSchema,
  categories: z.array(CategoryStatsSchema),
  consumers: z.array(ConsumerStatsSchema),
  recommendations: z.array(RecommendationSchema),
})

export type EfficiencyProfile = z.infer<typeof EfficiencyProfileSchema>

// ---------------------------------------------------------------------------
// OtlpSource
// ---------------------------------------------------------------------------

/** Source type for OTLP payloads, as detected at ingestion time */
export type OtlpSource = 'claude-code' | 'codex' | 'local-llm' | 'unknown'

// ---------------------------------------------------------------------------
// DispatchContext
// ---------------------------------------------------------------------------

/**
 * Dispatch context injected by the orchestrator before each agent dispatch.
 * Stamped onto every RawOtlpPayload received while that dispatch is active.
 */
export interface DispatchContext {
  /** Task type of the dispatch (e.g. 'dev-story', 'code-review', 'create-story') */
  taskType: string
  /** Pipeline phase (e.g. 'IN_DEV', 'IN_REVIEW', 'IN_STORY_CREATION') */
  phase: string
  /** Unique identifier for this dispatch */
  dispatchId: string
}

// ---------------------------------------------------------------------------
// RawOtlpPayload
// ---------------------------------------------------------------------------

/**
 * A single raw OTLP payload as received by the ingestion server.
 */
export interface RawOtlpPayload {
  /** The parsed JSON body of the OTLP request */
  body: unknown
  /** Source detected at ingestion time */
  source: OtlpSource
  /** Unix milliseconds when the payload was received */
  receivedAt: number
  /** Optional dispatch context stamped at ingestion time (Story 30-1) */
  dispatchContext?: DispatchContext
  /** Story key extracted from OTLP resource attributes (substrate.story_key) */
  storyKey?: string
}

// ---------------------------------------------------------------------------
// RecommenderContext
// ---------------------------------------------------------------------------

/**
 * Context passed to the Recommender when generating recommendations.
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
  /** Per-dispatch efficiency scores (Story 30-3). When present, enables cache_delta_regression rule. */
  dispatchScores?: EfficiencyScore[]
}

// ---------------------------------------------------------------------------
// IRecommender
// ---------------------------------------------------------------------------

export interface IRecommender {
  analyze(context: RecommenderContext): Recommendation[]
}

// ---------------------------------------------------------------------------
// ITelemetryPersistence
// ---------------------------------------------------------------------------

/**
 * Interface for telemetry data persistence.
 * Implementations may target SQLite, Dolt, or in-memory storage.
 * Declares the 6 core write methods used by the telemetry pipeline.
 */
export interface ITelemetryPersistence {
  /** Batch-insert all turns for a story, serializing childSpans to JSON. */
  storeTurnAnalysis(storyKey: string, turns: TurnAnalysis[]): Promise<void>

  /** Insert or replace the efficiency score for a story. */
  storeEfficiencyScore(score: EfficiencyScore): Promise<void>

  /** Batch-insert category stats for a story. */
  storeCategoryStats(storyKey: string, stats: CategoryStats[]): Promise<void>

  /** Batch-insert consumer stats for a story. */
  storeConsumerStats(storyKey: string, consumers: ConsumerStats[]): Promise<void>

  /** Batch-insert all recommendations for a story in a single transaction. */
  saveRecommendations(storyKey: string, recs: Recommendation[]): Promise<void>

  /**
   * Delete all telemetry data for a story.
   * Called before persisting new data for a re-run story to prevent stale data.
   */
  purgeStoryTelemetry(storyKey: string): Promise<void>
}

// ---------------------------------------------------------------------------
// ITelemetryPipeline
// ---------------------------------------------------------------------------

/**
 * Interface for the telemetry analysis pipeline.
 * Processes batches of raw OTLP payloads through the full analysis pipeline.
 */
export interface ITelemetryPipeline {
  processBatch(items: RawOtlpPayload[]): Promise<void>
}
