/**
 * Minimal LLM client API for the factory graph engine (story 42-10).
 *
 * `callLLM` is a thin interface boundary — it defines the parameter shape and
 * return type that the codergen handler depends on, keeping the handler
 * decoupled from any specific provider SDK.  Actual provider routing is
 * handled at the application layer (e.g. the executor injects a real
 * implementation via dependency injection or monkey-patching for tests).
 *
 * Callers that need to make live LLM requests should either:
 *  1. Replace the exported function reference at startup, or
 *  2. Mock it with `vi.mock('@substrate-ai/core')` in unit tests.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Parameters passed to an LLM invocation.
 */
export interface LLMCallParams {
  /** Model identifier, e.g. `"claude-sonnet-4-5"` */
  model: string
  /** Provider identifier, e.g. `"anthropic"` */
  provider: string
  /** Reasoning effort hint: `"low"`, `"medium"`, or `"high"` */
  reasoningEffort: string
  /** The fully-interpolated prompt text to send */
  prompt: string
}

/**
 * Result returned by an LLM invocation.
 */
export interface LLMCallResult {
  /** Raw response text from the model */
  text: string
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Invoke an LLM with the given parameters and return the response text.
 *
 * This default export throws "not implemented" — it is intended to be replaced
 * by a real adapter at runtime or mocked in tests.  The codergen handler
 * imports this symbol so that `vi.mock('@substrate-ai/core')` can intercept it.
 */
export async function callLLM(params: LLMCallParams): Promise<LLMCallResult> {
  throw new Error(
    `callLLM: no provider adapter configured for provider="${params.provider}" model="${params.model}"`
  )
}
