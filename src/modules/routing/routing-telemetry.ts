/**
 * RoutingTelemetry — emits OTEL spans for model routing decisions.
 *
 * Call `recordModelResolved()` immediately after `RoutingResolver.resolveModel()`
 * returns a non-null result to capture per-dispatch routing latency and metadata.
 *
 * References:
 *  - Epic 28, Story 28-6: Routing Telemetry — Per-Phase Token Tracking and OTEL Spans
 */

import type { Logger } from 'pino'

import type { ITelemetryPersistence } from '../../modules/telemetry/index.js'

// ---------------------------------------------------------------------------
// RoutingTelemetry
// ---------------------------------------------------------------------------

/**
 * Emits `routing.model_resolved` OTEL spans via a TelemetryPersistence instance.
 *
 * Injected into the run command alongside RoutingResolver. When telemetry is
 * not configured, pass null to the run command; no spans are emitted.
 */
export class RoutingTelemetry {
  private readonly _telemetry: ITelemetryPersistence
  private readonly _logger: Logger

  constructor(telemetry: ITelemetryPersistence, logger: Logger) {
    this._telemetry = telemetry
    this._logger = logger
  }

  /**
   * Emit a `routing.model_resolved` span for a single routing decision.
   *
   * @param attrs - span attributes including dispatchId, taskType, phase, model, source, latencyMs
   */
  recordModelResolved(attrs: {
    dispatchId: string
    taskType: string
    phase: string
    model: string
    source: string
    latencyMs: number
  }): void {
    this._telemetry.recordSpan({
      name: 'routing.model_resolved',
      attributes: attrs,
    })
    this._logger.debug(attrs, 'routing.model_resolved span emitted')
  }
}
