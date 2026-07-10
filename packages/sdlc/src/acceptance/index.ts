/**
 * Acceptance Gate module (epics A0–A7).
 *
 * Sits beside `verification/` — verification checks the changes an agent
 * MADE; acceptance checks the journeys that were SUPPOSED TO EXIST.
 * Design: _planning/2026-07-07-acceptance-gate-design-brief.md (rev 2).
 */
export * from './types.js'
export { JOURNEY_REGISTRY_PATH, JourneyRegistrySchema, RegistryProvenanceSchema, parseJourneyRegistry } from './registry.js'
// RP1.1: derive candidate (non-authoritative; the gate never reads it)
export { JOURNEY_CANDIDATE_PATH, JourneyCandidateSchema, parseJourneyCandidate } from './candidate.js'
export type { JourneyCandidate, CandidateJourney, CandidateParseResult } from './candidate.js'
export { loadJourneyRegistryFromTrustedTree, loadJourneyRegistryFromFile, loadJourneyDeferralsFromTrustedTree, loadAcceptanceContractFromTrustedTree } from './loader.js'
export type { DeferralsLoadResult } from './loader.js'
// A1.1: per-project acceptance contract (injection-safe render argv)
export {
  ACCEPTANCE_CONTRACT_PROFILE_PATH,
  AcceptanceContractSchema,
  parseAcceptanceContract,
  buildRenderArgv,
} from './contract.js'
export type { AcceptanceContract, RenderableSurface, ContractParseResult, RenderPlaceholderValues, RenderArgvResult } from './contract.js'
// A1.2: render executor + determinism probe
export { renderSurface, renderSurfaceDeterministic } from './render.js'
export type { RenderResult, RenderSurfaceOptions, DeterminismResult } from './render.js'
// A2.2: minutes-scale verdict artifact (self-contained HTML, escaped)
export { renderVerdictHtml } from './verdict-artifact.js'
export type { VerdictArtifactInput, VerdictArtifactJourney, VerdictArtifactEndState } from './verdict-artifact.js'
// A6: operator-local auto-demotion overlay + canary engine
export { GATE_STATE_PATH, GateStateSchema, readGateState, isGateDemoted, demoteGate, clearGateDemotion, effectiveAcceptanceMode } from './gate-state.js'
export type { GateState } from './gate-state.js'
export { runCanary } from './canary.js'
export type { CanaryResult, CanaryVerdict, CanaryJudge, RunCanaryOptions } from './canary.js'
// A6.2: precision + canary-recall instrumentation (operator-local tallies)
export {
  ACCEPTANCE_METRICS_PATH,
  AcceptanceMetricsSchema,
  readAcceptanceMetrics,
  computePrecision,
  computeRecall,
  recordCriticalFail,
  recordCanary,
  recordOverride,
} from './precision.js'
export type { AcceptanceMetrics, OverrideResult } from './precision.js'
// A0.3: coverage ledger (the spine) + operator deferrals
export {
  computeJourneyCoverage,
  summarizeCoverage,
  parseJourneyDeferrals,
  JOURNEY_DEFERRALS_PATH,
  JourneyDeferralSchema,
  JourneyDeferralsFileSchema,
} from './coverage.js'
export type {
  JourneyCoverageState,
  JourneyCoverageEntry,
  JourneyClaim,
  JourneyVerdictInput,
  CoverageScope,
  JourneyDeferral,
  DeferralsParseResult,
} from './coverage.js'
