/**
 * Pure aggregation helper for per-story dispatch telemetry — Story 81-1.
 *
 * Aggregates turn counts and token usage across all phase dispatches for a
 * story, producing the `total_turns` and `total_tokens` values persisted on
 * `PerStoryState`. The function is pure (no I/O) to make it unit-testable.
 *
 * Design note: the current `_storyAgents` dispatch records in the orchestrator
 * do not carry token/turn data (they store `{ agent, phase, model? }` only).
 * This function is designed to consume extended `DispatchRecord` values when
 * available. When called with bare agent-info records that lack telemetry,
 * it returns `{}` (both fields absent) — absent MUST NOT be treated as zero by
 * consumers (see `PerStoryState.total_turns` / `total_tokens` JSDoc). This is
 * the documented known gap: piping turn/token data through every dispatch site
 * is out of scope for Story 81-1 and tracked as a follow-up.
 */

// ---------------------------------------------------------------------------
// DispatchRecord — the shape this helper accepts
// ---------------------------------------------------------------------------

/**
 * A single dispatch record contributed by one phase of story execution.
 * Extends beyond the current `_storyAgents` entries with optional telemetry
 * fields that, when present, are summed into the per-story totals.
 */
export interface DispatchRecord {
  /** Agent identifier (e.g. 'claude-code', 'codex'). */
  agent: string
  /** Phase name (e.g. 'create-story', 'dev-story', 'code-review'). */
  phase: string
  /** Resolved model string, if known. */
  model?: string
  /**
   * Number of agentic turns consumed by this dispatch.
   * Absent when the phase does not track turn counts.
   * Absent MUST NOT be treated as zero.
   */
  turns?: number
  /**
   * Token usage for this dispatch.
   * Absent when the phase does not track token counts (e.g. pre-81-1 dispatch
   * records that only carry `agent`/`phase`/`model`).
   * Absent MUST NOT be treated as zero.
   */
  tokens?: {
    input: number
    output: number
  }
}

// ---------------------------------------------------------------------------
// aggregateStoryDispatchTelemetry
// ---------------------------------------------------------------------------

/**
 * Aggregates turn counts and token usage across an array of dispatch records.
 *
 * Returns an object with `total_turns` and/or `total_tokens` populated only
 * when at least one record carries the corresponding telemetry:
 * - If NO record has `turns` data → `total_turns` is absent.
 * - If NO record has `tokens` data → `total_tokens` is absent.
 * - If SOME records have turns/tokens and some don't, the available data is
 *   summed; records without the field do not contribute zero.
 *
 * Absence MUST NOT be treated as zero by consumers — use `?? null` at call
 * sites per the `PerStoryState.total_turns` / `total_tokens` semantics.
 *
 * @param dispatchRecords - Array of per-dispatch records for one story.
 *   Pass `_storyAgents.get(storyKey) ?? []` from the orchestrator. In the
 *   current implementation those records don't carry token/turn data, so
 *   the result is `{}` — this is the documented known gap.
 * @returns Partial telemetry aggregate: `{}` when no data, populated when present.
 */
export function aggregateStoryDispatchTelemetry(
  dispatchRecords: DispatchRecord[],
): { total_turns?: number; total_tokens?: { input: number; output: number } } {
  if (dispatchRecords.length === 0) {
    return {}
  }

  let turnsSum: number | undefined
  let tokensInput: number | undefined
  let tokensOutput: number | undefined

  for (const record of dispatchRecords) {
    if (record.turns !== undefined) {
      turnsSum = (turnsSum ?? 0) + record.turns
    }
    if (record.tokens !== undefined) {
      tokensInput = (tokensInput ?? 0) + record.tokens.input
      tokensOutput = (tokensOutput ?? 0) + record.tokens.output
    }
  }

  const result: { total_turns?: number; total_tokens?: { input: number; output: number } } = {}

  if (turnsSum !== undefined) {
    result.total_turns = turnsSum
  }

  if (tokensInput !== undefined && tokensOutput !== undefined) {
    result.total_tokens = { input: tokensInput, output: tokensOutput }
  }

  return result
}
