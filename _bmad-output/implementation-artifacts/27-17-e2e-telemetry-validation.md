# Story 27-17: E2E Telemetry Validation

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want to run a real pipeline and verify that OTLP telemetry flows end-to-end into the database,
so that Epic 27 is validated with non-zero data in all telemetry tables.

## Context

Stories 27-14 through 27-16 fix the telemetry pipeline's data format gap. This story is the acceptance gate: run a real pipeline on an external project (ynab) and verify that telemetry tables contain actual data.

**Tables that MUST have data after a successful pipeline run with telemetry enabled:**
- `turn_analysis` — per-turn token breakdown from OTLP log records
- `efficiency_scores` — composite 0-100 efficiency score per story
- `category_stats` — semantic categorization of token usage
- `consumer_stats` — top token consumers by model+tool

**Tables that may remain empty (acceptable):**
- `recommendations` — only populated if heuristic rules fire (depends on data patterns)

## Acceptance Criteria

### AC1: Pipeline Completes with Telemetry Active
**Given** a project with `telemetry: { enabled: true }` in `.substrate/config.yaml`
**When** `substrate run --events --stories <story>` completes a story through SHIP_IT
**Then** the pipeline exits cleanly (exit 0) with no telemetry-related errors in the event stream

### AC2: turn_analysis Table Populated
**Given** a completed pipeline run with telemetry enabled
**When** querying the project's SQLite database
**Then** `turn_analysis` has > 0 rows for the completed story's storyKey, with non-zero `inputTokens` and `outputTokens`

### AC3: efficiency_scores Table Populated
**Given** turn_analysis data exists for the completed story
**When** the post-SHIP_IT efficiency scoring runs
**Then** `efficiency_scores` has exactly 1 row for the story with a `compositeScore` between 0 and 100

### AC4: category_stats Table Populated
**Given** turn_analysis data exists for the completed story
**When** the post-SHIP_IT categorization runs
**Then** `category_stats` has > 0 rows for the story, with at least one category having non-zero `totalTokens`

### AC5: consumer_stats Table Populated
**Given** turn_analysis data exists for the completed story
**When** the post-SHIP_IT consumer analysis runs
**Then** `consumer_stats` has > 0 rows for the story

### AC6: CLI Metrics Command Shows Data
**Given** telemetry data has been persisted
**When** `substrate metrics --output-format json` is run in the project directory
**Then** the output includes non-empty telemetry sections (efficiency scores, recommendations if any)

## Tasks / Subtasks

- [ ] Task 1: Build substrate with stories 27-14, 27-15, 27-16 changes
  - [ ] `npm run build` in substrate project
  - [ ] Verify build succeeds
- [ ] Task 2: Install updated substrate globally (or use `npm run substrate:dev`)
- [ ] Task 3: Run pipeline on ynab project
  - [ ] Target a single small story (e.g., `--stories 5-4` or next pending story)
  - [ ] Use `--events` flag to capture event stream
  - [ ] Verify clean exit (exit 0)
- [ ] Task 4: Query SQLite database for telemetry data
  - [ ] `SELECT COUNT(*) FROM turn_analysis WHERE story_key = '<story>'`
  - [ ] `SELECT * FROM efficiency_scores WHERE story_key = '<story>'`
  - [ ] `SELECT * FROM category_stats WHERE story_key = '<story>'`
  - [ ] `SELECT * FROM consumer_stats WHERE story_key = '<story>'`
  - [ ] All queries must return > 0 rows
- [ ] Task 5: Run `substrate metrics --output-format json` and verify output
- [ ] Task 6: Document results
  - [ ] Record row counts for each table
  - [ ] Record efficiency score value
  - [ ] Record top category and top consumer
  - [ ] Update MEMORY.md with Epic 27 validation status

## Dev Notes

### This is a manual validation story, not an automated test
- The "test" is running a real pipeline and inspecting the database
- No new code is written — this validates stories 27-14 through 27-16
- If validation fails, the fix goes into the relevant story (27-14, 27-15, or 27-16)

### Database Location
- ynab SQLite DB: `/home/jplanow/code/jplanow/ynab/.substrate/substrate.db`
- Query tool: `sqlite3` CLI or substrate's built-in metrics command

### Prerequisites
- Stories 27-14, 27-15, 27-16 must be implemented and built
- ynab project must have `telemetry: { enabled: true, port: 4318 }` in config
- No stale substrate processes running (`pgrep -f substrate` should be clean)

## Interface Contracts

- None — this is a validation story

## Dependencies

- **MUST run after**: 27-14, 27-15, 27-16
