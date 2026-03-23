/**
 * Types for the codergen backend abstraction layer.
 *
 * Provides `ICodergenBackend` interface and associated types for injecting
 * configurable mock backends into the codergen handler — enabling deterministic
 * testing of retry logic, budget enforcement, and convergence behavior without
 * real LLM calls.
 *
 * Story 42-18.
 */

import type { GraphNode, IGraphContext, Outcome, OutcomeStatus } from '../graph/types.js'

// ---------------------------------------------------------------------------
// MockBackendResponse
// ---------------------------------------------------------------------------

/**
 * A single configured response returned by `MockCodergenBackend` on a given call.
 */
export interface MockBackendResponse {
  /** Status to return for this call. */
  status: OutcomeStatus
  /** Optional context updates to include in the returned Outcome. */
  contextUpdates?: Record<string, string>
  /** Optional notes string to include in the returned Outcome. */
  notes?: string
}

// ---------------------------------------------------------------------------
// MockCodergenBackendConfig
// ---------------------------------------------------------------------------

/**
 * Configuration for `MockCodergenBackend`.
 */
export interface MockCodergenBackendConfig {
  /**
   * Ordered list of responses to return on successive `run()` calls.
   * When calls exceed the list length, the last response is repeated.
   * Defaults to `[{ status: 'SUCCESS' }]`.
   */
  responses?: MockBackendResponse[]
  /**
   * 1-based call indices on which `run()` should return `{ status: 'FAILURE' }`.
   * Defaults to `[]` (no injected failures).
   */
  failOnCall?: number[]
  /**
   * Artificial delay in milliseconds before each `run()` call resolves.
   * Use `vi.useFakeTimers()` in tests to avoid real wall-clock waits.
   * Defaults to `0` (no delay).
   */
  delay?: number
}

// ---------------------------------------------------------------------------
// CallRecord
// ---------------------------------------------------------------------------

/**
 * A record of a single invocation of `MockCodergenBackend.run()`.
 * Appended to `MockCodergenBackend.calls` on each invocation.
 */
export interface CallRecord {
  /** The graph node dispatched. */
  node: GraphNode
  /** The interpolated prompt string passed to `run()`. */
  prompt: string
  /** The graph context at the time of the call. */
  context: IGraphContext
  /** 1-based index of this call among all calls to this mock instance. */
  callIndex: number
}

// ---------------------------------------------------------------------------
// ICodergenBackend
// ---------------------------------------------------------------------------

/**
 * Formal interface for codergen backends.
 * Implemented by `MockCodergenBackend` for testing and by any future real backend.
 */
export interface ICodergenBackend {
  /**
   * Invoke the backend with the given node, prompt, and context.
   * Returns an `Outcome` that the codergen handler returns directly.
   *
   * @param node    - The graph node being dispatched.
   * @param prompt  - The interpolated prompt string.
   * @param context - The current graph execution context.
   */
  run(node: GraphNode, prompt: string, context: IGraphContext): Promise<Outcome>
}
