/**
 * Re-export shim — routing/routing-engine.ts
 *
 * RoutingEngine interface, related types, and createRoutingEngine factory have
 * moved to @substrate-ai/core. RoutingEngineOptions is provided as an alias
 * for RoutingEngineImplOptions for backwards compatibility.
 * This file exists for backwards compatibility with existing monolith imports.
 */
export type {
  RoutingEngine,
  RoutingTask,
  ModelResolution,
  IRoutingResolver,
} from '@substrate-ai/core'
// RoutingEngineOptions alias — maps to RoutingEngineImplOptions from core
export type { RoutingEngineImplOptions as RoutingEngineOptions } from '@substrate-ai/core'
export { createRoutingEngine } from '@substrate-ai/core'
