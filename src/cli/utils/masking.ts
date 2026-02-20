/**
 * Credential masking utilities for CLI output and Pino logger redaction.
 *
 * Ensures that API keys and other secrets never appear in logs, status
 * output, or error messages (NFR8, NFR9).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Placeholder shown instead of a real credential */
export const MASKED_VALUE = '***'

/**
 * Regex patterns that identify API key field values.
 * Used by Pino redaction paths and by the string-scrubbing function.
 */
export const API_KEY_PATTERNS: RegExp[] = [
  // Anthropic: sk-ant-...
  /sk-ant-[A-Za-z0-9_-]{20,}/g,
  // OpenAI: sk-...
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Google / Gemini: AIza...
  /AIza[A-Za-z0-9_-]{35,}/g,
  // Generic 40-char hex tokens (e.g. GitHub PATs, generic secrets)
  /\b[A-Fa-f0-9]{40}\b/g,
  // Generic long base64-looking tokens (≥32 chars, no spaces)
  /[A-Za-z0-9+/]{32,}={0,2}/g,
]

/**
 * Known Pino redaction paths for provider API key fields.
 * Pass this array to the `pino({ redact: ... })` option.
 *
 * @example
 * import pino from 'pino'
 * import { PINO_REDACT_PATHS } from './masking.js'
 * const logger = pino({ redact: PINO_REDACT_PATHS })
 */
export const PINO_REDACT_PATHS: string[] = [
  'apiKey',
  'api_key',
  '*.apiKey',
  '*.api_key',
  'providers.*.api_key_env',
  'env.ANTHROPIC_API_KEY',
  'env.OPENAI_API_KEY',
  'env.GOOGLE_API_KEY',
]

// ---------------------------------------------------------------------------
// String scrubbing
// ---------------------------------------------------------------------------

/**
 * Replace any known API key patterns in a string with `***`.
 *
 * This is a best-effort scrub for log messages and error strings; it does
 * NOT guarantee removal of every possible secret format.
 *
 * @param input - The string to scrub
 * @returns Scrubbed string with recognized secrets replaced
 */
export function maskSecrets(input: string): string {
  let result = input
  for (const pattern of API_KEY_PATTERNS) {
    // Reset lastIndex in case the regex is reused (global flag)
    pattern.lastIndex = 0
    result = result.replace(pattern, MASKED_VALUE)
  }
  return result
}

// ---------------------------------------------------------------------------
// Object masking (for config display)
// ---------------------------------------------------------------------------

/**
 * Credential field names that should be replaced with `***` in displayed output.
 */
const CREDENTIAL_FIELDS = new Set([
  'api_key',
  'apiKey',
  'api_key_env',
  'api_key_value',
  'token',
  'secret',
  'password',
])

/**
 * Deep-clone a plain-object tree and replace known credential fields with `***`.
 *
 * Only operates on plain objects and arrays; primitives are returned as-is.
 *
 * @param value - Value to mask
 * @returns Masked clone of `value`
 */
export function deepMask(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (Array.isArray(value)) return value.map(deepMask)
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const masked: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      if (CREDENTIAL_FIELDS.has(k)) {
        masked[k] = MASKED_VALUE
      } else {
        masked[k] = deepMask(v)
      }
    }
    return masked
  }
  return value
}
