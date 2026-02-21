/**
 * debate-panel module — Debate Panel Engine
 *
 * Public API re-exports for the debate-panel module.
 */

// Types
export type {
  DecisionTier,
  DecisionRequest,
  Perspective,
  VotingRecord,
  DebateResult,
} from './types.js'

// Interface
export type { DebatePanel } from './debate-panel.js'

// Implementation and factory
export {
  DebatePanelImpl,
  createDebatePanel,
} from './debate-panel-impl.js'
export type { DebatePanelOptions, PerspectiveGeneratorFn } from './debate-panel-impl.js'
