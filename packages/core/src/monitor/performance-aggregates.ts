/**
 * Performance Aggregates — type definitions for performance aggregate queries.
 * Migrated to @substrate-ai/core (Story 41-7)
 */

// ---------------------------------------------------------------------------
// PerformanceAggregates — raw database row shape
// ---------------------------------------------------------------------------

export interface PerformanceAggregates {
  agent: string
  task_type: string
  total_tasks: number
  successful_tasks: number
  failed_tasks: number
  total_input_tokens: number
  total_output_tokens: number
  total_duration_ms: number
  total_cost: number
  total_retries: number
  last_updated: string
}

// ---------------------------------------------------------------------------
// AgentPerformanceMetrics — computed metrics for a single agent
// ---------------------------------------------------------------------------

export type AgentPerformanceMetrics = {
  total_tasks: number
  successful_tasks: number
  failed_tasks: number
  success_rate: number
  failure_rate: number
  average_tokens: number
  average_duration: number
  token_efficiency: number
  retry_rate: number
  last_updated: string
}

// ---------------------------------------------------------------------------
// TaskTypeBreakdownResult — per-agent comparison for a single task type
// ---------------------------------------------------------------------------

export type TaskTypeBreakdownResult = {
  task_type: string
  agents: Array<{
    agent: string
    total_tasks: number
    success_rate: number
    average_tokens: number
    average_duration: number
    sample_size: number
  }>
}
