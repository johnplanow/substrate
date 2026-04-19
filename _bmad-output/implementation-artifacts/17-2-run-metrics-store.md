# Story 17.2: Run Metrics Aggregation and Historical Comparison

Status: review
Blocked-by: 17-1

## Story

As a pipeline operator or supervisor agent,
I want pipeline runs to persist structured performance metrics and expose them for cross-run comparison,
so that I can identify regressions, track improvements, and establish baselines for optimization.

## Context

Currently, `token_usage_json` stores per-run story state, and `addTokenUsage` / `getTokenUsageSummary` track raw token counts. But there's no structured way to compare Run A vs Run B: which prompts were more efficient? Which stories took more review cycles? How did concurrency affect wall-clock time?

The supervisor agent (17-1) needs this data to graduate from "watchdog" to "analyst." Without run-over-run metrics, it can detect stalls but can't identify systemic inefficiencies.

## Acceptance Criteria

### AC1: Run Metrics Table
**Given** a pipeline run completes (any terminal status)
**When** the orchestrator reaches its terminal state
**Then** a `run_metrics` row is written to the DB with:
  - `run_id`, `methodology`, `status`, `started_at`, `completed_at`
  - `wall_clock_seconds` (total elapsed time)
  - `total_input_tokens`, `total_output_tokens`, `total_cost_usd`
  - `stories_attempted`, `stories_succeeded`, `stories_failed`, `stories_escalated`
  - `total_review_cycles`, `total_dispatches`
  - `concurrency_setting`, `max_concurrent_actual`
  - `restarts` (number of supervisor restarts, 0 if none)

### AC2: Per-Story Metrics
**Given** a story reaches a terminal state (success, failed, escalated)
**When** the story completes
**Then** a `story_metrics` row is written with:
  - `run_id`, `story_key`, `result` (success|failed|escalated)
  - `phase_durations_json` (object mapping phase → seconds: `{"create-story": 45, "dev-story": 120, ...}`)
  - `review_cycles`, `input_tokens`, `output_tokens`, `cost_usd`
  - `dispatches` (number of sub-agent dispatches for this story)

### AC3: Metrics Query Command
**Given** historical run metrics exist
**When** the user runs `substrate auto metrics`
**Then** the output shows the last N runs (default: 10) with key metrics
**And** supports `--output-format json` for programmatic consumption
**And** supports `--compare <run-id-a> <run-id-b>` for side-by-side diff
**And** the comparison highlights: token delta, time delta, review cycle delta

### AC4: Baseline Tagging
**Given** the user identifies a "good" run
**When** they run `substrate auto metrics --tag-baseline <run-id>`
**Then** that run is marked as the baseline in the DB
**And** subsequent `substrate auto metrics` output shows deltas vs baseline
**And** the supervisor agent can query the baseline for comparison

### AC5: Metrics Available to Supervisor
**Given** the supervisor (17-1) is running
**When** a pipeline run completes
**Then** the supervisor can query `run_metrics` and `story_metrics` via the existing DB
**And** it can compute: "this run used X% more tokens than baseline" or "story Y took Z more review cycles than average"

### AC6: Existing Tests Pass
**Given** the metrics store is implemented
**When** the full test suite runs
**Then** all existing tests pass and coverage thresholds are maintained

## Dev Notes

### Schema

```sql
CREATE TABLE run_metrics (
  run_id TEXT PRIMARY KEY REFERENCES pipeline_runs(id),
  methodology TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  wall_clock_seconds REAL,
  total_input_tokens INTEGER DEFAULT 0,
  total_output_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  stories_attempted INTEGER DEFAULT 0,
  stories_succeeded INTEGER DEFAULT 0,
  stories_failed INTEGER DEFAULT 0,
  stories_escalated INTEGER DEFAULT 0,
  total_review_cycles INTEGER DEFAULT 0,
  total_dispatches INTEGER DEFAULT 0,
  concurrency_setting INTEGER,
  max_concurrent_actual INTEGER,
  restarts INTEGER DEFAULT 0,
  is_baseline INTEGER DEFAULT 0
);

CREATE TABLE story_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES pipeline_runs(id),
  story_key TEXT NOT NULL,
  result TEXT NOT NULL,
  phase_durations_json TEXT,
  review_cycles INTEGER DEFAULT 0,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  dispatches INTEGER DEFAULT 0,
  UNIQUE(run_id, story_key)
);
```

### Implementation Notes

- New migration file in `src/persistence/migrations/`
- Metrics written in orchestrator's terminal state handlers (both `run()` completion and error paths)
- Per-story metrics written when `story:done` fires — collect phase timings from the story's event history
- `auto metrics` command registered alongside `auto health` and `auto status`
- Comparison logic: compute percentage deltas for numeric fields, highlight regressions in red (human mode)

## Tasks

- [x] Create DB migration for `run_metrics` and `story_metrics` tables (AC1, AC2)
- [x] Write `run_metrics` on pipeline terminal state (AC1)
- [x] Write `story_metrics` on story terminal state (AC2)
- [x] Track phase durations via event timestamps in orchestrator (AC2)
- [x] Implement `substrate auto metrics` command (AC3)
- [x] Implement `--compare` mode with delta calculation (AC3)
- [x] Implement `--tag-baseline` for baseline tagging (AC4)
- [x] Expose metrics queries for supervisor consumption (AC5)
- [x] Write unit tests for metrics persistence
- [x] Write unit tests for metrics query and comparison
- [x] Verify full test suite passes (AC6)
