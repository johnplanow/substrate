/**
 * WorkerAdapter interface definition
 *
 * This is the core pluggable interface that all CLI agent adapters must implement.
 * Adding a new adapter requires only creating a class that satisfies this interface
 * — no modifications to the orchestrator core are needed (NFR11, FR14).
 *
 * @example
 * ```typescript
 * class MyCustomAdapter implements WorkerAdapter {
 *   readonly id: AgentId = 'my-custom-agent'
 *   readonly displayName = 'My Custom Agent'
 *   readonly adapterVersion = '1.0.0'
 *   // ... implement all 7 methods
 * }
 * ```
 */

import type { AgentId } from '../core/types.js'
import type {
  SpawnCommand,
  AdapterOptions,
  AdapterCapabilities,
  AdapterHealthResult,
  TaskResult,
  TokenEstimate,
  PlanRequest,
  PlanParseResult,
} from './types.js'

export type {
  SpawnCommand,
  AdapterOptions,
  AdapterCapabilities,
  AdapterHealthResult,
  TaskResult,
  TokenEstimate,
  PlanRequest,
  PlanParseResult,
}

/**
 * WorkerAdapter — the interface every CLI agent adapter must implement.
 *
 * Adapters are responsible for:
 * 1. Verifying their CLI binary is installed and responsive (healthCheck)
 * 2. Constructing the spawn command to execute a task (buildCommand)
 * 3. Constructing the spawn command for plan generation (buildPlanningCommand)
 * 4. Parsing task result output from the CLI (parseOutput)
 * 5. Parsing plan result output from the CLI (parsePlanOutput)
 * 6. Estimating token usage for budget tracking (estimateTokens)
 * 7. Reporting their capabilities for routing decisions (getCapabilities)
 */
export interface WorkerAdapter {
  // ----- Readonly identity properties -----

  /**
   * Unique identifier for this adapter type.
   * Used as the Map key in AdapterRegistry.
   * @example "claude-code"
   */
  readonly id: AgentId

  /**
   * Human-readable display name for the adapter.
   * @example "Claude Code"
   */
  readonly displayName: string

  /**
   * Semantic version of this adapter implementation.
   * @example "1.0.0"
   */
  readonly adapterVersion: string

  // ----- Required methods -----

  /**
   * Verify that the underlying CLI binary is installed, accessible, and
   * able to respond in headless/non-interactive mode.
   *
   * This method must NOT throw — failures should be captured in the returned
   * AdapterHealthResult.
   *
   * @returns A promise resolving to health check details
   *
   * @example
   * ```typescript
   * const result = await adapter.healthCheck()
   * if (!result.healthy) console.error(result.error)
   * ```
   */
  healthCheck(): Promise<AdapterHealthResult>

  /**
   * Generate the spawn command to execute a coding task.
   *
   * The returned SpawnCommand must set `cwd` to options.worktreePath so the
   * CLI agent operates in the correct git worktree (NFR10).
   *
   * @param prompt   Prompt or description of the task to execute
   * @param options  Per-invocation execution options
   * @returns SpawnCommand ready to be executed by the orchestrator
   *
   * @example
   * ```typescript
   * const cmd = adapter.buildCommand('Fix the failing tests', { worktreePath: '/tmp/wt', billingMode: 'api' })
   * // spawn(cmd.binary, cmd.args, { cwd: cmd.cwd, env: { ...process.env, ...cmd.env } })
   * ```
   */
  buildCommand(prompt: string, options: AdapterOptions): SpawnCommand

  /**
   * Generate the spawn command to invoke the CLI agent for plan generation.
   *
   * @param request  Plan request with goal and context
   * @param options  Per-invocation execution options
   * @returns SpawnCommand for the planning invocation
   */
  buildPlanningCommand(request: PlanRequest, options: AdapterOptions): SpawnCommand

  /**
   * Parse the raw CLI process output into a normalized TaskResult.
   *
   * This method must handle all output variations including:
   * - Valid JSON stdout
   * - Non-JSON stdout (fallback)
   * - Non-zero exit codes
   * - Combined stdout + stderr
   *
   * @param stdout    Standard output captured from the CLI process
   * @param stderr    Standard error captured from the CLI process
   * @param exitCode  Exit code from the CLI process
   * @returns Normalized TaskResult
   */
  parseOutput(stdout: string, stderr: string, exitCode: number): TaskResult

  /**
   * Parse the raw CLI output from a planning invocation into a PlanParseResult.
   *
   * @param stdout    Standard output from the planning invocation
   * @param stderr    Standard error from the planning invocation
   * @param exitCode  Exit code from the planning invocation
   * @returns Parsed plan result
   */
  parsePlanOutput(
    stdout: string,
    stderr: string,
    exitCode: number
  ): PlanParseResult

  /**
   * Estimate the token count for a given prompt string.
   *
   * Used for pre-execution budget checks. Implementations may use heuristics
   * (e.g., character count / 3) when exact tokenizers are unavailable.
   *
   * @param prompt  The prompt text to estimate
   * @returns TokenEstimate with input, output, and total projections
   *
   * @example
   * ```typescript
   * const estimate = adapter.estimateTokens('Fix the failing tests in auth.ts')
   * if (estimate.total > budgetCap) throw new BudgetExceededError(...)
   * ```
   */
  estimateTokens(prompt: string): TokenEstimate

  /**
   * Return the capabilities of this adapter's underlying CLI agent.
   *
   * The returned object is used by the orchestrator for:
   * - Routing decisions (which adapter handles which task type)
   * - Plan generation eligibility
   * - Budget mode selection
   *
   * @returns AdapterCapabilities for this agent
   */
  getCapabilities(): AdapterCapabilities
}
