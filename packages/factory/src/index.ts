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
