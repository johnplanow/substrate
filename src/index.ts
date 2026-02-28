/**
 * Substrate - Main module exports
 * Public API surface for the toolkit
 */

// Core types
export * from './core/types.js'

// Pipeline event types (AC8: exported for external consumers)
export type {
  PipelineEvent,
  PipelineStartEvent,
  PipelineCompleteEvent,
  StoryPhaseEvent,
  StoryDoneEvent,
  StoryEscalationEvent,
  StoryWarnEvent,
  StoryLogEvent,
  EscalationIssue,
  PipelinePhase,
} from './modules/implementation-orchestrator/event-types.js'
// Core errors
export * from './core/errors.js'
// Utilities
export { createLogger, childLogger, logger } from './utils/logger.js'
export * from './utils/helpers.js'

// Orchestrator
export { createOrchestrator } from './core/orchestrator-impl.js'
export type { Orchestrator, OrchestratorConfig } from './core/orchestrator.js'

// Event Bus
export type { TypedEventBus } from './core/event-bus.js'
export type { OrchestratorEvents } from './core/event-bus.types.js'
export { createEventBus } from './core/event-bus.js'

// Dependency Injection
export type { BaseService } from './core/di.js'
export { ServiceRegistry } from './core/di.js'

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

// TUI Dashboard
export * from './tui/index.js'
