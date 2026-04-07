/**
 * Gating module types — Story 53-9: Dispatch Pre-Condition Gating
 *
 * Defines the type system for the dispatch gate: ConflictType, GateDecision,
 * GateResult, DispatchGateOptions, and the new pipeline event payloads.
 */

import type { DatabaseAdapter } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// ConflictType
// ---------------------------------------------------------------------------

/**
 * Discriminant for the kind of conflict the gate detected.
 *
 * - `namespace-collision`: a symbol defined in the pending story already exists
 *   in a file modified by a completed story.
 * - `file-overlap`: the pending story's target files overlap with a completed
 *   story's modified files, but no namespace collision was found.
 * - `learning-preemption`: the learning store contains a high-confidence
 *   namespace-collision finding for the pending story's target files, even
 *   without a direct completed-story overlap in this run.
 */
export type ConflictType = 'namespace-collision' | 'file-overlap' | 'learning-preemption'

// ---------------------------------------------------------------------------
// GateDecision
// ---------------------------------------------------------------------------

/**
 * The gate's verdict for a pending story dispatch.
 *
 * - `proceed`: no conflict detected; dispatch normally.
 * - `warn`: file overlap found but no collision; dispatch proceeds with a warning event.
 * - `block`: collision resolved via auto-resolution; dispatch with modified prompt.
 * - `gated`: non-resolvable conflict; story is placed in the `gated` phase and
 *   excluded from future dispatch attempts until operator review.
 */
export type GateDecision = 'proceed' | 'warn' | 'block' | 'gated'

// ---------------------------------------------------------------------------
// GateResult
// ---------------------------------------------------------------------------

/**
 * Structured result returned by `DispatchGate.check()`.
 */
export interface GateResult {
  /** The gate's verdict. */
  decision: GateDecision
  /** Type of conflict detected (absent when decision is 'proceed'). */
  conflictType?: ConflictType
  /** Human-readable reason string for the gate decision. */
  reason?: string
  /** Modified story prompt with extension note appended (present when decision is 'block'). */
  modifiedPrompt?: string
  /** Completed-story key that triggered the conflict. */
  completedStoryKey?: string
  /** Files shared between pending and completed story (present when decision is 'warn'). */
  overlappingFiles?: string[]
}

// ---------------------------------------------------------------------------
// DispatchGateOptions
// ---------------------------------------------------------------------------

/**
 * Options passed to `DispatchGate.check()` for a single pending story.
 */
export interface DispatchGateOptions {
  /** Story key being evaluated (e.g. '53-9'). */
  storyKey: string
  /** Raw content of the story file — used for symbol extraction. */
  storyContent: string
  /** Files referenced / targeted by the pending story. */
  pendingFiles: string[]
  /** Completed stories with their modified file lists. */
  completedStories: Array<{ key: string; modifiedFiles: string[] }>
  /** Database adapter for learning store queries. */
  db: DatabaseAdapter
  /** Project root path — used for file content reads during collision detection. */
  projectRoot: string
}

// ---------------------------------------------------------------------------
// Pipeline event payloads (new events added by this story)
// ---------------------------------------------------------------------------

/**
 * Payload for the `pipeline:dispatch-warn` event (AC2).
 *
 * Emitted when a file overlap is detected between the pending story and a
 * completed story, but no namespace collision was found. Dispatch proceeds
 * normally after this event.
 */
export interface PipelineDispatchWarnPayload {
  /** Pending story key. */
  storyKey: string
  /** Completed story whose modified files overlap with the pending story. */
  completedStoryKey: string
  /** Files that exist in both pending and completed story file sets. */
  overlappingFiles: string[]
}

/**
 * Payload for the `pipeline:story-gated` event (AC5).
 *
 * Emitted when the gate cannot resolve a conflict and places the story in the
 * `gated` phase for operator review.
 */
export interface PipelineStoryGatedPayload {
  /** Story key being gated. */
  storyKey: string
  /** Type of conflict that triggered the gate. */
  conflictType: ConflictType
  /** Human-readable reason for gating. */
  reason: string
  /** Completed story that triggered the conflict (if applicable). */
  completedStoryKey?: string
}
