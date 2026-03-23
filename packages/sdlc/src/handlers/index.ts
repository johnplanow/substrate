/**
 * Barrel export for the SDLC handlers module.
 * Stories 43-2, 43-3, 43-4, 43-9.
 */

export { createSdlcCreateStoryHandler } from './sdlc-create-story-handler.js'
export type {
  SdlcCreateStoryHandlerOptions,
  CreateStoryParams,
  CreateStoryResult,
  RunCreateStoryFn,
} from './sdlc-create-story-handler.js'

// Story 43-2: SDLC phase handler
export { createSdlcPhaseHandler } from './sdlc-phase-handler.js'
export type {
  SdlcPhaseHandlerDeps,
  SdlcNodeHandler,
  SdlcOutcome,
  PhaseOrchestrator,
  PhaseRunnerFn,
  PhaseRunners,
  // Story 43-13: entry gate types
  EntryGateResult,
  GateFailure,
} from './types.js'

// Story 43-4: SDLC dev-story handler
export { createSdlcDevStoryHandler } from './sdlc-dev-story-handler.js'
export type {
  SdlcDevStoryHandlerOptions,
  DevStoryParams,
  DevStoryResult,
  RunDevStoryFn,
} from './sdlc-dev-story-handler.js'

// Story 43-5: SDLC code-review handler
export { createSdlcCodeReviewHandler } from './sdlc-code-review-handler.js'
export type {
  SdlcCodeReviewHandlerOptions,
  CodeReviewParams,
  CodeReviewResult,
  CodeReviewIssue,
  RunCodeReviewFn,
} from './sdlc-code-review-handler.js'

// Story 43-9: SDLC event bridge
export { createSdlcEventBridge } from './event-bridge.js'
export type {
  SdlcEventBridgeOptions,
  GraphEventEmitter,
  SdlcEventBus,
} from './event-bridge.js'
