/**
 * Types and interfaces for the Sub-Agent Dispatch Engine.
 *
 * This is the stable, type-safe dispatch contract exported from @substrate-ai/core.
 * Consumers should import from this package rather than from the monolith.
 */

import type { ZodSchema } from "zod"
import type { BillingMode } from "../types.js"

// ---------------------------------------------------------------------------
// Routing abstraction (re-exported from routing module)
// ---------------------------------------------------------------------------

// IRoutingResolver and ModelResolution are defined in packages/core/src/routing/routing-engine.ts
// and imported here for use in DispatchConfig. They are NOT re-exported from dispatch —
// consumers should import them from the routing submodule (or from @substrate-ai/core directly,
// which re-exports the full routing barrel). Keeping the re-export here would create a diamond
// ambiguity since root index.ts exports both dispatch/index.js and routing/index.js.
import type { ModelResolution, IRoutingResolver } from "../routing/routing-engine.js"

// ---------------------------------------------------------------------------
// DispatchRequest
// ---------------------------------------------------------------------------

/**
 * Request payload for dispatching a sub-agent.
 */
export interface DispatchRequest<T = unknown> {
  /** Compiled prompt to pass to the agent via stdin */
  prompt: string
  /** Agent identifier (e.g., "claude-code", "codex", "gemini") */
  agent: string
  /** Task type determines default timeout and output schema */
  taskType: string
  /** Optional timeout override in milliseconds */
  timeout?: number
  /** Optional Zod schema to validate the parsed YAML output */
  outputSchema?: ZodSchema<T>
  /** Optional working directory for the spawned process (defaults to process.cwd()) */
  workingDirectory?: string
  /** Optional model identifier override */
  model?: string
  /** Optional maximum agentic turns override */
  maxTurns?: number
  /** Optional OTLP endpoint URL for telemetry export */
  otlpEndpoint?: string
  /** Optional story key for OTEL resource attribute tagging */
  storyKey?: string
  /** Optional maximum context tokens ceiling */
  maxContextTokens?: number
  /** Optional optimization directives derived from prior stories telemetry */
  optimizationDirectives?: string
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
  status: "queued" | "running" | "completed" | "failed" | "timeout"
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
  status: "completed" | "failed" | "timeout"
  /** Exit code from the subprocess */
  exitCode: number
  /** Output from the agent */
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
  /**
   * Optional routing resolver for model selection.
   * Typed as IRoutingResolver so packages/core does not depend on the monolith.
   * The existing RoutingResolver class satisfies IRoutingResolver structurally.
   */
  routingResolver?: IRoutingResolver
}

// ---------------------------------------------------------------------------
// Default timeouts
// ---------------------------------------------------------------------------

/**
 * Default timeout values per task type (milliseconds).
 */
export const DEFAULT_TIMEOUTS: Record<string, number> = {
  "analysis": 300_000,
  "planning": 300_000,
  "architecture": 300_000,
  "story-generation": 300_000,
  "create-story": 600_000,
  "dev-story": 1_800_000,
  "code-review": 900_000,
  "minor-fixes": 300_000,
  "major-rework": 900_000,
  "readiness-check": 600_000,
  "elicitation": 900_000,
  "analysis-vision": 180_000,
  "analysis-scope": 180_000,
  "planning-classification": 180_000,
  "planning-frs": 240_000,
  "planning-nfrs": 240_000,
  "arch-context": 180_000,
  "arch-decisions": 240_000,
  "arch-patterns": 240_000,
  "story-epics": 240_000,
  "story-stories": 600_000,
}

/**
 * Default max agentic turns per task type.
 * Passed as --max-turns to Claude CLI to prevent turn exhaustion without YAML emission.
 */
export const DEFAULT_MAX_TURNS: Record<string, number> = {
  "analysis": 15,
  "planning": 20,
  "architecture": 25,
  "story-generation": 30,
  "readiness-check": 20,
  "elicitation": 15,
  "critique": 15,
  "dev-story": 75,
  "major-rework": 50,
  "code-review": 25,
  "create-story": 30,
  "minor-fixes": 25,
  "analysis-vision": 8,
  "analysis-scope": 10,
  "planning-classification": 8,
  "planning-frs": 12,
  "planning-nfrs": 12,
  "arch-context": 10,
  "arch-decisions": 15,
  "arch-patterns": 12,
  "story-epics": 15,
  "story-stories": 20,
}

// ---------------------------------------------------------------------------
// DispatcherMemoryState
// ---------------------------------------------------------------------------

/**
 * Current memory pressure state as seen by the dispatcher.
 * Used by the orchestrator for pre-dispatch backoff-retry logic.
 */
export interface DispatcherMemoryState {
  /** Available free memory in megabytes */
  freeMB: number
  /** Minimum free memory threshold in megabytes */
  thresholdMB: number
  /**
   * Platform memory pressure level (macOS only).
   * 1 = normal, 2 = warn, 4 = critical. 0 on non-macOS platforms.
   */
  pressureLevel: number
  /** True when available memory is below the threshold */
  isPressured: boolean
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
   * Returns a DispatchHandle synchronously with id, status, cancel(),
   * and a result Promise that resolves with the final DispatchResult.
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
   * Return current memory pressure state.
   *
   * Used by the orchestrator for pre-dispatch backoff-retry logic (Story 23-8).
   * Callers can check isPressured before dispatching and back off if true.
   */
  getMemoryState(): DispatcherMemoryState

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
    super("Dispatcher is shutting down and cannot accept new requests")
    this.name = "DispatcherShuttingDownError"
  }
}

// ---------------------------------------------------------------------------
// Adapter interfaces (AC2, AC3 — for DispatcherImpl migration)
// ---------------------------------------------------------------------------

/**
 * Minimal spawn command descriptor used by DispatcherImpl.
 * The concrete SpawnCommand from src/adapters/types satisfies this structurally.
 */
export interface ISpawnCommand {
  /** The binary to execute */
  binary: string
  /** Arguments to pass to the binary */
  args: string[]
  /** Working directory for the process */
  cwd: string
  /** Optional environment variable overrides */
  env?: Record<string, string>
  /** Optional list of environment variable keys to unset in the child process */
  unsetEnvKeys?: string[]
}

/**
 * Minimal options passed to ICliAdapter.buildCommand().
 * The concrete AdapterOptions from src/adapters/types satisfies this structurally.
 */
export interface IAdapterOptions {
  /** Path to the git worktree for this task */
  worktreePath: string
  /** Billing mode to use for this execution */
  billingMode: BillingMode
  /** Optional model identifier override */
  model?: string
  /** Optional maximum agentic turns */
  maxTurns?: number
  /** Optional maximum context tokens */
  maxContextTokens?: number
  /** Optional OTLP endpoint URL for telemetry export */
  otlpEndpoint?: string
  /** Optional story key for OTEL resource attribute tagging */
  storyKey?: string
  /** Optional optimization directives */
  optimizationDirectives?: string
  /** Task type for OTLP attribution */
  taskType?: string
  /** Unique dispatch ID for per-dispatch telemetry correlation */
  dispatchId?: string
}

/**
 * Minimal CLI adapter interface.
 * Only defines the methods DispatcherImpl actually calls.
 * The concrete WorkerAdapter from src/adapters satisfies this structurally.
 */
export interface ICliAdapter {
  buildCommand(prompt: string, options: IAdapterOptions): ISpawnCommand
  /** Return adapter capabilities for dispatch decisions. */
  getCapabilities(): {
    timeoutMultiplier?: number
    requiresYamlSuffix?: boolean
    supportsOtlpExport?: boolean
    supportsSystemPrompt?: boolean
    defaultMaxReviewCycles?: number
    [key: string]: unknown
  }
}

/**
 * Minimal adapter registry interface.
 * Only defines the methods DispatcherImpl and RoutingEngineImpl actually call.
 * The concrete AdapterRegistry from src/adapters satisfies this structurally.
 */
export interface IAdapterRegistry {
  get(id: string): ICliAdapter | undefined
  /**
   * Return all registered adapters.
   * Optional — only needed for RoutingEngineImpl's no-policy fallback path.
   * The concrete AdapterRegistry always has this method.
   */
  getAll?(): Array<{ id: string }>
}

/**
 * Logger interface compatible with both pino-style loggers and console.
 * Methods accept any argument pattern: (msg: string) or (obj: unknown, msg?: string).
 */
export interface ILogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
  debug(...args: unknown[]): void
}
