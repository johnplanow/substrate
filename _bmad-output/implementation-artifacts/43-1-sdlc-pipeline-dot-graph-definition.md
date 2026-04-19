# Story 43-1: SDLC Pipeline DOT Graph Definition

## Story

As a graph engine developer,
I want a DOT graph file that encodes the existing linear SDLC pipeline topology,
so that the graph executor can drive the same pipeline logic as an alternative to the linear orchestrator.

## Acceptance Criteria

### AC1: DOT File Parses to 8-Node Graph
**Given** `packages/sdlc/graphs/sdlc-pipeline.dot` exists on disk
**When** `parseGraph(dotSource)` is called with its contents
**Then** the returned `Graph` has exactly 8 nodes with IDs: `start`, `analysis`, `planning`, `solutioning`, `create_story`, `dev_story`, `code_review`, `exit`

### AC2: Zero Lint Errors and Zero Warnings
**Given** the parsed `Graph` from `sdlc-pipeline.dot`
**When** `createValidator().validate(graph)` is called (all 13 rules — 8 error + 5 warning)
**Then** the returned diagnostics array is empty (zero errors, zero warnings)

### AC3: `dev_story` Node Has Required Attributes
**Given** the parsed `Graph`
**When** `graph.nodes.get('dev_story')` is inspected
**Then** it has `goalGate === true`, `retryTarget === 'dev_story'`, `maxRetries === 2`, and `type === 'sdlc.dev-story'`

### AC4: `code_review` Node Is a Diamond with Two Conditional Outgoing Edges
**Given** the parsed `Graph`
**When** `graph.nodes.get('code_review')` and its outgoing edges are inspected
**Then** the node has `shape === 'diamond'` and `type === 'sdlc.code-review'`; `graph.outgoingEdges('code_review')` returns exactly 2 edges — one with `condition === 'outcome=success'` leading to `exit`, and one with `condition === 'outcome=fail'` leading to `dev_story`

### AC5: Phase Nodes Have `type === 'sdlc.phase'`
**Given** the parsed `Graph`
**When** `analysis`, `planning`, and `solutioning` nodes are inspected
**Then** each has `type === 'sdlc.phase'`; `create_story` has `type === 'sdlc.create-story'`

### AC6: Linear Topology Is Correct from `start` to `code_review`
**Given** the parsed `Graph`
**When** outgoing edges are traced from `start` through the main happy path
**Then** the single-edge sequence is: `start → analysis → planning → solutioning → create_story → dev_story → code_review`; `start` has `shape === 'Mdiamond'`; `exit` has `shape === 'Msquare'`

## Tasks / Subtasks

- [ ] Task 1: Create `packages/sdlc/graphs/` directory and author `sdlc-pipeline.dot` (AC: #1, #3, #4, #5, #6)
  - [ ] Create directory `packages/sdlc/graphs/`
  - [ ] Write `packages/sdlc/graphs/sdlc-pipeline.dot` with the following structure:
    - Graph-level attributes: `goal`, `label` describing the SDLC pipeline
    - `start [shape=Mdiamond]`
    - `analysis [type="sdlc.phase", label="Analysis Phase"]`
    - `planning [type="sdlc.phase", label="Planning Phase"]`
    - `solutioning [type="sdlc.phase", label="Solutioning Phase"]`
    - `create_story [type="sdlc.create-story", label="Create Story"]`
    - `dev_story [type="sdlc.dev-story", label="Dev Story", goal_gate=true, retry_target=dev_story, max_retries=2]`
    - `code_review [type="sdlc.code-review", label="Code Review", shape=diamond]`
    - `exit [shape=Msquare]`
    - Linear edges: `start → analysis → planning → solutioning → create_story → dev_story → code_review`
    - Conditional edges from `code_review`: `code_review -> exit [label="outcome=success"]`, `code_review -> dev_story [label="outcome=fail"]`
  - [ ] Verify the DOT file is syntactically valid DOT (no mismatched braces, all nodes declared before edge references)
  - [ ] Confirm attribute names match the DOT-to-Go mapping: `goal_gate` → `goalGate`, `retry_target` → `retryTarget`, `max_retries` → `maxRetries` (snake_case in DOT, camelCase in parsed `GraphNode`)

- [ ] Task 2: Add `@substrate-ai/factory` devDependency to `packages/sdlc/package.json` (AC: #1, #2)
  - [ ] Open `packages/sdlc/package.json` and add `"devDependencies": { "@substrate-ai/factory": "*" }` if not already present
  - [ ] This is test-only — runtime code in `packages/sdlc` does NOT import from `@substrate-ai/factory` (enforces ADR-003 no cross-package imports)
  - [ ] Run `npm install` (or `npm run build`) at repo root to confirm workspace links resolve correctly

- [ ] Task 3: Create `packages/sdlc/src/__tests__/sdlc-pipeline.test.ts` (AC: #1–#6)
  - [ ] Import `node:fs/promises` (`readFile`) and `node:path` (`join`, `dirname`) and `node:url` (`fileURLToPath`) to locate the DOT file relative to the package root
  - [ ] Import `parseGraph` from `@substrate-ai/factory/graph` or `packages/factory/src/graph/parser.js` (verify the actual export path by reading `packages/factory/src/graph/index.ts` and `packages/factory/package.json` exports)
  - [ ] Import `createValidator` from the same graph module
  - [ ] In a top-level `describe('sdlc-pipeline.dot', () => { ... })`:
    - [ ] In `beforeAll`: read file contents from `../../graphs/sdlc-pipeline.dot` relative to the test file, call `parseGraph(contents)`, store as `graph`
    - [ ] **AC1 test**: assert `graph.nodes.size === 8` and each of the 8 node IDs is present in `graph.nodes`
    - [ ] **AC2 test**: call `createValidator().validate(graph)`, assert `diagnostics.length === 0`; if not zero, print diagnostics to aid debugging
    - [ ] **AC3 test**: destructure `dev_story` node, assert `goalGate === true`, `retryTarget === 'dev_story'`, `maxRetries === 2`, `type === 'sdlc.dev-story'`
    - [ ] **AC4 test**: assert `code_review.shape === 'diamond'`, `type === 'sdlc.code-review'`; call `graph.outgoingEdges('code_review')`, assert length 2; find edge with `condition === 'outcome=success'` and assert `toNode === 'exit'`; find edge with `condition === 'outcome=fail'` and assert `toNode === 'dev_story'`
    - [ ] **AC5 test**: assert `analysis.type === 'sdlc.phase'`, `planning.type === 'sdlc.phase'`, `solutioning.type === 'sdlc.phase'`, `create_story.type === 'sdlc.create-story'`
    - [ ] **AC6 test**: assert `start.shape === 'Mdiamond'`, `exit.shape === 'Msquare'`; assert `graph.outgoingEdges('start')` has exactly 1 edge with `toNode === 'analysis'`; assert `graph.outgoingEdges('dev_story')` has exactly 1 edge with `toNode === 'code_review'`
  - [ ] All imports use ESM `.js` extensions; Node built-ins use `node:` prefix

- [ ] Task 4: Add `vitest.config.ts` or verify test discovery in `packages/sdlc` (AC: all)
  - [ ] Check whether `packages/sdlc` has its own `vitest.config.ts` or is covered by the root vitest config
  - [ ] If no test config exists in `packages/sdlc`, check `vitest.config.ts` at repo root to confirm `packages/sdlc/**/*.test.ts` is included in the test glob patterns
  - [ ] If needed, create a minimal `packages/sdlc/vitest.config.ts` referencing the root config or standalone config
  - [ ] Verify `packages/sdlc/tsconfig.json` includes `src/**/*.ts` and the `graphs/` directory is accessible at runtime via `node:fs`

- [ ] Task 5: Build and run tests (AC: all)
  - [ ] Run `npm run build` — confirm no TypeScript errors in `packages/sdlc`
  - [ ] Run `pgrep -f vitest` — confirm no concurrent vitest process
  - [ ] Run `npm run test:fast` with `timeout: 300000` — do NOT pipe output
  - [ ] Confirm output contains "Test Files" summary line with zero failures
  - [ ] If AC2 (validation) fails, inspect diagnostics output and fix the DOT file attribute that violates the lint rule; the 13 rules are implemented in `packages/factory/src/graph/rules/` — read `error-rules.ts` and `warning-rules.ts` to understand each rule's trigger condition

## Dev Notes

### Architecture Constraints
- **New files:**
  - `packages/sdlc/graphs/sdlc-pipeline.dot` (new — the primary deliverable)
  - `packages/sdlc/src/__tests__/sdlc-pipeline.test.ts` (new — validation test)
  - Possibly `packages/sdlc/vitest.config.ts` (new — if not covered by root config)
- **Modified files:**
  - `packages/sdlc/package.json` — add `devDependencies` for `@substrate-ai/factory` (test-only)
- **No modifications to `packages/factory/` source files** — this story is purely additive in `packages/sdlc`
- **ADR-003 compliance**: `packages/sdlc` runtime source must NOT import from `@substrate-ai/factory`; the `devDependency` is test-only

### DOT Attribute Naming Convention
DOT attribute names use snake_case; the parser maps them to camelCase on `GraphNode`. Verify the mapping by reading `packages/factory/src/graph/parser.ts` before writing the DOT file. Critical mappings:
- `goal_gate` → `GraphNode.goalGate` (boolean)
- `retry_target` → `GraphNode.retryTarget` (string)
- `max_retries` → `GraphNode.maxRetries` (number)
- `type` → `GraphNode.type` (string, passed through as-is)
- `shape` → `GraphNode.shape` (string, passed through as-is)

### Finding the DOT File Path in Tests
The test file lives at `packages/sdlc/src/__tests__/sdlc-pipeline.test.ts`. The DOT file is at `packages/sdlc/graphs/sdlc-pipeline.dot`. Use `import.meta.url` with `fileURLToPath` and `dirname` to build an absolute path that works regardless of the working directory vitest uses:
```ts
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readFile } from 'node:fs/promises'

const __dirname = dirname(fileURLToPath(import.meta.url))
const dotPath = join(__dirname, '../../../graphs/sdlc-pipeline.dot')
const dotSource = await readFile(dotPath, 'utf-8')
```

### Validator Import Path
The `createValidator` function is exported from `packages/factory/src/graph/validator.ts` but may not be re-exported in the barrel `packages/factory/src/graph/index.ts` (confirm by reading the barrel). If it is not in the barrel, import directly:
```ts
import { parseGraph } from '@substrate-ai/factory/graph'  // if barrel includes parseGraph
import { createValidator } from '@substrate-ai/factory'    // check factory root barrel
```
Or, since this is a devDependency test context, import from the relative workspace path using TypeScript path mapping — check `packages/sdlc/tsconfig.json` for path aliases. Read `packages/factory/src/index.ts` to see the factory package's public exports before writing any import.

### DOT Edge Condition Syntax
Edge conditions in the established graph engine syntax use the `label` attribute, not a separate `condition` attribute:
```dot
code_review -> exit [label="outcome=success"]
code_review -> dev_story [label="outcome=fail"]
```
The parser maps the `label` attribute to `GraphEdge.condition` for conditional edges (verify by reading parser.ts). The `GraphEdge.label` and `GraphEdge.condition` may be the same field or distinct — confirm before writing tests.

### 13 Lint Rules Reference
The validator runs 8 error rules + 5 warning rules (13 total). Warning rules include `prompt_on_llm_nodes` (warns if a `codergen`/LLM node has no `prompt`). Since `sdlc-pipeline.dot` uses custom types (`sdlc.phase`, `sdlc.dev-story`, etc.) rather than `codergen`, this warning rule should not trigger. Verify by reading `packages/factory/src/graph/rules/warning-rules.ts` to confirm which node types it checks. If `prompt_on_llm_nodes` fires on unknown types, add a `prompt="..."` attribute to each node.

### Testing Requirements
- Test framework: Vitest (`import { describe, it, expect, beforeAll } from 'vitest'`)
- `parseGraph` takes a DOT source string; `createValidator()` returns a `GraphValidator` — read `packages/factory/src/graph/parser.ts` and `validator.ts` to confirm exact signatures
- Run `npm run test:fast` — never pipe output; confirm "Test Files" summary line appears in output
- Never run tests concurrently: `pgrep -f vitest` must return nothing before starting
- Use `timeout: 300000` (5 min) when invoking tests via Bash

### Pre-Implementation Checklist
Before writing the DOT file, read:
1. `packages/factory/src/graph/parser.ts` — confirm DOT → `GraphNode` attribute mapping (especially `goal_gate`, `retry_target`, `max_retries`, `shape`, `type`)
2. `packages/factory/src/graph/rules/error-rules.ts` — understand all 8 error rules to avoid violations
3. `packages/factory/src/graph/rules/warning-rules.ts` — understand all 5 warning rules to avoid violations
4. `packages/factory/src/graph/types.ts` — confirm `GraphEdge.condition` vs `GraphEdge.label` distinction
5. `packages/factory/src/index.ts` — confirm what `@substrate-ai/factory` exports (for test imports)

## Interface Contracts

- **Export**: `sdlc-pipeline.dot` @ `packages/sdlc/graphs/sdlc-pipeline.dot` — the DOT graph definition consumed by stories 43-2 through 43-13 and the graph executor at runtime via `packages/sdlc/src/orchestrator/graph-orchestrator.ts` (story 43-7)
- **Import**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (from story 42-1, test-only)
- **Import**: `createValidator` @ `packages/factory/src/graph/validator.ts` (from stories 42-4/42-5, test-only)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
