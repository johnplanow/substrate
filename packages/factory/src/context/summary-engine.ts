/**
 * SummaryEngine interface for reversible multi-level context summarization.
 *
 * Zero runtime imports — pure TypeScript interface declaration only.
 */
import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from './summary-types.js'

/**
 * Reversible multi-level context summarization engine.
 *
 * Contract: expand(summarize(content, level), 'full') must preserve all
 * code blocks, file paths, error messages, and key decisions from the original.
 *
 * Implementations:
 * - LLMSummaryEngine (story 49-2): LLM-backed summarization and expansion
 * - Passthrough mock: for tests, returns content unmodified or sliced by budget fraction
 */
export interface SummaryEngine {
  /**
   * A human-readable name for this engine instance.
   * Used for traceability in logs and metrics.
   */
  readonly name: string

  /**
   * Summarize content to the target level.
   *
   * @param content - The original content to summarize
   * @param targetLevel - The desired summary level
   * @param opts - Optional configuration for the summarization
   * @returns A Summary object containing the compressed content and provenance metadata
   */
  summarize(
    content: string,
    targetLevel: SummaryLevel,
    opts?: SummarizeOptions,
  ): Promise<Summary>

  /**
   * Expand a summary back toward a higher-fidelity representation.
   *
   * When `opts.originalContent` is provided, implementations may use it for
   * lossless or near-lossless expansion. Without it, expansion relies on
   * heuristics or LLM inference.
   *
   * @param summary - The summary to expand
   * @param targetLevel - The target level (typically 'full' for full recovery)
   * @param opts - Optional configuration including the original content
   * @returns The expanded content as a string
   */
  expand(
    summary: Summary,
    targetLevel: SummaryLevel,
    opts?: ExpandOptions,
  ): Promise<string>
}
