# Story 51-2: Phantom Review Detection

## Story

As a substrate operator,
I want the system to detect when a code review dispatch failed but was recorded as a passing verdict,
so that stories that were never actually reviewed are not counted as verified.

## Acceptance Criteria

### AC1: Non-Zero Exit Code or Dispatch Crash Detected as Phantom
**Given** a completed story dispatch where code review returned `dispatchFailed: true` (non-zero exit code, timeout, or crash)
**When** `PhantomReviewCheck.run(context)` is called with a `VerificationContext` containing the review result
**Then** the check returns `{ status: 'fail', details: 'phantom-review: dispatch failed — <error>', duration_ms: <number> }`

### AC2: Empty Review Output Detected as Phantom
**Given** a completed story dispatch where the code review agent produced empty or null raw output (`rawOutput` is empty string, `undefined`, or `null`)
**When** `PhantomReviewCheck.run(context)` is called
**Then** the check returns `status: 'fail'` with details including "phantom-review: empty review output"

### AC3: Schema Validation Failure Detected as Phantom
**Given** a completed story dispatch where `runCodeReview()` returned `error: 'schema_validation_failed'` (YAML extraction failed or Zod validation failed)
**When** `PhantomReviewCheck.run(context)` is called
**Then** the check returns `status: 'fail'` with details including "phantom-review: schema validation failed"

### AC4: Fallback Silent Verdict Removed From code-review.ts
**Given** `runCodeReview()` encounters a YAML parse failure (`dispatchResult.parsed === null`) or Zod validation failure
**When** it returns the failure result
**Then** the returned `CodeReviewResult` includes `dispatchFailed: true` (marking it explicitly as a phantom, not a real verdict) — the schema validation failure cases are no longer silently conflated with genuine `NEEDS_MINOR_FIXES` findings

### AC5: Valid Review Passes the Check
**Given** a completed story dispatch where `runCodeReview()` returned a legitimate verdict (no `dispatchFailed`, non-empty `rawOutput`, no schema validation error) with any verdict value (`SHIP_IT`, `NEEDS_MINOR_FIXES`, `NEEDS_MAJOR_REWORK`, `LGTM_WITH_NOTES`)
**When** `PhantomReviewCheck.run(context)` is called
**Then** the check returns `{ status: 'pass', details: 'phantom-review: review output is valid', duration_ms: <number> }`

### AC6: PhantomReviewCheck Interface Compliance
**Given** the `VerificationCheck` interface defined in story 51-1 (`{ name: string, tier: 'A' | 'B', run(context: VerificationContext): Promise<VerificationResult> }`)
**When** `PhantomReviewCheck` is instantiated and inspected
**Then** `check.name === 'phantom-review'`, `check.tier === 'A'`, and `check.run` is a function returning `Promise<VerificationResult>`

### AC7: Unit Tests Cover All Detection Branches
**Given** the unit test file for `PhantomReviewCheck`
**When** `npm run test:fast` executes
**Then** at least 8 `it(...)` cases pass covering: dispatch failed (non-zero exit), dispatch timeout, empty rawOutput, null rawOutput, schema_validation_failed error, valid SHIP_IT review (pass), valid NEEDS_MINOR_FIXES review (pass), and check name/tier assertions — confirmed by "Test Files" summary line showing the file green with zero failures

## Tasks / Subtasks

- [ ] Task 1: Extend `VerificationContext` with optional `reviewResult` field (AC: #1, #2, #3, #4, #5)
  - [ ] Before editing, read the current `VerificationContext` definition: `cat packages/sdlc/src/verification/types.ts` (or `grep -rn "VerificationContext" packages/sdlc/src/verification/`)
  - [ ] Add `reviewResult?: ReviewSignals` to `VerificationContext` in `packages/sdlc/src/verification/types.ts`
  - [ ] Define `ReviewSignals` as a new exported interface in `types.ts`:
    ```typescript
    export interface ReviewSignals {
      /** True when dispatch itself failed (crash, timeout, non-zero exit, or schema validation failure) */
      dispatchFailed?: boolean;
      /** Error type string from the review result ('schema_validation_failed' or other) */
      error?: string;
      /** Raw agent output — empty string or undefined indicates no output was produced */
      rawOutput?: string;
    }
    ```
  - [ ] The `ReviewSignals` interface is intentionally narrow (only signals needed by the check) — do not import the full `CodeReviewResult` type into the sdlc verification module
  - [ ] Confirm no TypeScript errors: `npm run build` after the types change

- [ ] Task 2: Modify `code-review.ts` to expose schema validation failures as `dispatchFailed: true` (AC: #4)
  - [ ] Read the current schema validation failure blocks: lines ~354–385 of `src/modules/compiled-workflows/code-review.ts`
  - [ ] In the first schema validation failure block (where `dispatchResult.parsed === null`, ~line 358): add `dispatchFailed: true` to the returned object alongside the existing `verdict: 'NEEDS_MINOR_FIXES'`, `error: 'schema_validation_failed'`
  - [ ] In the second schema validation failure block (where `CodeReviewResultSchema.safeParse()` fails, ~line 372): add `dispatchFailed: true` to the returned object alongside the existing `verdict: 'NEEDS_MINOR_FIXES'`, `error: 'schema_validation_failed'`
  - [ ] The `verdict: 'NEEDS_MINOR_FIXES'` may remain for backward compatibility with existing orchestrator code that reads it — the critical change is that `dispatchFailed: true` is now set, making these cases detectable by `PhantomReviewCheck`
  - [ ] Update the JSDoc comment on `defaultFailResult` to note that schema validation failures also use `dispatchFailed: true` as of this change
  - [ ] Confirm `CodeReviewResult` type already allows `dispatchFailed?: boolean` (it does, per types.ts line 219) — no type changes needed in `types.ts`
  - [ ] Run `npm run build` to confirm zero TypeScript errors

- [ ] Task 3: Implement `PhantomReviewCheck` class (AC: #1, #2, #3, #5, #6)
  - [ ] Create `packages/sdlc/src/verification/checks/phantom-review-check.ts`
  - [ ] Import using `.js` extension (ESM requirement): `import type { VerificationCheck, VerificationContext, VerificationResult } from '../types.js'`
  - [ ] Implement the class:
    ```typescript
    export class PhantomReviewCheck implements VerificationCheck {
      readonly name = 'phantom-review';
      readonly tier = 'A' as const;

      async run(context: VerificationContext): Promise<VerificationResult> {
        const start = Date.now();
        const review = context.reviewResult;

        // No review signals available — treat as pass (check cannot determine failure)
        if (!review) {
          return { status: 'pass', details: 'phantom-review: no review result in context — skipping check', duration_ms: Date.now() - start };
        }

        // Phantom: dispatch itself failed (non-zero exit, timeout, crash, or schema validation failure)
        if (review.dispatchFailed === true) {
          const reason = review.error === 'schema_validation_failed'
            ? 'schema validation failed'
            : `dispatch failed${review.error ? ` — ${review.error}` : ''}`;
          return { status: 'fail', details: `phantom-review: ${reason}`, duration_ms: Date.now() - start };
        }

        // Phantom: agent produced no output
        if (!review.rawOutput || review.rawOutput.trim().length === 0) {
          return { status: 'fail', details: 'phantom-review: empty review output', duration_ms: Date.now() - start };
        }

        return { status: 'pass', details: 'phantom-review: review output is valid', duration_ms: Date.now() - start };
      }
    }
    ```
  - [ ] Export `PhantomReviewCheck` from the checks barrel at `packages/sdlc/src/verification/checks/index.ts` (create if it doesn't exist; verify with `ls packages/sdlc/src/verification/checks/`)
  - [ ] Export `PhantomReviewCheck` from `packages/sdlc/src/verification/index.ts`
  - [ ] Export `ReviewSignals` from `packages/sdlc/src/verification/index.ts`

- [ ] Task 4: Register `PhantomReviewCheck` as first Tier A check in `VerificationPipeline` (AC: #6)
  - [ ] Read how story 51-1's `VerificationPipeline` registers checks: `grep -n "register\|addCheck\|checks\|pipeline" packages/sdlc/src/verification/verification-pipeline.ts`
  - [ ] Add `PhantomReviewCheck` as the first registered Tier A check in the pipeline (before `TrivialOutputCheck` from 51-3, before `BuildCheck` from 51-4) — the canonical Tier A order is: 1→PhantomReview, 2→TrivialOutput, 3→Build
  - [ ] Register at the same location where 51-1 sets up the pipeline (constructor or factory)
  - [ ] Confirm ordering: if the pipeline exposes an inspection method (e.g. `getChecks()`), assert order in tests; otherwise, confirm via a comment in the pipeline file

- [ ] Task 5: Write unit tests for `PhantomReviewCheck` (AC: #7)
  - [ ] Create `packages/sdlc/src/__tests__/verification/phantom-review-check.test.ts`
  - [ ] Discover correct import paths before writing: `grep -n "^export" packages/sdlc/src/verification/checks/phantom-review-check.ts`
  - [ ] Import: `import { PhantomReviewCheck } from '../../verification/checks/phantom-review-check.js'`
  - [ ] Build a `makeContext()` helper:
    ```typescript
    function makeContext(reviewOverrides?: Partial<ReviewSignals>): VerificationContext {
      return {
        storyKey: '51-2',
        workingDir: '/tmp/test',
        commitSha: 'abc123',
        timeout: 30000,
        reviewResult: reviewOverrides !== undefined ? reviewOverrides : undefined,
      };
    }
    ```
  - [ ] Test (dispatch failed — non-zero exit): `dispatchFailed: true, error: 'Exit code: 1'` → `status: 'fail'`, details include "dispatch failed"
  - [ ] Test (dispatch timeout): `dispatchFailed: true, error: 'Dispatch status: timeout...'` → `status: 'fail'`
  - [ ] Test (schema validation failure): `dispatchFailed: true, error: 'schema_validation_failed'` → `status: 'fail'`, details include "schema validation failed"
  - [ ] Test (empty rawOutput — empty string): `dispatchFailed: false, rawOutput: ''` → `status: 'fail'`, details include "empty review output"
  - [ ] Test (empty rawOutput — whitespace only): `dispatchFailed: false, rawOutput: '   \n  '` → `status: 'fail'`
  - [ ] Test (null rawOutput — undefined): `dispatchFailed: false, rawOutput: undefined` → `status: 'fail'`, details include "empty review output"
  - [ ] Test (valid SHIP_IT review): `dispatchFailed: false, rawOutput: 'verdict: SHIP_IT\n...'` → `status: 'pass'`
  - [ ] Test (valid NEEDS_MINOR_FIXES review): `dispatchFailed: false, rawOutput: 'verdict: NEEDS_MINOR_FIXES\n...'` → `status: 'pass'`
  - [ ] Test (no reviewResult in context): `makeContext(undefined)` (context.reviewResult not set) → `status: 'pass'`, details include "skipping"
  - [ ] Test (check metadata): `check.name === 'phantom-review'` and `check.tier === 'A'`
  - [ ] Test (duration_ms): all results have `duration_ms >= 0` as a number
  - [ ] Minimum 10 `it(...)` cases; confirm count with `grep -c "it(" packages/sdlc/src/__tests__/verification/phantom-review-check.test.ts`

- [ ] Task 6: Build and run tests to confirm all changes pass (AC: #7)
  - [ ] Run `npm run build`; confirm zero TypeScript errors in new and modified files
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line shows the new test file green with zero failures
  - [ ] NEVER pipe test output through `tail`, `head`, `grep`, or any filtering command

## Dev Notes

### Architecture Constraints

- **Package placement:** `PhantomReviewCheck` lives at `packages/sdlc/src/verification/checks/phantom-review-check.ts`. The `ReviewSignals` interface lives in `packages/sdlc/src/verification/types.ts`. Do not place verification types in `packages/core/`.
- **No LLM calls** (FR-V9): `PhantomReviewCheck` is pure static signal inspection — it reads fields from `VerificationContext.reviewResult`. No subprocess calls, no git invocations.
- **Import style:** All relative imports within `packages/sdlc/` MUST use `.js` extensions (ESM): e.g., `import type { ... } from '../types.js'`. Do not use bare relative imports.
- **`ReviewSignals` is intentionally a slim projection** — do NOT import `CodeReviewResult` from `src/modules/compiled-workflows/types.ts` into `packages/sdlc/src/verification/`. The sdlc package must not create a dependency on the monolith `src/`. Use the narrow `ReviewSignals` interface which mirrors only the fields the check needs.
- **`VerificationContext.reviewResult` is optional** — the check handles missing review context gracefully (returns `pass` with a skip note). This preserves backward compatibility when the context is assembled without review data (e.g., Tier B-only runs, or integration contexts not yet updated).
- **Tier A check** — no run model dependency. `PhantomReviewCheck` does not read from the file-backed run manifest (that's Epic 52 scope).
- **Backward compatibility in `code-review.ts`** — only add `dispatchFailed: true` to the two schema validation failure returns. Do not change the `verdict: 'NEEDS_MINOR_FIXES'` value itself (other code paths may still use it for non-phantom cases). The existing orchestrator phantom detection logic continues to work unchanged until story 51-5 integrates the full pipeline.
- **TypeScript strict mode** — all new types must be non-`any`. The `ReviewSignals` interface uses specific optional fields, not `unknown`.
- **Build must stay under 5 seconds** — the new check file is minimal (<50 lines); no heavy imports.

### Code-Review.ts Modification Detail

The two blocks to update are at approximately lines 354–385 of `src/modules/compiled-workflows/code-review.ts`:

**Block 1 — YAML extraction failure (`dispatchResult.parsed === null`):**
```typescript
// Before:
return {
  verdict: 'NEEDS_MINOR_FIXES',
  issues: 0,
  issue_list: [],
  error: 'schema_validation_failed',
  details,
  rawOutput,
  tokenUsage,
}

// After (add dispatchFailed: true):
return {
  verdict: 'NEEDS_MINOR_FIXES',
  issues: 0,
  issue_list: [],
  error: 'schema_validation_failed',
  details,
  rawOutput,
  tokenUsage,
  dispatchFailed: true,  // NEW — marks as phantom for PhantomReviewCheck
}
```

**Block 2 — Zod schema validation failure (`parseResult.success === false`):**
Same change — add `dispatchFailed: true`.

This is the "removal of the fallback verdict logic" — both schema failure cases now carry `dispatchFailed: true`, making them detectable by `PhantomReviewCheck` via the same signal path as genuine dispatch crashes. The `NEEDS_MINOR_FIXES` verdict is kept for backward compatibility with code paths that haven't yet been updated to check `dispatchFailed`.

### ReviewSignals Interface Design

```typescript
// packages/sdlc/src/verification/types.ts — add to VerificationContext and define ReviewSignals

export interface ReviewSignals {
  /** True when the dispatch itself failed — covers crash, timeout, non-zero exit, AND schema validation failure */
  dispatchFailed?: boolean;
  /** Error type string (e.g., 'schema_validation_failed', dispatch error message) */
  error?: string;
  /** Raw agent output text — empty/undefined indicates no output was produced */
  rawOutput?: string;
}

// Add to VerificationContext:
export interface VerificationContext {
  storyKey: string;
  workingDir: string;
  commitSha: string;
  timeout: number;
  priorStoryFiles?: Map<string, string[]>;  // Tier B, from story 51-1
  outputTokenCount?: number;                // Tier A, from story 51-3
  reviewResult?: ReviewSignals;             // NEW — Tier A, from this story
}
```

### Both Claude Code and Codex Output Formats

The check works at the signal level (exit codes, `dispatchFailed` flag, `rawOutput` empty check) rather than parsing format-specific output. This means it inherently handles both Claude Code and Codex output:
- **Claude Code**: dispatch failures set `dispatchFailed: true`; schema failures produce empty YAML blocks
- **Codex**: same `dispatchFailed` signal; schema failures produce malformed YAML or empty responses
No format-specific logic is needed in the check itself.

### Testing Requirements

- **Framework:** Vitest (`describe`, `it`, `expect`) — no Jest globals, no `jest.fn()`
- **No real file I/O, no subprocess calls** — pure unit test of the check logic
- **Mocking:** No mocking needed — `PhantomReviewCheck` is a pure function over `VerificationContext` fields
- **`makeContext()` helper** to avoid repetitive context construction; the `reviewResult` field is what varies
- **Duration assertion:** `duration_ms` should be `>= 0` and `typeof number`; avoid exact value assertions
- **Test file location:** `packages/sdlc/src/__tests__/verification/phantom-review-check.test.ts`
- **Run targeted tests:** `npm run test:fast` (unit tests only, ~50s). Do not run the full suite during iteration
- **Concurrent vitest prevention:** Before running tests, verify no vitest instance is running: `pgrep -f vitest` must return nothing

### Tier A Check Ordering

Per architecture document section 3.5 and Decision 2, the canonical Tier A check order is:
1. `PhantomReviewCheck` (this story — runs first: a story that was never reviewed shouldn't get further analysis)
2. `TrivialOutputCheck` (story 51-3 — fast token count check, no shell invocation)
3. `BuildCheck` (story 51-4 — expensive, 60s timeout)

`PhantomReviewCheck` must be registered before the other checks.

### New File Paths
```
packages/sdlc/src/verification/checks/phantom-review-check.ts         — PhantomReviewCheck implementation
packages/sdlc/src/__tests__/verification/phantom-review-check.test.ts  — unit tests (≥10 cases)
```

### Modified File Paths
```
packages/sdlc/src/verification/types.ts                               — add ReviewSignals interface + reviewResult? to VerificationContext
packages/sdlc/src/verification/checks/index.ts                        — export PhantomReviewCheck (create if missing)
packages/sdlc/src/verification/index.ts                               — re-export PhantomReviewCheck, ReviewSignals
packages/sdlc/src/verification/verification-pipeline.ts               — register PhantomReviewCheck as first Tier A check
src/modules/compiled-workflows/code-review.ts                         — add dispatchFailed: true to schema validation failure returns
```

## Interface Contracts

- **Import**: `VerificationCheck`, `VerificationContext`, `VerificationResult` @ `packages/sdlc/src/verification/types.ts` (from story 51-1)
- **Import**: `VerificationPipeline` @ `packages/sdlc/src/verification/verification-pipeline.ts` (from story 51-1 — registration target)
- **Export**: `PhantomReviewCheck` @ `packages/sdlc/src/verification/checks/phantom-review-check.ts` (consumed by story 51-5 for pipeline integration and story 54-8 for verification→learning feedback)
- **Export**: `ReviewSignals` @ `packages/sdlc/src/verification/types.ts` (consumed by story 51-5 when assembling `VerificationContext` from `CodeReviewResult`)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-05 | Initial story created for Epic 51 Phase D |
