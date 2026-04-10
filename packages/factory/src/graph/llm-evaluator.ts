/**
 * LLM-based edge condition evaluator for the factory graph engine.
 *
 * Provides pure, side-effect-free functions for detecting `llm:` prefixed
 * conditions, building evaluation prompts, parsing boolean responses, and
 * executing an LLM-backed condition evaluation with safe error handling.
 *
 * Zero external package imports — all LLM wiring is done by the caller
 * (edge-selector.ts) via the injectable `llmCall` parameter.
 *
 * Story 50-4.
 */

// ---------------------------------------------------------------------------
// isLlmCondition
// ---------------------------------------------------------------------------

/**
 * Returns `true` iff the condition string starts with the `"llm:"` prefix
 * (after trimming leading/trailing whitespace).
 */
export function isLlmCondition(condition: string): boolean {
  return condition.trim().startsWith('llm:')
}

// ---------------------------------------------------------------------------
// extractLlmQuestion
// ---------------------------------------------------------------------------

/**
 * Strips the `"llm:"` prefix and trims surrounding whitespace from the
 * remainder of the condition string.
 *
 * @param condition - A condition string beginning with `"llm:"`.
 * @returns The extracted question text, trimmed.
 */
export function extractLlmQuestion(condition: string): string {
  return condition.trim().slice('llm:'.length).trim()
}

// ---------------------------------------------------------------------------
// buildEvaluationPrompt
// ---------------------------------------------------------------------------

/**
 * Builds an LLM evaluation prompt that includes the question and a JSON
 * block of the current context snapshot, with an explicit instruction to
 * answer with only "yes" or "no".
 *
 * @param question         - The routing question extracted from the condition.
 * @param contextSnapshot  - Shallow copy of the current execution context.
 * @returns The fully constructed prompt string.
 */
export function buildEvaluationPrompt(
  question: string,
  contextSnapshot: Record<string, unknown>
): string {
  return [
    `You are evaluating a routing condition in a software pipeline.`,
    ``,
    `Context:`,
    JSON.stringify(contextSnapshot, null, 2),
    ``,
    `Question: ${question}`,
    ``,
    `Answer with exactly "yes" or "no".`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// parseLlmBoolResponse
// ---------------------------------------------------------------------------

/**
 * Parses an LLM yes/no response into a boolean value.
 *
 * Returns `true` if the cleaned (trimmed, lowercased) response starts with or
 * contains one of: `"yes"`, `"true"`, `"affirmative"`, `"correct"`, `"1"`.
 * Returns `false` otherwise, including for an empty string.
 *
 * @param response - Raw text response from the LLM.
 * @returns `true` for affirmative responses, `false` for all others.
 */
export function parseLlmBoolResponse(response: string): boolean {
  const cleaned = response.trim().toLowerCase()
  const affirmatives = ['yes', 'true', 'affirmative', 'correct', '1']
  return affirmatives.some(
    (token) =>
      cleaned === token || cleaned.startsWith(token + ' ') || cleaned.startsWith(token + '\n')
  )
}

// ---------------------------------------------------------------------------
// evaluateLlmCondition
// ---------------------------------------------------------------------------

/**
 * Evaluates an LLM edge condition asynchronously.
 *
 * Builds the evaluation prompt, calls the injectable `llmCall` function,
 * and parses the response via `parseLlmBoolResponse`. If any step throws,
 * returns `false` silently — never re-throws.
 *
 * @param question         - The routing question to evaluate.
 * @param contextSnapshot  - Shallow copy of the current execution context.
 * @param llmCall          - Injectable async function that calls an LLM and
 *                           returns the raw text response.
 * @returns `true` if the LLM responds affirmatively, `false` otherwise or on error.
 */
export async function evaluateLlmCondition(
  question: string,
  contextSnapshot: Record<string, unknown>,
  llmCall: (prompt: string) => Promise<string>
): Promise<boolean> {
  try {
    const prompt = buildEvaluationPrompt(question, contextSnapshot)
    const response = await llmCall(prompt)
    return parseLlmBoolResponse(response)
  } catch {
    return false
  }
}
