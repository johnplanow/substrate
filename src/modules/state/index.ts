/**
 * State module — barrel exports and factory functions.
 *
 * Provides two factories with distinct return types:
 *  - `createStateStore()` returns a `StateStore` (FileStateStore — in-memory,
 *    orchestrator-facing). The Dolt backend was removed from this factory in
 *    Ship 1; see `createDoltOperatorReader` for the Dolt-backed surface.
 *  - `createDoltOperatorReader()` returns a `DoltOperatorReader` (DoltStateStore
 *    — Dolt-backed, operator-CLI-facing). Provides commit-log reads, KV metrics,
 *    branch lifecycle helpers.
 */

// Re-export all types from types.ts.
export type {
  StoryPhase,
  DoltOperatorReader,
  DoltOperatorReaderConfig,
  StateStore,
  StoryRecord,
  StoryFilter,
  MetricRecord,
  MetricFilter,
  ContractRecord,
  ContractFilter,
  ContractVerificationRecord,
  StateStoreConfig,
  HistoryEntry,
  WgStory,
  StoryDependency,
  WgStoryStatus,
} from './types.js'

// Re-export WorkGraphRepository and BlockedStoryInfo.
export { WorkGraphRepository } from './work-graph-repository.js'
export type { BlockedStoryInfo } from './work-graph-repository.js'

// Re-export the FileStateStore class.
export { FileStateStore } from './file-store.js'
export type { FileStateStoreOptions } from './file-store.js'

// Re-export Dolt initialization utilities.
export { initializeDolt, checkDoltInstalled, runDoltCommand, DoltNotInstalled, DoltInitError } from './dolt-init.js'
export type { DoltInitConfig } from './dolt-init.js'

// Re-export the DoltStateStore class and related helpers.
export { DoltStateStore } from './dolt-store.js'
export type { DoltStateStoreOptions } from './dolt-store.js'
export { DoltClient, createDoltClient } from './dolt-client.js'
export type { DoltClientOptions } from './dolt-client.js'

// Re-export typed error classes.
export {
  StateStoreError,
  DoltNotInitializedError,
  DoltQueryError,
  DoltMergeConflictError,
  DoltMergeConflict,
} from './errors.js'

import type { StateStore, StateStoreConfig, DoltOperatorReader, DoltOperatorReaderConfig } from './types.js'
import { FileStateStore } from './file-store.js'
import { DoltStateStore } from './dolt-store.js'
import { DoltClient } from './dolt-client.js'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

/**
 * Create a StateStore for orchestrator use. Returns a FileStateStore — the
 * Dolt backend is no longer routed through this factory (use
 * `createDoltOperatorReader` for operator-side Dolt reads).
 */
export function createStateStore(config: StateStoreConfig = {}): StateStore {
  return new FileStateStore({ basePath: config.basePath })
}

/**
 * Create a DoltOperatorReader for CLI operator commands (history, routing,
 * metrics, health). Constructs a DoltClient against `<basePath>/.dolt/` and
 * exposes only the read-side surface meaningful for operators.
 *
 * Caller is responsible for calling `initialize()` before use and `close()`
 * when done.
 */
export function createDoltOperatorReader(config: DoltOperatorReaderConfig): DoltOperatorReader {
  const repoPath = config.basePath
  const client = new DoltClient({ repoPath })
  return new DoltStateStore({ repoPath, client })
}
