---
external_state_dependencies:
  - filesystem
---

# Story 65-6: Telemetry Events for State-Integrating Dispatches

## Story

As a substrate operator,
I want probe-author telemetry events to carry a `triggered_by` discriminator and `substrate metrics` to support a `--probe-author-class-summary` flag,
so that I can measure catch rate, cost, and dispatch count broken down by trigger class (event-driven vs. state-integrating).

## Acceptance Criteria

<!-- source-ac-hash: 947c0e3405a6998d7e504c5c9d0c64780809ba3fabafa5744f4575b5739c0a1c -->

### AC1: `probe-author:dispatched` event includes `triggered_by` field
`probe-author:dispatched` event includes `triggered_by` field.

### AC2: Per-story manifest records `probe_author.triggered_by`
Per-story manifest records `probe_author.triggered_by` alongside existing fields.

### AC3: `substrate metrics --probe-author-class-summary` outputs per-class aggregates
`substrate metrics --probe-author-class-summary` outputs per-class aggregates.

### AC4: Backward-compat default for legacy events
Backward-compat: legacy events without `triggered_by` default to `event-driven` (the only class that existed pre-Phase 3).

## Tasks / Subtasks

- [ ] Task 1: Define `ProbeAuthorTriggerClass` type and extend event schema (AC: #1, #4)
  - [ ] Add `export type ProbeAuthorTriggerClass = 'event-driven' | 'state-integrating' | 'both'` to `packages/sdlc/src/run-model/probe-author-metrics.ts`
  - [ ] Update `'probe-author:dispatched'` payload in `src/core/event-bus.types.ts` to include `triggered_by: ProbeAuthorTriggerClass` (or `string` with a note) as an optional field
  - [ ] Document that absent `triggered_by` on legacy events defaults to `'event-driven'`

- [ ] Task 2: Persist `probe_author_triggered_by` to per-story manifest (AC: #2, #4)
  - [ ] Add optional `probe_author_triggered_by` field (open string union: `z.union([z.literal('event-driven'), z.literal('state-integrating'), z.literal('both'), z.string()]).optional()`) to `PerStoryStateSchema` in `packages/sdlc/src/run-model/per-story-state.ts`, following the `dev_story_signals` pattern
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts` around line 2264, compute `triggerClass: ProbeAuthorTriggerClass` from the two AC-detector booleans (`eventDriven`, `stateIntegrating`) and call `patchStoryState(storyKey, { probe_author_triggered_by: triggerClass })` (best-effort, non-fatal — match the `dev_story_signals` pattern)
  - [ ] Pass `triggerClass` into `runProbeAuthor` params so it can include it on the emitted `probe-author:dispatched` event

- [ ] Task 3: Thread `triggered_by` through `runProbeAuthor` to emitted events (AC: #1)
  - [ ] Extend `RunProbeAuthorParams` in `src/modules/implementation-orchestrator/probe-author-integration.ts` with optional `triggerClass?: ProbeAuthorTriggerClass`
  - [ ] Update both `emitEvent?.('probe-author:dispatched', {...})` call sites (around lines 415 and 465) to include `triggered_by: params.triggerClass ?? 'event-driven'`

- [ ] Task 4: Add `rollupProbeAuthorByClass` aggregation helper (AC: #3, #4)
  - [ ] Add `ProbeAuthorClassSummary` interface and `rollupProbeAuthorByClass(entries: Array<{ metrics: ProbeAuthorMetrics; triggered_by?: string }>): Record<ProbeAuthorTriggerClass, ProbeAuthorAggregate>` to `packages/sdlc/src/run-model/probe-author-metrics.ts`
  - [ ] Group entries by `triggered_by` value (absent or unknown defaults to `'event-driven'`); compute `aggregateProbeAuthorMetrics` per group
  - [ ] Export the new type and function alongside the existing exports

- [ ] Task 5: Add `--probe-author-class-summary` flag to `substrate metrics` CLI (AC: #3)
  - [ ] Register `--probe-author-class-summary` in the metrics subcommand option parser in `src/cli/commands/metrics.ts` (following the `--probe-author-summary` pattern at line 1078)
  - [ ] In the JSON output branch, when the flag is set, call `rollupProbeAuthorByClass` with each story metric's `probe_author` + the manifest's `probe_author_triggered_by`, and attach the result as `jsonPayload.probe_author_class_summary`

- [ ] Task 6: Tests (AC: #1, #2, #3, #4)
  - [ ] Unit test: `triggered_by` field is present on both emit-path dispatches (mock `emitEvent`, assert payload includes `triggered_by: 'event-driven'` when only event-driven AC fires, `'state-integrating'` when only state-integrating fires, `'both'` when both fire)
  - [ ] Unit test: `PerStoryStateSchema` round-trips `probe_author_triggered_by` via `patchStoryState` + read (mirror existing `dev_story_signals` round-trip test in `__tests__/per-story-state.test.ts`)
  - [ ] Unit test: `rollupProbeAuthorByClass` produces correct per-class aggregates for a mixed set of entries (one `event-driven`, one `state-integrating`, one without `triggered_by`)
  - [ ] Unit test: backward-compat — entry without `triggered_by` is counted under `event-driven` in `rollupProbeAuthorByClass`

## Dev Notes

### Architecture Constraints
- `ProbeAuthorTriggerClass` type lives in `packages/sdlc/src/run-model/probe-author-metrics.ts` (alongside the existing `ProbeAuthorMetrics`, `ProbeAuthorAggregate`, etc.)
- The manifest field name follows the project's snake_case convention: `probe_author_triggered_by` (a top-level optional field on `PerStoryStateSchema`, NOT nested inside another object)
- The `probe_author.triggered_by` surface exposed in the metrics JSON output is assembled at read-time by merging the manifest's `probe_author_triggered_by` with the rollup computed from the verification summary — same read-time composition pattern used for `probe_author` today
- Backward-compat is load-bearing: old manifests have no `probe_author_triggered_by` field; the read path MUST default to `'event-driven'` without throwing
- `patchStoryState` calls MUST be best-effort / non-fatal (`.catch(err => logger.warn({err, storyKey}, '...'))`) — the pipeline must not fail if the manifest write fails

### Key File Paths
- **Event type**: `src/core/event-bus.types.ts` — `'probe-author:dispatched'` payload type (around line 446)
- **Manifest schema**: `packages/sdlc/src/run-model/per-story-state.ts` — `PerStoryStateSchema` (add `probe_author_triggered_by` optional field)
- **Metrics helpers**: `packages/sdlc/src/run-model/probe-author-metrics.ts` — add `ProbeAuthorTriggerClass` type + `rollupProbeAuthorByClass`
- **Probe-author integration params**: `src/modules/implementation-orchestrator/probe-author-integration.ts` — `RunProbeAuthorParams` + both emit sites
- **Orchestrator dispatch site**: `src/modules/implementation-orchestrator/orchestrator-impl.ts` around line 2264 — compute `triggerClass` from detector results + call `patchStoryState`
- **Metrics CLI**: `src/cli/commands/metrics.ts` — register `--probe-author-class-summary`, wire `rollupProbeAuthorByClass`, emit `probe_author_class_summary` in JSON output

### Trigger class computation logic
At the orchestrator dispatch site (line 2264):
```typescript
const isEventDriven = detectsEventDrivenAC(probeAuthorEpicContent)
const isStateIntegrating = stateIntegratingEnabled && detectsStateIntegratingAC(probeAuthorEpicContent)
if (isEventDriven || isStateIntegrating) {
  const triggerClass: ProbeAuthorTriggerClass =
    isEventDriven && isStateIntegrating ? 'both'
    : isStateIntegrating ? 'state-integrating'
    : 'event-driven'
  // persist to manifest + pass to runProbeAuthor
}
```

### Testing Requirements
- Use existing vitest test framework (no new frameworks)
- Run `npm run test:fast` during iteration; full `npm test` before merging
- Mirror existing `rollupProbeAuthorMetrics` test shape for new `rollupProbeAuthorByClass` tests
- The `PerStoryStateSchema` round-trip test can follow the pattern at `__tests__/per-story-state.test.ts` line 385 (`dev_story_signals round-trips`)
- Do NOT break existing `probe-author-metrics` tests, manifest round-trip tests, or metrics command tests

## Runtime Probes

```yaml
- name: metrics-class-summary-flag-accepted
  sandbox: host
  command: |
    node dist/cli.mjs metrics --probe-author-class-summary --output-format json 2>&1 || true
  description: >
    Verifies --probe-author-class-summary is a recognized CLI flag.
    The command may produce empty class buckets when no run data with
    triggered_by fields exists yet — that is acceptable. What is NOT
    acceptable is an "unknown option" argument-parse error.
  expect_stdout_no_regex:
    - '(?i)unknown\s+option'
    - '(?i)unknown\s+flag'
    - '(?i)invalid\s+option'
    - '(?i)error:\s+unknown'

- name: metrics-backward-compat-no-crash
  sandbox: host
  command: |
    node dist/cli.mjs metrics --output-format json 2>&1 | head -c 2048
  description: >
    Verifies that the existing --output-format json metrics path still
    produces valid JSON after the backward-compat changes. Legacy run data
    (manifests without probe_author_triggered_by) must not cause a
    TypeError or undefined-access crash.
  expect_stdout_no_regex:
    - 'TypeError'
    - 'Cannot read propert'
    - 'is not a function'
    - 'undefined is not'
```

## Interface Contracts

- **Export**: `ProbeAuthorTriggerClass` @ `packages/sdlc/src/run-model/probe-author-metrics.ts`
- **Export**: `rollupProbeAuthorByClass` @ `packages/sdlc/src/run-model/probe-author-metrics.ts`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
