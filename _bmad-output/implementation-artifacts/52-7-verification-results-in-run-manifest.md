# Story 52-7: Verification Results in Run Manifest

## Story

As a substrate developer,
I want Epic 51's verification check results persisted to the run manifest per story,
so that verification outcomes survive process crashes and are available to downstream consumers (completion reports, escalation recovery) without relying on in-memory state.

## Acceptance Criteria

### AC1: StoredVerificationSummary Zod Schema Defined in run-model
**Given** the new file `packages/sdlc/src/run-model/verification-result.ts`
**When** a `VerificationSummary` (from Epic 51) is ready to be stored in the manifest
**Then** the file exports `StoredVerificationCheckResultSchema` (fields: `checkName: z.string()`, `status: z.enum(['pass','warn','fail'])`, `details: z.string()`, `duration_ms: z.number().nonneg()`) and `StoredVerificationSummarySchema` (fields: `storyKey: z.string()`, `checks: z.array(StoredVerificationCheckResultSchema)`, `status: z.enum(['pass','warn','fail'])`, `duration_ms: z.number().nonneg()`)
**And** both schemas and their inferred types (`StoredVerificationCheckResult`, `StoredVerificationSummary`) are re-exported from `packages/sdlc/src/run-model/index.ts`

### AC2: PerStoryState.verification_result Typed as StoredVerificationSummary
**Given** the `PerStoryStateSchema` in `packages/sdlc/src/run-model/per-story-state.ts`
**When** the schema is applied to a manifest entry that contains verification data
**Then** the `verification_result` field is validated against `StoredVerificationSummarySchema.optional()` (replacing the previous `z.unknown().optional()` placeholder introduced in story 52-4)
**And** `PerStoryState.verification_result` is typed as `StoredVerificationSummary | undefined` — no cast required by consumers

### AC3: Verification Results Persisted to Manifest After Tier A Checks Complete
**Given** the implementation orchestrator has dispatched a story and the `VerificationPipeline.run()` call returns a `VerificationSummary`
**When** the orchestrator (or its verification integration layer) processes the summary
**Then** `manifest.patchStoryState(storyKey, { verification_result: summary })` is called immediately after the pipeline returns, before any terminal phase transition
**And** this write is non-fatal: wrapped in `.catch(err => logger.warn('manifest verification_result write failed', { storyKey, err }))` so a manifest failure never aborts the pipeline
**And** both pass/warn and fail summaries are persisted (all outcomes recorded, not just failures)

### AC4: Manifest Persistence Called with Correct RunManifest Instance
**Given** the `VerificationIntegration` module (or equivalent wiring in `verification-integration.ts`) receives a `VerificationSummary`
**When** it needs to persist to the manifest
**Then** the `RunManifest` instance is injected via the orchestrator's dependency container (the same instance used by story 52-4's `patchStoryState` calls for lifecycle transitions)
**And** no new manifest file path is opened — the single manifest instance is reused to avoid concurrent-write conflicts

### AC5: Verification Results Survive Process Crash
**Given** the pipeline has completed verification for story `X` and written `verification_result` to the manifest
**When** the process crashes immediately after the manifest write (before the story reaches a terminal phase)
**Then** on the next `substrate resume`, `manifest.read()` returns `per_story_state['X'].verification_result` with the full `VerificationSummary` data intact
**And** the crashed story's verification outcome is available to the completion report and recovery logic in Epics 53–54

### AC6: Backward Compatibility with Pre-52-7 Manifests
**Given** a manifest written by stories 52-1 through 52-6 where `per_story_state[storyKey].verification_result` is absent or `null`
**When** any consumer reads `manifest.per_story_state[storyKey].verification_result`
**Then** the value is `undefined` with no schema validation error
**And** `StoredVerificationSummarySchema.optional()` accepts the absent field without throwing

### AC7: Unit Tests for Schema and Persistence Wiring
**Given** the new `packages/sdlc/src/run-model/verification-result.test.ts` test file
**When** the tests run via `npm run test:fast`
**Then** the following cases pass:
  - Valid `StoredVerificationSummarySchema` with all three status values (`pass`, `warn`, `fail`)
  - Invalid data (missing required fields, unknown status) is rejected with a Zod error
  - `patchStoryState` with a verification summary round-trips through manifest read and produces identical data
  - `verification_result` field absent in `PerStoryStateSchema` validation does not throw

## Tasks / Subtasks

- [ ] Task 1: Create `packages/sdlc/src/run-model/verification-result.ts` with Zod schemas (AC: #1)
  - [ ] Define `StoredVerificationCheckResultSchema` with `checkName`, `status` (`z.enum(['pass','warn','fail'])`), `details`, `duration_ms`
  - [ ] Define `StoredVerificationSummarySchema` with `storyKey`, `checks`, `status`, `duration_ms`
  - [ ] Export inferred types `StoredVerificationCheckResult` and `StoredVerificationSummary`
  - [ ] Re-export both schemas and types from `packages/sdlc/src/run-model/index.ts`

- [ ] Task 2: Upgrade `verification_result` field in `per-story-state.ts` (AC: #2)
  - [ ] Import `StoredVerificationSummarySchema` from `./verification-result.js`
  - [ ] Replace `verification_result: z.unknown().optional()` with `verification_result: StoredVerificationSummarySchema.optional()`
  - [ ] Verify TypeScript compiles clean: `npm run build`

- [ ] Task 3: Wire manifest persistence into the orchestrator's verification integration (AC: #3, #4)
  - [ ] In `src/modules/implementation-orchestrator/verification-integration.ts`, accept an optional `runManifest: RunManifest | undefined` parameter in the relevant wiring function or class constructor
  - [ ] After `VerificationPipeline.run()` returns `VerificationSummary`, call `runManifest?.patchStoryState(storyKey, { verification_result: summary }).catch(...)` (non-fatal best-effort)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator.ts`, pass the manifest instance to the verification integration (same instance used for 52-4 lifecycle transitions)
  - [ ] Confirm `VerificationStore` is not removed — it continues as an in-memory cache for the current session; the manifest is an additional durable write target

- [ ] Task 4: Write unit tests in `packages/sdlc/src/run-model/verification-result.test.ts` (AC: #7)
  - [ ] Test valid summary with `pass`, `warn`, `fail` statuses
  - [ ] Test rejection of missing required fields (`checkName`, `status`, `details`, `duration_ms`)
  - [ ] Test `StoredVerificationSummarySchema.optional()` passes `undefined` without error
  - [ ] Test `patchStoryState` round-trip: write a summary to a temp manifest, read back, assert deep equality

- [ ] Task 5: Integration test for crash-recovery scenario (AC: #5, #6)
  - [ ] In the verification-integration test file (`src/modules/implementation-orchestrator/verification-integration.test.ts`), add a test that:
    1. Creates a real `RunManifest` instance backed by a temp directory
    2. Calls the verification wiring with a mock `VerificationSummary`
    3. Reads the manifest back from disk and asserts `verification_result` is persisted
  - [ ] Test that a manifest written without `verification_result` (pre-52-7) passes `PerStoryStateSchema` validation

## Dev Notes

### Architecture Constraints
- **File-backed JSON only** — no SQLite, no Dolt writes; manifest is the sole persistence target per Epic 52 Decision 1 and `feedback_no_sqlite_run_manifest.md`
- **Non-fatal writes** — all `patchStoryState` calls must be wrapped in `.catch()` per v0.18.0 `addTokenUsage` pattern; a manifest write failure must never abort the pipeline
- **Single manifest instance** — do not open a second `RunManifest` instance in verification wiring; inject the existing instance from the orchestrator's dependency container to avoid concurrent-write conflicts with the atomic-write lock
- **No circular imports** — `packages/sdlc/src/run-model/verification-result.ts` must NOT import from `packages/sdlc/src/verification/`; mirror only the field shape (string/number primitives) to stay import-free and avoid a core↔sdlc circular dependency
- **Extensible union pattern** — `status` in `StoredVerificationCheckResultSchema` uses `z.enum` (not `z.union` with literals) since the set is closed for verification (`pass|warn|fail` only); this is distinct from `PerStoryStatusSchema` which uses the open extensible union pattern from v0.19.6
- **Import with `.js` extensions** — all imports within the monorepo use `.js` suffix per existing project convention (e.g., `import { RunManifest } from './run-manifest.js'`)

### Key File Paths
| File | Change Type | Purpose |
|---|---|---|
| `packages/sdlc/src/run-model/verification-result.ts` | NEW | `StoredVerificationCheckResultSchema`, `StoredVerificationSummarySchema`, inferred types |
| `packages/sdlc/src/run-model/per-story-state.ts` | EDIT | Replace `z.unknown()` with `StoredVerificationSummarySchema.optional()` on `verification_result` |
| `packages/sdlc/src/run-model/index.ts` | EDIT | Re-export new schemas and types |
| `src/modules/implementation-orchestrator/verification-integration.ts` | EDIT | Add manifest persistence call after `VerificationPipeline.run()` |
| `src/modules/implementation-orchestrator/orchestrator.ts` | EDIT | Inject manifest instance into verification wiring |
| `packages/sdlc/src/run-model/verification-result.test.ts` | NEW | Unit tests for schema and round-trip |
| `src/modules/implementation-orchestrator/verification-integration.test.ts` | EDIT | Integration test for crash-recovery persistence |

### Integration Points
- **Consumes** `VerificationSummary` from `packages/sdlc/src/verification/types.ts` (Epic 51) — shape mirrored by `StoredVerificationSummarySchema`, not imported directly
- **Writes via** `RunManifest.patchStoryState()` from `packages/sdlc/src/run-model/run-manifest.ts` (Epic 52-4)
- **Schema slot** `per_story_state[storyKey].verification_result` was reserved as `z.unknown().optional()` in story 52-4 — this story fills that slot with a typed schema
- **Downstream consumers**: Epic 54 completion report reads `per_story_state[storyKey].verification_result` typed as `StoredVerificationSummary | undefined`; Epic 53 escalation recovery uses `checks` array to identify which checks failed

### Testing Requirements
- **Framework**: Vitest (`import { describe, it, expect } from 'vitest'`)
- **No e2e overhead** — unit tests use in-memory or temp-directory manifest instances, not live pipeline runs
- **Round-trip test**: write `verification_result` via `patchStoryState`, read manifest from disk JSON, assert `verification_result.checks.length` and `status` match input
- **Run with**: `npm run test:fast` — tests must pass without full coverage run
- **Prerequisite**: story 52-4 must be implemented (provides `patchStoryState`, `PerStoryStateSchema`, and the `RunManifest` class)

## Interface Contracts

- **Export**: `StoredVerificationSummarySchema` @ `packages/sdlc/src/run-model/verification-result.ts` (from story 52-7, consumed by Epic 54)
- **Export**: `StoredVerificationCheckResultSchema` @ `packages/sdlc/src/run-model/verification-result.ts` (from story 52-7, consumed by Epic 54)
- **Import**: `VerificationSummary` shape (mirrored, not imported) from story 51-5 @ `packages/sdlc/src/verification/types.ts`
- **Import**: `RunManifest.patchStoryState()` from story 52-4 @ `packages/sdlc/src/run-model/run-manifest.ts`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-06 | Initial story created |
