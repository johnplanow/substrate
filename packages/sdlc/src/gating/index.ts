/**
 * Gating module barrel — Story 53-9: Dispatch Pre-Condition Gating
 *
 * Public API for the dispatch pre-condition gating system.
 */

export { DispatchGate } from './dispatch-gate.js'
export { ConflictDetector } from './conflict-detector.js'
export type {
  ConflictType,
  GateDecision,
  GateResult,
  DispatchGateOptions,
  PipelineDispatchWarnPayload,
  PipelineStoryGatedPayload,
} from './types.js'
