/**
 * AI Dev Toolkit - Main module exports
 * Public API surface for the toolkit
 */

// Core types
export * from './core/types.js'
// Core errors
export * from './core/errors.js'
// Utilities
export { createLogger, childLogger, logger } from './utils/logger.js'
export * from './utils/helpers.js'

// Adapter subsystem
export { AdapterRegistry } from './adapters/adapter-registry.js'
export type { AdapterDiscoveryResult, DiscoveryReport } from './adapters/adapter-registry.js'
export type { WorkerAdapter } from './adapters/worker-adapter.js'
export type {
  SpawnCommand,
  AdapterOptions,
  AdapterCapabilities,
  AdapterHealthResult,
  TaskResult,
  TokenEstimate,
  PlanRequest,
  PlanParseResult,
  PlannedTask,
} from './adapters/types.js'
export { ClaudeCodeAdapter } from './adapters/claude-adapter.js'
export { CodexCLIAdapter } from './adapters/codex-adapter.js'
export { GeminiCLIAdapter } from './adapters/gemini-adapter.js'
