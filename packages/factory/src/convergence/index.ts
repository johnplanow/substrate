/**
 * Convergence subsystem barrel exports.
 * Story 42-16.
 */
export type { ConvergenceController, GoalGateResult, CheckGoalGatesOptions } from './controller.js'
export { createConvergenceController } from './controller.js'

// Per-node budget enforcement — story 45-3
export type { BudgetCheckResult, BackoffOptions } from './budget.js'
export { checkNodeBudget, computeBackoffDelay } from './budget.js'

// Per-pipeline budget enforcement — story 45-4
export { checkPipelineBudget, PipelineBudgetManager } from './budget.js'

// Per-session budget enforcement — story 45-5
export { checkSessionBudget, SessionBudgetManager } from './budget.js'

// Plateau detection — story 45-6
export type { PlateauDetectorOptions, PlateauDetector, PlateauCheckContext, PlateauCheckResult } from './plateau.js'
export { createPlateauDetector, checkPlateauAndEmit } from './plateau.js'

// Remediation context injection — story 45-7
export { REMEDIATION_CONTEXT_KEY, buildRemediationContext, formatScenarioDiff, deriveFixScope, injectRemediationContext, getRemediationContext } from './remediation.js'
export type { RemediationContext, BuildRemediationContextParams } from './remediation.js'

// Dual-signal coordinator — story 46-5/46-6
export type { DualSignalVerdict, DualSignalAgreement, DualSignalResult, DualSignalCoordinator, DualSignalCoordinatorOptions, QualityMode } from './dual-signal.js'
export { evaluateDualSignal, createDualSignalCoordinator, CONTEXT_KEY_CODE_REVIEW_VERDICT } from './dual-signal.js'
