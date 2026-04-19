# Story 21-1: Operational Findings Capture via Decision Store

Status: ready-for-dev

## Story

As a pipeline operator,
I want the supervisor and pipeline runtime to persist operational findings (stalls, run summaries, experiment results, and per-story efficiency metrics) into the decision store,
so that insights from pipeline runs are captured structurally, queryable via `substrate export` and `substrate metrics`, and available to future runs instead of vanishing in NDJSON event logs.

## Acceptance Criteria

### AC1: Supervisor Writes Stall Findings to Decision Store
**Given** the supervisor detects a stall and kills/restarts a pipeline
**When** the stall recovery cycle completes
**Then** a decision is inserted with `category: "operational-finding"`, `key: "stall:{story_key}:{timestamp}"`, `value` containing story phase, staleness seconds, restart attempt number, and outcome (recovered/failed/max-restarts), and `rationale` summarizing what happened

### AC2: Supervisor Summary Persists Run-Level Finding
**Given** the supervisor emits a `supervisor:summary` event at the end of a monitored run
**When** the summary contains at least one story (succeeded, failed, or escalated)
**Then** a decision is inserted with `category: "operational-finding"`, `key: "run-summary:{run_id}"`, `value` containing succeeded/failed/escalated story lists, total restarts, elapsed time, and token usage summary

### AC3: Experiment Results Written as Decisions
**Given** the experiment engine completes an experiment with a verdict (IMPROVED/MIXED/REGRESSED)
**When** the experiment result event is emitted
**Then** a decision is inserted with `category: "experiment-result"`, `key: "experiment:{run_id}:{timestamp}"`, `value` containing target metric, before/after measurements, verdict, and branch name (if a PR was created)

### AC4: Per-Story Wall-Clock and Efficiency Metrics Recorded
**Given** a story completes (success or failure) in the implementation orchestrator
**When** the orchestrator records the story outcome
**Then** it also inserts a decision with `category: "story-metrics"`, `key: "{story_key}:{run_id}"`, `value` containing wall-clock duration (seconds), total input+output tokens, number of review cycles, and whether a stall occurred

### AC5: Operational Findings Rendered by `substrate export`
**Given** the decision store contains `operational-finding` and `experiment-result` category decisions
**When** `substrate export` is run
**Then** the exported markdown includes an "Operational Findings" section grouping findings by run key and an "Experiments" section listing verdict summaries

### AC6: `substrate metrics` Surface Story-Level Efficiency Data
**Given** `story-metrics` decisions exist for one or more stories
**When** `substrate metrics --output-format json` is run
**Then** the output includes per-story wall-clock time, total tokens, review cycles, and stall flag — displayed alongside or replacing the cost_usd-centric view

## Tasks / Subtasks

- [ ] Task 1: Define decision category constants and key schemas (AC: #1, #2, #3, #4)
  - [ ] Add `OPERATIONAL_FINDING`, `EXPERIMENT_RESULT`, `STORY_METRICS` category constants in `src/persistence/schemas/decisions.ts` (or a new `src/persistence/schemas/operational.ts`)
  - [ ] Document the expected JSON shape of `value` for each category in code comments
  - [ ] Export constants so supervisor and orchestrator can import them without string literals

- [ ] Task 2: Wire supervisor stall events to decision store (AC: #1)
  - [ ] In `src/cli/commands/supervisor.ts`, open the project's SQLite DB (`src/persistence/database.ts`) after detecting the project path
  - [ ] On stall-kill + restart, call `createDecision` with `category: OPERATIONAL_FINDING`, `phase: "supervisor"`, `key: "stall:{storyKey}:{Date.now()}"`, `value: JSON.stringify({phase, staleness_secs, attempt, outcome})`
  - [ ] On `max-restarts` escalation, insert a separate finding with `outcome: "max-restarts-escalated"`

- [ ] Task 3: Wire supervisor summary event to decision store (AC: #2)
  - [ ] In supervisor summary handler, insert `operational-finding` decision with `key: "run-summary:{run_id}"` containing succeeded/failed/escalated lists, total restarts, elapsed seconds, token totals
  - [ ] Guard: only insert if summary contains at least one story entry

- [ ] Task 4: Wire experiment result event to decision store (AC: #3)
  - [ ] In `src/modules/supervisor/experimenter.ts`, after emitting `supervisor:experiment:result`, call `createDecision` with `category: EXPERIMENT_RESULT`
  - [ ] Include target metric, before/after values, verdict, and PR branch name (or null if no PR)
  - [ ] Requires experimenter to accept a `db` dependency (add to `ExperimenterDeps` if not already present)

- [ ] Task 5: Record per-story metrics in implementation orchestrator (AC: #4)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, capture `startTime = Date.now()` when a story dispatch begins
  - [ ] On story completion, compute `wall_clock_seconds`, sum total tokens from token usage entries, count review cycles, set `stalled: boolean`
  - [ ] Call `createDecision` with `category: STORY_METRICS`, `phase: "implementation"`, `key: "{storyKey}:{runId}"`, `value: JSON.stringify({wall_clock_seconds, input_tokens, output_tokens, review_cycles, stalled})`

- [ ] Task 6: Add renderers for new categories to `substrate export` (AC: #5)
  - [ ] In `src/modules/export/renderers.ts`, add `renderOperationalFindings(decisions: Decision[]): string`
  - [ ] Add `renderExperiments(decisions: Decision[]): string`
  - [ ] Wire both into the main export output in `src/cli/commands/export.ts`, querying by category

- [ ] Task 7: Update `substrate metrics` to include story-metrics decisions (AC: #6)
  - [ ] In `src/cli/commands/metrics.ts`, query decisions by `category = "story-metrics"` and parse JSON values
  - [ ] Add per-story table to JSON and text output: `story_key`, `wall_clock_seconds`, `input_tokens`, `output_tokens`, `review_cycles`, `stalled`
  - [ ] Keep `cost_usd` as secondary/optional field; suppress it when zero (subscription plans)

- [ ] Task 8: Tests for new decision insertions and renderers (AC: #1–#6)
  - [ ] Unit tests for `renderOperationalFindings` and `renderExperiments` in `src/modules/export/__tests__/`
  - [ ] Integration test: supervisor stall path inserts decision (use in-memory SQLite)
  - [ ] Integration test: orchestrator story completion inserts `story-metrics` decision
  - [ ] Unit test: `metrics` command includes story-level data from decisions

## Dev Notes

### Architecture Constraints
- Decision store is SQLite-backed, accessed via `src/persistence/queries/decisions.ts` (`createDecision`, `getDecisionsByCategory`)
- Database file: `.substrate/substrate.db` in the project root; opened via `src/persistence/database.ts`
- `createDecision` signature: `(db: BetterSqlite3Database, input: CreateDecisionInput) => Decision`
  - Required fields: `phase`, `category`, `key`, `value` (strings); optional: `pipeline_run_id`, `rationale`
  - `value` must be a non-empty string — store complex data as `JSON.stringify({...})`
- Export renderers are pure functions in `src/modules/export/renderers.ts`; they accept `Decision[]` and return a markdown string
- Supervisor CLI: `src/cli/commands/supervisor.ts`; supervisor analysis/experimenter modules: `src/modules/supervisor/`
- Implementation orchestrator: `src/modules/implementation-orchestrator/orchestrator-impl.ts`
- `substrate metrics` command: `src/cli/commands/metrics.ts`; existing metrics queries: `src/persistence/queries/metrics.ts`

### Key Data Shapes

```typescript
// operational-finding value shape
{
  phase: string,          // e.g. "code-review"
  staleness_secs: number,
  attempt: number,
  outcome: "recovered" | "failed" | "max-restarts-escalated"
}

// run-summary value shape
{
  succeeded: string[],
  failed: string[],
  escalated: string[],
  total_restarts: number,
  elapsed_seconds: number,
  total_input_tokens: number,
  total_output_tokens: number
}

// experiment-result value shape
{
  target_metric: string,
  before: number,
  after: number,
  verdict: "IMPROVED" | "MIXED" | "REGRESSED",
  branch_name: string | null
}

// story-metrics value shape
{
  wall_clock_seconds: number,
  input_tokens: number,
  output_tokens: number,
  review_cycles: number,
  stalled: boolean
}
```

### Testing Requirements
- Test framework: **vitest** (not jest — `--testPathPattern` does not work; use `-- "pattern"`)
- Coverage threshold: 80% enforced — run full suite with `npm test` before submitting
- Use in-memory SQLite (`:memory:`) for all persistence tests; import DB helpers from `src/persistence/database.ts`
- Do not mock `better-sqlite3` — use real in-memory DB for decision store tests
- For supervisor tests that involve spawning, mock process spawning; only test the decision-insertion path directly

### Import Style
- Use `.js` extensions on all local imports (ESM): `import { createDecision } from '../../persistence/queries/decisions.js'`
- Named exports only; no default exports on new files

### Future: OpenTelemetry
- OTel integration is out of scope for this story; this story lays the schema groundwork
- `cost_usd` tracking is preserved for API-billed usage but deprioritized in the metrics view

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
- 2026-03-05: Story created from draft in docs/stories/21-1-operational-findings-to-decision-store.md
