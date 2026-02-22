/**
 * ImplementationOrchestrator interface.
 *
 * Defines the public contract for running the full create-story → dev-story →
 * code-review pipeline for a list of story keys with retry, escalation, and
 * parallel execution support.
 */

import type { OrchestratorStatus } from './types.js'

// ---------------------------------------------------------------------------
// ImplementationOrchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrates the full implementation pipeline for a set of story keys.
 *
 * Lifecycle:
 *   IDLE → run() called → RUNNING → all stories done → COMPLETE
 *                                 → pause() called → PAUSED → resume() → RUNNING
 */
export interface ImplementationOrchestrator {
  /**
   * Run the full create-story → dev-story → code-review pipeline for the
   * given story keys.
   *
   * Non-conflicting story groups are processed in parallel up to
   * `config.maxConcurrency`. Within each conflict group, stories are
   * serialized.
   *
   * @param storyKeys - List of story keys to process (e.g., ["10-1", "10-2"])
   * @returns Promise resolving to the final OrchestratorStatus when all stories complete
   */
  run(storyKeys: string[]): Promise<OrchestratorStatus>

  /**
   * Pause the orchestrator.
   *
   * In-progress story phases are allowed to complete. No new phases will be
   * started while paused. The orchestrator state transitions to `PAUSED`.
   */
  pause(): void

  /**
   * Resume a paused orchestrator.
   *
   * Processing continues from where it left off. The orchestrator state
   * transitions back to `RUNNING`.
   */
  resume(): void

  /**
   * Return the current status snapshot of the orchestrator and all stories.
   */
  getStatus(): OrchestratorStatus
}
