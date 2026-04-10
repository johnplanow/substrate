/**
 * AutoSummarizer — automatic context compression for long-running convergence loops.
 *
 * Monitors accumulated iteration contexts and compresses older iterations
 * when the total token estimate crosses a configurable fraction of the model's
 * token limit. Designed for injection into ConvergenceController (story 49-3).
 */

import type { SummaryEngine } from './summary-engine.js'
import type { Summary, SummaryLevel } from './summary-types.js'

/**
 * Configuration for AutoSummarizer.
 *
 * All fields are optional; defaults are applied in the constructor.
 */
export interface AutoSummarizerConfig {
  /**
   * Fraction of the model's token limit that triggers compression.
   * Default: 0.8. Valid range: [0.5, 0.95].
   */
  threshold?: number
  /**
   * Summary level to compress older iterations to.
   * Default: 'medium'.
   */
  targetLevel?: SummaryLevel
}

/**
 * Context accumulated during a single convergence iteration.
 */
export interface IterationContext {
  /** Zero-based iteration index within the convergence loop. */
  index: number
  /** Accumulated text for this iteration (agent output, decisions, diffs). */
  content: string
  /**
   * Cached token estimate. Auto-computed from content via estimateTokens() if absent.
   * Set this field to avoid repeated computation across shouldTrigger() calls.
   */
  tokenEstimate?: number
}

/**
 * A previous iteration that has been compressed to a summary.
 *
 * The `compressed: true` discriminant literal enables TypeScript type narrowing:
 *   if ('compressed' in ctx) { // ctx is CompressedIterationContext }
 */
export interface CompressedIterationContext {
  index: number
  summary: Summary
  /** Discriminant literal — enables TypeScript type narrowing. */
  compressed: true
}

/**
 * Result returned by AutoSummarizer.compress().
 */
export interface CompressionResult {
  /**
   * The updated iteration array: previous iterations are replaced with
   * CompressedIterationContext objects; the current iteration passes through unchanged.
   */
  iterations: (IterationContext | CompressedIterationContext)[]
  /**
   * Indices of the iterations that were compressed in this call.
   */
  compressedIndices: number[]
}

/**
 * Approximate token count using the chars/4 heuristic.
 *
 * Pure synchronous function — no imports, no async.
 * Returns 0 for falsy input (empty string, null, undefined).
 *
 * @param text - The text to estimate token count for
 * @returns Estimated token count: Math.ceil(text.length / 4)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * Monitors convergence loop iteration contexts and compresses older iterations
 * when accumulated token usage exceeds the configured threshold.
 *
 * Inject into ConvergenceController via ConvergenceControllerConfig.autoSummarizer.
 * Depends on the SummaryEngine interface — does NOT import LLMSummaryEngine directly
 * (inversion of control).
 */
export class AutoSummarizer {
  private readonly engine: SummaryEngine
  private readonly modelTokenLimit: number
  private readonly threshold: number
  private readonly targetLevel: SummaryLevel

  /**
   * @param engine - The summarization engine to use for compression
   * @param modelTokenLimit - The model's maximum token limit (positive integer)
   * @param config - Optional configuration; defaults applied for missing fields
   * @throws {RangeError} When threshold is outside the valid range [0.5, 0.95]
   */
  constructor(engine: SummaryEngine, modelTokenLimit: number, config?: AutoSummarizerConfig) {
    const threshold = config?.threshold ?? 0.8
    if (threshold < 0.5 || threshold > 0.95) {
      throw new RangeError('context_summarize_threshold must be between 0.5 and 0.95')
    }
    this.engine = engine
    this.modelTokenLimit = modelTokenLimit
    this.threshold = threshold
    this.targetLevel = config?.targetLevel ?? 'medium'
  }

  /**
   * Returns true when the total estimated token count across all iterations
   * is strictly greater than `threshold * modelTokenLimit`.
   *
   * Uses `iter.tokenEstimate` when present to avoid recomputing from content.
   *
   * @param iterations - The accumulated iteration contexts to evaluate
   * @returns `true` when compression should be triggered; `false` otherwise
   */
  shouldTrigger(iterations: IterationContext[]): boolean {
    const total = iterations.reduce(
      (sum, iter) => sum + (iter.tokenEstimate ?? estimateTokens(iter.content)),
      0
    )
    return total > this.threshold * this.modelTokenLimit
  }

  /**
   * Compress all iterations with `index < currentIndex` to the configured
   * summary level. The iteration at `currentIndex` (and any later) passes through
   * unchanged.
   *
   * @param iterations - The full set of iteration contexts to process
   * @param currentIndex - The index of the iteration currently being dispatched;
   *                       this iteration and any with higher indices are never compressed
   * @returns A CompressionResult containing the updated iterations array and
   *          the list of indices that were compressed
   */
  async compress(iterations: IterationContext[], currentIndex: number): Promise<CompressionResult> {
    const compressedIndices: number[] = []
    const result: (IterationContext | CompressedIterationContext)[] = []

    for (const iter of iterations) {
      if (iter.index < currentIndex && iter.content !== '') {
        const summary = await this.engine.summarize(iter.content, this.targetLevel)
        result.push({ index: iter.index, summary, compressed: true })
        compressedIndices.push(iter.index)
      } else {
        result.push(iter)
      }
    }

    return { iterations: result, compressedIndices }
  }
}
