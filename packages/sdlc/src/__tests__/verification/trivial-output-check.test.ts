/**
 * Unit tests for TrivialOutputCheck — Story 51-3.
 *
 * Framework: vitest (describe / it / expect — no Jest globals, no jest.fn()).
 * No real file I/O, no network calls — pure unit test.
 *
 * AC coverage:
 *   AC1  — zero tokens and 99 tokens → fail
 *   AC2  — details string contains "Re-run with increased maxTurns"
 *   AC3  — 100 and 500 tokens → pass
 *   AC4  — custom threshold 250: 200 tokens → fail, 300 tokens → pass
 *   AC5  — undefined outputTokenCount → warn
 *   AC6  — name === 'trivial-output', tier === 'A', run is a function
 *   AC7  — ≥9 it() cases; duration_ms is a non-negative number
 */

import { describe, it, expect } from 'vitest'
import {
  TrivialOutputCheck,
  DEFAULT_TRIVIAL_OUTPUT_THRESHOLD,
} from '../../verification/checks/trivial-output-check.js'
import type { VerificationContext } from '../../verification/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<VerificationContext> = {}): VerificationContext {
  return {
    storyKey: '51-3',
    workingDir: '/tmp/test',
    commitSha: 'abc123',
    timeout: 30_000,
    priorStoryFiles: [],
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TrivialOutputCheck', () => {
  // AC6 — check metadata
  it('has name "trivial-output" and tier "A"', () => {
    const check = new TrivialOutputCheck()
    expect(check.name).toBe('trivial-output')
    expect(check.tier).toBe('A')
  })

  // AC6 — run is a function
  it('has a run method that returns a Promise', async () => {
    const check = new TrivialOutputCheck()
    const result = check.run(makeContext({ outputTokenCount: 200 }))
    expect(result).toBeInstanceOf(Promise)
    await result // ensure it resolves
  })

  // AC1 + AC2 — zero tokens → fail with actionable details
  it('returns fail when outputTokenCount is 0 (zero tokens)', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: 0 }))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('0')
    expect(result.details).toContain(`${DEFAULT_TRIVIAL_OUTPUT_THRESHOLD}`)
    expect(result.details).toContain('Re-run with increased maxTurns')
  })

  // AC1 — 99 tokens (one below threshold) → fail
  it('returns fail when outputTokenCount is 99 (one below default threshold)', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: 99 }))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('99')
    expect(result.details).toContain('Re-run with increased maxTurns')
  })

  // AC3 — exactly 100 tokens (at threshold) → pass
  it('returns pass when outputTokenCount is exactly 100 (at default threshold)', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: 100 }))
    expect(result.status).toBe('pass')
    expect(result.details).toContain('100')
  })

  // AC3 — 500 tokens (well above threshold) → pass
  it('returns pass when outputTokenCount is 500 (well above default threshold)', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: 500 }))
    expect(result.status).toBe('pass')
    expect(result.details).toContain('500')
  })

  // AC5 — undefined outputTokenCount → warn, not fail or crash
  it('returns warn when outputTokenCount is undefined (token data unavailable)', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: undefined }))
    expect(result.status).toBe('warn')
    expect(result.details).toContain('unavailable')
  })

  // AC4 — custom threshold 250, count 200 → fail
  it('returns fail when custom threshold is 250 and count is 200', async () => {
    const check = new TrivialOutputCheck({ trivialOutputThreshold: 250 })
    const result = await check.run(makeContext({ outputTokenCount: 200 }))
    expect(result.status).toBe('fail')
    expect(result.details).toContain('200')
    expect(result.details).toContain('250')
    expect(result.details).toContain('Re-run with increased maxTurns')
  })

  // AC4 — custom threshold 250, count 300 → pass
  it('returns pass when custom threshold is 250 and count is 300', async () => {
    const check = new TrivialOutputCheck({ trivialOutputThreshold: 250 })
    const result = await check.run(makeContext({ outputTokenCount: 300 }))
    expect(result.status).toBe('pass')
    expect(result.details).toContain('300')
    expect(result.details).toContain('250')
  })

  // AC7 — duration_ms is present and non-negative on every result
  it('includes a non-negative duration_ms on pass result', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: 500 }))
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('includes a non-negative duration_ms on fail result', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: 0 }))
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('includes a non-negative duration_ms on warn result (undefined count)', async () => {
    const check = new TrivialOutputCheck()
    const result = await check.run(makeContext({ outputTokenCount: undefined }))
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  // Default threshold exported constant
  it('exports DEFAULT_TRIVIAL_OUTPUT_THRESHOLD === 100', () => {
    expect(DEFAULT_TRIVIAL_OUTPUT_THRESHOLD).toBe(100)
  })

  // Story 55-2 AC2 — structured findings
  describe('structured findings (story 55-2)', () => {
    it('emits a single error finding when below threshold', async () => {
      const check = new TrivialOutputCheck()
      const result = await check.run(makeContext({ outputTokenCount: 42 }))
      expect(result.findings).toHaveLength(1)
      expect(result.findings?.[0]?.category).toBe('trivial-output')
      expect(result.findings?.[0]?.severity).toBe('error')
      expect(result.findings?.[0]?.message).toContain('42')
      expect(result.findings?.[0]?.message).toContain(`${DEFAULT_TRIVIAL_OUTPUT_THRESHOLD}`)
    })

    it('emits a single warn finding when outputTokenCount is missing', async () => {
      const check = new TrivialOutputCheck()
      const result = await check.run(makeContext({ outputTokenCount: undefined }))
      expect(result.findings).toHaveLength(1)
      expect(result.findings?.[0]?.category).toBe('trivial-output')
      expect(result.findings?.[0]?.severity).toBe('warn')
      expect(result.findings?.[0]?.message).toContain('unavailable')
    })

    it('emits empty findings array when above threshold', async () => {
      const check = new TrivialOutputCheck()
      const result = await check.run(makeContext({ outputTokenCount: 500 }))
      expect(result.status).toBe('pass')
      expect(result.findings).toEqual([])
    })
  })
})
