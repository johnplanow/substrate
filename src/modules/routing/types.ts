/**
 * Re-export shim — routing/types.ts
 *
 * All routing types and duck-typed interfaces have moved to @substrate-ai/core.
 * This file exists for backwards compatibility with existing monolith imports.
 */
export type {
  PhaseTokenEntry,
  PhaseTokenBreakdown,
  RoutingRecommendation,
  RoutingAnalysis,
  TuneLogEntry,
  IConfigSystem,
  IMonitorAgent,
  IRoutingTelemetryPersistence,
  ITelemetryPersistence,
  IStateStore,
} from '@substrate-ai/core'
