/**
 * AdapterRegistry — central registry for WorkerAdapter instances
 *
 * Discovers, health-checks, and stores all available CLI agent adapters.
 * Unhealthy adapters are reported but do not block system startup.
 */

import type { AgentId } from '../core/types.js'
import type { WorkerAdapter } from './worker-adapter.js'
import type { AdapterHealthResult } from './types.js'
import { ClaudeCodeAdapter } from './claude-adapter.js'
import { CodexCLIAdapter } from './codex-adapter.js'
import { GeminiCLIAdapter } from './gemini-adapter.js'

/**
 * Result from a single adapter discovery attempt.
 */
export interface AdapterDiscoveryResult {
  /** Adapter id that was tried */
  adapterId: AgentId
  /** Display name of the adapter */
  displayName: string
  /** Health check result */
  healthResult: AdapterHealthResult
  /** Whether the adapter was registered (healthy) */
  registered: boolean
}

/**
 * Summary result from discoverAndRegister().
 */
export interface DiscoveryReport {
  /** Number of adapters successfully registered */
  registeredCount: number
  /** Number of adapters that failed health checks */
  failedCount: number
  /** Per-adapter detail results */
  results: AdapterDiscoveryResult[]
}

/**
 * AdapterRegistry manages the lifecycle of WorkerAdapter instances.
 *
 * Usage:
 * ```typescript
 * const registry = new AdapterRegistry()
 * const report = await registry.discoverAndRegister()
 * const claude = registry.get('claude-code')
 * ```
 */
export class AdapterRegistry {
  private readonly _adapters = new Map<AgentId, WorkerAdapter>()

  /**
   * Register an adapter by its id.
   * Overwrites any existing adapter with the same id.
   */
  register(adapter: WorkerAdapter): void {
    this._adapters.set(adapter.id, adapter)
  }

  /**
   * Retrieve a registered adapter by id.
   * @returns The adapter, or undefined if not registered
   */
  get(id: AgentId): WorkerAdapter | undefined {
    return this._adapters.get(id)
  }

  /**
   * Return all registered adapters as an array.
   */
  getAll(): WorkerAdapter[] {
    return Array.from(this._adapters.values())
  }

  /**
   * Return all registered adapters that support plan generation.
   */
  getPlanningCapable(): WorkerAdapter[] {
    return this.getAll().filter(
      (adapter) => adapter.getCapabilities().supportsPlanGeneration
    )
  }

  /**
   * Instantiate all built-in adapters, run health checks sequentially,
   * and register those that pass.
   *
   * Failed adapters are included in the report but do NOT prevent startup.
   *
   * @returns Discovery report with per-adapter results
   */
  async discoverAndRegister(): Promise<DiscoveryReport> {
    const builtInAdapters: WorkerAdapter[] = [
      new ClaudeCodeAdapter(),
      new CodexCLIAdapter(),
      new GeminiCLIAdapter(),
    ]

    const results: AdapterDiscoveryResult[] = []
    let registeredCount = 0
    let failedCount = 0

    for (const adapter of builtInAdapters) {
      let healthResult: AdapterHealthResult

      try {
        healthResult = await adapter.healthCheck()
      } catch (err) {
        // Catch unexpected errors during health check — adapter should not throw
        const message = err instanceof Error ? err.message : String(err)
        healthResult = {
          healthy: false,
          error: `Unexpected error during health check: ${message}`,
          supportsHeadless: false,
        }
      }

      const registered = healthResult.healthy
      if (registered) {
        this.register(adapter)
        registeredCount++
      } else {
        failedCount++
      }

      results.push({
        adapterId: adapter.id,
        displayName: adapter.displayName,
        healthResult,
        registered,
      })
    }

    return {
      registeredCount,
      failedCount,
      results,
    }
  }
}
