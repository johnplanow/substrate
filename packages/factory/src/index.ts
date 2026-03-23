// @substrate-ai/factory — public API (populated in stories 40-3 through 40-8)
// events.ts exports are listed explicitly to avoid name conflicts with graph/types.ts.
// `Outcome` (story 42-8) and `StageStatus` are exported via graph/types.ts.
export type { ScenarioResult, ScenarioRunResult, FactoryEvents } from './events.js'
export * from './graph/types.js'
export { parseGraph } from './graph/parser.js'
export { createValidator, isStartNode, isExitNode } from './graph/validator.js'
export { selectEdge, normalizeLabel, bestByWeightThenLexical } from './graph/index.js'
// Backend module (story 42-18)
export * from './backend/index.js'
// Handler registry — exported for CLI composition root (story 43-6)
export { HandlerRegistry, createDefaultRegistry } from './handlers/index.js'
export type { IHandlerRegistry, NodeHandler } from './handlers/index.js'
// Graph executor — exported for CLI composition root (story 43-10)
export { createGraphExecutor } from './graph/executor.js'
export type { GraphExecutor, GraphExecutorConfig } from './graph/executor.js'
// Scenario store, runner, scorer, and CLI command (stories 44-1, 44-5)
// Includes: ScenarioStore, ScenarioRunner, computeSatisfactionScore, SatisfactionScore,
//           registerScenariosCommand (all via scenarios/index.js)
export * from './scenarios/index.js'
// Factory CLI command group (story 44-8)
export { registerFactoryCommand } from './factory-command.js'

// Factory config schema (story 44-9)
export { FactoryConfigSchema, FactoryExtendedConfigSchema, loadFactoryConfig } from './config.js'
export type { FactoryConfig, FactoryExtendedConfig } from './config.js'

// Convergence subsystem — ConvergenceController + per-node budget (stories 42-16, 45-3)
export * from './convergence/index.js'

// Factory persistence query functions (story 46-3)
export * from './persistence/factory-queries.js'

// Twin Registry + Docker Compose orchestration (stories 47-1, 47-2)
export * from './twins/index.js'
