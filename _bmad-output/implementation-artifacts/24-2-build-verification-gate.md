# Story 24-2: Build Verification Gate

Status: review

## Story

As a pipeline operator,
I want a configurable build verification step to run after dev-story and before code-review,
so that cross-file import errors and interface type mismatches are caught at compile time before wasting a review cycle.

Addresses: Epic 22 cross-file coherence gap (22-7 missing schema export), Epic 23 interface mismatches (99 test regressions from shared interface changes).

## Acceptance Criteria

### AC1: Build Gate Executes Post-Dev
**Given** a dev-story agent completes with COMPLETE and passes the zero-diff check (24-1)
**When** the orchestrator prepares to dispatch code-review
**Then** it first runs the configured `verifyCommand` (default: `npm run build`)

### AC2: Build Success Proceeds to Review
**Given** the `verifyCommand` exits with code 0
**When** the orchestrator evaluates the result
**Then** the story proceeds to code-review as normal

### AC3: Build Failure Escalates
**Given** the `verifyCommand` exits with a non-zero exit code
**When** the orchestrator evaluates the result
**Then** the story status is set to `NEEDS_ESCALATION` with reason `build-verification-failed` and the stderr/stdout is captured in the escalation metadata

### AC4: Configurable via Pack Manifest
**Given** a pack manifest YAML file
**When** it includes a `verifyCommand` field (e.g., `verifyCommand: "npm run build"`)
**Then** the orchestrator uses that command for the build gate

### AC5: Default Command When Not Configured
**Given** no `verifyCommand` in the pack manifest
**When** the build gate runs
**Then** it defaults to `npm run build`

### AC6: Gate Can Be Disabled
**Given** a pack manifest with `verifyCommand: ""` (empty string) or `verifyCommand: false`
**When** the orchestrator reaches the build gate
**Then** the gate is skipped and the story proceeds directly to code-review

### AC7: Structured Event Emission
**Given** a build verification failure occurs
**When** the orchestrator sets the story to NEEDS_ESCALATION
**Then** a structured NDJSON event is emitted: `{ type: "story:build-verification-failed", storyKey, exitCode, output (truncated to 2000 chars) }`

### AC8: Timeout Protection
**Given** the `verifyCommand` is running
**When** it exceeds 60 seconds (configurable via `verifyTimeoutMs`)
**Then** the process is killed and the story is escalated with reason `build-verification-timeout`

## Tasks / Subtasks

- [x] Task 1: Add `verifyCommand` and `verifyTimeoutMs` to pack manifest schema (AC: #4, #5, #6)
  - [x] Update pack manifest types/schema to include optional `verifyCommand: string | false` and `verifyTimeoutMs: number`
  - [x] Default `verifyCommand` to `"npm run build"`, `verifyTimeoutMs` to `60000`

- [x] Task 2: Implement build verification step in dispatcher (AC: #1, #2, #3, #8)
  - [x] In `dispatcher-impl.ts`, after zero-diff check passes and before code-review dispatch
  - [x] Read `verifyCommand` from pack manifest (or use default)
  - [x] If empty/false: skip gate
  - [x] Execute command via `execSync` with timeout, capture stdout+stderr
  - [x] Exit 0: proceed to code-review
  - [x] Non-zero / timeout: set NEEDS_ESCALATION with reason and captured output

- [x] Task 3: Add structured event for build gate outcomes (AC: #7)
  - [x] Emit NDJSON event on failure with type, storyKey, exitCode, truncated output
  - [x] Optionally emit success event for observability: `story:build-verification-passed`

- [x] Task 4: Unit tests (AC: #1-#8)
  - [x] Test: build succeeds (exit 0) → proceeds to review
  - [x] Test: build fails (exit 1) → NEEDS_ESCALATION with output captured
  - [x] Test: build times out → NEEDS_ESCALATION with timeout reason
  - [x] Test: verifyCommand from pack manifest used when present
  - [x] Test: default `npm run build` used when not configured
  - [x] Test: verifyCommand = "" → gate skipped
  - [x] Test: verifyCommand = false → gate skipped
  - [x] Test: event emission on failure

## Dev Notes

### Architecture Constraints
- **Files**: `src/modules/agent-dispatch/dispatcher-impl.ts` (gate logic), pack manifest schema (new fields)
- **Sequence**: This gate runs AFTER the zero-diff check (24-1) and BEFORE code-review dispatch
- **Modular Monolith (ADR-001)**: Gate logic inline in dispatcher; pack manifest schema update in its existing location
- **Import style**: `.js` extension on all local imports (ESM)
- **Test framework**: vitest (not jest)
- **Build time baseline**: `npm run build` = 1.4s (measured 2026-03-06)

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest)
- Mock `execSync` for build command in tests
- Test both the pack-manifest-present and pack-manifest-absent paths
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Completion Notes List
- Implemented `runBuildVerification` in `dispatcher-impl.ts` using `execSync` with timeout/cwd support
- Added `verifyCommand` and `verifyTimeoutMs` to pack manifest types and Zod schema
- Added `story:build-verification-failed` and `story:build-verification-passed` to `event-bus.types.ts` and `event-types.ts`
- Gate inserted in `orchestrator-impl.ts` after zero-diff check (story 24-1) and before code-review dispatch
- Added 17 unit tests in `build-verification.test.ts`; full suite: 4717 tests all passing (up from 4690)
- Updated `PIPELINE_EVENT_METADATA` in `help-agent.ts` and `EVENT_TYPE_NAMES` in `event-types.ts`
- Updated orchestrator test and epic-10-integration test to mock `runBuildVerification`

### File List
- /Users/John.Planow/code/jplanow/substrate/src/modules/methodology-pack/types.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/methodology-pack/schemas.ts
- /Users/John.Planow/code/jplanow/substrate/src/core/event-bus.types.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/agent-dispatch/dispatcher-impl.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/agent-dispatch/__tests__/build-verification.test.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/orchestrator-impl.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/event-types.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/help-agent.ts
- /Users/John.Planow/code/jplanow/substrate/src/cli/commands/__tests__/help-agent.test.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts
- /Users/John.Planow/code/jplanow/substrate/src/__tests__/e2e/epic-10-integration.test.ts

## Change Log
