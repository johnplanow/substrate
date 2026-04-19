# Story 38-3b: Migrate Remaining Module Tests from WasmSqlite to InMemory

Status: review
Depends on: 38-1

## Story

As a substrate developer,
I want all remaining module-level tests (cost-tracker, telemetry, supervisor, implementation-orchestrator) to use `InMemoryDatabaseAdapter` instead of `createWasmSqliteAdapter()`,
so that these test files no longer fail with `Failed to load url sql.js`.

## Acceptance Criteria

### AC1: Cost Tracker Tests Pass
**Given** `src/modules/cost-tracker/__tests__/cost-tracker.test.ts`
**When** I run it with InMemory adapter
**Then** all 56 tests pass (currently 46 fail)

### AC2: Telemetry Tests Pass
**Given** test files in `src/modules/telemetry/__tests__/`
**When** I run them with InMemory adapter
**Then** all tests pass

### AC3: Supervisor Tests Pass
**Given** `src/modules/supervisor/__tests__/experimenter.test.ts`
**When** I run it with InMemory adapter
**Then** all 55 tests pass (currently 1 fails)

### AC4: Implementation Orchestrator Tests Pass
**Given** test files in `src/modules/implementation-orchestrator/__tests__/` that use WasmSqlite
**When** I run them with InMemory adapter
**Then** all tests pass

### AC5: Zero WasmSqlite Imports Remain in Module Scope
**Given** a grep for `createWasmSqliteAdapter|wasm-sqlite-adapter` in `src/modules/`
**When** I search (excluding phase-orchestrator which is covered by 38-3a)
**Then** zero matches

## Tasks / Subtasks

- [x] Task 1: Migrate cost-tracker tests (AC: #1)
  - [x] `src/modules/cost-tracker/__tests__/cost-tracker.test.ts`

- [x] Task 2: Migrate telemetry tests (AC: #2)
  - [x] `src/modules/telemetry/__tests__/efficiency-scores.integration.test.ts`
  - [x] `src/modules/telemetry/__tests__/persistence-telemetry-query.test.ts`
  - [x] `src/modules/telemetry/__tests__/recommender.test.ts`
  - [x] `src/modules/telemetry/__tests__/categorizer.test.ts`
  - [x] `src/modules/telemetry/__tests__/consumer-analyzer.test.ts`
  - [x] `src/modules/telemetry/__tests__/ingestion-pipeline.integration.test.ts`

- [x] Task 3: Migrate supervisor and implementation-orchestrator tests (AC: #3, #4)
  - [x] `src/modules/supervisor/__tests__/experimenter.test.ts`
  - [x] `src/modules/implementation-orchestrator/__tests__/story-metrics-event.test.ts`
  - [x] `src/modules/implementation-orchestrator/__tests__/story-metrics-integration.test.ts`
  - [x] `src/modules/implementation-orchestrator/__tests__/story-metrics-decisions.test.ts`
  - [x] `src/modules/implementation-orchestrator/__tests__/project-findings.test.ts`
  - [x] `src/modules/implementation-orchestrator/__tests__/resolve-story-keys.test.ts`
  - [x] `src/modules/implementation-orchestrator/__tests__/lgtm-with-notes.test.ts`
  - [x] `src/modules/implementation-orchestrator/__tests__/seed-methodology-context.test.ts`

- [x] Task 4: Migrate remaining module tests (AC: #5)
  - [x] `src/modules/compiled-workflows/__tests__/create-story.test.ts` (already clean)
  - [x] `src/modules/compiled-workflows/__tests__/code-review.test.ts` (already clean)
  - [x] `src/modules/compiled-workflows/__tests__/test-expansion.test.ts` (already clean)
  - [x] `src/modules/context-compiler/__tests__/context-compiler.test.ts`
  - [x] `src/modules/debate-panel/__tests__/debate-panel.test.ts`
  - [x] `src/modules/amendment-handlers/__tests__/context-handler.test.ts` (already clean)
  - [x] `src/modules/export/__tests__/integration.test.ts`
  - [x] `src/modules/export/__tests__/export-action.test.ts`
  - [x] `src/modules/export/__tests__/renderers.test.ts` (already clean)

- [x] Task 5: Catch-all sweep (AC: #5)
  - [x] After completing listed files, grep for any remaining `createWasmSqliteAdapter` or `wasm-sqlite-adapter` imports in `src/modules/` (excluding `phase-orchestrator/`)
  - [x] Zero matches found

## Dev Notes

### Same replacement pattern as 38-2
See Story 38-2 Dev Notes for the find-and-replace pattern.

### File List (~24 test files)
See Tasks above for full list.
