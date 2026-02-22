/**
 * PhaseOrchestrator interface.
 *
 * Defines the public contract for managing the multi-phase pipeline
 * (Analysis → Planning → Solutioning → Implementation) with entry/exit
 * gates and artifact flow through the decision store.
 */

import type { PhaseDefinition, PhaseRunStatus, AdvancePhaseResult } from './types.js'

// ---------------------------------------------------------------------------
// PhaseOrchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrates a multi-phase pipeline with entry/exit gate enforcement.
 *
 * Lifecycle:
 *   startRun() → advancePhase() (repeated) → phases complete
 *   OR resumeRun() (after crash/interruption) → advancePhase()
 */
export interface PhaseOrchestrator {
  /**
   * Start a new pipeline run for the given concept/project.
   *
   * Creates a pipeline_runs record with status 'running' and current_phase
   * set to the first phase (or the specified startPhase).
   *
   * @param concept - The user concept/project description to process
   * @param startPhase - Optional override for the starting phase (defaults to 'analysis')
   * @returns Promise resolving to the new run ID (UUID)
   */
  startRun(concept: string, startPhase?: string): Promise<string>

  /**
   * Attempt to advance from the current phase to the next phase.
   *
   * Steps:
   *   1. Check exit gates of current phase (must all pass)
   *   2. Determine next phase in the ordered sequence
   *   3. Check entry gates of next phase (must all pass)
   *   4. Call onExit() for current phase
   *   5. Call onEnter() for next phase
   *   6. Update pipeline_run record
   *
   * @param runId - The pipeline run ID to advance
   * @returns Result including whether advance succeeded and any gate failures
   */
  advancePhase(runId: string): Promise<AdvancePhaseResult>

  /**
   * Resume a pipeline run that was interrupted (crash, manual stop, etc.).
   *
   * Loads the existing pipeline_run record, determines the last completed
   * phase by checking which phase's exit gates all pass, then resumes
   * from the next incomplete phase. Updates status back to 'running'.
   *
   * @param runId - The pipeline run ID to resume
   * @returns Current run status after resumption
   */
  resumeRun(runId: string): Promise<PhaseRunStatus>

  /**
   * Get the current status of a pipeline run.
   *
   * Returns the current phase, list of completed phases, registered
   * artifacts, overall status, and phase history.
   *
   * @param runId - The pipeline run ID to query
   * @returns Current run status snapshot
   */
  getRunStatus(runId: string): Promise<PhaseRunStatus>

  /**
   * Register a custom phase definition.
   *
   * The custom phase is appended to the phase sequence (or inserted at
   * the specified position if the phase definition supports it). It can
   * define its own entry/exit gates and callbacks.
   *
   * @param phase - The phase definition to register
   */
  registerPhase(phase: PhaseDefinition): void

  /**
   * Return the ordered list of all registered phases.
   *
   * @returns Array of phase definitions in execution order
   */
  getPhases(): PhaseDefinition[]
}
