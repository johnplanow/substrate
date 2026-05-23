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
  console.warn('[persistence:adapter] Dolt directory found but dolt binary unavailable — retrying once...')
  spawnSync('sleep', ['1'], { stdio: 'ignore' })

  if (isDoltBinaryAvailable()) {
    return true
  }

  console.warn('[persistence:adapter] Dolt still unavailable after retry — falling back to InMemoryDatabaseAdapter. Telemetry and cost data will NOT persist.')
  return false
}

// v0.20.110: Use process.stderr.write (not console.debug) for diagnostic
// logs in this module. Node's console.debug is an alias for console.log,
// which writes to STDOUT — that contaminates the JSON output stream when
// commands like `substrate report --output-format json` call
// createDatabaseAdapter. Routing through stderr keeps stdout pure for JSON
// consumers. Surfaced by the boardgame Item 3 low-output flagging change.
function adapterDiag(message: string): void {
  process.stderr.write('[persistence:adapter] ' + message + '\n')
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
      adapterDiag('dolt backend requested but no doltClientFactory provided; falling back to memory')
      return new InMemoryDatabaseAdapter()
    }
    adapterDiag('Using DoltDatabaseAdapter (explicit config)')
    return new DoltDatabaseAdapter(doltClientFactory(doltRepoPath))
  }

  if (backend === 'memory') {
    adapterDiag('Using InMemoryDatabaseAdapter (explicit config)')
    return new InMemoryDatabaseAdapter()
  }

  // 'auto': probe for Dolt, fall back to in-memory
  if (doltClientFactory && isDoltAvailable(basePath)) {
    adapterDiag('Dolt detected, using DoltDatabaseAdapter')
    return new DoltDatabaseAdapter(doltClientFactory(doltRepoPath))
  }

  adapterDiag('Dolt not available or no factory, using InMemoryDatabaseAdapter')
  return new InMemoryDatabaseAdapter()
}
