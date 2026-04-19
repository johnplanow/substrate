# Story 45-2: 4-Level Retry Target Resolution Chain

## Story

As a convergence controller,
I want a `resolveRetryTarget()` method that walks a 4-level priority chain to find a valid retry destination after an unsatisfied goal gate,
so that the executor knows exactly which node to jump to (or that no retry is possible and the pipeline must FAIL).

## Acceptance Criteria

### AC1: Node-Level `retryTarget` Resolved at Level 1
**Given** a failing goal gate node with `retryTarget = "dev_story"` and `"dev_story"` exists in `graph.nodes`
**When** `resolveRetryTarget(failedNode, graph)` is called
**Then** it returns `"dev_story"` without inspecting any lower-priority levels

### AC2: Node-Level `fallbackRetryTarget` Resolved at Level 2
**Given** a failing node with `retryTarget = ""` (absent) but `fallbackRetryTarget = "start_over"` and `"start_over"` exists in `graph.nodes`
**When** `resolveRetryTarget(failedNode, graph)` is called
**Then** it returns `"start_over"` without inspecting graph-level fields

### AC3: Graph-Level `retryTarget` Resolved at Level 3
**Given** a failing node with both node-level fields empty (`retryTarget = ""`, `fallbackRetryTarget = ""`), and the graph has `retryTarget = "global_retry"` pointing to an existing node
**When** `resolveRetryTarget(failedNode, graph)` is called
**Then** it returns `"global_retry"`

### AC4: Graph-Level `fallbackRetryTarget` Resolved at Level 4
**Given** a failing node with all node-level fields empty, `graph.retryTarget = ""`, and `graph.fallbackRetryTarget = "last_resort"` pointing to an existing node
**When** `resolveRetryTarget(failedNode, graph)` is called
**Then** it returns `"last_resort"`

### AC5: Returns `null` When No Valid Target Exists at Any Level
**Given** a failing node with all four fields empty (or all referencing non-existent nodes)
**When** `resolveRetryTarget(failedNode, graph)` is called
**Then** it returns `null`, signalling that the pipeline must return FAIL

### AC6: Non-Existent Node Reference Falls Through to Next Level
**Given** a failing node with `retryTarget = "ghost_node"` where `"ghost_node"` does NOT exist in `graph.nodes`, but `graph.retryTarget = "global_retry"` does exist
**When** `resolveRetryTarget(failedNode, graph)` is called
**Then** it falls through the missing reference and returns `"global_retry"` (level 3), not `null`

### AC7: Empty String Treated as "Not Set" — Falls Through
**Given** any field in the chain contains an empty string `""`
**When** `resolveRetryTarget()` encounters it
**Then** it skips that level and continues to the next, treating `""` identically to an absent value

## Tasks / Subtasks

- [ ] Task 1: Extend `ConvergenceController` interface in `packages/factory/src/convergence/controller.ts` (AC: #1–#7)
  - [ ] Import `GraphNode` from `'../graph/types.js'` (already has `Graph` import)
  - [ ] Add `resolveRetryTarget(failedNode: GraphNode, graph: Graph): string | null` to the `ConvergenceController` interface with JSDoc explaining the 4-level chain
  - [ ] Document that non-existent node ids and empty strings are both treated as absent (fall through to next level)

- [ ] Task 2: Implement `resolveRetryTarget` in `createConvergenceController()` in `packages/factory/src/convergence/controller.ts` (AC: #1–#7)
  - [ ] Implement a private helper `isValidTarget(id: string, graph: Graph): boolean` that returns `true` only when `id` is non-empty AND `graph.nodes.has(id)`
  - [ ] Walk the 4 candidates in order: `failedNode.retryTarget`, `failedNode.fallbackRetryTarget`, `graph.retryTarget`, `graph.fallbackRetryTarget`
  - [ ] Return the first candidate for which `isValidTarget` returns `true`
  - [ ] Return `null` if no candidate is valid

- [ ] Task 3: Write unit tests in `packages/factory/src/convergence/__tests__/controller.test.ts` (AC: #1–#7)
  - [ ] Reuse existing `minimalNode`, `makeGraph`, and `makeGateNode` helpers already in the test file
  - [ ] Add helper `makeNodeWithRetry(id, retryTarget, fallbackRetryTarget)` for concise node construction
  - [ ] Test AC1: node.retryTarget resolves (existing node) → returns that id
  - [ ] Test AC2: node.retryTarget absent, node.fallbackRetryTarget resolves → returns fallback id
  - [ ] Test AC3: both node-level fields absent, graph.retryTarget resolves → returns graph retry id
  - [ ] Test AC4: levels 1–3 absent, graph.fallbackRetryTarget resolves → returns graph fallback id
  - [ ] Test AC5: all four fields absent (or all point to missing nodes) → returns null
  - [ ] Test AC6: node.retryTarget references a non-existent node → falls through to graph.retryTarget
  - [ ] Test AC7a: empty string in node.retryTarget skips to node.fallbackRetryTarget
  - [ ] Test AC7b: empty string in ALL four fields → returns null
  - [ ] Test: multiple levels have valid targets — only level 1 (highest priority) is returned

- [ ] Task 4: Build and validate (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass, no regressions in the 7672-test baseline
  - [ ] Confirm `resolveRetryTarget` is reachable via `createConvergenceController()` return value

## Dev Notes

### Architecture Constraints

- **File to modify (only one source file):** `packages/factory/src/convergence/controller.ts`
  - Add `GraphNode` to the existing `import type { Graph, OutcomeStatus } from '../graph/types.js'` import
  - Add `resolveRetryTarget` to the `ConvergenceController` interface
  - Add the implementation to the object returned by `createConvergenceController()`
  - Do NOT create new files — the barrel `convergence/index.ts` already re-exports the interface and factory function

- **Test file to extend:** `packages/factory/src/convergence/__tests__/controller.test.ts`
  - Add new `describe` blocks below the existing ones — do NOT modify existing tests
  - Reuse `minimalNode` and `makeGraph` helpers already defined at the top of the file

- **Import style:** ESM with `.js` extensions on all relative imports within the factory package (e.g., `import type { Graph, GraphNode } from '../../graph/types.js'`).

- **No new exports needed:** `resolveRetryTarget` is a method on the existing `ConvergenceController` interface. The interface is already exported from `convergence/index.ts` and from `packages/factory/src/index.ts` — no barrel changes required.

- **Resolution semantics (from Architecture §6.2):**
  1. `failedNode.retryTarget` — node-level explicit target
  2. `failedNode.fallbackRetryTarget` — node-level fallback
  3. `graph.retryTarget` — graph-level default
  4. `graph.fallbackRetryTarget` — graph-level default fallback
  5. `null` — FAIL

  A candidate is valid only when the string is non-empty **and** the node id exists in `graph.nodes`. Empty string and non-existent ids are both treated as absent.

- **No event emission in this story:** The `graph:goal-gate-unsatisfied` event (from `events.ts`) carries `retryTarget: string | null` and is emitted by the executor. Event wiring belongs to Story 45-8 (Convergence Controller Integration with Executor), not here.

- **No side effects:** `resolveRetryTarget` is a pure read-only function. It does not mutate the outcomes map, the node, or the graph.

### Testing Requirements

- **Framework:** Vitest (configured in `packages/factory/`)
- **Run command:** `npm run test:fast` (unit tests only, ~50 s, no coverage report)
- **Verify results:** Look for the `Test Files` summary line — exit code alone is not sufficient
- **Never pipe output** through `head`, `tail`, or `grep`
- **Minimum test count:** ≥ 9 new tests in the `resolveRetryTarget` describe blocks
- **No regressions:** All 7672 existing tests must continue to pass

### Key Type References

```typescript
// GraphNode (packages/factory/src/graph/types.ts)
interface GraphNode {
  retryTarget: string          // '' means not set
  fallbackRetryTarget: string  // '' means not set
  // ... other fields
}

// Graph (packages/factory/src/graph/types.ts)
interface Graph {
  retryTarget: string          // '' means not set
  fallbackRetryTarget: string  // '' means not set
  nodes: Map<string, GraphNode>
  // ... other fields
}
```

### Dependency Notes

- **Depends on Story 45-1** (Goal Gate Evaluation) — `ConvergenceController` interface and `createConvergenceController()` are already in place; this story extends both.
- **Consumed by Story 45-7** (Remediation Context Injection) — calls `resolveRetryTarget` to find the retry destination before constructing remediation context.
- **Consumed by Story 45-8** (Convergence Controller Integration with Executor) — executor calls `resolveRetryTarget` at exit node to route the retry jump.

## Interface Contracts

- **Export**: `ConvergenceController` (extended with `resolveRetryTarget`) @ `packages/factory/src/convergence/controller.ts` (consumed by stories 45-7, 45-8)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-23: Story created for Epic 45 — Convergence Loop + Scoring
