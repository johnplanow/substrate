/**
 * Re-export shim — routing/routing-engine-impl.ts
 *
 * RoutingEngineImpl, RoutingEngineImplOptions, createRoutingEngineImpl, and
 * createRoutingEngine have moved to @substrate-ai/core.
 * This file exists for backwards compatibility with existing monolith imports.
 */
export type { RoutingEngineImplOptions } from '@substrate-ai/core'
export { RoutingEngineImpl, createRoutingEngineImpl, createRoutingEngine } from '@substrate-ai/core'
