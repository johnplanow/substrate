# Story 23-8: Memory Backoff-Retry on Dispatch Hold

Status: ready

## Story

As a pipeline operator running long pipeline sessions,
I want the orchestrator to implement backoff-retry when memory pressure triggers dispatch holds,
so that transient memory pressure doesn't kill the pipeline and the final stories still complete.

Addresses finding 7 (memory pressure kills orchestrator without recovery) from `docs/findings-cross-project-epic4-2026-03-05.md`.

## Acceptance Criteria

### AC1: Backoff-Retry on Memory Pressure
**Given** the dispatcher enters a memory-pressure hold state
**When** the hold persists
**Then** the orchestrator retries dispatch with exponential backoff (30s, 60s, 120s) up to 3 attempts before escalating the story

### AC2: GC Hint Between Stories
**Given** a story completes (any phase)
**When** the orchestrator moves to the next story
**Then** a `global.gc?.()` hint is called (if exposed via `--expose-gc`) and a 2-second pause is inserted to allow memory reclamation

### AC3: Memory State Logged on Hold
**Given** the dispatcher enters a memory-pressure hold
**When** the hold begins
**Then** available memory (MB), threshold (MB), and pressure level are logged at warn level

### AC4: Escalation After Max Retries
**Given** 3 backoff-retry attempts all fail due to sustained memory pressure
**When** the final retry fails
**Then** the story is escalated with reason `memory_pressure_exhausted` and the pipeline continues to the next story (not killed)

### AC5: Pipeline Continues After Memory Escalation
**Given** a story is escalated due to memory pressure
**When** subsequent stories are queued
**Then** the orchestrator attempts them normally (memory may have freed after the escalated story's resources are released)

## Tasks / Subtasks

- [ ] Task 1: Implement backoff-retry loop in dispatch-hold path (AC: #1, #3)
  - [ ] In `dispatcher-impl.ts` or orchestrator dispatch wrapper, add retry logic when memory check fails
  - [ ] Backoff intervals: 30s, 60s, 120s (3 attempts)
  - [ ] Log memory state at each hold entry

- [ ] Task 2: Add GC hint between stories (AC: #2)
  - [ ] After `processStory()` completes, call `global.gc?.()` and `await sleep(2000)`
  - [ ] This is a best-effort hint; no error handling needed

- [ ] Task 3: Escalation on exhausted retries (AC: #4, #5)
  - [ ] After 3 failed retries, escalate story with `reason: 'memory_pressure_exhausted'`
  - [ ] Orchestrator continues to next story in the queue

- [ ] Task 4: Write tests (AC: #1–#5)
  - [ ] Test: memory pressure → backoff retries up to 3 times
  - [ ] Test: memory clears on 2nd retry → dispatch succeeds
  - [ ] Test: 3 retries exhausted → story escalated, pipeline continues
  - [ ] Test: GC hint called between stories (mock global.gc)

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/modules/agent-dispatch/dispatcher-impl.ts` — memory check, dispatch hold
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — GC hint, escalation
- **Test framework**: vitest (not jest).

### Key Context
- During the Epic 4 run, macOS memory dropped to 34MB free (threshold: 256MB) after 5 stories (~2 hours). The orchestrator blocked indefinitely and was killed (likely OOM).
- v0.2.18 relaxed the pressure-level gate from `>= 2` to `>= 4`. v0.2.19 lowered the threshold from 512MB to 256MB. But neither version added recovery logic — just moved the trigger point.
- The process was killed on story 4-6 (the last one), losing code-review results.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
