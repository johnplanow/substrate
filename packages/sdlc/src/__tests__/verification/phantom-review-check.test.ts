/**
 * Unit tests for PhantomReviewCheck — Story 51-2.
 *
 * Framework: Vitest (describe / it / expect — no Jest globals, no jest.fn()).
 * No real file I/O, no subprocess calls — pure unit test of check logic.
 *
 * AC coverage:
 *   AC1  — dispatch failed (non-zero exit, timeout) → fail, details include "dispatch failed"
 *   AC2  — empty rawOutput (empty string, whitespace-only) → fail, details include "empty review output"
 *   AC3  — schema_validation_failed error → fail, details include "schema validation failed"
 *   AC5  — valid SHIP_IT and NEEDS_MINOR_FIXES reviews → pass
 *   AC6  — name === 'phantom-review', tier === 'A', run returns Promise<VerificationResult>
 *   AC7  — ≥10 it() cases; duration_ms is a non-negative number on all results
 */

import { describe, it, expect } from 'vitest'
import { PhantomReviewCheck } from '../../verification/checks/phantom-review-check.js'
import type { VerificationContext, ReviewSignals } from '../../verification/types.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(reviewOverrides?: Partial<ReviewSignals>): VerificationContext {
  return {
    storyKey: '51-2',
    workingDir: '/tmp/test',
    commitSha: 'abc123',
    timeout: 30_000,
    reviewResult: reviewOverrides !== undefined ? (reviewOverrides as ReviewSignals) : undefined,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PhantomReviewCheck', () => {
  // AC6 — check metadata
  it('has name "phantom-review" and tier "A"', () => {
    const check = new PhantomReviewCheck()
    expect(check.name).toBe('phantom-review')
    expect(check.tier).toBe('A')
  })

  // AC6 — run returns a Promise
  it('has a run method that returns a Promise', async () => {
    const check = new PhantomReviewCheck()
    const result = check.run(makeContext({ dispatchFailed: false, rawOutput: 'verdict: SHIP_IT\n...' }))
    expect(result).toBeInstanceOf(Promise)
    await result
  })

  // AC1 — dispatch failed (non-zero exit code)
  it('returns fail when dispatch failed with non-zero exit code', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: true, error: 'Exit code: 1' }),
    )
    expect(result.status).toBe('fail')
    expect(result.details).toContain('dispatch failed')
    expect(result.details).toContain('Exit code: 1')
  })

  // AC1 — dispatch failed (timeout)
  it('returns fail when dispatch timed out', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: true, error: 'Dispatch status: timeout after 300s' }),
    )
    expect(result.status).toBe('fail')
    expect(result.details).toContain('dispatch failed')
  })

  // AC3 — schema validation failure
  it('returns fail with "schema validation failed" when error is schema_validation_failed', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: true, error: 'schema_validation_failed' }),
    )
    expect(result.status).toBe('fail')
    expect(result.details).toContain('schema validation failed')
  })

  // AC2 — empty rawOutput (empty string)
  it('returns fail when rawOutput is empty string', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: false, rawOutput: '' }),
    )
    expect(result.status).toBe('fail')
    expect(result.details).toContain('empty review output')
  })

  // AC2 — empty rawOutput (whitespace only)
  it('returns fail when rawOutput is whitespace-only', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: false, rawOutput: '   \n  ' }),
    )
    expect(result.status).toBe('fail')
    expect(result.details).toContain('empty review output')
  })

  // AC2 — undefined rawOutput means dispatch result didn't capture output (not phantom)
  it('returns pass when rawOutput is undefined (output not captured)', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: false, rawOutput: undefined }),
    )
    expect(result.status).toBe('pass')
  })

  // AC5 — valid SHIP_IT review
  it('returns pass for a valid SHIP_IT review', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({
        dispatchFailed: false,
        rawOutput: 'verdict: SHIP_IT\nissues: 0\nissue_list: []',
      }),
    )
    expect(result.status).toBe('pass')
    expect(result.details).toContain('review output is valid')
  })

  // AC5 — valid NEEDS_MINOR_FIXES review
  it('returns pass for a valid NEEDS_MINOR_FIXES review', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({
        dispatchFailed: false,
        rawOutput: 'verdict: NEEDS_MINOR_FIXES\nissues: 1\nissue_list:\n  - minor issue',
      }),
    )
    expect(result.status).toBe('pass')
    expect(result.details).toContain('review output is valid')
  })

  // AC5 — no reviewResult in context (skip)
  it('returns pass when reviewResult is not set in context (skips check)', async () => {
    const check = new PhantomReviewCheck()
    // Pass undefined to makeContext so reviewResult is omitted from context
    const context: VerificationContext = {
      storyKey: '51-2',
      workingDir: '/tmp/test',
      commitSha: 'abc123',
      timeout: 30_000,
    }
    const result = await check.run(context)
    expect(result.status).toBe('pass')
    expect(result.details).toContain('skipping')
  })

  // AC7 — duration_ms is non-negative on all result types
  it('includes a non-negative duration_ms on fail result (dispatch failed)', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: true, error: 'Exit code: 1' }),
    )
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('includes a non-negative duration_ms on fail result (empty output)', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: false, rawOutput: '' }),
    )
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('includes a non-negative duration_ms on pass result (valid review)', async () => {
    const check = new PhantomReviewCheck()
    const result = await check.run(
      makeContext({ dispatchFailed: false, rawOutput: 'verdict: LGTM_WITH_NOTES\n...' }),
    )
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  // Story 55-2 AC1 — structured findings emitted on fail and empty on pass
  describe('structured findings (story 55-2)', () => {
    it('emits one phantom-review finding with severity=error on dispatch failure', async () => {
      const check = new PhantomReviewCheck()
      const result = await check.run(
        makeContext({ dispatchFailed: true, error: 'Exit code: 1' }),
      )
      expect(result.findings).toHaveLength(1)
      expect(result.findings?.[0]?.category).toBe('phantom-review')
      expect(result.findings?.[0]?.severity).toBe('error')
      expect(result.findings?.[0]?.message).toContain('dispatch failed')
      expect(result.findings?.[0]?.message).toContain('Exit code: 1')
    })

    it('emits one phantom-review finding with severity=error on empty output', async () => {
      const check = new PhantomReviewCheck()
      const result = await check.run(
        makeContext({ dispatchFailed: false, rawOutput: '' }),
      )
      expect(result.findings).toHaveLength(1)
      expect(result.findings?.[0]?.category).toBe('phantom-review')
      expect(result.findings?.[0]?.severity).toBe('error')
      expect(result.findings?.[0]?.message).toBe('empty review output')
    })

    it('emits empty findings array on pass', async () => {
      const check = new PhantomReviewCheck()
      const result = await check.run(
        makeContext({ dispatchFailed: false, rawOutput: 'verdict: SHIP_IT\n...' }),
      )
      expect(result.status).toBe('pass')
      expect(result.findings).toEqual([])
    })

    it('details is equal to renderFindings(findings) on fail', async () => {
      const check = new PhantomReviewCheck()
      const result = await check.run(
        makeContext({ dispatchFailed: true, error: 'schema_validation_failed' }),
      )
      expect(result.findings?.[0]?.message).toBe('schema validation failed')
      // Rendering format: `ERROR [phantom-review] schema validation failed`
      expect(result.details).toBe('ERROR [phantom-review] schema validation failed')
    })
  })
})
