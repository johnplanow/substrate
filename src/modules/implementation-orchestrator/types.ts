/**
 * Types and enums for the Implementation Orchestrator module.
 *
 * Defines the orchestrator state machine, story lifecycle states,
 * configuration, and status reporting structures.
 */

// ---------------------------------------------------------------------------
// Orchestrator state
// ---------------------------------------------------------------------------

/**
 * Overall state of the orchestrator run.
 */
export type OrchestratorState = 'IDLE' | 'RUNNING' | 'PAUSED' | 'COMPLETE' | 'FAILED'

// ---------------------------------------------------------------------------
// Story phase
// ---------------------------------------------------------------------------

/**
 * Lifecycle phase of an individual story within the pipeline.
 */
export type StoryPhase =
  | 'PENDING'
  | 'IN_STORY_CREATION'
  | 'IN_TEST_PLANNING'
  | 'IN_DEV'
  | 'IN_REVIEW'
  | 'NEEDS_FIXES'
  | 'COMPLETE'
  | 'ESCALATED'
  | 'CHECKPOINT'
  | 'VERIFICATION_FAILED'

// ---------------------------------------------------------------------------
// StoryState
// ---------------------------------------------------------------------------

/**
 * Per-story tracking state within an orchestrator run.
 */
export interface StoryState {
  /** Current lifecycle phase of this story */
  phase: StoryPhase
  /** Number of code review cycles completed for this story */
  reviewCycles: number
  /** Last verdict from code review (if any) */
  lastVerdict?: string
  /** Error message if this story encountered a fatal error */
  error?: string
  /** ISO timestamp when this story's processing started */
  startedAt?: string
  /** ISO timestamp when this story's processing completed or was escalated */
  completedAt?: string
  /**
   * Number of files modified at the time of a dev-story timeout checkpoint.
   * Only set when phase === 'CHECKPOINT'.
   */
  checkpointFilesCount?: number
  /**
   * A0.3 (acceptance-gate): journey ids this story claims via `journeys:`
   * frontmatter tags (validated against the trusted-tree registry at
   * create-story time). Input to the epic-close coverage audit.
   */
  journeys?: string[]
}

// ---------------------------------------------------------------------------
// OrchestratorConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for an orchestrator run.
 */
export interface OrchestratorConfig {
  /** Maximum number of conflict groups running in parallel */
  maxConcurrency: number
  /**
   * v0.20.109: files (relative to projectRoot) to copy into each per-story
   * worktree after `git worktree add`. Useful for gitignored env files
   * (e.g. `.env`, `.env.local`) that build tooling needs but git doesn't
   * carry into the worktree. Sourced from `worktree.copy_files` in
   * `.substrate/config.yaml`. Default: empty (no files copied).
   */
  worktreeCopyFiles?: readonly string[]
  /** Maximum number of code review cycles per story before escalation */
  maxReviewCycles: number
  /** Per-story maximum retry attempts before mandatory escalation. Default: 2 (Story 53-4). */
  retryBudget?: number
  /** Optional pipeline run ID for state persistence */
  pipelineRunId?: string
  /**
   * Whether to enable the heartbeat/watchdog timer.
   * Should only be true when --events mode is active; otherwise the timer
   * fires and emits eventBus events with no listeners, wasting CPU.
   * Defaults to false.
   */
  enableHeartbeat?: boolean
  /**
   * Duration (ms) of the pause inserted after each story for GC hint.
   * Default: 2000 ms (Story 23-8, AC2).
   * Set to 0 in tests to avoid 2-second delays per story.
   */
  gcPauseMs?: number
  /**
   * When true, skip the pre-flight build check (Story 25-2).
   * Escape hatch for known-broken projects. Pass `--skip-preflight` from CLI.
   */
  skipPreflight?: boolean
  /**
   * When true, skip per-story post-dev build verification (Story 24-2).
   * Independent from skipPreflight — pre-flight checks "can this project build
   * at all?" while per-story checks "did this story break the build?".
   */
  skipBuildVerify?: boolean
  /**
   * Sprint identifier for state store persistence (Story 26-4).
   * When set, persisted StoryRecords include this value in the sprint field.
   * Falls back to undefined when absent, resulting in no sprint label on records.
   */
  sprint?: string
  /**
   * Per-story context token ceilings (Story 30-8). Historically passed as
   * --max-context-tokens to every dispatch for the story; that flag was removed
   * in Claude Code v2.x and is now silently ignored by the claude-adapter. The
   * field is preserved for backward compat but no longer affects dispatch.
   */
  perStoryContextCeilings?: Record<string, number>
  /**
   * When true, skip the post-dispatch Tier A verification pipeline (Story 51-5).
   * Escape hatch for debugging.
   */
  skipVerification?: boolean
  /**
   * Grace period in ms to await in-flight dispatches before SIGTERM/SIGINT exits. Default 5000.
   */
  shutdownGracePeriodMs?: number
  /**
   * Story 60-14: probe-author phase mode.
   *  - 'enabled':  always run the probe-author phase (between create-story and test-plan)
   *  - 'disabled': always skip — falls back to dev-authored probes path
   *  - 'auto':     read SUBSTRATE_PROBE_AUTHOR_ENABLED env var; default true when env absent
   *
   * Per-run override via `--probe-author=enabled|disabled|auto` CLI flag. Used by
   * the A/B validation harness (Phase 2 go/no-go gate) to compare authored vs
   * dev-authored probe quality across the defect-replay corpus.
   */
  probeAuthorMode?: 'enabled' | 'disabled' | 'auto'
  /**
   * Story 65-2: ramp-DOWN feature flag for state-integrating AC probe-author dispatch.
   *  - `true` (default): dispatch probe-author for state-integrating ACs (Phase 3 enabled)
   *  - `false`: skip `detectsStateIntegratingAC()` branch — only event-driven ACs dispatch
   *
   * Controlled via `--probe-author-state-integrating=on|off` CLI flag or
   * `SUBSTRATE_PROBE_AUTHOR_STATE_INTEGRATING=on|off` env var.
   * CLI flag takes precedence when both are set. Defaults to `true` (on) when absent.
   * Use to ramp DOWN if catch rate drops below the GREEN threshold without modifying source.
   */
  probeAuthorStateIntegrating?: boolean
  /**
   * Story 75-1 (Path E spike 2026-05-10): opt-out flag for per-story worktree isolation.
   * When true, the per-story worktree is NOT created and `effectiveProjectRoot` falls back
   * to `projectRoot`. Set via `--no-worktree` CLI flag (Story 75-3).
   * Default: false (worktrees enabled by default when projectRoot is defined).
   */
  noWorktree?: boolean
  /**
   * H3.1 (hardening program): how a verified story integrates.
   * 'merge' (default) = local merge to the start branch (today's behavior);
   * 'branch' = commit and stop — the story branch is the deliverable, nothing
   * self-merges; 'pr' = branch + push + `gh pr create`, degrading to 'branch'
   * on push/gh failure. Set via `--finalization` or config `finalization.mode`.
   */
  finalizationMode?: 'merge' | 'branch' | 'pr'
  /**
   * H3.3 (AC2): merge strategy for merge-mode finalization. 'ff-only'
   * (default) escalates instead of synthesizing a merge commit when the base
   * branch moved; 'three-way' restores the pre-H3.3 fallback.
   * Config: `finalization.merge_strategy`.
   */
  mergeStrategy?: 'ff-only' | 'three-way'
  /**
   * H3.4: shell command gating the LAST story of an epic before merge/pr
   * finalization. Non-zero exit → the story escalates `epic-gate-failed`
   * with the command output; the branch is preserved. Not run in branch mode.
   * Config: `finalization.epic_gate_command`.
   */
  epicGateCommand?: string
  /**
   * A0.3 (acceptance-gate): journey-coverage audit posture. `off` skips the
   * audit; `advisory` (default when a registry exists) emits coverage events +
   * warnings; `blocking` escalates `journey-unclaimed` / `journey-unwalked`
   * on the LAST story of the audited epic before it integrates.
   * Config: `acceptance.mode`.
   */
  acceptanceMode?: 'off' | 'advisory' | 'blocking'
}

// ---------------------------------------------------------------------------
// DecompositionMetrics
// ---------------------------------------------------------------------------

/**
 * Decomposition metrics emitted when a story is dispatched via batched dev-story.
 * Absent for non-decomposed (simple) stories — AC6: clean output for simple stories.
 */
export interface DecompositionMetrics {
  /** Total number of tasks identified in the story */
  totalTasks: number
  /** Number of batches the tasks were split into */
  batchCount: number
  /** Number of tasks per batch, in dispatch order */
  batchSizes: number[]
}

// ---------------------------------------------------------------------------
// PerBatchMetrics
// ---------------------------------------------------------------------------

/**
 * Per-batch telemetry logged during the batched dev-story dispatch loop.
 * Logged at INFO level for each batch dispatched (AC2).
 */
export interface PerBatchMetrics {
  /** Zero-based index of this batch */
  batchIndex: number
  /** Task IDs included in this batch */
  taskIds: number[]
  /** Token usage from this batch dispatch */
  tokensUsed: { input: number; output: number }
  /** Wall-clock duration of this batch dispatch in milliseconds */
  durationMs: number
  /** Files reported as modified by this batch */
  filesModified: string[]
  /** Whether this batch completed successfully or failed */
  result: 'success' | 'failed'
}

// ---------------------------------------------------------------------------
// OrchestratorStatus
// ---------------------------------------------------------------------------

/**
 * Full status snapshot of the orchestrator and all managed stories.
 */
export interface OrchestratorStatus {
  /** Current state of the orchestrator */
  state: OrchestratorState
  /** Per-story state keyed by story key */
  stories: Record<string, StoryState>
  /** ISO timestamp when run() was called */
  startedAt?: string
  /** ISO timestamp when orchestrator reached COMPLETE or FAILED */
  completedAt?: string
  /** Total elapsed milliseconds (only set when completedAt is set) */
  totalDurationMs?: number
  /**
   * Decomposition metrics for the most recent pipeline run.
   * Present only when at least one story was decomposed into batches (AC1).
   * Absent for simple (non-decomposed) stories (AC6).
   */
  decomposition?: DecompositionMetrics
  /**
   * Peak number of conflict groups running concurrently during this run.
   * Always <= maxConcurrency and <= total group count.
   */
  maxConcurrentActual?: number
  /**
   * Contract verification warnings from the post-sprint gate (Story 25-6).
   * Present when one or more declared export/import contracts failed verification.
   * Failures are non-blocking — stories already completed.
   */
  contractMismatches?: ContractMismatch[]
}

// ---------------------------------------------------------------------------
// ContractMismatch
// ---------------------------------------------------------------------------

/**
 * A single contract verification failure from the post-sprint gate (Story 25-6).
 */
export interface ContractMismatch {
  /** Story key that declared the export */
  exporter: string
  /** Story key that declared the import (null if no importer found) */
  importer: string | null
  /** Contract name (TypeScript interface or Zod schema name) */
  contractName: string
  /** Human-readable description of the mismatch */
  mismatchDescription: string
}
