# Story 31-6: Contract Detector Writes Dependencies to story_dependencies

Status: ready-for-dev

## Story

As the pipeline orchestrator,
I want contract-based dependency edges discovered during dispatch planning persisted in the `story_dependencies` table with `source='contract'`,
so that the `ready_stories` view enforces interface ordering (importers cannot dispatch until their exporters complete) and `substrate status` can report contract-gated blockers alongside explicit ones.

## Acceptance Criteria

### AC1: addContractDependencies() persists export→import edges as 'blocks' deps
**Given** a list of edge objects where `reason` does NOT start with `'dual export:'`
**When** `WorkGraphRepository.addContractDependencies(edges)` is called
**Then** each edge is persisted as a `story_dependencies` row with `story_key = edge.to`, `depends_on = edge.from`, `dep_type = 'blocks'`, `source = 'contract'`

### AC2: Dual-export edges are persisted as 'informs' deps
**Given** a list of edge objects where `reason` starts with `'dual export:'`
**When** `WorkGraphRepository.addContractDependencies(edges)` is called
**Then** each dual-export edge is persisted with `dep_type = 'informs'` — dual-export edges represent serialization constraints, not hard prerequisites, and must not gate dispatch

### AC3: addContractDependencies() is idempotent
**Given** the same edge list is passed to `addContractDependencies()` twice
**When** both calls complete
**Then** only one `story_dependencies` row exists per `(story_key, depends_on)` pair — the underlying `INSERT IGNORE` in `addDependency()` prevents duplicates

### AC4: Empty edge list is a no-op
**Given** an empty array `[]` is passed
**When** `addContractDependencies([])` is called
**Then** the method returns immediately without error and makes no database writes

### AC5: Orchestrator calls addContractDependencies() fire-and-forget after contract detection
**Given** the orchestrator calls `detectConflictGroupsWithContracts()` and receives a non-empty `edges` array
**When** `run()` proceeds with dispatch
**Then** `wgRepo.addContractDependencies(edges)` is called without `await` immediately after the detection result is obtained, and the existing dispatch ordering logic (batches) is unchanged

### AC6: addContractDependencies() errors are suppressed (non-fatal)
**Given** the `DatabaseAdapter` throws when the method attempts to write to `story_dependencies`
**When** `wgRepo.addContractDependencies(edges)` is called from the orchestrator
**Then** the rejection is caught and logged at WARN level; the pipeline continues and no story execution is affected

## Tasks / Subtasks

- [ ] Task 1: Add `addContractDependencies()` to WorkGraphRepository (AC: #1, #2, #3, #4)
  - [ ] In `src/modules/state/work-graph-repository.ts`, add the method signature:
    `async addContractDependencies(edges: ReadonlyArray<{ from: string; to: string; reason?: string }>): Promise<void>`
  - [ ] Return early with no writes if `edges.length === 0` (AC4)
  - [ ] For each edge, determine `dep_type`: if `edge.reason?.startsWith('dual export:')` → `'informs'`; otherwise → `'blocks'`
  - [ ] Call `await this.addDependency({ story_key: edge.to, depends_on: edge.from, dep_type, source: 'contract', created_at: new Date().toISOString() })` for each edge
  - [ ] Idempotency is automatic: `addDependency()` already uses `INSERT IGNORE` on the composite PK `(story_key, depends_on)`

- [ ] Task 2: Write unit tests for `addContractDependencies()` (AC: #1, #2, #3, #4)
  - [ ] In `src/modules/state/__tests__/work-graph-repository.test.ts`, add `describe('addContractDependencies', ...)` block
  - [ ] `beforeEach`: create a fresh `InMemoryDatabaseAdapter` and `WorkGraphRepository`, create `story_dependencies` table with the standard DDL (no `wg_stories` needed — this method only writes to `story_dependencies`)
  - [ ] Test AC1: export→import edge (reason `'31-A exports FooSchema, 31-B imports it'`) → row with `dep_type='blocks'`, `source='contract'`, `story_key='31-B'`, `depends_on='31-A'`
  - [ ] Test AC2: dual-export edge (reason starting with `'dual export:'`) → row with `dep_type='informs'`
  - [ ] Test AC3: call twice with the same edges → query returns exactly one row per `(story_key, depends_on)` pair
  - [ ] Test AC4: `addContractDependencies([])` → `story_dependencies` table remains empty, no error thrown

- [ ] Task 3: Hook contract dep persistence into orchestrator `run()` (AC: #5, #6)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, locate the existing call to `detectConflictGroupsWithContracts()` (added in Story 25-5) that returns `{ batches, edges }`
  - [ ] Add the `WorkGraphRepository` import if not already present: `import { WorkGraphRepository } from '../state/index.js'`
  - [ ] If Story 31-4 has already added `wgRepo` to the factory closure, reuse that instance — do NOT construct a second `WorkGraphRepository`. If 31-4 is not yet implemented, add `const wgRepo = new WorkGraphRepository(db)` near the top of the `run()` function body (or in the factory closure alongside the `db` reference)
  - [ ] Immediately after the `detectConflictGroupsWithContracts()` call, add the fire-and-forget:
    ```typescript
    wgRepo.addContractDependencies(result.edges).catch((err: unknown) =>
      logger.warn({ err }, 'contract dep persistence failed (best-effort)')
    )
    ```
  - [ ] Confirm that `result.batches` usage (dispatch loop) is NOT modified

- [ ] Task 4: Write orchestrator wiring test (AC: #5, #6)
  - [ ] In `src/modules/implementation-orchestrator/__tests__/contract-ordering.test.ts` (existing file) or a new file `contract-dep-persistence.test.ts`, add a `describe` block for the new wiring
  - [ ] Mock `WorkGraphRepository.prototype.addContractDependencies` using `vi.spyOn` before the orchestrator is constructed
  - [ ] Test AC5: when the mock `detectConflictGroupsWithContracts` returns `{ batches: [...], edges: [{ from: '31-1', to: '31-2', reason: 'export' }] }`, the spy should have been called once with that edges array
  - [ ] Test AC6: when the spy rejects with an error, the orchestrator `run()` resolves normally without rethrowing

- [ ] Task 5: Build and test validation (all ACs)
  - [ ] Run `npm run build` — must exit 0
  - [ ] Run `npm run test:fast` — confirm output contains "Test Files" line with all passing; do NOT pipe output

## Dev Notes

### Architecture Constraints

- **File paths to modify**:
  - `src/modules/state/work-graph-repository.ts` — add `addContractDependencies()` method
  - `src/modules/state/__tests__/work-graph-repository.test.ts` — add `describe('addContractDependencies')` block
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — fire-and-forget hook after `detectConflictGroupsWithContracts()` call
  - `src/modules/implementation-orchestrator/__tests__/contract-ordering.test.ts` (preferred) or `contract-dep-persistence.test.ts` (new) — orchestrator wiring tests

- **Import style**: All imports use named exports with `.js` extension (ESM project):
  ```typescript
  import { WorkGraphRepository } from '../state/index.js'
  ```

- **DO NOT import `ContractDependencyEdge` into `work-graph-repository.ts`**: The repository lives in `src/modules/state/` and must not depend on `src/modules/implementation-orchestrator/`. Use a structural type `ReadonlyArray<{ from: string; to: string; reason?: string }>` for the parameter — `ContractDependencyEdge` satisfies this shape structurally and no explicit import is needed in the repository.

- **Dual-export detection**: Use `edge.reason?.startsWith('dual export:')` to distinguish dual-export edges from export→import edges. This matches the exact string produced by `buildContractDependencyGraph()` in `conflict-detector.ts`:
  ```typescript
  reason: `dual export: ${sorted[i]} and ${sorted[i + 1]} both export ${contractName} — serialized to prevent conflicting definitions`
  ```

- **`wgRepo` in orchestrator — check before constructing**: Story 31-4 (Status Lifecycle) adds `const wgRepo = new WorkGraphRepository(db)` to the `createImplementationOrchestrator()` factory closure. If 31-4 is already implemented when this story is applied, the variable will exist — do NOT create a second instance. Read `orchestrator-impl.ts` first and search for `wgRepo` before adding any construction.

- **Fire-and-forget placement**: The hook must come immediately after the `detectConflictGroupsWithContracts()` result is destructured, BEFORE the batch iteration loop. This placement is observable but non-blocking:
  ```typescript
  const result = detectConflictGroupsWithContracts(storyKeys, config, declarations)
  // NEW: persist contract deps to Dolt (fire-and-forget, non-fatal)
  wgRepo.addContractDependencies(result.edges).catch((err: unknown) =>
    logger.warn({ err }, 'contract dep persistence failed (best-effort)')
  )
  // EXISTING: batch dispatch loop unchanged
  for (const batch of result.batches) { ... }
  ```

- **Test table DDL for repository tests**: `addContractDependencies()` only writes to `story_dependencies`, so only that table is needed in `beforeEach`. Reuse the standard DDL:
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

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `beforeEach`, `vi.spyOn`. Do NOT use Jest APIs.

- **Verifying rows in tests**: After calling `addContractDependencies()`, query with:
  ```typescript
  const rows = await db.query<{ story_key: string; depends_on: string; dep_type: string; source: string }>(
    'SELECT * FROM story_dependencies'
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toMatchObject({ story_key: '31-B', depends_on: '31-A', dep_type: 'blocks', source: 'contract' })
  ```

### Testing Requirements

- Unit tests for `addContractDependencies()` use `InMemoryDatabaseAdapter` only — no Dolt process required
- Orchestrator wiring tests use `vi.spyOn` mocks — no real DB writes needed
- All new code must remain above the 80% coverage threshold enforced by vitest config
- Run `npm run test:fast` (not `npm test`) during development; confirm "Test Files" line in output; do NOT pipe output

## Interface Contracts

- **Import**: `WorkGraphRepository` @ `src/modules/state/work-graph-repository.ts` (from story 31-1)
- **Import**: `StoryDependency` @ `src/modules/state/types.ts` (from story 31-1 — used internally by `addDependency()`, already available)
- **Import**: `detectConflictGroupsWithContracts`, `ContractDependencyEdge` @ `src/modules/implementation-orchestrator/conflict-detector.ts` (from story 25-5) — consumed only in `orchestrator-impl.ts`, NOT in `work-graph-repository.ts`

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
