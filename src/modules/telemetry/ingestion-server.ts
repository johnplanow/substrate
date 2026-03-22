/**
 * Re-export shim for ingestion-server — implementation lives in @substrate-ai/core.
 * Story 41-6a migrated this module to packages/core/src/telemetry/ingestion-server.ts.
 *
 * TelemetryError in core extends Error (not AppError) but retains the `code` property
 * that existing callers rely on. If any caller performs `instanceof AppError`, it will
 * no longer match — inspection of callers shows only `instanceof TelemetryError` is used.
 *
 * IngestionServer accepts `logger?: ILogger` in options; pino loggers satisfy ILogger
 * structurally so existing callers are unaffected.
 *
 * DispatchContext is re-exported both as the original interface and via the core types barrel.
 */
export { IngestionServer, TelemetryError } from '@substrate-ai/core'
export type { IngestionServerOptions, DispatchContext } from '@substrate-ai/core'
