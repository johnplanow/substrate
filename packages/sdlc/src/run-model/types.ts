/**
 * RunManifest type definitions — Story 52-1 / Story 52-8.
 *
 * Provides TypeScript interfaces for the run manifest file stored at
 * `.substrate/runs/{run-id}.json`.
 */

import type { PerStoryState } from './per-story-state.js'
import type { RecoveryEntry, CostAccumulation } from './recovery-history.js'

// Re-export recovery types for consumers of types.ts (Story 52-8)
export type { RecoveryEntry, CostAccumulation }

/**
 * A pending supervisor proposal awaiting user confirmation.
 */
export interface Proposal {
  /** Unique proposal ID. */
  id: string
  /** ISO-8601 timestamp when the proposal was created. */
  created_at: string
  /** Short description of what is being proposed. */
  description: string
  /** Proposal type (e.g. 'retry', 'fix', 'escalate'). */
  type: string
  /** Story key this proposal pertains to, if any. */
  story_key?: string
  /** Additional payload data for the proposal. */
  payload?: Record<string, unknown>
}

/**
 * A single self-eval attempt for a phase (Epic 55-4).
 */
export interface SelfEvalEntry {
  /** Phase name that was evaluated. */
  phase: string
  /** Aggregate phase score from the eval engine (0-1). */
  score: number
  /** Whether the score met the configured threshold. */
  pass: boolean
  /** Retry index (0 = first attempt, 1+ = retries). */
  retry_index: number
  /** Human-readable feedback from the eval engine (if score was low). */
  feedback?: string
  /** ISO-8601 timestamp when this eval completed. */
  timestamp: string
}

// ---------------------------------------------------------------------------
// RunManifestData — primary interface
// ---------------------------------------------------------------------------

/**
 * Full data shape for a run manifest stored on disk.
 *
 * All fields are required; optional values use `null`.
 * `per_story_state` is typed as `Record<string, PerStoryState>` (story 52-4).
 * Each key is a story key (e.g., '52-1'); the value tracks full per-story
 * lifecycle state for manifest consumers across Epics 52–54.
 */
export interface RunManifestData {
  /** Unique run identifier (UUID). */
  run_id: string
  /** CLI flags used to start this run. */
  cli_flags: Record<string, unknown>
  /** Explicit story scope (empty = all pending stories). */
  story_scope: string[]
  /**
   * Pipeline run status. Authoritative source — Dolt `pipeline_runs.status`
   * is the degraded fallback. Consumers MUST read this field first.
   */
  run_status?: 'running' | 'completed' | 'failed' | 'stopped'
  /**
   * Number of supervisor-triggered restarts for this run.
   * Authoritative source — Dolt `run_metrics.restarts` is the degraded fallback.
   */
  restart_count?: number
  /** PID of the attached supervisor process, or null if none. */
  supervisor_pid: number | null
  /** Session ID of the supervisor process, or null if none. */
  supervisor_session_id: string | null
  /** Per-story state keyed by story key (story 52-4). */
  per_story_state: Record<string, PerStoryState>
  /** Log of recovery attempts for this run (Story 52-8). */
  recovery_history: RecoveryEntry[]
  /** Accumulated retry cost data (Story 52-8). */
  cost_accumulation: CostAccumulation
  /** Pending proposals awaiting confirmation. */
  pending_proposals: Proposal[]
  /**
   * Self-eval results per phase (Epic 55-4). Keyed by phase name.
   * Each entry is an array of eval attempts (first attempt + retries).
   * Undefined on runs predating Epic 55 (backward compat).
   */
  self_eval_history?: Record<string, SelfEvalEntry[]>
  /**
   * Monotonic write counter. Incremented on every successful `write()`.
   * Used to detect which file is newer after a mid-rename crash.
   */
  generation: number
  /** ISO-8601 timestamp when the manifest was first created. */
  created_at: string
  /** ISO-8601 timestamp of the most recent write. */
  updated_at: string
}
