/**
 * Unit tests for the Supervisor Analysis Engine (Story 17-3).
 *
 * Tests cover:
 *   - AC2: analyzeTokenEfficiency — token delta detection
 *   - AC3: analyzeReviewCycles — high-cycle story detection + averages
 *   - AC4: analyzeTimings — bottleneck + concentration detection
 *   - AC5: generateAnalysisReport — markdown + JSON structure
 *   - AC6: generateRecommendations — typed recommendation objects
 *   - writeAnalysisReport — file I/O (mocked)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  analyzeTokenEfficiency,
  analyzeReviewCycles,
  analyzeTimings,
  generateRecommendations,
  generateAnalysisReport,
  writeAnalysisReport,
} from '../analysis.js'
import type {
  TokenEfficiencyFinding,
  ReviewCycleAnalysis,
  TimingAnalysis,
  AnalysisReport,
  AnalysisRecommendation,
} from '../analysis.js'
import type { RunMetricsRow, StoryMetricsRow } from '../../../persistence/queries/metrics.js'

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

function makeRunRow(overrides: Partial<RunMetricsRow> = {}): RunMetricsRow {
  return {
    run_id: 'run-test-001',
    methodology: 'bmad',
    status: 'completed',
    started_at: '2026-03-01T10:00:00Z',
    completed_at: '2026-03-01T11:00:00Z',
    wall_clock_seconds: 3600,
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    total_cost_usd: 0.15,
    stories_attempted: 3,
    stories_succeeded: 3,
    stories_failed: 0,
    stories_escalated: 0,
    total_review_cycles: 6,
    total_dispatches: 9,
    concurrency_setting: 2,
    max_concurrent_actual: 2,
    restarts: 0,
    is_baseline: 0,
    created_at: '2026-03-01T10:00:00Z',
    ...overrides,
  }
}

function makeStoryRow(
  story_key: string,
  overrides: Partial<StoryMetricsRow> = {}
): StoryMetricsRow {
  return {
    id: 1,
    run_id: 'run-test-001',
    story_key,
    result: 'success',
    phase_durations_json: null,
    started_at: '2026-03-01T10:00:00Z',
    completed_at: '2026-03-01T10:30:00Z',
    wall_clock_seconds: 1800,
    input_tokens: 3000,
    output_tokens: 1500,
    cost_usd: 0.05,
    review_cycles: 2,
    dispatches: 3,
    created_at: '2026-03-01T10:00:00Z',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// AC2: analyzeTokenEfficiency
// ---------------------------------------------------------------------------

describe('analyzeTokenEfficiency', () => {
  it('returns empty array when no stories exceed 20% threshold', () => {
    const stories = [
      makeStoryRow('17-1', { input_tokens: 3000, output_tokens: 1000 }), // 4000 total
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 3500, output_tokens: 1000 }), // 4500 total — current is LOWER
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(0)
  })

  it('returns finding when tokens exceed baseline by >20%', () => {
    const stories = [
      makeStoryRow('17-1', { input_tokens: 8000, output_tokens: 2000 }), // 10000 total
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 4000, output_tokens: 1000 }), // 5000 total → +100%
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(1)
    expect(result[0].story_key).toBe('17-1')
    expect(result[0].tokens_actual).toBe(10000)
    expect(result[0].tokens_baseline).toBe(5000)
    expect(result[0].delta_pct).toBe(100)
  })

  it('does not return finding when delta is exactly at threshold (20%)', () => {
    const stories = [
      makeStoryRow('17-1', { input_tokens: 4800, output_tokens: 1200 }), // 6000
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 4000, output_tokens: 1000 }), // 5000 → +20%
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    // Exactly 20% is NOT above 20%, so no finding
    expect(result).toHaveLength(0)
  })

  it('returns finding when delta is just above threshold (20.1%)', () => {
    // 5001 / 5000 → delta ~0.1 more than at threshold ... let's use a cleaner example
    // 6010 vs 5000 → delta = 1010/5000 = 20.2%
    const stories = [
      makeStoryRow('17-1', { input_tokens: 4808, output_tokens: 1202 }), // 6010
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 4000, output_tokens: 1000 }), // 5000
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(1)
    expect(result[0].delta_pct).toBeGreaterThan(20)
  })

  it('skips stories with no matching baseline', () => {
    const stories = [makeStoryRow('17-1', { input_tokens: 9000, output_tokens: 1000 })]
    const baseline = [
      makeStoryRow('17-2', { run_id: 'baseline', input_tokens: 1000, output_tokens: 500 }),
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(0)
  })

  it('skips stories where baseline has zero tokens', () => {
    const stories = [makeStoryRow('17-1', { input_tokens: 5000, output_tokens: 1000 })]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 0, output_tokens: 0 }),
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(0)
  })

  it('sorts findings by delta_pct descending', () => {
    const stories = [
      makeStoryRow('17-1', { input_tokens: 10000, output_tokens: 0 }), // +100% vs 5000
      makeStoryRow('17-2', { input_tokens: 7500, output_tokens: 0 }), // +50% vs 5000
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 5000, output_tokens: 0 }),
      makeStoryRow('17-2', { run_id: 'baseline', input_tokens: 5000, output_tokens: 0 }),
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(2)
    expect(result[0].story_key).toBe('17-1') // highest delta first
    expect(result[1].story_key).toBe('17-2')
  })

  it('reports phase as "total" since per-phase token data is unavailable', () => {
    const phases = JSON.stringify({ 'create-story': 100, 'dev-story': 500, 'code-review': 50 })
    const stories = [
      makeStoryRow('17-1', {
        input_tokens: 8000,
        output_tokens: 2000,
        phase_durations_json: phases,
      }),
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 4000, output_tokens: 1000 }),
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(1)
    // phase is always 'total' because StoryMetricsRow only has aggregate token counts
    expect(result[0].phase).toBe('total')
  })

  it('falls back to "total" when phase_durations_json is null', () => {
    const stories = [
      makeStoryRow('17-1', { input_tokens: 8000, output_tokens: 2000, phase_durations_json: null }),
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 4000, output_tokens: 1000 }),
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result[0].phase).toBe('total')
  })

  it('handles multiple stories with mixed results', () => {
    const stories = [
      makeStoryRow('17-1', { input_tokens: 10000, output_tokens: 0 }), // 10000 vs 5000 → +100%
      makeStoryRow('17-2', { input_tokens: 5000, output_tokens: 0 }), // 5000 vs 5000 → 0%, no finding
      makeStoryRow('17-3', { input_tokens: 2000, output_tokens: 0 }), // 2000 vs 5000 → negative, no finding
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', input_tokens: 5000, output_tokens: 0 }),
      makeStoryRow('17-2', { run_id: 'baseline', input_tokens: 5000, output_tokens: 0 }),
      makeStoryRow('17-3', { run_id: 'baseline', input_tokens: 5000, output_tokens: 0 }),
    ]
    const result = analyzeTokenEfficiency(stories, baseline)
    expect(result).toHaveLength(1)
    expect(result[0].story_key).toBe('17-1')
  })
})

// ---------------------------------------------------------------------------
// AC3: analyzeReviewCycles
// ---------------------------------------------------------------------------

describe('analyzeReviewCycles', () => {
  it('returns no high-cycle stories when all stories have ≤2 cycles', () => {
    const stories = [
      makeStoryRow('17-1', { review_cycles: 1 }),
      makeStoryRow('17-2', { review_cycles: 2 }),
    ]
    const result = analyzeReviewCycles(stories, [])
    expect(result.high_cycle_stories).toHaveLength(0)
  })

  it('identifies stories with >2 review cycles', () => {
    const stories = [
      makeStoryRow('17-1', { review_cycles: 3 }),
      makeStoryRow('17-2', { review_cycles: 1 }),
      makeStoryRow('17-3', { review_cycles: 5 }),
    ]
    const result = analyzeReviewCycles(stories, [])
    expect(result.high_cycle_stories).toHaveLength(2)
    expect(result.high_cycle_stories[0].story_key).toBe('17-3') // highest first
    expect(result.high_cycle_stories[1].story_key).toBe('17-1')
  })

  it('computes correct average review cycles', () => {
    const stories = [
      makeStoryRow('17-1', { review_cycles: 2 }),
      makeStoryRow('17-2', { review_cycles: 4 }),
    ]
    const result = analyzeReviewCycles(stories, [])
    expect(result.avg_cycles).toBe(3) // (2+4)/2
  })

  it('returns null baseline averages when no baseline stories', () => {
    const stories = [makeStoryRow('17-1', { review_cycles: 3 })]
    const result = analyzeReviewCycles(stories, [])
    expect(result.avg_cycles_baseline).toBeNull()
    expect(result.delta_pct).toBeNull()
  })

  it('computes delta_pct against baseline', () => {
    const stories = [
      makeStoryRow('17-1', { review_cycles: 4 }),
      makeStoryRow('17-2', { review_cycles: 4 }),
    ]
    const baseline = [
      makeStoryRow('17-1', { run_id: 'baseline', review_cycles: 2 }),
      makeStoryRow('17-2', { run_id: 'baseline', review_cycles: 2 }),
    ]
    const result = analyzeReviewCycles(stories, baseline)
    expect(result.avg_cycles).toBe(4)
    expect(result.avg_cycles_baseline).toBe(2)
    expect(result.delta_pct).toBe(100) // +100%
  })

  it('returns null delta_pct when baseline avg is zero', () => {
    const stories = [makeStoryRow('17-1', { review_cycles: 3 })]
    const baseline = [makeStoryRow('17-1', { run_id: 'baseline', review_cycles: 0 })]
    const result = analyzeReviewCycles(stories, baseline)
    expect(result.delta_pct).toBeNull()
  })

  it('assigns phase code-review to high-cycle findings', () => {
    const stories = [makeStoryRow('17-1', { review_cycles: 4 })]
    const result = analyzeReviewCycles(stories, [])
    expect(result.high_cycle_stories[0].phase).toBe('code-review')
  })

  it('handles empty stories list', () => {
    const result = analyzeReviewCycles([], [])
    expect(result.high_cycle_stories).toHaveLength(0)
    expect(result.avg_cycles).toBe(0)
    expect(result.avg_cycles_baseline).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// AC4: analyzeTimings
// ---------------------------------------------------------------------------

describe('analyzeTimings', () => {
  it('returns null bottleneck_phase when no phase_durations_json data', () => {
    const stories = [makeStoryRow('17-1', { phase_durations_json: null })]
    const result = analyzeTimings(stories)
    expect(result.bottleneck_phase).toBeNull()
    expect(result.bottleneck_phase_seconds).toBe(0)
  })

  it('identifies bottleneck phase across all stories', () => {
    const phases1 = JSON.stringify({ 'create-story': 60, 'dev-story': 300, 'code-review': 60 })
    const phases2 = JSON.stringify({ 'create-story': 60, 'dev-story': 400, 'code-review': 40 })
    const stories = [
      makeStoryRow('17-1', { phase_durations_json: phases1 }),
      makeStoryRow('17-2', { phase_durations_json: phases2 }),
    ]
    const result = analyzeTimings(stories)
    expect(result.bottleneck_phase).toBe('dev-story') // 300+400 = 700 total
    expect(result.bottleneck_phase_seconds).toBe(700)
  })

  it('identifies stories where dominant phase > 50% of story time', () => {
    // dev-story: 800s out of 1000s = 80%
    const phases = JSON.stringify({ 'create-story': 100, 'dev-story': 800, 'code-review': 100 })
    const stories = [makeStoryRow('17-1', { phase_durations_json: phases })]
    const result = analyzeTimings(stories)
    expect(result.high_phase_concentration_stories).toHaveLength(1)
    expect(result.high_phase_concentration_stories[0].dominant_phase).toBe('dev-story')
    expect(result.high_phase_concentration_stories[0].dominant_phase_pct).toBe(80)
  })

  it('does not flag stories where dominant phase is exactly 50%', () => {
    const phases = JSON.stringify({ 'dev-story': 500, 'code-review': 500 })
    const stories = [makeStoryRow('17-1', { phase_durations_json: phases })]
    const result = analyzeTimings(stories)
    expect(result.high_phase_concentration_stories).toHaveLength(0)
  })

  it('computes effective concurrency from wall-clock data', () => {
    // story1: 3600s, story2: 3600s, story3: 3600s
    // sum = 10800, max = 3600, effective = 10800/3600 = 3.0
    const stories = [
      makeStoryRow('17-1', { wall_clock_seconds: 3600, phase_durations_json: null }),
      makeStoryRow('17-2', { wall_clock_seconds: 3600, phase_durations_json: null }),
      makeStoryRow('17-3', { wall_clock_seconds: 3600, phase_durations_json: null }),
    ]
    const result = analyzeTimings(stories)
    expect(result.effective_concurrency).toBe(3)
  })

  it('returns null effective_concurrency for empty stories', () => {
    const result = analyzeTimings([])
    expect(result.effective_concurrency).toBeNull()
  })

  it('returns configured_concurrency and concurrency_ratio when concurrencySetting is provided', () => {
    const stories = [
      makeStoryRow('17-1', { wall_clock_seconds: 3600, phase_durations_json: null }),
      makeStoryRow('17-2', { wall_clock_seconds: 3600, phase_durations_json: null }),
      makeStoryRow('17-3', { wall_clock_seconds: 3600, phase_durations_json: null }),
    ]
    const result = analyzeTimings(stories, 2)
    expect(result.configured_concurrency).toBe(2)
    expect(result.effective_concurrency).toBe(3)
    // concurrency_ratio = effective / configured = 3 / 2 = 1.5
    expect(result.concurrency_ratio).toBe(1.5)
  })

  it('returns null configured_concurrency and concurrency_ratio when concurrencySetting is omitted', () => {
    const stories = [makeStoryRow('17-1', { wall_clock_seconds: 3600, phase_durations_json: null })]
    const result = analyzeTimings(stories)
    expect(result.configured_concurrency).toBeNull()
    expect(result.concurrency_ratio).toBeNull()
  })

  it('computes bottleneck_phase_pct correctly', () => {
    // create-story: 100, dev-story: 400, code-review: 100 → total = 600
    // dev-story pct = 400/600 * 100 = 66.7%
    const phases = JSON.stringify({ 'create-story': 100, 'dev-story': 400, 'code-review': 100 })
    const stories = [makeStoryRow('17-1', { phase_durations_json: phases })]
    const result = analyzeTimings(stories)
    expect(result.bottleneck_phase).toBe('dev-story')
    expect(result.bottleneck_phase_pct).toBeCloseTo(66.7, 0)
  })

  it('handles malformed phase_durations_json gracefully', () => {
    const stories = [makeStoryRow('17-1', { phase_durations_json: '{not valid json}' })]
    const result = analyzeTimings(stories)
    expect(result.bottleneck_phase).toBeNull()
    expect(result.high_phase_concentration_stories).toHaveLength(0)
  })

  it('sorts high_phase_concentration_stories descending by pct', () => {
    const phases1 = JSON.stringify({ 'dev-story': 900, 'code-review': 100 }) // 90%
    const phases2 = JSON.stringify({ 'dev-story': 600, 'code-review': 400 }) // 60%
    const stories = [
      makeStoryRow('17-2', { phase_durations_json: phases2, wall_clock_seconds: 1000 }),
      makeStoryRow('17-1', { phase_durations_json: phases1, wall_clock_seconds: 1000 }),
    ]
    const result = analyzeTimings(stories)
    expect(result.high_phase_concentration_stories[0].story_key).toBe('17-1') // 90% first
    expect(result.high_phase_concentration_stories[1].story_key).toBe('17-2')
  })
})

// ---------------------------------------------------------------------------
// AC6: generateRecommendations
// ---------------------------------------------------------------------------

describe('generateRecommendations', () => {
  const emptyReviewCycles: ReviewCycleAnalysis = {
    high_cycle_stories: [],
    avg_cycles: 1,
    avg_cycles_baseline: 1,
    delta_pct: 0,
  }

  const emptyTiming: TimingAnalysis = {
    bottleneck_phase: null,
    bottleneck_phase_seconds: 0,
    bottleneck_phase_pct: 0,
    high_phase_concentration_stories: [],
    effective_concurrency: null,
    configured_concurrency: null,
    concurrency_ratio: null,
  }

  it('returns empty recommendations when no findings', () => {
    const result = generateRecommendations([], emptyReviewCycles, emptyTiming)
    expect(result).toHaveLength(0)
  })

  it('generates token_regression recommendations for each token finding', () => {
    const tokenFindings: TokenEfficiencyFinding[] = [
      {
        story_key: '17-1',
        phase: 'dev-story',
        tokens_actual: 10000,
        tokens_baseline: 5000,
        delta_pct: 100,
      },
    ]
    const result = generateRecommendations(tokenFindings, emptyReviewCycles, emptyTiming)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('token_regression')
    expect(result[0].story_key).toBe('17-1')
    expect(result[0].phase).toBe('dev-story')
    expect(result[0].delta_pct).toBe(100)
    expect(result[0].recommendation).toContain('17-1')
    expect(result[0].recommendation).toContain('100%')
  })

  it('generates review_cycles recommendations for high-cycle stories', () => {
    const reviewCycles: ReviewCycleAnalysis = {
      high_cycle_stories: [
        { story_key: '17-2', phase: 'code-review', review_cycles: 4, issue_patterns: [] },
      ],
      avg_cycles: 4,
      avg_cycles_baseline: 1,
      delta_pct: 300,
    }
    const result = generateRecommendations([], reviewCycles, emptyTiming)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('review_cycles')
    expect(result[0].story_key).toBe('17-2')
    expect(result[0].recommendation).toContain('17-2')
    expect(result[0].recommendation).toContain('4 times')
  })

  it('generates timing_bottleneck recommendation when bottleneck_phase_pct > 40%', () => {
    const timing: TimingAnalysis = {
      bottleneck_phase: 'dev-story',
      bottleneck_phase_seconds: 700,
      bottleneck_phase_pct: 70,
      high_phase_concentration_stories: [],
      effective_concurrency: 2,
      configured_concurrency: 2,
      concurrency_ratio: 1,
    }
    const result = generateRecommendations([], emptyReviewCycles, timing)
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe('timing_bottleneck')
    expect(result[0].phase).toBe('dev-story')
    expect(result[0].recommendation).toContain('dev-story')
    expect(result[0].recommendation).toContain('70%')
  })

  it('does not generate timing recommendation when bottleneck_phase_pct ≤ 40%', () => {
    const timing: TimingAnalysis = {
      bottleneck_phase: 'dev-story',
      bottleneck_phase_seconds: 200,
      bottleneck_phase_pct: 40,
      high_phase_concentration_stories: [],
      effective_concurrency: 2,
      configured_concurrency: 2,
      concurrency_ratio: 1,
    }
    const result = generateRecommendations([], emptyReviewCycles, timing)
    expect(result).toHaveLength(0)
  })

  it('combines all recommendation types', () => {
    const tokenFindings: TokenEfficiencyFinding[] = [
      {
        story_key: '17-1',
        phase: 'dev-story',
        tokens_actual: 10000,
        tokens_baseline: 5000,
        delta_pct: 100,
      },
    ]
    const reviewCycles: ReviewCycleAnalysis = {
      high_cycle_stories: [
        { story_key: '17-2', phase: 'code-review', review_cycles: 4, issue_patterns: [] },
      ],
      avg_cycles: 4,
      avg_cycles_baseline: 1,
      delta_pct: 300,
    }
    const timing: TimingAnalysis = {
      bottleneck_phase: 'dev-story',
      bottleneck_phase_seconds: 700,
      bottleneck_phase_pct: 70,
      high_phase_concentration_stories: [],
      effective_concurrency: 2,
      configured_concurrency: 2,
      concurrency_ratio: 1,
    }
    const result = generateRecommendations(tokenFindings, reviewCycles, timing)
    expect(result).toHaveLength(3)
    const types = result.map((r) => r.type)
    expect(types).toContain('token_regression')
    expect(types).toContain('review_cycles')
    expect(types).toContain('timing_bottleneck')
  })

  it('recommendation objects have machine-readable fields', () => {
    const tokenFindings: TokenEfficiencyFinding[] = [
      {
        story_key: '17-1',
        phase: 'dev-story',
        tokens_actual: 10000,
        tokens_baseline: 5000,
        delta_pct: 100,
      },
    ]
    const result = generateRecommendations(tokenFindings, emptyReviewCycles, emptyTiming)
    const rec = result[0] as AnalysisRecommendation
    expect(typeof rec.type).toBe('string')
    expect(typeof rec.recommendation).toBe('string')
    expect(typeof rec.actual).toBe('number')
    expect(typeof rec.baseline).toBe('number')
    expect(typeof rec.delta_pct).toBe('number')
  })
})

// ---------------------------------------------------------------------------
// AC5: generateAnalysisReport
// ---------------------------------------------------------------------------

describe('generateAnalysisReport', () => {
  const run = makeRunRow({
    total_input_tokens: 10000,
    total_output_tokens: 5000,
    wall_clock_seconds: 3600,
    stories_succeeded: 2,
    stories_failed: 0,
    stories_escalated: 1,
    total_review_cycles: 4,
  })

  const stories = [
    makeStoryRow('17-1', { review_cycles: 2, wall_clock_seconds: 1800 }),
    makeStoryRow('17-2', { review_cycles: 2, wall_clock_seconds: 1800 }),
  ]

  const baseline = makeRunRow({
    run_id: 'baseline-001',
    total_input_tokens: 8000,
    total_output_tokens: 4000,
    wall_clock_seconds: 3000,
    total_review_cycles: 2,
    is_baseline: 1,
  })

  const baselineStories = [
    makeStoryRow('17-1', {
      run_id: 'baseline-001',
      review_cycles: 1,
      input_tokens: 4000,
      output_tokens: 2000,
    }),
    makeStoryRow('17-2', {
      run_id: 'baseline-001',
      review_cycles: 1,
      input_tokens: 4000,
      output_tokens: 2000,
    }),
  ]

  it('returns a report with correct run_id', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.run_id).toBe('run-test-001')
  })

  it('sets generated_at to an ISO timestamp', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(new Date(report.generated_at).toISOString()).toBe(report.generated_at)
  })

  it('sets baseline_run_id from baseline row', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.baseline_run_id).toBe('baseline-001')
  })

  it('returns undefined baseline_run_id when no baseline', () => {
    const report = generateAnalysisReport(run, stories, undefined, [])
    expect(report.baseline_run_id).toBeUndefined()
  })

  it('computes correct summary totals', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.summary.total_tokens).toBe(15000) // 10000 + 5000
    expect(report.summary.total_tokens_baseline).toBe(12000) // 8000 + 4000
    expect(report.summary.wall_clock_seconds).toBe(3600)
    expect(report.summary.stories_succeeded).toBe(2)
    expect(report.summary.stories_failed).toBe(0)
    expect(report.summary.stories_escalated).toBe(1)
  })

  it('computes token_delta_pct correctly', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    // 15000 vs 12000 → +25%
    expect(report.summary.token_delta_pct).toBe(25)
  })

  it('returns null token_delta_pct when no baseline', () => {
    const report = generateAnalysisReport(run, stories, undefined, [])
    expect(report.summary.token_delta_pct).toBeNull()
  })

  it('includes findings with correct structure', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.findings).toHaveProperty('token_efficiency')
    expect(report.findings).toHaveProperty('review_cycles')
    expect(report.findings).toHaveProperty('timing')
    expect(report.findings).toHaveProperty('recommendations')
  })

  it('markdown contains run-id header', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.markdown).toContain('# Pipeline Run Analysis: run-test-001')
  })

  it('markdown contains Summary section', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.markdown).toContain('## Summary')
  })

  it('markdown contains Raw Data JSON block', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.markdown).toContain('## Raw Data')
    expect(report.markdown).toContain('```json')
  })

  it('markdown contains baseline run-id', () => {
    const report = generateAnalysisReport(run, stories, baseline, baselineStories)
    expect(report.markdown).toContain('baseline-001')
  })

  it('markdown shows "Baseline: none" when no baseline', () => {
    const report = generateAnalysisReport(run, stories, undefined, [])
    expect(report.markdown).toContain('Baseline: none')
  })

  it('markdown contains Regressions section when token regressions exist', () => {
    // Modify stories to trigger token regression
    const highTokenStories = [
      makeStoryRow('17-1', { input_tokens: 10000, output_tokens: 5000, review_cycles: 1 }),
    ]
    const lowBaselineStories = [
      makeStoryRow('17-1', {
        run_id: 'baseline-001',
        input_tokens: 3000,
        output_tokens: 1000,
        review_cycles: 1,
      }),
    ]
    const report = generateAnalysisReport(run, highTokenStories, baseline, lowBaselineStories)
    expect(report.markdown).toContain('## Regressions')
    expect(report.markdown).toContain('Token Regressions')
  })

  it('markdown contains Recommendations section when recs exist', () => {
    const highCycleStories = [makeStoryRow('17-1', { review_cycles: 5, wall_clock_seconds: 1800 })]
    const report = generateAnalysisReport(run, highCycleStories, undefined, [])
    expect(report.markdown).toContain('## Recommendations')
  })

  it('avg_review_cycles is computed from stories', () => {
    const testStories = [
      makeStoryRow('17-1', { review_cycles: 2 }),
      makeStoryRow('17-2', { review_cycles: 4 }),
    ]
    const report = generateAnalysisReport(run, testStories, undefined, [])
    expect(report.summary.avg_review_cycles).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// writeAnalysisReport (AC5: file I/O)
// ---------------------------------------------------------------------------

describe('writeAnalysisReport', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-analysis-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeReport(): AnalysisReport {
    const run = makeRunRow()
    const stories = [makeStoryRow('17-1', { review_cycles: 1 })]
    return generateAnalysisReport(run, stories, undefined, [])
  }

  it('writes markdown file to the correct path', () => {
    const report = makeReport()
    const { mdPath } = writeAnalysisReport(report, tmpDir)
    expect(fs.existsSync(mdPath)).toBe(true)
    expect(mdPath).toContain('run-test-001-analysis.md')
  })

  it('writes JSON file to the correct path', () => {
    const report = makeReport()
    const { jsonPath } = writeAnalysisReport(report, tmpDir)
    expect(fs.existsSync(jsonPath)).toBe(true)
    expect(jsonPath).toContain('run-test-001-analysis.json')
  })

  it('creates the supervisor-reports directory if it does not exist', () => {
    const report = makeReport()
    const { mdPath } = writeAnalysisReport(report, tmpDir)
    const dir = path.dirname(mdPath)
    expect(fs.existsSync(dir)).toBe(true)
    expect(dir).toContain('supervisor-reports')
  })

  it('markdown file content matches report.markdown', () => {
    const report = makeReport()
    const { mdPath } = writeAnalysisReport(report, tmpDir)
    const content = fs.readFileSync(mdPath, 'utf8')
    expect(content).toBe(report.markdown)
  })

  it('JSON file is valid JSON with run_id, summary, baseline_run_id, and findings fields', () => {
    const report = makeReport()
    const { jsonPath } = writeAnalysisReport(report, tmpDir)
    const content = fs.readFileSync(jsonPath, 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.run_id).toBe('run-test-001')
    expect(parsed.findings).toBeDefined()
    expect(parsed.generated_at).toBeDefined()
    // AC5: JSON output includes summary stats and baseline_run_id
    expect(parsed.summary).toBeDefined()
    expect(parsed.summary.total_tokens).toBe(report.summary.total_tokens)
    expect(parsed).toHaveProperty('baseline_run_id')
  })

  it('creates files under _bmad-output/supervisor-reports/', () => {
    const report = makeReport()
    const { mdPath, jsonPath } = writeAnalysisReport(report, tmpDir)
    const expectedSubdir = path.join(tmpDir, '_bmad-output', 'supervisor-reports')
    expect(mdPath.startsWith(expectedSubdir)).toBe(true)
    expect(jsonPath.startsWith(expectedSubdir)).toBe(true)
  })
})
