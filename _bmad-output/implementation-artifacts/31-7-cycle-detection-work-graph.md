# Story 31-7: Cycle Detection in Work Graph

Status: review

## Story

As the pipeline orchestrator,
I want cyclic dependency chains detected at ingest time and rejected before they reach the database,
so that the `ready_stories` view never enters a state where all stories in a cycle are blocked waiting for each other, causing dispatch to hang indefinitely.

## Acceptance Criteria

### AC1: detectCycles() returns null for an acyclic graph
**Given** a dependency edge list forming a valid DAG (e.g., A→B→C with no back edges)
**When** `detectCycles(edges)` is called
**Then** it returns `null` — no cycle found, graph is safe to persist

### AC2: detectCycles() identifies a 2-node mutual dependency cycle
**Given** two edges where A `depends_on` B and B `depends_on` A
**When** `detectCycles(edges)` is called
**Then** it returns a non-null array of story keys tracing the cycle (e.g. `['A', 'B', 'A']`); the first and last element are the same story key

### AC3: detectCycles() identifies a 3-node transitive cycle
**Given** three edges forming the cycle C `depends_on` B, B `depends_on` A, A `depends_on` C
**When** `detectCycles(edges)` is called
**Then** it returns a non-null array containing all three story keys in the cycle path

### AC4: Self-loops (story depends on itself) are detected
**Given** a single edge where story A `depends_on` A
**When** `detectCycles(edges)` is called
**Then** it returns a non-null array (self-reference is treated as a cycle of length 1)

### AC5: WorkGraphRepository.detectCycles() considers only 'blocks' deps
**Given** two `informs` deps form a mutual cycle (A informs B, B informs A) and no `blocks` deps exist
**When** `WorkGraphRepository.detectCycles()` is called
**Then** it returns an empty array — soft dependencies cannot create dispatch deadlocks and are excluded from validation

### AC6: EpicIngester.ingest() throws CyclicDependencyError before any DB writes
**Given** a `dependencies` list passed to `EpicIngester.ingest()` that contains a cycle
**When** `ingest(stories, cyclicDeps)` is called
**Then** it throws `CyclicDependencyError` with a `cycle` field containing the path array; no rows are written to `stories` or `story_dependencies` (transaction is never opened)

### AC7: substrate ingest-epic surfaces cycles as an actionable error and exits non-zero
**Given** an epic doc whose `**Dependency chain**:` line resolves to a cyclic set of edges
**When** `substrate ingest-epic <path>` is run
**Then** it writes a descriptive error to stderr (e.g. `Error: Cyclic dependency detected: 31-A → 31-B → 31-A`) and exits with a non-zero code

## Tasks / Subtasks

- [ ] Task 1: Create `src/modules/work-graph/cycle-detector.ts` with `detectCycles()` pure function (AC: #1, #2, #3, #4)
  - [ ] Implement DFS-based cycle detection using a `visiting` (on-stack) set and a `visited` (fully explored) set
  - [ ] Function signature: `export function detectCycles(edges: ReadonlyArray<{ story_key: string; depends_on: string }>): string[] | null`
  - [ ] Build an adjacency map: `Map<string, string[]>` where key = story_key, value = list of depends_on keys
  - [ ] For each unvisited node, run DFS; track the current path stack for cycle path reconstruction
  - [ ] On detecting a back edge (node already in `visiting` set), extract the cycle subpath from the stack and return `[...cyclePath, cyclePath[0]]` (cycle closed)
  - [ ] Return `null` if DFS completes without finding a cycle
  - [ ] Handle self-loops: a node with an edge to itself is immediately detected (depends_on === story_key)

- [ ] Task 2: Write unit tests for `cycle-detector.ts` (AC: #1, #2, #3, #4)
  - [ ] Create `src/modules/work-graph/__tests__/cycle-detector.test.ts`
  - [ ] Test AC1 (null on DAG): linear chain `['31-1'→'31-2', '31-2'→'31-3']` returns `null`
  - [ ] Test AC1 (null on empty): `detectCycles([])` returns `null`
  - [ ] Test AC2 (2-node cycle): edges `[{story_key:'31-B', depends_on:'31-A'}, {story_key:'31-A', depends_on:'31-B'}]` returns non-null array containing both keys
  - [ ] Test AC3 (3-node cycle): edges forming `31-A → 31-B → 31-C → 31-A` — assert returned array is length ≥ 4 (3 unique + closing repeat) and contains all three keys
  - [ ] Test AC4 (self-loop): `[{story_key:'31-A', depends_on:'31-A'}]` returns non-null array
  - [ ] Test fan-out DAG (one story blocked by multiple) returns `null` (no false positive)

- [ ] Task 3: Add `CyclicDependencyError` to `src/modules/work-graph/errors.ts` (or inline in `cycle-detector.ts`) (AC: #6)
  - [ ] Create (or add to existing) `src/modules/work-graph/errors.ts`:
    ```typescript
    export class CyclicDependencyError extends Error {
      constructor(public readonly cycle: string[]) {
        super(`Cyclic dependency detected: ${cycle.join(' → ')}`)
        this.name = 'CyclicDependencyError'
      }
    }
    ```
  - [ ] Export `CyclicDependencyError` from `src/modules/work-graph/index.ts` (add to barrel if it exists, or export directly)

- [ ] Task 4: Hook cycle detection into `EpicIngester.ingest()` (AC: #6)
  - [ ] In `src/modules/work-graph/epic-ingester.ts`, import `detectCycles` and `CyclicDependencyError`:
    ```typescript
    import { detectCycles } from './cycle-detector.js'
    import { CyclicDependencyError } from './errors.js'
    ```
  - [ ] At the start of `ingest()`, before `this.adapter.transaction(...)`, run cycle detection:
    ```typescript
    const cycle = detectCycles(dependencies)
    if (cycle !== null) {
      throw new CyclicDependencyError(cycle)
    }
    ```
  - [ ] This placement ensures zero DB writes on a cyclic input (transaction never starts)
  - [ ] Write a unit test in `src/modules/work-graph/__tests__/epic-ingester.test.ts` confirming that cyclic `dependencies` throws `CyclicDependencyError` and that the DB remains empty after the throw

- [ ] Task 5: Add `WorkGraphRepository.detectCycles()` for in-DB validation (AC: #5)
  - [ ] In `src/modules/state/work-graph-repository.ts`, import `detectCycles` from the work-graph module — use a relative path crossing module boundaries or move `detectCycles` to a shared location if needed. Preferred: import via relative path `../../modules/work-graph/cycle-detector.js`
  - [ ] Add the method:
    ```typescript
    async detectCycles(): Promise<string[]> {
      const rows = await this.db.query<{ story_key: string; depends_on: string }>(
        `SELECT story_key, depends_on FROM story_dependencies WHERE dep_type = 'blocks'`
      )
      const cycle = detectCycles(rows)
      return cycle ?? []
    }
    ```
  - [ ] Returns empty array if no cycle found (not null — consistent with other repository methods returning empty arrays)
  - [ ] Write unit tests in `src/modules/state/__tests__/work-graph-repository.test.ts` in a `describe('detectCycles')` block:
    - Test acyclic `blocks` deps returns `[]`
    - Test cyclic `blocks` deps returns non-empty array
    - Test `informs` dep cycle (only `informs` rows in DB) returns `[]` (AC5)

- [ ] Task 6: Surface `CyclicDependencyError` cleanly in the `ingest-epic` CLI command (AC: #7)
  - [ ] In `src/cli/commands/ingest-epic.ts`, check for `CyclicDependencyError` specifically in the catch block around `ingester.ingest()`:
    ```typescript
    import { CyclicDependencyError } from '../../modules/work-graph/errors.js'
    // ...
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
      process.exitCode = 1
    }
    ```
  - [ ] Since `CyclicDependencyError extends Error`, its `message` field already contains the formatted cycle path — no special branching needed. Confirm the generic catch block already in `ingest-epic.ts` (Task 3 of story 31-2) surfaces the message correctly without modification
  - [ ] Add a CLI-level integration test in `src/cli/commands/__tests__/ingest-epic.test.ts` that mocks `EpicIngester.prototype.ingest` to throw `CyclicDependencyError(['31-A', '31-B', '31-A'])` and asserts stderr contains "Cyclic dependency detected" and exitCode is 1

- [ ] Task 7: Build and test validation (all ACs)
  - [ ] Run `npm run build` — must exit 0
  - [ ] Run `npm run test:fast` — confirm output contains "Test Files" line with all passing; do NOT pipe output

## Dev Notes

### Architecture Constraints

- **New files to create**:
  - `src/modules/work-graph/cycle-detector.ts` — pure DFS cycle detection function
  - `src/modules/work-graph/errors.ts` — `CyclicDependencyError` class
  - `src/modules/work-graph/__tests__/cycle-detector.test.ts` — unit tests

- **Files to modify**:
  - `src/modules/work-graph/epic-ingester.ts` — add cycle check before transaction
  - `src/modules/state/work-graph-repository.ts` — add `detectCycles()` method
  - `src/modules/state/__tests__/work-graph-repository.test.ts` — add `detectCycles` describe block
  - `src/modules/work-graph/__tests__/epic-ingester.test.ts` — add cycle-detection test case
  - `src/cli/commands/__tests__/ingest-epic.test.ts` — add CLI-level cycle error test

- **Import style**: All imports use named exports with `.js` extension (ESM project):
  ```typescript
  import { detectCycles } from './cycle-detector.js'
  import { CyclicDependencyError } from './errors.js'
  ```

- **Pure function location**: `detectCycles` lives in `src/modules/work-graph/cycle-detector.ts`. The `WorkGraphRepository` in `src/modules/state/` imports it via a relative cross-module path (`../../modules/work-graph/cycle-detector.js`). This is acceptable — `detectCycles` has no dependencies (pure function) so there is no circular import risk.

- **DFS algorithm sketch**:
  ```typescript
  export function detectCycles(
    edges: ReadonlyArray<{ story_key: string; depends_on: string }>
  ): string[] | null {
    // Build adjacency map: node → nodes it depends on (outbound edges)
    const adj = new Map<string, string[]>()
    for (const { story_key, depends_on } of edges) {
      if (!adj.has(story_key)) adj.set(story_key, [])
      adj.get(story_key)!.push(depends_on)
    }

    const visited = new Set<string>()
    const visiting = new Set<string>()
    const path: string[] = []

    function dfs(node: string): string[] | null {
      if (visiting.has(node)) {
        // Cycle found — extract cycle from path stack
        const cycleStart = path.indexOf(node)
        return [...path.slice(cycleStart), node]
      }
      if (visited.has(node)) return null

      visiting.add(node)
      path.push(node)

      for (const neighbor of adj.get(node) ?? []) {
        const cycle = dfs(neighbor)
        if (cycle !== null) return cycle
      }

      path.pop()
      visiting.delete(node)
      visited.add(node)
      return null
    }

    const allNodes = new Set([
      ...edges.map((e) => e.story_key),
      ...edges.map((e) => e.depends_on),
    ])
    for (const node of allNodes) {
      if (!visited.has(node)) {
        const cycle = dfs(node)
        if (cycle !== null) return cycle
      }
    }
    return null
  }
  ```

- **`EpicIngester` uses `dependency_type` column, not `dep_type`**: The `stories` / `story_dependencies` tables in `src/modules/work-graph/schema.ts` use `dependency_type` (not `dep_type` as in the `wg_stories` / `story_dependencies` tables in `WorkGraphRepository`). The `detectCycles` pure function only needs `story_key` and `depends_on`, so it is compatible with both schemas without modification. `WorkGraphRepository.detectCycles()` filters using `dep_type = 'blocks'`; `EpicIngester` passes all parsed deps (parser only emits `blocks` deps, so no filtering needed there).

- **No DB calls in `detectCycles()`**: The pure function never touches the database — it operates only on the in-memory edge list. This makes it fast, synchronous-capable, and trivially testable without `InMemoryDatabaseAdapter`.

- **Transaction placement**: The cycle check in `EpicIngester.ingest()` must happen BEFORE `this.adapter.transaction(...)`. Do NOT call `detectCycles` inside the transaction callback. This ensures a clean fail-fast path with zero DB side effects.

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `beforeEach`. Do NOT use Jest APIs (`test.each` with object format, `jest.fn`, etc.).

- **Test DDL for repository tests**: the `detectCycles` describe block only needs `story_dependencies` (not `wg_stories`). Reuse the standard DDL:
  ```typescript
  await db.exec(`CREATE TABLE IF NOT EXISTS story_dependencies (
    story_key VARCHAR(20) NOT NULL,
    depends_on VARCHAR(20) NOT NULL,
    dep_type VARCHAR(20) NOT NULL,
    source VARCHAR(20) NOT NULL,
    created_at DATETIME,
    PRIMARY KEY (story_key, depends_on)
  )`)
  ```

### Testing Requirements

- `cycle-detector.ts` unit tests use plain in-memory arrays — no `InMemoryDatabaseAdapter` needed
- `WorkGraphRepository.detectCycles()` tests use `InMemoryDatabaseAdapter`
- `EpicIngester` cycle test uses `InMemoryDatabaseAdapter` with the work-graph schema tables
- CLI test for `ingest-epic` mocks `EpicIngester.prototype.ingest` via `vi.spyOn` — no real DB writes
- All new code must remain above the 80% coverage threshold enforced by vitest config
- Run `npm run test:fast` (not `npm test`) during development; confirm "Test Files" line in output; do NOT pipe output

## Interface Contracts

- **Export**: `detectCycles` @ `src/modules/work-graph/cycle-detector.ts` (pure function, consumed by `EpicIngester` and `WorkGraphRepository`)
- **Export**: `CyclicDependencyError` @ `src/modules/work-graph/errors.ts` (consumed by `EpicIngester` and `ingest-epic` CLI command)
- **Import**: `ParsedDependency` @ `src/modules/work-graph/epic-parser.ts` (from story 31-2 — edge shape already available; `detectCycles` accepts a compatible structural subtype)
- **Import**: `WorkGraphRepository` @ `src/modules/state/work-graph-repository.ts` (from story 31-1 — extended with `detectCycles()` method)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
