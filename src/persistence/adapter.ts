// src/persistence/adapter.ts — re-export shim (migrated to packages/core in story 41-3)
//
// Re-exports all interfaces and type guards from @substrate-ai/core.
// Wraps the core factory with DoltClient injection so monolith callers
// continue to get Dolt support without any import changes.

// Re-export interfaces and type guard from core
export type { DatabaseAdapter, SyncAdapter, DatabaseAdapterConfig } from '@substrate-ai/core'
export { isSyncAdapter } from '@substrate-ai/core'

// Re-export DoltClientLike for consumers that need the duck-typed interface
export type { DoltClientLike } from '@substrate-ai/core'

import type { DatabaseAdapterConfig } from '@substrate-ai/core'
import { createDatabaseAdapter as coreCreateDatabaseAdapter } from '@substrate-ai/core'
import { DoltClient } from '../modules/state/dolt-client.js'

/**
 * Create a DatabaseAdapter for the specified (or auto-detected) backend.
 *
 * This shim wraps the core factory and injects the concrete DoltClient
 * constructor as the doltClientFactory parameter, so monolith callers
 * get Dolt support transparently.
 */
export function createDatabaseAdapter(config?: DatabaseAdapterConfig) {
  return coreCreateDatabaseAdapter(config, (repoPath) => new DoltClient({ repoPath }))
}
