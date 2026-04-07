/**
 * SdlcEvents — typed event map for SDLC orchestrator story-lifecycle events.
 *
 * Extends CoreEvents (via intersection) with all SDLC-specific event types:
 * orchestrator:*, plan:*, solutioning:*, story:*, pipeline:*
 *
 * Payload shapes are copied verbatim from src/core/event-bus.types.ts (monolith source).
 * Do NOT modify this file without corresponding changes to the monolith source.
 */

import type { CoreEvents } from '@substrate-ai/core'
import type { VerificationSummary } from './verification/types.js'

// ---------------------------------------------------------------------------
// Helper payload types
// ---------------------------------------------------------------------------

/**
 * Structured escalation diagnosis from `orchestrator:story-escalated`.
 * Carries classification and recommended action for the escalation.
 */
export interface EscalationDiagnosis {
  issueDistribution: 'concentrated' | 'widespread'
  severityProfile: 'blocker-present' | 'major-only' | 'minor-only' | 'no-structured-issues'
  totalIssues: number
  blockerCount: number
  majorCount: number
  minorCount: number
  affectedFiles: string[]
  reviewCycles: number
  recommendedAction: 'retry-targeted' | 'split-story' | 'human-intervention'
  rationale: string
}

/**
 * A single finding from `solutioning:readiness-failed`.
 */
export interface SolutioningFinding {
  category: string
  severity: string
  description: string
  affected_items: string[]
}

/**
 * Phase-level timing breakdown from `story:metrics`.
 * Keys are phase names (e.g., "dev-story", "code-review"), values are elapsed milliseconds.
 */
export type StoryPhaseBreakdown = Record<string, number>

// ---------------------------------------------------------------------------
// SdlcEvents
// ---------------------------------------------------------------------------

/**
 * Complete typed map of all SDLC orchestrator events.
 * Intersection with CoreEvents so TypedEventBus<SdlcEvents> includes all core event keys.
 */
export type SdlcEvents = CoreEvents & {
  // -------------------------------------------------------------------------
  // Implementation orchestrator lifecycle events
  // -------------------------------------------------------------------------

  /** Implementation orchestrator has started processing story keys */
  'orchestrator:started': { storyKeys: string[]; pipelineRunId?: string }

  /** A story phase has started within the implementation orchestrator */
  'orchestrator:story-phase-start': {
    storyKey: string
    phase: string
    pipelineRunId?: string
  }

  /** A story phase has completed within the implementation orchestrator */
  'orchestrator:story-phase-complete': {
    storyKey: string
    phase: string
    result: unknown
    pipelineRunId?: string
  }

  /** A story has completed the full pipeline with SHIP_IT verdict */
  'orchestrator:story-complete': { storyKey: string; reviewCycles: number }

  /** A story has been escalated after exceeding max review cycles */
  'orchestrator:story-escalated': {
    storyKey: string
    lastVerdict: string
    reviewCycles: number
    issues: unknown[]
    /** Structured diagnosis with classification and recommended action (Story 22-3) */
    diagnosis?: EscalationDiagnosis
  }

  /** A non-fatal warning occurred during story processing */
  'orchestrator:story-warn': {
    storyKey: string
    msg: string
  }

  /** Zero-diff detection gate: dev-story reported COMPLETE but git diff is empty (Story 24-1) */
  'orchestrator:zero-diff-escalation': {
    storyKey: string
    reason: string
  }

  /** Implementation orchestrator has finished all stories */
  'orchestrator:complete': {
    totalStories: number
    completed: number
    escalated: number
    failed: number
  }

  /** Implementation orchestrator has been paused */
  'orchestrator:paused': Record<string, never>

  /** Implementation orchestrator has been resumed */
  'orchestrator:resumed': Record<string, never>

  // -------------------------------------------------------------------------
  // Implementation orchestrator health events
  // -------------------------------------------------------------------------

  /** Periodic heartbeat emitted every 30s during pipeline execution */
  'orchestrator:heartbeat': {
    runId: string
    activeDispatches: number
    completedDispatches: number
    queuedDispatches: number
  }

  /** Watchdog detected no progress for an extended period */
  'orchestrator:stall': {
    runId: string
    storyKey: string
    phase: string
    elapsedMs: number
    /** PIDs of child processes at time of stall detection */
    childPids: number[]
    /** Whether any child process was actively running (not zombie) */
    childActive: boolean
  }

  // -------------------------------------------------------------------------
  // Plan events
  // -------------------------------------------------------------------------

  /** Plan generation has started */
  'plan:generating': { agent: string; description: string }

  /** Plan generation has completed */
  'plan:generated': { taskCount: number; estimatedCost: number }

  /** Plan was approved by the user */
  'plan:approved': { taskCount: number }

  /** Plan was rejected by the user */
  'plan:rejected': { reason: string }

  /** Plan is being refined based on feedback */
  'plan:refining': { planId: string; feedback: string; currentVersion: number }

  /** Plan refinement completed successfully */
  'plan:refined': { planId: string; newVersion: number; taskCount: number }

  /** Plan was rolled back to a previous version */
  'plan:rolled-back': { planId: string; fromVersion: number; toVersion: number; newVersion: number }

  /** Plan refinement failed */
  'plan:refinement-failed': { planId: string; currentVersion: number; error: string }

  // -------------------------------------------------------------------------
  // Solutioning phase events
  // -------------------------------------------------------------------------

  /** Readiness check has completed — emitted for all verdicts (READY, NEEDS_WORK, NOT_READY) */
  'solutioning:readiness-check': {
    runId: string
    verdict: 'READY' | 'NEEDS_WORK' | 'NOT_READY'
    coverageScore: number
    findingCount: number
    blockerCount: number
  }

  /** Readiness check returned NOT_READY — solutioning phase will not proceed to implementation */
  'solutioning:readiness-failed': {
    runId: string
    verdict: 'NOT_READY'
    coverageScore: number
    findings: SolutioningFinding[]
  }

  // -------------------------------------------------------------------------
  // Story events
  // -------------------------------------------------------------------------

  /**
   * Emitted when a dev-story timeout has partial work on disk and the
   * orchestrator captures it as a checkpoint for retry (Story 39-5).
   */
  'story:checkpoint-saved': {
    /** Story key that timed out with partial work */
    storyKey: string
    /** Number of files modified before the timeout */
    filesCount: number
    /** Approximate byte length of the git diff captured */
    diffSizeBytes: number
  }

  /**
   * Emitted when the orchestrator dispatches a checkpoint retry for a story
   * that timed out with partial work (Story 39-6).
   */
  'story:checkpoint-retry': {
    /** Story key being retried */
    storyKey: string
    /** Number of files modified in the partial work captured at checkpoint */
    filesCount: number
    /** Retry attempt number (always 2 — first retry after initial timeout) */
    attempt: number
  }

  /** Build verification command failed with non-zero exit or timeout */
  'story:build-verification-failed': {
    storyKey: string
    exitCode: number
    /** Build output (stdout+stderr), truncated to 2000 chars */
    output: string
  }

  /** Build verification command exited with code 0 */
  'story:build-verification-passed': {
    storyKey: string
  }

  /** Non-blocking warning: modified .ts files export shared interfaces referenced by cross-module tests */
  'story:interface-change-warning': {
    storyKey: string
    modifiedInterfaces: string[]
    potentiallyAffectedTests: string[]
  }

  /** Per-story metrics snapshot emitted when a story reaches a terminal state (Story 24-4) */
  'story:metrics': {
    storyKey: string
    wallClockMs: number
    phaseBreakdown: StoryPhaseBreakdown
    tokens: { input: number; output: number }
    reviewCycles: number
    dispatches: number
  }

  // -------------------------------------------------------------------------
  // Pipeline phase lifecycle events
  // -------------------------------------------------------------------------

  /** A pipeline phase has started (emitted by full pipeline path for NDJSON visibility) */
  'pipeline:phase-start': {
    phase: string
    ts: string
  }

  /** A pipeline phase has completed (emitted by full pipeline path for NDJSON visibility) */
  'pipeline:phase-complete': {
    phase: string
    ts: string
  }

  /** Pre-flight build check failed before any stories were dispatched */
  'pipeline:pre-flight-failure': {
    exitCode: number
    /** Build output (stdout+stderr), truncated to 2000 chars */
    output: string
  }

  /** Contract verification found a mismatch between declared export/import contracts */
  'pipeline:contract-mismatch': {
    /** Story key that declared the export for this contract */
    exporter: string
    /** Story key that declared the import for this contract (null if no importer found) */
    importer: string | null
    /** TypeScript interface or Zod schema name (e.g., "JudgeResult") */
    contractName: string
    /** Human-readable description of the mismatch */
    mismatchDescription: string
  }

  /** Consolidated contract verification summary (emitted once per verification pass) */
  'pipeline:contract-verification-summary': {
    /** Number of contract declarations verified (current sprint only) */
    verified: number
    /** Number of stale declarations pruned (from previous epics) */
    stalePruned: number
    /** Number of real mismatches found */
    mismatches: number
    /** 'pass' if zero mismatches, 'fail' otherwise */
    verdict: 'pass' | 'fail'
  }

  /** Dolt merge conflict detected when merging a story branch into main */
  'pipeline:state-conflict': {
    storyKey: string
    conflict: unknown
  }

  /**
   * Emitted at pipeline startup when the repo-map symbol index is detected as stale.
   */
  'pipeline:repo-map-stale': {
    /** SHA stored in the repo-map meta (last index update) */
    storedSha: string
    /** Current HEAD commit SHA */
    headSha: string
    /** Number of files in the stored index */
    fileCount: number
  }

  /** Project profile may be outdated relative to the actual project structure */
  'pipeline:profile-stale': {
    /** Human-readable message describing the staleness indicators found */
    message: string
    /** List of staleness indicators detected */
    indicators: string[]
  }

  // -------------------------------------------------------------------------
  // Learning loop events (Story 53-8)
  // -------------------------------------------------------------------------

  /**
   * Emitted when classifyAndPersist() successfully persists a finding from
   * a failing story. Used by observability and monitoring consumers.
   */
  'pipeline:finding-captured': {
    storyKey: string
    runId: string
    rootCause: string
  }

  // -------------------------------------------------------------------------
  // Dispatch gating events (Story 53-9)
  // -------------------------------------------------------------------------

  /**
   * Emitted when a file overlap is detected between a pending story and a
   * completed story, but no namespace collision exists. Dispatch proceeds
   * normally after this event (non-blocking warning).
   */
  'pipeline:dispatch-warn': {
    storyKey: string
    completedStoryKey: string
    overlappingFiles: string[]
  }

  /**
   * Emitted when the dispatch gate cannot resolve a conflict and places the
   * story in the `gated` phase for operator review. Dispatch does not proceed.
   */
  'pipeline:story-gated': {
    storyKey: string
    conflictType: string
    reason: string
    completedStoryKey?: string
  }

  // -------------------------------------------------------------------------
  // Verification pipeline events (Story 51-1)
  // -------------------------------------------------------------------------

  /**
   * Emitted after each individual verification check completes (pass, warn, or fail).
   * AC5: payload matches VerificationCheckResult fields plus storyKey.
   */
  'verification:check-complete': {
    storyKey: string
    checkName: string
    status: 'pass' | 'warn' | 'fail'
    details: string
    duration_ms: number
  }

  /**
   * Emitted once per story after all verification checks have run.
   * AC5: payload is the full VerificationSummary for the story.
   */
  'verification:story-complete': VerificationSummary
}
