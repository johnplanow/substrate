# Story 24-3: Interface Change Detection Warning

Status: review

## Story

As a pipeline operator,
I want the orchestrator to warn when a dev-story modifies files that export shared TypeScript interfaces,
so that I am alerted to potential downstream test breakage from stale mocks before it cascades.

Addresses: Epic 23 Sprint 3 — 99 test regressions from a single shared interface change (getMemoryState on Dispatcher).

## Acceptance Criteria

### AC1: Detect Interface-Exporting Files in Diff
**Given** a dev-story completes with file modifications
**When** the orchestrator has the list of modified files (from the zero-diff check in 24-1)
**Then** it identifies `.ts` files in the diff that contain `export interface` or `export type` declarations

### AC2: Cross-Reference Test Files
**Given** one or more modified files export interfaces/types
**When** the orchestrator runs the detection
**Then** it searches test files (`**/*.test.ts`, `**/*.spec.ts`) for imports or mocks referencing the modified interface names

### AC3: Warning Event Emission (Non-Blocking)
**Given** matching test files are found that may have stale mocks
**When** the detection completes
**Then** a structured NDJSON warning event is emitted: `{ type: "story:interface-change-warning", storyKey, modifiedInterfaces: [...], potentiallyAffectedTests: [...] }`
**And** the story proceeds to code-review (warning is non-blocking)

### AC4: No False Positives on Internal Types
**Given** a modified file exports only types used within the same module (no cross-module test references)
**When** the detection runs
**Then** no warning is emitted (only warn when test files outside the story's scope reference the interface)

### AC5: Graceful Degradation
**Given** the interface detection logic encounters an error (e.g., grep fails, file not found)
**When** the detection runs
**Then** the error is logged but the story proceeds normally (detection failure never blocks the pipeline)

## Tasks / Subtasks

- [x] Task 1: Extract exported interface names from modified .ts files (AC: #1)
  - [x] Parse `files_modified` list from dev-story result
  - [x] For each `.ts` file: read content and extract `export interface Foo` / `export type Bar` names
  - [x] Collect set of exported interface/type names

- [x] Task 2: Search test files for references to modified interfaces (AC: #2, #4)
  - [x] For each interface name: grep `**/*.test.ts` and `**/*.spec.ts` for the name
  - [x] Filter out test files that belong to the same module as the modified source file
  - [x] Collect set of potentially affected test files

- [x] Task 3: Emit warning event (AC: #3, #5)
  - [x] If affected tests found: emit NDJSON warning event with interface names and test file paths
  - [x] If no affected tests: no event emitted
  - [x] Wrap entire detection in try/catch — log errors, never block pipeline

- [x] Task 4: Unit tests (AC: #1-#5)
  - [x] Test: modified file with `export interface` → interface name extracted
  - [x] Test: modified file with no exports → no warning
  - [x] Test: test file referencing modified interface → warning emitted
  - [x] Test: test file in same module → filtered out (no warning)
  - [x] Test: detection error → logged, pipeline continues
  - [x] Test: warning event structure matches schema

## Dev Notes

### Architecture Constraints
- **File**: `src/modules/agent-dispatch/dispatcher-impl.ts` (or a co-located utility function)
- **Non-blocking**: This is a warning system, never a gate. Detection failure must never block pipeline flow.
- **Performance**: Keep it fast — simple regex extraction + grep, not AST parsing. Target <500ms.
- **Modular Monolith (ADR-001)**: Co-locate with dispatcher; no new module needed
- **Import style**: `.js` extension on all local imports (ESM)
- **Test framework**: vitest (not jest)

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest)
- Use fixture files for interface extraction tests
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Implemented `detectInterfaceChanges()` in a new co-located file `interface-change-detector.ts` (not in dispatcher-impl.ts directly, to keep concerns separate and testable)
- `extractExportedNames()` uses regex `/^export\s+(?:interface|type)\s+(\w+)/gm` — no AST parsing
- Same-module filtering: test file directory must start with source file's directory + `/` to prevent false matches on shared prefixes (e.g., `src/mymodule-extended` is NOT same module as `src/mymodule`)
- Added `StoryInterfaceChangeWarningEvent` to event-types.ts, updated `PipelineEvent` union and `EVENT_TYPE_NAMES`
- Added metadata entry in help-agent.ts and updated help-agent.test.ts expected types list
- Wired detection in orchestrator-impl.ts after build verification gate using `devFilesModified` variable
- Added NDJSON event handler in run.ts for `story:interface-change-warning`
- All 4752 tests pass after changes

### File List
- src/modules/agent-dispatch/interface-change-detector.ts (NEW)
- src/modules/agent-dispatch/__tests__/interface-change-detector.test.ts (NEW)
- src/modules/implementation-orchestrator/event-types.ts (MODIFIED)
- src/modules/implementation-orchestrator/orchestrator-impl.ts (MODIFIED)
- src/cli/commands/help-agent.ts (MODIFIED)
- src/cli/commands/help-agent.test.ts (MODIFIED — auto-updated by test fix)
- src/cli/commands/__tests__/help-agent.test.ts (MODIFIED)
- src/cli/commands/run.ts (MODIFIED)

## Change Log
