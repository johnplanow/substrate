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
  /** True when the dispatch itself failed (crash, timeout, non-zero exit) as opposed to schema validation failure */
  dispatchFailed?: boolean
  /** Raw agent output for artifact persistence (diagnosis of schema failures) */
  rawOutput?: string
  /** Token usage from the dispatch */
  tokenUsage: {
    input: number
    output: number
  }
}

// ---------------------------------------------------------------------------
// TestPlan types
// ---------------------------------------------------------------------------

/**
 * Parameters for the test-plan compiled workflow.
 */
export interface TestPlanParams {
  /** Story key (e.g., "22-7") for tracking */
  storyKey: string
  /** Absolute path to the story file on disk */
  storyFilePath: string
  /** Pipeline run ID for decision store persistence */
  pipelineRunId: string
}

/**
 * Result from the test-plan compiled workflow.
 */
export interface TestPlanResult {
  /** Whether the workflow succeeded or failed */
  result: 'success' | 'failed'
  /** Planned test file paths */
  test_files: string[]
  /** Test categories (unit, integration, e2e) */
  test_categories: string[]
  /** Coverage notes mapping ACs to test files */
  coverage_notes: string
  /** Error description (failure only) */
  error?: string
  /** Token usage from the dispatch */
  tokenUsage: {
    input: number
    output: number
  }
}

// ---------------------------------------------------------------------------
// TestExpansion types
// ---------------------------------------------------------------------------

/**
 * A single coverage gap identified during post-implementation test expansion.
 */
export interface CoverageGap {
  /** Acceptance criterion reference (e.g., "AC1") */
  ac_ref: string
  /** Human-readable description of the gap */
  description: string
  /** Type of gap — missing E2E, missing integration, or unit-only coverage */
  gap_type: 'missing-e2e' | 'missing-integration' | 'unit-only'
}

/**
 * A single suggested test generated during test expansion analysis.
 */
export interface SuggestedTest {
  /** Name of the suggested test */
  test_name: string
  /** Type of test to write */
  test_type: 'e2e' | 'integration' | 'unit'
  /** Human-readable description of what the test should verify */
  description: string
  /** Optional acceptance criterion reference this test targets */
  target_ac?: string
}

/**
 * Parameters for the test-expansion compiled workflow.
 */
export interface TestExpansionParams {
  /** Story key (e.g., "22-9") for tracking */
  storyKey: string
  /** Absolute path to the story file on disk */
  storyFilePath: string
  /** Optional pipeline run ID for decision store context */
  pipelineRunId?: string
  /** Optional list of files modified by dev-story, used to scope the git diff */
  filesModified?: string[]
  /** Optional working directory for git diff capture (defaults to process.cwd()) */
  workingDirectory?: string
}

/**
 * Result from the test-expansion compiled workflow.
 */
export interface TestExpansionResult {
  /** Priority of the identified expansion work */
  expansion_priority: 'low' | 'medium' | 'high'
  /** List of identified coverage gaps */
  coverage_gaps: CoverageGap[]
  /** List of suggested tests to close the gaps */
  suggested_tests: SuggestedTest[]
  /** Optional notes from the analysis agent */
  notes?: string
  /** Error description (graceful fallback only) */
  error?: string
  /** Token usage from the dispatch */
  tokenUsage: {
    input: number
    output: number
  }
}
