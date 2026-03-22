/**
 * Monitor module barrel export — @substrate-ai/core (Story 41-7)
 */

export type { MonitorAgent, TaskMetrics } from './monitor-agent.js'
export { MonitorAgentImpl, createMonitorAgent } from './monitor-agent-impl.js'
export type { MonitorConfig, MonitorAgentOptions } from './monitor-agent-impl.js'
export { TaskTypeClassifier, createTaskTypeClassifier, DEFAULT_TAXONOMY } from './task-type-classifier.js'
export type { MonitorReport, ReportGeneratorOptions } from './report-generator.js'
export { generateMonitorReport } from './report-generator.js'
export type { Recommendation, ConfidenceLevel, RecommendationFilters, RecommendationExport } from './recommendation-types.js'
export { createRecommendation } from './recommendation-types.js'
export { RecommendationEngine, createRecommendationEngine } from './recommendation-engine.js'
export type { MonitorRecommendationConfig } from './recommendation-engine.js'
export type { AgentPerformanceMetrics, TaskTypeBreakdownResult, PerformanceAggregates } from './performance-aggregates.js'
