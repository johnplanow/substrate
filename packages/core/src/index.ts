// @substrate-ai/core public API — exports added per story (40-3+)

// Core primitive types (TaskId, WorkerId, AgentId, TaskStatus, etc.)
// TaskId and WorkerId are defined here; the events subsystem also defines them
// but we use this module as the canonical source to avoid TS2308 ambiguity.
export * from './types.js'

// Events: TypedEventBus, CoreEvents, EventMap, EventHandler, createEventBus
// NOTE: TaskId and WorkerId are intentionally omitted here (already exported from ./types.js).
export type { EventMap, EventHandler } from './events/index.js'
export type { TypedEventBus } from './events/index.js'
export { TypedEventBusImpl, createEventBus } from './events/index.js'
export type { CoreEvents, EventTaskResult, EventTaskError } from './events/index.js'

// Dispatch: Dispatcher, DispatchRequest, DispatchHandle, DispatchResult, DispatchConfig
export * from './dispatch/index.js'

// Persistence: DatabaseAdapter, DatabaseAdapterConfig, SyncAdapter, isSyncAdapter, InitSchemaFn
export * from './persistence/index.js'

// Routing: RoutingDecision, RoutingPolicy, IRoutingResolver, ModelResolution
export * from './routing/index.js'

// Config: SubstrateConfig and related types
export * from './config/index.js'

// Telemetry: all types, schemas, and implementations
// Explicit re-exports before the wildcard to claim names that conflict with later modules:
//   - ITelemetryPersistence: telemetry's 6-method version takes precedence over routing's alias
//   - estimateCost: telemetry's (model, tokens) version takes precedence over cost-tracker's (provider, model, ...)
//   - Recommendation: telemetry's Zod-inferred type takes precedence over monitor's interface
export type { ITelemetryPersistence } from './telemetry/index.js'
export { estimateCost } from './telemetry/index.js'
export type { Recommendation } from './telemetry/index.js'
export * from './telemetry/index.js'

// Adapter subsystem (WorkerAdapter, AdapterRegistry, SpawnCommand, AdapterOptions, etc.)
export * from './adapters/index.js'

// Context compiler subsystem (ContextCompiler, TaskDescriptor, CompileResult, *Schema, etc.)
export * from './context/index.js'

// Quality gates subsystem (QualityGate, GatePipeline, GateResult, etc.)
export * from './quality-gates/index.js'

// Git utilities, worktree management, and git manager
export * from './git/index.js'

// Version manager (VersionManager, VersionManagerImpl, UpdateChecker, VersionCache, etc.)
export * from './version-manager/index.js'

// Supervisor: analysis engine, experimenter framework
export * from './supervisor/index.js'

// Budget: BudgetTracker interface and stub implementation
export * from './budget/index.js'

// CostTracker: token rates, cost tracking, and subscriber
// estimateCost: telemetry's (model, tokens) version is the canonical @substrate-ai/core export (exported above).
// estimateCostForProvider: cost-tracker variant (provider, model, inputTokens, outputTokens, rateTable?)
// CostEntry/TaskCostSummary/SessionCostSummary/AgentCostBreakdown re-exported here from
// cost-tracker/types.js which points to the same declarations as persistence/cost-types.js,
// so TypeScript treats them as non-ambiguous identical declarations.
// estimateCost is intentionally excluded from the root re-export to prevent a runtime
// collision with telemetry's estimateCost; the cost-tracker variant is accessible as
// estimateCostForProvider from the root barrel, and as estimateCost from cost-tracker/index.ts.
export { estimateCost as estimateCostForProvider } from './cost-tracker/token-rates.js'
export type { CostTracker, CostTrackerOptions } from './cost-tracker/index.js'
export { CostTrackerImpl, createCostTracker } from './cost-tracker/index.js'
export { CostTrackerSubscriber, createCostTrackerSubscriber } from './cost-tracker/index.js'
export type { CostTrackerSubscriberOptions } from './cost-tracker/index.js'
export type {
  CostEntry,
  TaskCostSummary,
  SessionCostSummary,
  AgentCostBreakdown,
} from './cost-tracker/index.js'
export type { TokenRates, ModelRates } from './cost-tracker/index.js'
export { TOKEN_RATES, PROVIDER_ALIASES, getTokenRate, estimateCostSafe } from './cost-tracker/index.js'

// Monitor: MonitorAgent, RecommendationEngine, ReportGenerator, TaskTypeClassifier
// Recommendation conflict resolved above (telemetry version is canonical at root API).
// MonitorRecommendation: monitor module's Recommendation interface (distinct from telemetry's Zod type)
export type { Recommendation as MonitorRecommendation } from './monitor/recommendation-types.js'
export * from './monitor/index.js'
