/**
 * Supervisor Analysis Engine — shim re-exporting from @substrate-ai/core (Story 41-7).
 *
 * All analysis functions and types now live in packages/core/src/supervisor/analysis.ts.
 * analyzeReviewCycles, ReviewCycleFinding, and ReviewCycleAnalysis are SDLC-specific
 * and are re-exported from review-cycle-analysis.ts (not from @substrate-ai/core).
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
} from '@substrate-ai/core'

export {
  analyzeTokenEfficiency,
  analyzeTimings,
  generateRecommendations,
  generateAnalysisReport,
  writeAnalysisReport,
} from '@substrate-ai/core'

// SDLC-specific types and function — not in @substrate-ai/core
export type { ReviewCycleFinding, ReviewCycleAnalysis } from './review-cycle-analysis.js'
export { analyzeReviewCycles } from './review-cycle-analysis.js'
