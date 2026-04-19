# Story 24-4: Pipeline Metrics v2

Status: review

## Story

As a pipeline operator,
I want pipeline metrics to track wall-clock time, token throughput, and review cycles per story,
so that I have meaningful signals for pipeline health instead of the misleading cost_usd metric on subscription plans.

Addresses: Open improvement area — cost_usd is meaningless on subscription plans; wall-clock time, token throughput, and review cycles are better signals.

## Acceptance Criteria

### AC1: Wall-Clock Time Per Story
**Given** a story begins execution (dev-story dispatch)
**When** the story reaches a terminal state (COMPLETE, NEEDS_ESCALATION, or max retries)
**Then** the total wall-clock duration in milliseconds is recorded in `story_metrics` table

### AC2: Wall-Clock Time Per Phase
**Given** a story transitions between phases (dev-story, build-gate, code-review)
**When** each phase completes
**Then** per-phase wall-clock duration is recorded, enabling breakdown analysis

### AC3: Token Throughput Per Story
**Given** a story's dev-story and code-review agents complete
**When** token usage is available from the adapter
**Then** total input_tokens and output_tokens are recorded per story in `story_metrics`

### AC4: Review Cycle Count
**Given** a story goes through one or more code-review cycles
**When** the story reaches a terminal state
**Then** the total number of review cycles (including rework loops) is recorded

### AC5: Pipeline Run Summary
**Given** a pipeline run completes (all stories terminal)
**When** the run summary is generated
**Then** it includes: total wall-clock time, per-story wall-clock breakdown, total tokens, total review cycles, and stories-per-hour throughput

### AC6: JSON Output Format
**Given** the `--output-format json` flag is used with `substrate status`
**When** metrics are included in the output
**Then** the new metrics (wall_clock_ms, tokens, review_cycles) appear alongside existing fields, and cost_usd is retained but deprioritized (moved to end of output)

### AC7: Backward Compatibility
**Given** existing pipeline_runs and story data in the database
**When** the metrics v2 schema migration runs
**Then** existing records get null/0 defaults for new fields and are not corrupted

### AC8: NDJSON Event for Story Metrics
**Given** a story reaches a terminal state
**When** metrics are finalized
**Then** a structured NDJSON event is emitted: `{ type: "story:metrics", storyKey, wallClockMs, phaseBreakdown: {...}, tokens: { input, output }, reviewCycles }`

## Tasks / Subtasks

- [x] Task 1: Add wall-clock timing to story lifecycle (AC: #1, #2)
  - [x] Record `startedAt` timestamp when dev-story dispatches
  - [x] Record per-phase timestamps: dev-story start/end, build-gate start/end, code-review start/end
  - [x] Compute total and per-phase durations on terminal state

- [x] Task 2: Extend story_metrics table schema (AC: #1, #2, #3, #4, #7)
  - [x] Add columns: `wall_clock_ms INTEGER`, `dev_phase_ms INTEGER`, `build_gate_ms INTEGER`, `review_phase_ms INTEGER`, `input_tokens INTEGER`, `output_tokens INTEGER`, `review_cycles INTEGER`
  - [x] Migration must handle existing rows with defaults (0 or null)

- [x] Task 3: Capture token counts from adapter responses (AC: #3)
  - [x] After dev-story and code-review complete: extract token usage from adapter result
  - [x] Accumulate per-story totals

- [x] Task 4: Record review cycle count (AC: #4)
  - [x] Increment review cycle counter on each code-review dispatch
  - [x] Include rework loops (NEEDS_MINOR_FIXES → re-dev → re-review)

- [x] Task 5: Pipeline run summary with new metrics (AC: #5, #6)
  - [x] Update `substrate status --output-format json` to include new fields
  - [x] Add computed field: `storiesPerHour = completedStories / (totalWallClockMs / 3600000)`
  - [x] Deprioritize cost_usd in output ordering

- [x] Task 6: NDJSON event emission (AC: #8)
  - [x] Emit `story:metrics` event on terminal state with full metrics payload

- [x] Task 7: Unit and integration tests (AC: #1-#8)
  - [x] Test: wall-clock timing recorded for completed story
  - [x] Test: per-phase breakdown sums to total (within tolerance)
  - [x] Test: token counts accumulated from adapter
  - [x] Test: review cycle count increments correctly
  - [x] Test: pipeline summary includes new metrics
  - [x] Test: JSON output format includes new fields
  - [x] Test: schema migration preserves existing data
  - [x] Test: NDJSON event structure matches schema

## Dev Notes

### Architecture Constraints
- **Files**: `src/modules/agent-dispatch/dispatcher-impl.ts` (timing hooks), `src/persistence/schemas/` (story_metrics schema), `src/cli/commands/status.ts` (output format)
- **Existing metrics**: `story_metrics` and `run_metrics` tables already exist — extend, don't replace
- **Modular Monolith (ADR-001)**: Metrics logic in dispatcher + persistence layer
- **SQLite WAL (ADR-003)**: Schema migration via existing migration system
- **Import style**: `.js` extension on all local imports (ESM)
- **Test framework**: vitest (not jest)

### Key Context
- `npm run build` = 1.4s, `npm test` = 108s (measured 2026-03-06)
- cost_usd remains in schema but is deprioritized in output — not removed for backward compatibility
- Subscription plans make per-token cost meaningless; throughput and cycle counts are the actionable signals

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest)
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify

### CRITICAL: Schema Already Exists — Do NOT Create a Migration

The `story_metrics` and `run_metrics` tables (migration 010 in `src/persistence/migrations/010-run-metrics.ts`) already have ALL needed columns:
`wall_clock_seconds`, `phase_durations_json`, `input_tokens`, `output_tokens`, `cost_usd`, `review_cycles`, `dispatches`.

`writeStoryMetricsBestEffort()` in `orchestrator-impl.ts:182` already populates wall-clock time, phase durations JSON, token counts (via
`aggregateTokenUsageForStory()`), review cycles, and dispatches. The data is already flowing into SQLite.

**Skip Task 1 (timing already wired), Task 2 (schema exists), Task 3 (token capture exists), Task 4 (review cycles already recorded).** Mark them [x]
immediately.

**Actual work is Tasks 5, 6, 7 only:**

- **Task 5 (AC5, AC6):** Update `src/cli/commands/status.ts` — add per-story metrics breakdown to `--output-format json` output. Add computed `storiesPerHour`
 field. Move `cost_usd` to end of object. Use `getStoryMetricsForRun()` from `src/persistence/queries/metrics.ts`.

- **Task 6 (AC8):** Add `story:metrics` NDJSON event emitted on terminal state. Wire through 5 files — follow the `story:interface-change-warning` pattern
exactly:
  1. `src/core/event-bus.types.ts` — add to `OrchestratorEvents` map
  2. `src/modules/implementation-orchestrator/event-types.ts` — add `StoryMetricsEvent` interface, add to `PipelineEvent` union, add to `EVENT_TYPE_NAMES`
  3. `src/modules/implementation-orchestrator/orchestrator-impl.ts` — emit event after each `writeStoryMetricsBestEffort()` call
  4. `src/cli/commands/run.ts` — add NDJSON handler in the `--events` block
  5. `src/cli/commands/help-agent.ts` — add event metadata entry

- **Task 7:** Tests for Tasks 5+6. Add orchestrator test for event emission, epic-15 integration test for NDJSON wire format, status command test for new
output fields.

### Event Payload Shape
```
{
  type: 'story:metrics'
  ts: string
  storyKey: string
  wallClockMs: number
  phaseBreakdown: Record<string, number>  // phase name → ms
  tokens: { input: number, output: number }
  reviewCycles: number
  dispatches: number
}
```

### Files to Read First
- `src/cli/commands/status.ts` — understand current output shape before modifying
- `src/core/event-bus.types.ts` — see `story:interface-change-warning` entry for pattern
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — search `writeStoryMetricsBestEffort` for all 10+ call sites where the event should be emitted
- `src/persistence/queries/metrics.ts` — `getStoryMetricsForRun()` is what you need for status output

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Tasks 1-4 were pre-existing (schema and timing infrastructure already in place per Dev Notes)
- Task 5: Extended `status.ts` JSON output with `story_metrics` array and `pipeline_metrics` object
- Task 6: Added `story:metrics` NDJSON event through all 5 required files
- Task 7: 78 new tests added across 3 test files; help-agent token threshold updated from 2500→2700 to accommodate the new event

### File List
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/status.ts
- /Users/John.Planow/code/jplanow/substrate/src/core/event-bus.types.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/event-types.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/orchestrator-impl.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/run.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/help-agent.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/__tests__/help-agent.test.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/__tests__/story-metrics-event.test.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/__tests__/status-metrics-v2.test.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/__tests__/story-metrics-ndjson.integration.test.ts

## Change Log
