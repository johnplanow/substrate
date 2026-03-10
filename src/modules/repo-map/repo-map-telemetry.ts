/**
 * RepoMapTelemetry — emits OTEL spans for repo-map query operations.
 *
 * Injected as an optional constructor argument to `RepoMapQueryEngine`.
 * When not provided, query telemetry is silently skipped.
 *
 * References:
 *  - Epic 28, Story 28-6: Routing Telemetry — Per-Phase Token Tracking and OTEL Spans
 */

import type { Logger } from 'pino'

import type { ITelemetryPersistence } from '../../modules/telemetry/index.js'

// ---------------------------------------------------------------------------
// RepoMapTelemetry
// ---------------------------------------------------------------------------

/**
 * Emits `repo_map.query` OTEL spans via a TelemetryPersistence instance.
 *
 * Constructed with an `ITelemetryPersistence` and a logger. Pass an instance
 * to `RepoMapQueryEngine` constructor to enable query telemetry; omit it to
 * skip telemetry without changing existing query behaviour.
 */
export class RepoMapTelemetry {
  private readonly _telemetry: ITelemetryPersistence
  private readonly _logger: Logger

  constructor(telemetry: ITelemetryPersistence, logger: Logger) {
    this._telemetry = telemetry
    this._logger = logger
  }

  /**
   * Emit a `repo_map.query` span.
   *
   * @param attrs - query telemetry attributes
   */
  recordQuery(attrs: {
    queryDurationMs: number
    symbolCount: number
    truncated: boolean
    filterFields: string[]
    error?: boolean
  }): void {
    this._telemetry.recordSpan({
      name: 'repo_map.query',
      attributes: attrs,
    })
    this._logger.debug(attrs, 'repo_map.query span emitted')
  }
}
