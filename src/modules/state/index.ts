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
  AggregateMetricResult,
  ContractRecord,
  ContractFilter,
  ContractVerificationRecord,
  StateDiff,
  StateStoreConfig,
  DiffRow,
  TableDiff,
  StoryDiff,
  HistoryEntry,
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
  DoltMergeConflict,
} from './errors.js'

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import type { StateStore, StateStoreConfig } from './types.js'
import { FileStateStore } from './file-store.js'
import { DoltStateStore } from './dolt-store.js'
import { DoltClient } from './dolt-client.js'
import { createLogger } from '../../utils/logger.js'

// Module-level logger for the factory.
const logger = createLogger('state:factory')

// ---------------------------------------------------------------------------
// Dolt auto-detection helper
// ---------------------------------------------------------------------------

/**
 * Synchronously check whether Dolt is available and a Dolt repo exists at the
 * canonical state path under `basePath`.
 *
 * @param basePath - Project root to check (e.g. `process.cwd()`).
 * @returns `{ available: true, reason: '...' }` when both probes pass,
 *          `{ available: false, reason: '...' }` otherwise.
 */
function detectDoltAvailableSync(basePath: string): { available: boolean; reason: string } {
  // Probe 1: is the dolt binary on PATH?
  const result = spawnSync('dolt', ['version'], { stdio: 'ignore' })
  const binaryFound = result.error == null && result.status === 0
  if (!binaryFound) {
    return { available: false, reason: 'dolt binary not found on PATH' }
  }

  // Probe 2: has a Dolt repo been initialised at the canonical state directory?
  const stateDoltDir = join(basePath, '.substrate', 'state', '.dolt')
  const repoExists = existsSync(stateDoltDir)
  if (!repoExists) {
    return { available: false, reason: `Dolt repo not initialised at ${stateDoltDir}` }
  }

  return { available: true, reason: 'dolt binary found and repo initialised' }
}

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

  if (backend === 'auto') {
    const repoPath = config.basePath ?? process.cwd()
    const detection = detectDoltAvailableSync(repoPath)
    if (detection.available) {
      logger.debug(`Dolt detected, using DoltStateStore (state path: ${join(repoPath, '.substrate', 'state')})`)
      const client = new DoltClient({ repoPath })
      return new DoltStateStore({ repoPath, client })
    } else {
      logger.debug(`Dolt not found, using FileStateStore (reason: ${detection.reason})`)
      return new FileStateStore({ basePath: config.basePath })
    }
  }

  // Default: file backend (in-memory Map + optional SQLite metrics).
  return new FileStateStore({ basePath: config.basePath })
}
