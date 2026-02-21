/**
 * agent-dispatch module — Sub-Agent Dispatch Engine
 *
 * Public API re-exports for the agent-dispatch module.
 */

export type {
  Dispatcher,
  DispatchRequest,
  DispatchHandle,
  DispatchResult,
  DispatchConfig,
} from './types.js'

export { DispatcherShuttingDownError, DEFAULT_TIMEOUTS } from './types.js'

export { extractYamlBlock, parseYamlResult } from './yaml-parser.js'

export { DispatcherImpl, createDispatcher } from './dispatcher-impl.js'
export type { CreateDispatcherOptions } from './dispatcher-impl.js'
