/**
 * Types for the Phase Orchestrator module.
 *
 * Defines the core data structures for phase definitions, gate checks,
 * run status, and phase history used throughout the multi-phase pipeline.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'

// ---------------------------------------------------------------------------
// GateCheck
// ---------------------------------------------------------------------------

/**
 * A single gate check that validates whether a phase transition condition is met.
 * Used for both entry gates (before entering a phase) and exit gates (after completing a phase).
 */
export interface GateCheck {
  /** Human-readable name for this gate (used in error reporting) */
  name: string
  /**
   * Async function that evaluates the gate condition.
   * @param db - SQLite database instance
   * @param runId - The pipeline run ID being evaluated
   * @returns true if the gate passes, false if it fails
   */
  check: (db: BetterSqlite3Database, runId: string) => Promise<boolean>
  /** Error message to display when this gate fails */
  errorMessage: string
}

// ---------------------------------------------------------------------------
// PhaseDefinition
// ---------------------------------------------------------------------------

/**
 * Defines a phase in the pipeline including its gate checks and lifecycle callbacks.
 */
export interface PhaseDefinition {
  /** Unique name for this phase (e.g., 'analysis', 'planning') */
  name: string
  /** Human-readable description of what this phase does */
  description: string
  /** Gates that must pass before this phase can begin */
  entryGates: GateCheck[]
  /** Gates that must pass before this phase can be considered complete */
  exitGates: GateCheck[]
  /**
   * Called when the phase is entered (after entry gates pass).
   * Used for setup, logging, or initializing phase-specific resources.
   */
  onEnter: (db: BetterSqlite3Database, runId: string) => Promise<void>
  /**
   * Called when the phase exits (after exit gates pass).
   * Used for cleanup, artifact registration, or finalizing phase results.
   */
  onExit: (db: BetterSqlite3Database, runId: string) => Promise<void>
}

// ---------------------------------------------------------------------------
// PhaseHistoryEntry
// ---------------------------------------------------------------------------

/**
 * Records the execution history of a single phase transition.
 */
export interface PhaseHistoryEntry {
  /** Name of the phase */
  phase: string
  /** ISO timestamp when this phase started */
  startedAt: string
  /** ISO timestamp when this phase completed (undefined if still running) */
  completedAt?: string
  /** Results of gate evaluations during this phase transition */
  gateResults: Array<{
    gate: string
    passed: boolean
    error?: string
  }>
}

// ---------------------------------------------------------------------------
// PhaseRunStatus
// ---------------------------------------------------------------------------

/**
 * Current status snapshot of a pipeline run.
 */
export interface PhaseRunStatus {
  /** The pipeline run ID */
  runId: string
  /** Name of the currently active phase (null if not yet started or completed) */
  currentPhase: string | null
  /** List of phases that have been fully completed */
  completedPhases: string[]
  /** All artifacts registered for this run */
  artifacts: Array<{
    type: string
    phase: string
    id: string
  }>
  /** Overall status of the pipeline run */
  status: 'running' | 'paused' | 'completed' | 'failed'
  /** History of phase transitions */
  phaseHistory: PhaseHistoryEntry[]
}

// ---------------------------------------------------------------------------
// Gate run result
// ---------------------------------------------------------------------------

/**
 * Result of running a set of gate checks.
 */
export interface GateRunResult {
  /** Whether all gates passed */
  passed: boolean
  /** Details of any gates that failed */
  failures: Array<{
    gate: string
    error: string
  }>
}

// ---------------------------------------------------------------------------
// Advance phase result
// ---------------------------------------------------------------------------

/**
 * Result of attempting to advance to the next phase.
 */
export interface AdvancePhaseResult {
  /** Whether the phase was successfully advanced */
  advanced: boolean
  /** The current phase after the advance attempt */
  phase: string
  /** Details of gate failures that prevented advancement (if any) */
  gateFailures?: Array<{
    gate: string
    error: string
  }>
}
