# Story 31-1: Create Dolt Work Graph Schema

Status: ready-for-dev

## Story

As a pipeline orchestrator,
I want `wg_stories` and `story_dependencies` tables plus a `ready_stories` view in the Dolt schema,
so that subsequent stories (31-2 through 31-3) can populate and query the work graph to enforce dependency ordering during dispatch.

## Acceptance Criteria

### AC1: wg_stories table created in schema.sql
**Given** the Dolt schema initialization runs
**When** `initializeDolt()` applies `schema.sql`
**Then** a `wg_stories` table exists with columns: `story_key` (VARCHAR(20) PK), `epic` (VARCHAR(20) NOT NULL), `title` (VARCHAR(255)), `status` (VARCHAR(30) NOT NULL DEFAULT 'planned'), `spec_path` (VARCHAR(500)), `created_at` (DATETIME), `updated_at` (DATETIME), `completed_at` (DATETIME)

### AC2: story_dependencies table created in schema.sql
**Given** the Dolt schema initialization runs
**When** `initializeDolt()` applies `schema.sql`
**Then** a `story_dependencies` table exists with columns: `story_key` (VARCHAR(20)), `depends_on` (VARCHAR(20)), `dep_type` (VARCHAR(20) NOT NULL — 'blocks' or 'informs'), `source` (VARCHAR(20) NOT NULL — 'explicit', 'contract', or 'inferred'), `created_at` (DATETIME), with composite PRIMARY KEY (`story_key`, `depends_on`)

### AC3: ready_stories view created in schema.sql
**Given** the Dolt schema initialization runs
**When** `initializeDolt()` applies `schema.sql`
**Then** a `ready_stories` view exists that selects from `wg_stories` where `status IN ('planned','ready')` and no unsatisfied `dep_type='blocks'` dependencies exist (i.e. all blocking parent stories have `status = 'complete'`)

### AC4: WorkGraphRepository implements story and dependency CRUD
**Given** a `WorkGraphRepository` initialized with a `DatabaseAdapter`
**When** callers invoke `upsertStory()`, `addDependency()`, or `listStories()`
**Then** the correct rows are written to / read from `wg_stories` and `story_dependencies`

### AC5: WorkGraphRepository.getReadyStories() returns only dispatchable stories
**Given** a set of stories and dependencies in `wg_stories` and `story_dependencies`
**When** some stories have unsatisfied 'blocks' dependencies and others do not
**Then** `getReadyStories()` returns only stories with status `planned` or `ready` that have no incomplete blocking dependencies; 'informs' (soft) dependencies never block dispatch

### AC6: Schema version bumped to 7
**Given** the schema.sql is applied
**When** `_schema_version` is queried
**Then** a version 7 row exists with description `'Add wg_stories, story_dependencies tables and ready_stories view (Epic 31-1)'`

### AC7: Unit tests cover WorkGraphRepository with InMemoryDatabaseAdapter
**Given** a test suite at `src/modules/state/__tests__/work-graph-repository.test.ts`
**When** `npm run test:fast` runs
**Then** all tests pass, covering: upsertStory (insert + update), addDependency (insert + idempotent duplicate), getReadyStories (no-dep story included, complete blocker included, incomplete blocker excluded, soft 'informs' dep does not block), and listStories with epic/status filters

## Tasks / Subtasks

- [ ] Task 1: Add wg_stories and story_dependencies tables + ready_stories view to schema.sql (AC: #1, #2, #3, #6)
  - [ ] Append new DDL after the final `INSERT IGNORE INTO _schema_version` entry at the end of `src/modules/state/schema.sql`
  - [ ] Add `CREATE TABLE IF NOT EXISTS wg_stories` with all columns from AC1 (use DATETIME not TIMESTAMP, to match existing schema patterns)
  - [ ] Add `CREATE INDEX IF NOT EXISTS idx_wg_stories_epic ON wg_stories (epic)`
  - [ ] Add `CREATE TABLE IF NOT EXISTS story_dependencies` with all columns and composite PK from AC2
  - [ ] Add `CREATE OR REPLACE VIEW ready_stories AS SELECT s.* FROM wg_stories s WHERE s.status IN ('planned', 'ready') AND NOT EXISTS (SELECT 1 FROM story_dependencies d JOIN wg_stories dep ON dep.story_key = d.depends_on WHERE d.story_key = s.story_key AND d.dep_type = 'blocks' AND dep.status <> 'complete')`
  - [ ] Add `INSERT IGNORE INTO _schema_version (version, description) VALUES (7, 'Add wg_stories, story_dependencies tables and ready_stories view (Epic 31-1)')`

- [ ] Task 2: Define TypeScript types for work graph entities (AC: #4)
  - [ ] Add `WgStory` interface to `src/modules/state/types.ts` with fields: `story_key`, `epic`, `title` (optional), `status`, `spec_path` (optional), `created_at` (optional), `updated_at` (optional), `completed_at` (optional)
  - [ ] Add `StoryDependency` interface to `src/modules/state/types.ts` with fields: `story_key`, `depends_on`, `dep_type` (literal union: `'blocks' | 'informs'`), `source` (literal union: `'explicit' | 'contract' | 'inferred'`), `created_at` (optional)
  - [ ] Add `WgStoryStatus` type alias: `type WgStoryStatus = 'planned' | 'ready' | 'in_progress' | 'complete' | 'escalated' | 'blocked'`

- [ ] Task 3: Create WorkGraphRepository class (AC: #4, #5)
  - [ ] Create `src/modules/state/work-graph-repository.ts` with class `WorkGraphRepository` taking `DatabaseAdapter` in constructor
  - [ ] Implement `upsertStory(story: WgStory): Promise<void>` — DELETE then INSERT (to handle upsert on InMemory adapter which may not support ON DUPLICATE KEY UPDATE)
  - [ ] Implement `addDependency(dep: StoryDependency): Promise<void>` — INSERT IGNORE into story_dependencies
  - [ ] Implement `listStories(filter?: { epic?: string; status?: string }): Promise<WgStory[]>` — SELECT with optional WHERE clauses built programmatically
  - [ ] Implement `getReadyStories(): Promise<WgStory[]>` — programmatic multi-step query (see Dev Notes); do NOT query the `ready_stories` VIEW directly (not supported by InMemoryDatabaseAdapter)
  - [ ] Export `WorkGraphRepository` from `src/modules/state/index.ts`; also export `WgStory`, `StoryDependency`, `WgStoryStatus` types

- [ ] Task 4: Write unit tests for WorkGraphRepository (AC: #7)
  - [ ] Create `src/modules/state/__tests__/work-graph-repository.test.ts`
  - [ ] Use `InMemoryDatabaseAdapter` as the test backend — create fresh adapter per test/describe block; CREATE TABLE directly in beforeEach (do not apply full schema.sql)
  - [ ] Test `upsertStory()`: insert new story, then upsert with updated status — verify only one row exists with new status
  - [ ] Test `addDependency()`: insert dep, insert same dep again — verify idempotent (one row)
  - [ ] Test `getReadyStories()`: (a) story with no deps → included; (b) story with a 'blocks' dep whose blocker is 'complete' → included; (c) story with a 'blocks' dep whose blocker is 'in_progress' → excluded; (d) story with an 'informs' dep whose blocker is 'in_progress' → included (soft dep does not block)
  - [ ] Test `listStories()` with `{ epic: '31' }` filter, `{ status: 'planned' }` filter, and no filter

- [ ] Task 5: Handle CREATE OR REPLACE VIEW in InMemoryDatabaseAdapter (AC: #3)
  - [ ] In `src/persistence/memory-adapter.ts`, locate the `exec()` method's DDL handling block
  - [ ] Add a guard: if the SQL statement starts with `CREATE OR REPLACE VIEW` or `CREATE VIEW`, treat it as a no-op and return without error
  - [ ] This ensures `schema.sql` can be applied in full without throwing on InMemory backends during integration scenarios

- [ ] Task 6: Build and test validation (AC: #7)
  - [ ] Run `npm run build` — must exit 0
  - [ ] Run `npm run test:fast` — confirm output contains "Test Files" line with all passing; do NOT pipe output

## Dev Notes

### Architecture Constraints

- **File locations (must match exactly)**:
  - Schema DDL: `src/modules/state/schema.sql` — append after last line of file
  - Repository: `src/modules/state/work-graph-repository.ts` — new file
  - Types: `src/modules/state/types.ts` — add interfaces after existing type definitions
  - State module index: `src/modules/state/index.ts` — add exports
  - Memory adapter: `src/persistence/memory-adapter.ts` — VIEW no-op guard in `exec()`
  - Tests: `src/modules/state/__tests__/work-graph-repository.test.ts` — new file

- **Import style**: All imports use `.js` extensions (ESM). Example:
  ```typescript
  import { WorkGraphRepository } from './work-graph-repository.js'
  import type { DatabaseAdapter } from '../../persistence/adapter.js'
  import type { WgStory, StoryDependency } from './types.js'
  ```

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `beforeEach`. Do NOT use Jest APIs.

- **Table naming rationale**: The existing `stories` table in `schema.sql` tracks runtime pipeline state (status: PENDING/IN_PROGRESS/COMPLETE/FAILED). The new `wg_stories` table tracks planning-level work graph state (status: planned/ready/in_progress/complete/escalated/blocked). Using `wg_stories` avoids naming collision and breakage of existing orchestrator code. Future stories (31-4, 31-8) can consolidate these tables once dispatch gating is live.

- **getReadyStories() programmatic implementation** — do NOT query the `ready_stories` VIEW:
  ```typescript
  async getReadyStories(): Promise<WgStory[]> {
    const candidates = await this.db.query<WgStory>(
      `SELECT * FROM wg_stories WHERE status IN ('planned', 'ready')`
    )
    if (candidates.length === 0) return []
    // Fetch all hard-blocking deps for candidates
    const deps = await this.db.query<{ story_key: string; depends_on: string }>(
      `SELECT story_key, depends_on FROM story_dependencies WHERE dep_type = 'blocks'`
    )
    if (deps.length === 0) return candidates
    // Fetch status of all potential blockers
    const blockerKeys = [...new Set(deps.map(d => d.depends_on))]
    const placeholders = blockerKeys.map(() => '?').join(',')
    const blockers = await this.db.query<{ story_key: string; status: string }>(
      `SELECT story_key, status FROM wg_stories WHERE story_key IN (${placeholders})`,
      blockerKeys
    )
    const blockerStatus = new Map(blockers.map(b => [b.story_key, b.status]))
    const depsMap = new Map<string, string[]>()
    for (const d of deps) {
      if (!depsMap.has(d.story_key)) depsMap.set(d.story_key, [])
      depsMap.get(d.story_key)!.push(d.depends_on)
    }
    return candidates.filter(s => {
      const blocking = depsMap.get(s.story_key) ?? []
      return blocking.every(dep => blockerStatus.get(dep) === 'complete')
    })
  }
  ```

- **upsertStory() implementation note**: InMemoryDatabaseAdapter may not support `INSERT ... ON DUPLICATE KEY UPDATE`. Use DELETE + INSERT pattern:
  ```typescript
  async upsertStory(story: WgStory): Promise<void> {
    await this.db.exec(
      `DELETE FROM wg_stories WHERE story_key = ?`, [story.story_key]
    )
    // Then INSERT...
  }
  ```
  Check if DatabaseAdapter.exec() accepts parameters — if not, use query() with side effects, or build parameterized SQL strings carefully.

- **SQL dialect**: Use MySQL/Dolt syntax (not SQLite): `INSERT IGNORE`, `DATETIME`, `AUTO_INCREMENT`, `CREATE OR REPLACE VIEW`. The InMemoryDatabaseAdapter already handles `INSERT IGNORE` (duplicate PK silently skipped). Verify by reading `src/persistence/memory-adapter.ts` before implementing.

- **DatabaseAdapter query() signature**: `query<T>(sql: string, params?: unknown[]): Promise<T[]>` — confirm parameter binding style from `src/persistence/adapter.ts` before implementing repository methods.

### Testing Requirements

- **Unit tests only**: Vitest with `InMemoryDatabaseAdapter`. No e2e or integration tests for this story.
- **Test table setup**: Each test or `beforeEach` block creates `wg_stories` and `story_dependencies` tables directly — do not apply full `schema.sql` (avoids the VIEW no-op issue before Task 5 is complete):
  ```typescript
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
  ```
- **Coverage**: Must stay above 80% threshold. `WorkGraphRepository` should reach ~90%+ coverage from unit tests.
- **Test run**: `npm run test:fast`. Never pipe output. Check for "Test Files" line in output.

## Interface Contracts

- **Export**: `WorkGraphRepository` @ `src/modules/state/work-graph-repository.ts` (consumed by story 31-2 for epic doc ingestion and story 31-3 for dispatch gating)
- **Export**: `WgStory`, `StoryDependency`, `WgStoryStatus` @ `src/modules/state/types.ts` (consumed by stories 31-2, 31-3, 31-4, 31-5)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
