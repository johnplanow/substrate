# Story 50-8: Manager Loop Handler (stack.manager_loop)

## Story

As a graph pipeline author,
I want to define a `stack.manager_loop` node that supervises and repeatedly executes a body subgraph,
so that I can implement autonomous refinement cycles with configurable stop conditions and stall-recovery steering within my graph pipelines.

## Acceptance Criteria

### AC1: Manager Loop Handler Executes Body Graph Each Cycle
**Given** a DOT graph containing a node with `type="stack.manager_loop"` and a `graph_file="body.dot"` attribute
**When** the graph executor resolves and invokes the handler
**Then** the handler loads the body graph once, executes it via `createGraphExecutor().run()` each cycle, seeds each cycle with the current parent context snapshot via `initialContext`, and merges `contextUpdates` from the body back into the parent context via `context.applyUpdates()` after each cycle

### AC2: Max Cycles Enforcement Terminates the Loop
**Given** `max_cycles="N"` on the manager loop node (default `10` when the attribute is absent or invalid)
**When** N cycles complete without a stop condition triggering
**Then** the loop exits, `context.set("manager_loop.stop_reason", "max_cycles")` is called, and the handler returns `{ status: "SUCCESS" }`

### AC3: Stop Condition — Context Key Truthiness Exits Early
**Given** `stop_condition="some.context_key"` (no `llm:` prefix) on the manager node
**When** a cycle completes and `context.get("some.context_key")` evaluates to a truthy value
**Then** the loop exits early, `manager_loop.stop_reason` is set to `"stop_condition"` in context, and the handler returns `{ status: "SUCCESS" }` without running further cycles

### AC4: Stop Condition — LLM-Evaluated Condition (llm: prefix)
**Given** `stop_condition="llm: Has the goal been achieved?"` on the manager node and an injectable `llmCall` function provided in options
**When** `evaluateLlmCondition` from `llm-evaluator.ts` returns `true` after a cycle
**Then** the loop exits early with `manager_loop.stop_reason = "stop_condition"`; when no `llmCall` is provided in options, `isLlmCondition` is still detected but the condition always evaluates to `false` so the loop continues

### AC5: Cycle Telemetry Written to Context Each Iteration
**Given** the manager loop executes cycles
**When** each cycle body completes
**Then** `manager_loop.cycle` is set to the current 1-based cycle number before execution, `manager_loop.cycles_completed` holds the count of completed cycles, and `manager_loop.last_outcome` holds the body graph executor's outcome status string (e.g. `"SUCCESS"` or `"FAIL"`) after each cycle

### AC6: Stall Detection Injects Steering Context on Consecutive Non-Success Cycles
**Given** the body graph executor returns a non-`"SUCCESS"` status for 2 or more consecutive cycles (threshold configurable via `options.maxStallCycles`, default `2`)
**When** the handler evaluates the pattern after a cycle completes
**Then** it sets `manager_loop.steering.mode` to `"recovery"` and `manager_loop.steering.hints` to a non-empty array of hint strings in context before the next cycle begins; when a `"SUCCESS"` cycle occurs the consecutive counter resets, `manager_loop.steering.mode` is set to `"normal"`, and `manager_loop.steering.hints` is set to `[]`

### AC7: Unit Tests Cover All Manager Loop Handler Behaviours (≥12 cases)
**Given** `packages/factory/src/handlers/__tests__/manager-loop.test.ts`
**When** `npm run test:fast` executes
**Then** at least 12 `it(...)` cases pass covering: successful single-cycle loop; max_cycles enforcement (runs exactly N times); stop_condition truthy key exits early; stop_condition falsy key continues all cycles; LLM stop_condition with `llmCall` returning `true` exits early; LLM stop_condition with `llmCall` returning `false` continues; LLM stop_condition with no `llmCall` continues; stall detection after 2 consecutive failures injects steering; SUCCESS cycle clears stall state; missing `graph_file` attribute returns FAILURE; body executor non-SUCCESS updates `last_outcome` and loop continues; `createDefaultRegistry()` resolves `stack.manager_loop` type without throwing

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/handlers/manager-loop.ts` — types, options interface, and handler skeleton (AC: #1, #5)
  - [ ] Add imports: `path` from `'node:path'`, `readFile` from `'node:fs/promises'`, `tmpdir` from `'node:os'`, `randomUUID` from `'node:crypto'`
  - [ ] Add imports: `parseGraph` from `'../graph/parser.js'`, `createGraphExecutor` from `'../graph/executor.js'`, `createValidator` from `'../graph/validator.js'`
  - [ ] Add imports: types `GraphNode`, `Graph`, `IGraphContext`, `Outcome` from `'../graph/types.js'`; `NodeHandler`, `IHandlerRegistry` from `'./types.js'`
  - [ ] Add imports: `isLlmCondition`, `evaluateLlmCondition`, `extractLlmQuestion` from `'../graph/llm-evaluator.js'`
  - [ ] Export `interface ManagerLoopHandlerOptions { handlerRegistry: IHandlerRegistry; llmCall?: (prompt: string) => Promise<string>; baseDir?: string; graphFileLoader?: (filePath: string) => Promise<string>; logsRoot?: string; maxStallCycles?: number }` — all fields except `handlerRegistry` are optional
  - [ ] Export `function createManagerLoopHandler(options: ManagerLoopHandlerOptions): NodeHandler` returning an `async (node, context, _graph) => Promise<Outcome>` function

- [ ] Task 2: Implement body graph loading and the main cycle execution loop (AC: #1, #2, #5)
  - [ ] Inside the handler: read `const graphFile = node.attrs?.['graph_file']`; if absent or empty → return `{ status: 'FAILURE', failureReason: \`Manager loop node "${node.id}" is missing required attribute graph_file\` }`
  - [ ] Parse `max_cycles` from `node.attrs?.['max_cycles']`; default to `10`; clamp to `Math.max(1, parseInt(raw, 10))` (NaN → default `10`)
  - [ ] Resolve the body graph file path: `const filePath = path.isAbsolute(graphFile) ? graphFile : path.join(options.baseDir ?? process.cwd(), graphFile)`
  - [ ] Load body graph ONCE before the loop via `options.graphFileLoader ?? ((fp) => readFile(fp, 'utf-8'))`; wrap in try/catch → return FAILURE outcome on error
  - [ ] Parse: `let bodyGraph: Graph; try { bodyGraph = parseGraph(dotSource) } catch (err) { return FAILURE outcome }`
  - [ ] Validate: `try { createValidator().validateOrRaise(bodyGraph) } catch (err) { return FAILURE outcome }`
  - [ ] Implement main `for (let cycle = 1; cycle <= maxCycles; cycle++)` loop
  - [ ] At loop start each cycle: `context.set('manager_loop.cycle', cycle)`
  - [ ] Build body executor config: `{ runId: randomUUID(), logsRoot: options.logsRoot ?? tmpdir(), handlerRegistry: options.handlerRegistry, initialContext: context.snapshot() }` — note: no `checkpointPath`; body always executes fresh
  - [ ] Execute: `const bodyOutcome = await createGraphExecutor().run(bodyGraph, bodyConfig)`
  - [ ] Merge body updates into parent: `if (bodyOutcome.contextUpdates) { context.applyUpdates(bodyOutcome.contextUpdates) }`
  - [ ] Update telemetry: `context.set('manager_loop.cycles_completed', cycle)` and `context.set('manager_loop.last_outcome', bodyOutcome.status)`
  - [ ] After the loop: `context.set('manager_loop.stop_reason', 'max_cycles')` and `return { status: 'SUCCESS' }`

- [ ] Task 3: Implement stop condition evaluation — context key and LLM-evaluated paths (AC: #3, #4)
  - [ ] Read `const stopCondition = node.attrs?.['stop_condition']`; if absent, skip evaluation each cycle
  - [ ] After telemetry update each cycle, evaluate stop condition: if `isLlmCondition(stopCondition)`, extract the question with `extractLlmQuestion(stopCondition)`, then call `evaluateLlmCondition(question, context.snapshot(), options.llmCall!)` — guard: if `options.llmCall` is undefined, skip the LLM call and treat result as `false`
  - [ ] Otherwise (no `llm:` prefix): `const shouldStop = Boolean(context.get(stopCondition))`
  - [ ] If stop condition is true: `context.set('manager_loop.stop_reason', 'stop_condition')`, then `return { status: 'SUCCESS' }`
  - [ ] Stop condition is evaluated AFTER stall detection so steering hints are available for the terminal cycle log

- [ ] Task 4: Implement stall detection and steering injection (AC: #6)
  - [ ] Declare `let consecutiveFailures = 0` before the loop
  - [ ] After updating `manager_loop.last_outcome` each cycle: if `bodyOutcome.status === 'SUCCESS'`, reset `consecutiveFailures = 0`, set `manager_loop.steering.mode = "normal"` and `manager_loop.steering.hints = []`
  - [ ] Otherwise: `consecutiveFailures++`; if `consecutiveFailures >= (options.maxStallCycles ?? 2)`, set `manager_loop.steering.mode = "recovery"` and `manager_loop.steering.hints = [\`Previous ${consecutiveFailures} attempts returned ${bodyOutcome.status}. Consider a different strategy.\`, 'Review context state and adjust approach before retrying.']`
  - [ ] Stall injection happens BEFORE stop condition evaluation in each cycle iteration

- [ ] Task 5: Register handler in default registry and export (AC: #1, #7)
  - [ ] In `packages/factory/src/handlers/registry.ts`: add `import { createManagerLoopHandler } from './manager-loop.js'`
  - [ ] Extend `DefaultRegistryOptions` to add `llmCall?: (prompt: string) => Promise<string>` — this field is passed through to the manager loop handler for LLM-evaluated stop conditions
  - [ ] Inside `createDefaultRegistry()`, after the subgraph registration add: `// Story 50-8: manager loop handler` then `registry.register('stack.manager_loop', createManagerLoopHandler({ handlerRegistry: registry, baseDir: options?.baseDir ?? process.cwd(), llmCall: options?.llmCall }))`
  - [ ] In `packages/factory/src/handlers/index.ts`: add `export { createManagerLoopHandler } from './manager-loop.js'` and `export type { ManagerLoopHandlerOptions } from './manager-loop.js'`
  - [ ] In `packages/factory/src/handlers/index.ts`: re-export the updated `DefaultRegistryOptions` type from `'./registry.js'` (should already be exported; verify it includes the new `llmCall` field)

- [ ] Task 6: Write unit tests in `packages/factory/src/handlers/__tests__/manager-loop.test.ts` (AC: #1–#7)
  - [ ] Use `vi.mock('../graph/parser.js')`, `vi.mock('../graph/executor.js')`, `vi.mock('../graph/validator.js')` at the top of the test file; inject `graphFileLoader` via options for file-loading tests
  - [ ] Helper: `makeCtx(snapshot?: Record<string, unknown>): IGraphContext` — builds a `GraphContext` from snapshot using the real `GraphContext` class or a lightweight in-memory mock
  - [ ] Helper: `makeNode(attrs?: Record<string, string>): GraphNode` — minimal node with `type='stack.manager_loop'`, `id='manager_loop_1'`, and provided attrs
  - [ ] Helper: `makeOptions(overrides?: Partial<ManagerLoopHandlerOptions>): ManagerLoopHandlerOptions` — creates default options with a mock `handlerRegistry` and stub `graphFileLoader`
  - [ ] Test (AC1): single cycle, executor returns SUCCESS → body executes once, `cycles_completed = 1`
  - [ ] Test (AC2): `max_cycles="3"` → body executes exactly 3 times, `stop_reason = "max_cycles"` in context
  - [ ] Test (AC3): `stop_condition="done"`, context key `done` set to `true` by body → loop exits after that cycle, `stop_reason = "stop_condition"`
  - [ ] Test (AC3 negative): `stop_condition="done"`, context key never set → loop runs all cycles, `stop_reason = "max_cycles"`
  - [ ] Test (AC4): `stop_condition="llm: Is done?"`, `llmCall` mock returns `"yes"` → `evaluateLlmCondition` returns `true`, loop exits early
  - [ ] Test (AC4): `stop_condition="llm: Is done?"`, `llmCall` returns `"no"` → loop continues all cycles
  - [ ] Test (AC4 no llmCall): `stop_condition="llm: Is done?"`, no `llmCall` provided → loop runs all cycles (LLM condition treated as false)
  - [ ] Test (AC5): after cycle 2 → `manager_loop.cycle = 2`, `manager_loop.cycles_completed = 2`, `manager_loop.last_outcome` matches executor status
  - [ ] Test (AC6): 2 consecutive FAILURE cycles → `manager_loop.steering.mode = "recovery"`, `manager_loop.steering.hints` is non-empty array
  - [ ] Test (AC6 reset): FAILURE then SUCCESS → `manager_loop.steering.mode = "normal"`, `manager_loop.steering.hints = []`
  - [ ] Test: missing `graph_file` attribute → returns `{ status: 'FAILURE' }` with descriptive `failureReason`
  - [ ] Test: `createDefaultRegistry()` → `registry.resolve({ type: 'stack.manager_loop', ...minimalNode })` does not throw (verifies registration)
  - [ ] Run `npm run build` before running tests; then `npm run test:fast` with `timeout: 300000`; NEVER pipe output; confirm "Test Files" summary line

- [ ] Task 7: Build and full test verification (AC: all)
  - [ ] Run `npm run build` — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — confirm "Test Files" summary line with zero failures
  - [ ] Grep all `createDefaultRegistry` call sites: `grep -rn "createDefaultRegistry" packages/ src/` — verify no breakage from the `DefaultRegistryOptions.llmCall` addition (all existing callers pass `CodergenHandlerOptions`-compatible objects; the new field is optional, so no changes needed at call sites)

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): e.g. `import { parseGraph } from '../graph/parser.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `manager-loop.ts` may import Node.js built-ins (`node:fs/promises`, `node:path`, `node:os`, `node:crypto`) — available in Node.js 18+
- Body graph is loaded ONCE before the loop (not re-read each cycle) — this is the same pattern used in the subgraph handler and is consistent with the assumption that the body graph definition does not change during execution
- Body executor is invoked with NO `checkpointPath` — each cycle always executes fresh; resumable cycles are out of scope for this story
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming

### New File Paths
```
packages/factory/src/handlers/manager-loop.ts                          — ManagerLoopHandlerOptions, createManagerLoopHandler
packages/factory/src/handlers/__tests__/manager-loop.test.ts           — unit tests (≥12 test cases)
```

### Modified File Paths
```
packages/factory/src/handlers/registry.ts   — extend DefaultRegistryOptions with llmCall?, register 'stack.manager_loop' type
packages/factory/src/handlers/index.ts      — add barrel exports for manager-loop + updated DefaultRegistryOptions
```

### Key Type Definitions

```typescript
// packages/factory/src/handlers/manager-loop.ts

import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { parseGraph } from '../graph/parser.js'
import { createGraphExecutor } from '../graph/executor.js'
import { createValidator } from '../graph/validator.js'
import type { GraphNode, Graph, IGraphContext, Outcome } from '../graph/types.js'
import type { NodeHandler, IHandlerRegistry } from './types.js'
import { isLlmCondition, evaluateLlmCondition, extractLlmQuestion } from '../graph/llm-evaluator.js'

export interface ManagerLoopHandlerOptions {
  /** Registry used to resolve node handlers inside the body graph each cycle. */
  handlerRegistry: IHandlerRegistry
  /**
   * Injectable LLM call function for `llm:` prefix stop conditions.
   * When absent, LLM stop conditions always evaluate to `false`.
   */
  llmCall?: (prompt: string) => Promise<string>
  /** Base directory for resolving relative graph_file paths. Default: process.cwd() */
  baseDir?: string
  /**
   * Injectable file loader for testability.
   * Defaults to `(fp) => readFile(fp, 'utf-8')`.
   */
  graphFileLoader?: (filePath: string) => Promise<string>
  /**
   * Root directory for body executor checkpoint/log files.
   * Defaults to `os.tmpdir()`.
   */
  logsRoot?: string
  /**
   * Number of consecutive non-SUCCESS cycles before steering is injected.
   * Default: 2.
   */
  maxStallCycles?: number
}
```

### Context Keys Written by manager-loop Handler

| Key | Type | Description |
|-----|------|-------------|
| `manager_loop.cycle` | `number` | Current 1-based cycle number (set at start of each cycle) |
| `manager_loop.cycles_completed` | `number` | Total cycles completed so far (set after each cycle) |
| `manager_loop.last_outcome` | `string` | Body executor outcome status from the most recent cycle |
| `manager_loop.stop_reason` | `string` | Why the loop terminated: `"max_cycles"` or `"stop_condition"` |
| `manager_loop.steering.mode` | `string` | `"normal"` or `"recovery"` (set when stall detected or cleared) |
| `manager_loop.steering.hints` | `string[]` | Hint strings for child nodes to read in subsequent cycles |

### Registry Extension Pattern

```typescript
// packages/factory/src/handlers/registry.ts — additions

import { createManagerLoopHandler } from './manager-loop.js'

export interface DefaultRegistryOptions extends CodergenHandlerOptions {
  /** Base directory for resolving relative graph_file paths. Default: process.cwd() */
  baseDir?: string
  /**
   * Injectable LLM call for manager loop's llm:-prefixed stop conditions.
   * Passed through to createManagerLoopHandler.
   */
  llmCall?: (prompt: string) => Promise<string>
}

export function createDefaultRegistry(options?: DefaultRegistryOptions): HandlerRegistry {
  // ... existing registrations ...
  // Story 50-8: manager loop handler
  registry.register('stack.manager_loop', createManagerLoopHandler({
    handlerRegistry: registry,
    baseDir: options?.baseDir ?? process.cwd(),
    llmCall: options?.llmCall,
  }))
  // ...
}
```

### Cycle Execution Sequence (per-cycle ordering)

Each cycle follows this strict order to ensure telemetry, stall detection, and stop condition evaluation are consistent:

1. `context.set('manager_loop.cycle', cycle)` — update current cycle number
2. Execute body graph: `createGraphExecutor().run(bodyGraph, bodyConfig)`
3. `context.applyUpdates(bodyOutcome.contextUpdates ?? {})` — merge body outputs
4. `context.set('manager_loop.cycles_completed', cycle)` — record completion
5. `context.set('manager_loop.last_outcome', bodyOutcome.status)` — record outcome
6. Stall detection: update `consecutiveFailures`, inject or clear steering hints
7. Stop condition evaluation: check `stop_condition` attribute, exit if true
8. Continue to next cycle (or exit after final cycle)

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- Mock `createGraphExecutor` via `vi.mock('../graph/executor.js')` to control body executor behavior per test
- Mock `parseGraph` via `vi.mock('../graph/parser.js')` to avoid real DOT parsing in unit tests
- Inject `graphFileLoader` via `ManagerLoopHandlerOptions` to avoid real filesystem access in tests
- Build first: `npm run build` — confirm zero TypeScript errors before running tests
- Run tests: `npm run test:fast` with `timeout: 300000` (5 min); NEVER pipe output; confirm "Test Files" summary line

### Important: `DefaultRegistryOptions` backward compatibility
Before modifying `registry.ts`, verify call sites:
```bash
grep -rn "createDefaultRegistry" packages/ src/
```
All existing callers pass either no argument or a `CodergenHandlerOptions`-compatible object. Since the new `llmCall` field is optional, no call site changes are needed.

### Relationship to Epic 45 (Convergence Loop) and Epic 41 (Supervisor Module)
The `stack.manager_loop` handler implements the graph-primitive analogue of the convergence loop from Epic 45. It does NOT import from `@substrate-ai/core/supervisor` directly — the stall detection and steering injection are self-contained heuristics within the handler. The dependency on story 41-7 is structural: the supervisor module must be available in `@substrate-ai/core` as the authoritative supervisor pattern that the manager loop mirrors at the graph level. Future enhancement can inject supervisor analysis functions via `ManagerLoopHandlerOptions` to leverage `analyzeTokenEfficiency` and `generateRecommendations` from `packages/core/src/supervisor/analysis.ts`.

## Interface Contracts

- **Export**: `createManagerLoopHandler` @ `packages/factory/src/handlers/manager-loop.ts` (consumed by story 50-11)
- **Export**: `ManagerLoopHandlerOptions` @ `packages/factory/src/handlers/manager-loop.ts` (consumed by story 50-11)
- **Export**: updated `DefaultRegistryOptions` (with `llmCall?`) @ `packages/factory/src/handlers/registry.ts` (consumed by stories 50-10, 50-11)
- **Import**: `isLlmCondition`, `evaluateLlmCondition`, `extractLlmQuestion` @ `packages/factory/src/graph/llm-evaluator.ts` (established by story 50-4)
- **Import**: `parseGraph` @ `packages/factory/src/graph/parser.ts` (established by story 42-1)
- **Import**: `createGraphExecutor`, `GraphExecutorConfig` @ `packages/factory/src/graph/executor.ts` (established by story 42-14)
- **Import**: `createValidator` @ `packages/factory/src/graph/validator.ts` (established by stories 42-4, 42-5)
- **Import**: `IHandlerRegistry`, `NodeHandler` @ `packages/factory/src/handlers/types.ts` (established by story 42-9)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
