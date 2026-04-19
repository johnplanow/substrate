# Story 39-5: Capture Checkpoint State on Dev-Story Timeout

Status: review

## Story

As a pipeline operator,
I want the orchestrator to capture the partial work state when a dev-story agent times out,
so that a retry dispatch can pick up where the agent left off instead of starting over.

Fixes issue #1b (part 1): Checkpoint capture.

## Acceptance Criteria

### AC1: Checkpoint Captured on Timeout
**Given** a dev-story dispatch times out after 30 minutes
**When** the orchestrator processes the timeout result
**Then** it captures: (a) list of files modified from `checkGitDiffFiles()`, (b) git diff of those files, (c) partial agent output, and stores this as checkpoint context

### AC2: Story Phase Set to CHECKPOINT
**Given** a dev-story timeout with partial files on disk (files_modified.length > 0)
**When** the orchestrator detects the timeout
**Then** the story phase in Dolt `stories` table is set to `CHECKPOINT` (not ESCALATED)

### AC3: Zero-Diff Timeout Escalates Immediately
**Given** a dev-story timeout with NO files on disk (files_modified.length === 0)
**When** the orchestrator detects the timeout
**Then** the story is escalated immediately (no checkpoint — there's nothing to resume from)

### AC4: Checkpoint Event Emitted
**Given** a checkpoint is captured
**When** the story enters CHECKPOINT phase
**Then** a `story:checkpoint-saved` NDJSON event is emitted with `{ storyKey, filesCount, diffSizeBytes }`

### AC5: Checkpoint Visible in Status
**Given** a story in CHECKPOINT phase
**When** I run `substrate status`
**Then** the story shows phase `CHECKPOINT` with the file count

### AC6: Dispatch Log Records Timeout
**Given** a dev-story timeout
**When** the checkpoint is captured
**Then** a record is written to Dolt `dispatch_log` with `result: 'timeout'`

## Tasks / Subtasks

- [ ] Task 1: Add CHECKPOINT phase to story lifecycle (AC: #2, #5)
  - [ ] In `src/modules/state/types.ts`, add `'CHECKPOINT'` to the `StoryPhase` type
  - [ ] Ensure Dolt `stories` table accepts `CHECKPOINT` as a valid phase value
  - [ ] Update `substrate status` display to handle CHECKPOINT phase

- [ ] Task 2: Capture checkpoint in orchestrator (AC: #1, #2, #3)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, after dev-story returns `status: 'timeout'`
  - [ ] Run `checkGitDiffFiles()` to detect partial work
  - [ ] If files exist: capture git diff, set phase to CHECKPOINT, store context for retry
  - [ ] If no files: escalate immediately (existing behavior)
  - [ ] The checkpoint context (diff, file list) stays in the orchestrator's in-memory state — NOT persisted to Dolt (ephemeral, only needed for immediate retry)

- [ ] Task 3: Emit checkpoint event (AC: #4)
  - [ ] Emit `story:checkpoint-saved` event via eventBus
  - [ ] Include storyKey, filesCount, and approximate diff size

- [ ] Task 4: Record timeout in dispatch_log (AC: #6)
  - [ ] Write a dispatch_log record via Dolt StateStore with `result: 'timeout'`

- [ ] Task 5: Tests
  - [ ] Test: timeout with partial files → CHECKPOINT phase
  - [ ] Test: timeout with zero files → ESCALATED phase
  - [ ] Test: checkpoint event emitted with correct payload
  - [ ] Test: dispatch_log records timeout

## Dev Notes

### Architecture
- **Files**: `src/modules/implementation-orchestrator/orchestrator-impl.ts`, `src/modules/state/types.ts`
- The dev-story timeout path is at `dev-story.ts:339-348` (returns `result: 'failed'`). The orchestrator then handles this at the story dispatch level.
- Currently, timeout → code review of partial work → likely NEEDS_MAJOR_REWORK → rework dispatch. The checkpoint path short-circuits this: timeout → CHECKPOINT → retry (in story 39-6).
- The git diff context is assembled from the live working tree, NOT stored in Dolt. Dolt only records the phase and the fact that a timeout occurred.
- The `dev-story.ts:374-402` fallback already recovers `files_modified` from git — reuse this logic.

### File List
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modify)
- `src/modules/state/types.ts` (modify — add CHECKPOINT phase)
- `src/modules/compiled-workflows/dev-story.ts` (no changes — existing git recovery is reused)
