# Story 40.12: Re-Export Shim Validation

## Story

As a substrate developer preparing for Epic 41 implementation migration,
I want prototype re-export shims at the key type-only `src/` module paths that forward to `@substrate-ai/core` and `@substrate-ai/sdlc`,
so that I can confirm the shim pattern is viable, the extracted interface types are structurally compatible with existing consumers, and all 5,944 tests pass before any implementation code is moved.

## Acceptance Criteria

### AC1: Type-Only Shims Pass Full Test Suite
**Given** re-export shims replacing the content of `src/core/types.ts` and `src/core/event-bus.types.ts` to re-export from `@substrate-ai/core` and `@substrate-ai/sdlc` respectively
**When** `npm run test:fast` is run from the project root
**Then** all tests pass with count ≥ 5,944 and zero regressions compared to the pre-shim baseline

### AC2: Import Chain Resolves Through Shim to Core Package
**Given** a shim at `src/core/event-bus.types.ts` that exports `OrchestratorEvents` re-routed from `@substrate-ai/sdlc` (as `SdlcEvents`)
**When** any monolith file imports `OrchestratorEvents` from `./core/event-bus.types.js`
**Then** TypeScript resolves the import to the sdlc package type without a module-not-found or type error

### AC3: `tsc --build` Succeeds with Shims in Place
**Given** all created shim files
**When** `npx tsc --build` is run from the project root
**Then** exit code is 0, zero type errors are emitted, and all `packages/*/dist/` artifacts remain intact

### AC4: Multi-Shim Regression Coverage
**Given** shims covering three high-traffic type-file groups simultaneously: (a) core primitives at `src/core/types.ts`, (b) SDLC event map at `src/core/event-bus.types.ts`, (c) quality-gate types at `src/modules/quality-gates/types.ts`
**When** `npm run test:fast` is run with all three shims active
**Then** all tests pass with count ≥ 5,944 — confirming the multi-shim scenario is regression-free

### AC5: No Implementation Code Removed
**Given** this is a validation story (not an implementation migration)
**When** shims are created
**Then** zero implementation classes, functions, or runtime logic are deleted from `src/`; only pure type-definition files are replaced by shims, and all original implementation code remains intact

### AC6: Structural Compatibility Confirmed
**Given** the types extracted to `@substrate-ai/core` (stories 40-3 through 40-8) and `@substrate-ai/sdlc` (story 40-9)
**When** the shim re-exports are evaluated by TypeScript against existing consumers
**Then** zero `TS2345` (argument not assignable) or `TS2322` (type not assignable) errors caused by structural shape mismatches — confirming that Epic 40's interface definitions accurately match the monolith's actual types

### AC7: Gate Report Written
**Given** all checks above have been run
**When** this story is marked complete
**Then** a gate report is written to `_bmad-output/implementation-artifacts/40-12-gate-report.md` with: shim inventory (files shimmed + re-export source + any types kept inline), vitest total/pass/fail counts, `tsc --build` exit code, any structural fixes applied, and a PASS/FAIL verdict — PASS unblocks Epic 41-1

## Tasks / Subtasks

- [x] Task 1: Audit type-only `src/` files and map to `@substrate-ai/core`/`sdlc` exports (AC: #4, #5)
  - [x] Read `src/core/types.ts` — list all exported names (`TaskId`, `WorkerId`, `AgentId`, `TaskStatus`, `SessionStatus`, `BillingMode`, `LogLevel`, `TaskPriority`, `AgentCapability`, `TaskNode`, `SessionConfig`, `CostRecord`) and verify each has a counterpart in `packages/core/src/types.ts`
  - [x] Read `src/core/event-bus.types.ts` — identify all exported names (`OrchestratorEvents`, `RoutingDecision`, `TaskResult`, `TaskError`); verify `OrchestratorEvents` events are covered by `SdlcEvents` in `packages/sdlc/src/events.ts` and sub-types by `packages/core/src/events/`
  - [x] Read `src/modules/quality-gates/types.ts` — list all exported names and verify each has a counterpart in `packages/core/src/quality-gates/types.ts`
  - [x] For each file, document any gaps: types present in `src/` with no core package counterpart (these must be kept inline in the shim)

- [x] Task 2: Create shim for `src/core/types.ts` (AC: #1, #2, #5)
  - [x] Replace the content of `src/core/types.ts` with a type re-export shim: `export type { TaskId, WorkerId, AgentId, TaskStatus, SessionStatus, BillingMode, LogLevel, TaskPriority, AgentCapability, TaskNode, SessionConfig, CostRecord } from '@substrate-ai/core'`
  - [x] For any types present in the original file but absent from `@substrate-ai/core`, keep them inline in the shim file with a `// TODO: add to @substrate-ai/core in Epic 41` comment
  - [x] Run `npx tsc --build` after this shim; confirm exit code 0 before continuing

- [x] Task 3: Create shim for `src/core/event-bus.types.ts` (AC: #1, #2, #5)
  - [x] Replace the content of `src/core/event-bus.types.ts` with: (a) `export type { SdlcEvents as OrchestratorEvents } from '@substrate-ai/sdlc'`, (b) re-export of `RoutingDecision`, `TaskResult`, `TaskError` from `@substrate-ai/core` (or `@substrate-ai/sdlc` — whichever package owns them)
  - [x] Verify that the re-exported `OrchestratorEvents` alias preserves structural compatibility: the original `OrchestratorEvents` shape must be assignable to/from the new re-export
  - [x] For any event types in the original file not present in `SdlcEvents`, keep them inline and note them as gaps to fix in `packages/sdlc/src/events.ts`
  - [x] Run `npx tsc --build` after this shim; confirm exit code 0

- [x] Task 4: Create shim for `src/modules/quality-gates/types.ts` (AC: #4, #5)
  - [x] Replace the content of `src/modules/quality-gates/types.ts` with re-exports from `@substrate-ai/core` for all quality-gate types (`EvaluatorFn`, `GateEvaluation`, `GateConfig`, `GateResult`, `QualityGate`, `GatePipeline`)
  - [x] Keep any types not present in the core package inline
  - [x] Run `npx tsc --build` to verify no new errors

- [x] Task 5: Fix structural incompatibilities discovered during shimming (AC: #3, #6)
  - [x] For each `TS2345` or `TS2322` type error surfaced when shims are active: read both the core package definition and the monolith consumer to determine which side is wrong
  - [x] Fix direction is always the same as story 40-11 AC6: update `packages/core/src/` or `packages/sdlc/src/` to match the monolith's actual usage — never modify consumers or test files
  - [x] Re-run `npx tsc --build --force` after each batch of fixes until exit code 0
  - [x] Track every changed file path and the nature of each fix for the gate report

- [x] Task 6: Run full test suite and confirm no regressions (AC: #1, #4)
  - [x] Verify `pgrep -f vitest` returns nothing before starting
  - [x] Run `npm run test:fast` with all three shims active; confirm count ≥ 5,944 and zero failures
  - [x] If any test fails, categorize: (a) import not found — fix shim re-export, (b) type mismatch — fix `packages/*/src/`, (c) runtime value mismatch — check that the re-exported type alias is not a value-level export
  - [x] Do NOT modify test files under any circumstances

- [x] Task 7: Write gate report and commit shim files (AC: #7)
  - [x] If all tests pass: keep the shim files in place (they serve as the scaffolding for Epic 41)
  - [x] If any tests fail: revert shim files with `git restore src/core/types.ts src/core/event-bus.types.ts src/modules/quality-gates/types.ts`, document all failures in the gate report, and mark verdict FAIL
  - [x] Write gate report to `_bmad-output/implementation-artifacts/40-12-gate-report.md` using the format in Dev Notes

## Dev Notes

### Architecture Constraints
- **Type-only files only** — shims are created ONLY for files that contain zero implementation code (pure `interface`, `type`, or `export type` declarations). Do NOT shim files that export classes, functions, or runtime values.
- **Fix direction** — if a structural mismatch is found, fix the core package (`packages/core/src/` or `packages/sdlc/src/`), never the consumer. The monolith is always the source of truth.
- **ESM import style** — shim files in `src/core/` and `src/modules/` follow the existing ESM convention: relative imports use `.js` extensions; cross-package imports (e.g., `from '@substrate-ai/core'`) do NOT use `.js` extensions.
- **No test file modifications** — if a test fails due to a type error, the fix is in the shim definition or the core package interface, never in the test file.
- **Composite build required** — always run `npx tsc --build` (not `npx tsc`) to build in dependency order: core → sdlc → factory → monolith. Running bare `tsc` may miss project references.
- **`@substrate-ai/sdlc` must be importable from `src/`** — before creating the sdlc shim, verify that `packages/sdlc/package.json` has `"name": "@substrate-ai/sdlc"` and that the root `package.json` `workspaces` field includes `"packages/*"`. If workspace symlinks are missing, run `npm install` from the project root.

### Key Source Files to Read Before Starting
- `src/core/types.ts` — monolith primitive types to be shimmed
- `src/core/event-bus.types.ts` — monolith SDLC event map to be shimmed
- `src/modules/quality-gates/types.ts` — monolith quality-gate types to be shimmed
- `packages/core/src/types.ts` — core package primitive type definitions (story 40-8)
- `packages/sdlc/src/events.ts` — `SdlcEvents` definition (story 40-9)
- `packages/core/src/quality-gates/types.ts` — core quality-gate types (story 40-8)
- `packages/core/src/events/` — core event sub-types (`RoutingDecision`, `TaskResult`, `TaskError` counterparts)
- `packages/sdlc/package.json` — verify `"name": "@substrate-ai/sdlc"` and `"exports"` fields

### Testing Requirements
- Run `npm run test:fast` (unit tests only, ~50s) during iteration — do NOT run `npm test` (full suite with coverage, ~140s) until final gate verification
- NEVER pipe test output through `tail`, `head`, or `grep` — pipes discard the vitest summary line and make results unverifiable
- NEVER run tests in background — always foreground with `timeout: 300000`
- NEVER run concurrent vitest instances — verify `pgrep -f vitest` returns nothing before starting
- Confirm test results by checking for "Test Files" in the output, not exit code alone

### Gate Report Format
```markdown
# Story 40-12 Gate Report

## Summary
VERDICT: PASS | FAIL

## Shim Inventory
| File | Re-Export Source | Types Kept Inline |
|---|---|---|
| src/core/types.ts | @substrate-ai/core | none |
| src/core/event-bus.types.ts | @substrate-ai/sdlc | ... |
| src/modules/quality-gates/types.ts | @substrate-ai/core | ... |

## Vitest Results
- Total tests: X
- Passed: X
- Failed: X

## TypeScript Build
- Exit code: 0 | N
- Errors: none | list

## Structural Fixes Applied
- (list any packages/*/src/ files changed + one-line description of each fix)

## Epic 41 Unblock Status
UNBLOCKED — all shim validations passed, Epic 41 implementation migration may proceed with 41-1.
```

## Interface Contracts

- **Import**: `TaskId`, `WorkerId`, `AgentId`, `TaskStatus`, `SessionStatus`, `BillingMode`, `LogLevel`, `TaskPriority`, `AgentCapability`, `TaskNode`, `SessionConfig`, `CostRecord` @ `packages/core/src/types.ts` (from story 40-8) — re-exported via `src/core/types.ts` shim
- **Import**: `SdlcEvents` @ `packages/sdlc/src/events.ts` (from story 40-9) — re-exported as `OrchestratorEvents` via `src/core/event-bus.types.ts` shim
- **Import**: `EvaluatorFn`, `GateEvaluation`, `GateConfig`, `GateResult`, `QualityGate`, `GatePipeline` @ `packages/core/src/quality-gates/types.ts` (from story 40-8) — re-exported via `src/modules/quality-gates/types.ts` shim

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 3 shims created: src/core/types.ts, src/core/event-bus.types.ts, src/modules/quality-gates/types.ts
- One structural fix applied: packages/core/src/routing/routing-decision.ts — MonitorRecommendation.confidence changed from `number` to `string` to match monolith's ConfidenceLevel type
- All 5,944 tests pass (test:fast, 251 test files, 30.2s)
- tsc --build exit code 0, typecheck:gate exit code 0
- TaskResult and TaskError kept inline in event-bus.types.ts shim (no compatible core export)

### File List
- src/core/types.ts (shim: re-exports from @substrate-ai/core)
- src/core/event-bus.types.ts (shim: OrchestratorEvents from @substrate-ai/sdlc, RoutingDecision from @substrate-ai/core, TaskResult/TaskError inline)
- src/modules/quality-gates/types.ts (shim: re-exports from @substrate-ai/core)
- packages/core/src/routing/routing-decision.ts (fix: MonitorRecommendation.confidence type)

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
