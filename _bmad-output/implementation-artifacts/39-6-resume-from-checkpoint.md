# Story 39-6: Resume From Checkpoint on Retry

Status: review
Depends on: 39-5

## Story

As a pipeline operator,
I want the orchestrator to automatically retry a timed-out story with the partial work context injected,
so that the agent picks up where it left off instead of starting over, saving one review-rework cycle.

Fixes issue #1b (part 2): Checkpoint resume.

## Acceptance Criteria

### AC1: Automatic Retry After Checkpoint
**Given** a story in CHECKPOINT phase (captured by 39-5)
**When** the orchestrator processes the checkpoint
**Then** it dispatches a retry with the dev-story task type (not major-rework)

### AC2: Retry Prompt Includes Partial Work Context
**Given** a checkpoint with 5 files modified and a git diff
**When** the retry dispatch is assembled
**Then** the prompt includes: (a) the original story content, (b) "Your prior attempt timed out. Here is the work you completed:" followed by the git diff, (c) "Continue from where you left off. Do not redo completed work."

### AC3: Retry Uses Same Turn Budget
**Given** a checkpoint retry
**When** the dispatch is configured
**Then** it uses the same `dev-story` timeout and max-turns as the original dispatch (not a reduced budget)

### AC4: Second Timeout Escalates
**Given** a checkpoint retry that also times out
**When** the orchestrator processes the second timeout
**Then** the story is escalated (no infinite retry loop — maximum one checkpoint retry per story)

### AC5: Successful Retry Proceeds to Review
**Given** a checkpoint retry that completes successfully
**When** the agent emits the YAML output contract
**Then** the story proceeds to code review as normal (same as a successful first-attempt dev-story)

### AC6: Retry Event Emitted
**Given** a checkpoint retry is dispatched
**When** the retry starts
**Then** a `story:checkpoint-retry` NDJSON event is emitted with `{ storyKey, filesCount, attempt: 2 }`

## Tasks / Subtasks

- [x] Task 1: Add checkpoint retry logic to orchestrator (AC: #1, #4)
  - [x] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, after setting CHECKPOINT phase (from 39-5)
  - [x] Track retry count per story (in-memory counter, not DB)
  - [x] If retryCount < 1: dispatch checkpoint retry
  - [x] If retryCount >= 1: escalate (second timeout = give up)

- [x] Task 2: Assemble checkpoint retry prompt (AC: #2, #3)
  - [x] Create a new prompt section assembly similar to major-rework but for checkpoint resume
  - [x] Sections: `story_content` (required), `checkpoint_context` (required — git diff + file list), `arch_constraints` (optional)
  - [x] Use the dev-story prompt template (not rework-story) with a preamble: "Your prior attempt timed out. Continue from the work below."
  - [x] Use same `dev-story` timeout (30 min) and turn budget

- [x] Task 3: Dispatch and handle result (AC: #5)
  - [x] Dispatch with `taskType: 'dev-story'` and `outputSchema: DevStoryResultSchema`
  - [x] On success: proceed to code review (same as normal dev-story completion)
  - [x] On timeout: escalate (AC4)
  - [x] On failure: proceed to code review (let reviewer decide)

- [x] Task 4: Emit retry event (AC: #6)
  - [x] Emit `story:checkpoint-retry` event before dispatching

- [x] Task 5: Tests
  - [x] Test: CHECKPOINT story gets retry dispatch with context
  - [x] Test: retry prompt contains git diff and "continue from where you left off"
  - [x] Test: successful retry → proceeds to code review
  - [x] Test: retry timeout → ESCALATED (no infinite loop)
  - [x] Test: retry event emitted with correct payload

## Dev Notes

### Architecture
- **File**: `src/modules/implementation-orchestrator/orchestrator-impl.ts` — main change
- The major-rework prompt assembly at lines 2323-2422 is the template for this work: story content + context sections + git diff. The checkpoint retry is simpler — no review findings section, just prior work context.
- The prompt template should be `dev-story` (not `rework-story`) because this is a continuation, not a re-do. The agent should see the story spec and the prior work, and pick up where it left off.
- The git diff is captured at checkpoint time (39-5) and held in orchestrator memory. It's NOT re-read from disk at retry time (the working tree may have been modified by other concurrent stories).
- Max one retry per story prevents infinite timeout loops. This is tracked by an in-memory `Map<string, number>` in the orchestrator, not in Dolt.

### File List
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modify)
- `packs/bmad/prompts/dev-story.md` (possibly modify — add checkpoint resume section handling)
