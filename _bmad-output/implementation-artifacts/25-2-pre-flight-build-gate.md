# Story 25-2: Pre-Flight Build Gate

Status: pending

## User Story

As a pipeline operator,
I want the pipeline to verify the target project builds successfully before dispatching any stories,
so that dev agents don't produce code masked by pre-existing build failures.

## Background

The pipeline currently dispatches stories into projects without checking whether the project builds. Build verification (Story 24-2) only runs post-dev, meaning dev agents may produce code that "works" in isolation but is masked by existing breakage. The v0.2.29 cross-project run dispatched into a project with broken builds — wasting tokens on stories that could never pass verification.

The build verification infrastructure already exists: `verifyBuild()` in the orchestrator runs the project's build command and checks the exit code. Story 24-8 added auto-detected package manager support. This story reuses that infrastructure but runs it *before* the first story dispatch.

## Acceptance Criteria

### AC1: Pre-Flight Build Execution
**Given** the orchestrator is about to dispatch the first story
**When** the pipeline run starts
**Then** the orchestrator runs the project's build command (e.g., `npm run build`) before dispatching any story

### AC2: Pre-Flight Failure Event and Abort
**Given** the pre-flight build command exits with a non-zero code
**When** the build failure is detected
**Then** emit a `pipeline:pre-flight-failure` event with `exitCode` and `output` fields, and abort the pipeline with an actionable error message

### AC3: Respect verifyCommand Config
**Given** the project config specifies a custom `verifyCommand`
**When** the pre-flight build runs
**Then** it uses the same `verifyCommand` as the post-dev build gate (Story 24-2)

### AC4: Auto-Detected Package Manager
**Given** the project uses yarn, pnpm, or bun instead of npm
**When** the pre-flight build runs
**Then** it uses the auto-detected package manager (Story 24-8) for the build command

### AC5: Skip Pre-Flight Flag
**Given** the user passes `--skip-preflight` to `substrate run`
**When** the pipeline starts
**Then** the pre-flight build check is skipped entirely (escape hatch for known-broken projects)

## Dev Notes

- The `verifyBuild()` function already exists in the orchestrator — reuse it for pre-flight
- The `detectPackageManager()` function from Story 24-8 is already available
- The pre-flight check should run once before the first `processStory()` call in `orchestrator.run()`
- Add the `--skip-preflight` flag to `src/cli/commands/run.ts` and thread it through to the orchestrator config
- Event type `pipeline:pre-flight-failure` needs to be added to `event-types.ts`

## Tasks

- [ ] Task 1: Add `pipeline:pre-flight-failure` event type to `src/modules/implementation-orchestrator/event-types.ts` (AC: #2)
- [ ] Task 2: Add pre-flight build check in `orchestrator.run()` before the first story dispatch (AC: #1, #3, #4)
  - [ ] Call `verifyBuild()` or equivalent with the project's build command
  - [ ] Use `detectPackageManager()` for the default build command
  - [ ] Respect `verifyCommand` from config if set
- [ ] Task 3: On pre-flight failure, emit event and abort pipeline (AC: #2)
  - [ ] Emit `pipeline:pre-flight-failure` event with exitCode and output
  - [ ] Return early from `orchestrator.run()` with failure status
- [ ] Task 4: Add `--skip-preflight` CLI flag to `src/cli/commands/run.ts` (AC: #5)
  - [ ] Thread the flag through to orchestrator config
  - [ ] When set, skip the pre-flight build check
- [ ] Task 5: Write unit tests for pre-flight build gate (AC: #1-#5)
  - [ ] Test: pre-flight passes, stories proceed normally
  - [ ] Test: pre-flight fails, pipeline aborts with event
  - [ ] Test: `--skip-preflight` bypasses the check
  - [ ] Test: custom verifyCommand is respected
  - [ ] Test: auto-detected package manager is used
