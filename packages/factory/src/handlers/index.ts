/**
 * Barrel export for the handlers module.
 * Story 42-9, 42-10.
 */

export { startHandler } from './start.js'
export { exitHandler } from './exit.js'
export { conditionalHandler } from './conditional.js'
export { HandlerRegistry, createDefaultRegistry } from './registry.js'
export type { DefaultRegistryOptions } from './registry.js'
export { createCodergenHandler } from './codergen-handler.js'
export type { CodergenHandlerOptions } from './codergen-handler.js'
export { createToolHandler } from './tool.js'
export type { ToolHandlerOptions } from './tool.js'
export { createWaitHumanHandler, parseAcceleratorKey, deriveChoices } from './wait-human.js'
export type { WaitHumanHandlerOptions, Choice } from './wait-human.js'
export type { NodeHandler, IHandlerRegistry } from './types.js'
// Re-export ICodergenBackend so callers can import from @substrate-ai/factory/handlers (story 42-18)
export type { ICodergenBackend } from '../backend/types.js'
// Story 50-2: fan-in exports
export { createFanInHandler, rankBranches, buildSelectionPrompt, parseLlmWinnerResponse } from './fan-in.js'
export type { FanInHandlerOptions, BranchResult } from './fan-in.js'
// Story 50-1: parallel handler exports
export { createParallelHandler } from './parallel.js'
export type { ParallelBranchResult, ParallelHandlerOptions, FanInBranchResult } from './types.js'
// Story 50-3: join-policy exports
export {
  evaluateJoinPolicy,
  BranchCancellationManager,
} from './join-policy.js'
export type {
  JoinPolicy,
  JoinPolicyConfig,
  JoinDecision,
} from './join-policy.js'
// Re-export BranchResult from join-policy under an alias to avoid collision with
// fan-in's BranchResult (which is also exported as BranchResult above).
// NOTE: Story 50-3 interface contracts specify this export as "BranchResult", but
// the name is taken by fan-in's BranchResult.  Downstream consumers (story 50-11
// and any other caller that needs the join-policy shape) MUST use the alias
// `JoinBranchResult` when importing from '@substrate-ai/factory'.
// e.g.:  import type { JoinBranchResult } from '@substrate-ai/factory'
export type { BranchResult as JoinBranchResult } from './join-policy.js'
// Story 50-5: subgraph handler exports
export { createSubgraphHandler } from './subgraph.js'
export type { SubgraphHandlerOptions } from './subgraph.js'
// Story 50-8: manager loop handler exports
export { createManagerLoopHandler } from './manager-loop.js'
export type { ManagerLoopHandlerOptions } from './manager-loop.js'
