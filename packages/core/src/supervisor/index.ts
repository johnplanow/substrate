/**
 * Supervisor module barrel export — @substrate-ai/core (Story 41-7)
 *
 * Note: analyzeReviewCycles is SDLC-specific and lives in the monolith at
 * src/modules/supervisor/review-cycle-analysis.ts.
 * ReviewCycleFinding and ReviewCycleAnalysis are used internally in analysis.ts
 * but are NOT part of this barrel's public API; define them locally in monolith code.
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
} from './analysis.js'

export {
  analyzeTokenEfficiency,
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
  buildWorktreePath,
  buildModificationDirective,
  resolvePromptFile,
  determineVerdict,
  buildPRBody,
  buildAuditLogEntry,
  createExperimenter,
} from './experimenter.js'
