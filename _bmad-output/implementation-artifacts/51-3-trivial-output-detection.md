# Story 51-3: Trivial Output Detection

## Story

As a substrate operator,
I want stories that produced fewer than 100 output tokens to be flagged as unverified,
so that I don't mistakenly treat minimal-output stories as successful completions.

## Acceptance Criteria

### AC1: Flag Story With Zero or Trivial Output Token Count
**Given** a completed story dispatch where the output token count for the story key is below 100 (e.g., 0, 1, 99)
**When** `TrivialOutputCheck.run(context)` is called with a `VerificationContext` that includes `outputTokenCount` below the threshold
**Then** the check returns `{ status: 'fail', details: 'trivial-output: output token count X is below threshold 100 — Re-run with increased maxTurns', duration_ms: <number> }`

### AC2: Escalation Details Include Suggested Action
**Given** a trivial-output failure result
**When** the result `details` string is read
**Then** it contains the phrase "Re-run with increased maxTurns" so that an operator (or recovery engine) has an actionable next step embedded in the check output

### AC3: Check Passes When Token Count Meets or Exceeds Threshold
**Given** a completed story dispatch where `outputTokenCount` is 100 or greater (e.g., 100, 500, 8000)
**When** `TrivialOutputCheck.run(context)` is called
**Then** the check returns `{ status: 'pass', details: 'output token count X meets threshold 100', duration_ms: <number> }`

### AC4: Threshold Is Configurable via SubstrateConfig
**Given** a `SubstrateConfig` with `trivialOutputThreshold: 250` injected at construction time
**When** a story dispatch produces 200 output tokens (below the custom threshold)
**Then** the check returns `status: 'fail'` using 250 as the threshold, not the hardcoded default of 100

### AC5: Missing Token Data Produces a Warn, Not Fail
**Given** a completed story dispatch where `outputTokenCount` is `undefined` (e.g., token tracking was unavailable for this dispatch)
**When** `TrivialOutputCheck.run(context)` is called
**Then** the check returns `{ status: 'warn', details: 'trivial-output: output token count unavailable — skipping check', duration_ms: <number> }` rather than crashing or producing a false failure

### AC6: TrivialOutputCheck Correctly Implements VerificationCheck Interface
**Given** the `VerificationCheck` interface from story 51-1 (`{ name: string, tier: 'A' | 'B', run(context): Promise<VerificationResult> }`)
**When** `TrivialOutputCheck` is constructed and inspected
**Then** `check.name === 'trivial-output'`, `check.tier === 'A'`, and `check.run` is a function returning `Promise<VerificationResult>`

### AC7: Unit Tests Cover All Branches With ≥8 Test Cases
**Given** the unit test file for `TrivialOutputCheck`
**When** `npm run test:fast` executes
**Then** at least 8 `it(...)` cases pass covering: zero tokens, 99 tokens (fail), 100 tokens (pass), 500 tokens (pass), undefined token count (warn), custom threshold below count (pass), custom threshold above count (fail), and check name/tier assertions — confirmed by "Test Files" summary line showing the file green with zero failures

## Tasks / Subtasks

- [ ] Task 1: Extend `VerificationContext` with optional token count field and extend `SubstrateConfig` with threshold field (AC: #1, #4, #5)
  - [ ] Before editing, read the existing types file: `grep -n "VerificationContext\|VerificationResult\|VerificationCheck" packages/sdlc/src/verification/types.ts 2>/dev/null || grep -rn "VerificationContext" packages/sdlc/src/`
  - [ ] Add `outputTokenCount?: number` to the `VerificationContext` interface in `packages/sdlc/src/verification/types.ts` (this field is optional — Tier A checks populate it when available)
  - [ ] Read existing `SubstrateConfig` shape: `grep -n "trivialOutput\|verif" packages/core/src/config/types.ts 2>/dev/null || grep -rn "SubstrateConfig" packages/core/src/`
  - [ ] Add `trivialOutputThreshold?: number` to `SubstrateConfig` in `packages/core/src/config/types.ts` (default: 100 when omitted)
  - [ ] Confirm no TypeScript errors on config extension: `npm run build` after change

- [ ] Task 2: Implement `TrivialOutputCheck` class (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Create `packages/sdlc/src/verification/checks/trivial-output-check.ts`
  - [ ] Import `VerificationCheck`, `VerificationContext`, `VerificationResult` from the types file using `.js` extension: `import type { VerificationCheck, VerificationContext, VerificationResult } from '../types.js'`
  - [ ] Import `SubstrateConfig` (or its config type) using `.js` extension from `@substrate-ai/core`; confirm exact export path with `grep -n "^export" packages/core/src/config/types.ts`
  - [ ] Define `DEFAULT_TRIVIAL_OUTPUT_THRESHOLD = 100` as a named constant
  - [ ] Implement `TrivialOutputCheck` class:
    ```typescript
    export class TrivialOutputCheck implements VerificationCheck {
      readonly name = 'trivial-output';
      readonly tier = 'A' as const;
      private readonly threshold: number;
      constructor(config?: Pick<SubstrateConfig, 'trivialOutputThreshold'>) {
        this.threshold = config?.trivialOutputThreshold ?? DEFAULT_TRIVIAL_OUTPUT_THRESHOLD;
      }
      async run(context: VerificationContext): Promise<VerificationResult> { ... }
    }
    ```
  - [ ] In `run()`: record `start = Date.now()`; if `context.outputTokenCount === undefined`, return warn with "output token count unavailable — skipping check"; if `context.outputTokenCount < this.threshold`, return fail with details including actual count, threshold, and "Re-run with increased maxTurns"; otherwise return pass; always set `duration_ms = Date.now() - start`
  - [ ] Export `TrivialOutputCheck` from the checks barrel/index file at `packages/sdlc/src/verification/checks/index.ts` (create if it doesn't exist; confirm via `ls packages/sdlc/src/verification/checks/`)
  - [ ] Export `TrivialOutputCheck` from `packages/sdlc/src/verification/index.ts` (create if needed)

- [ ] Task 3: Register `TrivialOutputCheck` in `VerificationPipeline` (AC: #6)
  - [ ] Read how story 51-1's `VerificationPipeline` registers checks: `grep -n "register\|addCheck\|checks\|pipeline" packages/sdlc/src/verification/verification-pipeline.ts`
  - [ ] Add `TrivialOutputCheck` as the second Tier A check in the pipeline's default ordered list (after `PhantomReviewCheck`, before `BuildCheck`), following the architecture sequence: 1→PhantomReview, 2→TrivialOutput, 3→Build
  - [ ] If the pipeline uses constructor injection or a factory function, add `TrivialOutputCheck` there; if it uses `addCheck()`, add the call in the pipeline initialization site in the orchestrator integration
  - [ ] Confirm check ordering by inspecting the registered list in the pipeline (unit test or console assertion)

- [ ] Task 4: Populate `outputTokenCount` in `VerificationContext` at the dispatch call site (AC: #1, #5)
  - [ ] Find where `VerificationContext` is assembled (likely in `packages/sdlc/src/orchestrator/implementation-orchestrator.ts` near story 51-5's integration hook): `grep -rn "VerificationContext\|verificationContext\|outputTokenCount" packages/sdlc/src/`
  - [ ] Read how token usage is stored for a story: `grep -rn "token_usage_json\|outputTokens\|storyKey" packages/sdlc/src/ packages/core/src/ src/modules/ | head -30`
  - [ ] At the context assembly site, read the story's output token count from the state store (Dolt `pipeline_runs.token_usage_json`) or from in-memory tracking (whatever is available at post-dispatch time); assign to `outputTokenCount`
  - [ ] If the token data is not available at context assembly time, leave `outputTokenCount` undefined (the check handles this gracefully per AC5)

- [ ] Task 5: Write unit tests for `TrivialOutputCheck` (AC: #7)
  - [ ] Create `packages/sdlc/src/__tests__/verification/trivial-output-check.test.ts`
  - [ ] Discover correct import paths before writing: `grep -n "^export" packages/sdlc/src/verification/checks/trivial-output-check.ts`
  - [ ] Import: `import { TrivialOutputCheck } from '../../verification/checks/trivial-output-check.js'`
  - [ ] Build a helper: `makeContext(overrides: Partial<VerificationContext>): VerificationContext` that fills required fields with valid defaults (e.g., `{ storyKey: '51-3', workingDir: '/tmp/test', commitSha: 'abc123', timeout: 30000, priorStoryFiles: new Map() }`)
  - [ ] Test (zero tokens): `outputTokenCount: 0` → `status: 'fail'`, details include "0", "100", "Re-run with increased maxTurns"
  - [ ] Test (99 tokens — one below threshold): `outputTokenCount: 99` → `status: 'fail'`
  - [ ] Test (100 tokens — exactly at threshold): `outputTokenCount: 100` → `status: 'pass'`
  - [ ] Test (500 tokens — well above threshold): `outputTokenCount: 500` → `status: 'pass'`
  - [ ] Test (undefined token count): `outputTokenCount: undefined` → `status: 'warn'`, details include "unavailable"
  - [ ] Test (custom threshold 250, count 200): new `TrivialOutputCheck({ trivialOutputThreshold: 250 })`, count 200 → `status: 'fail'`
  - [ ] Test (custom threshold 250, count 300): new `TrivialOutputCheck({ trivialOutputThreshold: 250 })`, count 300 → `status: 'pass'`
  - [ ] Test (check metadata): `check.name === 'trivial-output'` and `check.tier === 'A'`
  - [ ] Test (duration_ms): all results have `duration_ms >= 0` as a number
  - [ ] Minimum 9 `it(...)` cases; confirm count with `grep -c "it(" packages/sdlc/src/__tests__/verification/trivial-output-check.test.ts`

- [ ] Task 6: Build and run tests to confirm all changes pass (AC: #7)
  - [ ] Run `npm run build`; confirm zero TypeScript errors in new and modified files
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line shows the new test file green with zero failures
  - [ ] NEVER pipe test output through `tail`, `head`, `grep`, or any filtering command

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/sdlc/` and `packages/core/` MUST use `.js` extensions (ESM): e.g., `import { ... } from '../types.js'`
- `TrivialOutputCheck` lives at `packages/sdlc/src/verification/checks/trivial-output-check.ts` — this matches the file organization pattern from the architecture document (section 3.5)
- `VerificationCheck` interface and `VerificationContext`/`VerificationResult` types all live in `packages/sdlc/src/verification/` — do NOT put them in `packages/core` (the interface is SDLC-specific per architecture Decision 2)
- `SubstrateConfig` extension goes in `packages/core/src/config/types.ts` — config fields are always in core
- This check is Tier A: it has NO dependency on the run model (Epic 52). It receives everything it needs from `VerificationContext`
- No LLM calls — this is pure static analysis (architecture constraint DC-6, FR-V9)
- Use `vitest` (`describe`, `it`, `expect`) — no Jest globals, no `jest.fn()`

### Token Count Data Access
The `token_usage_json` field is stored in the Dolt `pipeline_runs` table and tracked in-memory during dispatch. The exact shape to verify before coding:
```bash
grep -rn "token_usage_json\|outputTokens\|output_tokens" src/ packages/ | grep -v ".test." | head -20
grep -rn "addTokenUsage\|tokenUsage" packages/sdlc/src/ src/ | head -20
```
The `VerificationContext.outputTokenCount` will be the sum of all output tokens attributed to the story key in `token_usage_json.stories[storyKey]`. If per-story token breakdown isn't available, `outputTokenCount` should be left as `undefined` — the check handles this as a `warn` (AC5).

### VerificationPipeline Registration Order
Per architecture document section 3.5 and Decision 2, the canonical Tier A check order is:
1. `PhantomReviewCheck` (story 51-2)
2. `TrivialOutputCheck` (this story — 51-3)
3. `BuildCheck` (story 51-4)

This ordering is important: phantom review detection runs first (a story that was never reviewed shouldn't get token analysis), then trivial output (fast check, no shell invocation), then build (expensive, 60s timeout).

### Threshold Constant and Config Integration
Use a module-level constant so it's testable without config injection:
```typescript
export const DEFAULT_TRIVIAL_OUTPUT_THRESHOLD = 100;
```
The `SubstrateConfig` addition is:
```typescript
trivialOutputThreshold?: number; // default: 100 — stories below this output token count are flagged
```

### Fail Details String Format
The `details` string on failure MUST contain all three of: the actual token count, the threshold value, and the suggested action string "Re-run with increased maxTurns". Example:
```
trivial-output: output token count 0 is below threshold 100 — Re-run with increased maxTurns
```
This format enables the recovery engine (story 54-1) and completion report (story 54-5) to surface actionable guidance without additional parsing.

### Testing Requirements
- Framework: `vitest` (`describe`, `it`, `expect`) — no Jest globals
- No real file I/O, no network calls — pure unit test
- Use `makeContext()` helper to avoid repetitive context construction
- Minimum 9 `it(...)` test cases (one per behavior variant)
- Run `npm run build` first; then `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line; NEVER pipe output through any filter

### New File Paths
```
packages/sdlc/src/verification/checks/trivial-output-check.ts     — TrivialOutputCheck implementation
packages/sdlc/src/__tests__/verification/trivial-output-check.test.ts — unit tests (≥9 cases)
```

### Modified File Paths
```
packages/sdlc/src/verification/types.ts                            — add outputTokenCount?: number to VerificationContext
packages/core/src/config/types.ts                                  — add trivialOutputThreshold?: number to SubstrateConfig
packages/sdlc/src/verification/checks/index.ts                     — export TrivialOutputCheck (create if missing)
packages/sdlc/src/verification/index.ts                            — re-export TrivialOutputCheck (create if missing)
packages/sdlc/src/verification/verification-pipeline.ts            — register TrivialOutputCheck as 2nd Tier A check
```

## Interface Contracts

- **Import**: `VerificationCheck`, `VerificationContext`, `VerificationResult` @ `packages/sdlc/src/verification/types.ts` (from story 51-1)
- **Import**: `VerificationPipeline` @ `packages/sdlc/src/verification/verification-pipeline.ts` (from story 51-1 — registration target)
- **Export**: `TrivialOutputCheck` @ `packages/sdlc/src/verification/checks/trivial-output-check.ts` (consumed by story 51-5 for pipeline integration and story 54-8 for verification→learning feedback)
- **Export**: `DEFAULT_TRIVIAL_OUTPUT_THRESHOLD` @ `packages/sdlc/src/verification/checks/trivial-output-check.ts` (consumed by tests and story 54-5 report rendering)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
