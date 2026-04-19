# Story 17.3: Supervisor Analysis Engine

Status: review
Blocked-by: 17-2

## Story

As a pipeline operator,
I want the supervisor to analyze completed runs against historical baselines and produce actionable optimization recommendations,
so that the pipeline improves over time without manual analysis.

## Context

Story 17-1 gives us a watchdog that detects stalls and restarts. Story 17-2 gives us structured metrics. This story connects them: the supervisor becomes an analyst that reads metrics, identifies patterns, and writes findings.

This is where the supervisor transitions from "keep it alive" to "make it better." The analysis runs after each pipeline completion and compares against baselines to surface regressions and opportunities.

## Acceptance Criteria

### AC1: Post-Run Analysis Trigger
**Given** the supervisor (17-1) is running
**When** a pipeline run reaches a terminal state
**Then** the supervisor automatically triggers a post-run analysis
**And** the analysis reads `run_metrics` and `story_metrics` for the completed run and the baseline

### AC2: Token Efficiency Analysis
**Given** a completed run's metrics and a baseline exist
**When** the analysis runs
**Then** it identifies stories where token usage exceeded the baseline by >20%
**And** it identifies which phases consumed the most tokens (create-story, dev-story, code-review, fix)
**And** findings are structured as: `{story_key, phase, tokens_actual, tokens_baseline, delta_pct}`

### AC3: Review Cycle Analysis
**Given** a completed run's per-story metrics
**When** the analysis runs
**Then** it identifies stories that required >2 review cycles
**And** for each, it notes the phase and common issue patterns (if available from decision store)
**And** it computes average review cycles per story vs baseline

### AC4: Timing Analysis
**Given** phase duration data from story_metrics
**When** the analysis runs
**Then** it identifies bottleneck phases (longest wall-clock contribution)
**And** it flags stories where a single phase took >50% of total story time
**And** it computes effective concurrency vs configured concurrency

### AC5: Findings Output
**Given** the analysis produces findings
**When** findings are ready
**Then** they are written to `_bmad-output/supervisor-reports/<run-id>-analysis.md` as a structured report
**And** they are also available via `substrate auto metrics --analysis <run-id> --output-format json`
**And** the report includes: summary stats, regressions, recommendations, and raw data tables

### AC6: Recommendation Generation
**Given** analysis findings
**When** the report is generated
**Then** each finding includes a concrete recommendation:
  - Token regression → "Prompt X in phase Y is N% over baseline — consider compressing context injection"
  - Excessive review cycles → "Story Z failed code review N times — review prompt quality or acceptance criteria clarity"
  - Timing bottleneck → "Phase P accounts for N% of wall clock — consider increasing concurrency or splitting work"
**And** recommendations are machine-readable (structured JSON) so a Tier 3 agent can act on them

### AC7: Existing Tests Pass
**Given** the analysis engine is implemented
**When** the full test suite runs
**Then** all existing tests pass and coverage thresholds are maintained

## Dev Notes

### Architecture

- Analysis logic lives in `src/modules/supervisor/analysis.ts` (new module)
- Pure functions: `analyzeTokenEfficiency(run, baseline)`, `analyzeReviewCycles(stories)`, `analyzeTimings(stories)`
- Report writer: markdown + JSON output
- Supervisor hooks into analysis after detecting terminal state (extends 17-1 polling loop)
- Recommendations are typed: `{type: 'token_regression'|'review_cycles'|'timing_bottleneck', ...details, recommendation: string}`

### Report Format

```markdown
# Pipeline Run Analysis: <run-id>
Generated: <timestamp>
Baseline: <baseline-run-id>

## Summary
- Total tokens: X (baseline: Y, delta: +Z%)
- Wall clock: Xm (baseline: Ym)
- Stories: N succeeded, M failed, K escalated
- Avg review cycles: X.Y (baseline: A.B)

## Regressions
| Story | Phase | Metric | Actual | Baseline | Delta |
|-------|-------|--------|--------|----------|-------|
| 7-1   | dev   | tokens | 8200   | 5100     | +61%  |

## Recommendations
1. **Token regression in 7-1/dev**: Input tokens 61% over baseline...
2. **Review cycle spike in 7-3**: 4 cycles vs baseline avg of 1.5...

## Raw Data
[JSON block with full metrics]
```

## Tasks

- [x] Create `src/modules/supervisor/analysis.ts` with analysis functions (AC2, AC3, AC4)
- [x] Implement token efficiency analysis with baseline comparison (AC2)
- [x] Implement review cycle analysis (AC3)
- [x] Implement timing/bottleneck analysis (AC4)
- [x] Implement report writer (markdown + JSON) (AC5)
- [x] Implement recommendation generation with machine-readable format (AC6)
- [x] Hook analysis into supervisor's terminal-state handler (AC1)
- [x] Add `--analysis` flag to `auto metrics` command (AC5)
- [x] Write unit tests for each analysis function
- [x] Write unit tests for report generation
- [x] Verify full test suite passes (AC7)
