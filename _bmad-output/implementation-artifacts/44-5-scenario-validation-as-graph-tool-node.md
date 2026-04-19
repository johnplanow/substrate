# Story 44-5: Scenario Validation as Graph Tool Node

## Story

As a factory graph executor,
I want a `tool` node that runs scenario validation and writes a satisfaction score to context,
so that downstream conditional nodes can route to exit (score meets threshold) or retry (score below threshold).

## Acceptance Criteria

### AC1: `substrate scenarios run --format json` outputs ScenarioRunResult JSON
**Given** `.substrate/scenarios/` contains one or more scenario files
**When** `substrate scenarios run --format json` is invoked from the project root
**Then** it discovers all scenario files, executes them via `ScenarioRunner`, and writes a JSON-serialized `ScenarioRunResult` to stdout with exit code 0

### AC2: Tool handler detects ScenarioRunResult JSON in stdout via duck-typing
**Given** a `type="tool"` node whose command produces valid `ScenarioRunResult` JSON on stdout
**When** the tool handler executes the command and captures stdout
**Then** it detects the JSON as a `ScenarioRunResult` via duck-typing on `summary.total` and `summary.passed` — not by inspecting the command string — and proceeds to score computation

### AC3: Satisfaction score computed and written to context on successful run
**Given** a scenario tool node where 3 of 4 scenarios pass (JSON: `summary: {total:4, passed:3, failed:1}`)
**When** the tool handler completes execution
**Then** `context.satisfaction_score` is `0.75`, `Outcome.status` is `SUCCESS`, and no `{node.id}.output` key is set (scenario path, not default path)

### AC4: Zero passing scenarios writes 0.0 to context with SUCCESS outcome
**Given** a scenario tool node where all scenarios fail (JSON: `summary: {total:2, passed:0, failed:2}`)
**When** the tool handler completes execution
**Then** `context.satisfaction_score` is `0.0` and `Outcome.status` is `SUCCESS` so that the downstream conditional node can evaluate the score and route to retry

### AC5: Numeric comparison operators (`>=`, `<=`, `>`, `<`) supported in edge conditions
**Given** a conditional edge with condition `satisfaction_score>=0.8`
**When** `context.satisfaction_score` is `0.9` (stored as a Number in GraphContext)
**Then** the condition evaluates to `true` and the edge is selected

### AC6: Score below threshold routes to the unlabelled retry edge
**Given** a graph with edges labelled `satisfaction_score>=0.8` (to exit) and unlabelled (to retry)
**When** `context.satisfaction_score` is `0.6`
**Then** the `>=0.8` condition evaluates to `false` and the unlabelled edge to retry is selected

### AC7: Scorer and CLI command exported from factory package public API
**Given** a consumer imports from `@substrate-ai/factory`
**When** they access `computeSatisfactionScore`
**Then** it accepts a `ScenarioRunResult` and an optional threshold, returning `{ score: number; passes: boolean; threshold: number }`

## Tasks / Subtasks

- [ ] Task 1: Create `substrate scenarios run` CLI subcommand (AC: #1)
  - [ ] Create `packages/factory/src/scenarios/cli-command.ts`
  - [ ] Import `ScenarioStore` from `./store.js` and `createScenarioRunner` from `./runner.js`
  - [ ] Export `registerScenariosCommand(program: Command): void` using `commander`
  - [ ] Implement `scenarios run --format <format>` action: call `store.discover()`, then `runner.run(manifest, process.cwd())`, and `console.log(JSON.stringify(results))` when `--format json`; print human-readable summary otherwise
  - [ ] Locate the factory CLI entry point (search for `commander` `new Command()` or `program.command(...)` in `packages/factory/src/`) and register `registerScenariosCommand(program)`
  - [ ] Export `registerScenariosCommand` from `packages/factory/src/scenarios/index.ts`

- [ ] Task 2: Create `SatisfactionScorer` utility (AC: #3, #4, #7)
  - [ ] Create `packages/factory/src/scenarios/scorer.ts`
  - [ ] Export type: `export interface SatisfactionScore { score: number; passes: boolean; threshold: number }`
  - [ ] Export function: `export function computeSatisfactionScore(result: ScenarioRunResult, threshold = 0.8): SatisfactionScore`
  - [ ] Implement: `const { total, passed } = result.summary; const score = total === 0 ? 0 : passed / total; return { score, passes: score >= threshold, threshold }`
  - [ ] Import `ScenarioRunResult` from `../events.js` (not redefined — reuse existing type)
  - [ ] Add `computeSatisfactionScore` and `SatisfactionScore` exports to `packages/factory/src/scenarios/index.ts`

- [ ] Task 3: Extend tool handler to parse and score scenario results (AC: #2, #3, #4)
  - [ ] Open `packages/factory/src/handlers/tool.ts`
  - [ ] Add imports: `import { computeSatisfactionScore } from '../scenarios/scorer.js'` and `import type { ScenarioRunResult } from '../events.js'`
  - [ ] Add `isScenarioRunResult(parsed: unknown): parsed is ScenarioRunResult` duck-typing guard (see Dev Notes)
  - [ ] On exit code 0: attempt `JSON.parse(stdoutBuf.trim())`; if `isScenarioRunResult(parsed)`, call `computeSatisfactionScore(parsed)` and return `{ status: 'SUCCESS', contextUpdates: { satisfaction_score: result.score } }`
  - [ ] If stdout is non-JSON or fails the duck-type check, fall through to original behavior: `contextUpdates: { [\`${node.id}.output\`]: stdoutBuf.trim() }`
  - [ ] On non-zero exit code, existing FAILURE behavior is unchanged

- [ ] Task 4: Extend condition parser/evaluator with numeric comparison operators (AC: #5, #6)
  - [ ] Locate condition expression source — search for `ConditionClause` definition, likely `packages/factory/src/graph/condition.ts`
  - [ ] Extend `ConditionClause.op` union type: add `'>='`, `'<='`, `'>'`, `'<'`
  - [ ] Extend parser: tokenize two-character operators (`>=`, `<=`) BEFORE single-character (`>`, `<`, `=`, `!=`) to avoid misparsing
  - [ ] Extend evaluator: for `>=`/`<=`/`>`/`<`, read `context.getNumber(key)` and compare with `parseFloat(value)`; `=` and `!=` retain existing string-equality behavior (no behavior change for existing tests)
  - [ ] Update `types.ts` if `ConditionClause` is defined there instead of `condition.ts`

- [ ] Task 5: Export new components from factory public barrel (AC: #7)
  - [ ] Add `computeSatisfactionScore` and `SatisfactionScore` to `packages/factory/src/index.ts` top-level re-exports (search existing barrel for pattern to follow)

- [ ] Task 6: Write unit and integration tests (AC: #1–#7)
  - [ ] Create `packages/factory/src/scenarios/__tests__/scorer.test.ts`:
    - Test 0 scenarios → score 0.0, `passes: false`
    - Test 3/4 pass → score 0.75, `passes: false` (below 0.8 threshold)
    - Test 4/4 pass → score 1.0, `passes: true`
    - Test 0/2 pass → score 0.0, `passes: false`
    - Test custom threshold: 3/4 pass, threshold 0.7 → `passes: true`
  - [ ] Create `packages/factory/src/handlers/__tests__/tool-scenario.test.ts` using `vi.mock('child_process', ...)`:
    - Mock process emitting JSON `ScenarioRunResult` stdout, exit code 0 → assert `contextUpdates.satisfaction_score === 0.75`, no `{node.id}.output`
    - Mock process emitting non-JSON stdout, exit code 0 → assert `contextUpdates[\`${node.id}.output\`]` is set, no `satisfaction_score`
    - Mock process emitting 0/2 scenario JSON → assert `satisfaction_score === 0` and status `SUCCESS`
    - Mock process with non-zero exit code → assert FAILURE outcome (existing behavior unchanged)
  - [ ] Extend condition evaluator test file with `>=`, `<=`, `>`, `<` cases against numeric context values

- [ ] Task 7: Build and validate (AC: #1–#7)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass, no regressions in existing suite
  - [ ] Confirm `computeSatisfactionScore` is importable from `@substrate-ai/factory`
  - [ ] Confirm `satisfaction_score>=0.8` edge condition parses and evaluates correctly with a numeric `0.9` context value

## Dev Notes

### Architecture Constraints

- **New files:**
  - `packages/factory/src/scenarios/cli-command.ts` — `substrate scenarios run` CLI subcommand
  - `packages/factory/src/scenarios/scorer.ts` — satisfaction scorer utility
  - `packages/factory/src/scenarios/__tests__/scorer.test.ts` — scorer unit tests
  - `packages/factory/src/handlers/__tests__/tool-scenario.test.ts` — tool handler scenario parsing tests

- **Modified files:**
  - `packages/factory/src/handlers/tool.ts` — JSON detection + satisfaction score logic
  - `packages/factory/src/graph/condition.ts` (or equivalent) — numeric comparison operators
  - `packages/factory/src/scenarios/index.ts` — add scorer, CLI command, and `SatisfactionScore` exports
  - `packages/factory/src/index.ts` — top-level barrel additions

- **Import style:** All relative imports within factory package use `.js` extensions (ESM). Example: `import { computeSatisfactionScore } from '../scenarios/scorer.js'`

- **Do NOT couple the tool handler to specific command names:** Detection uses duck-typing on the JSON shape, not the value of `node.toolCommand`. This keeps the handler generic and reusable for any command that emits `ScenarioRunResult`-shaped JSON.

### ScenarioRunResult Duck-Typing Guard

```typescript
import type { ScenarioRunResult } from '../events.js'

function isScenarioRunResult(parsed: unknown): parsed is ScenarioRunResult {
  if (typeof parsed !== 'object' || parsed === null) return false
  const p = parsed as Record<string, unknown>
  const summary = p['summary'] as Record<string, unknown> | undefined
  return (
    typeof summary?.['total'] === 'number' &&
    typeof summary?.['passed'] === 'number'
  )
}
```

### Satisfaction Score Computation

```typescript
// packages/factory/src/scenarios/scorer.ts
import type { ScenarioRunResult } from '../events.js'

export interface SatisfactionScore {
  score: number      // 0.0 to 1.0
  passes: boolean    // score >= threshold
  threshold: number  // configured threshold (default 0.8)
}

export function computeSatisfactionScore(
  result: ScenarioRunResult,
  threshold = 0.8,
): SatisfactionScore {
  const { total, passed } = result.summary
  const score = total === 0 ? 0 : passed / total
  return { score, passes: score >= threshold, threshold }
}
```

### Tool Handler Extension Pattern

The tool handler in `tool.ts` currently stores trimmed stdout as `{node.id}.output`. Extend the exit-code-0 branch as follows:

```typescript
child.on('close', (code: number | null) => {
  if (code === 0) {
    let parsed: unknown
    try { parsed = JSON.parse(stdoutBuf.trim()) } catch { /* not JSON */ }

    if (isScenarioRunResult(parsed)) {
      const scored = computeSatisfactionScore(parsed)
      resolve({
        status: 'SUCCESS',
        contextUpdates: { satisfaction_score: scored.score },
      })
    } else {
      resolve({
        status: 'SUCCESS',
        contextUpdates: { [`${node.id}.output`]: stdoutBuf.trim() },
      })
    }
  } else {
    resolve({
      status: 'FAILURE',
      failureReason: stderrBuf.trim() || `Command exited with code ${code}`,
    })
  }
})
```

### Numeric Condition Operator Extension

Locate `ConditionClause` (likely `packages/factory/src/graph/condition.ts` or `types.ts`). Extend the `op` union:

```typescript
// Before:
op: '=' | '!='
// After:
op: '=' | '!=' | '>=' | '<=' | '>' | '<'
```

In the parser, match two-character operators first to avoid ambiguity:

```typescript
// Check in order: >=, <=, >, <, !=, =
const TWO_CHAR_OPS = ['>=', '<=', '!='] as const
const ONE_CHAR_OPS = ['>', '<', '='] as const
```

In the condition evaluator, add numeric cases:

```typescript
case '>=': return context.getNumber(key) >= parseFloat(value)
case '<=': return context.getNumber(key) <= parseFloat(value)
case '>':  return context.getNumber(key) >  parseFloat(value)
case '<':  return context.getNumber(key) <  parseFloat(value)
// = and != retain existing string-equality behavior — no change
```

### CLI Subcommand Registration

Find the factory CLI entry point by searching for `new Command()` or `program.command(` in `packages/factory/src/`. Register the scenarios subcommand there:

```typescript
import { registerScenariosCommand } from './scenarios/index.js'
// ...
registerScenariosCommand(program)
```

### Context Key Convention

The key written to `GraphContext` is the string literal `'satisfaction_score'` (no prefix, no dot notation). The conditional edge condition `satisfaction_score>=0.8` uses this exact key. Downstream stories (44-10, 45-1) read this key by name.

### DOT Graph Node Example

A correctly wired scenario validation node in a factory graph:

```dot
validate [shape=parallelogram, type="tool",
          tool_command="substrate scenarios run --format json",
          label="Validate against holdout scenarios"]
```

A downstream conditional edge:

```dot
validate -> exit [label="satisfaction_score>=0.8"]
validate -> implement [label="retry"]
```

### Testing Requirements

- **Framework:** Vitest (`import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`)
- **child_process mock:** `vi.mock('child_process', () => ({ spawn: vi.fn() }))` with a `createMockProcess({ stdout, stderr, exitCode })` helper that emits `data` events and fires `close` via `setImmediate`
- **ScenarioRunResult stub:** `{ scenarios: [], summary: { total: 4, passed: 3, failed: 1 }, durationMs: 10 }`
- **IGraphContext mock for condition tests:** implement `getNumber(key)` returning test values
- **Run tests:** `npm run test:fast` — look for `Test Files` summary line; never pipe output through `head`/`tail`/`grep`
- **Minimum:** 5 scorer tests, 4 tool handler scenario tests, 4 condition evaluator tests — all passing; no regressions in existing suite

### Dependency Notes

- **Depends on:** 44-1 (`ScenarioStore` — already implemented in `store.ts`)
- **Depends on:** 44-2 (`createScenarioRunner`, `ScenarioRunResult` — already implemented in `runner.ts`)
- **Depends on:** 44-4 (Integrity verification infrastructure — already implemented in executor)
- **Depends on:** 42-6 (Condition evaluator — being extended here with numeric operators)
- **Unblocks:** 44-6 (Factory schema — `scenario_results` table stores scorer output)
- **Unblocks:** 44-8 (`substrate factory scenarios` CLI — builds on the `scenarios run` subcommand)
- **Unblocks:** 44-10 (Integration test — tests end-to-end scenario validation flow)
- **Unblocks:** 45-1 (Goal gate — reads `satisfaction_score` from context to determine convergence)

## Interface Contracts

- **Export**: `computeSatisfactionScore(result: ScenarioRunResult, threshold?: number): SatisfactionScore` @ `packages/factory/src/scenarios/scorer.ts` (consumed by stories 44-10, 45-1)
- **Export**: `SatisfactionScore` type @ `packages/factory/src/scenarios/scorer.ts` (consumed by stories 44-6, 45-1)
- **Export**: `registerScenariosCommand(program: Command): void` @ `packages/factory/src/scenarios/cli-command.ts` (consumed by factory CLI entry point)
- **Import**: `ScenarioRunResult` @ `packages/factory/src/events.ts` (from story 44-2, already defined)
- **Import**: `ScenarioStore` @ `packages/factory/src/scenarios/store.ts` (from story 44-1)
- **Import**: `createScenarioRunner` @ `packages/factory/src/scenarios/runner.ts` (from story 44-2)
- **Context key**: `'satisfaction_score'` — written by tool handler, read by conditional edge evaluator and story 45-1

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 44, Phase B — Scenario Store + Runner
