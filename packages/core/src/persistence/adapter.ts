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

function isDoltBinaryAvailable(): boolean {
  const result = spawnSync('dolt', ['version'], { stdio: 'ignore' })
  return result.error == null && result.status === 0
}

function isDoltAvailable(basePath: string): boolean {
  const stateDoltDir = join(basePath, '.substrate', 'state', '.dolt')
  if (!existsSync(stateDoltDir)) {
    return false
  }

  if (isDoltBinaryAvailable()) {
    return true
  }

  // Dolt directory exists but binary failed — retry once after 1s
  // (handles lock contention from concurrent processes)
  console.warn(
    '[persistence:adapter] Dolt directory found but dolt binary unavailable — retrying once...'
  )
  spawnSync('sleep', ['1'], { stdio: 'ignore' })

  if (isDoltBinaryAvailable()) {
    return true
  }

  console.warn(
    '[persistence:adapter] Dolt still unavailable after retry — falling back to InMemoryDatabaseAdapter. Telemetry and cost data will NOT persist.'
  )
  return false
}

export function createDatabaseAdapter(
  config: DatabaseAdapterConfig = { backend: 'auto' },
  doltClientFactory?: (repoPath: string) => DoltClientLike
): DatabaseAdapter {
  const backend = config.backend ?? 'auto'
  const basePath = config.basePath ?? process.cwd()
  const doltRepoPath = join(basePath, '.substrate', 'state')

  if (backend === 'dolt') {
    if (!doltClientFactory) {
      console.debug(
        '[persistence:adapter] dolt backend requested but no doltClientFactory provided; falling back to memory'
      )
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

  console.debug(
    '[persistence:adapter] Dolt not available or no factory, using InMemoryDatabaseAdapter'
  )
  return new InMemoryDatabaseAdapter()
}
