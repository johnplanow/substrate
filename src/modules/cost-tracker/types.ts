/**
 * CostTracker types — all shared interfaces for the cost tracking module.
 *
 * Defines types for:
 *  - CostEntry: a single recorded cost event tied to a task
 *  - TaskCostSummary: aggregated cost for a single task
 *  - SessionCostSummary: aggregated cost and savings for a full session (FR26)
 */

// ---------------------------------------------------------------------------
// CostEntry
// ---------------------------------------------------------------------------

/**
 * A single cost record tied to one task execution.
 */
export interface CostEntry {
  /** Auto-assigned by the database (INTEGER PRIMARY KEY AUTOINCREMENT) */
  id: number
  session_id: string
  /** Nullable — matches the DB schema: task_id TEXT REFERENCES tasks(id) (nullable) */
  task_id: string | null
  agent: string
  provider: string
  model: string
  billing_mode: 'subscription' | 'api'
  tokens_input: number
  tokens_output: number
  cost_usd: number
  savings_usd: number
  created_at: string
}

// ---------------------------------------------------------------------------
// TaskCostSummary
// ---------------------------------------------------------------------------

/**
 * Aggregated cost data for a single task.
 */
export interface TaskCostSummary {
  task_id: string
  cost_usd: number
  tokens: {
    input: number
    output: number
    total: number
  }
  billing_mode: 'subscription' | 'api' | 'mixed'
  savings_usd: number
}

// ---------------------------------------------------------------------------
// AgentCostBreakdown
// ---------------------------------------------------------------------------

/**
 * Cost breakdown per agent within a session.
 */
export interface AgentCostBreakdown {
  agent: string
  task_count: number
  cost_usd: number
  savings_usd: number
  subscription_tasks: number
  api_tasks: number
}

// ---------------------------------------------------------------------------
// SessionCostSummary
// ---------------------------------------------------------------------------

/**
 * Aggregated cost summary for an entire orchestration session.
 *
 * Includes breakdown between subscription-covered (zero marginal cost) and
 * API-billed usage, plus savings from subscription routing (FR26, FR28).
 *
 * Also includes budget status fields (Story 4.3) for display in CLI/dashboard.
 */
export interface SessionCostSummary {
  session_id: string
  total_cost_usd: number
  subscription_cost_usd: number
  api_cost_usd: number
  savings_usd: number
  /** Human-readable savings summary (AC5). */
  savingsSummary: string
  per_agent_breakdown: AgentCostBreakdown[]
  task_count: number
  subscription_task_count: number
  api_task_count: number
  created_at: string
  /** Budget cap for the session in USD (undefined if no cap set) — Story 4.3 */
  budget_usd?: number
  /** Remaining budget after total costs — Story 4.3 */
  remaining_budget_usd?: number
  /** Percentage of budget used (0–100+) — Story 4.3 */
  percentage_used?: number
  /** Budget status category — Story 4.3 */
  budget_status?: 'ok' | 'warning' | 'exceeded' | 'unlimited'
}

