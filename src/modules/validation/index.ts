/**
 * Public API for the validation module.
 */

// Types
export type {
  CascadeRunnerConfig,
  FailureDetail,
  LevelFailure,
  LevelResult,
  RemediationContext,
  StoryRecord,
  ValidationContext,
  ValidationLevel,
  ValidationResult,
} from './types.js'

// Harness
export type { ValidationHarness } from './harness.js'
export { CascadeRunner } from './harness.js'

// Validation Levels
export { StructuralValidator } from './levels/structural.js'
export { BuildValidationLevel } from './levels/build.js'
export type { BuildValidatorConfig, TscDiagnostic } from './levels/build.js'
