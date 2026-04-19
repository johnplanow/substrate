# Story 51-1: Verification Pipeline Framework

## Story

As a substrate developer,
I want a `VerificationPipeline` class that runs an ordered chain of `VerificationCheck` implementations after each story dispatch,
so that verification checks can be composed, ordered, and extended independently without coupling check logic to the orchestrator.

## Acceptance Criteria

### AC1: VerificationCheck Interface
**Given** the `packages/sdlc/src/verification/` directory contains the interface definitions
**When** a developer implements a new verification check
**Then** it must satisfy the `VerificationCheck` interface with `name: string`, `tier: 'A' | 'B'`, and `run(context: VerificationContext): Promise<VerificationResult>` method

### AC2: Tier A Checks Execute in Order
**Given** a `VerificationPipeline` instance with one or more registered Tier A checks
**When** the pipeline is invoked with a `VerificationContext`
**Then** all registered Tier A checks execute sequentially in registration order, each returning `{ status: 'pass' | 'warn' | 'fail', details: string, duration_ms: number }`

### AC3: Verification Context Shape
**Given** a completed story dispatch
**When** a `VerificationContext` is constructed for that story
**Then** it contains `storyKey: string`, `workingDir: string`, `commitSha: string`, and `timeout: number`; Tier B fields (`priorStoryFiles?: string[]`) are optional and may be undefined for Tier A runs

### AC4: Aggregated Per-Story Summary
**Given** a pipeline run with multiple checks
**When** all checks complete for a story
**Then** results are aggregated into a `VerificationSummary` containing: `storyKey`, array of per-check `VerificationCheckResult` entries, overall `status` (worst-case: fail > warn > pass), and total `duration_ms`

### AC5: Pipeline Events Emitted
**Given** a `VerificationPipeline` instance wired to the `TypedEventBus`
**When** each individual check completes
**Then** a `verification:check-complete` event is emitted with `{ storyKey, checkName, status, details, duration_ms }`; and when all checks complete a `verification:story-complete` event is emitted with the full `VerificationSummary`

### AC6: Unhandled Exceptions Treated as Warn
**Given** a `VerificationCheck` whose `run()` method throws an unhandled exception
**When** the pipeline executes that check
**Then** the exception is caught, logged at `warn` level, and the check result is recorded as `{ status: 'warn', details: '<exception message>', duration_ms: <elapsed> }` — the pipeline continues executing remaining checks and does not propagate the error

### AC7: Unit Tests Pass
**Given** the verification framework implementation
**When** `npm run test:fast` is executed
**Then** all new unit tests for `VerificationPipeline`, the `VerificationCheck` interface, and supporting types pass with no failures; existing 8,088+ tests continue to pass

## Tasks / Subtasks

- [ ] Task 1: Define types and interfaces (AC: #1, #2, #3, #4)
  - [ ] Create `packages/sdlc/src/verification/types.ts` with:
    - `VerificationContext` interface (`storyKey`, `workingDir`, `commitSha`, `timeout`, optional `priorStoryFiles`)
    - `VerificationResult` type: `{ status: 'pass' | 'warn' | 'fail', details: string, duration_ms: number }`
    - `VerificationCheckResult` type extending `VerificationResult` with `checkName: string`
    - `VerificationSummary` type: `{ storyKey: string, checks: VerificationCheckResult[], status: 'pass' | 'warn' | 'fail', duration_ms: number }`
    - `VerificationCheck` interface: `{ name: string, tier: 'A' | 'B', run(context: VerificationContext): Promise<VerificationResult> }`

- [ ] Task 2: Implement VerificationPipeline class (AC: #2, #4, #5, #6)
  - [ ] Create `packages/sdlc/src/verification/verification-pipeline.ts`
  - [ ] Constructor accepts `TypedEventBus` instance and optional array of `VerificationCheck` registrations
  - [ ] `register(check: VerificationCheck): void` — adds a check to the ordered list; Tier A checks always run before Tier B
  - [ ] `run(context: VerificationContext, tier: 'A' | 'B' = 'A'): Promise<VerificationSummary>` — executes all matching-tier checks sequentially
  - [ ] Each check wrapped in try/catch: exceptions caught, logged via `logger.warn`, result set to `{ status: 'warn', details: err.message, duration_ms: <elapsed> }`
  - [ ] Emit `verification:check-complete` event after each check via `TypedEventBus`
  - [ ] Compute aggregate `status` as worst-case (fail > warn > pass) and emit `verification:story-complete` event

- [ ] Task 3: Register new event types (AC: #5)
  - [ ] Add `verification:check-complete` and `verification:story-complete` to the event type definitions in `packages/sdlc/src/events.ts` (or wherever existing SDLC event types are declared)
  - [ ] Payloads: `verification:check-complete` → `{ storyKey: string, checkName: string, status: string, details: string, duration_ms: number }`; `verification:story-complete` → `VerificationSummary`

- [ ] Task 4: Create package barrel export (AC: #1)
  - [ ] Create `packages/sdlc/src/verification/index.ts` exporting: `VerificationPipeline`, `VerificationCheck`, `VerificationContext`, `VerificationResult`, `VerificationCheckResult`, `VerificationSummary`
  - [ ] Add `./verification` re-export to `packages/sdlc/src/index.ts`

- [ ] Task 5: Write unit tests (AC: #1, #2, #3, #4, #5, #6, #7)
  - [ ] Create `packages/sdlc/src/verification/__tests__/verification-pipeline.test.ts`
  - [ ] Test: registered checks execute in order (assert call order via mock)
  - [ ] Test: each check result included in summary with correct `checkName`, `status`, `details`, `duration_ms`
  - [ ] Test: aggregate status reflects worst-case (scenarios: all-pass → pass; mix pass+warn → warn; any fail → fail)
  - [ ] Test: unhandled exception from a check produces `status: 'warn'` and pipeline continues to next check
  - [ ] Test: `verification:check-complete` event emitted once per check with correct payload
  - [ ] Test: `verification:story-complete` event emitted once per pipeline run with full summary
  - [ ] Test: Tier B checks are skipped when running Tier A only (`tier: 'A'` argument)

## Dev Notes

### Architecture Constraints

- **Package placement:** All files live under `packages/sdlc/src/verification/`. Do not place anything in `packages/core/` for this story — the `VerificationCheck` interface references SDLC-specific fields (`storyKey`, `commitSha`, `priorStoryFiles`) and belongs in sdlc.
- **No LLM calls in default path** (FR-V9): `VerificationPipeline` must never invoke LLM adapters. Checks are static analysis only. The `VerificationContext` carries no prompt-assembly fields.
- **Import style:** Use named imports. Import `TypedEventBus` from the existing event bus in `packages/sdlc/src/events.ts` (check exact path before writing imports).
- **Logger:** Use the existing logger pattern from the sdlc package (check `packages/sdlc/src/orchestrator/` for current usage before importing).
- **TypeScript strict mode:** All new types must be non-`any`. Use `unknown` + type narrowing where necessary.
- **File-backed run manifest is Epic 52 scope** — this story only introduces the framework. Do not implement persistence of `VerificationSummary` to disk in this story.
- **Backward compatibility:** This story adds new exports; it does not modify any existing files except `packages/sdlc/src/events.ts` (to add event types) and `packages/sdlc/src/index.ts` (to add barrel export). No existing tests should break.
- **Build must stay under 5 seconds** (`npm run build`): avoid heavy imports or circular dependencies.

### Testing Requirements

- **Framework:** Vitest (project standard). Import from `vitest` not `jest`.
- **Mocking:** Use `vi.fn()` for mock `VerificationCheck` implementations. Do not import `jest`.
- **Event bus mocking:** Pass a mock `TypedEventBus` (constructed with `vi.fn()` for `emit`) to `VerificationPipeline` constructor so event assertions don't require a real bus.
- **Duration assertion:** `duration_ms` should be `>= 0` and `typeof number`; avoid exact value assertions since test execution timing varies.
- **Test file location:** Co-located under `packages/sdlc/src/verification/__tests__/verification-pipeline.test.ts`.
- **Run targeted tests:** `npm run test:fast` (unit tests only, ~50s). Do not run full suite during iteration.
- **Concurrent vitest prevention:** Before running tests, verify no vitest instance is running: `pgrep -f vitest` must return nothing.

### Related Epic Context

- **Story 51-2 (next)** will implement `PhantomReviewCheck` as the first concrete `VerificationCheck` implementation — this story defines the interface it will satisfy.
- **Story 51-3 (next)** will implement `TrivialOutputCheck` — same pattern.
- **Story 51-4 (next)** will implement `BuildCheck` with process-group kill logic.
- **Story 51-5** will wire `VerificationPipeline` into the implementation orchestrator's `processStory()` method — this story's pipeline class must be importable by that orchestrator.
- **Story 51-6** will extend event emission to include progress renderer output — event types registered in this story must match.

### Prior Epic Patterns (from Epic 50)

- Epic 50 used a handler registry pattern (`IHandlerRegistry`). `VerificationPipeline.register()` follows the same additive composition approach.
- Error handling philosophy from Epic 50: failures in pipeline components are caught and surfaced as structured results, never propagated as unhandled exceptions. This story adopts the same pattern (AC6).
- Epic 50 extended `GraphNode` with attributes via parser. For extensibility, `VerificationContext` should use an intersection type pattern if future fields are needed, not a union.

## Interface Contracts

- **Export**: `VerificationCheck` @ `packages/sdlc/src/verification/types.ts` (consumed by stories 51-2, 51-3, 51-4)
- **Export**: `VerificationPipeline` @ `packages/sdlc/src/verification/verification-pipeline.ts` (consumed by story 51-5)
- **Export**: `VerificationContext`, `VerificationResult`, `VerificationSummary` @ `packages/sdlc/src/verification/types.ts` (consumed by stories 51-2 through 51-6)
- **Export**: `verification:check-complete`, `verification:story-complete` event types @ `packages/sdlc/src/events.ts` (consumed by story 51-6)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-05 | Initial story created for Epic 51 Phase D |
