/**
 * plan-generator module — public API re-exports
 */

export {
  PlanGenerator,
  PlanError,
} from './plan-generator.js'

export type {
  PlanGeneratorOptions,
  PlanGenerateRequest,
  PlanGenerateResult,
} from './plan-generator.js'

export {
  scanCodebase,
  ScanError,
} from './codebase-scanner.js'

export type {
  CodebaseContext,
  TechStackItem,
  KeyFile,
  DependencySummary,
  ScanOptions,
} from './codebase-scanner.js'

export {
  buildPlanningPrompt,
  buildRefinementPrompt,
} from './planning-prompt.js'

export type {
  AgentSummary,
  PlanningPromptOptions,
  RefinementPromptOptions,
} from './planning-prompt.js'

export {
  PlanRefiner,
  computePlanDiff,
  countTasksInYaml,
} from './plan-refiner.js'

export type {
  PlanRefinerOptions,
  RefineResult,
  FieldChange,
  PlanDiffResult,
} from './plan-refiner.js'

export {
  validatePlan,
  normalizeAgentName,
  AGENT_NAME_ALIASES,
} from './plan-validator.js'

export type {
  PlanValidationResult,
  PlanValidationError,
  PlanValidationWarning,
} from './plan-validator.js'
