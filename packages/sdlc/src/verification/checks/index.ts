/**
 * Barrel export for VerificationCheck implementations.
 *
 * Check registration order (Tier A before Tier B, and within Tier A in
 * pipeline sequence order per architecture section 3.5):
 *   1. PhantomReviewCheck  — story 51-2
 *   2. TrivialOutputCheck  — story 51-3
 *   3. BuildCheck          — story 51-4
 */

export { PhantomReviewCheck } from './phantom-review-check.js'
export { TrivialOutputCheck, DEFAULT_TRIVIAL_OUTPUT_THRESHOLD } from './trivial-output-check.js'
export { BuildCheck, BUILD_CHECK_TIMEOUT_MS, detectBuildCommand } from './build-check.js'
