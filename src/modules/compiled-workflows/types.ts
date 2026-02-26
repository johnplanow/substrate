/**
 * Shared types for the compiled-workflows module.
 *
 * Defines the dependency injection contracts (WorkflowDeps) and the
 * result types for each compiled workflow function.
 */

import type { Database as BetterSqlite3Database } from 'better-sqlite3'
import type { MethodologyPack } from '../methodology-pack/types.js'
import type { ContextCompiler } from '../context-compiler/context-compiler.js'
import type { Dispatcher } from '../agent-dispatch/types.js'

// ---------------------------------------------------------------------------
// WorkflowDeps — dependency injection container
// ---------------------------------------------------------------------------

/**
 * Dependencies required by all compiled workflow functions.
 * All services are injected — no direct imports of implementation files.
 */
export interface WorkflowDeps {
  /** Better-SQLite3 database instance (ADR-003: SQLite WAL) */
  db: BetterSqlite3Database
  /** Loaded methodology pack providing compiled prompt templates */
  pack: MethodologyPack
  /** Context compiler for assembling decision-store context */
  contextCompiler: ContextCompiler
  /** Agent dispatcher for spawning sub-agents */
  dispatcher: Dispatcher
  /** Optional project root for file-based context fallback when decision store is empty */
  projectRoot?: string
}

// ---------------------------------------------------------------------------
// CreateStory types
// ---------------------------------------------------------------------------

/**
 * Parameters for the create-story compiled workflow.
 */
export interface CreateStoryParams {
  /** ID of the epic to create a story for */
  epicId: string
  /** Story key to be created (e.g., "10-2-dev-story") */
  storyKey: string
  /** Optional pipeline run ID for decision store context */
  pipelineRunId?: string
}

/**
 * Result from the create-story compiled workflow.
 */
export interface CreateStoryResult {
  /** Whether the workflow succeeded or failed */
  result: 'success' | 'failed'
  /** Path to the created story file (success only) */
  story_file?: string
  /** Key of the created story (success only) */
  story_key?: string
  /** Title of the created story (success only) */
  story_title?: string
  /** Error description (failure only) */
  error?: string
  /** Additional error details (validation failure) */
  details?: string
  /** Token usage from the dispatch */
  tokenUsage: {
    input: number
    output: number
  }
}

// ---------------------------------------------------------------------------
// DevStory types
// ---------------------------------------------------------------------------

/**
 * Parameters for the dev-story compiled workflow.
 */
export interface DevStoryParams {
  /** Story key (e.g., "10-2-dev-story") for tracking */
  storyKey: string
  /** Absolute path to the story file on disk */
  storyFilePath: string
  /** Optional pipeline run ID for decision store context */
  pipelineRunId?: string
  /**
   * Optional task scope string specifying which tasks to implement.
   * When provided, the prompt instructs the agent to implement ONLY these tasks.
   * Format: "T1: <title>\nT2: <title>\n..."
   */
  taskScope?: string
  /**
   * Optional list of files created/modified by previous batches.
   * Injected into the prompt as prior context for subsequent batch dispatches.
   */
  priorFiles?: string[]
}

/**
 * Result from the dev-story compiled workflow.
 */
export interface DevStoryResult {
  /** Whether the workflow succeeded or failed */
  result: 'success' | 'failed'
  /** Acceptance criteria that were met */
  ac_met: string[]
  /** Acceptance criteria that failed */
  ac_failures: string[]
  /** Files modified during implementation */
  files_modified: string[]
  /** Whether tests passed or failed */
  tests: 'pass' | 'fail'
  /** Optional notes from the implementation agent */
  notes?: string
  /** Error description (failure only) */
  error?: string
  /** Additional error details (validation/schema failure) */
  details?: string
  /** Token usage from the dispatch */
  tokenUsage: {
    input: number
    output: number
  }
}

// ---------------------------------------------------------------------------
// CodeReview types
// ---------------------------------------------------------------------------

/**
 * Parameters for the code-review compiled workflow.
 */
export interface CodeReviewParams {
  /** Story key (e.g., "10-3-code-review") for tracking */
  storyKey: string
  /** Absolute path to the story file on disk */
  storyFilePath: string
  /** Optional working directory for git diff capture (defaults to process.cwd()) */
  workingDirectory?: string
  /** Optional pipeline run ID for decision store context */
  pipelineRunId?: string
  /** Optional list of files modified by dev-story, used to scope the git diff */
  filesModified?: string[]
  /** Optional previous review issues — when present, scopes re-review to verify these were fixed */
  previousIssues?: Array<{ severity?: string; description?: string; file?: string; line?: number }>
}

/**
 * A single issue identified during code review.
 */
export interface CodeReviewIssue {
  /** Severity of the issue */
  severity: 'blocker' | 'major' | 'minor'
  /** Human-readable description of the issue */
  description: string
  /** Optional source file path where the issue was found */
  file?: string
  /** Optional line number where the issue was found */
  line?: number
}

/**
 * Result from the code-review compiled workflow.
 */
export interface CodeReviewResult {
  /** Pipeline-computed verdict (derived from issue_list severities) */
  verdict: 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK'
  /** Agent's original verdict before pipeline override (for logging) */
  agentVerdict?: 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK'
  /** Total number of issues found */
  issues: number
  /** Detailed list of issues */
  issue_list: CodeReviewIssue[]
  /** Optional notes from the reviewer */
  notes?: string
  /** Error description (failure only) */
  error?: string
  /** Additional error details (schema validation failure) */
  details?: string
  /** Raw agent output for artifact persistence (diagnosis of schema failures) */
  rawOutput?: string
  /** Token usage from the dispatch */
  tokenUsage: {
    input: number
    output: number
  }
}
