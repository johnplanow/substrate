# Story 31-4: Status Lifecycle — Orchestrator Writes wg_stories Transitions

Status: ready-for-dev

## Story

As the pipeline orchestrator,
I want every story status transition (planned → in_progress → complete/escalated) written to the `wg_stories` table in real-time,
so that the `ready_stories` view stays accurate and dependent stories unblock automatically as soon as their blockers complete.

## Acceptance Criteria

### AC1: Transition to in_progress on first active phase
**Given** a story key exists in `wg_stories` with status `planned` or `ready`
**When** `updateStory(storyKey, { phase: <any active phase> })` is called for the first time (i.e., `IN_STORY_CREATION`, `IN_TEST_PLANNING`, `IN_DEV`, `IN_REVIEW`, or `NEEDS_FIXES`)
**Then** `wg_stories.status` is updated to `in_progress` and `wg_stories.updated_at` is set to the current timestamp

### AC2: Transition to complete on COMPLETE phase
**Given** a story key exists in `wg_stories`
**When** `updateStory(storyKey, { phase: 'COMPLETE', completedAt: '<iso>' })` is called
**Then** `wg_stories.status` is updated to `complete`, `wg_stories.completed_at` is set to the story's `completedAt` value (or `now()` if absent), and `wg_stories.updated_at` is set

### AC3: Transition to escalated on ESCALATED phase
**Given** a story key exists in `wg_stories`
**When** `updateStory(storyKey, { phase: 'ESCALATED', completedAt: '<iso>' })` is called
**Then** `wg_stories.status` is updated to `escalated`, `wg_stories.completed_at` is set, and `wg_stories.updated_at` is set

### AC4: No-op when story is absent from wg_stories
**Given** a story key does NOT exist in `wg_stories` (work graph not populated — Epic 31-2 ingestion has not run for this project)
**When** `wgRepo.updateStoryStatus()` is called with any status value
**Then** the call completes without error, no rows are inserted or modified, and the pipeline continues normally

### AC5: Status writes are fire-and-forget
**Given** the `wg_stories` table is missing or the `DatabaseAdapter` throws on query
**When** the orchestrator calls `updateStoryStatus()` internally
**Then** the error is caught and logged at WARN level, but the error does not propagate and does not cause the pipeline story execution to fail

### AC6: updateStoryStatus() preserves non-status fields
**Given** a story with key `'31-4'` exists in `wg_stories` with `title='Some title'`, `spec_path='/path/to/spec'`, and `epic='31'`
**When** `wgRepo.updateStoryStatus('31-4', 'complete', { completedAt: '2026-03-14T10:00:00.000Z' })` is called
**Then** the row's `status` is `'complete'`, `completed_at` is `'2026-03-14T10:00:00.000Z'`, and `title`, `spec_path`, and `epic` are unchanged

### AC7: Redundant in_progress writes are suppressed
**Given** a story has already transitioned to `in_progress` in `wg_stories` (e.g., when `IN_STORY_CREATION` was set)
**When** `updateStory()` is called again with another active phase (e.g., `IN_DEV` or `IN_REVIEW`)
**Then** `updateStoryStatus()` is NOT called again for `in_progress` — a per-story tracking set prevents redundant DB writes for the same terminal-equivalent status

## Tasks / Subtasks

- [ ] Task 1: Add `updateStoryStatus()` to `WorkGraphRepository` (AC: #4, #5, #6)
  - [ ] In `src/modules/state/work-graph-repository.ts`, add `async updateStoryStatus(storyKey: string, status: WgStoryStatus, opts?: { completedAt?: string }): Promise<void>`
  - [ ] Implementation: SELECT existing row via `SELECT * FROM wg_stories WHERE story_key = ?`; if not found, return early (no-op)
  - [ ] If found, build an updated `WgStory` object: spread existing row, set `status`, set `updated_at = new Date().toISOString()`, set `completed_at` only when status is `'complete'` or `'escalated'` (use `opts.completedAt ?? now`); preserve `completed_at` unchanged for `in_progress`
  - [ ] Call `await this.upsertStory(updated)` to persist the change

- [ ] Task 2: Write unit tests for `updateStoryStatus()` (AC: #4, #5, #6)
  - [ ] In `src/modules/state/__tests__/work-graph-repository.test.ts`, add a `describe('updateStoryStatus')` block
  - [ ] Seed `wg_stories` table in `beforeEach` using the same `CREATE TABLE IF NOT EXISTS` DDL pattern used in existing tests (do not apply full schema.sql)
  - [ ] Test no-op: story key not in `wg_stories` → call completes with no error, no rows created
  - [ ] Test `in_progress` transition: existing row's `status` set to `'in_progress'`, `updated_at` updated, `completed_at` unchanged (not set for `in_progress`)
  - [ ] Test `complete` transition: `status='complete'`, `completed_at` set to provided value, other fields (`title`, `spec_path`, `epic`) preserved (AC6)
  - [ ] Test `escalated` transition: `status='escalated'`, `completed_at` set

- [ ] Task 3: Add `wgStatusForPhase()` helper in orchestrator (AC: #1, #2, #3, #7)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, add a module-level (or top-of-factory) helper: `function wgStatusForPhase(phase: StoryPhase): WgStoryStatus | null`
  - [ ] Return: `null` for `'PENDING'`; `'in_progress'` for `'IN_STORY_CREATION' | 'IN_TEST_PLANNING' | 'IN_DEV' | 'IN_REVIEW' | 'NEEDS_FIXES'`; `'complete'` for `'COMPLETE'`; `'escalated'` for `'ESCALATED'`
  - [ ] Add import: `import { WorkGraphRepository } from '../state/index.js'` and extend the existing `WgStoryStatus` type import from `'../state/index.js'`

- [ ] Task 4: Construct `WorkGraphRepository` and hook into `updateStory()` (AC: #1, #2, #3, #5, #7)
  - [ ] Inside `createImplementationOrchestrator()`, near the top of the factory function, add: `const wgRepo = new WorkGraphRepository(db)` and `const _wgInProgressWritten = new Set<string>()`
  - [ ] In the `updateStory()` function, after the existing `persistStoryState()` fire-and-forget call, add wg_stories update logic:
    - If `updates.phase` is not set, do nothing
    - Call `wgStatusForPhase(updates.phase)` to get the target wg status
    - If target status is `null` (`PENDING`), skip
    - If target status is `'in_progress'` AND `_wgInProgressWritten.has(storyKey)` is true, skip (dedup)
    - Otherwise: fire-and-forget `wgRepo.updateStoryStatus(storyKey, targetStatus, opts)` where `opts.completedAt` is the story's current `completedAt` for terminal phases; add to `_wgInProgressWritten` when writing `in_progress`
  - [ ] Wrap the fire-and-forget call with `.catch((err: unknown) => logger.warn({ err, storyKey }, 'wg_stories status update failed (best-effort)'))`

- [ ] Task 5: Build and test validation (all ACs)
  - [ ] Run `npm run build` — must exit 0
  - [ ] Run `npm run test:fast` — confirm output contains "Test Files" line with all passing; do NOT pipe output

## Dev Notes

### Architecture Constraints

- **File paths to modify**:
  - `src/modules/state/work-graph-repository.ts` — add `updateStoryStatus()`
  - `src/modules/state/__tests__/work-graph-repository.test.ts` — add tests
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — add helper, construct repo, hook into `updateStory()`

- **Import style**: All imports use named exports with `.js` extension (ESM project):
  ```typescript
  import { WorkGraphRepository } from '../state/index.js'
  import type { WgStoryStatus } from '../state/index.js'
  ```

- **Import note**: `WorkGraphRepository` and `WgStoryStatus` are already exported from `src/modules/state/index.ts` (added in story 31-1). No new exports are needed.

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `beforeEach`. Do NOT use Jest APIs.

- **`updateStoryStatus()` pattern**: Uses a read-modify-write approach (SELECT → upsertStory) rather than a SQL UPDATE. This is required because `InMemoryDatabaseAdapter` does not support UPDATE with a WHERE clause returning the modified row count. The existing `upsertStory()` method already uses DELETE + INSERT, which the InMemory adapter handles correctly.

- **Table setup in tests**: Unit tests must create `wg_stories` and `story_dependencies` tables manually using `db.exec()` in `beforeEach`. Do NOT call `schema.sql` (it contains VIEW DDL that InMemory adapter no-ops). Reuse the same DDL from existing tests in `work-graph-repository.test.ts`:
  ```typescript
  beforeEach(async () => {
    db = new InMemoryDatabaseAdapter()
    repo = new WorkGraphRepository(db)
    await db.exec(`CREATE TABLE IF NOT EXISTS wg_stories (
      story_key VARCHAR(20) NOT NULL,
      epic VARCHAR(20) NOT NULL,
      title VARCHAR(255),
      status VARCHAR(30) NOT NULL DEFAULT 'planned',
      spec_path VARCHAR(500),
      created_at DATETIME,
      updated_at DATETIME,
      completed_at DATETIME,
      PRIMARY KEY (story_key)
    )`)
    await db.exec(`CREATE TABLE IF NOT EXISTS story_dependencies (
      story_key VARCHAR(20) NOT NULL,
      depends_on VARCHAR(20) NOT NULL,
      dep_type VARCHAR(20) NOT NULL,
      source VARCHAR(20) NOT NULL,
      created_at DATETIME,
      PRIMARY KEY (story_key, depends_on)
    )`)
  })
  ```

- **`updateStory()` location**: In `orchestrator-impl.ts`, around line 481. The function currently calls `persistStoryState()` fire-and-forget and handles `mergeStory/rollbackStory` for terminal phases. Append the new `wgRepo.updateStoryStatus()` call after the existing fire-and-forget block — do not modify the existing `persistStoryState` or `mergeStory/rollbackStory` logic.

- **`completedAt` extraction**: When phase is `COMPLETE` or `ESCALATED`, the story's `completedAt` is available from `existing.completedAt` (since `updateStory()` may have set it in the same call via `updates.completedAt`). Merge `updates` with `existing` before reading `completedAt`:
  ```typescript
  const fullUpdated = { ...existing, ...updates }
  const opts = (targetStatus === 'complete' || targetStatus === 'escalated')
    ? { completedAt: fullUpdated.completedAt }
    : undefined
  ```

- **Dolt auto-detection**: The `db` passed to `createImplementationOrchestrator()` is already the resolved `DatabaseAdapter`. If Dolt is not in use, `db` is an `InMemoryDatabaseAdapter` or `WasmSqliteDatabaseAdapter` — neither has `wg_stories` populated, so `updateStoryStatus()` will no-op (AC4 behavior). No additional detection logic is needed.

### Testing Requirements

- Unit tests only: `WorkGraphRepository.updateStoryStatus()` tested with `InMemoryDatabaseAdapter` — no Dolt process required
- Do NOT add orchestrator integration tests for this story; the repository-level unit tests are sufficient for coverage
- All new code must remain above the 80% coverage threshold enforced by vitest config
- Run `npm run test:fast` (not `npm test`) to avoid slow feedback; confirm "Test Files" in output

## Interface Contracts

- **Import**: `WorkGraphRepository` @ `src/modules/state/work-graph-repository.ts` (from story 31-1)
- **Import**: `WgStoryStatus`, `WgStory` @ `src/modules/state/types.ts` (from story 31-1)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
