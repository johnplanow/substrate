/**
 * RoutingTokenAccumulator — collects per-dispatch routing metadata and
 * attributes agent token usage to pipeline phase buckets.
 *
 * Usage:
 *  1. Subscribe `onRoutingSelected` to `routing:model-selected` events.
 *  2. Subscribe `onAgentCompleted` to `agent:completed` events.
 *  3. Call `flush(runId)` at pipeline completion to persist the breakdown.
 *
 * References:
 *  - Epic 28, Story 28-6: Routing Telemetry — Per-Phase Token Tracking and OTEL Spans
 */

import type { ILogger } from '../dispatch/types.js'
import type { ModelRoutingConfig } from './model-routing-config.js'
import type { IStateStore, PhaseTokenBreakdown, PhaseTokenEntry } from './types.js'

// ---------------------------------------------------------------------------
// RoutingTokenAccumulator
// ---------------------------------------------------------------------------

/**
 * Accumulates per-dispatch routing decisions and agent token usage, then
 * flushes an aggregated `PhaseTokenBreakdown` to the IStateStore at run end.
 *
 * Thread-safety: all methods are synchronous accumulators; `flush` is async
 * but should only be called once per run after all dispatches settle.
 */
export class RoutingTokenAccumulator {
  private readonly _config: ModelRoutingConfig
  private readonly _stateStore: IStateStore
  private readonly _logger: ILogger

  /** Maps dispatchId → { phase, model } registered from routing:model-selected events */
  private readonly _dispatchMap: Map<string, { phase: string; model: string }> = new Map()

  /**
   * Bucket key = `"${phase}::${model}"`.
   * Separate entries per (phase, model) combination so mixed-model runs
   * produce distinct rows in the breakdown.
   */
  private readonly _buckets: Map<string, PhaseTokenEntry> = new Map()

  constructor(config: ModelRoutingConfig, stateStore: IStateStore, logger: ILogger) {
    this._config = config
    this._stateStore = stateStore
    this._logger = logger
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  /**
   * Register the routing decision for a dispatch.
   * A second event for the same `dispatchId` overwrites the prior entry (last-writer-wins).
   *
   * @param event - payload from `routing:model-selected`
   */
  onRoutingSelected(event: { dispatchId: string; phase: string; model: string }): void {
    this._dispatchMap.set(event.dispatchId, { phase: event.phase, model: event.model })
    this._logger.debug(
      { dispatchId: event.dispatchId, phase: event.phase, model: event.model },
      'routing:model-selected registered'
    )
  }

  /**
   * Attribute token usage to the phase bucket for this dispatch.
   * Unknown `dispatchId` values are attributed to `phase: 'default', model: 'unknown'`.
   *
   * @param event - payload from `agent:completed` (must include inputTokens / outputTokens)
   */
  onAgentCompleted(event: { dispatchId: string; inputTokens: number; outputTokens: number }): void {
    const mapping = this._dispatchMap.get(event.dispatchId)
    const phase = mapping?.phase ?? 'default'
    const model = mapping?.model ?? 'unknown'
    this._upsertBucket(phase, model, event.inputTokens, event.outputTokens)
    this._logger.debug(
      { dispatchId: event.dispatchId, phase, model, inputTokens: event.inputTokens },
      'agent:completed attributed'
    )
  }

  // ---------------------------------------------------------------------------
  // Flush
  // ---------------------------------------------------------------------------

  /**
   * Construct the `PhaseTokenBreakdown` from the accumulated buckets and
   * persist it to the IStateStore via `setMetric`.
   * Clears all in-memory state afterwards so a second call writes an empty entry.
   *
   * @param runId - the pipeline run ID used to scope the metric key
   */
  async flush(runId: string): Promise<void> {
    const entries = Array.from(this._buckets.values())
    const breakdown: PhaseTokenBreakdown = {
      entries,
      baselineModel: this._config.baseline_model,
      runId,
    }

    await this._stateStore.setMetric(runId, 'phase_token_breakdown', breakdown)

    this._logger.debug(
      { runId, entryCount: entries.length },
      'Phase token breakdown flushed to StateStore'
    )

    // Clear in-memory state — a subsequent flush() will write an empty breakdown.
    this._dispatchMap.clear()
    this._buckets.clear()
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _upsertBucket(
    phase: string,
    model: string,
    inputTokens: number,
    outputTokens: number
  ): void {
    const key = `${phase}::${model}`
    const existing = this._buckets.get(key)
    if (existing) {
      existing.inputTokens += inputTokens
      existing.outputTokens += outputTokens
      existing.dispatchCount += 1
    } else {
      this._buckets.set(key, {
        phase: phase as PhaseTokenEntry['phase'],
        model,
        inputTokens,
        outputTokens,
        dispatchCount: 1,
      })
    }
  }
}
