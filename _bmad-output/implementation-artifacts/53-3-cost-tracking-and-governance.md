# Story 53-3: Cost Tracking and Governance

## Story

As a substrate operator,
I want cumulative pipeline cost tracked against a `--cost-ceiling` and enforced between story dispatches,
so that automated overnight runs do not silently overspend beyond my approved budget.

## Acceptance Criteria

### AC1: CostGovernanceChecker Computes Cumulative Run Cost Correctly
**Given** a run manifest where `per_story_state` contains multiple stories each with a `cost_usd` value, and `cost_accumulation.run_total` holds the total retry cost
**When** `CostGovernanceChecker.computeCumulativeCost(manifest)` is called
**Then** it returns the sum of all `per_story_state[key].cost_usd` values (treating `undefined` as `0`) plus `manifest.cost_accumulation.run_total`

### AC2: Ceiling Threshold Check Returns Correct Status
**Given** a `CostGovernanceChecker` and a cost ceiling of `$5.00`
**When** `checkCeiling(manifest, 5.00)` is called with cumulative costs of `$3.90`, `$4.00`, `$4.20`, and `$5.10`
**Then** the results are `'ok'` (78%), `'warning'` (exactly 80%), `'warning'` (84%), and `'exceeded'` (102%) respectively
**And** `percentUsed` in the result equals `(cumulative / ceiling) * 100` rounded to two decimal places

### AC3: Pre-Dispatch Check Reads Ceiling from Manifest cli_flags
**Given** a run manifest with `cli_flags.cost_ceiling: 3.00`
**When** the orchestrator is about to dispatch a story
**Then** it reads the ceiling from `manifest.cli_flags.cost_ceiling`
**And** when `cli_flags.cost_ceiling` is absent or `runManifest` is null, no ceiling check is performed and dispatch proceeds normally

### AC4: cost:warning NDJSON Event Emitted at 80% Threshold (Once Per Run)
**Given** a cost ceiling and cumulative cost crossing the 80% threshold between story dispatches
**When** `checkCeiling` returns `status: 'warning'`
**Then** a `cost:warning` NDJSON event is emitted with `cumulative_cost`, `ceiling`, and `percent_used` fields
**And** the event is emitted at most once per pipeline run — subsequent checks that remain in the warning zone do not re-emit it

### AC5: With --halt-on none, Ceiling-Breaching Dispatch Stops and Finalizes
**Given** `--halt-on none` (the default) and cumulative cost that would exceed the ceiling before a story dispatch
**When** `checkCeiling` returns `status: 'exceeded'`
**Then** the story is NOT dispatched
**And** a `cost:ceiling-reached` NDJSON event is emitted with `halt_on: 'none'`, `action: 'stopped'`, and `skipped_stories` listing all stories skipped due to budget
**And** each skipped story is transitioned to `ESCALATED` phase so it appears in the `escalated` bucket of `pipeline:complete`

### AC6: In-Progress Story Completes Normally When Ceiling Is Reached
**Given** a story that is already mid-dispatch (i.e., `processStory` has been called) when cumulative cost exceeds the ceiling
**When** the ceiling check is called for the NEXT story in the processing loop
**Then** the in-progress story runs to completion (dev-story → code-review → terminal)
**And** only subsequent undispatched stories are skipped — enforcement is strictly between dispatches

### AC7: With --halt-on all or --halt-on critical, cost:ceiling-reached Emitted With Severity Field
**Given** `--halt-on all` or `--halt-on critical` and cost ceiling exceeded before a dispatch
**When** `checkCeiling` returns `status: 'exceeded'`
**Then** a `cost:ceiling-reached` event is emitted with `severity: 'critical'` and `halt_on` matching the configured value
**And** remaining stories are halted identically to `--halt-on none` (interactive operator prompt is Epic 54 scope via `DecisionRouter`)

## Tasks / Subtasks

- [ ] Task 1: Implement `CostGovernanceChecker` class (AC: #1, #2)
  - [ ] Create `src/modules/implementation-orchestrator/cost-governance.ts` exporting:
    - `CeilingCheckResult` type: `{ status: 'ok' | 'warning' | 'exceeded'; cumulative: number; ceiling: number; percentUsed: number; estimatedNext: number }`
    - `CostGovernanceChecker` class (pure — no I/O, no side effects):
      - `computeCumulativeCost(manifest: RunManifestData): number` — sums `per_story_state[key].cost_usd ?? 0` for all story keys, then adds `manifest.cost_accumulation.run_total`
      - `estimateNextStoryCost(manifest: RunManifestData): number` — returns the average `cost_usd` of stories that have a non-zero `cost_usd` (completed stories); returns `0` if none exist
      - `checkCeiling(manifest: RunManifestData, ceiling: number): CeilingCheckResult` — computes `percentUsed = (cumulative / ceiling) * 100`; returns `'ok'` if < 80%, `'warning'` if ≥ 80% and < 100%, `'exceeded'` if ≥ 100%
  - [ ] Import `RunManifestData` from `'@substrate-ai/sdlc/run-model/types.js'` (or the local re-export path in the orchestrator module)
  - [ ] The class must be instantiable with `new CostGovernanceChecker()` (no constructor arguments)

- [ ] Task 2: Add `cost:warning` and `cost:ceiling-reached` event types to the NDJSON protocol (AC: #4, #5, #7)
  - [ ] In `src/modules/implementation-orchestrator/event-types.ts`, add two new event interfaces:
    ```typescript
    export interface CostWarningEvent {
      type: 'cost:warning'
      ts: string
      cumulative_cost: number
      ceiling: number
      percent_used: number
    }

    export interface CostCeilingReachedEvent {
      type: 'cost:ceiling-reached'
      ts: string
      cumulative_cost: number
      ceiling: number
      halt_on: string
      /** 'stopped' for all halt-on modes in this story; interactive prompt is Epic 54 scope */
      action: string
      /** Story keys skipped because budget was exhausted */
      skipped_stories: string[]
      /** 'critical' when halt_on is 'all' or 'critical'; absent when 'none' */
      severity?: string
    }
    ```
  - [ ] Add both interfaces to the `PipelineEvent` union (after `VerificationStoryCompleteEvent`)
  - [ ] Add `'cost:warning'` and `'cost:ceiling-reached'` to the `EVENT_TYPE_NAMES` array (maintain alphabetical grouping in comments — add under a `// Story 53-3: cost governance events` comment)
  - [ ] **CRITICAL**: The exhaustiveness check (`_AssertExhaustive`) at the bottom of the file will fail at compile time if the union and the name array are out of sync — verify both are updated

- [ ] Task 3: Update `help-agent.ts` PIPELINE_EVENT_METADATA for new events (AC: #4, #5, #7)
  - [ ] In `src/cli/commands/help-agent.ts`, add two entries to `PIPELINE_EVENT_METADATA`:
    ```typescript
    {
      type: 'cost:warning',
      description: 'Cumulative pipeline cost has crossed 80% of the --cost-ceiling threshold.',
      when: 'Emitted at most once per run, between story dispatches, when cumulative cost ≥ 80% of ceiling.',
      fields: ['ts', 'cumulative_cost', 'ceiling', 'percent_used'],
    },
    {
      type: 'cost:ceiling-reached',
      description: 'Cost ceiling reached — remaining undispatched stories are skipped.',
      when: 'Emitted between story dispatches when cumulative cost ≥ 100% of ceiling.',
      fields: ['ts', 'cumulative_cost', 'ceiling', 'halt_on', 'action', 'skipped_stories', 'severity'],
    },
    ```
  - [ ] Verify that the `PIPELINE_EVENT_METADATA` test (in `src/cli/commands/__tests__/help-agent.test.ts`) covers all EVENT_TYPE_NAMES — the test will fail if a name is added without a corresponding metadata entry

- [ ] Task 4: Integrate ceiling check into `processConflictGroup` in the orchestrator (AC: #3, #4, #6)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`:
    - Import `CostGovernanceChecker` from `'./cost-governance.js'`
    - Instantiate `const _costChecker = new CostGovernanceChecker()` inside `createImplementationOrchestrator` (alongside other module-level state)
    - Add `let _costWarningEmitted = false` and `let _budgetExhausted = false` as closure-level state flags
    - In `processConflictGroup` (line ~3368), at the top of the `for (const storyKey of group)` loop, BEFORE calling `processStory(storyKey, ...)`, add the ceiling check block:
      ```typescript
      if (runManifest !== null) {
        const manifestData = await runManifest.read()
        const ceiling = manifestData.cli_flags.cost_ceiling as number | undefined
        if (ceiling !== undefined && ceiling > 0) {
          const checkResult = _costChecker.checkCeiling(manifestData, ceiling)
          if (checkResult.status === 'warning' && !_costWarningEmitted) {
            _costWarningEmitted = true
            emitNdjsonEvent({ type: 'cost:warning', ts: new Date().toISOString(), cumulative_cost: checkResult.cumulative, ceiling: checkResult.ceiling, percent_used: checkResult.percentUsed })
          }
          if (checkResult.status === 'exceeded') {
            await handleCeilingExceeded(storyKey, group.slice(group.indexOf(storyKey) + 1), checkResult, manifestData)
            return // stop processing remaining stories in this group
          }
        }
      }
      ```
    - The `emitNdjsonEvent` helper already exists in the orchestrator or is accessible via the eventBus. Use the same NDJSON emission pattern used for `verification:check-complete` or `story:stall` events.

- [ ] Task 5: Implement `handleCeilingExceeded` to finalize budget-exhausted dispatch (AC: #5, #7)
  - [ ] Add `async function handleCeilingExceeded(triggeredStoryKey: string, remainingInGroup: string[], result: CeilingCheckResult, manifest: RunManifestData): Promise<void>` inside the orchestrator closure
  - [ ] Compute `haltOn = (manifest.cli_flags.halt_on as string | undefined) ?? 'none'`
  - [ ] Collect `allSkipped: string[]` — the `triggeredStoryKey` plus all `remainingInGroup` plus all stories in `_stories` that are still in `PENDING` phase (not yet dispatched)
  - [ ] For each `skipped` story key, call `updateStory(key, { phase: 'ESCALATED', completedAt: new Date().toISOString() })` — this puts them in the `escalated` bucket of `pipeline:complete`
  - [ ] Best-effort: call `runManifest?.patchStoryState(key, { status: 'escalated' }).catch(() => {})` for each skipped story
  - [ ] Emit `cost:ceiling-reached` via NDJSON with `halt_on: haltOn`, `action: 'stopped'`, `skipped_stories: allSkipped`, and `severity: 'critical'` if `haltOn !== 'none'`
  - [ ] Set `_budgetExhausted = true` so `runWithConcurrency` stops enqueuing new groups
  - [ ] Log at `warn` level: `{ skipped: allSkipped.length, cumulative: result.cumulative, ceiling: result.ceiling }`, message `'Cost ceiling reached — stopping dispatch'`

- [ ] Task 6: Stop `runWithConcurrency` from enqueuing new groups when budget is exhausted (AC: #5, #6)
  - [ ] In the `enqueue()` function inside `runWithConcurrency` (line ~3411), add an early return guard at the top:
    ```typescript
    function enqueue(): void {
      if (_budgetExhausted) return  // budget ceiling reached — no new dispatches
      const group = queue.shift()
      ...
    }
    ```
  - [ ] This ensures that once `_budgetExhausted` is set, no further conflict groups are dequeued, while the currently-running group's in-progress story completes normally (AC6 guarantee)
  - [ ] Verify that the `while (running.size > 0)` loop in `runWithConcurrency` still drains properly — it should, because `Promise.race(running)` settles as running promises complete

- [ ] Task 7: Write unit tests for `CostGovernanceChecker` (AC: #1, #2)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/cost-governance.test.ts` using Vitest
  - [ ] Build minimal `RunManifestData` fixtures via a factory helper (inline, no shared fixture file needed)
  - [ ] Test `computeCumulativeCost`:
    - Empty `per_story_state` and zero `run_total` → returns `0`
    - Three stories with `cost_usd` of `0.10`, `0.20`, `0.30` and `run_total: 0.05` → returns `0.65`
    - Story with `undefined` `cost_usd` is treated as `0`
  - [ ] Test `checkCeiling` status thresholds (ceiling = `5.00`):
    - cumulative `3.90` → `'ok'`, percentUsed = 78
    - cumulative `4.00` → `'warning'`, percentUsed = 80
    - cumulative `4.20` → `'warning'`, percentUsed = 84
    - cumulative `5.00` → `'exceeded'`, percentUsed = 100
    - cumulative `5.10` → `'exceeded'`, percentUsed = 102
    - cumulative `0` → `'ok'`, percentUsed = 0
  - [ ] Test `estimateNextStoryCost`:
    - No stories with `cost_usd` → `0`
    - Two stories with `cost_usd` of `1.00` and `3.00` → `2.00`
    - Mixed: one story with `cost_usd: 2.00`, one with `undefined` → `2.00` (only defined values averaged)
  - [ ] All tests must use `import { describe, it, expect } from 'vitest'` — no Jest imports

- [ ] Task 8: Write integration test for ceiling enforcement in the orchestrator (AC: #3, #4, #5)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/cost-ceiling-enforcement.test.ts`
  - [ ] Use the same mock/stub pattern as `verification-integration.test.ts` — stub `runManifest.read()` to return a pre-built manifest, capture eventBus emissions
  - [ ] Test scenario 1 — **no ceiling configured**: set `cli_flags: {}` in manifest; confirm `processConflictGroup` dispatches normally and emits no cost events
  - [ ] Test scenario 2 — **80% warning**: set cumulative cost at 81% of ceiling; confirm `cost:warning` event is emitted exactly once; confirm story IS dispatched (not skipped)
  - [ ] Test scenario 3 — **ceiling exceeded, halt-on none**: set cumulative cost ≥ ceiling; confirm story is NOT dispatched; confirm `cost:ceiling-reached` event emitted with `action: 'stopped'`; confirm story transitions to ESCALATED phase
  - [ ] Test scenario 4 — **ceiling exceeded, halt-on critical**: same as scenario 3 but with `cli_flags.halt_on: 'critical'`; confirm `cost:ceiling-reached` event has `severity: 'critical'`
  - [ ] Framework: Vitest. File must end in `.test.ts`. Mock `runManifest` as a minimal object: `{ read: vi.fn(), patchStoryState: vi.fn().mockResolvedValue(undefined) }`

## Dev Notes

### Architecture Constraints
- `CostGovernanceChecker` must be **pure** (no I/O, no imports from `src/` — only types from `packages/sdlc/src/run-model/types.js`). All I/O stays in the orchestrator.
- Enforcement is **between dispatches only** — never interrupt a running story (FR-C3a). The check runs at the top of the `for (const storyKey of group)` loop in `processConflictGroup`, before `processStory` is called.
- No new Dolt tables. The `CostAccumulation.run_total` schema (Story 52-8) already exists and is sufficient. No manifest schema changes are needed for the core cost tracking — `per_story_state[key].cost_usd` and `cost_accumulation.run_total` provide all the data.
- Import style: use `.js` extension for ESM compatibility (e.g., `import { CostGovernanceChecker } from './cost-governance.js'`)
- The `_budgetExhausted` flag is a closure-level variable inside `createImplementationOrchestrator`, consistent with `_costWarningEmitted` and other orchestrator state flags.
- Do NOT modify `RunManifestData.run_status` union type in `packages/sdlc/src/run-model/types.ts`. Budget-exhausted stories use `ESCALATED` phase in the orchestrator, which maps to the existing `'stopped'` run_status when all stories are in terminal state.

### Key File Paths
- **New file**: `src/modules/implementation-orchestrator/cost-governance.ts`
- **New tests**: `src/modules/implementation-orchestrator/__tests__/cost-governance.test.ts`
- **New tests**: `src/modules/implementation-orchestrator/__tests__/cost-ceiling-enforcement.test.ts`
- **Modify**: `src/modules/implementation-orchestrator/event-types.ts` — add `CostWarningEvent`, `CostCeilingReachedEvent` to union and `EVENT_TYPE_NAMES`
- **Modify**: `src/cli/commands/help-agent.ts` — add two entries to `PIPELINE_EVENT_METADATA`
- **Modify**: `src/modules/implementation-orchestrator/orchestrator-impl.ts` — import checker, add flags, add check in `processConflictGroup` (~line 3391), add `handleCeilingExceeded` function, guard in `enqueue()` (~line 3411)
- **Reference only (do not modify)**: `packages/sdlc/src/run-model/types.ts`, `packages/sdlc/src/run-model/recovery-history.ts`

### CostGovernanceChecker Class Sketch
```typescript
import type { RunManifestData } from '@substrate-ai/sdlc/run-model/types.js'

export interface CeilingCheckResult {
  status: 'ok' | 'warning' | 'exceeded'
  cumulative: number
  ceiling: number
  percentUsed: number
  estimatedNext: number
}

export class CostGovernanceChecker {
  computeCumulativeCost(manifest: RunManifestData): number {
    const dispatchCost = Object.values(manifest.per_story_state)
      .reduce((sum, s) => sum + (s.cost_usd ?? 0), 0)
    return dispatchCost + manifest.cost_accumulation.run_total
  }

  estimateNextStoryCost(manifest: RunManifestData): number {
    const completed = Object.values(manifest.per_story_state)
      .map((s) => s.cost_usd)
      .filter((c): c is number => c !== undefined && c > 0)
    if (completed.length === 0) return 0
    return completed.reduce((s, c) => s + c, 0) / completed.length
  }

  checkCeiling(manifest: RunManifestData, ceiling: number): CeilingCheckResult {
    const cumulative = this.computeCumulativeCost(manifest)
    const estimatedNext = this.estimateNextStoryCost(manifest)
    const percentUsed = Math.round((cumulative / ceiling) * 10000) / 100
    const status = percentUsed >= 100 ? 'exceeded' : percentUsed >= 80 ? 'warning' : 'ok'
    return { status, cumulative, ceiling, percentUsed, estimatedNext }
  }
}
```

### Integration Point in processConflictGroup
The check is added at the top of the `for (const storyKey of group)` loop in `processConflictGroup` (around line 3372 in `orchestrator-impl.ts`), immediately before the existing `telemetryAdvisor` block. The check reads the manifest on every loop iteration; the manifest read is a fast in-memory or disk operation (<50ms per NFR-P3).

### NDJSON Event Emission Pattern
Examine how `verification:check-complete` events are emitted in `src/modules/implementation-orchestrator/orchestrator-impl.ts` and use the same local emission helper. The helper typically calls `eventBus.emit(...)` which is then forwarded to stdout by the `--events` renderer in `run.ts`. Do NOT write directly to stdout from the orchestrator.

### Cost Data Available in the Manifest
- **Initial dispatch cost**: `per_story_state[storyKey].cost_usd` (set by `patchStoryState` in orchestrator, e.g., line 749)
- **Retry cost**: `cost_accumulation.run_total` (sum of all `RecoveryEntry.cost_usd` values, set by Story 52-8 when recovery entries are appended)
- **Total run cost**: `computeCumulativeCost(manifest)` = initial + retry
- Verification overhead is included because it runs within the story dispatch and is reflected in the story's `cost_usd`

### Event Type Registration Invariant
`event-types.ts` has a compile-time exhaustiveness check at the bottom:
```typescript
type _AssertExhaustive = PipelineEvent['type'] extends PipelineEventType
  ? PipelineEventType extends PipelineEvent['type']
    ? true
    : never
  : never
```
If `PipelineEvent` union and `EVENT_TYPE_NAMES` array diverge, this becomes `never` and tsc fails. The `help-agent.ts` test additionally checks that `PIPELINE_EVENT_METADATA` covers every name in `EVENT_TYPE_NAMES`. Both invariants must be satisfied.

### Testing Requirements
- Framework: Vitest (not Jest) — `import { describe, it, expect, vi } from 'vitest'`
- `CostGovernanceChecker` tests are pure unit tests — no temp directories, no mocks needed
- Integration tests must mock `runManifest` and `eventBus` to avoid real I/O
- All test files must end with `.test.ts` and live in the `__tests__` directory alongside the source file they test
- After implementation: run `npm run test:fast` to confirm all 8398+ existing tests still pass

## Interface Contracts

- **Export**: `CostGovernanceChecker`, `CeilingCheckResult` @ `src/modules/implementation-orchestrator/cost-governance.ts` (consumed by orchestrator-impl.ts and test fixtures)
- **Export**: `CostWarningEvent`, `CostCeilingReachedEvent` @ `src/modules/implementation-orchestrator/event-types.ts` (consumed by run.ts event renderer, supervisor, and help-agent.ts metadata)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-04-06: Story created (Epic 53, Phase D Autonomous Operations) — combines planning sub-stories 53-3a (cost tracking foundation), 53-3b (ceiling enforcement + halt-on), and 53-3c (budget-exhausted finalization)
