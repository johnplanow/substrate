# Story 42-12: 5-Step Edge Selection Algorithm

## Story

As a graph executor,
I want an edge selection algorithm that follows the 5-step Attractor spec priority order,
so that graph traversal correctly routes between nodes based on condition evaluation, preferred labels, suggested IDs, and edge weights — matching the Attractor specification exactly.

## Acceptance Criteria

### AC1: Step 1 — Condition-Matched Edges Take Highest Priority
**Given** a node with both conditional and unconditional outgoing edges, and an outcome or context that satisfies one or more conditions
**When** `selectEdge(node, outcome, context, graph)` is called
**Then** only condition-matched edges are considered; the one with the highest `weight` is returned, with lexically-first target node ID as a tiebreak — unconditional edges are ignored entirely

### AC2: Step 2 — Preferred Label Match on Unconditional Edges
**Given** no condition-matched edges exist, and `outcome.preferredLabel` is set to a non-empty string
**When** `selectEdge` evaluates Step 2
**Then** it returns the first unconditional edge whose normalized label matches the normalized `preferredLabel` (normalization: lowercase, trim whitespace, strip accelerator prefix)

### AC3: Step 3 — Suggested Next IDs on Unconditional Edges
**Given** no condition match and no preferred label match, and `outcome.suggestedNextIds` contains one or more node IDs
**When** `selectEdge` evaluates Step 3
**Then** it iterates `suggestedNextIds` in order and returns the first unconditional edge whose `to` field matches a suggested ID; earlier entries in `suggestedNextIds` take precedence

### AC4: Steps 4 & 5 — Highest Weight with Lexical Tiebreak Among Unconditional Edges
**Given** no condition match, no preferred label match, and no suggested ID match among unconditional edges
**When** `selectEdge` evaluates Steps 4 and 5
**Then** it selects the unconditional edge with the highest `weight` attribute; when two edges share the same weight, the one targeting the lexically-first node ID (ascending alphabetical) is returned

### AC5: No Outgoing Edges Returns Null
**Given** a node that has no outgoing edges in the graph
**When** `selectEdge` is called for that node
**Then** it returns `null` immediately without evaluating any further steps

### AC6: Label Normalization Strips Accelerator Prefixes
**Given** an edge label containing an accelerator prefix such as `[Y] Yes`, `Y) Yes`, or `Y - Yes`
**When** `normalizeLabel` processes that label
**Then** the prefix is stripped and the result is the remaining text lowercased and trimmed (e.g., `"yes"`); labels with no accelerator prefix are only lowercased and trimmed

### AC7: Condition Match Supersedes preferredLabel and suggestedNextIds
**Given** a node with a matching conditional edge, and an outcome that also has a `preferredLabel` pointing to a different edge and a `suggestedNextIds` pointing to yet another edge
**When** `selectEdge` runs
**Then** the conditional edge is returned — Steps 2 and 3 are never evaluated when Step 1 produces a match

## Tasks / Subtasks

- [ ] Task 1: Scaffold `edge-selector.ts` with imports and function signatures (AC: #1–#7)
  - [ ] Create `packages/factory/src/graph/edge-selector.ts`
  - [ ] Import `GraphNode`, `GraphEdge`, `Graph`, `IGraphContext`, `Outcome` from `./types.js`
  - [ ] Import `evaluateCondition` from `./condition-parser.js`
  - [ ] Declare and export `selectEdge(node: GraphNode, outcome: Outcome, context: IGraphContext, graph: Graph): GraphEdge | null`
  - [ ] Declare and export `normalizeLabel(label: string): string` (exported for unit-test access)
  - [ ] Declare and export `bestByWeightThenLexical(edges: GraphEdge[]): GraphEdge` (exported for unit-test access)

- [ ] Task 2: Implement `normalizeLabel()` with accelerator prefix stripping (AC: #6)
  - [ ] Lowercase and trim the input string
  - [ ] Strip accelerator prefixes matching these patterns (case-insensitive, applied after lowercasing):
    - `[K] ` — bracket-enclosed single character followed by space (e.g., `[y] `)
    - `K) ` — single character followed by closing paren and space (e.g., `y) `)
    - `K - ` — single character followed by ` - ` (e.g., `y - `)
  - [ ] Use regex: `/^[a-z]\)\s+|^\[[a-z]\]\s+|^[a-z]\s+-\s+/` applied after lowercasing to strip the matching prefix
  - [ ] Return the trimmed remainder; if no prefix matches, return the lowercased-and-trimmed string as-is

- [ ] Task 3: Implement `bestByWeightThenLexical()` helper (AC: #1, #4, #5)
  - [ ] Accept a non-empty `GraphEdge[]` (caller guarantees at least one element)
  - [ ] Sort edges by `weight` descending first, then by `edge.to` ascending (string lexical order)
  - [ ] Return the first element after sort (the winner)
  - [ ] Do not mutate the input array — sort a copy

- [ ] Task 4: Implement `selectEdge()` verbatim from Attractor spec Section 3.3 (AC: #1–#5, #7)
  - [ ] Compute `outgoing = graph.edges.filter(e => e.from === node.id)`
  - [ ] If `outgoing` is empty → return `null` immediately (AC5)
  - [ ] **Step 1:** Filter `outgoing` for edges where `edge.condition` is non-empty; call `evaluateCondition(edge.condition, context.snapshot())` wrapped in try/catch (parse errors = not matched); collect matches; if any → return `bestByWeightThenLexical(matches)` (AC1, AC7)
  - [ ] **Step 2:** If `outcome.preferredLabel` is a non-empty string → iterate `outgoing` for edges where `edge.condition` is empty and `normalizeLabel(edge.label) === normalizeLabel(outcome.preferredLabel)`; return the first match (AC2)
  - [ ] **Step 3:** If `outcome.suggestedNextIds` is a non-empty array → iterate `outcome.suggestedNextIds` in order; for each id, find an edge where `edge.condition` is empty and `edge.to === id`; return on first match (AC3)
  - [ ] **Steps 4 & 5:** Collect `unconditional = outgoing.filter(e => !e.condition)`; if non-empty → return `bestByWeightThenLexical(unconditional)`; else → return `null` (AC4)
  - [ ] Note: `evaluateCondition` from 42-6 accepts `(conditionStr: string, context: Record<string, unknown>)` — pass `context.snapshot()` as the second argument

- [ ] Task 5: Barrel exports and index integration (AC: #1–#7)
  - [ ] Add re-exports to `packages/factory/src/graph/index.ts` (create this file if it does not exist): `export { selectEdge, normalizeLabel, bestByWeightThenLexical } from './edge-selector.js'`
  - [ ] Verify `packages/factory/src/index.ts` re-exports from `./graph/index.js` or add a direct export if it does not; do not break existing exports
  - [ ] Run `npm run build` from the repo root to confirm no TypeScript errors before proceeding to tests

- [ ] Task 6: Write unit tests covering all 7 ACs (AC: #1–#7)
  - [ ] Create `packages/factory/src/graph/__tests__/edge-selector.test.ts`
  - [ ] Import `{ selectEdge, normalizeLabel, bestByWeightThenLexical }` from `../edge-selector.js`
  - [ ] Use real `GraphContext` from `../context.js`; build minimal `Graph` objects inline (no mocks needed for the graph itself)
  - [ ] **AC1 tests:** node with conditional edge matching outcome context → returns that edge; two matching conditional edges with different weights → returns higher-weight one; equal weights → returns lexically-first target
  - [ ] **AC2 tests:** no condition match, `preferredLabel` matches one unconditional edge (exact after normalization) → returns that edge; `preferredLabel` matches no edge → falls through to Step 3/4
  - [ ] **AC3 tests:** `suggestedNextIds = ["b", "c"]`, edges to both "b" and "c" → returns edge to "b" (first in list); id not present in edges → falls through to Step 4
  - [ ] **AC4 tests:** two unconditional edges weights 5 and 2 → returns weight 5; equal weights and targets "node_b" and "node_a" → returns edge to "node_a" (lexically first)
  - [ ] **AC5 test:** node with no outgoing edges → `selectEdge` returns `null`
  - [ ] **AC6 tests:** `normalizeLabel("[Y] Yes")` → `"yes"`; `normalizeLabel("y) No")` → `"no"`; `normalizeLabel("y - Maybe")` → `"maybe"`; `normalizeLabel("Continue")` → `"continue"`
  - [ ] **AC7 test:** node with a matching conditional edge AND `preferredLabel` pointing elsewhere → returns conditional edge, not preferred-label edge
  - [ ] Run `pgrep -f vitest` first; then run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" in output

## Dev Notes

### Architecture Constraints
- **New file:** `packages/factory/src/graph/edge-selector.ts`
- **Modified files:** `packages/factory/src/graph/index.ts` (add barrel exports), `packages/factory/src/index.ts` (verify re-export chain)
- All relative imports within `packages/factory/src/` use ESM `.js` extensions (e.g., `import { evaluateCondition } from './condition-parser.js'`)
- No external packages beyond what is already in `packages/factory/package.json` — this module only needs types and `evaluateCondition` which are already available in the package
- TypeScript strict mode is enabled; `GraphEdge | null` return type must be explicit

### Graph Type Discovery (CRITICAL — do before Task 4)
Before writing `selectEdge`, read `packages/factory/src/graph/types.ts` to confirm:
- The exact shape of `GraphEdge` (especially `from`, `to`, `condition`, `weight`, `label` field names and types)
- The exact shape of `Graph` (especially how edges are stored: array vs Map)
- The exact shape of `Outcome` (especially `preferredLabel?: string` and `suggestedNextIds?: string[]`)
- The exact signature of `evaluateCondition` from `condition-parser.ts` (especially whether it takes a `Record<string, unknown>` or an `IGraphContext`)

Do not guess field names — read the actual source.

### evaluateCondition API Note
Story 42-6 defines `evaluateCondition(conditionStr: string, context: Record<string, unknown>): boolean`.
Pass `context.snapshot()` (which returns `Record<string, unknown>`) — do **not** pass the `IGraphContext` object directly.
Wrap each call in try/catch: if `evaluateCondition` throws (invalid condition syntax), treat the edge as non-matching for Step 1.

### Edge Weight Default
Story 42-2 defines `weight` on edges. If a `GraphEdge` has no explicit `weight` attribute, it defaults to `0`. The `bestByWeightThenLexical` sort should treat `edge.weight ?? 0` to avoid `NaN` comparisons.

### Label on Edges
Edge labels come from DOT `label` attributes and are stored as strings in `GraphEdge`. An edge with no label will have `label: ""` (empty string). `normalizeLabel("")` returns `""`. In Step 2, `normalizeLabel(edge.label) === normalizeLabel(outcome.preferredLabel)` — if both normalize to `""`, they match; avoid this false-match by only entering Step 2 when `outcome.preferredLabel` is a non-empty string.

### Accelerator Pattern Implementation
The accelerator regex should be applied **after** lowercasing the full string, so patterns are simpler:
```ts
export function normalizeLabel(label: string): string {
  const s = label.toLowerCase().trim();
  // [k] prefix, k) prefix, k - prefix
  return s.replace(/^[a-z]\)\s+/, '').replace(/^\[[a-z]\]\s+/, '').replace(/^[a-z]\s*-\s*/, '').trim();
}
```
Validate this against all AC6 test cases before considering it done.

### Testing Requirements
- Test framework: Vitest (configured; `import { describe, it, expect } from 'vitest'`)
- Run: `npm run test:fast` — never pipe output; confirm "Test Files" summary line appears
- Never run tests concurrently (`pgrep -f vitest` must return nothing before starting)
- Use real `GraphContext` for context arguments — do not stub
- Build minimal `Graph` objects inline: `{ nodes: [], edges: [...] }` — no fixtures needed
- The test file must cover every AC with at least one positive and one negative (fallthrough) case

## Interface Contracts

- **Import**: `GraphNode`, `GraphEdge`, `Graph`, `IGraphContext`, `Outcome` @ `packages/factory/src/graph/types.ts` (from stories 42-1, 42-2, 42-8)
- **Import**: `evaluateCondition` @ `packages/factory/src/graph/condition-parser.ts` (from story 42-6)
- **Export**: `selectEdge` @ `packages/factory/src/graph/edge-selector.ts` (consumed by story 42-14 — Graph Executor Core Loop)
- **Export**: `normalizeLabel`, `bestByWeightThenLexical` @ `packages/factory/src/graph/edge-selector.ts` (consumed by story 42-11 — Tool and wait.human Handlers, for label normalization parity)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
