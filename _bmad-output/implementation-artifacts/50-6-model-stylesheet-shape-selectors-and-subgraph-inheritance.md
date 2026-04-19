# Story 50-6: Model Stylesheet — Shape Selectors and Subgraph Inheritance

## Story

As a pipeline graph author,
I want stylesheet shape-based selectors to cascade automatically through executor and subgraph boundaries,
so that I can define LLM routing rules once at the graph level and have every node — including those inside subgraphs — inherit the correct model without per-node repetition.

## Acceptance Criteria

### AC1: Shape Selector Resolves to Matching Node's LLM Properties
**Given** a stylesheet rule `box { llm_model: claude-sonnet-4-5; }` and a graph node with `shape=box`
**When** `resolveNodeStyles(node, stylesheet)` is called
**Then** `resolved.llmModel === 'claude-sonnet-4-5'` (shape selector specificity 1 applied correctly)

### AC2: Class Rule Overrides Shape Rule at Higher Specificity
**Given** a stylesheet with `box { llm_model: x; }` and `.critical { llm_model: y; }`
**When** a node with `shape=box` and `class=critical` is resolved
**Then** `resolved.llmModel === 'y'` because class selector specificity 2 beats shape selector specificity 1

### AC3: Multiple Classes Use Source-Order Tie-Breaking
**Given** a node with `class="critical,expensive"` and stylesheet rules `.critical { llm_model: a; }` followed by `.expensive { llm_model: b; }`
**When** both rules match the node at equal specificity (2)
**Then** `resolved.llmModel === 'b'` (the rule appearing later in stylesheet source order wins)

### AC4: Graph Transformer Applies Stylesheet to All Nodes Before Execution
**Given** a `Graph` with a non-empty `modelStylesheet` attribute containing valid CSS-like rules
**When** `applyStylesheet(graph)` is called
**Then** every node whose selector matches has its `llmModel`, `llmProvider`, and `reasoningEffort` fields populated from matching rules; nodes whose `llmModel` (or `llmProvider` / `reasoningEffort`) is already a non-empty string are **not** overwritten

### AC5: Graph Executor Calls Transformer Before First Node Execution
**Given** a `Graph` with `modelStylesheet="* { llm_model: haiku; }"` and nodes that have no explicit `llmModel`
**When** `createGraphExecutor().run(graph, config)` is called
**Then** `applyStylesheet` runs before the first handler is dispatched, so every handler invocation receives the already-resolved `node.llmModel === 'haiku'` without any per-handler stylesheet lookup

### AC6: Subgraph Nodes Inherit Parent Graph's Stylesheet
**Given** a parent graph with `model_stylesheet="* { llm_model: parent-model; }"` and a subgraph node that references a `.dot` file whose nodes have no explicit `llmModel` and no local `model_stylesheet`
**When** the subgraph handler executes the referenced graph
**Then** nodes inside the subgraph resolve `llmModel === 'parent-model'` from the inherited parent stylesheet

### AC7: Subgraph's Own Stylesheet Overrides Inherited Parent Rules
**Given** a parent graph with `model_stylesheet="* { llm_model: parent-model; }"` and the subgraph `.dot` file has its own `model_stylesheet="* { llm_model: child-model; }"`
**When** nodes inside the subgraph are resolved
**Then** `child-model` is applied because subgraph rules are concatenated after parent rules and therefore win at equal specificity via source-order tie-breaking

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/graph/transformer.ts` — graph stylesheet transformer (AC: #1, #2, #3, #4, #6, #7)
  - [ ] Add imports: `parseStylesheet` from `'../stylesheet/parser.js'`; `resolveNodeStyles` from `'../stylesheet/resolver.js'`; types `Graph`, `ParsedStylesheet` from `'./types.js'`
  - [ ] Export `function applyStylesheet(graph: Graph, inheritedStylesheet?: ParsedStylesheet): void`
  - [ ] Inside `applyStylesheet`: parse local stylesheet — `const localRules = graph.modelStylesheet ? parseStylesheet(graph.modelStylesheet) : []`
  - [ ] Merge: `const effectiveStylesheet: ParsedStylesheet = [...(inheritedStylesheet ?? []), ...localRules]` — parent rules first, so child local rules win at equal specificity via source order
  - [ ] If `effectiveStylesheet.length === 0`, return early (no-op)
  - [ ] For each node in `graph.nodes.values()`: call `const resolved = resolveNodeStyles(node, effectiveStylesheet)`; apply `if (!node.llmModel && resolved.llmModel) node.llmModel = resolved.llmModel`; same pattern for `llmProvider` and `reasoningEffort`
  - [ ] Export `applyStylesheet` as a named export (no default export)

- [ ] Task 2: Add `inheritedStylesheet` to `GraphExecutorConfig` in `packages/factory/src/graph/types.ts` (AC: #5, #6, #7)
  - [ ] Locate the `GraphExecutorConfig` interface (or equivalent executor config type) in `types.ts`
  - [ ] Add optional field: `inheritedStylesheet?: ParsedStylesheet` — the resolved stylesheet from a parent graph, prepended before the graph's own stylesheet rules during transformer application
  - [ ] Add a JSDoc comment: `/** Stylesheet rules inherited from a parent graph. Prepended before the graph's own model_stylesheet; child rules win at equal specificity via source order. Used by createSubgraphHandler. */`

- [ ] Task 3: Wire `applyStylesheet` into `packages/factory/src/graph/executor.ts` (AC: #5)
  - [ ] Import `applyStylesheet` from `'./transformer.js'`
  - [ ] At the very start of the `run(graph, config)` method body — before the checkpoint resume check and before the first node is dispatched — add: `applyStylesheet(graph, config.inheritedStylesheet)`
  - [ ] Verify the call does not break the resume/checkpoint path: `applyStylesheet` is idempotent for nodes that already have `llmModel` set (explicit values are preserved), so calling it twice is safe even if a graph is re-used
  - [ ] Do NOT move the call inside the main execution loop — it must run exactly once per `run()` invocation

- [ ] Task 4: Update `createSubgraphHandler` in `packages/factory/src/handlers/subgraph.ts` to pass parent stylesheet (AC: #6, #7)
  - [ ] Import `parseStylesheet` from `'../stylesheet/parser.js'`
  - [ ] After the sub-executor config is assembled (just before `createGraphExecutor().run(subgraph, subConfig)`), add: `const parentStylesheet = graph.modelStylesheet ? parseStylesheet(graph.modelStylesheet) : undefined`
  - [ ] In the sub-executor config, add `inheritedStylesheet: parentStylesheet` (undefined is acceptable — executor and transformer handle `undefined` as no inherited rules)
  - [ ] Note: `graph` here is the **parent** graph object (third argument of the `NodeHandler` signature `(node, context, graph)`), not the subgraph

- [ ] Task 5: Export `applyStylesheet` from the `graph` barrel (AC: #4)
  - [ ] In `packages/factory/src/graph/index.ts` (create if absent, otherwise extend): add `export { applyStylesheet } from './transformer.js'`
  - [ ] Also export `ParsedStylesheet` type re-export if not already present in the chain from `types.ts`
  - [ ] Verify `packages/factory/src/index.ts` propagates the new export (it likely re-exports from `./graph/index.js`; no change needed unless it uses an explicit allowlist)

- [ ] Task 6: Write unit tests in `packages/factory/src/graph/__tests__/transformer.test.ts` (AC: #1–#5)
  - [ ] Test: `applyStylesheet` with universal rule `* { llm_model: x; }` applies to all nodes
  - [ ] Test: shape rule applies to matching-shape node, does NOT apply to non-matching shape
  - [ ] Test: class rule (specificity 2) wins over shape rule (specificity 1) on same node (AC2)
  - [ ] Test: two equal-specificity class rules — later rule in stylesheet wins (AC3)
  - [ ] Test: node with explicit `llmModel` set to non-empty string is NOT overwritten (AC4 preservation)
  - [ ] Test: node with `llmModel === ''` (empty string, the default) IS overwritten (AC4 application)
  - [ ] Test: `applyStylesheet` with empty `modelStylesheet` is a no-op (no changes to nodes)
  - [ ] Test: `inheritedStylesheet` rules apply when graph has no local stylesheet
  - [ ] Test: when both `inheritedStylesheet` and local `modelStylesheet` rules exist, local rules win at equal specificity (AC7 merging logic)
  - [ ] Use `makeNode` helper (same pattern as `stylesheet.test.ts`) and a minimal `makeGraph` factory

- [ ] Task 7: Write integration tests in `packages/factory/src/handlers/__tests__/subgraph-inheritance.test.ts` (AC: #6, #7)
  - [ ] Use `vi.fn()` for `graphFileLoader` to inject subgraph DOT content without file I/O
  - [ ] Test AC6: parent graph has `model_stylesheet="* { llm_model: parent-model; }"`, subgraph DOT has no `model_stylesheet`; assert subgraph nodes receive `llmModel: 'parent-model'` — verify by mocking the sub-executor and checking the `inheritedStylesheet` field passed to it, OR by using a real executor with a minimal subgraph DOT
  - [ ] Test AC7: parent has `model_stylesheet="* { llm_model: parent-model; }"`, subgraph DOT has `model_stylesheet="* { llm_model: child-model; }"`, assert child-model wins
  - [ ] Test: parent has NO `model_stylesheet` → `inheritedStylesheet` is `undefined` in sub-executor config; subgraph executes normally without error
  - [ ] Test: `applyStylesheet` called on subgraph with empty local stylesheet and non-empty `inheritedStylesheet` populates nodes from inherited rules

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/src/` **must** use `.js` extensions (ESM project references)
- Cross-package imports use package names: `import { ... } from '@substrate-ai/core'`
- `transformer.ts` lives at `packages/factory/src/graph/transformer.ts` — sibling to `executor.ts`, `parser.ts`, `validator.ts`
- `applyStylesheet` **mutates** graph nodes in-place — this is intentional and consistent with how the parser sets node fields after DOT parsing
- `applyStylesheet` is idempotent: a node with `llmModel !== ''` (already resolved) is never overwritten, so calling it twice is safe
- `parseStylesheet` is already implemented in `packages/factory/src/stylesheet/parser.ts` (Story 42-7); do not reimplement
- `resolveNodeStyles` is already implemented in `packages/factory/src/stylesheet/resolver.ts` (Story 42-7); do not reimplement

### Key Type Locations
- `Graph`, `GraphNode`, `ParsedStylesheet`, `GraphExecutorConfig`: `packages/factory/src/graph/types.ts`
- `StylesheetRule`, `ResolvedNodeStyles`, `StylesheetSelector`: `packages/factory/src/graph/types.ts`
- `NodeHandler`, `IHandlerRegistry`: `packages/factory/src/handlers/types.ts`
- `IGraphContext`: `packages/factory/src/graph/types.ts` (or imported from `@substrate-ai/core`)

### Stylesheet Merging Strategy
The parent-first concatenation `[...inheritedRules, ...localRules]` achieves the correct override behaviour via the existing `resolveNodeStyles` source-order tie-breaking rule (Story 42-7): two rules with the same selector specificity → the one appearing later wins. By placing parent rules first, any local rule at equal specificity will appear later and therefore win. Higher-specificity local rules always win regardless of order.

### `GraphExecutorConfig` Location
Search `packages/factory/src/graph/types.ts` and `packages/factory/src/graph/executor.ts` for `GraphExecutorConfig` (or a similarly named config interface such as `ExecutorConfig` or `RunConfig`). The new `inheritedStylesheet?: ParsedStylesheet` field must be added to whichever interface is passed as the second argument to `run()`.

### Subgraph Handler Access to Parent Graph
The `NodeHandler` signature is `(node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>`. The `graph` parameter is the **parent** graph — the one containing the subgraph node. Its `modelStylesheet` field holds the parent's raw CSS-like string. Parse it with `parseStylesheet(graph.modelStylesheet)` to get `ParsedStylesheet` for the `inheritedStylesheet` field of the sub-executor config.

### Testing Requirements
- Framework: Vitest (`describe`, `it`, `expect`, `vi`)
- Minimum test count: 10 in `transformer.test.ts` + 4 in `subgraph-inheritance.test.ts`
- No real file I/O in `subgraph-inheritance.test.ts` — use `graphFileLoader: vi.fn().mockResolvedValue(dotString)` to inject subgraph DOT content
- `makeNode` helper: copy the same factory function from `stylesheet.test.ts` (fills all required `GraphNode` fields with defaults)
- All tests must pass with `npm run test:fast` (unit tests only, ~50s)
- Build must succeed with `npm run build` before running tests

### Executor Call-Site Location
In `packages/factory/src/graph/executor.ts`, locate the `run(graph, config)` function. The `applyStylesheet(graph, config.inheritedStylesheet)` call must go **before** any checkpoint resume logic or node dispatch. Placing it as the very first statement in `run()` is correct and safe.

## Interface Contracts

- **Export**: `applyStylesheet` @ `packages/factory/src/graph/transformer.ts` (consumed by executor and by story 50-7 RoutingEngine integration)
- **Import**: `parseStylesheet` @ `packages/factory/src/stylesheet/parser.ts` (from story 42-7)
- **Import**: `resolveNodeStyles` @ `packages/factory/src/stylesheet/resolver.ts` (from story 42-7)
- **Export**: `GraphExecutorConfig.inheritedStylesheet` @ `packages/factory/src/graph/types.ts` (from story 50-6, consumed by subgraph handler and story 50-7)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
