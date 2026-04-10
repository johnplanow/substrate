/**
 * Monitor module barrel export — shim re-exporting from @substrate-ai/core (Story 41-7).
 *
 * Note: `Recommendation` exported here is the monitor's interface.
 * It is accessible from @substrate-ai/core as `MonitorRecommendation` (alias resolving the conflict
 * with telemetry's Recommendation type).
 */
export type { MonitorAgent, TaskMetrics } from '@substrate-ai/core'
export { MonitorAgentImpl, createMonitorAgent } from '@substrate-ai/core'
export type { MonitorConfig, MonitorAgentOptions } from '@substrate-ai/core'
export { TaskTypeClassifier, createTaskTypeClassifier, DEFAULT_TAXONOMY } from '@substrate-ai/core'
export type { MonitorReport, ReportGeneratorOptions } from '@substrate-ai/core'
export { generateMonitorReport } from '@substrate-ai/core'
export type {
  ConfidenceLevel,
  MonitorRecommendation as Recommendation,
  RecommendationFilters,
  RecommendationExport,
} from '@substrate-ai/core'
export { createRecommendation } from '@substrate-ai/core'
export { RecommendationEngine, createRecommendationEngine } from '@substrate-ai/core'
export type { MonitorRecommendationConfig } from '@substrate-ai/core'
export type {
  AgentPerformanceMetrics,
  TaskTypeBreakdownResult,
  PerformanceAggregates,
} from '@substrate-ai/core'
