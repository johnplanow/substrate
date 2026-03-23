/**
 * Codergen handler — invokes an LLM with a prompt derived from node attributes
 * and GraphContext, storing the response in context so downstream nodes can
 * reference it via `{{nodeId_output}}` in their own prompts.
 *
 * Story 42-10.
 */

import type { GraphNode, Graph, IGraphContext, Outcome, ParsedStylesheet } from '../graph/types.js'
import type { NodeHandler } from './types.js'
import type { ICodergenBackend } from '../backend/types.js'
import { resolveNodeStyles } from '../stylesheet/resolver.js'
import { callLLM } from '@substrate-ai/core'

// ---------------------------------------------------------------------------
// System defaults
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-sonnet-4-5'
const DEFAULT_PROVIDER = 'anthropic'
const DEFAULT_REASONING_EFFORT = 'medium'

// ---------------------------------------------------------------------------
// Option types
// ---------------------------------------------------------------------------

/**
 * Configuration options for the codergen handler factory.
 */
export interface CodergenHandlerOptions {
  /** Optional model stylesheet used to resolve per-node LLM routing properties. */
  stylesheet?: ParsedStylesheet
  /** Default LLM model when neither node attributes nor stylesheet specify one. */
  defaultModel?: string
  /** Default LLM provider when neither node attributes nor stylesheet specify one. */
  defaultProvider?: string
  /** Default reasoning effort when neither node attributes nor stylesheet specify one. */
  defaultReasoningEffort?: string
  /**
   * Optional injectable backend for testing.
   * When provided, `backend.run()` is invoked instead of `callLLM()`, and its
   * Outcome is returned directly. The `callLLM` path, model resolution, and error
   * classification are all bypassed. Story 42-18.
   */
  backend?: ICodergenBackend
}

// ---------------------------------------------------------------------------
// Prompt interpolation (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Replace all `{{key}}` placeholders in `template` with the corresponding
 * values from `context`.  Missing keys resolve to empty string `""` without
 * throwing.
 *
 * @param template - The prompt template string (may contain `{{variable}}` tokens).
 * @param context  - The graph context to read values from.
 * @returns The fully-interpolated prompt string.
 */
export function interpolatePrompt(template: string, context: IGraphContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    return context.getString(key, '')
  })
}

// ---------------------------------------------------------------------------
// Model resolution (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Resolve the LLM routing properties for a graph node.
 *
 * Priority (highest wins):
 *   1. Node-level attributes (`node.llmModel`, `node.llmProvider`, `node.reasoningEffort`)
 *   2. Stylesheet-resolved values via `resolveNodeStyles`
 *   3. Per-option defaults (`options.defaultModel`, etc.)
 *   4. System defaults (`claude-sonnet-4-5`, `anthropic`, `medium`)
 */
export function resolveModel(
  node: GraphNode,
  stylesheet?: ParsedStylesheet,
  options?: CodergenHandlerOptions
): { llm_model: string; llm_provider: string; reasoning_effort: string } {
  const stylesheetResolved = stylesheet ? resolveNodeStyles(node, stylesheet) : {}

  const llm_model =
    node.llmModel ||
    stylesheetResolved.llmModel ||
    options?.defaultModel ||
    DEFAULT_MODEL

  const llm_provider =
    node.llmProvider ||
    stylesheetResolved.llmProvider ||
    options?.defaultProvider ||
    DEFAULT_PROVIDER

  const reasoning_effort =
    node.reasoningEffort ||
    stylesheetResolved.reasoningEffort ||
    options?.defaultReasoningEffort ||
    DEFAULT_REASONING_EFFORT

  return { llm_model, llm_provider, reasoning_effort }
}

// ---------------------------------------------------------------------------
// Error classification (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Returns `true` for errors that are transient and should trigger a
 * `NEEDS_RETRY` outcome:
 *   - HTTP status 429 (rate limit)
 *   - Errors whose message contains `"timeout"`, `"ETIMEDOUT"`,
 *     `"ECONNRESET"`, or `"ECONNREFUSED"`
 *
 * All other errors are non-transient and map to `FAILURE`.
 */
export function isTransientError(error: unknown): boolean {
  if (error == null) return false

  // Check HTTP-style status codes
  const status =
    (error as Record<string, unknown>).status ??
    (error as Record<string, unknown>).statusCode
  if (status === 429) return true

  // Check message patterns for transient network / timeout errors
  const message = (error as Record<string, unknown>).message
  if (typeof message === 'string') {
    if (
      message.includes('timeout') ||
      message.includes('ETIMEDOUT') ||
      message.includes('ECONNRESET') ||
      message.includes('ECONNREFUSED')
    ) {
      return true
    }
  }

  return false
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Create a codergen node handler configured with the given options.
 *
 * @param options - Optional configuration (stylesheet, default model/provider/effort).
 * @returns A `NodeHandler` that:
 *   1. Interpolates the node's prompt (or label) against GraphContext.
 *   2. Resolves LLM routing properties.
 *   3. Calls the LLM client from `\@substrate-ai/core`.
 *   4. Returns a `SUCCESS` outcome with the response in `contextUpdates`,
 *      `NEEDS_RETRY` for transient errors, or `FAILURE` for others.
 */
export function createCodergenHandler(options?: CodergenHandlerOptions): NodeHandler {
  return async (node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    // 1. Build the interpolated prompt — prefer node.prompt, fall back to node.label
    const template = node.prompt || node.label || ''
    const interpolatedPrompt = interpolatePrompt(template, context)

    // 1a. If a backend is injected (e.g. MockCodergenBackend for testing),
    //     delegate entirely to it — bypassing model resolution, callLLM, and
    //     error classification. Story 42-18.
    if (options?.backend) {
      return options.backend.run(node, interpolatedPrompt, context)
    }

    // 2. Resolve LLM routing properties
    const { llm_model, llm_provider, reasoning_effort } = resolveModel(
      node,
      options?.stylesheet,
      options
    )

    // 3. Invoke the LLM client
    try {
      const result = await callLLM({
        model: llm_model,
        provider: llm_provider,
        reasoningEffort: reasoning_effort,
        prompt: interpolatedPrompt,
      })

      const responseText = result.text

      // 4. Map to SUCCESS outcome — store response under `${nodeId}_output`
      return {
        status: 'SUCCESS',
        notes: responseText,
        contextUpdates: {
          [`${node.id}_output`]: responseText,
        },
      }
    } catch (error: unknown) {
      // 5. Classify and map error to retry or failure outcome
      if (isTransientError(error)) {
        return { status: 'NEEDS_RETRY', error }
      }
      return { status: 'FAILURE', error }
    }
  }
}
