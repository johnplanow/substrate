# Story 26-1: StateStore Interface + File-Based Backend

Status: complete

## User Story

As a pipeline developer,
I want a clean StateStore abstraction layer with a file-based backend implementation,
so that pipeline modules can read and write state through a single interface and future Dolt or other backends can be swapped in without touching consumer code.

## Background

Pipeline state is currently spread across: an in-memory `_stories` Map in `orchestrator-impl.ts`, SQLite decision/metrics queries in `src/persistence/queries/`, and JSON status files read by the CLI. There is no single interface — every module knows the storage format directly. This story introduces the `StateStore` interface and a `FileStateStore` that wraps the existing SQLite + in-memory behavior, enabling later stories to drop in a Dolt backend (26-3) without touching orchestrator code.

## Acceptance Criteria

### AC1: StateStore Interface
**Given** the new module `src/modules/state/types.ts`
**When** it is imported by any module
**Then** it exports a `StateStore` interface with the following async methods:
- `initialize(): Promise<void>`
- `close(): Promise<void>`
- `getStoryState(storyKey: string): Promise<StoryRecord | undefined>`
- `setStoryState(storyKey: string, state: StoryRecord): Promise<void>`
- `queryStories<T extends StoryFilter>(filter: T): Promise<StoryRecord[]>`
- `recordMetric(metric: MetricRecord): Promise<void>`
- `queryMetrics(filter: MetricFilter): Promise<MetricRecord[]>`
- `getContracts(storyKey: string): Promise<ContractRecord[]>`
- `setContracts(storyKey: string, contracts: ContractRecord[]): Promise<void>`
- `branchForStory(storyKey: string): Promise<void>`
- `mergeStory(storyKey: string): Promise<void>`
- `rollbackStory(storyKey: string): Promise<void>`
- `diffStory(storyKey: string): Promise<StateDiff>`

### AC2: Supporting Type Definitions
**Given** `src/modules/state/types.ts`
**When** it is imported
**Then** it exports fully typed interfaces: `StoryRecord`, `StoryFilter`, `MetricRecord`, `MetricFilter`, `ContractRecord`, `StateDiff`, and `StateStoreConfig` (with `backend: 'file' | 'dolt'` and `basePath?: string`)

### AC3: FileStateStore Implementation
**Given** the new file `src/modules/state/file-store.ts`
**When** `FileStateStore` is constructed with a `basePath`
**Then** it implements `StateStore` where:
- `getStoryState` / `setStoryState` / `queryStories` delegate to an in-memory Map (matching current orchestrator behavior)
- `recordMetric` / `queryMetrics` delegate to the existing SQLite metrics queries in `src/persistence/queries/metrics.ts`
- `getContracts` / `setContracts` delegate to the existing SQLite decision store using category `interface-contract`
- `branchForStory`, `mergeStory`, `rollbackStory`, `diffStory` are no-ops that resolve immediately (file backend has no branching)
- `initialize` and `close` are no-ops

### AC4: createStateStore Factory
**Given** `src/modules/state/index.ts` exports `createStateStore(config: StateStoreConfig): StateStore`
**When** called with `{ backend: 'file' }` (or no backend specified)
**Then** it returns a `FileStateStore` instance; when called with `{ backend: 'dolt' }` it throws `Error('DoltStateStore not yet implemented — install story 26-3')` so downstream code fails fast with a clear message

### AC5: Barrel Exports
**Given** `src/modules/state/index.ts`
**When** other modules import from `'../../modules/state/index.js'`
**Then** the following are available: `StateStore` (type), `StoryRecord` (type), `StoryFilter` (type), `MetricRecord` (type), `MetricFilter` (type), `ContractRecord` (type), `StateDiff` (type), `StateStoreConfig` (type), `FileStateStore` (class), `createStateStore` (function)

### AC6: Unit Tests — FileStateStore Contract
**Given** `src/modules/state/__tests__/file-store.test.ts`
**When** tests run
**Then** they cover: `setStoryState` + `getStoryState` round-trip, `queryStories` with phase filter, `recordMetric` delegates to mocked persistence layer, `getContracts` / `setContracts` round-trip, and no-op branch operations resolve without error

### AC7: Zero Regression
**Given** the new `src/modules/state/` module is added
**When** the full test suite runs (`npm run test:fast`)
**Then** all existing tests continue to pass — the new module is purely additive and does not modify any existing files

## Interface Contracts

- **Export**: `StateStore` @ src/modules/state/types.ts (consumed by stories 26-2, 26-3, 26-4, 26-5, 26-6, 26-7)
- **Export**: `StoryRecord` @ src/modules/state/types.ts (consumed by stories 26-4, 26-7)
- **Export**: `MetricRecord` @ src/modules/state/types.ts (consumed by story 26-5)
- **Export**: `ContractRecord` @ src/modules/state/types.ts (consumed by story 26-6)
- **Export**: `StateStoreConfig` @ src/modules/state/types.ts (consumed by stories 26-3, 26-4)
- **Export**: `createStateStore` @ src/modules/state/index.ts (consumed by stories 26-4, 26-8)

## Tasks / Subtasks

- [ ] Task 1: Define all types in `src/modules/state/types.ts` (AC: #1, #2)
  - [ ] Define `StateStore` interface with all 13 methods listed in AC1
  - [ ] Define `StoryRecord` interface: `{ storyKey: string; phase: StoryPhase; reviewCycles: number; lastVerdict?: string; error?: string; startedAt?: string; completedAt?: string; sprint?: string }`
  - [ ] Define `StoryFilter` interface: `{ phase?: StoryPhase | StoryPhase[]; sprint?: string; storyKey?: string }`
  - [ ] Define `MetricRecord` interface: `{ storyKey: string; taskType: string; model?: string; tokensIn?: number; tokensOut?: number; cacheReadTokens?: number; costUsd?: number; wallClockMs?: number; reviewCycles?: number; stallCount?: number; result?: string; recordedAt?: string }`
  - [ ] Define `MetricFilter` interface: `{ storyKey?: string; taskType?: string; sprint?: string; dateFrom?: string; dateTo?: string }`
  - [ ] Define `ContractRecord` interface: `{ storyKey: string; contractName: string; direction: 'export' | 'import'; schemaPath: string; transport?: string }`
  - [ ] Define `StateDiff` interface: `{ storyKey: string; changes: Array<{ table: string; rowKey: string; before?: unknown; after?: unknown }> }`
  - [ ] Define `StateStoreConfig` interface: `{ backend?: 'file' | 'dolt'; basePath?: string; doltPort?: number }`
  - [ ] Re-export `StoryPhase` from `src/modules/implementation-orchestrator/types.ts` (avoid duplication)

- [ ] Task 2: Implement `FileStateStore` in `src/modules/state/file-store.ts` (AC: #3)
  - [ ] Constructor accepts `{ db?: DatabaseWrapper; basePath?: string }` — `db` is optional (metrics/contracts need it, story state doesn't)
  - [ ] Implement `initialize()` and `close()` as no-ops (return `Promise.resolve()`)
  - [ ] Implement story state methods using an internal `Map<string, StoryRecord>` (mirrors the `_stories` Map in orchestrator-impl.ts)
  - [ ] Implement `queryStories` with phase and sprint filter support
  - [ ] Implement `recordMetric` by calling `writeStoryMetrics` from `src/persistence/queries/metrics.ts`; if no `db` provided, store in-memory array
  - [ ] Implement `queryMetrics` by calling the appropriate metrics query; fallback to in-memory array if no `db`
  - [ ] Implement `getContracts` / `setContracts` by reading/writing from a `Map<string, ContractRecord[]>` (in-memory for file backend — no DB dependency required)
  - [ ] Implement `branchForStory`, `mergeStory`, `rollbackStory` as no-ops returning `Promise.resolve()`
  - [ ] Implement `diffStory` returning `Promise.resolve({ storyKey, changes: [] })` (no diff available in file backend)

- [ ] Task 3: Implement `createStateStore` factory in `src/modules/state/index.ts` (AC: #4, #5)
  - [ ] Export all types and the `FileStateStore` class
  - [ ] Implement `createStateStore(config: StateStoreConfig = {}): StateStore`
  - [ ] When `backend === 'dolt'`, throw descriptive error: `'DoltStateStore not yet implemented — install story 26-3'`
  - [ ] Default `backend` to `'file'` when unspecified
  - [ ] Return `new FileStateStore()` for file backend

- [ ] Task 4: Write unit tests in `src/modules/state/__tests__/file-store.test.ts` (AC: #6)
  - [ ] Test `setStoryState` + `getStoryState` round-trip preserves all fields
  - [ ] Test `getStoryState` returns `undefined` for unknown key
  - [ ] Test `queryStories({ phase: 'COMPLETE' })` returns only matching stories
  - [ ] Test `queryStories({ phase: ['COMPLETE', 'ESCALATED'] })` supports array of phases
  - [ ] Test `getContracts` / `setContracts` round-trip preserves contract list
  - [ ] Test `branchForStory` / `mergeStory` / `rollbackStory` resolve without error
  - [ ] Test `diffStory` returns empty changes array

- [ ] Task 5: Write unit tests for `createStateStore` factory in `src/modules/state/__tests__/index.test.ts` (AC: #4)
  - [ ] Test `createStateStore()` (no args) returns a `FileStateStore` instance
  - [ ] Test `createStateStore({ backend: 'file' })` returns a `FileStateStore` instance
  - [ ] Test `createStateStore({ backend: 'dolt' })` throws with a message containing `'26-3'`

- [ ] Task 6: Verify zero regression (AC: #7)
  - [ ] Run `npm run test:fast` and confirm all tests pass
  - [ ] Confirm no existing source files were modified (git diff should show only new files under `src/modules/state/`)
  - [ ] Run `npm run build` to confirm TypeScript compilation succeeds

## Dev Notes

### Architecture Constraints
- **TypeScript only** — all new files in `src/modules/state/` must be `.ts` with explicit type annotations; no `any` types
- **Import style** — use `.js` extension on all relative imports (ESM): `import { ... } from './types.js'`
- **StoryPhase re-export** — import `StoryPhase` from `../../modules/implementation-orchestrator/types.js` and re-export it from `types.ts` to avoid duplicating the union type
- **No breaking changes** — do NOT modify `src/modules/implementation-orchestrator/orchestrator-impl.ts` or any other existing file in this story; Story 26-4 wires the orchestrator to StateStore
- **Test framework** — vitest (NOT jest); use `import { describe, it, expect, beforeEach } from 'vitest'`
- **Metrics integration** — `writeStoryMetrics` signature is in `src/persistence/queries/metrics.ts`; the `FileStateStore` recordMetric implementation can store in-memory if no DB is provided (keeps this story self-contained without requiring a real SQLite DB in tests)
- **No new dependencies** — this story must not add any new npm packages; all types and implementations use only existing stdlib + already-installed packages

### Testing Requirements
- Tests must use `vi.mock` for any SQLite imports if needed (prefer in-memory fallback approach so no mocking is required)
- Test file location: `src/modules/state/__tests__/file-store.test.ts` and `src/modules/state/__tests__/index.test.ts`
- Each test file must have `// @vitest-environment node` if it accesses filesystem
- Coverage: aim for >90% line coverage on the new files; threshold check runs automatically in `npm test`

### Key File Paths
- `src/modules/state/types.ts` — new (interface + type definitions)
- `src/modules/state/file-store.ts` — new (FileStateStore implementation)
- `src/modules/state/index.ts` — new (barrel exports + createStateStore factory)
- `src/modules/state/__tests__/file-store.test.ts` — new (unit tests)
- `src/modules/state/__tests__/index.test.ts` — new (factory tests)
- `src/modules/implementation-orchestrator/types.ts` — read-only reference for `StoryPhase`
- `src/persistence/queries/metrics.ts` — read-only reference for metric write signatures

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
