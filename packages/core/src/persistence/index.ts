// @substrate-ai/core — persistence public API
export * from './types.js'
export * from './schema-version.js'
export * from './adapter.js'
export * from './dolt-adapter.js'
export * from './memory-adapter.js'
export { initSchema } from './schema.js'
// Canonical cost types — single source of truth (avoids dual-definition with src/modules/cost-tracker/types.ts)
export * from './cost-types.js'
export * from './schemas/decisions.js'
export * from './schemas/operational.js'
export * from './queries/amendments.js'
// Export decisions query functions explicitly; Decision/Requirement/etc. types come from schemas/decisions.js above
export {
  createDecision,
  upsertDecision,
  getDecisionsByPhase,
  getDecisionsByPhaseForRun,
  getDecisionsByCategory,
  getDecisionByKey,
  updateDecision,
  createRequirement,
  listRequirements,
  updateRequirementStatus,
  createConstraint,
  listConstraints,
  registerArtifact,
  getArtifactsByPhase,
  getArtifactByType,
  getArtifactByTypeForRun,
  getArtifactsByRun,
  getPipelineRunById,
  updatePipelineRunConfig,
  createPipelineRun,
  updatePipelineRun,
  getRunningPipelineRuns,
  getLatestRun,
  addTokenUsage,
  getTokenUsageSummary,
} from './queries/decisions.js'
export type { TokenUsageSummary } from './queries/decisions.js'
export * from './queries/cost.js'
export * from './queries/metrics.js'
export * from './queries/retry-escalated.js'
export * from './monitor-database.js'
export { DoltClient, createDoltClient } from './dolt-client.js'
export type { DoltClientOptions } from './dolt-client.js'
export { initializeDolt, checkDoltInstalled, runDoltCommand } from './dolt-init.js'
export type { DoltInitConfig } from './dolt-init.js'
export { DoltNotInstalled, DoltInitError } from './dolt-init.js'
export { DoltQueryError } from './dolt-errors.js'
