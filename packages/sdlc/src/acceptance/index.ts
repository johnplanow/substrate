/**
 * Acceptance Gate module (epics A0–A7).
 *
 * Sits beside `verification/` — verification checks the changes an agent
 * MADE; acceptance checks the journeys that were SUPPOSED TO EXIST.
 * Design: _planning/2026-07-07-acceptance-gate-design-brief.md (rev 2).
 */
export * from './types.js'
export { JOURNEY_REGISTRY_PATH, JourneyRegistrySchema, parseJourneyRegistry } from './registry.js'
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
