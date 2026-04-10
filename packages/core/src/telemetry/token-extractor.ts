/**
 * Token extraction from OTLP span/log attributes and body JSON.
 *
 * OTLP payloads from different LLM providers use varying attribute naming
 * conventions for token counts. This module provides fuzzy extraction via
 * case-insensitive substring pattern matching.
 *
 * Priority: attributes take precedence over body for each field.
 * Body fallback: parses JSON and recursively searches up to depth 4.
 */

import type { TokenCounts } from './types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single OTLP attribute entry.
 */
interface OtlpAttributeValue {
  stringValue?: string
  intValue?: string | number
  doubleValue?: string | number
  boolValue?: boolean
}

interface OtlpAttribute {
  key: string
  value: OtlpAttributeValue
}

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

/**
 * Patterns for matching attribute keys to token fields.
 * Each pattern is checked case-insensitively via substring match.
 *
 * IMPORTANT: more-specific patterns (cacheRead, cacheCreation) MUST come first
 * so that keys like `cache_read_input_tokens` match `cache_read` before `input_token`.
 */
const TOKEN_PATTERNS = {
  cacheRead: ['cache_read'],
  cacheCreation: ['cache_creation', 'cache_write'],
  input: ['input_token', 'prompt_token'],
  output: ['output_token', 'completion_token'],
} as const

// ---------------------------------------------------------------------------
// extractTokensFromAttributes
// ---------------------------------------------------------------------------

/**
 * Extract token counts from an OTLP attributes array.
 *
 * Matches attribute keys case-insensitively against known patterns.
 * The first matching value for each field wins.
 *
 * @param attributes - Array of OTLP attribute entries
 * @returns Partial token counts (only fields found in attributes)
 */
export function extractTokensFromAttributes(
  attributes: OtlpAttribute[] | undefined | null
): Partial<TokenCounts> {
  if (!Array.isArray(attributes) || attributes.length === 0) {
    return {}
  }

  const result: Partial<TokenCounts> = {}

  for (const attr of attributes) {
    if (!attr?.key || !attr?.value) continue

    const keyLower = attr.key.toLowerCase()
    const numValue = resolveAttrValue(attr.value)
    if (numValue === undefined) continue

    // Each attribute maps to at most ONE field (first match in priority order wins).
    // cacheRead/cacheCreation patterns are checked before input/output so that
    // keys like `cache_read_input_tokens` do NOT also match `input_token`.
    let matched = false
    for (const [field, patterns] of Object.entries(TOKEN_PATTERNS) as [
      keyof typeof TOKEN_PATTERNS,
      readonly string[],
    ][]) {
      if (matched) break
      if (result[field as keyof TokenCounts] !== undefined) continue
      for (const pattern of patterns) {
        if (keyLower.includes(pattern)) {
          ;(result as Record<string, number>)[field] = numValue
          matched = true
          break
        }
      }
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// extractTokensFromBody
// ---------------------------------------------------------------------------

/**
 * Extract token counts from a JSON body string via recursive search.
 *
 * Parses the body as JSON and recursively walks the object tree up to
 * depth 4, looking for keys matching token patterns.
 *
 * @param body - Raw body string (may be JSON)
 * @returns Partial token counts found in body
 */
export function extractTokensFromBody(body: string | undefined | null): Partial<TokenCounts> {
  if (!body || typeof body !== 'string') {
    return {}
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return {}
  }

  return searchObjectForTokens(parsed, 0)
}

// ---------------------------------------------------------------------------
// mergeTokenCounts
// ---------------------------------------------------------------------------

/**
 * Merge attribute-derived and body-derived token counts.
 *
 * Attributes take priority over body for each field.
 * Missing fields default to 0.
 *
 * @param fromAttributes - Token counts from attributes (higher priority)
 * @param fromBody - Token counts from body JSON (lower priority)
 * @returns Complete TokenCounts with all fields
 */
export function mergeTokenCounts(
  fromAttributes: Partial<TokenCounts>,
  fromBody: Partial<TokenCounts>
): TokenCounts {
  return {
    input: fromAttributes.input ?? fromBody.input ?? 0,
    output: fromAttributes.output ?? fromBody.output ?? 0,
    cacheRead: fromAttributes.cacheRead ?? fromBody.cacheRead ?? 0,
    cacheCreation: fromAttributes.cacheCreation ?? fromBody.cacheCreation ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve an OTLP attribute value to a number.
 * OTLP integer values arrive as strings (e.g. `"intValue": "2048"`).
 */
function resolveAttrValue(value: OtlpAttributeValue): number | undefined {
  if (value.intValue !== undefined) {
    const n = Number(value.intValue)
    return isFinite(n) ? n : undefined
  }
  if (value.doubleValue !== undefined) {
    const n = Number(value.doubleValue)
    return isFinite(n) ? n : undefined
  }
  if (value.stringValue !== undefined) {
    const n = Number(value.stringValue)
    if (!isNaN(n) && isFinite(n)) return n
  }
  return undefined
}

/**
 * Recursively search an object for token count fields up to maxDepth.
 */
function searchObjectForTokens(obj: unknown, depth: number): Partial<TokenCounts> {
  if (depth >= 4 || obj === null || typeof obj !== 'object') {
    return {}
  }

  const result: Partial<TokenCounts> = {}

  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = searchObjectForTokens(item, depth + 1)
      mergePartialInto(result, found)
    }
    return result
  }

  const record = obj as Record<string, unknown>
  for (const [key, val] of Object.entries(record)) {
    const keyLower = key.toLowerCase()

    // Check if this key matches a token pattern.
    // Each key maps to at most ONE field (first match in priority order wins).
    let keyMatched = false
    for (const [field, patterns] of Object.entries(TOKEN_PATTERNS) as [
      keyof typeof TOKEN_PATTERNS,
      readonly string[],
    ][]) {
      if (keyMatched) break
      if (result[field as keyof TokenCounts] !== undefined) continue
      for (const pattern of patterns) {
        if (keyLower.includes(pattern)) {
          const num = typeof val === 'number' ? val : typeof val === 'string' ? Number(val) : NaN
          if (!isNaN(num) && isFinite(num)) {
            ;(result as Record<string, number>)[field] = num
          }
          keyMatched = true
          break
        }
      }
    }

    // Recurse into nested objects
    if (val !== null && typeof val === 'object') {
      const nested = searchObjectForTokens(val, depth + 1)
      mergePartialInto(result, nested)
    }
  }

  return result
}

/**
 * Merge source into target, only filling missing fields.
 */
function mergePartialInto(target: Partial<TokenCounts>, source: Partial<TokenCounts>): void {
  if (target.input === undefined && source.input !== undefined) target.input = source.input
  if (target.output === undefined && source.output !== undefined) target.output = source.output
  if (target.cacheRead === undefined && source.cacheRead !== undefined)
    target.cacheRead = source.cacheRead
  if (target.cacheCreation === undefined && source.cacheCreation !== undefined)
    target.cacheCreation = source.cacheCreation
}
