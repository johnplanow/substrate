/**
 * Verification framework barrel export — Stories 51-1 through 51-3.
 *
 * Exports the VerificationPipeline class, all supporting types,
 * and concrete check implementations.
 */

export { VerificationPipeline, createDefaultVerificationPipeline } from './verification-pipeline.js'
export type {
  VerificationCheck,
  VerificationContext,
  VerificationResult,
  VerificationCheckResult,
  VerificationSummary,
  ReviewSignals,
  DevStorySignals,
} from './types.js'
// Concrete check implementations (story 51-2+)
export { PhantomReviewCheck } from './checks/index.js'
export { TrivialOutputCheck, DEFAULT_TRIVIAL_OUTPUT_THRESHOLD } from './checks/index.js'
export { AcceptanceCriteriaEvidenceCheck, extractAcceptanceCriteriaIds } from './checks/index.js'
export { BuildCheck, BUILD_CHECK_TIMEOUT_MS, detectBuildCommand } from './checks/index.js'
