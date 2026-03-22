/**
 * Supervisor Analysis Engine — migrated to @substrate-ai/core (Story 41-7)
 *
 * Pure analysis functions that compare completed pipeline runs against baselines
 * and produce actionable optimization recommendations.
 *
 * Architecture:
 *   - All functions are pure: no DB access, no file I/O, no side effects
 *   - Callers inject pre-fetched RunMetricsRow / StoryMetricsRow data
 *   - generateAnalysisReport() produces both markdown and JSON output
 *   - writeAnalysisReport() handles file I/O (separate from pure functions)
 *
 * Note: analyzeReviewCycles, ReviewCycleFinding, and ReviewCycleAnalysis are
 * SDLC-specific (story-phase semantics) and remain in the monolith at
 * src/modules/supervisor/review-cycle-analysis.ts.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import type { RunMetricsRow, StoryMetricsRow } from '../persistence/queries/metrics.js'

// ---------------------------------------------------------------------------
// Phase duration types
// ---------------------------------------------------------------------------

/**
 * Per-phase wall-clock duration map stored in story_metrics.phase_durations_json.
 * Keys are phase names; values are duration in seconds.
 */
export interface PhaseDurations {
  'create-story'?: number
  'dev-story'?: number
  'code-review'?: number
  fix?: number
  [key: string]: number | undefined
}

// ---------------------------------------------------------------------------
// Finding types
// ---------------------------------------------------------------------------

/**
 * A single token-efficiency finding for a story.
 */
export interface TokenEfficiencyFinding {
  story_key: string
  /** Phase / aggregate level. 'total' when no per-phase breakdown is available. */
  phase: string
  tokens_actual: number
  tokens_baseline: number
  /** Positive = current run used more tokens than baseline. */
  delta_pct: number
}

/**
 * A per-story timing finding: story where one phase dominated wall clock.
 */
export interface TimingFinding {
  story_key: string
  dominant_phase: string
  dominant_phase_seconds: number
  total_seconds: number
  /** Percentage of total story time used by the dominant phase. */
  dominant_phase_pct: number
}

/**
 * Aggregate timing analysis across all stories in a run.
 */
export interface TimingAnalysis {
  /** Phase with the highest total wall-clock contribution across all stories. */
  bottleneck_phase: string | null
  bottleneck_phase_seconds: number
  /** Fraction (0–100) of total wall-clock accounted for by the bottleneck phase. */
  bottleneck_phase_pct: number
  /** Stories where one phase consumed >50% of their total wall-clock time. */
  high_phase_concentration_stories: TimingFinding[]
  /**
   * Computed effective concurrency = stories / (total_wall_clock / max_story_wall_clock).
   * null when data is insufficient.
   */
  effective_concurrency: number | null
  /** Configured concurrency from run_metrics (null when not provided). */
  configured_concurrency: number | null
  /**
   * Ratio of effective to configured concurrency (effective / configured).
   * Values < 1 mean under-utilization; > 1 means more parallelism than configured.
   * null when either value is unavailable.
   */
  concurrency_ratio: number | null
}

// ---------------------------------------------------------------------------
// Recommendation types
// ---------------------------------------------------------------------------

export type RecommendationType = 'token_regression' | 'review_cycles' | 'timing_bottleneck'

/**
 * A machine-readable recommendation produced from analysis findings.
 */
export interface AnalysisRecommendation {
  type: RecommendationType
  story_key?: string
  phase?: string
  metric?: string
  actual?: number
  baseline?: number
  delta_pct?: number
  recommendation: string
}

// ---------------------------------------------------------------------------
// Top-level report types
// ---------------------------------------------------------------------------

export interface AnalysisSummary {
  total_tokens: number
  total_tokens_baseline: number | null
  token_delta_pct: number | null
  wall_clock_seconds: number
  wall_clock_baseline: number | null
  wall_clock_delta_pct: number | null
  stories_succeeded: number
  stories_failed: number
  stories_escalated: number
  avg_review_cycles: number
  avg_review_cycles_baseline: number | null
  review_cycles_delta_pct: number | null
}

export interface AnalysisFindings {
  token_efficiency: TokenEfficiencyFinding[]
  /** Review-cycle aggregate data. Populated inline; SDLC-typed variant lives in monolith. */
  review_cycles: {
    high_cycle_stories: Array<{
      story_key: string
      phase: string
      review_cycles: number
      issue_patterns: string[]
    }>
    avg_cycles: number
    avg_cycles_baseline: number | null
    delta_pct: number | null
  }
  timing: TimingAnalysis
  recommendations: AnalysisRecommendation[]
}

export interface AnalysisReport {
  run_id: string
  generated_at: string
  baseline_run_id: string | undefined
  summary: AnalysisSummary
  findings: AnalysisFindings
  /** Markdown-formatted report text. */
  markdown: string
}

// ---------------------------------------------------------------------------
// Token Efficiency Analysis
// ---------------------------------------------------------------------------

/**
 * Analyse token usage for each story in the current run, comparing against
 * the corresponding story in the baseline run.
 *
 * Returns findings only for stories where total tokens exceeded the baseline
 * by more than 20%.
 */
export function analyzeTokenEfficiency(
  stories: StoryMetricsRow[],
  baselineStories: StoryMetricsRow[],
): TokenEfficiencyFinding[] {
  const baselineMap = new Map<string, StoryMetricsRow>()
  for (const bs of baselineStories) {
    baselineMap.set(bs.story_key, bs)
  }

  const findings: TokenEfficiencyFinding[] = []

  for (const story of stories) {
    const baseline = baselineMap.get(story.story_key)
    if (!baseline) continue

    const actual = (story.input_tokens ?? 0) + (story.output_tokens ?? 0)
    const base = (baseline.input_tokens ?? 0) + (baseline.output_tokens ?? 0)

    if (base === 0) continue // can't compute a meaningful delta

    const delta_pct = Math.round(((actual - base) / base) * 100 * 10) / 10

    if (delta_pct > 20) {
      findings.push({
        story_key: story.story_key,
        phase: 'total',
        tokens_actual: actual,
        tokens_baseline: base,
        delta_pct,
      })
    }
  }

  // Sort descending by delta_pct so worst offenders appear first
  findings.sort((a, b) => b.delta_pct - a.delta_pct)
  return findings
}

// ---------------------------------------------------------------------------
// Timing Analysis
// ---------------------------------------------------------------------------

/**
 * Analyse phase timing across all stories to identify:
 *   1. The bottleneck phase (highest total wall-clock contribution).
 *   2. Stories where a single phase used >50% of their total wall-clock.
 *   3. Effective concurrency estimate.
 */
export function analyzeTimings(
  stories: StoryMetricsRow[],
  concurrencySetting?: number,
): TimingAnalysis {
  const phaseTotal: Record<string, number> = {}
  const highConcentrationStories: TimingFinding[] = []
  let totalWallClock = 0
  let maxStoryWallClock = 0

  for (const story of stories) {
    const storySeconds = story.wall_clock_seconds ?? 0
    totalWallClock += storySeconds
    if (storySeconds > maxStoryWallClock) maxStoryWallClock = storySeconds

    const phases = parsePhaseDurations(story.phase_durations_json ?? null)
    if (!phases) continue

    let storyPhaseTotal = 0
    for (const [phase, dur] of Object.entries(phases)) {
      const d = dur ?? 0
      phaseTotal[phase] = (phaseTotal[phase] ?? 0) + d
      storyPhaseTotal += d
    }

    if (storyPhaseTotal === 0) continue

    // Find the dominant phase for this story
    let dominantPhase = ''
    let dominantSeconds = 0
    for (const [phase, dur] of Object.entries(phases)) {
      const d = dur ?? 0
      if (d > dominantSeconds) {
        dominantSeconds = d
        dominantPhase = phase
      }
    }

    const dominantPct = Math.round((dominantSeconds / storyPhaseTotal) * 100 * 10) / 10
    if (dominantPct > 50) {
      highConcentrationStories.push({
        story_key: story.story_key,
        dominant_phase: dominantPhase,
        dominant_phase_seconds: dominantSeconds,
        total_seconds: storyPhaseTotal,
        dominant_phase_pct: dominantPct,
      })
    }
  }

  // Sort by dominant_phase_pct descending
  highConcentrationStories.sort((a, b) => b.dominant_phase_pct - a.dominant_phase_pct)

  // Find global bottleneck phase
  let bottleneckPhase: string | null = null
  let bottleneckSeconds = 0

  for (const [phase, total] of Object.entries(phaseTotal)) {
    if (total > bottleneckSeconds) {
      bottleneckSeconds = total
      bottleneckPhase = phase
    }
  }

  const totalPhaseTime = Object.values(phaseTotal).reduce((s, v) => s + (v ?? 0), 0)
  const bottleneckPct =
    totalPhaseTime > 0
      ? Math.round((bottleneckSeconds / totalPhaseTime) * 100 * 10) / 10
      : 0

  // Effective concurrency = (sum of story wall-clocks) / (total elapsed)
  let effective_concurrency: number | null = null
  if (maxStoryWallClock > 0 && stories.length > 0) {
    effective_concurrency = Math.round((totalWallClock / maxStoryWallClock) * 10) / 10
  }

  const configured_concurrency = concurrencySetting ?? null
  const concurrency_ratio =
    effective_concurrency !== null && configured_concurrency !== null && configured_concurrency > 0
      ? Math.round((effective_concurrency / configured_concurrency) * 100) / 100
      : null

  return {
    bottleneck_phase: bottleneckPhase,
    bottleneck_phase_seconds: bottleneckSeconds,
    bottleneck_phase_pct: bottleneckPct,
    high_phase_concentration_stories: highConcentrationStories,
    effective_concurrency,
    configured_concurrency,
    concurrency_ratio,
  }
}

// ---------------------------------------------------------------------------
// Recommendation Generation
// ---------------------------------------------------------------------------

/**
 * Generate machine-readable recommendations from analysis findings.
 */
export function generateRecommendations(
  tokenFindings: TokenEfficiencyFinding[],
  reviewCycles: {
    high_cycle_stories: Array<{ story_key: string; phase: string; review_cycles: number }>
    avg_cycles: number
    avg_cycles_baseline: number | null
    delta_pct: number | null
  },
  timing: TimingAnalysis,
): AnalysisRecommendation[] {
  const recs: AnalysisRecommendation[] = []

  // Token regression recommendations
  for (const f of tokenFindings) {
    recs.push({
      type: 'token_regression',
      story_key: f.story_key,
      phase: f.phase,
      metric: 'tokens',
      actual: f.tokens_actual,
      baseline: f.tokens_baseline,
      delta_pct: f.delta_pct,
      recommendation: `Prompt in ${f.phase} phase for story ${f.story_key} is ${f.delta_pct}% over baseline — consider compressing context injection`,
    })
  }

  // Review cycle recommendations
  for (const f of reviewCycles.high_cycle_stories) {
    recs.push({
      type: 'review_cycles',
      story_key: f.story_key,
      phase: f.phase,
      metric: 'review_cycles',
      actual: f.review_cycles,
      recommendation: `Story ${f.story_key} failed code review ${f.review_cycles} times — review prompt quality or acceptance criteria clarity`,
    })
  }

  // Timing bottleneck recommendation
  if (timing.bottleneck_phase !== null && timing.bottleneck_phase_pct > 40) {
    recs.push({
      type: 'timing_bottleneck',
      phase: timing.bottleneck_phase,
      metric: 'wall_clock',
      actual: timing.bottleneck_phase_seconds,
      delta_pct: timing.bottleneck_phase_pct,
      recommendation: `Phase ${timing.bottleneck_phase} accounts for ${timing.bottleneck_phase_pct}% of wall clock — consider increasing concurrency or splitting work`,
    })
  }

  return recs
}

// ---------------------------------------------------------------------------
// Report Generation
// ---------------------------------------------------------------------------

/**
 * Run a full analysis on a completed pipeline run and produce a structured report.
 *
 * Note: review_cycles.high_cycle_stories will be empty because analyzeReviewCycles
 * is SDLC-specific and is not in core. Use analyzeReviewCycles from the monolith
 * (src/modules/supervisor/review-cycle-analysis.ts) for the full review cycle analysis.
 */
export function generateAnalysisReport(
  run: RunMetricsRow,
  stories: StoryMetricsRow[],
  baseline: RunMetricsRow | undefined,
  baselineStories: StoryMetricsRow[],
): AnalysisReport {
  const generated_at = new Date().toISOString()

  // --- Summary ---
  const total_tokens = (run.total_input_tokens ?? 0) + (run.total_output_tokens ?? 0)
  const total_tokens_baseline =
    baseline !== undefined
      ? (baseline.total_input_tokens ?? 0) + (baseline.total_output_tokens ?? 0)
      : null
  const token_delta_pct =
    total_tokens_baseline !== null && total_tokens_baseline > 0
      ? Math.round(((total_tokens - total_tokens_baseline) / total_tokens_baseline) * 100 * 10) / 10
      : null

  const wall_clock_seconds = run.wall_clock_seconds ?? 0
  const wall_clock_baseline = baseline?.wall_clock_seconds ?? null
  const wall_clock_delta_pct =
    wall_clock_baseline !== null && wall_clock_baseline > 0
      ? Math.round(
          ((wall_clock_seconds - wall_clock_baseline) / wall_clock_baseline) * 100 * 10,
        ) / 10
      : null

  const avg_review_cycles = computeAvg(stories.map(s => s.review_cycles ?? 0))
  const avg_review_cycles_baseline =
    baselineStories.length > 0
      ? computeAvg(baselineStories.map(s => s.review_cycles ?? 0))
      : null
  const review_cycles_delta_pct =
    avg_review_cycles_baseline !== null && avg_review_cycles_baseline > 0
      ? Math.round(
          ((avg_review_cycles - avg_review_cycles_baseline) / avg_review_cycles_baseline) *
            100 *
            10,
        ) / 10
      : null

  const summary: AnalysisSummary = {
    total_tokens,
    total_tokens_baseline,
    token_delta_pct,
    wall_clock_seconds,
    wall_clock_baseline,
    wall_clock_delta_pct,
    stories_succeeded: run.stories_succeeded ?? 0,
    stories_failed: run.stories_failed ?? 0,
    stories_escalated: run.stories_escalated ?? 0,
    avg_review_cycles,
    avg_review_cycles_baseline,
    review_cycles_delta_pct,
  }

  // --- Analysis ---
  const token_efficiency = analyzeTokenEfficiency(stories, baselineStories)

  // Build review_cycles analysis inline.
  // high_cycle_stories: detect stories with >2 cycles using a generic threshold.
  // analyzeReviewCycles (in the monolith) adds SDLC-specific issue_patterns extraction;
  // here we produce a structurally correct result with empty issue_patterns.
  const highCycleStories = stories
    .filter(s => (s.review_cycles ?? 0) > 2)
    .sort((a, b) => (b.review_cycles ?? 0) - (a.review_cycles ?? 0))
    .map(s => ({
      story_key: s.story_key,
      phase: 'code-review',
      review_cycles: s.review_cycles ?? 0,
      issue_patterns: [],
    }))

  const review_cycles = {
    high_cycle_stories: highCycleStories,
    avg_cycles: avg_review_cycles,
    avg_cycles_baseline: avg_review_cycles_baseline,
    delta_pct: review_cycles_delta_pct,
  }

  const timing = analyzeTimings(stories, run.concurrency_setting)
  const recommendations = generateRecommendations(token_efficiency, review_cycles, timing)

  const findings: AnalysisFindings = {
    token_efficiency,
    review_cycles,
    timing,
    recommendations,
  }

  // --- Markdown ---
  const markdown = buildMarkdownReport(run.run_id, generated_at, baseline?.run_id, summary, findings)

  return {
    run_id: run.run_id,
    generated_at,
    baseline_run_id: baseline?.run_id,
    summary,
    findings,
    markdown,
  }
}

/**
 * Write the analysis report to the filesystem.
 *
 * Writes:
 *   - `<projectRoot>/_bmad-output/supervisor-reports/<run-id>-analysis.md`
 *   - `<projectRoot>/_bmad-output/supervisor-reports/<run-id>-analysis.json`
 */
export function writeAnalysisReport(
  report: AnalysisReport,
  projectRoot: string,
): { mdPath: string; jsonPath: string } {
  const dir = path.join(projectRoot, '_bmad-output', 'supervisor-reports')
  fs.mkdirSync(dir, { recursive: true })

  const mdPath = path.join(dir, `${report.run_id}-analysis.md`)
  const jsonPath = path.join(dir, `${report.run_id}-analysis.json`)

  fs.writeFileSync(mdPath, report.markdown, 'utf8')
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        run_id: report.run_id,
        generated_at: report.generated_at,
        baseline_run_id: report.baseline_run_id ?? null,
        summary: report.summary,
        findings: report.findings,
      },
      null,
      2,
    ),
    'utf8',
  )

  return { mdPath, jsonPath }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function parsePhaseDurations(json: string | null): PhaseDurations | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as PhaseDurations
    }
    return null
  } catch {
    return null
  }
}

function computeAvg(values: number[]): number {
  if (values.length === 0) return 0
  const sum = values.reduce((a, b) => a + b, 0)
  return Math.round((sum / values.length) * 100) / 100
}

// ---------------------------------------------------------------------------
// Markdown report builder
// ---------------------------------------------------------------------------

function buildMarkdownReport(
  runId: string,
  generatedAt: string,
  baselineRunId: string | undefined,
  summary: AnalysisSummary,
  findings: AnalysisFindings,
): string {
  const lines: string[] = []

  lines.push(`# Pipeline Run Analysis: ${runId}`)
  lines.push(`Generated: ${generatedAt}`)
  if (baselineRunId) {
    lines.push(`Baseline: ${baselineRunId}`)
  } else {
    lines.push('Baseline: none')
  }
  lines.push('')

  // Summary
  lines.push('## Summary')
  const tokenDeltaStr =
    summary.token_delta_pct !== null ? `, delta: ${fmtPct(summary.token_delta_pct)}` : ''
  const baselineTokenStr =
    summary.total_tokens_baseline !== null ? ` (baseline: ${summary.total_tokens_baseline}${tokenDeltaStr})` : ''
  lines.push(`- Total tokens: ${summary.total_tokens}${baselineTokenStr}`)

  const clockMin = (summary.wall_clock_seconds / 60).toFixed(1)
  const baselineClockStr =
    summary.wall_clock_baseline !== null
      ? ` (baseline: ${(summary.wall_clock_baseline / 60).toFixed(1)}m${summary.wall_clock_delta_pct !== null ? `, delta: ${fmtPct(summary.wall_clock_delta_pct)}` : ''})`
      : ''
  lines.push(`- Wall clock: ${clockMin}m${baselineClockStr}`)
  lines.push(
    `- Stories: ${summary.stories_succeeded} succeeded, ${summary.stories_failed} failed, ${summary.stories_escalated} escalated`,
  )
  const baselineCycleStr =
    summary.avg_review_cycles_baseline !== null
      ? ` (baseline: ${summary.avg_review_cycles_baseline}${summary.review_cycles_delta_pct !== null ? `, delta: ${fmtPct(summary.review_cycles_delta_pct)}` : ''})`
      : ''
  lines.push(`- Avg review cycles: ${summary.avg_review_cycles}${baselineCycleStr}`)
  lines.push('')

  // Regressions
  if (findings.token_efficiency.length > 0 || findings.review_cycles.high_cycle_stories.length > 0) {
    lines.push('## Regressions')

    if (findings.token_efficiency.length > 0) {
      lines.push('')
      lines.push('### Token Regressions (>20% above baseline)')
      lines.push('| Story | Phase | Actual | Baseline | Delta |')
      lines.push('|-------|-------|--------|----------|-------|')
      for (const f of findings.token_efficiency) {
        lines.push(
          `| ${f.story_key} | ${f.phase} | ${f.tokens_actual} | ${f.tokens_baseline} | ${fmtPct(f.delta_pct)} |`,
        )
      }
    }

    if (findings.review_cycles.high_cycle_stories.length > 0) {
      lines.push('')
      lines.push('### Review Cycle Regressions (>2 cycles)')
      lines.push('| Story | Phase | Cycles |')
      lines.push('|-------|-------|--------|')
      for (const f of findings.review_cycles.high_cycle_stories) {
        lines.push(`| ${f.story_key} | ${f.phase} | ${f.review_cycles} |`)
      }
    }

    lines.push('')
  }

  // Timing
  if (findings.timing.bottleneck_phase !== null || findings.timing.high_phase_concentration_stories.length > 0) {
    lines.push('## Timing Analysis')

    if (findings.timing.bottleneck_phase !== null) {
      lines.push(
        `- Bottleneck phase: **${findings.timing.bottleneck_phase}** (${findings.timing.bottleneck_phase_seconds.toFixed(1)}s, ${findings.timing.bottleneck_phase_pct}% of total phase time)`,
      )
    }
    if (findings.timing.effective_concurrency !== null) {
      const configuredStr =
        findings.timing.configured_concurrency !== null
          ? ` (configured: ${findings.timing.configured_concurrency}, ratio: ${findings.timing.concurrency_ratio ?? 'N/A'})`
          : ''
      lines.push(`- Effective concurrency: ${findings.timing.effective_concurrency}x${configuredStr}`)
    }

    if (findings.timing.high_phase_concentration_stories.length > 0) {
      lines.push('')
      lines.push('### High Phase Concentration Stories (>50% in one phase)')
      lines.push('| Story | Dominant Phase | Phase Time | Total Time | % |')
      lines.push('|-------|---------------|------------|------------|---|')
      for (const f of findings.timing.high_phase_concentration_stories) {
        lines.push(
          `| ${f.story_key} | ${f.dominant_phase} | ${f.dominant_phase_seconds.toFixed(1)}s | ${f.total_seconds.toFixed(1)}s | ${f.dominant_phase_pct}% |`,
        )
      }
    }

    lines.push('')
  }

  // Recommendations
  if (findings.recommendations.length > 0) {
    lines.push('## Recommendations')
    lines.push('')
    for (let i = 0; i < findings.recommendations.length; i++) {
      const r = findings.recommendations[i]
      const label = r?.story_key ? `${r.type} in ${r.story_key}` : r?.type ?? ''
      lines.push(`${i + 1}. **${label}**: ${r?.recommendation ?? ''}`)
    }
    lines.push('')
  }

  // Raw Data
  lines.push('## Raw Data')
  lines.push('')
  lines.push('```json')
  lines.push(
    JSON.stringify(
      { summary, findings: { token_efficiency: findings.token_efficiency, review_cycles: findings.review_cycles, timing: findings.timing } },
      null,
      2,
    ),
  )
  lines.push('```')
  lines.push('')

  return lines.join('\n')
}

function fmtPct(pct: number): string {
  return pct >= 0 ? `+${pct}%` : `${pct}%`
}
