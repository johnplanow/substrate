# Story 42-8: Graph Context and Outcome Types

## Story

As a graph engine developer,
I want a thread-safe `GraphContext` key-value store and a structured `Outcome` result type,
so that node handlers can read and write execution state in isolation and return well-typed results that drive edge selection, checkpointing, and retry logic.

## Acceptance Criteria

### AC1: Basic Get / Set
**Given** a newly constructed `GraphContext`
**When** `ctx.set("key", "value")` is called and then `ctx.get("key")` is called
**Then** `ctx.get("key")` returns `"value"`

### AC2: Typed Accessors with Defaults
**Given** a `GraphContext` that does not contain the key `"missing"`
**When** `ctx.getString("missing", "fallback")` is called
**Then** it returns `"fallback"`; similarly `getNumber("n", 0)` returns `0` and `getBoolean("b", false)` returns `false` for absent keys

### AC3: Batch Update via `applyUpdates`
**Given** a `GraphContext`
**When** `ctx.applyUpdates({ a: 1, b: "hello" })` is called
**Then** both `ctx.get("a")` → `1` and `ctx.get("b")` → `"hello"` are set atomically without affecting pre-existing keys not in the update map

### AC4: Snapshot Returns Serializable Record
**Given** a `GraphContext` with several keys set
**When** `ctx.snapshot()` is called
**Then** it returns a plain `Record<string, unknown>` containing all current key-value pairs, and `JSON.stringify(ctx.snapshot())` succeeds without throwing

### AC5: Independent Clone — Mutations Do Not Propagate
**Given** a `GraphContext` with key `"x"` set to `"original"`
**When** `const clone = ctx.clone()` is called and then `clone.set("x", "mutated")`
**Then** `ctx.get("x")` still returns `"original"` (the original is unaffected), and mutating the original after cloning does not affect the clone

### AC6: Outcome Type Covers All Terminal Statuses
**Given** an `Outcome` object constructed with `status: 'SUCCESS'`, optional `preferredLabel`, `suggestedNextIds`, `contextUpdates`, `notes`, and `error`
**When** it is serialized with `JSON.stringify`
**Then** all fields are present with correct types; status must be one of `SUCCESS | PARTIAL_SUCCESS | FAILURE | NEEDS_RETRY | ESCALATE`

### AC7: Unit Tests Pass
**Given** the implementations in `context.ts` and updated `types.ts`
**When** `npm run test:fast` is executed
**Then** all tests in `context.test.ts` pass, covering every AC above

## Tasks / Subtasks

- [ ] Task 1: Add `Outcome`-related types to `packages/factory/src/graph/types.ts` (AC: #6)
  - [ ] Define `OutcomeStatus` union: `'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'`
  - [ ] Define `Outcome` interface with fields: `status: OutcomeStatus`, `preferredLabel?: string`, `suggestedNextIds?: string[]`, `contextUpdates?: Record<string, unknown>`, `notes?: string`, `error?: unknown`
  - [ ] Export both types from `types.ts`; do not break existing imports from prior stories

- [ ] Task 2: Define `GraphContext` interface in `packages/factory/src/graph/types.ts` (AC: #1–#5)
  - [ ] Define `IGraphContext` interface with methods: `get(key: string): unknown`, `set(key: string, value: unknown): void`, `getString(key: string, defaultValue?: string): string`, `getNumber(key: string, defaultValue?: number): number`, `getBoolean(key: string, defaultValue?: boolean): boolean`, `applyUpdates(updates: Record<string, unknown>): void`, `snapshot(): Record<string, unknown>`, `clone(): IGraphContext`
  - [ ] Export `IGraphContext` from `types.ts`

- [ ] Task 3: Implement `GraphContext` class in `packages/factory/src/graph/context.ts` (AC: #1–#5)
  - [ ] Create `packages/factory/src/graph/context.ts` (new file)
  - [ ] Implement `GraphContext` class implementing `IGraphContext`
  - [ ] Backing store: private `Map<string, unknown>`; constructor accepts optional `Record<string, unknown>` initial values
  - [ ] `get`: returns value or `undefined` for missing keys
  - [ ] `set`: stores value; overwrite if key already exists
  - [ ] `getString`: returns stored value coerced via `String()`, or `defaultValue ?? ""` if absent
  - [ ] `getNumber`: returns stored value coerced via `Number()`, or `defaultValue ?? 0` if absent; NaN resolves to default
  - [ ] `getBoolean`: returns stored value coerced via `Boolean()`, or `defaultValue ?? false` if absent
  - [ ] `applyUpdates`: iterates entries and calls `set` for each; does not clear pre-existing keys
  - [ ] `snapshot`: returns `Object.fromEntries(this._store)` — a shallow copy, no references to internal Map
  - [ ] `clone`: returns `new GraphContext(this.snapshot())` — completely independent copy
  - [ ] Export `GraphContext` as named export

- [ ] Task 4: Write unit tests (AC: #1–#7)
  - [ ] Create `packages/factory/src/graph/__tests__/context.test.ts`
  - [ ] Test `get`/`set` round-trip for string, number, boolean, and object values
  - [ ] Test `getString`/`getNumber`/`getBoolean` defaults for absent keys
  - [ ] Test `applyUpdates` does not clobber pre-existing keys outside the update map
  - [ ] Test `snapshot()` returns plain object; modifying the returned snapshot does not affect context
  - [ ] Test `clone()` independence: mutate clone, verify original unchanged; mutate original, verify clone unchanged
  - [ ] Test `Outcome` type compliance: verify `OutcomeStatus` union literals match expected set (type-only tests via `satisfies`)
  - [ ] Aim for 100% branch coverage on `GraphContext` methods

## Dev Notes

### Architecture Constraints
- **File paths:**
  - `packages/factory/src/graph/context.ts` — new file; exports `GraphContext` class
  - `packages/factory/src/graph/types.ts` — add `OutcomeStatus`, `Outcome`, `IGraphContext` (extend existing file from 42-1/42-2/42-6; do not delete existing types)
  - `packages/factory/src/graph/__tests__/context.test.ts` — new test file
- **Import style:** ESM with `.js` extensions for all relative imports (e.g., `import { GraphContext } from './context.js'`)
- **No external dependencies:** `GraphContext` must use only built-in JS `Map`; no third-party libraries
- **No circular deps:** `context.ts` must not import from `validator.ts`, `executor.ts`, `edge-selector.ts`, or any story not yet implemented
- **Thread-safety note:** JavaScript is single-threaded, so the "thread-safe" requirement means no shared mutable state across independent `clone()` instances — each clone must have its own backing store

### Outcome Type Guidance
The `Outcome` type is the single return value from every node handler. The executor reads `outcome.contextUpdates` and merges them into `GraphContext` after a successful node, uses `outcome.preferredLabel` and `outcome.suggestedNextIds` in edge selection (story 42-12), and stores `outcome.notes` in the checkpoint (story 42-13). `NEEDS_RETRY` triggers exponential back-off retry (200ms initial, 2× factor, 60s cap, ±50% jitter). `ESCALATE` halts execution and surfaces the error to the operator.

### Context Compatibility Note
`evaluateCondition` in `condition-parser.ts` (42-6) accepts `Record<string, unknown>` — pass `ctx.snapshot()` when calling it from the executor. Do not pass the `GraphContext` instance directly to the condition evaluator.

### Testing Requirements
- Test framework: Vitest (already configured in the monorepo)
- Run tests with: `npm run test:fast` (unit only, no e2e)
- All tests must pass before the story is considered done
- Verify with `npm run test:fast` — confirm "Test Files" line appears in output

## Interface Contracts

- **Export**: `OutcomeStatus` @ `packages/factory/src/graph/types.ts`
- **Export**: `Outcome` @ `packages/factory/src/graph/types.ts` (consumed by handler registry in 42-9, edge selector in 42-12, checkpoint manager in 42-13, executor in 42-14)
- **Export**: `IGraphContext` @ `packages/factory/src/graph/types.ts` (consumed by handler registry in 42-9, executor in 42-14)
- **Export**: `GraphContext` @ `packages/factory/src/graph/context.ts` (consumed by executor in 42-14, checkpoint manager in 42-13)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
