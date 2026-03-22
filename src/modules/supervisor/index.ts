/**
 * Supervisor module barrel export — shim re-exporting from @substrate-ai/core (Story 41-7).
 *
 * analyzeReviewCycles, ReviewCycleFinding, and ReviewCycleAnalysis are SDLC-specific
 * and NOT in @substrate-ai/core. They are re-exported from ./review-cycle-analysis.js.
 */

export type {
  PhaseDurations,
  TokenEfficiencyFinding,
  TimingFinding,
  TimingAnalysis,
  RecommendationType,
  AnalysisRecommendation,
  AnalysisSummary,
  AnalysisFindings,
  AnalysisReport,
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
  SpawnFn,
} from '@substrate-ai/core'

export {
  analyzeTokenEfficiency,
  analyzeTimings,
  generateRecommendations,
  generateAnalysisReport,
  writeAnalysisReport,
  buildBranchName,
  buildWorktreePath,
  buildModificationDirective,
  resolvePromptFile,
  determineVerdict,
  buildPRBody,
  buildAuditLogEntry,
  createExperimenter,
} from '@substrate-ai/core'

// SDLC-specific review cycle analysis — not in @substrate-ai/core
export type { ReviewCycleFinding, ReviewCycleAnalysis } from './review-cycle-analysis.js'
export { analyzeReviewCycles } from './review-cycle-analysis.js'
