# Story 50-2: Fan-In Handler — Merge and Best-Candidate Selection

## Story

As a pipeline author,
I want a `parallel.fan_in` node that consolidates results from parallel branches and selects the best candidate,
so that I can implement parallel-exploration patterns where multiple implementations are generated concurrently and the strongest one is chosen.

## Acceptance Criteria

### AC1: Heuristic Selection by Outcome Rank
**Given** a fan-in node without a `prompt` attribute and `parallel.results` containing multiple branch results
**When** the fan-in handler executes
**Then** it selects the winner by ranking SUCCESS > PARTIAL_SUCCESS > NEEDS_RETRY > FAILURE, with ties broken by `score` descending, then `branch_id` ascending

### AC2: LLM-Based Selection
**Given** a fan-in node with a non-empty `prompt` attribute and `parallel.results` containing multiple branch results
**When** the fan-in handler executes
**Then** it calls the injected (or default) `llmCall` with the node prompt plus branch summaries, parses the response to identify the winning `branch_id`, and selects that branch as the winner

### AC3: Winner Context Updates Applied
**Given** a winning branch is selected (heuristic or LLM mode)
**When** the fan-in handler completes
**Then** the winner's `context_updates` are merged into the main context, `parallel.fan_in.best_id` (number) is recorded in context, and `parallel.fan_in.best_outcome` (OutcomeStatus string) is recorded in context

### AC4: All-Failed Scenario
**Given** all branches in `parallel.results` have status `FAILURE`
**When** the fan-in handler executes
**Then** it returns a `FAILURE` outcome with a `failureReason` that lists the failure reasons from all branches

### AC5: Partial-Failure Tolerance
**Given** `parallel.results` contains a mix of `FAILURE` and non-`FAILURE` branches
**When** the fan-in handler evaluates
**Then** it selects the best among the non-`FAILURE` branches only, applies the winner, and returns a `SUCCESS` outcome

### AC6: Empty or Absent Results
**Given** `parallel.results` is absent from context or is an empty array
**When** the fan-in handler executes
**Then** it returns a `FAILURE` outcome with a descriptive error message indicating no parallel results were found

### AC7: Registry Wiring
**Given** the default handler registry created by `createDefaultRegistry()`
**When** resolving a node with `shape="tripleoctagon"` or explicit `type="parallel.fan_in"`
**Then** the fan-in handler is returned

## Tasks / Subtasks

- [ ] Task 1: Define shared `BranchResult` type and implement heuristic selection in `packages/factory/src/handlers/fan-in.ts` (AC: #1, #4, #5, #6)
  - [ ] Define and export `BranchResult` interface: `{ branch_id: number; status: OutcomeStatus; context_updates?: Record<string, unknown>; score?: number; failure_reason?: string }` — this is the contract that story 50-1 must write into `parallel.results`
  - [ ] Implement and export `rankBranches(results: BranchResult[]): BranchResult | null` — filter out `FAILURE` branches, sort remaining by OUTCOME_RANK ascending (`SUCCESS=0`, `PARTIAL_SUCCESS=1`, `NEEDS_RETRY=2`), then `score` descending (treat `undefined` as `0`), then `branch_id` ascending; return `null` if all branches are `FAILURE`
  - [ ] Implement `createFanInHandler(options?: FanInHandlerOptions): NodeHandler` — reads `parallel.results` from context, returns `FAILURE` if absent/empty, delegates to heuristic or LLM path, merges winner's `context_updates` into context, sets `parallel.fan_in.best_id` and `parallel.fan_in.best_outcome`, returns `SUCCESS`

- [ ] Task 2: Implement LLM-based selection path in `fan-in.ts` (AC: #2)
  - [ ] Define `FanInHandlerOptions` with injectable `llmCall?: (prompt: string) => Promise<string>` for testability; in production (no option supplied) bind to the unified LLM client from `@substrate-ai/core` — read `packages/core/src/index.ts` to confirm the correct import path before writing
  - [ ] Implement and export `buildSelectionPrompt(nodePrompt: string, results: BranchResult[]): string` — prepends the node's prompt, then lists each branch with its `branch_id`, `status`, `score`, and the keys present in `context_updates` (values omitted for token efficiency); instructs the LLM to reply with just the integer `branch_id` of the best candidate
  - [ ] Implement and export `parseLlmWinnerResponse(response: string, results: BranchResult[]): BranchResult | null` — scans the LLM response for the first integer that matches a valid `branch_id`; returns the matching `BranchResult`, or `null` (triggering heuristic fallback) if none found; log a `warn`-level message on fallback

- [ ] Task 3: Wire fan-in handler into the default registry (AC: #7)
  - [ ] In `packages/factory/src/handlers/registry.ts` `createDefaultRegistry()`, add `registry.register('parallel.fan_in', createFanInHandler())` following the existing pattern for other handlers
  - [ ] In the same function add `registry.registerShape('tripleoctagon', 'parallel.fan_in')` following the existing shape-mapping pattern (e.g., `box → codergen`)

- [ ] Task 4: Update barrel exports (AC: #7)
  - [ ] In `packages/factory/src/handlers/index.ts`, export `createFanInHandler`, `FanInHandlerOptions`, `BranchResult`, `rankBranches`, `buildSelectionPrompt`, and `parseLlmWinnerResponse` — utility function exports enable unit testing without instantiating the full handler

- [ ] Task 5: Write unit tests in `packages/factory/src/handlers/__tests__/fan-in.test.ts` (AC: #1–#7)
  - [ ] Heuristic: multiple branches with varied statuses — verify correct winner (SUCCESS beats PARTIAL_SUCCESS beats NEEDS_RETRY)
  - [ ] Heuristic tiebreak: same status, varied scores — verify score descending wins; same score, varied `branch_id` — verify ascending ID wins
  - [ ] Heuristic: mix of FAILURE and non-FAILURE — verify FAILURE branches excluded, best non-FAILURE selected
  - [ ] All-FAILURE: verify handler returns `FAILURE` outcome with `failureReason` containing individual branch failure reasons
  - [ ] Empty `parallel.results`: verify `FAILURE` outcome with descriptive message
  - [ ] Absent `parallel.results` (key not in context): verify `FAILURE` outcome
  - [ ] LLM path: mock `llmCall`, verify `buildSelectionPrompt` receives node prompt + branch data, verify winner from parsed `branch_id` in response
  - [ ] LLM parse failure (response has no valid `branch_id`): verify fallback to heuristic, verify warning logged
  - [ ] Context merge: verify winner's `context_updates` keys are applied to context, `parallel.fan_in.best_id` equals winner's `branch_id`, `parallel.fan_in.best_outcome` equals winner's `status`
  - [ ] Registry wiring: `createDefaultRegistry()` resolves `{ shape: 'tripleoctagon' }` node to a function (fan-in handler), and resolves `{ type: 'parallel.fan_in' }` node to same handler
  - [ ] Minimum 12 test cases total; target 15+

## Dev Notes

### Architecture Constraints
- Handler factory pattern is mandatory: `createFanInHandler(options?: FanInHandlerOptions): NodeHandler` — a factory function returning an async `NodeHandler`. Do NOT use a class. Match the patterns in `conditional.ts` (minimal), `wait-human.ts` (injectable deps), and `codergen-handler.ts` (options struct with defaults).
- `NodeHandler` signature: `(node: GraphNode, context: GraphContext, graph: Graph) => Promise<Outcome>` — defined in `packages/factory/src/handlers/types.ts`
- `Outcome` and `OutcomeStatus` live in `packages/factory/src/graph/types.ts`. The valid `OutcomeStatus` values are: `'SUCCESS'` | `'PARTIAL_SUCCESS'` | `'FAILURE'` | `'NEEDS_RETRY'` | `'ESCALATE'`. **Do NOT use `'FAIL'` or `'RETRY'`** — those are Attractor spec shorthand; the actual codebase enums differ.
- Node attributes accessed via `node.attributes["prompt"]` — check the `codergen-handler.ts` for the exact access pattern.
- Context I/O: `context.get(key)` / `context.set(key, value)` — confirm the exact `GraphContext` interface before writing.

### BranchResult Contract (cross-story)
`BranchResult` defined in this story (`fan-in.ts`) is the authoritative type for the `parallel.results` context key. Story 50-1 (parallel handler) **must import and use `BranchResult`** when writing results — this ensures type safety at the story boundary. If story 50-1 has already been implemented with a local type, reconcile the shapes and re-export from `index.ts`.

### LLM Integration
- Story 50-4 implements a dedicated `llm-evaluator.ts` for semantic edge routing. For this story, keep the LLM integration self-contained with an injectable `llmCall` function.
- **Before writing the production LLM binding**, read `packages/core/src/index.ts` (or `packages/core/src/`) to locate the unified LLM client exported by Epic 48. Use that exact import path — do not guess or assume a path.
- The LLM call for fan-in selection is intentionally lightweight: one round-trip, no tool use, response expected to be a short integer or sentence containing an integer.

### Attractor Spec Conformance
Per `docs/reference/attractor-spec.md` (lines 853–890), the fan-in handler must:
- Read from context key `parallel.results`
- Write to context keys `parallel.fan_in.best_id` (number) and `parallel.fan_in.best_outcome` (OutcomeStatus string)
- Return `SUCCESS` when at least one branch succeeded
- Return `FAILURE` only when ALL branches failed or results are empty
- Support both heuristic and LLM selection modes based on presence of `node.prompt`

### Testing Requirements
- Unit tests only — end-to-end integration tests are in story 50-11
- Mock `llmCall` via `FanInHandlerOptions` injection; do NOT mock module internals
- Run during development with: `npm run test:fast`
- Before merging: `npm test` (full suite)
- Do not run tests concurrently — verify `pgrep -f vitest` returns nothing before starting

### File Paths Summary
| Action | File |
|--------|------|
| New | `packages/factory/src/handlers/fan-in.ts` |
| Modify | `packages/factory/src/handlers/registry.ts` |
| Modify | `packages/factory/src/handlers/index.ts` |
| New | `packages/factory/src/handlers/__tests__/fan-in.test.ts` |

## Interface Contracts

- **Export**: `BranchResult` @ `packages/factory/src/handlers/fan-in.ts` (consumed by story 50-1 parallel handler when writing `parallel.results` to context)
- **Import**: `parallel.results` context key @ runtime (array of `BranchResult`, produced by story 50-1 parallel handler at node execution time)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
