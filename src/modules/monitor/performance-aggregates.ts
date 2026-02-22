/**
 * Performance Aggregates — type definitions for performance aggregate queries.
 *
 * These types represent the results of querying the performance_aggregates
 * and task_metrics tables for agent-level and task-type-level analytics.
 *
 * Architecture: Pre-computed summaries updated on each metric insertion (AC6).
 * No LLM calls — all computation is pure SQL arithmetic (Architecture principle #1).
 */

// ---------------------------------------------------------------------------
// PerformanceAggregates — raw database row shape
// ---------------------------------------------------------------------------

/**
 * Raw row from performance_aggregates table.
 * Contains cumulative sums for a single (agent, task_type) pair.
 */
export interface PerformanceAggregates {
  /** Agent identifier (part of primary key) */
  agent: string

  /** Task type label (part of primary key) */
  task_type: string

  /** Total number of tasks executed by this agent for this type */
  total_tasks: number

  /** Count of successful task completions */
  successful_tasks: number

  /** Count of failed task executions */
  failed_tasks: number

  /** Sum of input tokens consumed across all tasks */
  total_input_tokens: number

  /** Sum of output tokens generated across all tasks */
  total_output_tokens: number

  /** Sum of total duration in milliseconds across all tasks */
  total_duration_ms: number

  /** Sum of actual cost across all tasks */
  total_cost: number

  /** Sum of retry attempts (if available in task_metrics) */
  total_retries: number

  /** ISO timestamp of when this row was last modified */
  last_updated: string
}

// ---------------------------------------------------------------------------
// AgentPerformanceMetrics — computed metrics for a single agent
// ---------------------------------------------------------------------------

/**
 * Computed performance metrics for a single agent across all task types.
 * Returned by MonitorDatabase.getAgentPerformance().
 */
export type AgentPerformanceMetrics = {
  /** Total tasks executed by this agent */
  total_tasks: number

  /** Number of successful task completions */
  successful_tasks: number

  /** Number of failed task executions */
  failed_tasks: number

  /** Percentage of tasks that succeeded: (successful_tasks / total_tasks) * 100 */
  success_rate: number

  /** Percentage of tasks that failed: (failed_tasks / total_tasks) * 100 */
  failure_rate: number

  /** Average tokens per task: (total_input_tokens + total_output_tokens) / total_tasks */
  average_tokens: number

  /** Average duration per task in ms: total_duration_ms / total_tasks */
  average_duration: number

  /** Output-to-input token ratio: total_output_tokens / total_input_tokens */
  token_efficiency: number

  /** Percentage of tasks that required retries: (total_retries / total_tasks) * 100 */
  retry_rate: number

  /** ISO timestamp of the most recent metric update */
  last_updated: string
}

// ---------------------------------------------------------------------------
// TaskTypeBreakdownResult — per-agent comparison for a single task type
// ---------------------------------------------------------------------------

/**
 * Per-agent comparison for a single task type.
 * Returned by MonitorDatabase.getTaskTypeBreakdown().
 */
export type TaskTypeBreakdownResult = {
  /** The task type that was queried */
  task_type: string

  /** Array of agent performance entries, sorted by success_rate descending */
  agents: Array<{
    /** Agent identifier */
    agent: string

    /** Total tasks executed by this agent for this task type */
    total_tasks: number

    /** Success percentage for this agent and type */
    success_rate: number

    /** Average token usage (input + output) for this agent and type */
    average_tokens: number

    /** Average duration in ms for this agent and type */
    average_duration: number

    /** Same as total_tasks — for confidence assessment */
    sample_size: number
  }>
}
