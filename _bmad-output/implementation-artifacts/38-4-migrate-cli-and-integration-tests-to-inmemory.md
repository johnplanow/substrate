# Story 38-4: Migrate CLI and Integration Tests from WasmSqlite to InMemory

Status: ready
Depends on: 38-1

## Story

As a substrate developer,
I want all CLI command tests and integration tests to use `InMemoryDatabaseAdapter` instead of `createWasmSqliteAdapter()`,
so that the full test suite is free of sql.js dependencies.

## Acceptance Criteria

### AC1: CLI Command Tests Pass
**Given** all test files in `src/cli/commands/__tests__/`
**When** I run them with InMemory adapter
**Then** all tests pass with zero sql.js references

### AC2: Integration Tests Pass
**Given** all test files in `test/integration/` and `src/__tests__/`
**When** I run them with InMemory adapter
**Then** all tests pass

### AC3: Zero WasmSqlite Imports Remain in Scope
**Given** a grep for `createWasmSqliteAdapter|wasm-sqlite-adapter` in `src/cli/`, `src/__tests__/`, and `test/`
**When** I search
**Then** zero matches

## Tasks / Subtasks

- [ ] Task 1: Migrate CLI command tests (AC: #1)
  - [ ] `__tests__/health-bugs.test.ts`
  - [ ] `__tests__/status.test.ts`
  - [ ] `__tests__/status-story-count.test.ts`
  - [ ] `__tests__/status-metrics-v2.test.ts`
  - [ ] `__tests__/metrics.test.ts`
  - [ ] `__tests__/metrics-story-level.test.ts`
  - [ ] `__tests__/metrics-telemetry.test.ts`
  - [ ] `__tests__/auto-status.test.ts`
  - [ ] `__tests__/auto-health.test.ts`
  - [ ] `__tests__/auto-metrics.test.ts`
  - [ ] `__tests__/auto-pipeline.integration.test.ts`
  - [ ] `__tests__/auto-init-scaffolding.integration.test.ts`
  - [ ] `__tests__/auto-supervisor.test.ts`
  - [ ] `__tests__/supervisor-decisions.test.ts`
  - [ ] `__tests__/stall-detection.integration.test.ts`
  - [ ] `__tests__/cross-project-process-detection.test.ts`
  - [ ] `__tests__/sprint-summary.test.ts`
  - [ ] `__tests__/research-pipeline-smoke.test.ts`
  - [ ] `__tests__/migrate.test.ts`

- [ ] Task 2: Migrate integration tests (AC: #2)
  - [ ] `test/integration/epic-12-4-cross-story.test.ts`
  - [ ] `test/integration/epic-12-5-amendment-cli-integration.test.ts`
  - [ ] `src/__tests__/monitor-e2e.test.ts`
  - [ ] `src/__tests__/monitor-routing-integration-e2e.test.ts`
  - [ ] `src/__tests__/epic-8-integration.test.ts`
  - [ ] `src/__tests__/epic9-smoke.test.ts`
  - [ ] `src/__tests__/migration-smoke.test.ts`
  - [ ] `src/__tests__/e2e/epic-9-integration.test.ts`
  - [ ] `src/__tests__/e2e/epic-26-integration.test.ts` (if it uses WasmSqlite)

- [ ] Task 3: Catch-all sweep (AC: #3)
  - [ ] After completing listed files, grep for any remaining `createWasmSqliteAdapter` or `wasm-sqlite-adapter` imports in `src/cli/`, `src/__tests__/`, and `test/`
  - [ ] Migrate any found files not in the task list

## Dev Notes

### Same replacement pattern as 38-2
See Story 38-2 Dev Notes for the find-and-replace pattern.

### File List (~28 test files)
See Tasks above for full list.
