/**
 * Experimenter — shim re-exporting from @substrate-ai/core (Story 41-7).
 *
 * All experimenter types and functions now live in packages/core/src/supervisor/experimenter.ts.
 */

export type {
  SpawnFn,
  SupervisorRecommendation,
  ExperimentPhase,
  ExperimentVerdict,
  ExperimentMetricDeltas,
  ExperimentResult,
  ExperimentConfig,
  ExperimentRunOptions,
  RunStoryFn,
  ExperimenterDeps,
  Experimenter,
} from '@substrate-ai/core'

export {
  buildBranchName,
  buildWorktreePath,
  buildModificationDirective,
  resolvePromptFile,
  determineVerdict,
  buildPRBody,
  buildAuditLogEntry,
  createExperimenter,
} from '@substrate-ai/core'
