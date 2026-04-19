# Story 49-5: Fidelity Mode Integration with Summary Engine

## Story

As a graph pipeline operator,
I want graph nodes to automatically receive summarized context based on their `fidelity` attribute,
so that long-running pipelines can control LLM context pressure without manual intervention and without requiring changes to individual node handlers.

## Acceptance Criteria

### AC1: Fidelity String Parsing
**Given** a fidelity string from a graph node attribute, edge attribute, or internal executor state (including checkpoint-resume overrides)
**When** `parseFidelityLevel(fidelity: string): SummaryLevel | null` is called
**Then** the function returns:
- `null` for `''`, `'full'`, or any unrecognized value (sentinel: no summarization needed)
- `'high'` for `'high'` or `'summary:high'`
- `'medium'` for `'medium'` or `'summary:medium'`
- `'low'` for `'low'`, `'draft'`, or `'summary:low'`

### AC2: Effective Fidelity Resolution
**Given** a `GraphNode`, an optional incoming `GraphEdge`, and a `Graph`
**When** `resolveFidelity(node: GraphNode, incomingEdge: GraphEdge | undefined, graph: Graph): string` is called
**Then** the resolved fidelity string follows the precedence chain:
1. `incomingEdge.fidelity` when `incomingEdge` is defined and `incomingEdge.fidelity` is non-empty
2. `node.fidelity` when non-empty
3. `graph.defaultFidelity` when non-empty
4. `''` (empty string — no fidelity set, parseFidelityLevel returns null)

### AC3: GraphExecutorConfig — summaryEngine Option
**Given** `packages/factory/src/graph/executor.ts`
**When** a consumer creates a `GraphExecutorConfig`
**Then** the config accepts an optional `summaryEngine?: SummaryEngine` field (imported as `import type { SummaryEngine } from '../context/summary-engine.js'`); when absent the executor runs with no context summarization, all existing behaviour and tests are unaffected (backward-compatible)

### AC4: Pre-Dispatch Context Summarization
**Given** a graph executor configured with a `summaryEngine` and a node whose effective fidelity resolves to a non-null `SummaryLevel` via `parseFidelityLevel(resolveFidelity(...))`
**When** the executor is about to call `dispatchWithRetry()` for that node AND `context.getString('factory.nodeContext', '')` is non-empty
**Then** the executor calls `summaryEngine.summarize(nodeContextContent, resolvedLevel)`, writes `summary.content` to `context.set('factory.compressedNodeContext', summary.content)`, and leaves the original `factory.nodeContext` key unchanged; when `factory.nodeContext` is empty or `summaryEngine` is absent, no summarization occurs (no-op path)

### AC5: graph:context-summarized Event
**Given** the executor performed pre-dispatch context summarization for a node
**When** `summaryEngine.summarize()` resolves successfully
**Then** the executor emits `'graph:context-summarized'` on `config.eventBus` with payload `{ runId: string, nodeId: string, level: string, originalTokenCount: number, summaryTokenCount: number }` (token counts sourced from `summary.originalTokenCount ?? 0` and `summary.summaryTokenCount ?? 0`); the event is emitted BEFORE `dispatchWithRetry()` is called

### AC6: Checkpoint Resume Fidelity Parsed via parseFidelityLevel
**Given** the executor resumes from a checkpoint where `firstResumedFidelity` is set to `'summary:high'` for the first resumed node
**When** the executor resolves whether to apply pre-dispatch summarization for that node
**Then** `parseFidelityLevel('summary:high')` correctly returns `'high'`, so if `factory.nodeContext` is non-empty and `summaryEngine` is configured, the resumed node's context is compressed to the 'high' level; the existing `firstResumedFidelity !== ''` guard for the `nodeToDispatch` fidelity override assignment remains unchanged

### AC7: Unit Tests — Fidelity Module
**Given** `packages/factory/src/graph/__tests__/fidelity.test.ts`
**When** run via `npm run test:fast`
**Then** at least 12 `it(...)` cases pass covering:
- `parseFidelityLevel('')` returns `null`
- `parseFidelityLevel('full')` returns `null`
- `parseFidelityLevel('unrecognized-xyz')` returns `null`
- `parseFidelityLevel('high')` returns `'high'`
- `parseFidelityLevel('summary:high')` returns `'high'`
- `parseFidelityLevel('medium')` returns `'medium'`
- `parseFidelityLevel('summary:medium')` returns `'medium'`
- `parseFidelityLevel('low')` returns `'low'`
- `parseFidelityLevel('draft')` returns `'low'`
- `parseFidelityLevel('summary:low')` returns `'low'`
- `resolveFidelity`: edge fidelity (non-empty) takes precedence over node and graph default
- `resolveFidelity`: falls back to node.fidelity when edge is undefined or edge.fidelity is empty
- `resolveFidelity`: falls back to graph.defaultFidelity when node.fidelity is empty
- `resolveFidelity`: returns `''` when all three sources are empty or unset

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/graph/fidelity.ts` — pure fidelity resolution functions (AC: #1, #2)
  - [ ] Import types: `import type { SummaryLevel } from '../context/summary-types.js'` and `import type { GraphNode, GraphEdge, Graph } from './types.js'`
  - [ ] Export `parseFidelityLevel(fidelity: string): SummaryLevel | null`:
    - Map `'high'` or `'summary:high'` → `'high'`
    - Map `'medium'` or `'summary:medium'` → `'medium'`
    - Map `'low'` or `'draft'` or `'summary:low'` → `'low'`
    - All other values including `''` and `'full'` → `null`
    - Use a `switch` or `Map<string, SummaryLevel>` for exhaustive mapping (no if-else chains)
  - [ ] Export `resolveFidelity(node: GraphNode, incomingEdge: GraphEdge | undefined, graph: Graph): string`:
    - Check `incomingEdge?.fidelity` first; if truthy (non-empty), return it
    - Then `node.fidelity`; if truthy, return it
    - Then `graph.defaultFidelity`; if truthy, return it (cast to string — `FidelityMode | ''` is always a string)
    - Otherwise return `''`
  - [ ] No runtime side effects — pure functions only; no async, no I/O

- [ ] Task 2: Add `'graph:context-summarized'` event to `packages/factory/src/events.ts` (AC: #5)
  - [ ] **Read the entire existing `events.ts` first** to see its current structure
  - [ ] Add a new comment block after the convergence events section (before twin events or at end of graph node events section) and add:
    ```typescript
    // -------------------------------------------------------------------------
    // Context summarization events (story 49-5)
    // -------------------------------------------------------------------------

    /** Executor applied fidelity-based context summarization before node dispatch */
    'graph:context-summarized': {
      runId: string
      nodeId: string
      /** SummaryLevel applied: 'high' | 'medium' | 'low' */
      level: string
      /** Estimated token count of the original factory.nodeContext content */
      originalTokenCount: number
      /** Estimated token count of the compressed factory.compressedNodeContext content */
      summaryTokenCount: number
    }
    ```
  - [ ] Do NOT import `SummaryLevel` into `events.ts` — use `string` to keep events.ts free of cross-package imports

- [ ] Task 3: Extend `GraphExecutorConfig` with `summaryEngine?` in `packages/factory/src/graph/executor.ts` (AC: #3)
  - [ ] **Read the existing `GraphExecutorConfig` interface** (lines 50–139 approx) before editing
  - [ ] Add type-only import at the top of the file: `import type { SummaryEngine } from '../context/summary-engine.js'`
  - [ ] Add to `GraphExecutorConfig` after the `adapter?` field and before `initialContext?`:
    ```typescript
    /**
     * Optional summary engine for fidelity-based context compression.
     * When provided, nodes with a non-'full' fidelity level will have their
     * 'factory.nodeContext' compressed to the target level before dispatch.
     * When absent, all fidelity-related summarization is skipped (backward-compatible).
     * Story 49-5.
     */
    summaryEngine?: SummaryEngine
    ```

- [ ] Task 4: Add incoming-edge tracking and pre-dispatch summarization to the executor main loop (AC: #4, #5, #6)
  - [ ] **Read the full main traversal loop** in `createGraphExecutor` (starting around line 470) before editing
  - [ ] Add `import { parseFidelityLevel, resolveFidelity } from './fidelity.js'` to the imports at the top of `executor.ts`
  - [ ] In the execution state initialization block (around line 324–346), add: `let lastIncomingEdge: GraphEdge | undefined = undefined`
  - [ ] At the end of the main loop, after edge selection and BEFORE advancing `currentNode`, add: `lastIncomingEdge = edge`
    - Locate the line `currentNode = nextNode` and add `lastIncomingEdge = edge` immediately before it
  - [ ] Add a pre-dispatch summarization block AFTER the existing fidelity override block (after line 653 approximately) and BEFORE `const startedAt = Date.now()`. Insert:
    ```typescript
    // ----------------------------------------------------------------
    // Pre-dispatch context summarization based on node fidelity (story 49-5)
    // ----------------------------------------------------------------
    if (config.summaryEngine) {
      const effectiveFidelity = resolveFidelity(nodeToDispatch, lastIncomingEdge, graph)
      const summaryLevel = parseFidelityLevel(effectiveFidelity)
      if (summaryLevel !== null) {
        const nodeContextContent = context.getString('factory.nodeContext', '')
        if (nodeContextContent !== '') {
          const summary = await config.summaryEngine.summarize(nodeContextContent, summaryLevel)
          context.set('factory.compressedNodeContext', summary.content)
          config.eventBus?.emit('graph:context-summarized', {
            runId: config.runId,
            nodeId: nodeToDispatch.id,
            level: summaryLevel,
            originalTokenCount: summary.originalTokenCount ?? 0,
            summaryTokenCount: summary.summaryTokenCount ?? 0,
          })
        }
      }
    }
    ```
  - [ ] Verify the placement: this block MUST come after `const nodeToDispatch = ...` (fidelity override) and BEFORE `const startedAt = Date.now()` (artifact timing)

- [ ] Task 5: Write unit tests for `packages/factory/src/graph/__tests__/fidelity.test.ts` (AC: #7)
  - [ ] Import `describe`, `it`, `expect` from `'vitest'` — no Jest globals
  - [ ] Import `parseFidelityLevel` and `resolveFidelity` from `'../fidelity.js'`
  - [ ] Import `GraphNode`, `GraphEdge`, `Graph` types from `'../types.js'`
  - [ ] **`parseFidelityLevel` tests (10 cases):** the 10 cases listed in AC7 — use separate `it()` for each mapping
  - [ ] **`resolveFidelity` tests (4 cases):**
    - Build minimal `GraphNode` stubs (only `fidelity: string` needed; other fields can be empty string / false / 0 defaults)
    - Build minimal `GraphEdge` stubs (only `fidelity: string` needed)
    - Build minimal `Graph` stub (only `defaultFidelity: FidelityMode | ''` needed)
    - Case 1: edge.fidelity='low', node.fidelity='high', graph.defaultFidelity='medium' → returns 'low' (edge wins)
    - Case 2: edge=undefined, node.fidelity='high', graph.defaultFidelity='medium' → returns 'high' (node wins)
    - Case 3: edge.fidelity='', node.fidelity='', graph.defaultFidelity='medium' → returns 'medium' (graph wins)
    - Case 4: edge=undefined, node.fidelity='', graph.defaultFidelity='' → returns '' (all empty)
  - [ ] Ensure at least 14 total `it()` cases (10 parse + 4 resolve)

- [ ] Task 6: Write integration tests for executor fidelity behavior in `packages/factory/src/graph/__tests__/executor-fidelity.test.ts` (AC: #4, #5, #6)
  - [ ] Import `describe`, `it`, `expect`, `vi` from `'vitest'`
  - [ ] Import `createGraphExecutor` and `GraphExecutorConfig` from `'../executor.js'`
  - [ ] Import `GraphContext` from `'../context.js'`
  - [ ] Import `SummaryEngine`, `Summary`, `SummaryLevel` types from `'../../context/index.js'`
  - [ ] Define `MockSummaryEngine` class implementing `SummaryEngine` with:
    - `readonly name = 'mock-summary'`
    - `summarizeCallCount: number` counter
    - `lastSummarizeArgs: { content: string; level: SummaryLevel } | null`
    - `summarize(content, level)` stores args, increments counter, returns a deterministic `Summary` with `content: \`[${level}] ${content.slice(0, 50)}\``, `level`, `originalHash: 'test-hash'`, `createdAt: new Date().toISOString()`, `originalTokenCount: Math.ceil(content.length / 4)`, `summaryTokenCount: Math.ceil(content.length / 16)`
    - `expand()` returns the summary content unchanged
  - [ ] Build a minimal graph fixture via `parseGraph` (or construct `Graph` directly using `GraphImpl`) with:
    - One node with `fidelity='medium'` and `type='default'`
    - The node connects start→mid→exit
  - [ ] **Test 1 (AC4 — summarization fires):** Configure executor with MockSummaryEngine; set `'factory.nodeContext'` to a non-empty string in `initialContext`; run the graph with a mock handler that returns `{ status: 'SUCCESS' }`; assert `MockSummaryEngine.summarizeCallCount === 1` and `context` (captured via handler) has `'factory.compressedNodeContext'` set
  - [ ] **Test 2 (AC4 — no-op when factory.nodeContext empty):** Same setup but `factory.nodeContext` not set or empty; assert `summarizeCallCount === 0`
  - [ ] **Test 3 (AC4 — no-op when summaryEngine absent):** Same setup with `factory.nodeContext` set but `summaryEngine` omitted from config; assert handler receives context WITHOUT `'factory.compressedNodeContext'`
  - [ ] **Test 4 (AC5 — event emitted):** Capture events via mock event bus; assert `'graph:context-summarized'` fired with correct `nodeId`, `level: 'medium'`, and numeric token counts
  - [ ] **Test 5 (AC6 — summary:high from resume):** Set node `fidelity=''` (no node-level fidelity) but simulate resume by setting `firstResumedFidelity = 'summary:high'`; assert summarizeCallCount is 1 and level passed to engine is `'high'`
    - _Note_: `firstResumedFidelity` is internal executor state; to exercise this path, use a real checkpoint saved with a node that had `fidelity='full'` and then load it via `config.checkpointPath`; alternatively mock via a checkpoint fixture

- [ ] Task 7: Build and test verification (AC: all)
  - [ ] Run `npm run build` and confirm zero TypeScript errors — pay special attention to the new `fidelity.ts` imports and the `GraphEdge` parameter type (ensure `GraphEdge` is imported in `fidelity.ts`)
  - [ ] Run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line with zero failures
  - [ ] NEVER pipe test output through `grep`, `head`, `tail`, or any filter

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import type { SummaryLevel } from '../context/summary-types.js'`
- `fidelity.ts` MUST be a pure module — no async, no I/O, no class state — only exported pure functions
- The `SummaryEngine` import in `executor.ts` MUST be `import type` (type-only) — do NOT import the concrete `LLMSummaryEngine` or `CachingSummaryEngine`; the executor only depends on the interface (inversion of control)
- `events.ts` MUST NOT import from `./graph/` or `./context/` — the `level` field in `'graph:context-summarized'` MUST be typed as `string`, not `SummaryLevel`
- `factory.nodeContext` (read) and `factory.compressedNodeContext` (write) are the designated context keys for fidelity integration; do NOT repurpose any existing context keys
- The pre-dispatch summarization block MUST be placed AFTER the `nodeToDispatch` fidelity override assignment and BEFORE `const startedAt = Date.now()` — any other placement breaks artifact timing or applies wrong fidelity

### Fidelity Precedence Chain (Implementation Reference)
```
edge.fidelity (non-empty) > node.fidelity (non-empty) > graph.defaultFidelity (non-empty) > '' (no-op)
```

### parseFidelityLevel Mapping Table
```
''            → null   (no summarization)
'full'        → null   (explicit no-op)
'high'        → 'high'
'summary:high'→ 'high' (checkpoint-resume format)
'medium'      → 'medium'
'summary:medium'→ 'medium'
'low'         → 'low'
'draft'       → 'low'  (Attractor spec legacy mode)
'summary:low' → 'low'
<any other>   → null   (unrecognized = no-op)
```

### New File Paths
```
packages/factory/src/graph/fidelity.ts
packages/factory/src/graph/__tests__/fidelity.test.ts
packages/factory/src/graph/__tests__/executor-fidelity.test.ts
```

### Modified File Paths
```
packages/factory/src/events.ts                — add: 'graph:context-summarized' event type
packages/factory/src/graph/executor.ts        — add: summaryEngine? to config, lastIncomingEdge tracking, pre-dispatch summarization block
```

### Key Type Definitions for fidelity.ts

```typescript
// packages/factory/src/graph/fidelity.ts

import type { SummaryLevel } from '../context/summary-types.js'
import type { GraphNode, GraphEdge, Graph } from './types.js'

/**
 * Map a raw fidelity string to a SummaryLevel for context compression.
 *
 * Returns null when no summarization should be applied (fidelity is 'full',
 * empty, or an unrecognized value). Used by the executor before every node
 * dispatch to determine whether to call summaryEngine.summarize().
 */
export function parseFidelityLevel(fidelity: string): SummaryLevel | null {
  const FIDELITY_MAP: Record<string, SummaryLevel> = {
    'high': 'high',
    'summary:high': 'high',
    'medium': 'medium',
    'summary:medium': 'medium',
    'low': 'low',
    'draft': 'low',
    'summary:low': 'low',
  }
  return FIDELITY_MAP[fidelity] ?? null
}

/**
 * Resolve the effective fidelity string for a node about to be dispatched.
 *
 * Precedence (highest to lowest):
 *   1. incomingEdge.fidelity (non-empty)
 *   2. node.fidelity (non-empty)
 *   3. graph.defaultFidelity (non-empty)
 *   4. '' (no fidelity set — parseFidelityLevel will return null)
 */
export function resolveFidelity(
  node: GraphNode,
  incomingEdge: GraphEdge | undefined,
  graph: Graph,
): string {
  if (incomingEdge?.fidelity) return incomingEdge.fidelity
  if (node.fidelity) return node.fidelity
  if (graph.defaultFidelity) return graph.defaultFidelity
  return ''
}
```

### Executor Pre-Dispatch Block (Placement Reference)

Insert this block in `executor.ts` immediately after the fidelity override section and before `const startedAt = Date.now()`:

```typescript
// ----------------------------------------------------------------
// Pre-dispatch context summarization based on node fidelity (story 49-5)
// ----------------------------------------------------------------
if (config.summaryEngine) {
  const effectiveFidelity = resolveFidelity(nodeToDispatch, lastIncomingEdge, graph)
  const summaryLevel = parseFidelityLevel(effectiveFidelity)
  if (summaryLevel !== null) {
    const nodeContextContent = context.getString('factory.nodeContext', '')
    if (nodeContextContent !== '') {
      const summary = await config.summaryEngine.summarize(nodeContextContent, summaryLevel)
      context.set('factory.compressedNodeContext', summary.content)
      config.eventBus?.emit('graph:context-summarized', {
        runId: config.runId,
        nodeId: nodeToDispatch.id,
        level: summaryLevel,
        originalTokenCount: summary.originalTokenCount ?? 0,
        summaryTokenCount: summary.summaryTokenCount ?? 0,
      })
    }
  }
}
```

### Context Key Convention

| Key | Set by | Read by | Purpose |
|---|---|---|---|
| `factory.nodeContext` | Node handlers (via `contextUpdates`) | Executor pre-dispatch (story 49-5) | Accumulated context content to be compressed |
| `factory.compressedNodeContext` | Executor (story 49-5) | Node handlers (optional) | Compressed view of `factory.nodeContext` at node's fidelity level |

Both keys follow the existing `factory.*` namespace convention used by `factory.lastNodeCostUsd`, etc.

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect` — no Jest globals
- Do NOT use `vi.mock()` — define `MockSummaryEngine` as a plain TypeScript class with call counters
- For the integration tests in `executor-fidelity.test.ts`, use `vi.fn()` only for the event bus mock (e.g., `{ emit: vi.fn() }`)
- Run: `npm run build` first to catch TypeScript errors; then `npm run test:fast` with `timeout: 300000`; NEVER pipe output
- Confirm results by checking for the "Test Files" summary line in raw output

### Dependencies from Prior Stories
- `SummaryEngine` interface — `packages/factory/src/context/summary-engine.ts` (story 49-1)
- `SummaryLevel`, `Summary` types — `packages/factory/src/context/summary-types.ts` (story 49-1)
- `LLMSummaryEngine` — NOT imported by this story (only the interface is needed)
- `CachingSummaryEngine` — NOT imported by this story (only the interface is needed)

## Interface Contracts

- **Import**: `SummaryEngine` @ `packages/factory/src/context/summary-engine.ts` (from story 49-1)
- **Import**: `SummaryLevel` @ `packages/factory/src/context/summary-types.ts` (from story 49-1)
- **Export**: `parseFidelityLevel`, `resolveFidelity` @ `packages/factory/src/graph/fidelity.ts` (consumed by story 49-7 CLI and future stories)
- **Convention**: `'factory.nodeContext'` context key (write) — established by this story; consumed by codergen/convergence backends in future integration
- **Convention**: `'factory.compressedNodeContext'` context key (write) — established by this story; consumed optionally by node handlers

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
