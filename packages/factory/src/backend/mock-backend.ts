/**
 * MockCodergenBackend — injectable mock for testing the graph engine.
 *
 * Supports configurable response sequences, per-call failure injection,
 * artificial delays, and full call argument recording.
 *
 * Story 42-18.
 */

import type { GraphNode, IGraphContext, Outcome } from '../graph/types.js'
import type {
  ICodergenBackend,
  MockBackendResponse,
  MockCodergenBackendConfig,
  CallRecord,
} from './types.js'

// ---------------------------------------------------------------------------
// MockCodergenBackend
// ---------------------------------------------------------------------------

/**
 * A configurable mock implementation of `ICodergenBackend`.
 *
 * Usage:
 * ```ts
 * const mock = createMockCodergenBackend({
 *   responses: [{ status: 'NEEDS_RETRY' }, { status: 'SUCCESS', contextUpdates: { result: 'done' } }],
 * })
 * const handler = createCodergenHandler({ backend: mock })
 * ```
 */
export class MockCodergenBackend implements ICodergenBackend {
  /** Configuration for this mock instance. */
  private readonly config: Required<MockCodergenBackendConfig>

  /** 1-based call counter. Incremented before each `run()` evaluation. */
  private _callCount = 0

  /** Recorded arguments from every `run()` invocation, in order. */
  public calls: CallRecord[] = []

  constructor(config?: MockCodergenBackendConfig) {
    this.config = {
      responses: config?.responses ?? [{ status: 'SUCCESS' }],
      failOnCall: config?.failOnCall ?? [],
      delay: config?.delay ?? 0,
    }
  }

  /**
   * Simulate a codergen backend invocation.
   *
   * Steps:
   *   1. Increment `_callCount` (1-based).
   *   2. Record the call arguments into `calls`.
   *   3. Optionally wait `config.delay` milliseconds.
   *   4. If this call index is in `failOnCall`, return `{ status: 'FAILURE' }`.
   *   5. Otherwise return the configured response (last response repeats on over-use).
   */
  async run(node: GraphNode, prompt: string, context: IGraphContext): Promise<Outcome> {
    // 1. Increment call counter (1-based)
    this._callCount++
    const callIndex = this._callCount

    // 2. Record call
    this.calls.push({ node, prompt, context, callIndex })

    // 3. Apply artificial delay
    if (this.config.delay > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.config.delay))
    }

    // 4. Inject failure if this call index is in failOnCall
    if (this.config.failOnCall.includes(callIndex)) {
      return { status: 'FAILURE' }
    }

    // 5. Determine which response to use (last repeats on over-use)
    const responses: MockBackendResponse[] = this.config.responses
    const responseIndex = Math.min(callIndex - 1, responses.length - 1)
    const response = responses[responseIndex]!

    const result: Outcome = {
      status: response.status,
      contextUpdates: response.contextUpdates ?? {},
    }
    if (response.notes !== undefined) {
      result.notes = response.notes
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a new `MockCodergenBackend` instance with the given configuration.
 *
 * @param config - Optional mock configuration (responses, failOnCall, delay).
 * @returns A fresh `MockCodergenBackend` instance.
 */
export function createMockCodergenBackend(config?: MockCodergenBackendConfig): MockCodergenBackend {
  return new MockCodergenBackend(config)
}
