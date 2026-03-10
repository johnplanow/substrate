/**
 * Unit tests for timestamp-normalizer.ts
 *
 * Covers all five input formats plus edge cases.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { normalizeTimestamp } from '../timestamp-normalizer.js'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('normalizeTimestamp', () => {
  // -------------------------------------------------------------------------
  // Null / undefined fallback
  // -------------------------------------------------------------------------

  it('returns Date.now() for null', () => {
    const before = Date.now()
    const result = normalizeTimestamp(null)
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })

  it('returns Date.now() for undefined', () => {
    const before = Date.now()
    const result = normalizeTimestamp(undefined)
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })

  it('returns Date.now() for empty string', () => {
    const before = Date.now()
    const result = normalizeTimestamp('')
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })

  it('returns Date.now() for unparseable string', () => {
    const before = Date.now()
    const result = normalizeTimestamp('not-a-timestamp')
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })

  it('returns Date.now() for object', () => {
    const before = Date.now()
    const result = normalizeTimestamp({ foo: 'bar' })
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })

  // -------------------------------------------------------------------------
  // ISO 8601 strings
  // -------------------------------------------------------------------------

  it('parses ISO 8601 string with Z suffix', () => {
    const iso = '2024-03-08T12:00:00.000Z'
    const expected = new Date(iso).getTime()
    expect(normalizeTimestamp(iso)).toBe(expected)
  })

  it('parses ISO 8601 string with timezone offset', () => {
    const iso = '2024-03-08T12:00:00+00:00'
    const expected = new Date(iso).getTime()
    expect(normalizeTimestamp(iso)).toBe(expected)
  })

  it('parses ISO 8601 date-only string', () => {
    const iso = '2024-03-08'
    const expected = new Date(iso).getTime()
    expect(normalizeTimestamp(iso)).toBe(expected)
  })

  // -------------------------------------------------------------------------
  // Nanoseconds (>= 1e18)
  // -------------------------------------------------------------------------

  it('converts nanosecond number to milliseconds', () => {
    // 1709900000000000000 ns = 1709900000000 ms
    const ns = 1709900000000000000
    const result = normalizeTimestamp(ns)
    // Floating point approximation expected
    expect(result).toBeCloseTo(1709900000000, -3)
  })

  it('converts nanosecond string to milliseconds (OTLP startTimeUnixNano)', () => {
    const ns = '1709900000000000000'
    // 1709900000000000000 / 1_000_000 = 1709900000000
    expect(normalizeTimestamp(ns)).toBe(1709900000000)
  })

  it('handles nanosecond BigInt', () => {
    const ns = BigInt('1709900000000000000')
    expect(normalizeTimestamp(ns)).toBe(1709900000000)
  })

  // -------------------------------------------------------------------------
  // Microseconds (>= 1e15, < 1e18)
  // -------------------------------------------------------------------------

  it('converts microsecond number to milliseconds', () => {
    const us = 1709900000000000 // 1e15
    const result = normalizeTimestamp(us)
    expect(result).toBe(1709900000000)
  })

  it('converts microsecond string to milliseconds', () => {
    const us = '1709900000000000'
    expect(normalizeTimestamp(us)).toBe(1709900000000)
  })

  // -------------------------------------------------------------------------
  // Milliseconds (>= 1e12, < 1e15)
  // -------------------------------------------------------------------------

  it('returns millisecond number as-is', () => {
    const ms = 1709900000000 // 2024-03-08 epoch ms
    expect(normalizeTimestamp(ms)).toBe(1709900000000)
  })

  it('returns millisecond string as number', () => {
    const ms = '1709900000000'
    expect(normalizeTimestamp(ms)).toBe(1709900000000)
  })

  // -------------------------------------------------------------------------
  // Seconds (< 1e12)
  // -------------------------------------------------------------------------

  it('converts second number to milliseconds', () => {
    const sec = 1709900000
    expect(normalizeTimestamp(sec)).toBe(1709900000 * 1000)
  })

  it('converts second string to milliseconds', () => {
    const sec = '1709900000'
    expect(normalizeTimestamp(sec)).toBe(1709900000 * 1000)
  })

  it('converts small second value (e.g. 0)', () => {
    expect(normalizeTimestamp(0)).toBe(0)
  })

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  it('handles NaN number with Date.now() fallback', () => {
    const before = Date.now()
    const result = normalizeTimestamp(NaN)
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })

  it('handles Infinity with Date.now() fallback', () => {
    const before = Date.now()
    const result = normalizeTimestamp(Infinity)
    const after = Date.now()
    expect(result).toBeGreaterThanOrEqual(before)
    expect(result).toBeLessThanOrEqual(after)
  })
})
