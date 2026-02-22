/**
 * Stop-After Gate Module — StopAfterGate Interface
 *
 * Defines the interface for a stop-after gate object returned by createStopAfterGate().
 * All methods are pure functions with no side effects.
 */

import type { CompletionSummaryParams } from './types.js'

/**
 * A stateless, thread-safe gate object that evaluates stop-after semantics for a pipeline phase.
 *
 * Created by createStopAfterGate(phaseName). Each gate is independent and does not share
 * mutable state with other gates or pipeline executions.
 */
export interface StopAfterGate {
  /**
   * Returns true if this gate represents the stop phase.
   *
   * Since the gate is created with a specific phase name, this always returns true —
   * the gate is only created when a stop-after phase is configured.
   *
   * No side effects.
   */
  isStopPhase(): boolean

  /**
   * Returns a formatted human-readable summary of the completed phase.
   *
   * Includes: phase name, completion status, decisions count, artifact paths,
   * next-phase description, resume command, and wall-clock duration.
   *
   * Output is guaranteed to be <= 500 words (via simple whitespace word split).
   * No ANSI escape codes in output.
   * No side effects.
   *
   * @param params - Phase completion details
   * @returns Human-readable summary string
   */
  formatCompletionSummary(params: CompletionSummaryParams): string

  /**
   * Returns true if the pipeline should halt after the current phase completes.
   *
   * The gate is stateless — this always returns true once constructed, as the
   * gate is the mechanism by which halting is signaled.
   *
   * No side effects.
   */
  shouldHalt(): boolean
}
