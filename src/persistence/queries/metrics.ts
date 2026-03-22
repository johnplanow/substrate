// src/persistence/queries/metrics.ts — re-export shim (migrated to packages/core in story 41-3)
export {
  writeRunMetrics,
  getRunMetrics,
  listRunMetrics,
  tagRunAsBaseline,
  getBaselineRunMetrics,
  incrementRunRestarts,
  writeStoryMetrics,
  getStoryMetricsForRun,
  compareRunMetrics,
  getRunSummaryForSupervisor,
  aggregateTokenUsageForRun,
  aggregateTokenUsageForStory,
} from '@substrate-ai/core'
export type {
  RunMetricsInput,
  RunMetricsRow,
  StoryMetricsInput,
  StoryMetricsRow,
  TokenAggregate,
  RunMetricsDelta,
  RunSummaryForSupervisor,
} from '@substrate-ai/core'
