/**
 * Edge selection algorithm for the factory graph engine.
 *
 * Implements the 5-step Attractor spec priority order (Section 3.3):
 *   1. Condition-matched edges (highest priority)
 *   2. Preferred label match on unconditional edges
 *   3. Suggested next IDs on unconditional edges
 *   4. Highest weight among unconditional edges
 *   5. Lexically-first target ID as tiebreak for Step 4
 *
 * Story 42-12.
 */

import type { GraphNode, GraphEdge, Graph, IGraphContext, Outcome } from './types.js'
import { evaluateCondition } from './condition-parser.js'
import { isLlmCondition, extractLlmQuestion, evaluateLlmCondition } from './llm-evaluator.js'
import { callLLM } from '@substrate-ai/core'
import type { TypedEventBus } from '@substrate-ai/core'
import type { FactoryEvents } from '../events.js'

// ---------------------------------------------------------------------------
// normalizeLabel
// ---------------------------------------------------------------------------

/**
 * Normalize an edge label for preferred-label matching.
 *
 * Lowercases and trims the input, then strips an accelerator prefix if present:
 *   - `[K] ` — bracket-enclosed single character followed by whitespace
 *   - `K) `  — single character followed by `)` and whitespace
 *   - `K - ` — single character followed by optional whitespace, `-`, optional whitespace
 *
 * Patterns are matched after lowercasing, so the regex uses only `[a-z]`.
 *
 * @param label - Raw edge label string.
 * @returns Normalized label string.
 */
export function normalizeLabel(label: string): string {
  const s = label.toLowerCase().trim()
  // Apply accelerator prefix strips in order; only one will match per label.
  return s
    .replace(/^[a-z]\)\s+/, '')
    .replace(/^\[[a-z]\]\s+/, '')
    .replace(/^[a-z]\s*-\s*/, '')
    .trim()
}

// ---------------------------------------------------------------------------
// bestByWeightThenLexical
// ---------------------------------------------------------------------------

/**
 * Return the "best" edge from a non-empty array:
 *   - highest `weight` (treating missing weight as 0)
 *   - lexically-first `toNode` as a tiebreak (ascending alphabetical)
 *
 * Does not mutate the input array.
 *
 * @param edges - Non-empty array of candidate edges (caller guarantees length ≥ 1).
 * @returns The winning `GraphEdge`.
 */
export function bestByWeightThenLexical(edges: GraphEdge[]): GraphEdge {
  const sorted = [...edges].sort((a, b) => {
    // Descending by weight
    const weightDiff = (b.weight ?? 0) - (a.weight ?? 0)
    if (weightDiff !== 0) return weightDiff
    // Ascending by target node ID (lexical)
    return a.toNode.localeCompare(b.toNode)
  })
  return sorted[0]!
}

// ---------------------------------------------------------------------------
// SelectEdgeOptions
// ---------------------------------------------------------------------------

/**
 * Optional configuration for `selectEdge`.
 */
export interface SelectEdgeOptions {
  /**
   * Injectable LLM call function for testability.
   * In production, defaults to calling `callLLM` from `@substrate-ai/core`
   * using the node's `llmModel` / `llmProvider` attributes.
   */
  llmCall?: (prompt: string) => Promise<string>
  /** Optional event bus for emitting graph:llm-edge-evaluated events (story 50-9). */
  eventBus?: TypedEventBus<FactoryEvents>
  /** Optional run identifier included in emitted event payloads (story 50-9). */
  runId?: string
}

// ---------------------------------------------------------------------------
// selectEdge
// ---------------------------------------------------------------------------

/**
 * Select the best outgoing edge from `node` according to the 5-step Attractor spec.
 *
 * Step 1: Condition-matched edges — highest weight, lexical tiebreak.
 *         Edges with `llm:` prefix conditions are evaluated via LLM call.
 * Step 2: Preferred label match on unconditional edges — first match wins.
 * Step 3: Suggested next IDs on unconditional edges — first suggestedNextId wins.
 * Step 4: Highest weight among all unconditional edges.
 * Step 5: Lexically-first target node ID as tiebreak for Step 4.
 *
 * @param node    - The current graph node.
 * @param outcome - The outcome returned by the node's handler.
 * @param context - The current execution context (used for condition evaluation).
 * @param graph   - The full graph (source of edges).
 * @param options - Optional injectable overrides (e.g. llmCall for testing).
 * @returns The selected `GraphEdge`, or `null` if no outgoing edges exist.
 */
export async function selectEdge(
  node: GraphNode,
  outcome: Outcome,
  context: IGraphContext,
  graph: Graph,
  options?: SelectEdgeOptions
): Promise<GraphEdge | null> {
  // Collect all edges originating from this node.
  const outgoing = graph.edges.filter((e) => e.fromNode === node.id)

  // AC5: No outgoing edges → return null immediately.
  if (outgoing.length === 0) return null

  // Build default llmCall binding using node attributes.
  const defaultLlmCall = (prompt: string): Promise<string> =>
    callLLM({
      model: node.llmModel || 'claude-haiku-4-5',
      provider: node.llmProvider || 'anthropic',
      reasoningEffort: 'low',
      prompt,
    }).then((r) => r.text)

  const llmCall = options?.llmCall ?? defaultLlmCall

  // Step 1: Condition-matched edges (AC1, AC7).
  const conditionMatches: GraphEdge[] = []
  const snapshot = context.snapshot()
  for (const edge of outgoing) {
    if (edge.condition && edge.condition.trim() !== '') {
      if (isLlmCondition(edge.condition)) {
        // LLM-evaluated condition — wrap llmCall to capture error messages for context
        const question = extractLlmQuestion(edge.condition)
        let evalError: string | null = null

        const trackingLlmCall = async (prompt: string): Promise<string> => {
          try {
            return await llmCall(prompt)
          } catch (err) {
            evalError = err instanceof Error ? err.message : String(err)
            throw err // re-throw so evaluateLlmCondition catches it and returns false
          }
        }

        const matched = await evaluateLlmCondition(question, snapshot, trackingLlmCall)

        // Emit graph:llm-edge-evaluated for every LLM call attempt (story 50-9 AC3)
        // matched will be false on error-fallback path, so this single emission covers all cases
        options?.eventBus?.emit('graph:llm-edge-evaluated', {
          runId: options.runId ?? 'unknown',
          nodeId: node.id,
          question,
          result: matched,
        })

        // Increment LLM evaluation count regardless of success/failure (AC6)
        context.set('llm.edge_eval_count', context.getNumber('llm.edge_eval_count', 0) + 1)

        // On error, append message to llm.edge_eval_errors array (AC5)
        if (evalError !== null) {
          const existing = context.get('llm.edge_eval_errors')
          const errors = Array.isArray(existing) ? existing : []
          errors.push(evalError)
          context.set('llm.edge_eval_errors', errors)
        }

        if (matched) {
          conditionMatches.push(edge)
        }
      } else {
        try {
          if (evaluateCondition(edge.condition, snapshot)) {
            conditionMatches.push(edge)
          }
        } catch {
          // Parse errors or evaluation errors → treat as non-matching.
        }
      }
    }
  }
  if (conditionMatches.length > 0) {
    return bestByWeightThenLexical(conditionMatches)
  }

  // Step 2: Preferred label match on unconditional edges (AC2).
  if (outcome.preferredLabel && outcome.preferredLabel.trim() !== '') {
    const normalizedPreferred = normalizeLabel(outcome.preferredLabel)
    for (const edge of outgoing) {
      if (!edge.condition && normalizeLabel(edge.label) === normalizedPreferred) {
        return edge
      }
    }
  }

  // Step 3: Suggested next IDs on unconditional edges (AC3).
  if (outcome.suggestedNextIds && outcome.suggestedNextIds.length > 0) {
    for (const id of outcome.suggestedNextIds) {
      const match = outgoing.find((e) => !e.condition && e.toNode === id)
      if (match !== undefined) return match
    }
  }

  // Steps 4 & 5: Highest weight with lexical tiebreak among unconditional edges (AC4).
  const unconditional = outgoing.filter((e) => !e.condition)
  if (unconditional.length > 0) {
    return bestByWeightThenLexical(unconditional)
  }

  return null
}
