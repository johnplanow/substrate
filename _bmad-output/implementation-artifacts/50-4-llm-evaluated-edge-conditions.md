# Story 50-4: LLM-Evaluated Edge Conditions

## Story

As a pipeline graph author,
I want to define edge conditions using natural-language questions prefixed with `llm:`,
so that graph routing decisions can use semantic LLM judgments (e.g., `condition="llm:Is this output production-ready?"`) rather than only deterministic string comparisons.

## Acceptance Criteria

### AC1: `llm:` Prefix Detected and Dispatched to LLM Evaluator
**Given** an edge with `condition="llm:Is this implementation production-ready?"` in the graph
**When** `selectEdge` encounters it in Step 1 (condition-matched edges)
**Then** it calls `evaluateLlmCondition()` passing the extracted question and the current context snapshot, rather than `evaluateCondition()`, and includes the edge in `conditionMatches` only if the LLM responds affirmatively

### AC2: Affirmative LLM Response Treated as Matching Condition
**Given** `evaluateLlmCondition` is invoked and `parseLlmBoolResponse` receives a response containing "yes", "true", "affirmative", "correct", or "1" (case-insensitive)
**When** the response is parsed
**Then** `parseLlmBoolResponse` returns `true` and the edge is treated as a condition match, eligible for selection in Step 1

### AC3: Negative LLM Response Treated as Non-Matching Condition
**Given** `parseLlmBoolResponse` receives a response containing "no", "false", "negative", "incorrect", or "0" (case-insensitive), or any response that does not contain an affirmative token
**When** the response is parsed
**Then** `parseLlmBoolResponse` returns `false` and the edge is excluded from Step 1 matches, allowing edge selection to fall through to Steps 2–5

### AC4: `selectEdge` Becomes Async and All Executor Call Sites Are Awaited
**Given** the updated `selectEdge(node, outcome, context, graph, options?: SelectEdgeOptions): Promise<GraphEdge | null>` signature
**When** compiled and executed
**Then** all three existing call sites in `packages/factory/src/graph/executor.ts` use `await selectEdge(...)`, all non-LLM routing paths continue to work identically to the synchronous version, and existing edge-selector unit tests are updated to `await` results

### AC5: LLM Evaluation Error Produces Safe Non-Match
**Given** an LLM call that throws an error (network failure, provider error, malformed response)
**When** `evaluateLlmCondition` catches the exception
**Then** it returns `false` (the edge is treated as non-matching), and the error message is appended to the array at `context.get("llm.edge_eval_errors")` (creating the array if absent) so that the pipeline can log and continue safely without crashing

### AC6: LLM Call Count Tracked in Context for Cost Accounting
**Given** one or more edges with `llm:` conditions that are evaluated during a single `selectEdge` call
**When** each evaluation completes (success or failure)
**Then** `context.get("llm.edge_eval_count")` is a number equal to the cumulative total of LLM edge evaluations performed across all `selectEdge` invocations in the current run (incremented by 1 per evaluation, initialised from `0` if absent)

### AC7: Unit Tests Cover Evaluator Module and Async Edge Selection
**Given** `packages/factory/src/graph/__tests__/llm-evaluator.test.ts` and the updated `packages/factory/src/graph/__tests__/edge-selector.test.ts`
**When** `npm run test:fast` runs
**Then** at least 14 `it(...)` cases pass covering: `isLlmCondition` (truthy/falsy), `extractLlmQuestion` (prefix stripping, whitespace), `buildEvaluationPrompt` (contains question + JSON context), `parseLlmBoolResponse` (yes/no/edge cases/empty), `evaluateLlmCondition` (affirmative mock, negative mock, thrown mock), and async `selectEdge` with `llm:` conditions (match, non-match, error fallthrough, mixed llm+regular conditions)

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/graph/llm-evaluator.ts` — pure LLM evaluation module (AC: #1, #2, #3, #5)
  - [ ] Export `isLlmCondition(condition: string): boolean` — returns `true` iff `condition.trim()` starts with `"llm:"`
  - [ ] Export `extractLlmQuestion(condition: string): string` — strips the `"llm:"` prefix and trims surrounding whitespace from the remainder
  - [ ] Export `buildEvaluationPrompt(question: string, contextSnapshot: Record<string, unknown>): string` — produces a prompt that includes the question, a JSON block of the context snapshot, and an explicit instruction to answer with only "yes" or "no"
  - [ ] Export `parseLlmBoolResponse(response: string): boolean` — case-insensitive; returns `true` if the cleaned response starts with or contains one of `["yes", "true", "affirmative", "correct", "1"]`; returns `false` otherwise (including empty string)
  - [ ] Export `async function evaluateLlmCondition(question: string, contextSnapshot: Record<string, unknown>, llmCall: (prompt: string) => Promise<string>): Promise<boolean>` — builds prompt via `buildEvaluationPrompt`, calls `llmCall(prompt)`, parses response via `parseLlmBoolResponse`, returns `false` and re-throws nothing on any error (catch block returns `false`)
  - [ ] Zero external package imports — only TypeScript types and the injectable `llmCall` parameter; `callLLM` binding is done in `edge-selector.ts`, not here

- [ ] Task 2: Add `SelectEdgeOptions` and make `selectEdge` async in `packages/factory/src/graph/edge-selector.ts` (AC: #1, #4, #5, #6)
  - [ ] Add `import { isLlmCondition, extractLlmQuestion, evaluateLlmCondition } from './llm-evaluator.js'`
  - [ ] Add `import { callLLM } from '@substrate-ai/core'`
  - [ ] Export `interface SelectEdgeOptions { llmCall?: (prompt: string) => Promise<string> }` — injectable for tests
  - [ ] Change `selectEdge` to `async function selectEdge(node, outcome, context, graph, options?: SelectEdgeOptions): Promise<GraphEdge | null>`
  - [ ] In the Step 1 loop, before evaluating each edge condition: if `isLlmCondition(edge.condition)` is true, call `await evaluateLlmCondition(extractLlmQuestion(edge.condition), snapshot, llmCall)` where `llmCall` defaults to `(prompt) => callLLM({ model: node.llmModel || 'claude-haiku-4-5', provider: node.llmProvider || 'anthropic', reasoningEffort: 'low', prompt }).then(r => r.text)`; otherwise call `evaluateCondition(edge.condition, snapshot)` as before
  - [ ] After each LLM evaluation (success or failure), increment `context.set("llm.edge_eval_count", context.getNumber("llm.edge_eval_count", 0) + 1)`
  - [ ] On LLM evaluation error, append to `context.get("llm.edge_eval_errors")` array before returning `false`; guard against non-array existing value by checking with `Array.isArray`

- [ ] Task 3: Update `packages/factory/src/graph/executor.ts` — await three `selectEdge` call sites (AC: #4)
  - [ ] Line ~452 (resume path, last-completed node): change `const nextEdge = selectEdge(...)` to `const nextEdge = await selectEdge(...)`
  - [ ] Line ~593 (resume skip path): change `const skipEdge = selectEdge(...)` to `const skipEdge = await selectEdge(...)`
  - [ ] Line ~928 (main execution loop): change `const edge = selectEdge(...)` to `const edge = await selectEdge(...)`
  - [ ] Verify no other call sites of `selectEdge` exist in the codebase (run a grep before and after)

- [ ] Task 4: Update barrel exports (AC: #4)
  - [ ] In `packages/factory/src/graph/index.ts`: add re-exports `export { isLlmCondition, extractLlmQuestion, buildEvaluationPrompt, parseLlmBoolResponse, evaluateLlmCondition } from './llm-evaluator.js'` and `export type { SelectEdgeOptions } from './edge-selector.js'`
  - [ ] In `packages/factory/src/index.ts`: verify `selectEdge` and the new graph exports flow through correctly (the barrel chain should pick them up automatically)

- [ ] Task 5: Write unit tests in `packages/factory/src/graph/__tests__/llm-evaluator.test.ts` (AC: #2, #3, #5, #7)
  - [ ] `isLlmCondition` — 3 cases: `"llm:question"` → true; `"outcome=success"` → false; `"llm:"` (empty question) → true
  - [ ] `extractLlmQuestion` — 2 cases: `"llm:Is it ready?"` → `"Is it ready?"`; `"llm:  Trimmed "` → `"Trimmed"`
  - [ ] `buildEvaluationPrompt` — 1 case: returned string contains the question text and JSON-serialized context key
  - [ ] `parseLlmBoolResponse` — 5 cases: `"yes"` → true; `"YES\n"` → true; `"no"` → false; `""` → false; `"true"` → true; `"false"` → false
  - [ ] `evaluateLlmCondition` — 3 cases: mock `llmCall` returning `"yes"` → `true`; returning `"no"` → `false`; throwing `new Error("fail")` → `false` (no re-throw)
  - [ ] Total: at least 14 `it(...)` cases across both test files combined

- [ ] Task 6: Update `packages/factory/src/graph/__tests__/edge-selector.test.ts` — async conversion + LLM tests (AC: #1, #3, #4, #7)
  - [ ] Convert all existing `selectEdge(...)` call sites to `await selectEdge(...)` and mark test functions `async`
  - [ ] New test: edge with `condition="llm:Is this ready?"`, mock `options.llmCall` returning `"yes"` → edge is selected in Step 1
  - [ ] New test: edge with `condition="llm:Is this ready?"`, mock `options.llmCall` returning `"no"` → edge is not selected; unconditional edge is selected via Step 4/5
  - [ ] New test: `options.llmCall` throws → LLM edge not selected (error fallthrough); unconditional edge is returned; `context.get("llm.edge_eval_errors")` is an array with 1 entry
  - [ ] New test: mixed conditions — one regular `condition="outcome=success"` edge and one `condition="llm:question"` edge; only the regular condition matches → Step 1 returns the regular edge (LLM call is not made if regular condition already matches ahead of it in the loop)
  - [ ] Run `npm run build` before tests to catch TypeScript errors early; then run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line; NEVER pipe output

- [ ] Task 7: Run build and full test suite to confirm zero errors (AC: all)
  - [ ] Run `npm run build` and confirm zero TypeScript errors — pay special attention to the async signature change propagating through barrel exports
  - [ ] Run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line with zero failures
  - [ ] Verify no test output is piped through `grep`, `head`, `tail`, or any other filter

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { isLlmCondition } from './llm-evaluator.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `llm-evaluator.ts` must have **zero external package imports** — it is a pure algorithmic module; the `callLLM` binding lives in `edge-selector.ts`, not in `llm-evaluator.ts`
- The injectable `llmCall: (prompt: string) => Promise<string>` parameter is the primary testability mechanism — no `vi.mock('@substrate-ai/core')` required in unit tests
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- **Do NOT make `evaluateLlmCondition` import from `edge-selector.ts` or `executor.ts`** — keep the dependency arrow one-directional: `edge-selector.ts` → `llm-evaluator.ts`
- `AbortController` / timeouts for LLM calls are out of scope for this story — error handling is catch-and-return-false

### New File Paths
```
packages/factory/src/graph/llm-evaluator.ts                          — isLlmCondition, extractLlmQuestion, buildEvaluationPrompt, parseLlmBoolResponse, evaluateLlmCondition
packages/factory/src/graph/__tests__/llm-evaluator.test.ts           — unit tests for llm-evaluator.ts (≥10 test cases)
```

### Modified File Paths
```
packages/factory/src/graph/edge-selector.ts    — add SelectEdgeOptions, make selectEdge async, integrate LLM evaluation in Step 1
packages/factory/src/graph/executor.ts         — await three selectEdge call sites
packages/factory/src/graph/index.ts            — add re-exports for llm-evaluator.ts and SelectEdgeOptions
packages/factory/src/index.ts                  — verify barrel exports still compile (no changes needed if graph/index.ts is updated)
packages/factory/src/graph/__tests__/edge-selector.test.ts  — async conversion + new LLM condition tests
```

### Key Type Definitions

```typescript
// packages/factory/src/graph/llm-evaluator.ts

/** Returns true iff the condition string starts with the "llm:" prefix. */
export function isLlmCondition(condition: string): boolean {
  return condition.trim().startsWith('llm:')
}

/** Strips the "llm:" prefix and trims surrounding whitespace. */
export function extractLlmQuestion(condition: string): string {
  return condition.trim().slice('llm:'.length).trim()
}

/** Builds an LLM prompt that includes the question and a JSON context snapshot. */
export function buildEvaluationPrompt(
  question: string,
  contextSnapshot: Record<string, unknown>,
): string {
  return [
    `You are evaluating a routing condition in a software pipeline.`,
    ``,
    `Context:`,
    JSON.stringify(contextSnapshot, null, 2),
    ``,
    `Question: ${question}`,
    ``,
    `Answer with exactly "yes" or "no".`,
  ].join('\n')
}

/** Parses an LLM yes/no response. Returns true for affirmative tokens, false otherwise. */
export function parseLlmBoolResponse(response: string): boolean {
  const cleaned = response.trim().toLowerCase()
  const affirmatives = ['yes', 'true', 'affirmative', 'correct', '1']
  return affirmatives.some(token => cleaned.startsWith(token) || cleaned.includes(token))
}

/** Evaluates an LLM edge condition. Returns false on any error — never throws. */
export async function evaluateLlmCondition(
  question: string,
  contextSnapshot: Record<string, unknown>,
  llmCall: (prompt: string) => Promise<string>,
): Promise<boolean> {
  try {
    const prompt = buildEvaluationPrompt(question, contextSnapshot)
    const response = await llmCall(prompt)
    return parseLlmBoolResponse(response)
  } catch {
    return false
  }
}
```

```typescript
// packages/factory/src/graph/edge-selector.ts — additions

export interface SelectEdgeOptions {
  /**
   * Injectable LLM call function for testability.
   * In production, defaults to calling `callLLM` from `@substrate-ai/core`
   * using the node's `llmModel` / `llmProvider` attributes.
   */
  llmCall?: (prompt: string) => Promise<string>
}

export async function selectEdge(
  node: GraphNode,
  outcome: Outcome,
  context: IGraphContext,
  graph: Graph,
  options?: SelectEdgeOptions,
): Promise<GraphEdge | null>
```

### Default LLM Call Binding

The default `llmCall` in `selectEdge` is constructed as:

```typescript
const defaultLlmCall = (prompt: string): Promise<string> =>
  callLLM({
    model: node.llmModel || 'claude-haiku-4-5',
    provider: node.llmProvider || 'anthropic',
    reasoningEffort: 'low',
    prompt,
  }).then((r) => r.text)

const llmCall = options?.llmCall ?? defaultLlmCall
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- `evaluateLlmCondition` is tested with an inline mock function (`vi.fn()` or a plain `async () => "yes"`) — no module mocking needed
- The `options.llmCall` injectable in `selectEdge` is used for all new edge-selector tests — no `vi.mock` on `@substrate-ai/core`
- Run build first: `npm run build` — the async signature change must compile cleanly before testing
- Run tests with: `npm run test:fast` — use `timeout: 300000` (5 min) in Bash tool; NEVER pipe output
- Confirm results by checking for "Test Files" summary line in raw output
- Minimum 14 `it(...)` cases across `llm-evaluator.test.ts` + new additions to `edge-selector.test.ts`

### Important: Executor Call Site Locations
Read `packages/factory/src/graph/executor.ts` before editing to confirm exact line numbers. The three `selectEdge` call sites are:
1. Resume path — advancing past the last checkpointed node (looks like: `selectEdge(lastNode, { status: 'SUCCESS' }, context, graph)`)
2. Resume skip path — skipping already-completed nodes (looks like: `selectEdge(currentNode, { status: 'SUCCESS' } as GraphOutcome, context, graph)`)
3. Main execution loop — after a handler returns an outcome (looks like: `selectEdge(currentNode, outcome as unknown as GraphOutcome, context, graph)`)

Use grep to find all remaining call sites before and after editing: `grep -n "selectEdge" packages/factory/src/graph/executor.ts`

## Interface Contracts

- **Export**: `SelectEdgeOptions` @ `packages/factory/src/graph/edge-selector.ts` (consumed by story 50-11)
- **Export**: `isLlmCondition` @ `packages/factory/src/graph/llm-evaluator.ts` (consumed by story 50-11)
- **Export**: `extractLlmQuestion` @ `packages/factory/src/graph/llm-evaluator.ts` (consumed by story 50-11)
- **Export**: `buildEvaluationPrompt` @ `packages/factory/src/graph/llm-evaluator.ts` (consumed by story 50-11)
- **Export**: `parseLlmBoolResponse` @ `packages/factory/src/graph/llm-evaluator.ts` (consumed by story 50-11)
- **Export**: `evaluateLlmCondition` @ `packages/factory/src/graph/llm-evaluator.ts` (consumed by story 50-11)
- **Import**: `callLLM`, `LLMCallParams` @ `@substrate-ai/core` (established by Epic 42, story 42-10)
- **Import**: `selectEdge` async variant @ `packages/factory/src/graph/edge-selector.ts` (consumed by `executor.ts` and story 50-11)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
