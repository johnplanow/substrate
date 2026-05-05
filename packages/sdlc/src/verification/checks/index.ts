/**
 * Barrel export for VerificationCheck implementations.
 *
 * Check registration order (Tier A before Tier B, and within Tier A in
 * pipeline sequence order):
 *   1. PhantomReviewCheck  — story 51-2
 *   2. TrivialOutputCheck  — story 51-3
 *   3. AcceptanceCriteriaEvidenceCheck
 *   4. BuildCheck          — story 51-4
 *   5. RuntimeProbeCheck   — Epic 55 Phase 2
 */

export { PhantomReviewCheck } from './phantom-review-check.js'
export { TrivialOutputCheck, DEFAULT_TRIVIAL_OUTPUT_THRESHOLD } from './trivial-output-check.js'
export { AcceptanceCriteriaEvidenceCheck, extractAcceptanceCriteriaIds } from './acceptance-criteria-evidence-check.js'
export { BuildCheck, BUILD_CHECK_TIMEOUT_MS, detectBuildCommand } from './build-check.js'
export { RuntimeProbeCheck } from './runtime-probe-check.js'
export type { RuntimeProbeExecutors } from './runtime-probe-check.js'
export {
  SourceAcShelloutCheck,
  runShelloutCheck,
  scanFile,
  isCommentLine,
  isInStringLiteralContext,
} from './source-ac-shellout-check.js'
export {
  CrossStoryConsistencyCheck,
  runCrossStoryConsistencyCheck,
  computeCollisionPaths,
  diffContainsInterfaceOrConstChange,
} from './cross-story-consistency-check.js'
