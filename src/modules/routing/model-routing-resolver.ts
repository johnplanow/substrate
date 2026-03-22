/**
 * Re-export shim — routing/model-routing-resolver.ts
 *
 * RoutingResolver, ModelResolution, TASK_TYPE_PHASE_MAP, and
 * ROUTING_RESOLVER_LOGGER_NAME have moved to @substrate-ai/core.
 * createLogger is re-exported from the monolith utils for convenience.
 * This file exists for backwards compatibility with existing monolith imports.
 */
export type { ModelResolution } from '@substrate-ai/core'
export { RoutingResolver, TASK_TYPE_PHASE_MAP, ROUTING_RESOLVER_LOGGER_NAME } from '@substrate-ai/core'

// Re-export createLogger for callers that use this module as a convenience import
export { createLogger } from '../../utils/logger.js'
