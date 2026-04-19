# Story 31-3: Dispatch Gating via ready_stories View

Status: review

## Story

As the pipeline orchestrator,
I want `resolveStoryKeys()` to query the `ready_stories` SQL view when the work graph is populated,
so that stories with unsatisfied hard dependencies are never dispatched prematurely.

## Acceptance Criteria

### AC1: ready_stories view is used when stories table has rows
**Given** the `stories` table has been populated by epic doc ingestion (story 31-2)
**When** `resolveStoryKeys()` is called without an explicit `--stories` flag
**Then** it queries the `ready_stories` SQL view as the primary story source
**And** returns only story keys with status `planned` or `ready` whose hard dependencies are all `complete`

### AC2: Blocked stories are excluded from dispatch results
**Given** story B has a `blocks`-type dependency on story A
**And** story A has status `planned` (not yet `complete`)
**When** `resolveStoryKeys()` is called
**Then** story B is not present in the returned keys
**And** story A (if it has no unsatisfied dependencies itself) is present

### AC3: Explicit --stories flag bypasses dependency gating
**Given** a story has unsatisfied hard dependencies in the work graph
**When** `resolveStoryKeys()` is called with that story's key in `opts.stories`
**Then** that key is returned without dependency checking
**And** no `ready_stories` query is made

### AC4: Empty stories table falls through to existing discovery chain
**Given** the `stories` table is empty (31-2 ingestion has not run)
**Or** the `ready_stories` view does not yet exist (31-1 schema has not been applied)
**When** `resolveStoryKeys()` is called
**Then** it falls through to the existing fallback chain (decisions table → epic-shard → epics.md)
**And** no error is thrown

### AC5: DatabaseAdapter interface exposes queryReadyStories()
**Given** any `DatabaseAdapter` implementation
**When** `queryReadyStories()` is called on a Dolt-backed adapter
**Then** it returns an array of story key strings from the `ready_stories` view
**And** on any SQL error (e.g., view missing), it returns `[]` rather than throwing

### AC6: InMemoryAdapter and WasmSqliteAdapter return empty array
**Given** `InMemoryDatabaseAdapter` or `WasmSqliteAdapter` is in use
**When** `queryReadyStories()` is called
**Then** it returns `[]` immediately, signaling the caller to use the legacy discovery path

### AC7: Stories already in-progress or complete are excluded
**Given** stories with status `in_progress`, `complete`, or `escalated` exist in the `stories` table
**When** `resolveStoryKeys()` uses the `ready_stories` view
**Then** those stories are not included in the dispatch list
**And** only stories with status `planned` or `ready` (and no unsatisfied hard deps) are returned

## Dev Notes

### Architecture Constraints

The `resolveStoryKeys()` function in `story-discovery.ts` currently uses a 4-level fallback chain:
1. Explicit `--stories` flag
2. Decisions table (`category='stories', phase='solutioning'`)
3. Epic shard decisions (`category='epic-shard'`)
4. epics.md file on disk

Story 31-3 inserts a **Step 1.5** between steps 1 and 2: if `db.queryReadyStories()` returns a non-empty array, use those keys and skip steps 2–4. If it returns `[]`, proceed to step 2 as before. This preserves full backwards compatibility.

### New SQL view (created by 31-1, queried here)

The `ready_stories` view is defined in Epic 31's schema (story 31-1):
```sql
CREATE VIEW ready_stories AS
  SELECT s.* FROM stories s
  WHERE s.status IN ('planned', 'ready')
  AND NOT EXISTS (
    SELECT 1 FROM story_dependencies d
    JOIN stories dep ON dep.key = d.depends_on
    WHERE d.story_key = s.key
    AND d.dep_type = 'blocks'
    AND dep.status NOT IN ('complete')
  );
```

The `key` column (VARCHAR(20), PRIMARY KEY) holds story keys in the format `'31-3'`.

Query to use: `SELECT \`key\` FROM ready_stories ORDER BY \`key\` ASC`

### Defensive SQL handling

`DoltDatabaseAdapter.queryReadyStories()` must wrap the SQL query in a try/catch:
- If the view doesn't exist yet (31-1 hasn't run), Dolt throws a "table/view not found" error
- If the `stories` table is empty, the view returns `[]`
- In both cases, return `[]` and let the caller fall through to legacy discovery

### File paths to modify

- `src/persistence/adapter.ts` — add `queryReadyStories(): Promise<string[]>` to `DatabaseAdapter` interface
- `src/persistence/dolt-adapter.ts` — implement with try/catch, query `ready_stories` view
- `src/persistence/memory-adapter.ts` — implement as `async queryReadyStories() { return [] }`
- `src/persistence/wasm-sqlite-adapter.ts` — implement as `async queryReadyStories() { return [] }`
- `src/modules/implementation-orchestrator/story-discovery.ts` — add Step 1.5 in `resolveStoryKeys()`
- `src/modules/implementation-orchestrator/story-discovery.test.ts` — new test cases for gating behavior
- `src/persistence/dolt-adapter.test.ts` (or create) — tests for `queryReadyStories()`

### Import style

All imports use named exports with `.js` extension:
```typescript
import { DatabaseAdapter } from '../../persistence/adapter.js'
```

### Testing approach

Use `vi.fn()` to mock `db.queryReadyStories()`:
```typescript
const mockDb = {
  query: vi.fn(),
  exec: vi.fn(),
  queryReadyStories: vi.fn().mockResolvedValue(['31-1', '31-2']),
  // ...
} satisfies DatabaseAdapter
```

Test scenarios needed in `story-discovery.test.ts`:
1. `queryReadyStories()` returns non-empty → those keys are returned, no further fallback
2. `queryReadyStories()` returns `[]` → falls through to decisions table lookup
3. `opts.stories` provided → `queryReadyStories()` never called
4. `queryReadyStories()` returns blocked story's key → verify the view (not the resolver) is responsible for exclusion (integration-level concern; unit test just confirms returned keys are passed through)

## Interface Contracts

- **Import**: `ready_stories` SQL view @ Dolt database (created by story 31-1)
- **Import**: `stories` table rows @ Dolt database (populated by story 31-2)

## Tasks / Subtasks

- [x] Task 1: Extend DatabaseAdapter interface with queryReadyStories() (AC: #5, #6)
  - [x] Add `queryReadyStories(): Promise<string[]>` method signature to `DatabaseAdapter` interface in `src/persistence/adapter.ts`
  - [x] Add stub/default documentation comment explaining the method returns `[]` when the work graph is not yet populated

- [x] Task 2: Implement queryReadyStories() in DoltDatabaseAdapter (AC: #5)
  - [x] In `src/persistence/dolt-adapter.ts`, add `queryReadyStories()` method that runs `SELECT \`key\` FROM ready_stories ORDER BY \`key\` ASC`
  - [x] Wrap in try/catch: on any error (view missing, table empty), return `[]`
  - [x] Extract returned rows to `string[]` using `row.key`

- [x] Task 3: Implement queryReadyStories() in InMemoryAdapter and WasmSqliteAdapter (AC: #6)
  - [x] In `src/persistence/memory-adapter.ts`, add `async queryReadyStories(): Promise<string[]> { return [] }`
  - [x] In `src/persistence/wasm-sqlite-adapter.ts`, add `async queryReadyStories(): Promise<string[]> { return [] }`

- [x] Task 4: Add Step 1.5 to resolveStoryKeys() in story-discovery.ts (AC: #1, #2, #4, #7)
  - [x] After the explicit `opts.stories` check and before the decisions table query, call `await db.queryReadyStories()`
  - [x] If the result array is non-empty, apply existing filtering (dedup, sort) and return it
  - [x] If the result array is empty, continue to the existing fallback chain unchanged

- [x] Task 5: Write unit tests for new dispatch gating behavior (AC: #1, #2, #3, #4)
  - [x] In `src/modules/implementation-orchestrator/story-discovery.test.ts`, add test: `queryReadyStories()` returns keys → those keys returned
  - [x] Add test: `queryReadyStories()` returns `[]` → fallback to decisions table path
  - [x] Add test: explicit `opts.stories` provided → `queryReadyStories()` not called (spy assertion)
  - [x] Add test: empty ready_stories result with no decisions → epics.md fallback still works

- [x] Task 6: Write unit tests for DoltDatabaseAdapter.queryReadyStories() (AC: #5)
  - [x] Test happy path: mock query returns rows with `key` column → returns string array
  - [x] Test error path: mock query throws → returns `[]` without re-throwing

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Added `queryReadyStories()` to `DatabaseAdapter` interface with full JSDoc
- Implemented in `DoltDatabaseAdapter` with try/catch (returns `[]` on any SQL error)
- Implemented as `return []` stub in `InMemoryDatabaseAdapter`, `WasmSqliteDatabaseAdapter`, and `SyncDatabaseAdapter`
- Added Step 1.5 in `resolveStoryKeys()` between explicit flag check and decisions table query
- Step 1.5 handles epicNumber filter and filterCompleted when returning from the view path
- Full test suite passes: 5505 tests, 228 test files (test:fast)

### File List
- src/persistence/adapter.ts
- src/persistence/dolt-adapter.ts
- src/persistence/memory-adapter.ts
- src/persistence/wasm-sqlite-adapter.ts
- src/modules/implementation-orchestrator/story-discovery.ts
- src/modules/implementation-orchestrator/story-discovery.test.ts
- src/persistence/dolt-adapter.test.ts

## Change Log
