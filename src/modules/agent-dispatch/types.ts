/**
 * Types and interfaces for the Sub-Agent Dispatch Engine.
 *
 * Defines the contracts for dispatching autonomous coding agents
 * (Claude, Codex, Gemini) with compiled prompts and collecting their
 * structured YAML output.
 */

import type { ZodSchema } from 'zod'

// ---------------------------------------------------------------------------
// DispatchRequest
// ---------------------------------------------------------------------------

/**
 * Request payload for dispatching a sub-agent.
 */
export interface DispatchRequest<T = unknown> {
  /** Compiled prompt to pass to the agent via stdin */
  prompt: string
  /** Agent identifier (e.g., 'claude-code', 'codex', 'gemini') */
  agent: string
  /** Task type determines default timeout and output schema */
  taskType: string
  /** Optional timeout override in milliseconds */
  timeout?: number
  /** Optional Zod schema to validate the parsed YAML output */
  outputSchema?: ZodSchema<T>
  /** Optional working directory for the spawned process (defaults to process.cwd()) */
  workingDirectory?: string
  /** Optional model identifier override (e.g., 'claude-opus-4-5' for major rework escalation) */
  model?: string
  /** Optional maximum agentic turns override (passed as --max-turns to Claude CLI) */
  maxTurns?: number
}

// ---------------------------------------------------------------------------
// DispatchHandle
// ---------------------------------------------------------------------------

/**
 * Handle returned immediately when a dispatch is requested.
 * Provides access to current status and lifecycle control.
 */
export interface DispatchHandle {
  /** Unique identifier for this dispatch */
  id: string
  /** Current lifecycle status */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'timeout'
  /** Cancel this dispatch (sends SIGTERM if running, removes from queue if queued) */
  cancel(): Promise<void>
}

// ---------------------------------------------------------------------------
// DispatchResult
// ---------------------------------------------------------------------------

/**
 * Final result of a completed dispatch.
 */
export interface DispatchResult<T = unknown> {
  /** Unique identifier matching the DispatchHandle */
  id: string
  /** Final status of the dispatch */
  status: 'completed' | 'failed' | 'timeout'
  /** Exit code from the subprocess */
  exitCode: number
  /** Output from the agent: stdout for successful dispatches; combined stdout+stderr for failed dispatches */
  output: string
  /** Parsed and validated YAML result (null if parsing failed or no schema) */
  parsed: T | null
  /** Error description if parsing failed */
  parseError: string | null
  /** Total duration from spawn to exit in milliseconds */
  durationMs: number
  /** Token usage estimates */
  tokenEstimate: {
    /** Estimated input tokens (prompt.length / 4) */
    input: number
    /** Estimated output tokens (output.length / 4) */
    output: number
  }
}

// ---------------------------------------------------------------------------
// DispatchConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for the Dispatcher.
 */
export interface DispatchConfig {
  /** Maximum number of concurrently running dispatches */
  maxConcurrency: number
  /** Default timeouts per task type in milliseconds */
  defaultTimeouts: Record<string, number>
}

// ---------------------------------------------------------------------------
// Default timeouts
// ---------------------------------------------------------------------------

/**
 * Default timeout values per task type (milliseconds).
 */
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  'analysis': 300_000,
  'planning': 300_000,
  'architecture': 300_000,
  'story-generation': 300_000,
  'create-story': 180_000,
  'dev-story': 1_800_000,
  'code-review': 900_000,
  'minor-fixes': 300_000,
  'major-rework': 900_000,
}

/**
 * Default max agentic turns per task type.
 * Passed as --max-turns to Claude CLI to prevent turn exhaustion without YAML emission.
 * Only defined for task types that benefit from explicit turn budgets.
 */
export const DEFAULT_MAX_TURNS: Record<string, number> = {
  'dev-story': 75,
  'major-rework': 50,
  'code-review': 25,
  'create-story': 20,
  'minor-fixes': 25,
}

// ---------------------------------------------------------------------------
// Dispatcher interface
// ---------------------------------------------------------------------------

/**
 * The main dispatcher interface for spawning, tracking, and collecting
 * results from autonomous coding agents.
 */
export interface Dispatcher {
  /**
   * Dispatch a sub-agent with the given request.
   *
   * Returns a DispatchHandle synchronously with `id`, `status`, `cancel()`,
   * and a `result` Promise that resolves with the final DispatchResult.
   *
   * If the concurrency limit is reached, the request is queued.
   *
   * @param request - Dispatch request with prompt, agent, taskType, and optional config
   * @returns DispatchHandle with id, status, cancel(), and result Promise
   */
  dispatch<T>(request: DispatchRequest<T>): DispatchHandle & { result: Promise<DispatchResult<T>> }

  /**
   * Return the number of queued (waiting) dispatches.
   */
  getPending(): number

  /**
   * Return the number of currently running dispatches.
   */
  getRunning(): number

  /**
   * Gracefully shut down the dispatcher.
   *
   * Sends SIGTERM to all running processes, waits 10 seconds, then
   * sends SIGKILL to any remaining processes. Rejects new dispatch
   * requests after this is called.
   *
   * @returns Promise that resolves when all processes have exited
   */
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Error thrown when dispatch is attempted on a shutting-down dispatcher.
 */
export class DispatcherShuttingDownError extends Error {
  constructor() {
    super('Dispatcher is shutting down and cannot accept new requests')
    this.name = 'DispatcherShuttingDownError'
  }
}
