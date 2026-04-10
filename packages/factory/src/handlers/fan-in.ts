/**
 * fan-in handler — consolidates results from parallel branches and selects
 * the best candidate using heuristic ranking or an optional LLM call.
 *
 * Story 50-2.
 *
 * Reads:  context key `parallel.results` (array of BranchResult)
 * Writes: context keys `parallel.fan_in.best_id` and `parallel.fan_in.best_outcome`
 *         plus the winner's `context_updates` merged into the main context.
 */

import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler, FanInBranchResult } from './types.js'
import { callLLM } from '@substrate-ai/core'

/**
 * Re-export FanInBranchResult as BranchResult for backward compatibility.
 * The canonical type definition lives in types.ts (cross-story contract).
 */
export type { FanInBranchResult as BranchResult } from './types.js'
type BranchResult = FanInBranchResult

// ---------------------------------------------------------------------------
// FanInHandlerOptions
// ---------------------------------------------------------------------------

/**
 * Configuration for `createFanInHandler`.
 */
export interface FanInHandlerOptions {
  /**
   * Injectable LLM call function for testability.
   * Receives the full selection prompt and returns a text response.
   * In production (when omitted) the handler binds to `callLLM` from
   * `@substrate-ai/core` using default routing parameters.
   */
  llmCall?: (prompt: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Outcome rank constants
// ---------------------------------------------------------------------------

/** Lower number = better rank. FAILURE is excluded before ranking. */
const OUTCOME_RANK: Record<string, number> = {
  SUCCESS: 0,
  PARTIAL_SUCCESS: 1,
  NEEDS_RETRY: 2,
  FAILURE: 3,
  ESCALATE: 4,
}

// ---------------------------------------------------------------------------
// rankBranches (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Select the best non-FAILURE branch from `results`.
 *
 * Sort order (ascending priority):
 *   1. `OUTCOME_RANK[status]` ascending (SUCCESS wins)
 *   2. `score` descending (higher is better; `undefined` treated as `0`)
 *   3. `branch_id` ascending (stable tiebreak)
 *
 * Returns `null` when every branch has status `FAILURE`.
 */
export function rankBranches(results: BranchResult[]): BranchResult | null {
  const eligible = results.filter((r) => r.status !== 'FAILURE')
  if (eligible.length === 0) return null

  const sorted = [...eligible].sort((a, b) => {
    // 1. Outcome rank (lower = better)
    const rankDiff = (OUTCOME_RANK[a.status] ?? 99) - (OUTCOME_RANK[b.status] ?? 99)
    if (rankDiff !== 0) return rankDiff
    // 2. Score descending (higher = better)
    const scoreA = a.score ?? 0
    const scoreB = b.score ?? 0
    if (scoreB !== scoreA) return scoreB - scoreA
    // 3. branch_id ascending (stable tiebreak)
    return a.branch_id - b.branch_id
  })

  return sorted[0] ?? null
}

// ---------------------------------------------------------------------------
// buildSelectionPrompt (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Build the prompt sent to the LLM for selection-based fan-in.
 *
 * The prompt prepends `nodePrompt`, then lists each branch with its
 * `branch_id`, `status`, `score`, and the keys present in `context_updates`
 * (values omitted for token efficiency). The LLM is instructed to reply with
 * just the integer `branch_id` of the best candidate.
 */
export function buildSelectionPrompt(nodePrompt: string, results: BranchResult[]): string {
  const branchSummaries = results
    .map((r) => {
      const contextKeys =
        r.context_updates && Object.keys(r.context_updates).length > 0
          ? Object.keys(r.context_updates).join(', ')
          : '(none)'
      return (
        `Branch ${r.branch_id}: status=${r.status}, score=${r.score ?? 0}, ` +
        `context_update_keys=[${contextKeys}]`
      )
    })
    .join('\n')

  return (
    `${nodePrompt}\n\n` +
    `Parallel branch results:\n${branchSummaries}\n\n` +
    `Reply with only the integer branch_id of the best candidate.`
  )
}

// ---------------------------------------------------------------------------
// parseLlmWinnerResponse (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse an LLM response to extract the winning `branch_id`.
 *
 * Scans the response text for the first integer that matches a valid
 * `branch_id` in `results`. Returns the matching `BranchResult`, or `null`
 * (triggering heuristic fallback) if no valid branch_id is found.
 * Logs a warning on fallback.
 */
export function parseLlmWinnerResponse(
  response: string,
  results: BranchResult[]
): BranchResult | null {
  const validIds = new Set(results.map((r) => r.branch_id))
  const matches = response.match(/\d+/g)
  if (matches) {
    for (const m of matches) {
      const id = parseInt(m, 10)
      if (validIds.has(id)) {
        return results.find((r) => r.branch_id === id) ?? null
      }
    }
  }
  console.warn(
    `[fan-in] LLM response did not contain a valid branch_id; falling back to heuristic selection. Response: "${response}"`
  )
  return null
}

// ---------------------------------------------------------------------------
// Default production LLM binding
// ---------------------------------------------------------------------------

/**
 * Default `llmCall` implementation that wraps `callLLM` from `@substrate-ai/core`
 * with fixed default routing parameters.
 */
async function defaultLlmCall(prompt: string): Promise<string> {
  const result = await callLLM({
    model: 'claude-sonnet-4-5',
    provider: 'anthropic',
    reasoningEffort: 'low',
    prompt,
  })
  return result.text
}

// ---------------------------------------------------------------------------
// createFanInHandler — handler factory
// ---------------------------------------------------------------------------

/**
 * Create a `parallel.fan_in` node handler.
 *
 * Execution steps:
 *  1. Read `parallel.results` from context; return FAILURE if absent or empty.
 *  2. If `node.prompt` is non-empty, call LLM to select winner; fall back to
 *     heuristic on parse failure.
 *  3. Use heuristic `rankBranches` when no prompt or LLM fallback.
 *  4. If all branches failed, return FAILURE with aggregated failure reasons.
 *  5. Merge winner's `context_updates`, set `parallel.fan_in.best_id` and
 *     `parallel.fan_in.best_outcome`, return SUCCESS.
 *
 * @param options - Optional configuration (inject `llmCall` for testing).
 */
export function createFanInHandler(options?: FanInHandlerOptions): NodeHandler {
  const llmCallFn = options?.llmCall ?? defaultLlmCall

  return async (node: GraphNode, context: IGraphContext, _graph: Graph): Promise<Outcome> => {
    // Step 1: Read parallel.results from context
    const rawResults = context.get('parallel.results')

    if (!rawResults || !Array.isArray(rawResults) || rawResults.length === 0) {
      return {
        status: 'FAILURE',
        failureReason:
          'fan-in: no parallel results found in context (parallel.results is absent or empty)',
      }
    }

    const results = rawResults as FanInBranchResult[]

    // Step 2 / 3: Select winner via LLM or heuristic
    let winner: BranchResult | null = null

    if (node.prompt && node.prompt.trim().length > 0) {
      // LLM-based selection
      const prompt = buildSelectionPrompt(node.prompt, results)
      try {
        const response = await llmCallFn(prompt)
        winner = parseLlmWinnerResponse(response, results)
      } catch (err) {
        console.warn(
          `[fan-in] LLM call failed; falling back to heuristic selection. Error: ${String(err)}`
        )
        winner = null
      }
      // Fallback to heuristic if LLM parsing failed
      if (winner === null) {
        winner = rankBranches(results)
      }
    } else {
      // Heuristic selection
      winner = rankBranches(results)
    }

    // Step 4: All branches failed
    if (winner === null) {
      const reasons = results
        .map((r) => r.failure_reason ?? `branch ${r.branch_id}: no reason provided`)
        .join('; ')
      return {
        status: 'FAILURE',
        failureReason: `fan-in: all branches failed — ${reasons}`,
      }
    }

    // Step 5: Merge winner context updates and record best_id / best_outcome
    if (winner.context_updates && Object.keys(winner.context_updates).length > 0) {
      context.applyUpdates(winner.context_updates)
    }
    context.set('parallel.fan_in.best_id', winner.branch_id)
    context.set('parallel.fan_in.best_outcome', winner.status)

    return { status: 'SUCCESS' }
  }
}
