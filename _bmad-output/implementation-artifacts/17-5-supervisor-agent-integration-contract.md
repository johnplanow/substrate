# Story 17.5: Supervisor Agent Integration Contract

Status: done
Blocked-by: 17-4

## Story

As an AI agent operating inside a Claude Code session,
I want the supervisor's events, commands, and interaction patterns to be fully documented in the agent-facing contracts (`event-types.ts`, `help-agent.ts`, `CLAUDE.md`),
so that I can discover, invoke, and respond to the supervisor without hardcoded knowledge.

## Context

Stories 17-1 through 17-4 built a complete supervisor framework: watchdog, metrics, analysis engine, and automated experimentation. But the agent integration layer was not updated to reflect the new capabilities.

The original supervisor events (`supervisor:kill`, `supervisor:restart`, `supervisor:abort`, `supervisor:summary`) are properly registered in `event-types.ts` and `help-agent.ts`. However, stories 17-3 and 17-4 introduced 7 new events that are emitted as ad-hoc objects in `auto.ts` — they have no TypeScript interfaces, no entries in `EVENT_TYPE_NAMES`, and no metadata in `PIPELINE_EVENT_METADATA`. This bypasses the sync contract that was specifically designed to prevent event drift.

Additionally, `help-agent.ts` documents the supervisor command but omits the `--experiment` and `--analysis` flags. Its interaction patterns section covers pipeline events but has zero patterns for supervisor events. And `CLAUDE.md` — the primary instruction surface for agents entering this repo — mentions nothing about the supervisor at all.

The result: an agent in a Claude session defaults to `auto run` + manual polling (as demonstrated in the session where Epic 17 was implemented), completely unaware that `auto supervisor` exists or how to use it.

## Acceptance Criteria

### AC1: Analysis Event Type Definitions
**Given** stories 17-3/17-4 emit analysis and experiment events
**When** these events are consumed by an agent
**Then** `event-types.ts` contains TypeScript interfaces for:
  - `SupervisorAnalysisCompleteEvent` (`supervisor:analysis:complete`)
  - `SupervisorAnalysisErrorEvent` (`supervisor:analysis:error`)
**And** each interface has `type`, `ts`, `run_id`, and any additional fields matching current `emitEvent()` calls in `auto.ts`
**And** both interfaces are included in the `PipelineEvent` discriminated union
**And** both type strings are in `EVENT_TYPE_NAMES`

### AC2: Experiment Event Type Definitions
**Given** story 17-4 emits experiment lifecycle events
**When** these events are consumed by an agent
**Then** `event-types.ts` contains TypeScript interfaces for:
  - `SupervisorExperimentStartEvent` (`supervisor:experiment:start`)
  - `SupervisorExperimentSkipEvent` (`supervisor:experiment:skip`)
  - `SupervisorExperimentRecommendationsEvent` (`supervisor:experiment:recommendations`)
  - `SupervisorExperimentCompleteEvent` (`supervisor:experiment:complete`)
  - `SupervisorExperimentErrorEvent` (`supervisor:experiment:error`)
**And** each interface has fields matching the current `emitEvent()` calls in `auto.ts`
**And** all 5 interfaces are in the `PipelineEvent` union and `EVENT_TYPE_NAMES`

### AC3: Event Metadata in help-agent.ts
**Given** AC1 and AC2 add 7 new event type definitions
**When** an agent runs `substrate auto --help-agent`
**Then** `PIPELINE_EVENT_METADATA` contains entries for all 7 new events
**And** each entry has `type`, `description`, `when`, and `fields` matching the interfaces
**And** the existing sync contract tests pass (no gaps between `EVENT_TYPE_NAMES` and metadata)

### AC4: Command Documentation Updates
**Given** `help-agent.ts` documents the supervisor and metrics commands
**When** an agent reads the command reference section
**Then** `substrate auto supervisor` documents the `--experiment` flag with description
**And** `substrate auto supervisor` documents the `--max-experiments <n>` flag
**And** `substrate auto metrics` documents the `--analysis <run-id>` flag with description

### AC5: Supervisor Interaction Patterns
**Given** `help-agent.ts` has an interaction patterns section
**When** an agent reads the patterns
**Then** the following supervisor event patterns exist:
  - On `supervisor:summary` — summarize succeeded/failed/escalated, offer to run analysis
  - On `supervisor:kill` — inform user of stall detection and restart attempt
  - On `supervisor:abort` — escalate to user, suggest adjusting `--max-restarts` or `--stall-threshold`
  - On `supervisor:analysis:complete` — read the analysis report from `_bmad-output/supervisor-reports/`, present findings
  - On `supervisor:experiment:complete` — summarize verdicts (improved/mixed/regressed), link to any PRs created
  - On `supervisor:experiment:error` — report error, suggest running without `--experiment`

### AC6: CLAUDE.md Supervisor Section
**Given** `CLAUDE.md` is the primary instruction surface for agents
**When** an agent reads `CLAUDE.md` on entering the substrate repo
**Then** there is a "Supervisor Workflow" section within the `<!-- substrate:start -->` block
**And** it explains when to use `auto supervisor` vs `auto run` (decision framework)
**And** it documents the recommended invocation pattern:
  - Start pipeline: `substrate auto run --events --stories X,Y`
  - Monitor with supervisor: `substrate auto supervisor --output-format json`
  - Full self-improvement loop: `substrate auto supervisor --experiment --output-format json`
  - Read analysis: `substrate auto metrics --analysis <run-id> --output-format json`
**And** it notes that `--output-format json` should be used for agent consumption

### AC7: Existing Tests Pass
**Given** all changes are implemented
**When** the full test suite runs
**Then** all existing tests pass including the help-agent sync contract tests
**And** coverage thresholds are maintained

## Dev Notes

### Architecture

- Event interfaces follow the established pattern in `event-types.ts` — each has `type` literal, `ts: string`, `run_id: string | null`, plus event-specific fields
- The `emitEvent()` calls in `auto.ts` (lines ~3535, 3544, 3569, 3572, 3622, 3634, 3640) are the source of truth for current field shapes — match these exactly
- `PIPELINE_EVENT_METADATA` entries must have field counts matching the interfaces (sync contract test enforces this)
- CLAUDE.md changes go inside the existing `<!-- substrate:start -->` / `<!-- substrate:end -->` markers

### Files to Modify

- `src/modules/implementation-orchestrator/event-types.ts` — 7 new interfaces, union update, EVENT_TYPE_NAMES update
- `src/cli/commands/help-agent.ts` — 7 new PIPELINE_EVENT_METADATA entries, command doc updates, interaction patterns
- `CLAUDE.md` — new supervisor section
- `src/cli/commands/auto.ts` — update `emitEvent()` calls to use typed event objects (type-safe cast)

### Type the ad-hoc emitEvent calls

Currently `auto.ts` does:
```ts
emitEvent({ type: 'supervisor:analysis:complete', run_id: health.run_id })
```
After AC1/AC2, these should be typed:
```ts
emitEvent({ type: 'supervisor:analysis:complete', ts: new Date().toISOString(), run_id: health.run_id } as SupervisorAnalysisCompleteEvent)
```
Or better, the `emitEvent` function should accept the union type and auto-inject `ts`.

## Tasks

- [x] Add `SupervisorAnalysisCompleteEvent` and `SupervisorAnalysisErrorEvent` interfaces to `event-types.ts` (AC1)
- [x] Add 5 experiment event interfaces to `event-types.ts` (AC2)
- [x] Update `PipelineEvent` union and `EVENT_TYPE_NAMES` with all 7 new types (AC1, AC2)
- [x] Add 7 `PIPELINE_EVENT_METADATA` entries to `help-agent.ts` (AC3)
- [x] Update supervisor command docs with `--experiment` and `--max-experiments` flags (AC4)
- [x] Update metrics command docs with `--analysis <run-id>` flag (AC4)
- [x] Add supervisor interaction patterns section to `help-agent.ts` (AC5)
- [x] Add "Supervisor Workflow" section to `CLAUDE.md` (AC6)
- [x] Update `emitEvent()` calls in `auto.ts` to use typed event objects (AC1, AC2)
- [x] Write unit tests for new event type coverage
- [x] Verify full test suite passes including sync contract tests (AC7)
