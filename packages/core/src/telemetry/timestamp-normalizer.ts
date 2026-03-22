/**
 * Timestamp normalization for OTLP telemetry payloads.
 *
 * OTLP payloads use nanosecond integers for timestamps (e.g. `startTimeUnixNano`).
 * Claude Code and other providers may emit timestamps in various formats.
 *
 * `normalizeTimestamp()` accepts any unknown value and returns a Unix millisecond
 * number. Null/undefined/unparseable inputs fall back to `Date.now()`.
 *
 * Detection order (after ISO string check):
 *   1. Nanoseconds  (>= 1e18)
 *   2. Microseconds (>= 1e15)
 *   3. Milliseconds (>= 1e12)
 *   4. Seconds      (< 1e12)
 */

// ---------------------------------------------------------------------------
// normalizeTimestamp
// ---------------------------------------------------------------------------

/**
 * Normalize any timestamp value to Unix milliseconds.
 *
 * Handles:
 *   - ISO 8601 strings (e.g. "2024-03-08T12:00:00Z")
 *   - Nanosecond integers or numeric strings (>= 1e18)
 *   - Microsecond integers or numeric strings (>= 1e15)
 *   - Millisecond integers or numeric strings (>= 1e12)
 *   - Second integers or numeric strings (< 1e12)
 *   - BigInt string values from OTLP `startTimeUnixNano` (e.g. "1709900000000000000")
 *   - null / undefined / unparseable → falls back to Date.now()
 *
 * @param value - Raw timestamp value of unknown type
 * @returns Unix millisecond timestamp
 */
export function normalizeTimestamp(value: unknown): number {
  if (value === null || value === undefined) {
    return Date.now()
  }

  // ISO 8601 string
  if (typeof value === 'string') {
    // Try ISO 8601 date string first (contains non-digit characters beyond just digits)
    if (isIsoDateString(value)) {
      const parsed = Date.parse(value)
      if (!isNaN(parsed)) {
        return parsed
      }
    }

    // Numeric string (potentially bigint nanosecond from OTLP)
    // Use BigInt for large nanosecond values to avoid floating point precision loss
    const trimmed = value.trim()
    if (/^\d+$/.test(trimmed)) {
      try {
        const big = BigInt(trimmed)
        return bigIntToMillis(big)
      } catch {
        // fall through
      }
    }

    return Date.now()
  }

  // BigInt
  if (typeof value === 'bigint') {
    return bigIntToMillis(value)
  }

  // Number
  if (typeof value === 'number') {
    if (!isFinite(value) || isNaN(value)) {
      return Date.now()
    }
    return numericToMillis(value)
  }

  return Date.now()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns true if the string looks like an ISO 8601 date string
 * (contains letters or dashes/colons in date-like positions).
 */
function isIsoDateString(value: string): boolean {
  // Quick check: contains 'T' or '-' in date-like format, or ends with 'Z'
  return (
    /^\d{4}-\d{2}-\d{2}/.test(value) ||
    /Z$/.test(value) ||
    /[+-]\d{2}:\d{2}$/.test(value) ||
    value.includes('T')
  )
}

/**
 * Convert a BigInt nanosecond/microsecond/millisecond/second value to milliseconds.
 */
function bigIntToMillis(value: bigint): number {
  const NS_THRESHOLD = BigInt('1000000000000000000') // 1e18
  const US_THRESHOLD = BigInt('1000000000000000') // 1e15
  const MS_THRESHOLD = BigInt('1000000000000') // 1e12

  if (value >= NS_THRESHOLD) {
    // Nanoseconds → milliseconds
    return Number(value / BigInt(1_000_000))
  } else if (value >= US_THRESHOLD) {
    // Microseconds → milliseconds
    return Number(value / BigInt(1_000))
  } else if (value >= MS_THRESHOLD) {
    // Already milliseconds
    return Number(value)
  } else {
    // Seconds → milliseconds
    return Number(value) * 1_000
  }
}

/**
 * Convert a numeric value to milliseconds based on magnitude.
 */
function numericToMillis(value: number): number {
  if (value >= 1e18) {
    // Nanoseconds
    return Math.floor(value / 1_000_000)
  } else if (value >= 1e15) {
    // Microseconds
    return Math.floor(value / 1_000)
  } else if (value >= 1e12) {
    // Milliseconds
    return Math.floor(value)
  } else {
    // Seconds
    return Math.floor(value * 1_000)
  }
}
