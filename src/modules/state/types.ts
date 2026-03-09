/**
 * StateStore abstraction layer — type definitions and interface.
 *
 * Defines the StateStore interface and all supporting types.
 * The file-based backend (FileStateStore) wraps existing in-memory and
 * SQLite behaviour; future backends (e.g. Dolt, Story 26-3) implement this
 * same interface without touching consumer code.
 */

// Re-export StoryPhase from the orchestrator types to avoid duplication.
export type { StoryPhase } from '../implementation-orchestrator/types.js'

import type { StoryPhase } from '../implementation-orchestrator/types.js'

// ---------------------------------------------------------------------------
// StoryRecord
// ---------------------------------------------------------------------------

/**
 * Persisted state for a single story across the pipeline lifecycle.
 */
export interface StoryRecord {
  /** Unique story identifier, e.g. "26-1" */
  storyKey: string
  /** Current lifecycle phase */
  phase: StoryPhase
  /** Number of code-review cycles completed */
  reviewCycles: number
  /** Last verdict from code review, if any */
  lastVerdict?: string
  /** Error message if the story encountered a fatal error */
  error?: string
  /** ISO timestamp when processing started */
  startedAt?: string
  /** ISO timestamp when processing completed or was escalated */
  completedAt?: string
  /** Sprint identifier, e.g. "sprint-1" */
  sprint?: string
}

// ---------------------------------------------------------------------------
// StoryFilter
// ---------------------------------------------------------------------------

/**
 * Filter criteria for querying stories from the store.
 */
export interface StoryFilter {
  /** Match one phase or an array of phases */
  phase?: StoryPhase | StoryPhase[]
  /** Match a specific sprint */
  sprint?: string
  /** Match a specific story key */
  storyKey?: string
}

// ---------------------------------------------------------------------------
// MetricRecord
// ---------------------------------------------------------------------------

/**
 * A single telemetry record for a pipeline task dispatch.
 */
export interface MetricRecord {
  storyKey: string
  taskType: string
  model?: string
  tokensIn?: number
  tokensOut?: number
  cacheReadTokens?: number
  costUsd?: number
  wallClockMs?: number
  reviewCycles?: number
  stallCount?: number
  result?: string
  recordedAt?: string
  /** Sprint identifier, e.g. "sprint-1" */
  sprint?: string
  /** ISO timestamp alias for recordedAt (used in CLI display) */
  timestamp?: string
  /** Number of records in an aggregated result set (populated when MetricFilter.aggregate=true) */
  count?: number
}

// ---------------------------------------------------------------------------
// MetricFilter
// ---------------------------------------------------------------------------

/**
 * Filter criteria for querying metrics from the store.
 */
export interface MetricFilter {
  storyKey?: string
  taskType?: string
  sprint?: string
  dateFrom?: string
  dateTo?: string
  story_key?: string
  task_type?: string
  /** ISO date string — only records at or after this timestamp are returned */
  since?: string
  /** When true, return aggregated results grouped by task_type */
  aggregate?: boolean
}

// ---------------------------------------------------------------------------
// AggregateMetricResult
// ---------------------------------------------------------------------------

/**
 * Aggregated metric results grouped by task type.
 */
export interface AggregateMetricResult {
  task_type: string
  avg_cost_usd: number
  sum_tokens_in: number
  sum_tokens_out: number
  count: number
}

// ---------------------------------------------------------------------------
// ContractRecord
// ---------------------------------------------------------------------------

/**
 * An interface-contract declaration associated with a story.
 */
export interface ContractRecord {
  storyKey: string
  contractName: string
  direction: 'export' | 'import'
  schemaPath: string
  transport?: string
}

// ---------------------------------------------------------------------------
// ContractFilter
// ---------------------------------------------------------------------------

/**
 * Filter criteria for querying interface-contract declarations.
 */
export interface ContractFilter {
  /** Match a specific story key */
  storyKey?: string
  /** Match a specific direction */
  direction?: 'export' | 'import'
}

// ---------------------------------------------------------------------------
// ContractVerificationRecord
// ---------------------------------------------------------------------------

/**
 * Result of verifying a single interface-contract declaration.
 */
export interface ContractVerificationRecord {
  storyKey: string
  contractName: string
  verdict: 'pass' | 'fail'
  mismatchDescription?: string
  verifiedAt: string
}

// ---------------------------------------------------------------------------
// StateDiff
// ---------------------------------------------------------------------------

/**
 * Diff of state changes for a story (used by Dolt backend for branch diffs).
 * The file backend always returns an empty changes array.
 */
export interface StateDiff {
  storyKey: string
  changes: Array<{
    table: string
    rowKey: string
    before?: unknown
    after?: unknown
  }>
}

// ---------------------------------------------------------------------------
// DiffRow / TableDiff / StoryDiff — row-level diff (Story 26-7, 26-9)
// ---------------------------------------------------------------------------

/**
 * A single row change entry from DOLT_DIFF SQL output.
 */
export interface DiffRow {
  rowKey: string
  before?: Record<string, unknown>
  after?: Record<string, unknown>
}

/**
 * Per-table row-level diff from DOLT_DIFF SQL output.
 * Arrays of DiffRow entries for each change category.
 */
export interface TableDiff {
  table: string
  added: DiffRow[]
  modified: DiffRow[]
  deleted: DiffRow[]
}

/**
 * Aggregate diff for a single story execution, with row-level changes per table.
 * Returned by diffStory() on the Dolt backend; file backend returns empty tables array.
 */
export interface StoryDiff {
  storyKey: string
  tables: TableDiff[]
}

// ---------------------------------------------------------------------------
// HistoryEntry (Story 26-9)
// ---------------------------------------------------------------------------

/**
 * A single entry in the Dolt commit history.
 */
export interface HistoryEntry {
  /** Short commit hash (7 chars) */
  hash: string
  /** ISO 8601 timestamp */
  timestamp: string
  /** Story key extracted from commit message (e.g. "26-7"), or null if absent */
  storyKey: string | null
  /** Full commit message subject line */
  message: string
  /** Commit author name (optional — populated by Dolt backend when available) */
  author?: string
}

// ---------------------------------------------------------------------------
// StateStoreConfig
// ---------------------------------------------------------------------------

/**
 * Configuration passed to createStateStore().
 */
export interface StateStoreConfig {
  /**
   * Storage backend to use. Defaults to `'file'`.
   *
   * - `'file'`  — in-memory Map + optional SQLite metrics (default, always available)
   * - `'dolt'`  — Dolt-backed versioned state (requires Dolt binary on PATH)
   * - `'auto'`  — auto-detect: uses `'dolt'` when the Dolt binary is on PATH and a
   *               Dolt repo exists at `<basePath>/.substrate/state/.dolt/`; falls back
   *               to `'file'` otherwise. The default will be changed to `'auto'` in
   *               Epic 29 once Dolt is proven under production load.
   */
  backend?: 'file' | 'dolt' | 'auto'
  /** Base path for file-based storage (optional). */
  basePath?: string
  /** MySQL port for the Dolt backend (optional). */
  doltPort?: number
}

// ---------------------------------------------------------------------------
// StateStore interface
// ---------------------------------------------------------------------------

/**
 * Unified state store abstraction for pipeline modules.
 *
 * All implementations are async; the file backend resolves immediately while
 * the Dolt backend awaits actual DB round-trips.
 */
export interface StateStore {
  /** Initialise the backend (open connections, run migrations, etc.). */
  initialize(): Promise<void>

  /** Gracefully close all backend resources. */
  close(): Promise<void>

  // -- Story state -----------------------------------------------------------

  /** Retrieve the current state record for a story, or undefined if unknown. */
  getStoryState(storyKey: string): Promise<StoryRecord | undefined>

  /** Persist (create or replace) the state record for a story. */
  setStoryState(storyKey: string, state: StoryRecord): Promise<void>

  /** Return all stories matching the given filter criteria. */
  queryStories<T extends StoryFilter>(filter: T): Promise<StoryRecord[]>

  // -- Metrics ---------------------------------------------------------------

  /** Record a single metric observation. */
  recordMetric(metric: MetricRecord): Promise<void>

  /** Query stored metrics, optionally filtered. */
  queryMetrics(filter: MetricFilter): Promise<MetricRecord[]>

  // -- Contracts -------------------------------------------------------------

  /** Get all interface-contract declarations for a story. */
  getContracts(storyKey: string): Promise<ContractRecord[]>

  /** Persist (replace) the interface-contract declarations for a story. */
  setContracts(storyKey: string, contracts: ContractRecord[]): Promise<void>

  /** Query all interface-contract declarations, optionally filtered. */
  queryContracts(filter?: ContractFilter): Promise<ContractRecord[]>

  /** Persist contract verification results for a story. */
  setContractVerification(storyKey: string, results: ContractVerificationRecord[]): Promise<void>

  /** Retrieve contract verification results for a story. */
  getContractVerification(storyKey: string): Promise<ContractVerificationRecord[]>

  // -- Branching (Dolt backend; no-ops for file backend) ---------------------

  /** Create a branch for isolated story execution. */
  branchForStory(storyKey: string): Promise<void>

  /** Merge the story branch back into main. */
  mergeStory(storyKey: string): Promise<void>

  /** Roll back all changes made on the story branch. */
  rollbackStory(storyKey: string): Promise<void>

  /** Compute a stat-based diff of database changes for the story branch. */
  diffStory(storyKey: string): Promise<StoryDiff>

  /** Return a list of Dolt commits newest-first. File backend returns []. */
  getHistory(limit?: number): Promise<HistoryEntry[]>
}
