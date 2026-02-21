/**
 * Dispatcher interface re-export.
 *
 * The Dispatcher interface and related types are defined in types.ts.
 * This file re-exports them for convenience and module clarity.
 */

export type { Dispatcher, DispatchRequest, DispatchHandle, DispatchResult, DispatchConfig } from './types.js'
export { DispatcherShuttingDownError, DEFAULT_TIMEOUTS } from './types.js'
