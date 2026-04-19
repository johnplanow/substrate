# Story 25-6: Post-Sprint Contract Verification Gate

Status: review

## User Story

As a pipeline operator,
I want a post-sprint verification step that validates all declared contracts are satisfied,
so that cross-story schema mismatches are caught before the pipeline reports success.

## Background

Stories 25-4 and 25-5 introduced contract declarations (exports/imports) and contract-aware dispatch ordering. However, even with proper ordering, a dev agent may deviate from the declared schema during implementation. This story adds a post-sprint verification pass that checks whether all declared export/import pairs actually match.

The verification runs after all sprint stories complete (but before the pipeline emits `pipeline:complete`). For each export/import pair, it verifies the exported schema file exists and the importing story references it correctly. If a TypeScript project, it also runs a type-check across affected packages to detect interface mismatches.

## Acceptance Criteria

### AC1: Post-Sprint Contract Verification Pass
**Given** all sprint stories have completed
**When** the orchestrator is about to emit `pipeline:complete`
**Then** it runs a contract verification pass over all declared export/import pairs

### AC2: Exported File Existence Check
**Given** a story declared an export with a schema file path
**When** the verification pass runs
**Then** it checks that the exported file actually exists on disk

### AC3: TypeScript Type-Check for Contract Mismatches
**Given** the project is a TypeScript project (has tsconfig.json)
**When** the verification pass runs with export/import pairs
**Then** it runs `tsc --noEmit` to detect interface mismatches across the affected files

### AC4: Contract Mismatch Event
**Given** the verification pass finds a mismatch (missing file, type error, schema disagreement)
**When** a mismatch is detected
**Then** emit a `pipeline:contract-mismatch` event with details: exporter story, importer story, schema name, mismatch description

### AC5: User Escalation on Failure
**Given** one or more contract verification failures
**When** the pipeline finishes
**Then** the failures are escalated to the user (not auto-fixable) with a summary of which contracts failed and why

## Dev Notes

- The contract declarations are stored in the decision store with category `interface-contract` (from Story 25-4)
- Query the decision store for all `interface-contract` declarations at the end of the run
- Group by contract name to find export/import pairs
- For file existence: use `existsSync()` on the declared file paths
- For TypeScript check: run `tsc --noEmit` via `execSync` (similar to how build verification runs)
- Add `pipeline:contract-mismatch` event type to `event-types.ts`
- The verification logic can be a new module `src/modules/implementation-orchestrator/contract-verifier.ts`
- Wire into `orchestrator.run()` after all stories complete but before returning status
- Failed contracts should add warnings to the pipeline status, not block the pipeline from completing — the stories themselves already completed

## Tasks

- [x] Task 1: Add `pipeline:contract-mismatch` event type to `event-types.ts` (AC: #4)
  - [x] Define event with fields: exporter, importer, contractName, mismatchDescription
- [x] Task 2: Create contract verifier module (AC: #1, #2, #3)
  - [x] Create `src/modules/implementation-orchestrator/contract-verifier.ts`
  - [x] Implement `verifyContracts(declarations, projectRoot)` function
  - [x] Check exported file existence for each export declaration
  - [x] For TypeScript projects, run `tsc --noEmit` and capture errors
  - [x] Return array of verification results (pass/fail per contract pair)
- [x] Task 3: Wire contract verification into orchestrator (AC: #1, #4, #5)
  - [x] After all stories reach terminal state, query `interface-contract` decisions
  - [x] Call `verifyContracts()` and emit `pipeline:contract-mismatch` events for failures
  - [x] Include verification failures in the pipeline status summary
- [x] Task 4: Write unit tests for contract verifier (AC: #2, #3)
  - [x] Test: exported file exists → passes
  - [x] Test: exported file missing → fails with descriptive message
  - [x] Test: TypeScript type-check passes → no mismatch
  - [x] Test: TypeScript type-check fails → mismatch reported
  - [x] Test: no declarations → verification passes trivially
- [x] Task 5: Write integration test for end-to-end flow (AC: #1, #4, #5)
  - [x] Test: orchestrator runs verification after all stories complete
  - [x] Test: mismatch events are emitted correctly

## File List

- `src/modules/implementation-orchestrator/event-types.ts` (modified)
- `src/core/event-bus.types.ts` (modified)
- `src/modules/implementation-orchestrator/contract-verifier.ts` (new)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modified)
- `src/modules/implementation-orchestrator/types.ts` (modified)
- `src/cli/commands/run.ts` (modified)
- `src/cli/commands/help-agent.ts` (modified)
- `src/cli/commands/__tests__/help-agent.test.ts` (modified)
- `src/modules/implementation-orchestrator/__tests__/contract-verifier.test.ts` (new)
- `src/modules/implementation-orchestrator/__tests__/contract-verification-integration.test.ts` (new)
