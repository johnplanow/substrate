/**
 * Token counter utility for the context-compiler module.
 *
 * Uses a simple heuristic: chars/4, with a 10% upward adjustment for text
 * containing fenced code blocks (triple backticks). Intentionally conservative
 * — better to under-fill a prompt than overflow.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHARS_PER_TOKEN = 4
const CODE_BLOCK_ADJUSTMENT = 1.1 // 10% upward adjustment for code blocks
const CODE_BLOCK_MARKER = '```'

// ---------------------------------------------------------------------------
// countTokens
// ---------------------------------------------------------------------------

/**
 * Approximate the number of tokens in `text`.
 *
 * - Base heuristic: `Math.ceil(text.length / 4)`
 * - If the text contains one or more fenced code blocks (triple backticks),
 *   apply a 10% upward multiplier and re-ceil.
 *
 * The approximation is within 15% of actual tokenizer output for typical
 * prompt content.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0

  const base = text.length / CHARS_PER_TOKEN
  const hasCodeBlock = text.includes(CODE_BLOCK_MARKER)
  const adjusted = hasCodeBlock ? base * CODE_BLOCK_ADJUSTMENT : base
  return Math.ceil(adjusted)
}

// ---------------------------------------------------------------------------
// truncateToTokens
// ---------------------------------------------------------------------------

/**
 * Truncate `text` to approximately `maxTokens` tokens.
 *
 * Returns the original text if it already fits within the budget.
 * Appends a `…` ellipsis suffix when truncation occurs to indicate content
 * was cut off.
 *
 * Note: Because the chars/4 heuristic is an approximation, the truncated
 * result may still slightly exceed or fall short of the exact token target.
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return ''
  if (countTokens(text) <= maxTokens) return text

  // Estimate target character length to achieve maxTokens.
  // Divide by CODE_BLOCK_ADJUSTMENT conservatively if there are code blocks.
  const hasCodeBlock = text.includes(CODE_BLOCK_MARKER)
  const multiplier = hasCodeBlock ? CODE_BLOCK_ADJUSTMENT : 1
  const targetChars = Math.floor((maxTokens * CHARS_PER_TOKEN) / multiplier)

  if (targetChars <= 0) return ''

  // Truncate at a word boundary if possible (look back up to 50 chars)
  const roughTrunc = text.slice(0, targetChars)
  const lastSpace = roughTrunc.lastIndexOf(' ', roughTrunc.length - 1)

  let truncated: string
  if (lastSpace > targetChars - 50 && lastSpace > 0) {
    truncated = roughTrunc.slice(0, lastSpace)
  } else {
    truncated = roughTrunc
  }

  return truncated + '…'
}
