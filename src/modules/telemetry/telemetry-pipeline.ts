/**
 * Re-export shim for telemetry-pipeline — implementation lives in @substrate-ai/core.
 * Story 41-6a migrated this module to packages/core/src/telemetry/telemetry-pipeline.ts.
 *
 * The core TelemetryPipelineDeps uses duck-typed interfaces for scoring dependencies.
 * Existing callers pass concrete classes (TurnAnalyzer, Categorizer, etc.) which
 * satisfy those interfaces structurally in TypeScript.
 *
 * RawOtlpPayload is defined in @substrate-ai/core types and re-exported here
 * for backward compatibility (monolith callers import it from this path).
 */
export { TelemetryPipeline } from '@substrate-ai/core'
export type { TelemetryPipelineDeps } from '@substrate-ai/core'
// RawOtlpPayload lives in core types, re-exported for callers that import it here
export type { RawOtlpPayload } from '@substrate-ai/core'
