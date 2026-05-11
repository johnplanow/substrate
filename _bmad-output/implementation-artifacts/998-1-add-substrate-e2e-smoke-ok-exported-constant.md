# Story 998-1: Add SUBSTRATE_E2E_SMOKE_OK Exported Constant

## Story

As a substrate dispatch-pipeline e2e harness,
I want a one-line code addition to substrate's own codebase,
so that the auto-commit + merge-to-main flow can be validated end-to-end without ambiguity or upstream prompt issues blocking the SHIP_IT path.

## Acceptance Criteria

<!-- source-ac-hash: 0a1484533701bfaa7b04ae93aa6cb7701748b56fd8a7e0274dffeb4dbf135510 -->

### AC1: SUBSTRATE_E2E_SMOKE_OK constant is exported from packages/core/src/index.ts

**Given** an operator dispatches story 998-1 against substrate's repository

**When** the dev-story phase completes

**Then** `packages/core/src/index.ts` contains a new exported constant at
the bottom of the existing exports block (after the existing `callLLM`
exports section), reading exactly:

```ts
export const SUBSTRATE_E2E_SMOKE_OK = 'ok' as const
```

The value must be the literal string `'ok'` typed `as const`. No additional
tests or files are required — the existing test suite must still pass.

## Tasks / Subtasks

- [ ] Task 1: Append the exported constant to `packages/core/src/index.ts` (AC: #1)
  - [ ] Open `packages/core/src/index.ts` and locate the bottom of the exports block (after the `callLLM` / `LLMCallParams` / `LLMCallResult` re-exports)
  - [ ] Append the line `export const SUBSTRATE_E2E_SMOKE_OK = 'ok' as const` after the existing `callLLM` exports section
- [ ] Task 2: Build verification (AC: #1)
  - [ ] Run `npm run build` and confirm it exits 0 with no TypeScript errors
- [ ] Task 3: Test suite verification (AC: #1)
  - [ ] Run `npm run test:fast` and confirm all existing tests still pass (no regressions)

## Dev Notes

### File to Modify

- `packages/core/src/index.ts` — append new export after the `callLLM` section at the bottom of the file.

The current bottom of the file (after the LLM client section) reads:

```ts
// LLM client: callLLM, LLMCallParams, LLMCallResult (story 42-10)
export { callLLM } from './llm/client.js'
export type { LLMCallParams, LLMCallResult } from './llm/client.js'
```

Append directly after this block:

```ts
export const SUBSTRATE_E2E_SMOKE_OK = 'ok' as const
```

### Architecture Constraints

- No new files required — single-line addition to the existing barrel export file only.
- No new tests required — existing test suite must continue to pass without modification.
- The constant value must be the literal string `'ok'` typed `as const` — no other shape is acceptable.

### Testing Requirements

- Run `npm run build` (not `npm test`) to verify TypeScript compiles cleanly.
- Run `npm run test:fast` to verify no existing tests regress.
- Do NOT run bare `substrate` to test — it uses the globally published version, not local changes.

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
