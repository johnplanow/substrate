/**
 * Summary level definitions and context budget types for reversible context compression.
 *
 * No runtime imports — pure TypeScript type/interface/const declarations only.
 */

/**
 * The level of summarization to apply to a context.
 *
 * - `full`: No compression — the entire context is preserved (100% of token budget).
 * - `high`: Light compression — major details preserved (75% of token budget).
 * - `medium`: Moderate compression — key decisions, code blocks, and errors preserved (50% of token budget).
 * - `low`: Aggressive compression — only the most essential information preserved (25% of token budget).
 */
export type SummaryLevel = 'full' | 'high' | 'medium' | 'low'

/**
 * Token-budget fraction for each summary level.
 * Multiply by the model's token limit to get the target token count.
 */
export const SUMMARY_BUDGET: Record<SummaryLevel, number> = {
  full: 1.0,
  high: 0.75,
  medium: 0.50,
  low: 0.25,
}

/**
 * The default summary level to use when none is specified.
 * Balances compression ratio and information preservation.
 */
export const DEFAULT_SUMMARY_LEVEL: SummaryLevel = 'medium'

/**
 * The result produced by a summarization operation.
 * Contains the summarized content along with provenance metadata
 * to support lossless or near-lossless expansion.
 */
export interface Summary {
  /** The summary level that was applied */
  level: SummaryLevel
  /** The summarized content */
  content: string
  /** SHA-256 hex digest of the original content (before summarization) */
  originalHash: string
  /** ISO-8601 timestamp of when the summary was created */
  createdAt: string
  /** Token count of the original content, if known */
  originalTokenCount?: number
  /** Token count of the summarized content, if known */
  summaryTokenCount?: number
  /**
   * The pipeline iteration index this summary was created for.
   * Used by `factory context summarize/expand/stats` CLI commands to map
   * iteration numbers to stored summary hashes.
   */
  iterationIndex?: number
  /** Additional arbitrary metadata from the summarization engine */
  metadata?: Record<string, unknown>
}

/**
 * Options for a summarize() call.
 * All boolean fields default to `true` in implementations to maximize recoverability.
 */
export interface SummarizeOptions {
  /** The model's maximum token limit — used to compute the target token count */
  modelTokenLimit?: number
  /** Whether to preserve code blocks verbatim (default: true) */
  preserveCodeBlocks?: boolean
  /** Whether to preserve file paths (default: true) */
  preserveFilePaths?: boolean
  /** Whether to preserve error messages verbatim (default: true) */
  preserveErrorMessages?: boolean
}

/**
 * Options for an expand() call.
 */
export interface ExpandOptions {
  /**
   * The original content before summarization.
   * When provided, implementations may use it for lossless expansion
   * (e.g., by re-injecting preserved sections).
   */
  originalContent?: string
  /** Additional arbitrary metadata to guide expansion */
  metadata?: Record<string, unknown>
}

/**
 * Describes the token budget for a particular summarization level
 * relative to a model's token limit.
 */
export interface ContextBudget {
  /** The model's maximum token limit */
  modelTokenLimit: number
  /** The summary level this budget corresponds to */
  level: SummaryLevel
  /** Target token count = Math.floor(modelTokenLimit * SUMMARY_BUDGET[level]) */
  targetTokenCount: number
  /** The compression ratio = SUMMARY_BUDGET[level] */
  compressionRatio: number
}

/**
 * Compute the context budget for a given model token limit and summary level.
 *
 * Pure function — no I/O, no async, no external imports.
 *
 * @param modelTokenLimit - The model's maximum token limit
 * @param level - The desired summary level
 * @returns A fully populated ContextBudget object
 */
export function computeBudget(modelTokenLimit: number, level: SummaryLevel): ContextBudget {
  const compressionRatio = SUMMARY_BUDGET[level]
  return {
    modelTokenLimit,
    level,
    targetTokenCount: Math.floor(modelTokenLimit * compressionRatio),
    compressionRatio,
  }
}
