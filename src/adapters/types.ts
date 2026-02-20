/**
 * Type definitions for the WorkerAdapter subsystem
 * All adapter types are defined here for consistency and reuse
 */

import type { AgentId, BillingMode, TaskId } from '../core/types.js'

// Re-export for convenience
export type { AgentId, BillingMode, TaskId }

/**
 * A spawn command descriptor that the orchestrator uses to invoke a CLI agent.
 * Contains all information needed to execute an agent process.
 */
export interface SpawnCommand {
  /** The binary to execute (e.g., "claude", "codex", "gemini") */
  binary: string
  /** Arguments to pass to the binary */
  args: string[]
  /** Optional environment variable overrides */
  env?: Record<string, string>
  /** Working directory for the process */
  cwd: string
  /** Optional data to pipe to stdin */
  stdin?: string
  /** Optional timeout in milliseconds */
  timeoutMs?: number
}

/**
 * Options passed to adapter methods for each invocation.
 * Controls execution context for a specific task run.
 */
export interface AdapterOptions {
  /** Path to the git worktree for this task */
  worktreePath: string
  /** Billing mode to use for this execution */
  billingMode: BillingMode
  /** Optional model identifier override */
  model?: string
  /** Optional additional CLI flags to append */
  additionalFlags?: string[]
  /** Optional API key override (used when billingMode is 'api') */
  apiKey?: string
}

/**
 * Capabilities reported by an adapter for this CLI agent.
 * Used for routing and planning decisions.
 */
export interface AdapterCapabilities {
  /** Whether the agent outputs structured JSON */
  supportsJsonOutput: boolean
  /** Whether the agent supports streaming output */
  supportsStreaming: boolean
  /** Whether the agent supports subscription-based billing */
  supportsSubscriptionBilling: boolean
  /** Whether the agent supports API-key-based billing */
  supportsApiBilling: boolean
  /** Whether the agent can generate task planning graphs */
  supportsPlanGeneration: boolean
  /** Maximum context tokens the agent supports */
  maxContextTokens: number
  /** Task types this agent can handle */
  supportedTaskTypes: string[]
  /** Programming languages the agent supports */
  supportedLanguages: string[]
}

/**
 * Result returned from an adapter health check.
 * Indicates whether the CLI binary is present and functional.
 */
export interface AdapterHealthResult {
  /** Whether the adapter is considered healthy and usable */
  healthy: boolean
  /** Detected version string of the CLI binary */
  version?: string
  /** Full path to the CLI binary, if resolved */
  cliPath?: string
  /** Error message when healthy is false */
  error?: string
  /** Detected billing mode(s) available for this adapter */
  detectedBillingModes?: BillingMode[]
  /** Whether the CLI supports headless/non-interactive mode */
  supportsHeadless: boolean
}

/**
 * Parsed result from a task execution.
 * Normalized representation from CLI agent JSON output.
 */
export interface TaskResult {
  /** Task identifier this result belongs to */
  taskId?: TaskId
  /** Whether the task completed successfully */
  success: boolean
  /** Primary output content from the agent */
  output: string
  /** Error message if the task failed */
  error?: string
  /** Raw exit code from the CLI process */
  exitCode: number
  /** Execution metadata */
  metadata?: {
    executionTime?: number
    tokensUsed?: TokenEstimate
  }
}

/**
 * Token usage estimate for budget tracking.
 */
export interface TokenEstimate {
  /** Estimated input tokens */
  input: number
  /** Estimated output tokens */
  output: number
  /** Total token estimate */
  total: number
}

/**
 * Request input for plan generation.
 */
export interface PlanRequest {
  /** High-level goal or description of work to plan */
  goal: string
  /** Additional context for the planning agent */
  context?: string
  /** Maximum number of tasks to generate */
  maxTasks?: number
}

/**
 * Parsed result from a plan generation invocation.
 */
export interface PlanParseResult {
  /** Whether plan generation succeeded */
  success: boolean
  /** Parsed list of planned task descriptions */
  tasks: PlannedTask[]
  /** Error message if plan generation failed */
  error?: string
  /** Raw output for debugging */
  rawOutput?: string
}

/**
 * A single task entry in a generated plan.
 */
export interface PlannedTask {
  /** Task title */
  title: string
  /** Detailed description */
  description: string
  /** Estimated complexity (1-10) */
  complexity?: number
  /** Other task titles this task depends on */
  dependencies?: string[]
}
