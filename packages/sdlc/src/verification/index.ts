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
  VerificationFinding,
  VerificationFindingSeverity,
} from './types.js'
export { renderFindings } from './findings.js'

// Epic 55 Phase 2 — Runtime probe support.
export { RuntimeProbeCheck } from './checks/runtime-probe-check.js'
export type { RuntimeProbeExecutors } from './checks/runtime-probe-check.js'
// Story 60-13: exported for probe-author-integration gate
export { detectsEventDrivenAC } from './checks/runtime-probe-check.js'
// Story 65-1: exported for probe-author-integration gate (state-integrating ACs)
export { detectsStateIntegratingAC } from './checks/runtime-probe-check.js'
export {
  DEFAULT_PROBE_TIMEOUT_MS,
  PROBE_TAIL_BYTES,
  RuntimeProbeListSchema,
  RuntimeProbeSandboxSchema,
  RuntimeProbeSchema,
  parseRuntimeProbes,
  executeProbeOnHost,
} from './probes/index.js'
export type {
  HostExecuteOptions,
  ProbeResult,
  RuntimeProbe,
  RuntimeProbeParseResult,
  RuntimeProbeSandbox,
} from './probes/index.js'
// Concrete check implementations (story 51-2+)
export { PhantomReviewCheck } from './checks/index.js'
export { TrivialOutputCheck, DEFAULT_TRIVIAL_OUTPUT_THRESHOLD } from './checks/index.js'
export { AcceptanceCriteriaEvidenceCheck, extractAcceptanceCriteriaIds } from './checks/index.js'
export { BuildCheck, BUILD_CHECK_TIMEOUT_MS, detectBuildCommand } from './checks/index.js'
// Story 58-2: source AC fidelity check
export { SourceAcFidelityCheck } from './source-ac-fidelity-check.js'
// Story 67-3: bare npx fallback static-analysis gate
export { SourceAcShelloutCheck, runShelloutCheck } from './checks/index.js'
export { CATEGORY_SHELLOUT_NPX_FALLBACK } from './findings.js'
// Story 68-1: cross-story consistency check + finding category
export {
  CrossStoryConsistencyCheck,
  runCrossStoryConsistencyCheck,
} from './checks/index.js'
export { CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION } from './findings.js'
// Story 70-1: cross-story race recovery
export {
  detectStaleVerifications,
  CommittedAtResolver,
  runStaleVerificationRecovery,
} from './cross-story-race-recovery.js'
export type {
  BatchEntry,
  StaleVerificationRecoveryInput,
  StaleVerificationRecoveryResult,
} from './cross-story-race-recovery.js'
