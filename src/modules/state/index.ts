/**
 * State module — barrel exports and factory functions.
 *
 * Two surfaces:
 *  - `FileKvStore` — per-project KV persistence layer for routing-tuner +
 *    `substrate metrics`. Writes `.substrate/kv-metrics.json`.
 *  - `createDoltOperatorReader()` returns a `DoltOperatorReader`
 *    (DoltStateStore — Dolt-backed, operator-CLI-facing). Provides commit-log
 *    reads + per-run KV metrics.
 *
 * The pre-Ship-2 `StateStore` interface and its `createStateStore` factory
 * are gone — the orchestrator never used them in production. See the Item 7
 * arc retrospective for forensics.
 */

// Re-export public types from types.ts.
export type {
  StoryPhase,
  DoltOperatorReader,
  DoltOperatorReaderConfig,
  FileKvStoreOptions,
  HistoryEntry,
  WgStory,
  StoryDependency,
  WgStoryStatus,
} from './types.js'

// Re-export WorkGraphRepository and BlockedStoryInfo.
export { WorkGraphRepository } from './work-graph-repository.js'
export type { BlockedStoryInfo } from './work-graph-repository.js'

// Re-export the FileKvStore class.
export { FileKvStore } from './file-store.js'

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
} from './errors.js'

import type { DoltOperatorReader, DoltOperatorReaderConfig } from './types.js'
import { DoltStateStore } from './dolt-store.js'
import { DoltClient } from './dolt-client.js'

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

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
