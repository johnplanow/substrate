// @substrate-ai/core — persistence public API
export * from './types.js'
export * from './schema-version.js'
export * from './adapter.js'
export * from './dolt-adapter.js'
export * from './memory-adapter.js'
export {
  initSchema,
  initCoreSchema,
  initCoreViews,
  initPipelineSchema,
  initMonitorSchema,
  initStateSchema,
  initRepoMapSchema,
  initTelemetrySchema,
  initWorkGraphSchema,
} from './schema.js'

// Ship 6 ownership-contract exports: each subsystem declares the tables (and
// views) it owns. The meta-test in test/persistence/schema-ownership.test.ts
// asserts (a) no overlap and (b) the union covers the canonical set.
// `state-schema` owns no tables anymore (Ship 8 dropped the six legacy tables);
// it survives only as a DROP-table cleanup for existing repos, so it has no
// ownership array to export.
export { coreSchemaTables, coreSchemaViews } from './core-schema.js'
export { pipelineSchemaTables } from './pipeline-schema.js'
export { monitorSchemaTables } from './monitor-schema.js'
export { repoMapSchemaTables } from './repo-map-schema.js'
export { telemetrySchemaTables } from './telemetry-schema.js'
export { workGraphSchemaTables, workGraphSchemaViews } from './work-graph-schema.js'
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
  appendFinding,
} from './queries/decisions.js'
export type { TokenUsageSummary, AppendFindingInput } from './queries/decisions.js'
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
