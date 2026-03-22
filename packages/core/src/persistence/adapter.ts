/**
 * DatabaseAdapter factory for @substrate-ai/core.
 * Uses dependency injection for the DoltClient to avoid cross-package imports.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseAdapter, DatabaseAdapterConfig } from './types.js'
import type { DoltClientLike } from './dolt-adapter.js'
import { DoltDatabaseAdapter } from './dolt-adapter.js'
import { InMemoryDatabaseAdapter } from './memory-adapter.js'

function isDoltAvailable(basePath: string): boolean {
  const result = spawnSync('dolt', ['version'], { stdio: 'ignore' })
  if (result.error != null || result.status !== 0) {
    return false
  }
  const stateDoltDir = join(basePath, '.substrate', 'state', '.dolt')
  return existsSync(stateDoltDir)
}

export function createDatabaseAdapter(
  config: DatabaseAdapterConfig = { backend: 'auto' },
  doltClientFactory?: (repoPath: string) => DoltClientLike,
): DatabaseAdapter {
  const backend = config.backend ?? 'auto'
  const basePath = config.basePath ?? process.cwd()
  const doltRepoPath = join(basePath, '.substrate', 'state')

  if (backend === 'dolt') {
    if (!doltClientFactory) {
      console.debug('[persistence:adapter] dolt backend requested but no doltClientFactory provided; falling back to memory')
      return new InMemoryDatabaseAdapter()
    }
    console.debug('[persistence:adapter] Using DoltDatabaseAdapter (explicit config)')
    return new DoltDatabaseAdapter(doltClientFactory(doltRepoPath))
  }

  if (backend === 'memory') {
    console.debug('[persistence:adapter] Using InMemoryDatabaseAdapter (explicit config)')
    return new InMemoryDatabaseAdapter()
  }

  // 'auto': probe for Dolt, fall back to in-memory
  if (doltClientFactory && isDoltAvailable(basePath)) {
    console.debug('[persistence:adapter] Dolt detected, using DoltDatabaseAdapter')
    return new DoltDatabaseAdapter(doltClientFactory(doltRepoPath))
  }

  console.debug('[persistence:adapter] Dolt not available or no factory, using InMemoryDatabaseAdapter')
  return new InMemoryDatabaseAdapter()
}
