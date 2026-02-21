/**
 * quality-gates module — Quality Gate Framework
 *
 * Public API re-exports for the quality-gates module.
 */

// Types
export type {
  GateEvaluation,
  EvaluatorFn,
  GateConfig,
  GateResult,
  GateIssue,
  GatePipelineResult,
} from './types.js'

// Gate interface and implementation
export type { QualityGate } from './gate.js'
export { QualityGateImpl, createQualityGate } from './gate-impl.js'

// Pipeline
export type { GatePipeline } from './gate-pipeline.js'
export { GatePipelineImpl, createGatePipeline } from './gate-pipeline.js'

// Registry
export {
  registerGateType,
  createGate,
  getRegisteredGateTypes,
} from './gate-registry.js'
export type { CreateGateOptions } from './gate-registry.js'
