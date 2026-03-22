/**
 * Barrel export for dispatch types, interfaces, and implementation.
 *
 * Re-exports all dispatch symbols from packages/core/src/dispatch/.
 */

export {
  DEFAULT_TIMEOUTS,
  DEFAULT_MAX_TURNS,
  DispatcherShuttingDownError,
} from "./types.js"

export type {
  DispatchRequest,
  DispatchHandle,
  DispatchResult,
  DispatchConfig,
  DispatcherMemoryState,
  Dispatcher,
  ISpawnCommand,
  IAdapterOptions,
  ICliAdapter,
  IAdapterRegistry,
  ILogger,
} from "./types.js"

// Utility exports
export {
  extractYamlBlock,
  parseYamlResult,
} from "./yaml-parser.js"

export {
  detectInterfaceChanges,
  extractExportedNames,
} from "./interface-change-detector.js"

export type {
  InterfaceChangeResult,
} from "./interface-change-detector.js"

// Implementation exports
export {
  DispatcherImpl,
  createDispatcher,
} from "./dispatcher-impl.js"

export type {
  CreateDispatcherOptions,
} from "./dispatcher-impl.js"
