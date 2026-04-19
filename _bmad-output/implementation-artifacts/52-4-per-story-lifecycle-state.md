# Story 52-4: Per-Story Lifecycle State

## Story

As a substrate developer,
I want each story's lifecycle state tracked independently in the run manifest,
so that any consumer can determine which stories are complete, in-progress, or failed without querying multiple sources.

## Acceptance Criteria

### AC1: PerStoryState Schema with Extensible Status Type
**Given** the `PerStoryStateSchema` Zod schema exported from `packages/sdlc/src/run-model/per-story-state.ts`
**When** a story state entry is deserialized from the run manifest
**Then** it validates the following fields: `status` (required), `phase` (required), `started_at` (required ISO-8601 string), `completed_at` (optional ISO-8601 string), `verification_result` (optional), `cost_usd` (optional non-negative number)
**And** `status` uses `z.union` with known literals (`pending | dispatched | in-review | complete | failed | escalated | recovered | verification-failed | gated | skipped`) plus a trailing `z.string()` fallback (v0.19.6 extensible union pattern) to accommodate states added in later stories (`gated` from 53-9, `skipped` from 53-3, `recovered` from 54-1)

### AC2: RunManifestData.per_story_state Typed as Record<string, PerStoryState>
**Given** the `RunManifestData` interface in `packages/sdlc/src/run-model/types.ts`
**When** any consumer reads `manifest.per_story_state`
**Then** the TypeScript type is `Record<string, PerStoryState>` (not the placeholder `Record<string, unknown>` from story 52-1)
**And** `RunManifestSchema.per_story_state` validates as `z.record(z.string(), PerStoryStateSchema)`, rejecting entries with missing required fields

### AC3: patchStoryState Method — Atomic Upsert on RunManifest
**Given** a `RunManifest` instance bound to an active run
**When** `patchStoryState(storyKey, updates)` is called with partial `PerStoryState` fields (e.g., `{ status: 'dispatched', started_at: '...' }`)
**Then** the manifest's `per_story_state[storyKey]` is created (if absent) or shallowly merged with `updates` (if present)
**And** the result is written atomically via a single `this.write()` call (no intermediate partial-write state on disk)
**And** fields not included in `updates` on an existing entry are preserved unchanged

### AC4: Dispatched Transition Recorded
**Given** the implementation orchestrator is about to dispatch a story
**When** it transitions a story from `PENDING` to any active phase (e.g., `IN_STORY_CREATION`, `IN_DEV`)
**Then** `patchStoryState(storyKey, { status: 'dispatched', phase: 'dispatched', started_at: <ISO-timestamp> })` is called on the run manifest (best-effort, non-fatal)
**And** `per_story_state[storyKey].started_at` reflects the time the orchestrator began processing the story

### AC5: Terminal Transitions Recorded (complete, escalated, verification-failed)
**Given** the implementation orchestrator finishes processing a story
**When** it calls `updateStory()` with phase `COMPLETE`, `ESCALATED`, or `VERIFICATION_FAILED`
**Then** `patchStoryState(storyKey, { status: <mapped-status>, phase: <mapped-phase>, completed_at: <ISO-timestamp>, cost_usd: <story-cost> })` is called on the run manifest (best-effort, non-fatal)
**And** the manifest status mapping is: `COMPLETE` → `'complete'`, `ESCALATED` → `'escalated'`, `VERIFICATION_FAILED` → `'verification-failed'`
**And** `cost_usd` is populated from the orchestrator's per-story cost data (or `0` if unavailable)

### AC6: Manifest Write Failures are Non-Fatal
**Given** the run manifest write fails during a `patchStoryState` call (e.g., disk full, permission denied)
**When** the orchestrator calls `patchStoryState` during a story transition
**Then** the exception is caught, a `warn`-level log entry is emitted, and orchestrator processing continues normally
**And** the pipeline never aborts due to a manifest write failure (same pattern as `addTokenUsage` from v0.18.0)

### AC7: Backward Compatibility with Empty and Pre-Phase-D Manifests
**Given** a manifest written by story 52-1 or 52-3 with `per_story_state: {}` (empty record)
**When** the manifest is read by code that expects `Record<string, PerStoryState>`
**Then** the empty record is accepted without error by `PerStoryStateSchema` validation
**And** a manifest with unknown `status` values (pre-Phase-D legacy strings) is tolerated by the string fallback in `z.union`, not rejected

## Tasks / Subtasks

- [ ] Task 1: Define PerStoryState interface and Zod schema (AC: #1, #7)
  - [ ] Create `packages/sdlc/src/run-model/per-story-state.ts` with:
    - `PerStoryStatusSchema`: `z.union([z.literal('pending'), z.literal('dispatched'), z.literal('in-review'), z.literal('complete'), z.literal('failed'), z.literal('escalated'), z.literal('recovered'), z.literal('verification-failed'), z.literal('gated'), z.literal('skipped'), z.string()])` — string fallback last per v0.19.6 pattern
    - `PerStoryStateSchema`: `z.object({ status: PerStoryStatusSchema, phase: z.string(), started_at: z.string(), completed_at: z.string().optional(), verification_result: z.unknown().optional(), cost_usd: z.number().nonnegative().optional() })`
    - Export `PerStoryStatus` type (`z.infer<typeof PerStoryStatusSchema>`) and `PerStoryState` type (`z.infer<typeof PerStoryStateSchema>`)
  - [ ] Add JSDoc explaining: `phase` is the low-level orchestrator phase string (e.g., `'IN_DEV'`), `status` is the high-level consumer-facing status

- [ ] Task 2: Update RunManifestData interface and RunManifestSchema (AC: #2, #7)
  - [ ] In `packages/sdlc/src/run-model/types.ts`, change `per_story_state: Record<string, unknown>` → `per_story_state: Record<string, PerStoryState>` (import `PerStoryState` from `./per-story-state.js`)
  - [ ] In `packages/sdlc/src/run-model/schemas.ts`, change `per_story_state: z.record(z.string(), z.unknown())` → `per_story_state: z.record(z.string(), PerStoryStateSchema)` (import from `./per-story-state.js`)
  - [ ] Verify no other files in `packages/sdlc/` directly reference `per_story_state` as `unknown` that would break

- [ ] Task 3: Implement patchStoryState on RunManifest (AC: #3, #6)
  - [ ] In `packages/sdlc/src/run-model/run-manifest.ts`, add instance method:
    ```typescript
    async patchStoryState(storyKey: string, updates: Partial<PerStoryState>): Promise<void>
    ```
  - [ ] Implementation: read current manifest (or create empty if absent), merge `updates` into `per_story_state[storyKey]` using shallow object spread (`{ ...existing, ...updates }`), write the result atomically via `this.write()`
  - [ ] Import `PerStoryState` from `./per-story-state.js`
  - [ ] Add JSDoc noting that callers must wrap in try/catch (non-fatal pattern)

- [ ] Task 4: Update run-model index exports (AC: #1, #2)
  - [ ] In `packages/sdlc/src/run-model/index.ts`, add:
    - `export { PerStoryStatusSchema, PerStoryStateSchema } from './per-story-state.js'`
    - `export type { PerStoryStatus, PerStoryState } from './per-story-state.js'`
  - [ ] Ensure `patchStoryState` is accessible via the already-exported `RunManifest` class (no separate export needed)

- [ ] Task 5: Wire dispatched transition in implementation orchestrator (AC: #4, #6)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, locate the `updateStory()` function and the entry point where a story begins processing (transitions to `IN_STORY_CREATION` or first active phase)
  - [ ] After `updateStory(storyKey, { phase: <active-phase>, startedAt: ... })`, add a best-effort manifest write:
    ```typescript
    if (runManifest) {
      runManifest.patchStoryState(storyKey, {
        status: 'dispatched',
        phase: String(activePhase),
        started_at: new Date().toISOString(),
      }).catch((err) => logger.warn({ err, storyKey }, 'patchStoryState failed — pipeline continues'))
    }
    ```
  - [ ] Thread `runManifest: RunManifest | null` through the relevant closure or pass it as a parameter from the run context (follow the same pattern used for `verificationPipeline` in story 51-5)
  - [ ] `runManifest` is `null` when no manifest exists (pre-Phase-D runs); all writes are skipped

- [ ] Task 6: Wire terminal transitions in implementation orchestrator (AC: #5, #6)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, locate where terminal phases are set (`COMPLETE`, `ESCALATED`, `VERIFICATION_FAILED`) — these are inside `updateStory()` calls or the `writeStoryOutcomeBestEffort` path
  - [ ] Define a helper `mapPhaseToManifestStatus(phase: StoryPhase): PerStoryStatus`:
    - `'COMPLETE'` → `'complete'`
    - `'ESCALATED'` → `'escalated'`
    - `'VERIFICATION_FAILED'` → `'verification-failed'`
    - default → `'dispatched'` (in-progress phases)
  - [ ] After each terminal `updateStory()` call, add a best-effort `runManifest?.patchStoryState(storyKey, { status: mappedStatus, phase: String(phase), completed_at: new Date().toISOString(), cost_usd: costUsd })` wrapped in `.catch((err) => logger.warn(...))`
  - [ ] Source `costUsd` from the per-story cost tracker already available in the orchestrator closure (the same data used for `cost_usd` in `writeStoryMetricsBestEffort`) — default to `0` if not available

- [ ] Task 7: Unit tests for PerStoryState schema and patchStoryState (AC: #1, #2, #3, #7)
  - [ ] Create `packages/sdlc/src/run-model/__tests__/per-story-state.test.ts`
  - [ ] Use `os.tmpdir()` isolated temp directory (same pattern as `run-manifest-write.test.ts`); clean up in `afterEach`
  - [ ] Test: `PerStoryStateSchema` accepts a fully-populated valid entry (AC1)
  - [ ] Test: `PerStoryStateSchema` accepts optional fields as absent (AC1, AC7)
  - [ ] Test: `PerStoryStateSchema` rejects entry missing `status` or `started_at` (AC1)
  - [ ] Test: `PerStoryStateSchema` accepts an unknown `status` string via the fallback literal (AC1, AC7)
  - [ ] Test: `RunManifestSchema` rejects a `per_story_state` entry that fails `PerStoryStateSchema` validation (AC2)
  - [ ] Test: `patchStoryState` creates a new entry when `per_story_state[storyKey]` is absent (AC3)
  - [ ] Test: `patchStoryState` merges updates into an existing entry without clearing other fields (AC3)
  - [ ] Test: two sequential `patchStoryState` calls on different story keys both appear in the final manifest (AC3)

- [ ] Task 8: Unit tests for orchestrator wiring (AC: #4, #5, #6)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/per-story-state-wiring.test.ts`
  - [ ] Mock `RunManifest` with `vi.mock('@substrate-ai/sdlc', ...)` — track calls to `patchStoryState`
  - [ ] Test: when a story starts processing, `patchStoryState` is called with `status: 'dispatched'` and `started_at` set (AC4)
  - [ ] Test: when a story completes (COMPLETE phase), `patchStoryState` is called with `status: 'complete'` and `completed_at` set (AC5)
  - [ ] Test: when a story is escalated, `patchStoryState` is called with `status: 'escalated'` and `completed_at` set (AC5)
  - [ ] Test: when `patchStoryState` throws, the orchestrator does not throw and continues processing (AC6)
  - [ ] Test: when `runManifest` is `null` (no manifest available), orchestrator proceeds without error (AC4, AC6)

## Dev Notes

### Architecture Constraints
- **This story refines story 52-1**: The `per_story_state: Record<string, unknown>` placeholder in 52-1's `types.ts` and `schemas.ts` is intentionally left loose for this story to fill in. Read both files before editing to confirm the exact placeholder location (lines may differ from this story's authorship time).
- **Package placement**: All new types go in `packages/sdlc/src/run-model/per-story-state.ts`. Import path inside the package: `./per-story-state.js` (ESM `.js` extension required). Import from outside the package: `import { PerStoryState } from '@substrate-ai/sdlc'`.
- **Extensible union pattern (v0.19.6)**: The string fallback must be the LAST element in the `z.union` array — Zod evaluates union members in order; a leading `z.string()` would swallow all other literals.
- **Atomic writes**: `patchStoryState` must call `this.write()` exactly once per call. Never write `per_story_state[storyKey]` directly or perform two sequential `write()` calls.
- **Non-fatal everywhere**: All `patchStoryState` call sites in the orchestrator must use `.catch((err) => logger.warn(...))` — never `await` without a catch. Follow the `addTokenUsage` pattern from v0.18.0.
- **Orchestrator RunManifest access**: The `RunManifest` instance is not currently in scope inside `orchestrator-impl.ts`. The cleanest injection point is to pass it alongside the `verificationPipeline` (introduced in story 51-5) — both are optional dependencies initialized at the start of the run. Check `assembleVerificationContext` and `VerificationStore` in `verification-integration.ts` to understand the existing pattern for optional run-context injection.
- **`phase` field semantics**: The `phase` field in `PerStoryState` is typed as `z.string()` (not an enum) because it stores the raw orchestrator `StoryPhase` string (e.g., `'IN_DEV'`, `'IN_REVIEW'`). Consumers should not compare this field — use `status` for state-machine decisions. The `phase` field is informational for debugging.
- **StoryPhase import**: `StoryPhase` is exported from `src/modules/implementation-orchestrator/types.ts`. The `mapPhaseToManifestStatus` helper in Task 6 should accept `StoryPhase` as input.
- **`cost_usd` source**: In the orchestrator, per-story cost is available via the `story:complete` event payload or the `cost_usd` field in `writeStoryMetricsBestEffort`. Use the same source to avoid double-counting.
- **Backward compatibility**: `RunManifestSchema` change from `z.record(z.string(), z.unknown())` to `z.record(z.string(), PerStoryStateSchema)` is a narrowing. It will reject malformed entries that were previously accepted. This is intentional — no pre-Phase-D manifests have `per_story_state` entries. Verify the test for empty record still passes (empty `{}` satisfies `z.record(...)`).

### Testing Requirements
- **Framework**: Vitest. Import from `vitest`, never from `jest`.
- **File I/O in unit tests**: Prefer real temp dirs (`os.tmpdir()`) over mocking `fs/promises` for `patchStoryState` tests — the real atomic write path should be exercised.
- **Orchestrator tests**: Mock `RunManifest` at the module level (`vi.mock('@substrate-ai/sdlc')`). Do not perform real file I/O in orchestrator unit tests.
- **Test file locations**:
  - `packages/sdlc/src/run-model/__tests__/per-story-state.test.ts`
  - `src/modules/implementation-orchestrator/__tests__/per-story-state-wiring.test.ts`
- **Targeted run**: `npm run test:fast` (unit tests only, ~50s). Confirm `pgrep -f vitest` returns nothing before running.
- **Build check**: Run `npm run build` after implementation to catch TypeScript type errors from narrowing `per_story_state`. The type change in `types.ts` and `schemas.ts` may require fixes in files that currently assign to `per_story_state` as `Record<string, unknown>`.

### Key File Paths
| File | Change |
|---|---|
| `packages/sdlc/src/run-model/per-story-state.ts` | **NEW** — PerStoryState interface, Zod schema, PerStoryStatus type |
| `packages/sdlc/src/run-model/types.ts` | **EXTEND** — change `per_story_state: Record<string, unknown>` → `Record<string, PerStoryState>` |
| `packages/sdlc/src/run-model/schemas.ts` | **EXTEND** — change `per_story_state: z.record(z.string(), z.unknown())` → `z.record(z.string(), PerStoryStateSchema)` |
| `packages/sdlc/src/run-model/run-manifest.ts` | **EXTEND** — add `patchStoryState(storyKey, updates)` instance method |
| `packages/sdlc/src/run-model/index.ts` | **EXTEND** — re-export PerStoryStatus, PerStoryState, PerStoryStateSchema, PerStoryStatusSchema |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | **EXTEND** — call patchStoryState on dispatched + terminal transitions |
| `packages/sdlc/src/run-model/__tests__/per-story-state.test.ts` | **NEW** — AC1, AC2, AC3, AC7 tests |
| `src/modules/implementation-orchestrator/__tests__/per-story-state-wiring.test.ts` | **NEW** — AC4, AC5, AC6 tests |

### PerStoryState Schema Reference
```typescript
// packages/sdlc/src/run-model/per-story-state.ts
import { z } from 'zod'

export const PerStoryStatusSchema = z.union([
  z.literal('pending'),
  z.literal('dispatched'),
  z.literal('in-review'),
  z.literal('complete'),
  z.literal('failed'),
  z.literal('escalated'),
  z.literal('recovered'),
  z.literal('verification-failed'),
  z.literal('gated'),
  z.literal('skipped'),
  z.string(), // extensible fallback — must be last
])

export type PerStoryStatus = z.infer<typeof PerStoryStatusSchema>

export const PerStoryStateSchema = z.object({
  /** High-level consumer-facing status (state-machine value). */
  status: PerStoryStatusSchema,
  /** Raw orchestrator StoryPhase string (informational, for debugging). */
  phase: z.string(),
  /** ISO-8601 timestamp when the story entered an active phase. */
  started_at: z.string(),
  /** ISO-8601 timestamp when the story reached a terminal state. */
  completed_at: z.string().optional(),
  /** Verification pipeline result for this story (populated by story 52-7). */
  verification_result: z.unknown().optional(),
  /** Accumulated cost in USD for this story (populated at terminal transition). */
  cost_usd: z.number().nonnegative().optional(),
})

export type PerStoryState = z.infer<typeof PerStoryStateSchema>
```

### patchStoryState Integration Reference
```typescript
// In orchestrator-impl.ts — dispatched transition:
if (runManifest) {
  runManifest
    .patchStoryState(storyKey, {
      status: 'dispatched',
      phase: String(newPhase),
      started_at: new Date().toISOString(),
    })
    .catch((err) =>
      logger.warn({ err, storyKey }, 'patchStoryState(dispatched) failed — pipeline continues'),
    )
}

// In orchestrator-impl.ts — terminal transition helper:
function mapPhaseToManifestStatus(phase: StoryPhase): PerStoryStatus {
  switch (phase) {
    case 'COMPLETE':           return 'complete'
    case 'ESCALATED':          return 'escalated'
    case 'VERIFICATION_FAILED': return 'verification-failed'
    default:                   return 'dispatched'
  }
}
```

## Interface Contracts

- **Import**: `RunManifest` @ `packages/sdlc/src/run-model/run-manifest.ts` (from story 52-1)
- **Import**: `PerStoryState`, `PerStoryStatus` @ `packages/sdlc/src/run-model/per-story-state.ts` (this story)
- **Export**: `PerStoryState`, `PerStoryStatus`, `PerStoryStateSchema`, `PerStoryStatusSchema` @ `packages/sdlc/src/run-model/per-story-state.ts` (consumed by stories 52-5, 52-6, 52-7, 52-8 and all of Epics 53–54)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-06 | Initial story created for Epic 52 Phase D |
