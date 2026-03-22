/**
 * Re-export shim for normalizer — implementation lives in @substrate-ai/core.
 * Story 41-6a migrated this module to packages/core/src/telemetry/normalizer.ts.
 *
 * The core TelemetryNormalizer accepts ILogger (not pino.Logger directly).
 * pino.Logger satisfies ILogger structurally (method bivariance), so existing
 * callers passing a pino logger continue to work without modification.
 */
export { TelemetryNormalizer } from '@substrate-ai/core'
