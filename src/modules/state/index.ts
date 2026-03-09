/**
 * State module — barrel exports and createStateStore factory.
 *
 * Import from this module to access the StateStore interface, all supporting
 * types, the FileStateStore implementation, the DoltStateStore implementation,
 * and the createStateStore factory.
 */

// Re-export all types from types.ts.
export type {
  StoryPhase,
  StateStore,
  StoryRecord,
  StoryFilter,
  MetricRecord,
  MetricFilter,
  ContractRecord,
  StateDiff,
  StateStoreConfig,
} from './types.js'

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
} from './errors.js'

import type { StateStore, StateStoreConfig } from './types.js'
import { FileStateStore } from './file-store.js'
import { DoltStateStore } from './dolt-store.js'
import { DoltClient } from './dolt-client.js'

// ---------------------------------------------------------------------------
// createStateStore factory
// ---------------------------------------------------------------------------

/**
 * Create a StateStore backed by the specified backend.
 *
 * @param config - Optional configuration. Defaults to `{ backend: 'file' }`.
 * @returns A StateStore instance. Call `initialize()` before use.
 */
export function createStateStore(config: StateStoreConfig = {}): StateStore {
  const backend = config.backend ?? 'file'

  if (backend === 'dolt') {
    const repoPath = config.basePath ?? process.cwd()
    const client = new DoltClient({ repoPath })
    return new DoltStateStore({ repoPath, client })
  }

  // Default: file backend (in-memory Map + optional SQLite metrics).
  return new FileStateStore({ basePath: config.basePath })
}
