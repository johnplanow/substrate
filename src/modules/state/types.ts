/**
 * State persistence types and interfaces.
 *
 * Two surfaces, segregated by use case:
 *  - `DoltOperatorReader` — read-side operations for CLI operator commands
 *    (`substrate history`, `substrate routing`, `substrate metrics`,
 *    `substrate health`, `substrate status --history`). Implemented by
 *    `DoltStateStore` against `.substrate/state/.dolt/`.
 *  - `FileKvStore` (in `./file-store.ts`) — a thin per-project KV persistence
 *    layer used exclusively by routing-tuner and `substrate metrics` for
 *    `phase_token_breakdown` / `routing_tune_log` data (`.substrate/kv-metrics.json`).
 *    Satisfies the narrow `IStateStore` contract from `@substrate-ai/core`
 *    structurally.
 *
 * The pre-2026 `StateStore` interface and its orchestrator-state surface
 * (setStoryState/recordMetric/setContracts/setContractVerification) was
 * removed in v0.20.106 / v0.20.107 (Ships 1 + 2 of the Item 7 arc) — it
 * was a feature-flag-disabled API: production never passed a stateStore to
 * the orchestrator, so every write was a no-op. Canonical durable state lives
 * in the run manifest + initSchema-managed Dolt tables (pipeline_runs,
 * story_metrics, wg_stories, decisions, etc.).
 */

// Re-export StoryPhase from the orchestrator types to avoid duplication.
export type { StoryPhase } from '../implementation-orchestrator/types.js'

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
// WgStoryStatus / WgStory / StoryDependency (Epic 31-1)
// ---------------------------------------------------------------------------

/**
 * Status values for work-graph story nodes.
 * 'cancelled' is set by the SIGTERM/SIGINT handler when the pipeline is stopped (Story 58-7).
 */
export type WgStoryStatus = 'planned' | 'ready' | 'in_progress' | 'complete' | 'escalated' | 'blocked' | 'cancelled'

/**
 * A work-graph story node representing a planning-level story.
 */
export interface WgStory {
  /** Unique story identifier, e.g. "31-1" */
  story_key: string
  /** Epic identifier, e.g. "31" */
  epic: string
  /** Human-readable story title */
  title?: string
  /** Current work-graph status */
  status: WgStoryStatus
  /** Path to the story spec file */
  spec_path?: string
  /** ISO or DATETIME string when the story was created */
  created_at?: string
  /** ISO or DATETIME string when the story was last updated */
  updated_at?: string
  /** ISO or DATETIME string when the story was completed */
  completed_at?: string
}

/**
 * A directed dependency edge between two work-graph stories.
 */
export interface StoryDependency {
  /** The story that depends on another */
  story_key: string
  /** The story being depended upon */
  depends_on: string
  /** 'blocks' = hard dependency; 'informs' = soft/advisory */
  dependency_type: 'blocks' | 'informs'
  /** How the dependency was discovered */
  source: 'explicit' | 'contract' | 'inferred'
  /** ISO or DATETIME string when the dependency was recorded */
  created_at?: string
}

// ---------------------------------------------------------------------------
// DoltOperatorReaderConfig
// ---------------------------------------------------------------------------

/**
 * Configuration passed to createDoltOperatorReader().
 */
export interface DoltOperatorReaderConfig {
  /** Path containing the .dolt/ directory (e.g. `<projectRoot>/.substrate/state`). */
  basePath: string
  /** MySQL port for the Dolt server (optional). */
  doltPort?: number
}

// ---------------------------------------------------------------------------
// DoltOperatorReader interface
// ---------------------------------------------------------------------------

/**
 * Read-side state operations exposed to CLI operator commands.
 *
 * Backed by `DoltStateStore` against the `.substrate/state/.dolt/` repo.
 * Provides Dolt-meaningful read paths: commit log (`getHistory`), key-value
 * metrics (`setMetric`/`getMetric` — stored in-memory per process, scoped by
 * `runId`), and lifecycle.
 */
export interface DoltOperatorReader {
  /** Initialise the backend (open connections, run migrations, etc.). */
  initialize(): Promise<void>

  /** Gracefully close all backend resources. */
  close(): Promise<void>

  /**
   * Persist an arbitrary key-value metric for a run.
   * Keys are scoped by `runId` to avoid collisions across runs.
   * (Currently in-memory per process.)
   */
  setMetric(runId: string, key: string, value: unknown): Promise<void>

  /**
   * Retrieve a previously stored key-value metric for a run.
   * Returns undefined when no value was stored for the given runId+key.
   */
  getMetric(runId: string, key: string): Promise<unknown>

  /** Return a list of Dolt commits newest-first (from the `dolt_log` system table). */
  getHistory(limit?: number): Promise<HistoryEntry[]>
}

// ---------------------------------------------------------------------------
// FileKvStoreOptions
// ---------------------------------------------------------------------------

/**
 * Configuration passed to the `FileKvStore` constructor.
 *
 * Used exclusively by routing-tuner + `substrate metrics` to read/write the
 * per-project `.substrate/kv-metrics.json` corpus (phase token breakdown +
 * tune log). Satisfies the narrow `IStateStore` contract from
 * `@substrate-ai/core/routing` structurally.
 */
export interface FileKvStoreOptions {
  /**
   * Base path for the kv-metrics.json file. When undefined, the store runs
   * purely in memory (used by unit tests).
   */
  basePath?: string
}
