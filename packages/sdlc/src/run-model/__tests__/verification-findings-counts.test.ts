/**
 * Unit tests for rollupFindingCounts — Story 55-3b.
 *
 * Covers:
 *   - undefined / null summary → all-zero counts
 *   - summary with no checks → all-zero counts
 *   - summary whose checks all have empty findings arrays → all-zero counts
 *   - summary whose checks lack a findings field entirely (legacy
 *     manifest produced by a check that pre-dates Story 55-2) → all-zero
 *     counts; no throw, no placeholder
 *   - mixed error / warn / info findings across multiple checks add up
 *     per severity correctly
 *   - ZERO_FINDING_COUNTS is frozen (consumers cannot mutate the shared
 *     default)
 */

import { describe, it, expect } from 'vitest'
import {
  rollupFindingCounts,
  ZERO_FINDING_COUNTS,
} from '../verification-findings-counts.js'
import type { StoredVerificationSummary } from '../verification-result.js'

function makeSummary(
  checks: Array<{
    checkName: string
    status?: 'pass' | 'warn' | 'fail'
    findings?: Array<{ category: string; severity: 'error' | 'warn' | 'info'; message: string }>
  }>,
): StoredVerificationSummary {
  return {
    storyKey: 'test',
    status: 'pass',
    duration_ms: 0,
    checks: checks.map((c) => ({
      checkName: c.checkName,
      status: c.status ?? 'pass',
      details: '',
      duration_ms: 0,
      ...(c.findings !== undefined ? { findings: c.findings } : {}),
    })),
  }
}

describe('rollupFindingCounts', () => {
  it('returns zero-counts when the summary is undefined', () => {
    expect(rollupFindingCounts(undefined)).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('returns zero-counts when the summary is null', () => {
    expect(rollupFindingCounts(null)).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('returns zero-counts for an empty checks array', () => {
    expect(rollupFindingCounts(makeSummary([]))).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('returns zero-counts when every check has an explicitly empty findings array', () => {
    const summary = makeSummary([
      { checkName: 'phantom-review', findings: [] },
      { checkName: 'trivial-output', findings: [] },
    ])
    expect(rollupFindingCounts(summary)).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('returns zero-counts when checks lack a findings field (legacy pre-55-2 manifest)', () => {
    // makeSummary omits `findings` entirely when overrides.findings is undefined
    const summary = makeSummary([{ checkName: 'build' }, { checkName: 'phantom-review' }])
    expect(rollupFindingCounts(summary)).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('sums findings by severity across checks', () => {
    const summary = makeSummary([
      {
        checkName: 'build',
        findings: [{ category: 'build-error', severity: 'error', message: 'tsc failed' }],
      },
      {
        checkName: 'acceptance-criteria-evidence',
        findings: [
          { category: 'ac-missing-evidence', severity: 'error', message: 'AC2' },
          { category: 'ac-missing-evidence', severity: 'error', message: 'AC3' },
          { category: 'ac-test-outcome-missing', severity: 'warn', message: 'tests?' },
        ],
      },
      {
        checkName: 'runtime-probes',
        findings: [
          { category: 'runtime-probe-deferred', severity: 'warn', message: 'twin' },
          { category: 'runtime-probe-skip', severity: 'info', message: 'diagnostic' },
        ],
      },
    ])
    expect(rollupFindingCounts(summary)).toEqual({ error: 3, warn: 2, info: 1 })
  })

  it('handles mixed presence — some checks with findings arrays, others without', () => {
    const summary = makeSummary([
      { checkName: 'legacy-no-findings' },
      {
        checkName: 'new-check',
        findings: [{ category: 'x', severity: 'error', message: 'y' }],
      },
    ])
    expect(rollupFindingCounts(summary)).toEqual({ error: 1, warn: 0, info: 0 })
  })

  it('returns a new object each call — the result is not a reference to a shared default', () => {
    const a = rollupFindingCounts(undefined)
    const b = rollupFindingCounts(undefined)
    expect(a).not.toBe(b)
    a.error = 99 // mutation should not leak to subsequent calls
    expect(rollupFindingCounts(undefined)).toEqual({ error: 0, warn: 0, info: 0 })
  })

  it('exports ZERO_FINDING_COUNTS as a frozen constant', () => {
    expect(Object.isFrozen(ZERO_FINDING_COUNTS)).toBe(true)
    expect(ZERO_FINDING_COUNTS).toEqual({ error: 0, warn: 0, info: 0 })
  })
})
