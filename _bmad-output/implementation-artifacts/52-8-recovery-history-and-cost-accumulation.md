# Story 52-8: Recovery History and Cost Accumulation

## Story

As a substrate developer,
I want recovery history and cost accumulation tracked per story in the run manifest,
so that the escalation report and cost governance can operate on durable data.

## Acceptance Criteria

### AC1: RecoveryEntry Schema with All Required Fields
**Given** the `RecoveryEntrySchema` Zod schema exported from `packages/sdlc/src/run-model/recovery-history.ts`
**When** a recovery entry is deserialized from the run manifest
**Then** it validates the following fields: `story_key` (required string), `attempt_number` (required non-negative integer), `strategy` (required string), `root_cause` (required string), `outcome` (required — extensible union of `'retried' | 'escalated' | 'skipped'` plus string fallback), `cost_usd` (required non-negative number), `timestamp` (required ISO-8601 string)
**And** a `RecoveryEntry` TypeScript type is inferred via `z.infer<typeof RecoveryEntrySchema>`

### AC2: CostAccumulation Schema with Per-Story and Run-Total Fields
**Given** the `CostAccumulationSchema` Zod schema exported from `packages/sdlc/src/run-model/recovery-history.ts`
**When** a cost accumulation record is deserialized from the run manifest
**Then** it validates: `per_story` (required `Record<string, number>` mapping `story_key → cumulative USD including retries`) and `run_total` (required non-negative number)
**And** an empty `{ per_story: {}, run_total: 0 }` is valid (used as the initial value when a run starts)
**And** a `CostAccumulation` TypeScript type is inferred via `z.infer<typeof CostAccumulationSchema>`

### AC3: RunManifestData Types Refined for RecoveryEntry[] and CostAccumulation
**Given** the `RunManifestData` interface in `packages/sdlc/src/run-model/types.ts`
**When** any consumer reads `manifest.recovery_history` or `manifest.cost_accumulation`
**Then** the TypeScript type of `recovery_history` is `RecoveryEntry[]` (not the placeholder from story 52-1)
**And** the TypeScript type of `cost_accumulation` is `CostAccumulation` (not the placeholder from story 52-1)
**And** `RunManifestSchema` validates `recovery_history` as `z.array(RecoveryEntrySchema)` and `cost_accumulation` as `CostAccumulationSchema` with a `.default({ per_story: {}, run_total: 0 })` so pre-Phase-D manifests with missing `cost_accumulation` parse without error

### AC4: appendRecoveryEntry Method — Atomic Append and Cost Update
**Given** a `RunManifest` instance bound to an active run
**When** `appendRecoveryEntry(entry: RecoveryEntry)` is called
**Then** `entry` is appended to `recovery_history[]` atomically via a single `this.write()` call (no intermediate partial-write state on disk)
**And** `cost_accumulation.per_story[entry.story_key]` is incremented by `entry.cost_usd` (initialized to `entry.cost_usd` if the key is absent)
**And** `cost_accumulation.run_total` is incremented by `entry.cost_usd`
**And** no other manifest fields are affected by the operation

### AC5: Orchestrator Wires Retry Dispatch to appendRecoveryEntry (Non-Fatal)
**Given** the implementation orchestrator dispatches a story for retry (second or subsequent attempt)
**When** the retry dispatch is initiated
**Then** `runManifest?.appendRecoveryEntry({ story_key, attempt_number, strategy: 'retry-with-context', root_cause, outcome: 'retried', cost_usd, timestamp })` is called best-effort
**And** the call is wrapped in `.catch((err) => logger.warn(...))` — the orchestrator never aborts due to a manifest write failure
**And** when `runManifest` is `null` (pre-Phase-D runs), the retry proceeds normally without any manifest write
**And** `appendRecoveryEntry` is NOT called on the initial (first) dispatch of a story — only on retries

### AC6: Recovery Data Survives Process Crashes
**Given** an `appendRecoveryEntry` call that writes a recovery entry and updates cost accumulation
**When** the manifest is re-read immediately after `appendRecoveryEntry` resolves (simulating a process restart)
**Then** the recovery entry is present in `recovery_history[]`
**And** `cost_accumulation.run_total` reflects the appended entry's cost
**And** crash survival is verified by a unit test that uses real filesystem I/O in `os.tmpdir()` with no mocking of `fs/promises`

### AC7: Backward Compatibility with Pre-Phase-D and Empty Manifests
**Given** a manifest written by story 52-1 with `recovery_history: []` (empty array) and either missing or minimal `cost_accumulation`
**When** the manifest is read by Phase-D code expecting typed `RecoveryEntry[]` and `CostAccumulation`
**Then** the empty array satisfies `z.array(RecoveryEntrySchema)` validation without error
**And** a manifest with missing `cost_accumulation` is coerced to `{ per_story: {}, run_total: 0 }` via Zod `.default()`, not rejected
**And** a manifest with an unknown `outcome` string in an existing recovery entry is tolerated by the string fallback in `RecoveryOutcomeSchema`, not rejected

## Tasks / Subtasks

- [ ] Task 1: Define RecoveryEntry and CostAccumulation schemas (AC: #1, #2)
  - [ ] Create `packages/sdlc/src/run-model/recovery-history.ts` with:
    - `RecoveryOutcomeSchema`: `z.union([z.literal('retried'), z.literal('escalated'), z.literal('skipped'), z.string()])` — string fallback last (v0.19.6 extensible union pattern)
    - `RecoveryEntrySchema`: `z.object({ story_key: z.string(), attempt_number: z.number().int().nonnegative(), strategy: z.string(), root_cause: z.string(), outcome: RecoveryOutcomeSchema, cost_usd: z.number().nonnegative(), timestamp: z.string() })`
    - `CostAccumulationSchema`: `z.object({ per_story: z.record(z.string(), z.number().nonnegative()), run_total: z.number().nonnegative() })`
    - Export `RecoveryEntry`, `CostAccumulation`, `RecoveryOutcome` TypeScript types via `z.infer<>`
  - [ ] Add JSDoc to each schema explaining field semantics: `attempt_number` is 1-indexed (1 = first retry, not initial dispatch); `strategy` is free-form (e.g., `'retry-with-context'`); `cost_usd` on the entry is cost of this attempt only (not cumulative)

- [ ] Task 2: Update RunManifestData interface and RunManifestSchema (AC: #3, #7)
  - [ ] Read `packages/sdlc/src/run-model/types.ts` to locate the current placeholder for `recovery_history` and `cost_accumulation` (likely stub types from story 52-1's task 1); replace both with typed imports: `import type { RecoveryEntry, CostAccumulation } from './recovery-history.js'`
  - [ ] Read `packages/sdlc/src/run-model/schemas.ts` to locate stub `RecoveryEntrySchema` and `CostAccumulationSchema` (created by 52-1 as per its task 1 instruction); replace both with imports from `./recovery-history.js`
  - [ ] In `packages/sdlc/src/run-model/schemas.ts`, update the `RunManifestSchema` field for `cost_accumulation` to use `CostAccumulationSchema.default({ per_story: {}, run_total: 0 })` so pre-Phase-D manifests that omit this field parse without error (AC7)
  - [ ] Verify that `recovery_history: z.array(RecoveryEntrySchema)` in `RunManifestSchema` accepts `[]` without error

- [ ] Task 3: Implement appendRecoveryEntry on RunManifest (AC: #4, #6)
  - [ ] In `packages/sdlc/src/run-model/run-manifest.ts`, add instance method:
    ```typescript
    async appendRecoveryEntry(entry: RecoveryEntry): Promise<void>
    ```
  - [ ] Implementation: read current manifest data, append `entry` to `recovery_history[]`, increment `cost_accumulation.per_story[entry.story_key]` by `entry.cost_usd` (`(existing ?? 0) + entry.cost_usd`), increment `cost_accumulation.run_total` by `entry.cost_usd`, write atomically via a single `this.write()` call
  - [ ] Import `RecoveryEntry` from `./recovery-history.js`
  - [ ] Add JSDoc noting that callers must wrap in `.catch()` (non-fatal pattern, same as `patchStoryState` from story 52-4)

- [ ] Task 4: Update run-model index exports (AC: #1, #2, #3)
  - [ ] In `packages/sdlc/src/run-model/index.ts`, add:
    - `export { RecoveryEntrySchema, CostAccumulationSchema, RecoveryOutcomeSchema } from './recovery-history.js'`
    - `export type { RecoveryEntry, CostAccumulation, RecoveryOutcome } from './recovery-history.js'`
  - [ ] Confirm `appendRecoveryEntry` is accessible via the already-exported `RunManifest` class (no separate export needed)

- [ ] Task 5: Wire orchestrator retry dispatch to appendRecoveryEntry (AC: #5, #6)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, locate the retry dispatch path — the code that re-dispatches a story after failure (likely guarded by the `--max-review-cycles` counter or triggered by `ESCALATED`/`VERIFICATION_FAILED` phase transitions)
  - [ ] After each retry dispatch decision (not the initial dispatch), add a best-effort manifest write:
    ```typescript
    if (runManifest) {
      runManifest
        .appendRecoveryEntry({
          story_key: storyKey,
          attempt_number: currentAttempt,  // 1-indexed retry count
          strategy: 'retry-with-context',
          root_cause: failureReason ?? 'unknown',
          outcome: 'retried',
          cost_usd: storyCostUsd ?? 0,
          timestamp: new Date().toISOString(),
        })
        .catch((err) =>
          logger.warn({ err, storyKey }, 'appendRecoveryEntry failed — pipeline continues'),
        )
    }
    ```
  - [ ] Source `currentAttempt` from the existing retry counter already used to enforce `maxReviewCycles`
  - [ ] Source `failureReason` from any available error classification string (escalation reason, failure message); default to `'unknown'` if not available
  - [ ] Source `storyCostUsd` from the per-story cost tracker (same source used by `writeStoryMetricsBestEffort` and `patchStoryState` in story 52-4); default to `0` if unavailable
  - [ ] Thread `runManifest: RunManifest | null` through the closure using the same injection pattern established by story 52-4 for `patchStoryState`; if 52-4 has already threaded it, reuse that reference

- [ ] Task 6: Unit tests for RecoveryEntry and CostAccumulation schemas (AC: #1, #2, #7)
  - [ ] Create `packages/sdlc/src/run-model/__tests__/recovery-history.test.ts`
  - [ ] Test: `RecoveryEntrySchema` accepts a fully-populated valid entry (AC1)
  - [ ] Test: `RecoveryEntrySchema` rejects an entry with `attempt_number: -1` (AC1)
  - [ ] Test: `RecoveryEntrySchema` rejects an entry missing `story_key` or `timestamp` (AC1)
  - [ ] Test: `RecoveryEntrySchema` accepts an unknown `outcome` string via the string fallback (AC1, AC7)
  - [ ] Test: `CostAccumulationSchema` accepts `{ per_story: {}, run_total: 0 }` (AC2)
  - [ ] Test: `CostAccumulationSchema` rejects negative `run_total` (AC2)
  - [ ] Test: `RunManifestSchema` validates `recovery_history: []` (empty array) without error (AC7)
  - [ ] Test: `RunManifestSchema` coerces a manifest with no `cost_accumulation` field to `{ per_story: {}, run_total: 0 }` via `.default()` (AC7)

- [ ] Task 7: Unit tests for appendRecoveryEntry method (AC: #4, #6, #7)
  - [ ] Create `packages/sdlc/src/run-model/__tests__/recovery-history-manifest.test.ts`
  - [ ] Use `os.tmpdir()` isolated temp directory; clean up in `afterEach` (same pattern as `run-manifest-write.test.ts` from story 52-1)
  - [ ] Test: `appendRecoveryEntry` adds a new entry to `recovery_history[]` and the entry is readable on re-read (AC4, AC6)
  - [ ] Test: `appendRecoveryEntry` sets `cost_accumulation.per_story[storyKey]` to `entry.cost_usd` on first call for a story (AC4)
  - [ ] Test: two sequential `appendRecoveryEntry` calls for the same story accumulate `per_story` and `run_total` correctly (AC4)
  - [ ] Test: two sequential `appendRecoveryEntry` calls for different stories accumulate `run_total` as the sum of both entries (AC4)
  - [ ] Test: `appendRecoveryEntry` on a manifest with pre-existing `recovery_history: []` appends without error (AC7)
  - [ ] Test: after `appendRecoveryEntry` resolves, re-reading the manifest from the `.json` file (not from any in-memory cache) confirms the entry is persisted — real file I/O, no `fs/promises` mocking (AC6)

- [ ] Task 8: Unit tests for orchestrator wiring (AC: #5)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/recovery-history-wiring.test.ts`
  - [ ] Mock `RunManifest` via `vi.mock('@substrate-ai/sdlc', ...)` — track calls to `appendRecoveryEntry`
  - [ ] Test: when a story is retried, `appendRecoveryEntry` is called with `outcome: 'retried'` and `attempt_number >= 1` (AC5)
  - [ ] Test: when `appendRecoveryEntry` throws, the orchestrator does not throw and continues (AC5)
  - [ ] Test: when `runManifest` is `null`, the orchestrator retries the story without error (AC5)
  - [ ] Test: `appendRecoveryEntry` is NOT called on the initial (first) dispatch of a story (AC5)

## Dev Notes

### Architecture Constraints
- **This story refines story 52-1**: The `recovery_history` and `cost_accumulation` fields in 52-1's `types.ts` and `schemas.ts` were created as placeholders per story 52-1 task 1 ("Export `RecoveryEntry`, `CostAccumulation`, and `Proposal` sub-schemas from `schemas.ts` with appropriate Zod definitions"). Read both files before editing to confirm the exact placeholder shape — they may be `z.unknown()`, `z.any()`, or minimal stubs.
- **Package placement**: All new types go in `packages/sdlc/src/run-model/recovery-history.ts`. Import path inside the package uses ESM `.js` extension: `./recovery-history.js`. Import from outside the package: `import { RecoveryEntry, CostAccumulation } from '@substrate-ai/sdlc'`.
- **Extensible union pattern (v0.19.6)**: The string fallback must be the LAST element in `z.union` — Zod evaluates members in order; a leading `z.string()` swallows all other literals. Follow `PerStoryStatusSchema` from story 52-4 exactly.
- **Atomic writes**: `appendRecoveryEntry` must call `this.write()` exactly once per invocation. Never write `recovery_history` or `cost_accumulation` directly or perform two sequential `write()` calls — this would create a window where the two fields are inconsistent on disk.
- **Non-fatal everywhere**: All `appendRecoveryEntry` call sites in the orchestrator must use `.catch((err) => logger.warn(...))`. Follow the `addTokenUsage` (v0.18.0) and `patchStoryState` (story 52-4) patterns exactly.
- **cost_usd semantics**: `RecoveryEntry.cost_usd` is the cost of that single retry attempt only. `CostAccumulation.per_story[storyKey]` is the running total across all attempts for that story (initial dispatch cost from `PerStoryState.cost_usd` is separate — do NOT double-count it here). `CostAccumulation.run_total` is the sum of all `RecoveryEntry.cost_usd` values, not the sum of all story costs.
- **No new CLI commands**: This story is infrastructure-only. Cost governance enforcement (ceiling checks, `cost:warning` events) is implemented in Epic 53.
- **Dolt NOT updated**: Cost data is maintained exclusively in the run manifest JSON for operational use. The existing Dolt `pipeline_runs` cost tracking via `token_usage_json` is unchanged. Dolt remains the analytics projection.
- **`runManifest` threading**: Follow the injection pattern established in story 52-4 for `patchStoryState`. If story 52-4 has already threaded `RunManifest | null` through `orchestrator-impl.ts`, reuse that reference. Do not create a second injection point.
- **No Proposal schema in this story**: Story 52-1 also listed `Proposal` as a sub-schema to export. The `Proposal` type (for `pending_proposals[]`) is out of scope for 52-8 — it belongs to the recovery engine in Epic 54. If the placeholder for `Proposal` exists in `schemas.ts`, leave it as-is.

### Testing Requirements
- **Framework**: Vitest. Import from `vitest`, never from `jest`.
- **File I/O in unit tests**: Prefer real temp dirs (`os.tmpdir()`) over mocking `fs/promises` for `appendRecoveryEntry` tests — the real atomic write path must be exercised (same as `patchStoryState` tests in story 52-4).
- **Orchestrator tests**: Mock `RunManifest` at the module level (`vi.mock('@substrate-ai/sdlc')`). Do not perform real file I/O in orchestrator unit tests.
- **Test file locations**:
  - `packages/sdlc/src/run-model/__tests__/recovery-history.test.ts` — schema unit tests (Tasks 6)
  - `packages/sdlc/src/run-model/__tests__/recovery-history-manifest.test.ts` — manifest I/O tests (Task 7)
  - `src/modules/implementation-orchestrator/__tests__/recovery-history-wiring.test.ts` — orchestrator wiring tests (Task 8)
- **Targeted run**: `npm run test:fast` (unit tests only, ~50s). Confirm `pgrep -f vitest` returns nothing before running.
- **Build check**: Run `npm run build` after implementation to catch TypeScript errors from narrowing `recovery_history` and `cost_accumulation`. Any file that assigned to these fields as `unknown` in story 52-1's output will need to be updated.

### Key File Paths
| File | Change |
|---|---|
| `packages/sdlc/src/run-model/recovery-history.ts` | **NEW** — RecoveryEntry, CostAccumulation, RecoveryOutcome schemas and types |
| `packages/sdlc/src/run-model/types.ts` | **EXTEND** — narrow `recovery_history` and `cost_accumulation` placeholders to typed imports from `./recovery-history.js` |
| `packages/sdlc/src/run-model/schemas.ts` | **EXTEND** — replace stub schemas with imports from `./recovery-history.js`; add `.default()` on `cost_accumulation` |
| `packages/sdlc/src/run-model/run-manifest.ts` | **EXTEND** — add `appendRecoveryEntry(entry: RecoveryEntry): Promise<void>` instance method |
| `packages/sdlc/src/run-model/index.ts` | **EXTEND** — re-export RecoveryEntry, CostAccumulation, RecoveryOutcome and their Zod schemas |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | **EXTEND** — call `appendRecoveryEntry` on retry dispatch transitions (non-fatal, best-effort) |
| `packages/sdlc/src/run-model/__tests__/recovery-history.test.ts` | **NEW** — AC1, AC2, AC7 schema unit tests |
| `packages/sdlc/src/run-model/__tests__/recovery-history-manifest.test.ts` | **NEW** — AC4, AC6, AC7 manifest I/O tests |
| `src/modules/implementation-orchestrator/__tests__/recovery-history-wiring.test.ts` | **NEW** — AC5 orchestrator wiring tests |

### RecoveryEntry Schema Reference
```typescript
// packages/sdlc/src/run-model/recovery-history.ts
import { z } from 'zod'

export const RecoveryOutcomeSchema = z.union([
  z.literal('retried'),
  z.literal('escalated'),
  z.literal('skipped'),
  z.string(), // extensible fallback — must be last (v0.19.6 pattern)
])

export type RecoveryOutcome = z.infer<typeof RecoveryOutcomeSchema>

export const RecoveryEntrySchema = z.object({
  /** Story key that triggered this recovery attempt (e.g. '52-8'). */
  story_key: z.string(),
  /** 1-indexed attempt number — 1 = first retry, not initial dispatch. */
  attempt_number: z.number().int().nonnegative(),
  /** Recovery strategy applied (e.g., 'retry-with-context', 're-scope'). */
  strategy: z.string(),
  /** Root cause classification string (informational, for completion report). */
  root_cause: z.string(),
  /** Outcome of this recovery attempt. */
  outcome: RecoveryOutcomeSchema,
  /** Cost of this single retry attempt in USD (NOT cumulative). */
  cost_usd: z.number().nonnegative(),
  /** ISO-8601 timestamp when this recovery was initiated. */
  timestamp: z.string(),
})

export type RecoveryEntry = z.infer<typeof RecoveryEntrySchema>

export const CostAccumulationSchema = z.object({
  /**
   * Per-story cumulative retry cost in USD.
   * Maps story_key → sum of all RecoveryEntry.cost_usd for that story.
   * Does NOT include the initial dispatch cost (tracked in PerStoryState.cost_usd).
   */
  per_story: z.record(z.string(), z.number().nonnegative()),
  /**
   * Total retry cost for the entire run in USD.
   * Equal to sum of all RecoveryEntry.cost_usd values.
   */
  run_total: z.number().nonnegative(),
})

export type CostAccumulation = z.infer<typeof CostAccumulationSchema>
```

### appendRecoveryEntry Integration Reference
```typescript
// packages/sdlc/src/run-model/run-manifest.ts (method to add)
async appendRecoveryEntry(entry: RecoveryEntry): Promise<void> {
  const current = await this.read()
  const prevStory = current.cost_accumulation.per_story[entry.story_key] ?? 0
  const updated: RunManifestData = {
    ...current,
    recovery_history: [...current.recovery_history, entry],
    cost_accumulation: {
      per_story: {
        ...current.cost_accumulation.per_story,
        [entry.story_key]: prevStory + entry.cost_usd,
      },
      run_total: current.cost_accumulation.run_total + entry.cost_usd,
    },
  }
  await this.write(updated)
}

// In orchestrator-impl.ts — retry dispatch (non-fatal, best-effort):
if (runManifest) {
  runManifest
    .appendRecoveryEntry({
      story_key: storyKey,
      attempt_number: currentAttempt, // 1-indexed retry count
      strategy: 'retry-with-context',
      root_cause: failureReason ?? 'unknown',
      outcome: 'retried',
      cost_usd: storyCostUsd ?? 0,
      timestamp: new Date().toISOString(),
    })
    .catch((err) =>
      logger.warn({ err, storyKey }, 'appendRecoveryEntry failed — pipeline continues'),
    )
}
```

## Interface Contracts

- **Import**: `RunManifest`, `RunManifestData` @ `packages/sdlc/src/run-model/run-manifest.ts` (from story 52-1)
- **Import**: `PerStoryState` @ `packages/sdlc/src/run-model/per-story-state.ts` (from story 52-4 — `cost_usd` on PerStoryState is the initial dispatch cost; RecoveryEntry.cost_usd is retry cost only)
- **Export**: `RecoveryEntry`, `RecoveryEntrySchema` @ `packages/sdlc/src/run-model/recovery-history.ts` (consumed by Epic 53 cost governance and Epic 54 recovery engine)
- **Export**: `CostAccumulation`, `CostAccumulationSchema` @ `packages/sdlc/src/run-model/recovery-history.ts` (consumed by Epic 53 cost ceiling enforcement)
- **Export**: `RecoveryOutcome`, `RecoveryOutcomeSchema` @ `packages/sdlc/src/run-model/recovery-history.ts` (consumed by Epic 54 recovery engine classification)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-06 | Initial story created for Epic 52 Phase D |
