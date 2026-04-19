# Story 38-3a: Migrate Phase Orchestrator Tests from WasmSqlite to InMemory

Status: ready
Depends on: 38-1

## Story

As a substrate developer,
I want all phase-orchestrator test files to use `InMemoryDatabaseAdapter` instead of `createWasmSqliteAdapter()`,
so that these test files no longer fail with `Failed to load url sql.js`.

## Acceptance Criteria

### AC1: All Phase Orchestrator Tests Pass
**Given** all test files in `src/modules/phase-orchestrator/`
**When** I run them with InMemory adapter
**Then** all tests pass with zero sql.js references

### AC2: Zero WasmSqlite Imports Remain in Scope
**Given** a grep for `createWasmSqliteAdapter|wasm-sqlite-adapter` in `src/modules/phase-orchestrator/`
**When** I search
**Then** zero matches

## Tasks / Subtasks

- [ ] Task 1: Migrate phases/__tests__/ (AC: #1)
  - [ ] `solutioning.test.ts`
  - [ ] `ux-design.test.ts`
  - [ ] `solutioning-verdict.test.ts`
  - [ ] `solutioning-readiness-integration.test.ts`
  - [ ] `solutioning-reliability.test.ts`
  - [ ] `solutioning-retry.test.ts`
  - [ ] `planning.test.ts`
  - [ ] `planning-multistep.test.ts`
  - [ ] `research.test.ts`
  - [ ] `analysis.test.ts`
  - [ ] `analysis-multistep.test.ts`
  - [ ] `solutioning-multistep.test.ts`

- [ ] Task 2: Migrate __tests__/ (AC: #1)
  - [ ] `epic-11-integration.test.ts`
  - [ ] `phase-orchestrator.test.ts`
  - [ ] `phase-detection.test.ts`
  - [ ] `step-runner.test.ts`
  - [ ] `elicitation-integration.test.ts`
  - [ ] `critique-loop.test.ts`
  - [ ] `critique-integration.test.ts`
  - [ ] `ux-enabled-integration.test.ts`
  - [ ] `ux-skipped-integration.test.ts`
  - [ ] `research-enabled-integration.test.ts`
  - [ ] `research-disabled-integration.test.ts`
  - [ ] `research-phase-integration.test.ts`
  - [ ] `analysis-research-context.test.ts`
  - [ ] `backward-compat.test.ts`
  - [ ] `built-in-phases.test.ts`
  - [ ] `budget-utils.test.ts`

- [ ] Task 3: Catch-all sweep (AC: #2)
  - [ ] After completing listed files, grep for any remaining `createWasmSqliteAdapter` or `wasm-sqlite-adapter` imports in `src/modules/phase-orchestrator/`
  - [ ] Migrate any found files not in the task list

## Dev Notes

### Same replacement pattern as 38-2
See Story 38-2 Dev Notes for the find-and-replace pattern.

### File List (~28 test files)
See Tasks above for full list. All follow the identical mechanical pattern.
