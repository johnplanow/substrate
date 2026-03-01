/**
 * Shared utilities for dynamic prompt token budget calculation
 * and decision summarization.
 *
 * Extracted from phases/solutioning.ts to avoid inappropriate dependency
 * direction (step-runner.ts importing from a phase-specific module).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Absolute maximum prompt tokens (model context safety margin) */
export const ABSOLUTE_MAX_PROMPT_TOKENS = 12_000

/** Additional tokens per architecture decision injected into story generation prompt */
export const TOKENS_PER_DECISION = 100

/** Priority order for decision categories when summarizing (higher priority kept first) */
export const DECISION_CATEGORY_PRIORITY = ['data', 'auth', 'api', 'frontend', 'infra', 'observability', 'ci']

// ---------------------------------------------------------------------------
// Dynamic budget calculation
// ---------------------------------------------------------------------------

/**
 * Calculate the dynamic prompt token budget based on the number of decisions
 * that will be injected into the prompt.
 *
 * Formula: base_budget + (decision_count * tokens_per_decision)
 * Capped at ABSOLUTE_MAX_PROMPT_TOKENS.
 *
 * @param baseBudget - Base token budget for the phase
 * @param decisionCount - Number of decisions to inject
 * @returns Calculated token budget, capped at ABSOLUTE_MAX_PROMPT_TOKENS
 */
export function calculateDynamicBudget(baseBudget: number, decisionCount: number): number {
  const budget = baseBudget + decisionCount * TOKENS_PER_DECISION
  return Math.min(budget, ABSOLUTE_MAX_PROMPT_TOKENS)
}

// ---------------------------------------------------------------------------
// Decision summarization
// ---------------------------------------------------------------------------

/**
 * Summarize architecture decisions into compact key:value one-liners,
 * dropping rationale and optionally dropping lower-priority categories
 * to fit within a character budget.
 *
 * Strategy:
 * 1. Sort decisions by priority (known categories first, then alphabetical)
 * 2. For each decision, produce a compact `key: value` one-liner (drop rationale)
 * 3. If still over budget, drop lower-priority categories
 * 4. Return the compact summary string
 *
 * @param decisions - Full architecture decisions from the decision store
 * @param maxChars - Maximum character budget for the summarized output
 * @returns Compact summary string
 */
export function summarizeDecisions(
  decisions: Array<{ key: string; value: string; category?: string }>,
  maxChars: number,
): string {
  // Sort by priority: known categories first, then alphabetical
  const sorted = [...decisions].sort((a, b) => {
    const aCat = (a.category ?? '').toLowerCase()
    const bCat = (b.category ?? '').toLowerCase()
    const aIdx = DECISION_CATEGORY_PRIORITY.indexOf(aCat)
    const bIdx = DECISION_CATEGORY_PRIORITY.indexOf(bCat)
    const aPri = aIdx === -1 ? DECISION_CATEGORY_PRIORITY.length : aIdx
    const bPri = bIdx === -1 ? DECISION_CATEGORY_PRIORITY.length : bIdx
    return aPri - bPri
  })

  const header = '## Architecture Decisions (Summarized)'
  const lines: string[] = [header]
  let currentLength = header.length

  for (const d of sorted) {
    // Compact format: truncate long values
    const truncatedValue = d.value.length > 120 ? d.value.slice(0, 117) + '...' : d.value
    const line = `- ${d.key}: ${truncatedValue}`
    if (currentLength + line.length + 1 > maxChars) break
    lines.push(line)
    currentLength += line.length + 1
  }

  return lines.join('\n')
}
