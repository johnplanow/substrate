/**
 * Supervisor module barrel export (Stories 17-3 and 17-4).
 *
 * Re-exports the supervisor analysis engine types/functions and the
 * experimentation framework types/functions.
 */

export type {
  PhaseDurations,
  TokenEfficiencyFinding,
  ReviewCycleFinding,
  ReviewCycleAnalysis,
  TimingFinding,
  TimingAnalysis,
  RecommendationType,
  AnalysisRecommendation,
  AnalysisSummary,
  AnalysisFindings,
  AnalysisReport,
} from './analysis.js'

export {
  analyzeTokenEfficiency,
  analyzeReviewCycles,
  analyzeTimings,
  generateRecommendations,
  generateAnalysisReport,
  writeAnalysisReport,
} from './analysis.js'

export type {
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
} from './experimenter.js'

export {
  buildBranchName,
  buildModificationDirective,
  resolvePromptFile,
  determineVerdict,
  buildPRBody,
  buildAuditLogEntry,
  createExperimenter,
} from './experimenter.js'
