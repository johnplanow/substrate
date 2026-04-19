# Story 42-18: CodergenBackend Mock Implementation for Testing

## Story

As a graph engine test author,
I want a `MockCodergenBackend` with injectable responses, failures, delays, and call recording,
so that I can test the graph engine's retry logic, budget enforcement, and convergence behavior deterministically without making real LLM calls.

## Acceptance Criteria

### AC1: Configurable Response Sequence
**Given** a `MockCodergenBackend` configured with `responses: [{ status: 'SUCCESS', contextUpdates: { key: 'val' } }]`
**When** `run()` is called
**Then** it returns the configured response (with `status` and `contextUpdates`) without making any external calls; when calls exceed the response list length, the last configured response is repeated

### AC2: Injectable Per-Call Failures
**Given** a `MockCodergenBackend` configured with `failOnCall: [1, 3]`
**When** the 1st and 3rd calls to `run()` are made
**Then** those calls return `{ status: 'FAILURE' }`; call 2 (and any others not in the list) returns the configured success response

### AC3: Configurable Artificial Delay
**Given** a `MockCodergenBackend` configured with `delay: 50`
**When** `run()` is called
**Then** the mock waits approximately `delay` milliseconds before resolving, enabling timeout and stall-detection testing (use `vi.useFakeTimers()` in tests to avoid slow wall-clock waits)

### AC4: Call Argument Recording
**Given** a `MockCodergenBackend` in any configuration
**When** `run(node, prompt, context)` is called one or more times
**Then** each invocation appends `{ node, prompt, context, callIndex }` to a `calls` array accessible on the mock instance for post-run assertions

### AC5: ICodergenBackend Interface and CodergenHandler Wiring
**Given** a formal `ICodergenBackend` interface with `run(node: GraphNode, prompt: string, context: IGraphContext): Promise<Outcome>`
**When** `CodergenHandlerOptions.backend` is set to a `MockCodergenBackend` instance
**Then** the codergen handler invokes `backend.run()` instead of `callLLM()`, and the `Outcome` returned by the backend is used directly as the handler result — the `contextUpdates` on the returned Outcome are applied by the executor in the normal way

### AC6: Deterministic Integration Testing Enablement
**Given** the mock backend wired into a graph executor via the codergen handler's `backend` option
**When** a 3-node test graph (`start → codergen → exit`) is executed with the mock providing `[SUCCESS, NEEDS_RETRY, SUCCESS]` responses and `maxRetries: 2` on the codergen node
**Then** the executor retries the node correctly (call 1 → NEEDS_RETRY, call 2 → SUCCESS), and the final execution outcome is `SUCCESS` — proving the mock enables end-to-end retry logic testing

### AC7: All Unit Tests Pass Under npm test
**Given** the full test suite in `mock-backend.test.ts`
**When** `npm test` is run (after verifying no concurrent vitest process via `pgrep -f vitest`)
**Then** all tests pass with zero failures, the "Test Files" summary line confirms success, and no test is in `.skip` state without an explanatory comment

## Tasks / Subtasks

- [ ] Task 1: Define `ICodergenBackend` interface and config types (AC: #1, #2, #3, #4, #5)
  - [ ] Create `packages/factory/src/backend/types.ts`
  - [ ] Define `MockBackendResponse`: `{ status: OutcomeStatus; contextUpdates?: Record<string, string>; notes?: string }`
  - [ ] Define `MockCodergenBackendConfig`: `{ responses?: MockBackendResponse[]; failOnCall?: number[]; delay?: number }`
  - [ ] Define `CallRecord`: `{ node: GraphNode; prompt: string; context: IGraphContext; callIndex: number }`
  - [ ] Define `ICodergenBackend` interface: `{ run(node: GraphNode, prompt: string, context: IGraphContext): Promise<Outcome> }`
  - [ ] Import `GraphNode`, `IGraphContext`, `Outcome`, `OutcomeStatus` from `../graph/types.js`
  - [ ] Export all types from this file; use ESM `.js` extensions on all relative imports

- [ ] Task 2: Implement `MockCodergenBackend` class (AC: #1, #2, #3, #4)
  - [ ] Create `packages/factory/src/backend/mock-backend.ts`
  - [ ] Import types from `./types.js` and graph types from `../graph/types.js`
  - [ ] Implement `MockCodergenBackend` class that:
    - Stores `config: MockCodergenBackendConfig` (defaults: `responses: [{ status: 'SUCCESS' }]`, `failOnCall: []`, `delay: 0`)
    - Exposes a public `calls: CallRecord[]` array initialized to `[]`
    - Tracks a private `_callCount` counter (1-based, incremented before evaluation)
    - `async run(node, prompt, context)`:
      1. Increment `_callCount`
      2. Record `{ node, prompt, context, callIndex: _callCount }` into `calls`
      3. If `config.delay > 0`: `await new Promise(resolve => setTimeout(resolve, config.delay))`
      4. If `_callCount` is in `config.failOnCall`: return `{ status: 'FAILURE' }`
      5. Determine response: `config.responses[Math.min(_callCount - 1, responses.length - 1)]`
      6. Return `{ status: response.status, contextUpdates: response.contextUpdates ?? {}, notes: response.notes }`
  - [ ] Export `MockCodergenBackend` as a named export
  - [ ] Export a `createMockCodergenBackend(config?: MockCodergenBackendConfig): MockCodergenBackend` factory function

- [ ] Task 3: Wire `ICodergenBackend` into the codergen handler (AC: #5)
  - [ ] Read `packages/factory/src/handlers/codergen-handler.ts` to confirm the current `CodergenHandlerOptions` shape and `createCodergenHandler` implementation
  - [ ] Add `backend?: ICodergenBackend` to `CodergenHandlerOptions` — import `ICodergenBackend` from `../backend/types.js`
  - [ ] In `createCodergenHandler()`, after interpolating the prompt and resolving the model, check `options?.backend`:
    - **If backend is provided**: call `await options.backend.run(node, interpolatedPrompt, context)` and return the result directly
    - **If no backend**: proceed with existing `callLLM()` path unchanged
  - [ ] The fallback `callLLM()` path must remain 100% unchanged — no regression to existing behavior
  - [ ] Do NOT modify the `NodeHandler` type signature or `IHandlerRegistry` interface

- [ ] Task 4: Update barrel exports (AC: #5)
  - [ ] Create or update `packages/factory/src/backend/index.ts` to re-export:
    - `ICodergenBackend`, `MockBackendResponse`, `MockCodergenBackendConfig`, `CallRecord` from `./types.js`
    - `MockCodergenBackend`, `createMockCodergenBackend` from `./mock-backend.js`
  - [ ] Read `packages/factory/src/index.ts` (package barrel); if a `backend` sub-barrel is not yet exported, add `export * from './backend/index.js'`
  - [ ] Update `packages/factory/src/handlers/index.ts` to re-export `ICodergenBackend` from `../backend/types.js` (so callers can import from `@substrate-ai/factory/handlers` without a separate path)

- [ ] Task 5: Write unit tests for `MockCodergenBackend` (AC: #1–#4)
  - [ ] Create `packages/factory/src/backend/__tests__/mock-backend.test.ts`
  - [ ] Import from `'vitest'` only; import `createMockCodergenBackend` from `../mock-backend.js`
  - [ ] Define shared `makeNode()` and `makeContext()` helpers that return minimal `GraphNode` and `IGraphContext` stubs
  - [ ] **AC1 — response sequence**: configure 2 responses; call `run()` 3 times; assert calls 1 and 2 return configured responses, call 3 repeats last response
  - [ ] **AC1 — default response**: create with no config; assert `run()` returns `{ status: 'SUCCESS' }`
  - [ ] **AC2 — failOnCall**: configure `failOnCall: [1, 3]` with a SUCCESS response; call 3 times; assert calls 1 and 3 return FAILURE, call 2 returns SUCCESS
  - [ ] **AC3 — delay**: use `vi.useFakeTimers()` / `vi.runAllTimersAsync()` to avoid real sleeps; configure `delay: 500`; advance timers and assert `run()` resolves after advancement
  - [ ] **AC4 — call recording**: call `run(nodeA, 'prompt text', ctx)` twice; assert `mock.calls.length === 2`; assert `mock.calls[0].prompt === 'prompt text'`; assert `mock.calls[0].callIndex === 1` and `mock.calls[1].callIndex === 2`
  - [ ] **contextUpdates passthrough**: configure response with `contextUpdates: { foo: 'bar' }`; assert returned Outcome has `contextUpdates.foo === 'bar'`
  - [ ] **Reset between tests**: use a fresh `createMockCodergenBackend()` in each test (or `beforeEach`); never share state across tests

- [ ] Task 6: Write integration test proving retry logic (AC: #6)
  - [ ] Add a `describe('MockCodergenBackend — integration with graph executor')` block in `mock-backend.test.ts`
  - [ ] **Before implementing**: read `packages/factory/src/graph/executor.ts` to confirm `createGraphExecutor()` API and how `CodergenHandlerOptions` with `backend` is passed through the registry
  - [ ] Build a minimal 3-node DOT graph (start → codergen_node → exit) with `maxRetries=2` on `codergen_node`
  - [ ] Create a `MockCodergenBackend` with `responses: [{ status: 'NEEDS_RETRY' }, { status: 'SUCCESS', contextUpdates: { result: 'done' } }]`
  - [ ] Wire the mock into the executor via `createCodergenHandler({ backend: mock })` and `createDefaultRegistry()` with this handler registered
  - [ ] Execute the graph; assert final outcome `status === 'SUCCESS'`
  - [ ] Assert `mock.calls.length === 2` (one retry)
  - [ ] Assert `mock.calls[1].context.getString('codergen_node_output', '') !== ''` OR that the second call received the context from the first attempt (confirm executor behavior by reading `executor.ts` first)

- [ ] Task 7: Build and run tests (AC: #7)
  - [ ] Run `pgrep -f vitest` — confirm no concurrent vitest process
  - [ ] Run `npm run build` to catch TypeScript errors before the test run
  - [ ] Run `npm run test:fast` with `timeout: 300000`; do NOT pipe output through `grep`, `head`, `tail`, or any other command
  - [ ] Confirm output contains "Test Files" summary line with zero failures
  - [ ] Record the final test count in the Dev Agent Record

## Dev Notes

### Architecture Constraints
- **New directory**: `packages/factory/src/backend/` — create it fresh; no prior files exist here
- **New files**: `packages/factory/src/backend/types.ts`, `packages/factory/src/backend/mock-backend.ts`, `packages/factory/src/backend/index.ts`, `packages/factory/src/backend/__tests__/mock-backend.test.ts`
- **Modified files**: `packages/factory/src/handlers/codergen-handler.ts` (add `backend?` to options), `packages/factory/src/handlers/index.ts` (re-export ICodergenBackend), `packages/factory/src/index.ts` (add backend barrel if absent)
- **ESM `.js` extensions**: all relative imports use `.js` extensions (e.g., `import { ICodergenBackend } from '../backend/types.js'`)
- **Node built-ins**: use `node:` prefix if any are needed
- **Test framework**: Vitest only — `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
- **No circular dependencies**: `backend/types.ts` imports from `graph/types.ts`; `handlers/codergen-handler.ts` imports from `backend/types.ts`; `backend` must NOT import from `handlers/`

### Pre-implementation Read Checklist
Before writing Task 3 (codergen handler wiring), read these files to confirm current shapes:
- `packages/factory/src/handlers/codergen-handler.ts` — current `CodergenHandlerOptions` fields and the exact location of the `callLLM()` invocation
- `packages/factory/src/graph/types.ts` — confirm `Outcome` shape, especially `contextUpdates?: Record<string, string>` field name and type
- `packages/factory/src/index.ts` — check whether a `backend` barrel is already re-exported; add it only if missing

Before writing Task 6 (integration test), read:
- `packages/factory/src/graph/executor.ts` — confirm `createGraphExecutor()` signature and how handler registry is passed; confirm whether `contextUpdates` from handler `Outcome` are written back to `GraphContext` automatically

### MockCodergenBackend Design Notes
- **1-based call counting**: `_callCount` starts at 0 and is incremented to 1 on the first call. `failOnCall: [1, 3]` means "the 1st and 3rd invocations fail" — align with this convention throughout
- **Response cycling**: when call index exceeds `responses.length`, return `responses[responses.length - 1]` (last response repeats indefinitely). This avoids throwing on over-use in long integration tests
- **No external dependencies**: `MockCodergenBackend` must not import `callLLM` or `@substrate-ai/core` — it exists precisely to replace that dependency
- **Delay implementation**: use `new Promise<void>(resolve => setTimeout(resolve, config.delay))` — this is fakeable via `vi.useFakeTimers()`

### Codergen Handler Wiring — Minimal Change Principle
The modification to `codergen-handler.ts` should be surgical:
```typescript
// After interpolating prompt and before callLLM:
if (options?.backend) {
  return options.backend.run(node, interpolatedPrompt, context);
}
// existing callLLM path unchanged below
```
The backend path short-circuits the rest of the function — model resolution, `callLLM`, error classification are all bypassed when a backend is provided. This is intentional: the mock owns the full Outcome, not just the LLM text.

### Testing Requirements
- **Never pipe test output** — run `npm run test:fast` without `| grep`, `| head`, `| tail`, or any filter
- **Check for concurrent vitest**: `pgrep -f vitest` must return nothing before running tests
- **Confirm results** by looking for the "Test Files" line in output — exit code 0 alone is insufficient
- **Build first**: run `npm run build` to catch TypeScript errors before the test run
- **Fake timers for delay tests**: use `vi.useFakeTimers()` in `beforeEach` and `vi.useRealTimers()` in `afterEach` for the delay test block to avoid slow wall-clock waits

## Interface Contracts

- **Export**: `ICodergenBackend` @ `packages/factory/src/backend/types.ts` (consumed by story 42-14 executor wiring and any future real backend implementations)
- **Export**: `MockCodergenBackend`, `createMockCodergenBackend` @ `packages/factory/src/backend/mock-backend.ts` (consumed by integration tests in story 42-15 and 42-17)
- **Import**: `GraphNode`, `IGraphContext`, `Outcome`, `OutcomeStatus` @ `packages/factory/src/graph/types.ts` (from stories 42-1, 42-2, 42-8)
- **Import**: `callLLM` @ `packages/core/src/llm/client.ts` (from story 42-10 — used in the unchanged callLLM path of codergen handler)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
