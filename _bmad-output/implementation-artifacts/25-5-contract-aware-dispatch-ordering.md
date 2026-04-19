# Story 25-5: Contract-Aware Dispatch Ordering

Status: review

## User Story

As a pipeline operator,
I want the dispatch ordering to respect contract dependencies between stories,
so that a story that exports a schema is always dispatched before a story that imports it, preventing parallel stories from independently designing incompatible interfaces.

## Background

Story 25-4 introduced contract declarations in story files (exports/imports with schema names and locations). This story uses those declarations to build a dependency graph that informs dispatch ordering. Currently, the conflict detector only checks file-level conflicts via pack manifest `conflictGroups`. This story adds semantic contract dependency awareness.

The existing conflict detector in `src/modules/implementation-orchestrator/conflict-detector.ts` groups stories by potential file conflicts and assigns batch indices. This story extends that mechanism to also consider contract dependencies: if story A exports a contract that story B imports, A must be dispatched in an earlier batch than B.

## Acceptance Criteria

### AC1: Contract Dependency Graph
**Given** stories with contract declarations stored in the decision store (from Story 25-4)
**When** the orchestrator prepares to dispatch stories
**Then** it builds a contract dependency graph where edges go from exporter stories to importer stories

### AC2: Exporter Before Importer Ordering
**Given** story A exports contract "FooSchema" and story B imports "FooSchema"
**When** the dispatcher orders the stories
**Then** story A is dispatched before story B (A gets an earlier batch index)

### AC3: Dual-Export Serialization
**Given** story A and story B both export a contract named "BarSchema"
**When** the dispatcher orders the stories
**Then** they are serialized (assigned to different sequential batches) to prevent conflicting schema definitions

### AC4: No Regression for Independent Stories
**Given** stories with no contract overlap
**When** the dispatcher orders them
**Then** they continue to run in parallel as before (no change in behavior)

### AC5: Contract Dependency Event Logging
**Given** the contract dependency graph has edges
**When** the orchestrator begins dispatch
**Then** each contract dependency edge is logged as a structured event for observability

## Dev Notes

- The conflict detector is at `src/modules/implementation-orchestrator/conflict-detector.ts` — extend it to accept contract declarations
- Contract declarations are stored in the decision store with category `interface-contract` (from Story 25-4)
- The orchestrator loads decisions at the start of `run()` — query `interface-contract` declarations and pass them to the conflict detector
- Build an adjacency list: for each import, find the matching export by contract name, add an edge exporter→importer
- For dual exports (same contract name from two stories), add a bidirectional conflict (serialize them)
- The conflict detector already returns batch indices — contract dependencies should influence these batch assignments
- Emit a structured log/event when contract dependencies are detected, including the edge list

## Tasks

- [x] Task 1: Add contract dependency types (AC: #1)
  - [x] Define `ContractDeclaration` type with { storyKey, contractName, direction, filePath, transport? }
  - [x] Define `ContractDependencyEdge` type with { from, to, contractName, reason }
- [x] Task 2: Build contract dependency graph builder (AC: #1, #2, #3)
  - [x] Create `buildContractDependencyGraph(declarations: ContractDeclaration[])` function
  - [x] For each import, find matching export by contractName, create edge exporter→importer
  - [x] For dual exports (same contractName from two stories), create bidirectional conflict edge
  - [x] Return list of dependency edges
- [x] Task 3: Integrate contract dependencies into conflict detector (AC: #2, #3, #4)
  - [x] Extend `groupByConflicts()` or add a new function that merges file-conflict groups with contract dependency edges
  - [x] Stories connected by an export→import edge get different batch indices (exporter earlier)
  - [x] Stories with no contract overlap keep their original batch assignments
- [x] Task 4: Wire contract declarations into orchestrator dispatch flow (AC: #1, #5)
  - [x] In `orchestrator.run()`, query decision store for `interface-contract` declarations
  - [x] Pass declarations to the conflict detector / dependency graph builder
  - [x] Log contract dependency edges as structured events
- [x] Task 5: Write unit tests (AC: #1-#5)
  - [x] Test: simple A exports, B imports → A before B
  - [x] Test: A and B both export same contract → serialized
  - [x] Test: no contract overlap → parallel (no regression)
  - [x] Test: chain A→B→C (transitive) → correct ordering
  - [x] Test: mixed file conflicts + contract deps → both respected
  - [x] Test: dependency edges are logged

## File List

- `src/modules/implementation-orchestrator/conflict-detector.ts` — added `ContractDeclaration`, `ContractDependencyEdge`, `ContractAwareConflictResult`, `buildContractDependencyGraph`, `detectConflictGroupsWithContracts`
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — wired contract-aware dispatch: imports `getDecisionsByCategory`, `detectConflictGroupsWithContracts`, `ContractDeclaration`; queries interface-contract decisions at run() start; logs edges; iterates over ordered batches
- `src/modules/implementation-orchestrator/__tests__/contract-ordering.test.ts` — new unit tests for all AC
- `src/modules/implementation-orchestrator/__tests__/contract-aware-dispatch.test.ts` — new integration tests for AC5 (logging) and orchestrator wiring
- `src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts` — added `getDecisionsByCategory` to decisions mock
- `src/modules/implementation-orchestrator/__tests__/preflight-build-gate.test.ts` — added `getDecisionsByCategory` to decisions mock
- `src/modules/implementation-orchestrator/__tests__/heartbeat-watchdog.test.ts` — added `getDecisionsByCategory` to decisions mock
- `src/modules/implementation-orchestrator/__tests__/zero-diff-detection.test.ts` — added `getDecisionsByCategory` to decisions mock
- `src/modules/implementation-orchestrator/__tests__/decomposition-observability.test.ts` — added `getDecisionsByCategory` to decisions mock
- `src/modules/implementation-orchestrator/__tests__/batched-dev-story-dispatch.test.ts` — added `getDecisionsByCategory` to decisions mock
- `src/modules/implementation-orchestrator/__tests__/interface-contracts-integration.test.ts` — added `getDecisionsByCategory` to decisions mock
- `src/__tests__/e2e/epic-10-integration.test.ts` — added `getDecisionsByCategory` to decisions mock
