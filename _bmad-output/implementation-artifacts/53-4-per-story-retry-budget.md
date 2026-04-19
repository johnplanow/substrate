# Story 53-4: Per-Story Retry Budget

## Story

As a substrate developer,
I want a configurable maximum retry count per story,
so that the system doesn't endlessly retry non-recoverable failures.

## Acceptance Criteria

### AC1: retry_count Field in PerStoryState Schema
**Given** a `PerStoryState` entry in the run manifest
**When** the schema is parsed (including manifests written before this story shipped)
**Then** `retry_count` is present with a default value of `0` (backward compatible — existing manifests without the field parse without error)

### AC2: retry_budget Config Field in SubstrateConfig
**Given** a `substrate.config.json` with `"retry_budget": 3`
**When** the config is loaded via `SubstrateConfigSchema.parse()`
**Then** `config.retry_budget` equals `3`
**And** when the field is absent, `config.retry_budget` is `undefined` and the effective default of `2` applies at the orchestrator level

### AC3: retryBudget Wired into OrchestratorConfig
**Given** a `SubstrateConfig` with `retry_budget: 3`
**When** `createImplementationOrchestrator` is called in `run.ts`
**Then** `config.retryBudget` equals `3` (read from `substrateConfig.retry_budget ?? 2`)
**And** when `retry_budget` is absent from SubstrateConfig, `config.retryBudget` defaults to `2`

### AC4: retry_count Incremented on Each Retry Attempt
**Given** a story in the code-review loop on review cycle ≥ 1 (i.e., a retry)
**When** the orchestrator begins a non-initial review cycle
**Then** `patchStoryState(storyKey, { retry_count: <incremented value> })` is called on the run manifest (best-effort, non-fatal if manifest unavailable)
**And** the incremented count reflects the number of retries taken so far (first retry → `retry_count: 1`)

### AC5: Budget Gate Enforced Before Each Retry
**Given** a story whose `retry_count` in the run manifest has reached `retryBudget`
**When** the orchestrator would otherwise begin another review cycle retry
**Then** the story is escalated immediately with reason `'retry_budget_exhausted'`
**And** the escalation event carries `retryBudget` and `retry_count` in its payload
**And** this escalation cannot be overridden by learning loop suggestions (enforced unconditionally before any retry logic runs)

### AC6: Budget Gate Uses Manifest retry_count for Durability
**Given** a pipeline run that crashed mid-retry and was resumed
**When** the orchestrator re-processes the story
**Then** it reads `retry_count` from the run manifest (not in-memory state) to initialize its local counter
**And** the budget gate correctly accounts for retries from the previous session

### AC7: Default retry_budget is 2
**Given** no `retry_budget` in SubstrateConfig and no `--retry-budget` CLI flag
**When** a story exhausts its retries
**Then** escalation occurs after 2 retry attempts (i.e., when `retry_count` reaches 2)

## Tasks / Subtasks

- [ ] Task 1: Add `retry_count` to `PerStoryStateSchema` (AC: #1, #6)
  - [ ] In `packages/sdlc/src/run-model/per-story-state.ts`, add `retry_count: z.number().int().nonnegative().default(0).optional()` to `PerStoryStateSchema` after the existing `dispatches` field — use `.optional()` so pre-existing manifests without the field parse without error; consumers treat `undefined` as `0`
  - [ ] The field comment: `/** Number of retry attempts for this story (code review retries + recovery-engine retries). Initial dispatch is not counted. */`
  - [ ] No migration needed — `.optional()` with logical default `0` provides full backward compatibility

- [ ] Task 2: Add `retry_budget` to SubstrateConfig (AC: #2)
  - [ ] In `src/modules/config/config-schema.ts`, add `retry_budget: z.number().int().positive().optional()` to both `SubstrateConfigSchema` and `PartialSubstrateConfigSchema` (both use `.strict()` — the field must be named in both schemas)
  - [ ] Field comment: `/** Per-story maximum retry count before mandatory escalation (Story 53-4 AC7). Default: 2. */`
  - [ ] Place after `supervisor_poll_interval_seconds` (the most recent addition from Story 53-1) to preserve existing field ordering

- [ ] Task 3: Add `retryBudget` to `OrchestratorConfig` (AC: #3)
  - [ ] In `src/modules/implementation-orchestrator/types.ts`, add `retryBudget?: number` to `OrchestratorConfig` after `maxReviewCycles`
  - [ ] Field JSDoc: `/** Per-story maximum retry attempts before mandatory escalation. Default: 2 (Story 53-4). */`
  - [ ] In `src/cli/commands/run.ts`, in the linear-engine branch where `createImplementationOrchestrator` is called (~line 1563), add `retryBudget: substrateConfig?.retry_budget ?? 2` to the `config` object
  - [ ] Also add the same field in any graph-engine or graph-orchestrator config construction that accepts `maxReviewCycles` (search for both `maxReviewCycles: effectiveMaxReviewCycles` call sites in run.ts)

- [ ] Task 4: Implement budget gate and retry_count tracking in orchestrator (AC: #4, #5, #6)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, add a module-level `Map<string, number>` named `_storyRetryCount` (parallel to the existing `_storyDispatches` map) to track in-memory retry counts — initialized from the manifest on story start
  - [ ] Add helper `async function initRetryCount(storyKey: string): Promise<void>` that reads `runManifest?.read()` (or the manifest's `per_story_state[storyKey].retry_count ?? 0`) and populates `_storyRetryCount` for crash-recovery durability (AC6) — called at the top of `processStory` after the memory pressure check
  - [ ] Add helper `function incrementRetryCount(storyKey: string): void` that increments `_storyRetryCount` and calls `runManifest?.patchStoryState(storyKey, { retry_count: _storyRetryCount.get(storyKey) }).catch(...)` (best-effort, non-fatal)
  - [ ] In the code-review `while (keepReviewing)` loop (around line 2558), immediately after `if (reviewCycles === 0) startPhase(storyKey, 'code-review')`, add a budget gate block **before** incrementing `reviewCycles`:
    ```typescript
    if (reviewCycles > 0) {
      // This is a retry attempt — check budget before proceeding
      const currentRetries = _storyRetryCount.get(storyKey) ?? 0
      const budget = config.retryBudget ?? 2
      if (currentRetries >= budget) {
        // Budget exhausted — mandatory escalation, cannot be overridden
        endPhase(storyKey, 'code-review')
        updateStory(storyKey, {
          phase: 'ESCALATED' as StoryPhase,
          reviewCycles,
          completedAt: new Date().toISOString(),
          error: 'retry_budget_exhausted',
        })
        await writeStoryMetricsBestEffort(storyKey, 'escalated', reviewCycles)
        await emitEscalation({
          storyKey,
          lastVerdict: 'retry_budget_exhausted',
          reviewCycles,
          issues: [`Retry budget exhausted: ${currentRetries}/${budget} retries used`],
        })
        await persistState()
        return
      }
      // Budget not exhausted — increment counter and proceed
      incrementRetryCount(storyKey)
    }
    ```
  - [ ] Ensure `_storyRetryCount` is cleared/reset when a story starts fresh (in the same location `_storyDispatches` is cleared on story start, if any)

- [ ] Task 5: Write unit tests (AC: #1, #2, #4, #5, #7)
  - [ ] Create `packages/sdlc/src/run-model/__tests__/per-story-retry-budget.test.ts` using Vitest
    - Test: `PerStoryStateSchema.parse({ status: 'pending', phase: 'IN_DEV', started_at: '...' })` succeeds and `retry_count` equals `undefined` or `0` (backward compat — manifests without the field should parse)
    - Test: `PerStoryStateSchema.parse({ ..., retry_count: 3 })` yields `retry_count === 3`
    - Test: `PerStoryStateSchema.parse({ ..., retry_count: -1 })` throws (nonnegative constraint)
  - [ ] Create `src/modules/config/__tests__/retry-budget-config.test.ts` using Vitest
    - Test: `SubstrateConfigSchema.parse({ ...minimalValidConfig, retry_budget: 3 })` yields `retry_budget === 3`
    - Test: `SubstrateConfigSchema.parse({ ...minimalValidConfig })` yields `retry_budget === undefined`
    - Test: `SubstrateConfigSchema.parse({ ...minimalValidConfig, retry_budget: 0 })` throws (must be positive)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/retry-budget-gate.test.ts` using Vitest
    - Unit test the budget gate logic: mock a story that has `retry_count >= retryBudget` and verify escalation is triggered without calling the code-review dispatcher
    - Test that `retry_count = 0` allows the retry to proceed
    - Test that `retry_count = 1` with `retryBudget = 2` allows one more retry then blocks
    - Test that `retryBudget` defaults to `2` when not set in config

## Dev Notes

### Architecture Constraints
- `retry_count` field is added to `PerStoryStateSchema` in `packages/sdlc/src/run-model/per-story-state.ts` — this is the canonical persistent store for retry tracking
- `retry_budget` is added to `SubstrateConfig` in `src/modules/config/config-schema.ts` — both `SubstrateConfigSchema` and `PartialSubstrateConfigSchema` use `.strict()` and require explicit field declarations
- `retryBudget` in `OrchestratorConfig` (types.ts) is the runtime value — derived from `substrateConfig.retry_budget ?? 2` at orchestrator creation time
- The in-memory `_storyRetryCount` map shadows the manifest value for performance; the manifest is the durable source (read on resume/restart per AC6)
- Budget gate is positioned BEFORE any retry dispatch — it is unconditional and cannot be bypassed by future learning loop logic (AC5)
- Import style: use `.js` extension for all ESM imports (e.g., `import { ... } from './per-story-state.js'`)

### Key File Paths
- **Modify:** `packages/sdlc/src/run-model/per-story-state.ts` — add `retry_count` field to `PerStoryStateSchema`
- **Modify:** `src/modules/config/config-schema.ts` — add `retry_budget` to both schema objects
- **Modify:** `src/modules/implementation-orchestrator/types.ts` — add `retryBudget?: number` to `OrchestratorConfig`
- **Modify:** `src/cli/commands/run.ts` — wire `retryBudget` into both linear-engine and graph-engine orchestrator configs
- **Modify:** `src/modules/implementation-orchestrator/orchestrator-impl.ts` — add `_storyRetryCount` map, `initRetryCount()`, `incrementRetryCount()`, and budget gate in review loop
- **New tests:** `packages/sdlc/src/run-model/__tests__/per-story-retry-budget.test.ts`
- **New tests:** `src/modules/config/__tests__/retry-budget-config.test.ts`
- **New tests:** `src/modules/implementation-orchestrator/__tests__/retry-budget-gate.test.ts`

### RunManifest patchStoryState Pattern (from Story 52-4)
```typescript
// Best-effort pattern used throughout orchestrator-impl.ts
if (runManifest !== null) {
  runManifest
    .patchStoryState(storyKey, { retry_count: newCount })
    .catch((err: unknown) =>
      logger.warn({ err, storyKey }, 'patchStoryState(retry_count) failed — pipeline continues'),
    )
}
```

### Crash Recovery: Reading retry_count on Resume (AC6)
```typescript
async function initRetryCount(storyKey: string): Promise<void> {
  if (runManifest === null) return
  try {
    const data = await runManifest.read()
    const storyState = data.per_story_state[storyKey]
    const existingCount = storyState?.retry_count ?? 0
    _storyRetryCount.set(storyKey, existingCount)
  } catch (err) {
    logger.warn({ err, storyKey }, 'initRetryCount: failed to read manifest — starting at 0')
    _storyRetryCount.set(storyKey, 0)
  }
}
```

### Budget Gate Placement in Review Loop
The review loop in `orchestrator-impl.ts` starts around line 2553:
```typescript
let reviewCycles = 0
let keepReviewing = true
// ...
while (keepReviewing) {
  // Budget gate MUST be placed here — before any new dispatch
  // reviewCycles === 0 → initial dev dispatch (not a retry, skip gate)
  // reviewCycles > 0  → retry attempt — check budget
  if (reviewCycles > 0) {
    const currentRetries = _storyRetryCount.get(storyKey) ?? 0
    const budget = config.retryBudget ?? 2
    if (currentRetries >= budget) {
      // ... mandatory escalation (see Task 4)
      return
    }
    incrementRetryCount(storyKey)
  }
  // ... existing review dispatch logic
}
```

### SubstrateConfig Schema Extension Pattern
Both SubstrateConfigSchema and PartialSubstrateConfigSchema use `.strict()` — add `retry_budget` to BOTH or TypeScript will reject configs that include it:
```typescript
// In SubstrateConfigSchema:
retry_budget: z.number().int().positive().optional(),

// In PartialSubstrateConfigSchema (same):
retry_budget: z.number().int().positive().optional(),
```

### Testing Requirements
- Framework: Vitest (not Jest) — `import { describe, it, expect } from 'vitest'`
- Schema tests: use `PerStoryStateSchema.parse()` and `SubstrateConfigSchema.parse()` directly — no I/O needed
- Orchestrator gate tests: mock `runManifest` and the review cycle dispatch to verify the gate fires correctly
- The backward-compat test for `PerStoryState` is critical: parsing a manifest entry without `retry_count` must not throw

## Interface Contracts

- **Export**: `retry_count` field on `PerStoryStateSchema` @ `packages/sdlc/src/run-model/per-story-state.ts` (consumed by story 53-5 root cause taxonomy — `retry_count` will be included in finding metadata, and by story 54-x RecoveryEngine — which reads and enforces the same budget)
- **Export**: `retry_budget` @ `src/modules/config/config-schema.ts` (consumed by `run.ts` and future `RecoveryEngine` in Epic 54)
- **Export**: `retryBudget` on `OrchestratorConfig` @ `src/modules/implementation-orchestrator/types.ts` (consumed by orchestrator-impl.ts and graph-engine orchestrator)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-04-06: Story created (Epic 53, Phase D Autonomous Operations)
