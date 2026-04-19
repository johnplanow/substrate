# Story 42.16: PARTIAL_SUCCESS Semantics and Goal Gate Interaction

## Story

As a graph engine developer,
I want `PARTIAL_SUCCESS` outcomes to be handled correctly at retry exhaustion (governed by the `allowPartial` node attribute) and to be accepted as satisfying goal gates,
so that the Attractor spec's convergence semantics are faithfully implemented and handlers can accurately express partial completion without forcing a binary success/failure outcome.

## Acceptance Criteria

### AC1: PARTIAL_SUCCESS Satisfies Goal Gates
**Given** a node with `goalGate=true` that completed with an outcome of `PARTIAL_SUCCESS`
**When** the executor reaches the exit node and evaluates goal gates via the `ConvergenceController`
**Then** that gate is considered satisfied — `PARTIAL_SUCCESS` is treated the same as `SUCCESS` for gate evaluation per the Attractor spec

### AC2: `allowPartial=false` Demotes PARTIAL_SUCCESS to FAILURE at Retry Exhaustion
**Given** a node with `allowPartial=false` (the default) whose handler returns `PARTIAL_SUCCESS` on its final retry attempt
**When** the retry loop in `executor.ts` exhausts all attempts (i.e. `attempt >= maxRetries`)
**Then** the outcome status is demoted to `FAILURE` with an explanatory `failureReason`, and the node is treated as failed for all downstream purposes (edge selection, checkpointing, goal gate evaluation)

### AC3: `allowPartial=true` Accepts PARTIAL_SUCCESS at Retry Exhaustion
**Given** a node with `allowPartial=true` whose handler returns `PARTIAL_SUCCESS` on its final retry attempt
**When** the retry loop exhausts all attempts
**Then** the outcome is accepted as `PARTIAL_SUCCESS` — it is not promoted to `SUCCESS` and not demoted to `FAILURE`; downstream edge selection and goal gates receive the `PARTIAL_SUCCESS` status unchanged

### AC4: Multiple Goal Gates with Mixed SUCCESS and PARTIAL_SUCCESS Are All Satisfied
**Given** a graph with two nodes where `goalGate=true` — one that completed with `SUCCESS` and one that completed with `PARTIAL_SUCCESS`
**When** goal gates are evaluated at the exit node
**Then** both gates are satisfied and the `ConvergenceController.evaluateGates()` returns `{ satisfied: true, failingNodes: [] }`, allowing the pipeline to exit normally

### AC5: `PARTIAL_SUCCESS` JSDoc Documents Handler Authoring Guidelines
**Given** the `OutcomeStatus` type in `packages/factory/src/graph/types.ts`
**When** a handler author reads the JSDoc comment on the `PARTIAL_SUCCESS` member
**Then** the documentation clearly explains: use `PARTIAL_SUCCESS` when the primary objective was met but secondary goals were missed (e.g., code was generated but not all tests pass, or a report was written but coverage targets were not hit); and the `allowPartial` field on `GraphNode` is documented to explain its effect at retry exhaustion

### AC6: All Unit Tests Pass
**Given** the PARTIAL_SUCCESS implementation in executor and convergence controller
**When** `npm run test:fast` is run (after verifying no concurrent vitest process via `pgrep -f vitest`)
**Then** all new and existing tests pass with a "Test Files" summary line visible in the output, and no test is in `.skip` state without an explanatory comment

## Tasks / Subtasks

- [ ] Task 1: Add `allowPartial` demotion logic to executor retry exhaustion (AC: #2, #3)
  - [ ] Read `packages/factory/src/graph/executor.ts` (created by story 42-14) to locate the retry loop
  - [ ] After the retry loop exits and the final `outcome` is determined, insert the `allow_partial` check:
    ```typescript
    if (outcome.status === 'PARTIAL_SUCCESS' && !node.allowPartial) {
      outcome = {
        ...outcome,
        status: 'FAILURE',
        failureReason: outcome.failureReason
          ? `${outcome.failureReason} (PARTIAL_SUCCESS not accepted: allowPartial=false)`
          : 'PARTIAL_SUCCESS not accepted: allowPartial=false',
      }
    }
    ```
  - [ ] Verify the (possibly demoted) outcome is forwarded to the checkpoint save and edge selection steps unchanged

- [ ] Task 2: Create `ConvergenceController` with goal gate evaluation (AC: #1, #4)
  - [ ] Create directory `packages/factory/src/convergence/`
  - [ ] Create `packages/factory/src/convergence/controller.ts`:
    - Export interface `ConvergenceController` with methods:
      - `recordOutcome(nodeId: string, status: OutcomeStatus): void`
      - `evaluateGates(graph: Graph): { satisfied: boolean; failingNodes: string[] }`
    - Export function `createConvergenceController(): ConvergenceController`
    - `evaluateGates` iterates `graph.nodes`, selects nodes where `node.goalGate === true`, checks that each recorded outcome is `SUCCESS` or `PARTIAL_SUCCESS`; nodes with no recorded outcome are treated as unsatisfied
  - [ ] Create `packages/factory/src/convergence/index.ts` barrel exporting `ConvergenceController` and `createConvergenceController`

- [ ] Task 3: Wire `ConvergenceController` into executor terminal-node check (AC: #1, #4)
  - [ ] In `packages/factory/src/graph/executor.ts`, instantiate a `ConvergenceController` at the start of the run
  - [ ] After each successful node completion (before writing the checkpoint), call `controller.recordOutcome(node.id, outcome.status)`
  - [ ] In the terminal-node check (when `currentNode === graph.exitNode().id`), call `controller.evaluateGates(graph)`:
    - If `satisfied === false`, resolve the retry target chain (node-level `retryTarget` → `fallbackRetryTarget` → graph-level `retryTarget` → `fallbackRetryTarget` → FAIL) and route there instead of exiting
    - If `satisfied === true`, return the final executor outcome

- [ ] Task 4: Document PARTIAL_SUCCESS semantics in JSDoc (AC: #5)
  - [ ] In `packages/factory/src/graph/types.ts`, replace the bare `'PARTIAL_SUCCESS'` union member with a JSDoc-annotated form using a helper comment block above the type:
    ```typescript
    /**
     * `PARTIAL_SUCCESS` — the primary objective was met but secondary goals were missed.
     * Examples: code was generated but not all tests pass; a report was produced but
     * coverage targets were not hit. Use instead of `FAILURE` when the output has value
     * and downstream nodes can act on it.
     *
     * Retry exhaustion behaviour: if `GraphNode.allowPartial === false` (default),
     * the executor demotes `PARTIAL_SUCCESS` to `FAILURE`; if `allowPartial === true`,
     * it is accepted as-is. Goal gates always accept `PARTIAL_SUCCESS` as satisfying.
     */
    ```
  - [ ] In `GraphNode`, add a JSDoc comment to the `allowPartial` field explaining its interaction with `PARTIAL_SUCCESS` at retry exhaustion

- [ ] Task 5: Write unit tests for allow_partial retry exhaustion (AC: #2, #3, #6)
  - [ ] In `packages/factory/src/graph/__tests__/executor.test.ts`, add a `describe('allowPartial semantics')` block:
    - Test: node with `allowPartial=false`, handler returns `PARTIAL_SUCCESS` on all attempts → executor treats final node outcome as `FAILURE`
    - Test: node with `allowPartial=true`, handler returns `PARTIAL_SUCCESS` on all attempts → executor accepts `PARTIAL_SUCCESS` and continues
    - Test: node with `allowPartial=false`, handler returns `SUCCESS` → normal success, unaffected by flag
    - Use mock handlers (`vi.fn()`) returning `{ status: 'PARTIAL_SUCCESS' }`

- [ ] Task 6: Write unit tests for `ConvergenceController` goal gate evaluation (AC: #1, #4, #6)
  - [ ] Create `packages/factory/src/convergence/__tests__/controller.test.ts`:
    - Test: single goal gate node with `PARTIAL_SUCCESS` recorded → `evaluateGates` returns `{ satisfied: true, failingNodes: [] }`
    - Test: single goal gate node with `SUCCESS` recorded → satisfied
    - Test: single goal gate node with `FAILURE` recorded → `{ satisfied: false, failingNodes: [nodeId] }`
    - Test: two goal gate nodes — one `SUCCESS`, one `PARTIAL_SUCCESS` → both satisfied
    - Test: two goal gate nodes — one `SUCCESS`, one `FAILURE` → `satisfied: false`, `failingNodes` contains the failed node
    - Test: goal gate node with no recorded outcome → `satisfied: false`
    - Test: graph with no goal gate nodes → `{ satisfied: true, failingNodes: [] }` (vacuously true)

## Dev Notes

### Architecture Constraints
- **Package**: `packages/factory/` — all source and test files live here
- **`OutcomeStatus`** is defined in `packages/factory/src/graph/types.ts` and uses `'FAILURE'` (not `'FAIL'`) and `'NEEDS_RETRY'` (not `'RETRY'`). **Do not confuse** with `StageStatus` in `packages/factory/src/events.ts` which uses `'FAIL'` and `'RETRY'` — that type is used for event payloads, not handler returns.
- **`allowPartial`**: camelCase field on `GraphNode`, parsed from the DOT attribute `allow_partial` (already defined in `types.ts`). Default is `false` (the DOT parser emits `false` when the attribute is absent).
- **`goalGate`**: camelCase field on `GraphNode`, parsed from the DOT attribute `goal_gate`.
- All relative imports within `packages/factory/src/` must use ESM `.js` extensions (e.g. `import { createConvergenceController } from '../convergence/index.js'`)
- Test framework: Vitest only — import from `'vitest'`

### allow_partial Demotion — Placement in Executor
The demotion check must occur **after** the retry loop ends and the final `outcome` is determined, but **before** the outcome is used for:
1. Writing the checkpoint (`CheckpointManager.save`)
2. Selecting the next edge (`EdgeSelector.select`)
3. Emitting the `graph:node-completed` or `graph:node-failed` event

This ordering ensures the demoted status is consistently observable in checkpoint state, events, and edge selection.

### ConvergenceController Design
```typescript
// packages/factory/src/convergence/controller.ts
import type { Graph, OutcomeStatus } from '../graph/types.js'

export interface ConvergenceController {
  recordOutcome(nodeId: string, status: OutcomeStatus): void
  evaluateGates(graph: Graph): { satisfied: boolean; failingNodes: string[] }
}

export function createConvergenceController(): ConvergenceController {
  const outcomes = new Map<string, OutcomeStatus>()
  return {
    recordOutcome(nodeId, status) { outcomes.set(nodeId, status) },
    evaluateGates(graph) {
      const failingNodes: string[] = []
      for (const [id, node] of graph.nodes) {
        if (!node.goalGate) continue
        const status = outcomes.get(id)
        if (status !== 'SUCCESS' && status !== 'PARTIAL_SUCCESS') {
          failingNodes.push(id)
        }
      }
      return { satisfied: failingNodes.length === 0, failingNodes }
    },
  }
}
```

### Goal Gate Retry Target Chain
When `evaluateGates` returns `satisfied: false`, the executor resolves the next node in this priority order:
1. `failingNode.retryTarget` — the specific failing goal gate node's own retry target
2. `failingNode.fallbackRetryTarget` — the failing node's fallback
3. `graph.retryTarget` — graph-level retry target (check `Graph` type in `types.ts` for field name)
4. `graph.fallbackRetryTarget` — graph-level fallback
5. If none found: return `{ status: 'FAILURE', failureReason: 'Goal gate failed: no retry target' }`

Read `packages/factory/src/graph/types.ts` (the `Graph` interface) to confirm the exact field names for graph-level retry targets before implementing.

### Testing Requirements
- **Never pipe test output** — run `npm run test:fast` directly without `| grep`, `| head`, etc.
- **Check for concurrent vitest**: `pgrep -f vitest` must return nothing before starting
- **Confirm results** by looking for the "Test Files" line in output — exit code 0 alone is insufficient
- Mock handlers should use `vi.fn()` returning `Promise.resolve({ status: 'PARTIAL_SUCCESS' })` etc.
- For executor tests, minimally mock only `HandlerRegistry`, `CheckpointManager`, and `EdgeSelector` — use real `GraphContext` if feasible
- Build with `npm run build` before running the full test suite to catch type errors

### Key Files to Read Before Implementing
- `packages/factory/src/graph/executor.ts` (story 42-14) — locate retry loop and terminal-node check
- `packages/factory/src/graph/types.ts` — `OutcomeStatus`, `GraphNode.allowPartial`, `GraphNode.goalGate`, `Graph` interface (for retry target field names)
- `packages/factory/src/graph/index.ts` — barrel exports; update to re-export `ConvergenceController` if appropriate, or keep convergence exports in its own barrel

## Interface Contracts

- **Import**: `OutcomeStatus`, `GraphNode`, `Graph`, `Outcome` @ `packages/factory/src/graph/types.ts` (from stories 42-1/42-2/42-8)
- **Import**: `GraphExecutor`, `createGraphExecutor` @ `packages/factory/src/graph/executor.ts` (from story 42-14)
- **Export**: `ConvergenceController`, `createConvergenceController` @ `packages/factory/src/convergence/controller.ts` (consumed by executor integration and story 42-17 compliance tests)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
