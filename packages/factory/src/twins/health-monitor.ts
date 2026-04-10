/**
 * TwinHealthMonitor — polls twin health endpoints at a configurable interval
 * and emits events when twins become degraded or unhealthy.
 *
 * Story 47-6.
 */

import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'
import type { TwinDefinition } from './types.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Current health status of a monitored twin. */
export type TwinHealthStatus = 'healthy' | 'degraded' | 'unhealthy'

/** Options for configuring the health monitor. */
export interface TwinHealthMonitorOptions {
  /** Milliseconds between health check polls. Default: 30000. */
  monitorIntervalMs?: number
  /** Consecutive failures before emitting twin:health-failed. Default: 3. */
  maxConsecutiveFailures?: number
}

/** Interface for monitoring the health of digital twins during pipeline runs. */
export interface TwinHealthMonitor {
  /** Begin periodic health monitoring for the given twins. */
  start(twins: TwinDefinition[]): void
  /** Stop all polling timers. Idempotent — safe to call multiple times. */
  stop(): void
  /** Returns current health status for all monitored twins. */
  getStatus(): Record<string, TwinHealthStatus>
}

// ---------------------------------------------------------------------------
// Internal state shape
// ---------------------------------------------------------------------------

interface TwinState {
  consecutiveFailures: number
  status: TwinHealthStatus
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a TwinHealthMonitor that polls twin health endpoints and emits
 * health events on the provided event bus.
 *
 * @param eventBus - Factory event bus for emitting health events.
 * @param options  - Optional configuration for polling interval and failure threshold.
 */
export function createTwinHealthMonitor(
  eventBus: TypedEventBus<FactoryEvents>,
  options?: TwinHealthMonitorOptions
): TwinHealthMonitor {
  const monitorIntervalMs = options?.monitorIntervalMs ?? 30000
  const maxConsecutiveFailures = options?.maxConsecutiveFailures ?? 3

  const stateMap = new Map<string, TwinState>()
  const intervals = new Map<string, ReturnType<typeof setInterval>>()

  /**
   * Fetch a twin's health URL with a timeout. Resolves with the Response on
   * success, or rejects with an error on non-2xx, timeout, or connection failure.
   */
  async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Health check timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      fetch(url)
        .then((res) => {
          clearTimeout(timer)
          resolve(res)
        })
        .catch((err: unknown) => {
          clearTimeout(timer)
          reject(err)
        })
    })
  }

  /**
   * Poll a single twin's health endpoint.
   * Updates internal state and emits events as appropriate.
   */
  async function pollTwin(twin: TwinDefinition): Promise<void> {
    if (!twin.healthcheck?.url) return

    const timeoutMs = twin.healthcheck.timeout_ms ?? 5000

    try {
      const response = await fetchWithTimeout(twin.healthcheck.url, timeoutMs)

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
      }

      // Successful poll — reset failure state
      stateMap.set(twin.name, { consecutiveFailures: 0, status: 'healthy' })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      const state = stateMap.get(twin.name)
      const prevFailures = state?.consecutiveFailures ?? 0
      const count = prevFailures + 1

      if (count >= maxConsecutiveFailures) {
        // Twin is now confirmed unhealthy
        stateMap.set(twin.name, { consecutiveFailures: count, status: 'unhealthy' })
        eventBus.emit('twin:health-failed', { twinName: twin.name, error })

        // Stop polling this twin
        const id = intervals.get(twin.name)
        if (id !== undefined) {
          clearInterval(id)
          intervals.delete(twin.name)
        }
      } else {
        // Twin is degraded but not yet confirmed unhealthy
        stateMap.set(twin.name, { consecutiveFailures: count, status: 'degraded' })
        eventBus.emit('twin:health-warning', {
          twinName: twin.name,
          error,
          consecutiveFailures: count,
        })
      }
    }
  }

  return {
    start(twins: TwinDefinition[]): void {
      for (const twin of twins) {
        if (!twin.healthcheck?.url) continue

        // Initialize state
        stateMap.set(twin.name, { consecutiveFailures: 0, status: 'healthy' })

        // Start polling interval.
        // Note: returning the Promise from pollTwin allows vi.advanceTimersByTimeAsync
        // to properly await the async callback in tests.
        const id = setInterval(() => pollTwin(twin), monitorIntervalMs)

        intervals.set(twin.name, id)
      }
    },

    stop(): void {
      for (const id of intervals.values()) {
        clearInterval(id)
      }
      intervals.clear()
    },

    getStatus(): Record<string, TwinHealthStatus> {
      const result: Record<string, TwinHealthStatus> = {}
      for (const [name, state] of stateMap.entries()) {
        result[name] = state.status
      }
      return result
    },
  }
}
