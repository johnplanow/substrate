/**
 * Unit tests for probe-author-metrics rollup (Story 60-15).
 *
 * Covers the three pure functions that power the catch-rate KPI:
 *   - rollupProbeAuthorMetrics: per-story rollup with annotation
 *     cross-reference for confirmed-defect counting
 *   - rollupFindingsByAuthor: byAuthor breakdown of finding severities
 *   - aggregateProbeAuthorMetrics: cross-run aggregate for the
 *     --probe-author-summary flag
 *
 * Backward-compat is load-bearing — the rollup must produce sensible
 * zero values on pre-60-15 manifests (no `_authoredBy` field, no
 * `annotations` array).
 */

import { describe, expect, it } from 'vitest'

import {
  aggregateProbeAuthorMetrics,
  rollupFindingsByAuthor,
  rollupProbeAuthorMetrics,
  ZERO_PROBE_AUTHOR_METRICS,
} from '../probe-author-metrics.js'
import type { StoredVerificationSummary } from '../verification-result.js'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summaryWithFindings(
  findings: Array<{
    category: string
    severity: 'error' | 'warn' | 'info'
    message: string
    _authoredBy?: 'probe-author' | 'create-story-ac-transfer'
  }>,
  annotations?: StoredVerificationSummary['annotations'],
): StoredVerificationSummary {
  return {
    storyKey: 'test-1',
    status: 'fail',
    duration_ms: 100,
    checks: [
      {
        checkName: 'RuntimeProbeCheck',
        status: 'fail',
        details: 'test',
        duration_ms: 50,
        findings,
      },
    ],
    ...(annotations !== undefined ? { annotations } : {}),
  }
}

// ---------------------------------------------------------------------------
// rollupProbeAuthorMetrics
// ---------------------------------------------------------------------------

describe('rollupProbeAuthorMetrics', () => {
  it('returns zero metrics for undefined/null summary', () => {
    expect(rollupProbeAuthorMetrics(undefined)).toEqual(ZERO_PROBE_AUTHOR_METRICS)
    expect(rollupProbeAuthorMetrics(null)).toEqual(ZERO_PROBE_AUTHOR_METRICS)
  })

  it('honors dispatchedHint when present even on undefined summary', () => {
    const result = rollupProbeAuthorMetrics(undefined, true)
    expect(result.dispatched).toBe(true)
    expect(result.probesAuthoredCount).toBe(0)
  })

  it('counts probe-author authored failures, ignores create-story-ac-transfer', () => {
    const summary = summaryWithFindings([
      {
        category: 'runtime-probe-fail',
        severity: 'error',
        message: 'probe "p1" failed',
        _authoredBy: 'probe-author',
      },
      {
        category: 'runtime-probe-fail',
        severity: 'error',
        message: 'probe "p2" failed',
        _authoredBy: 'probe-author',
      },
      {
        category: 'runtime-probe-fail',
        severity: 'error',
        message: 'probe "legacy" failed',
        _authoredBy: 'create-story-ac-transfer',
      },
    ])
    const result = rollupProbeAuthorMetrics(summary)
    expect(result.dispatched).toBe(true)
    expect(result.authoredProbesFailedCount).toBe(2) // legacy probe excluded
    expect(result.authoredProbesCaughtConfirmedDefectCount).toBe(0) // no annotations
  })

  it('treats absent _authoredBy as create-story-ac-transfer (backward compat)', () => {
    // Pre-60-15 manifests: findings have no `_authoredBy` field at all.
    const summary = summaryWithFindings([
      {
        category: 'runtime-probe-fail',
        severity: 'error',
        message: 'probe "old" failed',
      },
    ])
    const result = rollupProbeAuthorMetrics(summary)
    expect(result.dispatched).toBe(false)
    expect(result.authoredProbesFailedCount).toBe(0)
  })

  it('counts confirmed-defect annotations via category match', () => {
    const summary = summaryWithFindings(
      [
        {
          category: 'runtime-probe-fail',
          severity: 'error',
          message: 'probe "real-defect" failed',
          _authoredBy: 'probe-author',
        },
        {
          category: 'runtime-probe-fail',
          severity: 'error',
          message: 'probe "false-pos" failed',
          _authoredBy: 'probe-author',
        },
      ],
      [
        {
          findingCategory: 'runtime-probe-fail',
          judgment: 'confirmed-defect',
          probeName: 'real-defect',
          createdAt: '2026-04-29T00:00:00Z',
        },
      ],
    )
    const result = rollupProbeAuthorMetrics(summary)
    expect(result.authoredProbesFailedCount).toBe(2)
    expect(result.authoredProbesCaughtConfirmedDefectCount).toBe(1)
  })

  it('annotation without probeName matches all probes in the category', () => {
    const summary = summaryWithFindings(
      [
        {
          category: 'runtime-probe-error-response',
          severity: 'error',
          message: 'probe "p1" failed',
          _authoredBy: 'probe-author',
        },
        {
          category: 'runtime-probe-error-response',
          severity: 'error',
          message: 'probe "p2" failed',
          _authoredBy: 'probe-author',
        },
      ],
      [
        {
          findingCategory: 'runtime-probe-error-response',
          judgment: 'confirmed-defect',
          // no probeName — annotation applies to all probes in this category
          createdAt: '2026-04-29T00:00:00Z',
        },
      ],
    )
    const result = rollupProbeAuthorMetrics(summary)
    expect(result.authoredProbesCaughtConfirmedDefectCount).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// rollupFindingsByAuthor
// ---------------------------------------------------------------------------

describe('rollupFindingsByAuthor', () => {
  it('routes findings into per-author severity buckets', () => {
    const summary = summaryWithFindings([
      {
        category: 'runtime-probe-fail',
        severity: 'error',
        message: 'probe "x" failed',
        _authoredBy: 'probe-author',
      },
      {
        category: 'build-error',
        severity: 'error',
        message: 'TypeScript error',
        // no _authoredBy → defaults to create-story-ac-transfer
      },
      {
        category: 'phantom-review',
        severity: 'warn',
        message: 'review hint',
      },
    ])
    const result = rollupFindingsByAuthor(summary)
    expect(result['probe-author']).toEqual({ error: 1, warn: 0, info: 0 })
    expect(result['create-story-ac-transfer']).toEqual({ error: 1, warn: 1, info: 0 })
  })

  it('returns zero buckets for undefined summary', () => {
    const result = rollupFindingsByAuthor(undefined)
    expect(result['probe-author']).toEqual({ error: 0, warn: 0, info: 0 })
    expect(result['create-story-ac-transfer']).toEqual({ error: 0, warn: 0, info: 0 })
  })
})

// ---------------------------------------------------------------------------
// aggregateProbeAuthorMetrics
// ---------------------------------------------------------------------------

describe('aggregateProbeAuthorMetrics', () => {
  it('computes catchRateByConfirmedDefect across stories', () => {
    const aggregate = aggregateProbeAuthorMetrics(
      [
        // Story 1: 3 authored, 2 failed, 1 confirmed
        {
          dispatched: true,
          probesAuthoredCount: 3,
          authoredProbesFailedCount: 2,
          authoredProbesCaughtConfirmedDefectCount: 1,
        },
        // Story 2: 2 authored, 0 failed
        {
          dispatched: true,
          probesAuthoredCount: 2,
          authoredProbesFailedCount: 0,
          authoredProbesCaughtConfirmedDefectCount: 0,
        },
        // Story 3: probe-author skipped (legacy path)
        {
          dispatched: false,
          probesAuthoredCount: 0,
          authoredProbesFailedCount: 0,
          authoredProbesCaughtConfirmedDefectCount: 0,
        },
      ],
      3, // 3 stories total
    )

    expect(aggregate.totalStoriesDispatched).toBe(3)
    expect(aggregate.probeAuthorDispatchedCount).toBe(2)
    expect(aggregate.probeAuthorDispatchedPct).toBeCloseTo(2 / 3)
    expect(aggregate.totalAuthoredProbes).toBe(5)
    expect(aggregate.totalAuthoredProbesFailed).toBe(2)
    expect(aggregate.totalConfirmedDefectsCaught).toBe(1)
    expect(aggregate.catchRateByCount).toBeCloseTo(2 / 5)
    expect(aggregate.catchRateByConfirmedDefect).toBeCloseTo(1 / 5)
  })

  it('handles totalStories=0 cleanly (no division by zero)', () => {
    const aggregate = aggregateProbeAuthorMetrics([], 0)
    expect(aggregate.probeAuthorDispatchedPct).toBe(0)
    expect(aggregate.catchRateByCount).toBe(0)
    expect(aggregate.catchRateByConfirmedDefect).toBe(0)
  })

  it('handles totalAuthoredProbes=0 cleanly (no division by zero)', () => {
    const aggregate = aggregateProbeAuthorMetrics(
      [
        {
          dispatched: true,
          probesAuthoredCount: 0,
          authoredProbesFailedCount: 0,
          authoredProbesCaughtConfirmedDefectCount: 0,
        },
      ],
      1,
    )
    expect(aggregate.catchRateByCount).toBe(0)
    expect(aggregate.catchRateByConfirmedDefect).toBe(0)
  })
})
