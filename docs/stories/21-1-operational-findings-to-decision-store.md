# Story 21-1: Operational Findings Capture via Decision Store

Status: done

## Story

As a pipeline operator,
I want the supervisor and pipeline runtime to persist operational findings (bugs, stalls, improvement opportunities, environment issues) into the decision store,
so that insights from pipeline runs are captured structurally, queryable via `substrate export`, and available to future runs — instead of vanishing in NDJSON event logs or living only in an agent's memory file.

## Background

Today the supervisor emits NDJSON events for stalls, restarts, and experiment results, but these are ephemeral — they disappear when the process exits. Operational insights (e.g., "story 1-4 consistently stalls during code review", "macOS memory detection was wrong", "code review agent times out on 7-AC stories") are only captured if a human or agent manually writes them down.

The decision store already has the right schema: `(category, key, value, rationale)` with per-run scoping and `substrate export` rendering. We just need to wire operational events into it.

Additionally, the current pipeline cost metrics (`cost_usd`) only track child subprocess tokens and are meaningless on subscription plans. Better operational metrics — wall-clock time, token throughput, review cycles, stall rate — should be captured alongside findings. Future integration with OpenTelemetry (OTel) metrics from LLM providers could replace or supplement internal tracking.

## Acceptance Criteria

### AC1: Supervisor Writes Stall Findings to Decision Store
**Given** the supervisor detects a stall and kills/restarts a pipeline
**When** the stall recovery cycle completes
**Then** an `operational-finding` category decision is inserted with key `stall:{story_key}:{timestamp}`, value containing the story phase, staleness seconds, restart attempt number, and outcome (recovered/failed/max-restarts), and rationale summarizing what happened

### AC2: Supervisor Summary Persists Run-Level Findings
**Given** the supervisor emits a `supervisor:summary` event at the end of a monitored run
**When** the summary contains failed or escalated stories
**Then** a decision is inserted with category `operational-finding`, key `run-summary:{run_id}`, value containing succeeded/failed/escalated story lists, total restarts, elapsed time, and token usage

### AC3: Experiment Results Written as Decisions
**Given** the experiment engine completes an experiment with a verdict (IMPROVED/MIXED/REGRESSED)
**When** the result event is emitted
**Then** a decision is inserted with category `experiment-result`, key `experiment:{run_id}:{timestamp}`, value containing the target metric, before/after measurements, verdict, and branch name (if PR was created)

### AC4: Operational Findings Rendered by `substrate export`
**Given** the decision store contains `operational-finding` and `experiment-result` category entries
**When** `substrate export` is run
**Then** the exported markdown includes an "Operational Findings" section grouping findings by run, and an "Experiments" section with verdict summaries

### AC5: Wall-Clock and Efficiency Metrics Per Story
**Given** a story completes (success or failure)
**When** the implementation orchestrator records the outcome
**Then** it also records wall-clock duration (start to finish), total input+output tokens, number of review cycles, and whether a stall occurred — as a decision with category `story-metrics`, key `{story_key}:{run_id}`

### AC6: Metrics Queryable via `substrate metrics`
**Given** `story-metrics` decisions exist across multiple runs
**When** `substrate metrics --output-format json` is run
**Then** the output includes per-story wall-clock time, token throughput, review cycles, and stall rate — replacing or supplementing the current `cost_usd`-centric view

## Tasks / Subtasks

- [x] Task 1: Define decision store categories and schemas (AC: #1, #2, #3, #5)
  - [x] Add `operational-finding`, `experiment-result`, and `story-metrics` as recognized decision categories
  - [x] Document the key/value schema for each category in code comments

- [x] Task 2: Wire supervisor stall events to decision store (AC: #1)
  - [x] On `supervisor:kill` + restart outcome, insert stall finding
  - [x] On `supervisor:stall:max-restarts`, insert escalation finding
  - [x] Requires supervisor to have access to the project's decision store (currently it may only read status)

- [x] Task 3: Wire supervisor summary to decision store (AC: #2)
  - [x] On `supervisor:summary`, insert run-level finding with succeeded/failed/escalated lists

- [x] Task 4: Wire experiment results to decision store (AC: #3)
  - [x] On `supervisor:experiment:result`, insert experiment decision with verdict and measurements

- [x] Task 5: Record story-level wall-clock and efficiency metrics (AC: #5)
  - [x] In implementation orchestrator, capture start time on story dispatch
  - [x] On story completion, compute wall-clock, total tokens, review cycles, stall boolean
  - [x] Insert as `story-metrics` decision

- [x] Task 6: Update `substrate export` renderer for new categories (AC: #4)
  - [x] Add "Operational Findings" section renderer
  - [x] Add "Experiments" section renderer
  - [x] Add "Story Metrics" table renderer

- [x] Task 7: Update `substrate metrics` to use story-metrics decisions (AC: #6)
  - [x] Replace or supplement cost-centric view with wall-clock, throughput, review cycles, stall rate
  - [x] Keep cost_usd as optional/secondary metric for API-billed usage

## Dev Notes

### Architecture Constraints
- Decision store is SQLite-backed, accessed via `src/persistence/queries/decisions.ts`
- Supervisor currently runs as a separate process — it needs DB access to the project's `.substrate/substrate.db`
- `substrate export` renderers live in `src/modules/export/renderers.ts`
- `substrate metrics` command is in `src/cli/commands/` and queries `src/persistence/queries/metrics.ts`

### Future: OpenTelemetry Integration
- LLM providers (Anthropic, OpenAI, Google) expose OTel-compatible metrics
- A community dashboard project is in development that visualizes these — evaluate for adoption once available
- OTel could provide ground-truth token counts, latency percentiles, and rate limit data that substrate currently estimates or misses entirely
- This story lays the schema groundwork; OTel integration would be a follow-up epic

### Relationship to Supervisor Bugs
Three supervisor bugs were identified during the session that motivated this story:
1. Restart uses `run` instead of `resume` (analysis-step-1-vision fails on existing projects)
2. Only monitors implementation phase (exits during analysis/planning/solutioning)
3. Orphan child processes survive orchestrator kill

These are separate fixes but would benefit from the operational findings capture — future stalls caused by these bugs would be automatically documented rather than lost.

## Change Log
- 2026-03-04: Story created from operational findings during code-review-agent pipeline supervision session
