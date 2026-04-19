# Story 42-4: Graph Validator — Error Rules (8 Rules)

## Story

As a graph engine consumer,
I want a `GraphValidator` that checks a parsed `Graph` against the 8 error-severity Attractor lint rules and throws on any violation,
so that invalid graphs are caught before execution begins.

## Acceptance Criteria

### AC1: `start_node` Error Rule
**Given** a graph with zero nodes having `shape="Mdiamond"` or `id="start"/"Start"`, OR a graph with two or more such nodes
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "start_node"`, `severity: "error"`, and a descriptive message identifying the offending count or node IDs.

### AC2: `terminal_node` Error Rule
**Given** a graph with zero nodes having `shape="Msquare"` or `id="exit"/"end"`, OR a graph with two or more such nodes
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "terminal_node"`, `severity: "error"`.

### AC3: `reachability` Error Rule
**Given** a graph where one or more nodes are not reachable from the start node via BFS/DFS traversal
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "reachability"`, `severity: "error"`, and the `nodeId` of each unreachable node.

### AC4: `edge_target_exists` Error Rule
**Given** a graph with an edge whose `targetId` does not match any key in `graph.nodes`
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "edge_target_exists"`, `severity: "error"`, and the `edgeIndex` of the offending edge.

### AC5: `start_no_incoming` and `exit_no_outgoing` Error Rules
**Given** a graph where an edge targets the start node (incoming edge), or an edge originates from the exit node (outgoing edge)
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "start_no_incoming"` or `"exit_no_outgoing"` respectively, `severity: "error"`.

### AC6: `condition_syntax` Error Rule
**Given** a graph containing an edge with a `condition` attribute that does not conform to the Attractor condition grammar (e.g., double-equals `outcome==success`, unrecognised operator)
**When** `validate(graph)` is called
**Then** it returns a `ValidationDiagnostic` with `ruleId: "condition_syntax"`, `severity: "error"`, and the `edgeIndex` of the offending edge.

### AC7: `validateOrRaise` Throws on Error Diagnostics
**Given** a `Graph` that produces one or more error-severity diagnostics from `validate()`
**When** `validateOrRaise(graph)` is called
**Then** it throws an `Error` whose message lists all error diagnostics; a graph with only warnings does NOT cause it to throw.

### AC8: All Unit Tests Pass
**Given** the validator implementation after this story
**When** `npm run test:fast` is run from the repo root
**Then** the output contains the "Test Files" summary line, all new tests for the 8 error rules and `validateOrRaise` pass, and no previously passing tests regress. [PRD: GE-V1]

## Tasks / Subtasks

- [ ] Task 1: Read existing parser output and define validator types (AC: #1–#7)
  - [ ] Read `packages/factory/src/graph/types.ts` in full (Graph, GraphNode, GraphEdge, FidelityMode from stories 42-1 through 42-3)
  - [ ] Read `packages/factory/src/graph/parser.ts` to understand the `outgoingEdges()` helper and graph structure
  - [ ] Read `packages/factory/src/graph/__tests__/` to understand existing test patterns (vitest imports, fixture style)
  - [ ] Define `ValidationDiagnostic`, `LintRule`, and `GraphValidator` interfaces in `packages/factory/src/graph/types.ts` (or a new `packages/factory/src/graph/validator-types.ts` if types.ts is getting large):
    ```typescript
    interface ValidationDiagnostic {
      ruleId: string
      severity: 'error' | 'warning'
      message: string
      nodeId?: string
      edgeIndex?: number
    }
    interface LintRule {
      id: string
      severity: 'error' | 'warning'
      check(graph: Graph): ValidationDiagnostic[]
    }
    interface GraphValidator {
      validate(graph: Graph): ValidationDiagnostic[]
      validateOrRaise(graph: Graph): void
      registerRule(rule: LintRule): void
    }
    ```

- [ ] Task 2: Scaffold `validator.ts` and `rules/` directory (AC: #1–#7)
  - [ ] Create `packages/factory/src/graph/validator.ts` — exports `createValidator(): GraphValidator`; maintains an array of registered `LintRule`s; `validate()` iterates all rules, concatenates diagnostics; `validateOrRaise()` calls `validate()`, throws if any `severity === 'error'`
  - [ ] Create `packages/factory/src/graph/rules/` directory with one file per error rule (or a single `error-rules.ts` grouping all 8)
  - [ ] Export all rules and the validator from `packages/factory/src/graph/index.ts` (or add to existing exports)

- [ ] Task 3: Implement structural error rules — `start_node`, `terminal_node`, `start_no_incoming`, `exit_no_outgoing`, `edge_target_exists` (AC: #1, #2, #4, #5)
  - [ ] `start_node`: count nodes where `node.shape === 'Mdiamond'` OR `['start', 'Start'].includes(node.id)`; error if count !== 1
  - [ ] `terminal_node`: count nodes where `node.shape === 'Msquare'` OR `['exit', 'end'].includes(node.id)`; error if count !== 1
  - [ ] `start_no_incoming`: find start node ID; scan `graph.edges` for any edge where `targetId === startNodeId`; produce error for each violation
  - [ ] `exit_no_outgoing`: find exit node ID; scan `graph.edges` for any edge where `sourceId === exitNodeId`; produce error for each violation
  - [ ] `edge_target_exists`: iterate all edges; for each edge where `!graph.nodes.has(edge.targetId)`, emit error with `edgeIndex`
  - [ ] Write unit tests in `packages/factory/src/graph/__tests__/validator-errors.test.ts` for each rule (happy path + violation path)

- [ ] Task 4: Implement `reachability` error rule (AC: #3)
  - [ ] Locate the start node (same logic as `start_node` rule); if no start node found, skip reachability check (structural rules fire first)
  - [ ] Perform BFS/DFS from start using `graph.outgoingEdges(nodeId)` to traverse
  - [ ] Collect all visited node IDs; for each node ID in `graph.nodes` not in visited set, emit a `ValidationDiagnostic` with `ruleId: "reachability"` and `nodeId`
  - [ ] Write unit tests: (a) fully-connected graph → no diagnostics, (b) orphan node not reachable from start → one error with correct `nodeId`, (c) two orphan nodes → two errors

- [ ] Task 5: Implement `condition_syntax` error rule (AC: #6)
  - [ ] For each edge in `graph.edges` that has a non-empty `condition` string, validate it against the Attractor condition grammar
  - [ ] Minimal grammar: a condition is one or more clauses joined by `&&`; each clause is `key=value` or `key!=value` (single `=`, not `==`); keys and values are alphanumeric with underscores/hyphens; reject anything that contains `==` or other operators
  - [ ] A regex approach is sufficient for this story: `/^[a-zA-Z_][a-zA-Z0-9_.-]*(!?=)[a-zA-Z0-9_.-]+(\s*&&\s*[a-zA-Z_][a-zA-Z0-9_.-]*(!?=)[a-zA-Z0-9_.-]+)*$/`
  - [ ] Emit `ValidationDiagnostic` with `ruleId: "condition_syntax"`, `severity: "error"`, and `edgeIndex` for each failing edge
  - [ ] Write unit tests: (a) `outcome=success` → valid, (b) `outcome!=fail` → valid, (c) `outcome=success && iteration!=0` → valid, (d) `outcome==success` (double `=`) → error at correct `edgeIndex`

- [ ] Task 6: Implement `stylesheet_syntax` error rule (AC: stub for story 42-7)
  - [ ] If `graph.modelStylesheet` is empty or undefined, return no diagnostics (no stylesheet = valid)
  - [ ] Perform a lightweight structural check: the stylesheet must consist of one or more rule blocks in the form `selector { property: value; ... }` — use a simple regex check for balanced braces and `selector {` pattern
  - [ ] If the check fails, emit `ValidationDiagnostic` with `ruleId: "stylesheet_syntax"`, `severity: "error"`, no `nodeId`
  - [ ] Write unit tests: (a) empty `modelStylesheet` → no diagnostics, (b) valid `box { llm_model: claude-3-5-sonnet; }` → no diagnostics, (c) malformed `box llm_model: claude;` (missing braces) → error diagnostic
  - [ ] Note: Full stylesheet parsing is implemented in story 42-7; this rule only needs to catch obviously malformed syntax

- [ ] Task 7: Wire up all 8 rules in `createValidator()` and implement `validateOrRaise` (AC: #7)
  - [ ] In `validator.ts`, pre-register all 8 error rules in the array when `createValidator()` is called
  - [ ] `validateOrRaise(graph)`: call `validate(graph)`, filter diagnostics for `severity === 'error'`; if any exist, throw `new Error('Graph validation failed:\n' + errors.map(d => `[${d.ruleId}] ${d.message}`).join('\n'))`
  - [ ] Write unit tests: (a) graph with errors → `validateOrRaise` throws with message containing the rule ID, (b) graph with warnings only → `validateOrRaise` does NOT throw (returns undefined), (c) valid graph → `validate` returns empty array

- [ ] Task 8: Build verification and test run (AC: #8)
  - [ ] Verify no vitest instance is running: `pgrep -f vitest` returns nothing
  - [ ] Run `npm run build` from the repo root and confirm exit code 0 and zero TypeScript errors
  - [ ] Run `npm run test:fast` from the repo root (timeout: 300000ms, foreground, do NOT pipe output)
  - [ ] Confirm output contains "Test Files" summary line and all new tests pass with zero failures

## Dev Notes

### Architecture Constraints
- **Target files (new)**:
  - `packages/factory/src/graph/validator.ts` — `createValidator(): GraphValidator` factory function
  - `packages/factory/src/graph/rules/error-rules.ts` — all 8 `LintRule` implementations (or split 1-file-per-rule at dev agent's discretion)
  - `packages/factory/src/graph/__tests__/validator-errors.test.ts` — unit tests for this story
- **Type additions**: `ValidationDiagnostic`, `LintRule`, `GraphValidator` interfaces go in `packages/factory/src/graph/types.ts` (preferred) or a co-located `validator-types.ts`
- **ESM `.js` extensions**: all intra-package imports in `packages/factory/src/` must use `.js` extensions (TypeScript resolves to `.ts` at compile time via `moduleResolution: "NodeNext"`)
- **No imports from monolith `src/`** — `packages/factory` must be self-contained; only import from `@substrate-ai/core`, `@substrate-ai/sdlc`, Node built-ins, or local package paths
- **Do NOT implement warning rules** — those belong to story 42-5; only the 8 error rules listed above are in scope

### Start/Exit Node Detection Convention
```typescript
// A node is the "start" node if:
//   node.shape === 'Mdiamond'  OR  node.id === 'start'  OR  node.id === 'Start'
// A node is the "exit" node if:
//   node.shape === 'Msquare'  OR  node.id === 'exit'  OR  node.id === 'end'
// These must match the same logic used by the executor (story 42-14).
// Export a helper: isStartNode(node: GraphNode): boolean, isExitNode(node: GraphNode): boolean
```

### `validateOrRaise` Error Format
```typescript
// Example throw message when two rules fire:
// "Graph validation failed:
//  [start_node] Expected exactly one start node, found 0
//  [reachability] Node 'orphan' is not reachable from start"
throw new Error('Graph validation failed:\n' + errors.map(d => `[${d.ruleId}] ${d.message}`).join('\n'))
```

### `condition_syntax` — Scope for This Story
The full condition expression parser (tokenizer + AST) is built in story 42-6. For this story, implement the `condition_syntax` lint rule using a regex-based validity check sufficient to catch the documented error case (`==` instead of `=`). The rule will be re-evaluated or refined in story 42-6 once the full parser exists.

### `stylesheet_syntax` — Scope for This Story
The full model stylesheet parser is built in story 42-7. For this story, implement a lightweight structural check (balanced braces, `selector { ... }` pattern). The rule will be replaced or refined in story 42-7.

### Testing Requirements
- Use `vitest` (already configured in the repo)
- Test file: `packages/factory/src/graph/__tests__/validator-errors.test.ts`
- Do NOT run tests concurrently — verify `pgrep -f vitest` returns nothing before running
- Run `npm run test:fast` from the **repo root** (not inside `packages/factory/`) — tests are discovered across the monorepo
- Do NOT pipe test output through `head`, `grep`, `tail`, or any command — must see the "Test Files" summary line
- Minimum test coverage for this story:
  - 2 tests per structural rule: happy path (valid graph → 0 diagnostics) + violation (→ error diagnostic with correct `ruleId`)
  - 3 tests for `reachability`: fully-connected, single orphan, two orphans
  - 4 tests for `condition_syntax`: 3 valid conditions + 1 invalid (`==`)
  - 3 tests for `stylesheet_syntax`: empty, valid, malformed
  - 3 tests for `validateOrRaise`: errors → throws, warnings only → no throw, empty → no throw

### Key Files to Read Before Starting
- `packages/factory/src/graph/types.ts` — current `Graph`, `GraphNode`, `GraphEdge`, `FidelityMode` definitions (built in stories 42-1 through 42-3)
- `packages/factory/src/graph/parser.ts` — full source; note `outgoingEdges()` helper on `Graph` (added in story 42-3)
- `packages/factory/src/graph/__tests__/` — all existing test files from stories 42-1 through 42-3 (vitest import style, fixture patterns)
- `packages/factory/package.json` — confirm test script configuration and dependencies

## Interface Contracts

- **Export**: `ValidationDiagnostic`, `LintRule`, `GraphValidator` @ `packages/factory/src/graph/types.ts` (consumed by stories 42-5, 42-6, 42-7, 42-14)
- **Export**: `createValidator()` @ `packages/factory/src/graph/validator.ts` (consumed by stories 42-5, 42-14, 42-15)
- **Export**: `isStartNode(node)`, `isExitNode(node)` @ `packages/factory/src/graph/validator.ts` (consumed by stories 42-9, 42-14)
- **Import**: `Graph`, `GraphNode`, `GraphEdge` @ `packages/factory/src/graph/types.ts` (from story 42-3)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 42 (Graph Engine Foundation — Parser, Validator, Executor, Handlers)
