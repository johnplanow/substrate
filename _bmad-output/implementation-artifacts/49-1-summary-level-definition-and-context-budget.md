# Story 49-1: Summary Level Definition and Context Budget

## Story

As a factory pipeline developer,
I want typed `SummaryLevel`, `Summary`, `ContextBudget`, and `SummaryEngine` interfaces defined in the factory package,
so that downstream summarization stories (49-2 through 49-8) can implement reversible context compression against a stable, shared contract.

## Acceptance Criteria

### AC1: SummaryLevel Type and Token Budget Constants
**Given** `packages/factory/src/context/summary-types.ts`
**When** imported by another TypeScript module
**Then** it exports a `SummaryLevel` const string-union with values `'full' | 'high' | 'medium' | 'low'`, and a `SUMMARY_BUDGET` constant mapping each level to its token-budget fraction: `full = 1.0`, `high = 0.75`, `medium = 0.50`, `low = 0.25`

### AC2: Summary Result Type
**Given** the `Summary` interface
**When** a summarization operation produces a result
**Then** the type requires `level: SummaryLevel`, `content: string`, `originalHash: string` (SHA-256 hex of the original text), `createdAt: string` (ISO-8601 timestamp), and accepts optional `originalTokenCount?: number`, `summaryTokenCount?: number`, and `metadata?: Record<string, unknown>`

### AC3: SummaryEngine Interface — summarize() Method
**Given** the `SummaryEngine` interface
**When** a class implements `summarize(content: string, targetLevel: SummaryLevel, opts?: SummarizeOptions): Promise<Summary>`
**Then** TypeScript accepts the implementation without errors, and `SummarizeOptions` provides optional `modelTokenLimit?: number`, `preserveCodeBlocks?: boolean`, `preserveFilePaths?: boolean`, `preserveErrorMessages?: boolean` fields (all defaulting to `true` in implementations)

### AC4: SummaryEngine Interface — expand() Method
**Given** the `SummaryEngine` interface
**When** a class implements `expand(summary: Summary, targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string>`
**Then** TypeScript accepts the implementation, and `ExpandOptions` provides optional `originalContent?: string` (used when the original is available for lossless expansion) and `metadata?: Record<string, unknown>` fields

### AC5: ContextBudget Type and Budget Calculation Helper
**Given** the `ContextBudget` interface and `computeBudget()` function signature
**When** called with a model token limit and a target `SummaryLevel`
**Then** `ContextBudget` contains `modelTokenLimit: number`, `level: SummaryLevel`, `targetTokenCount: number` (= `modelTokenLimit * SUMMARY_BUDGET[level]`), and `compressionRatio: number` (= `SUMMARY_BUDGET[level]`); the exported `computeBudget(modelTokenLimit: number, level: SummaryLevel): ContextBudget` function returns a correctly populated `ContextBudget` object

### AC6: Barrel Export and TypeScript Compilation
**Given** `packages/factory/src/context/index.ts`
**When** built via `npm run build`
**Then** it re-exports all types and functions from `./summary-types.js` and `./summary-engine.js`, the build produces zero TypeScript errors, and a test file that implements `SummaryEngine` as a class compiles and passes

### AC7: Unit Tests — All Acceptance Criteria Covered
**Given** `packages/factory/src/context/__tests__/summary-types.test.ts`
**When** run via `npm run test:fast`
**Then** at least 14 `it(...)` cases pass, covering: `SUMMARY_BUDGET` values for all four levels, `computeBudget()` correctness for all four levels, `Summary` shape validation, `SummaryEngine` interface satisfiability via a local `MockSummaryEngine` class, and `SummarizeOptions` / `ExpandOptions` optional-field behaviour

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/context/summary-types.ts` — SummaryLevel and budget constants (AC: #1)
  - [ ] Export `SummaryLevel` as a const string-union: `'full' | 'high' | 'medium' | 'low'`
  - [ ] Export `SUMMARY_BUDGET` as a `Record<SummaryLevel, number>` const with values `{ full: 1.0, high: 0.75, medium: 0.50, low: 0.25 }`
  - [ ] Export `DEFAULT_SUMMARY_LEVEL: SummaryLevel = 'medium'` as a named constant
  - [ ] Add JSDoc comments explaining each level and its intended use case

- [ ] Task 2: Define `Summary`, `SummarizeOptions`, and `ExpandOptions` in `summary-types.ts` (AC: #2, #3, #4)
  - [ ] Export `Summary` interface with required fields: `level: SummaryLevel`, `content: string`, `originalHash: string`, `createdAt: string`
  - [ ] Add optional fields to `Summary`: `originalTokenCount?: number`, `summaryTokenCount?: number`, `metadata?: Record<string, unknown>`
  - [ ] Export `SummarizeOptions` interface with optional fields: `modelTokenLimit?: number`, `preserveCodeBlocks?: boolean`, `preserveFilePaths?: boolean`, `preserveErrorMessages?: boolean`
  - [ ] Export `ExpandOptions` interface with optional fields: `originalContent?: string`, `metadata?: Record<string, unknown>`

- [ ] Task 3: Define `ContextBudget` interface and `computeBudget()` function in `summary-types.ts` (AC: #5)
  - [ ] Export `ContextBudget` interface with required fields: `modelTokenLimit: number`, `level: SummaryLevel`, `targetTokenCount: number`, `compressionRatio: number`
  - [ ] Export `computeBudget(modelTokenLimit: number, level: SummaryLevel): ContextBudget` — pure function, no async, no external imports
  - [ ] Implement `computeBudget` body: `const compressionRatio = SUMMARY_BUDGET[level]; return { modelTokenLimit, level, targetTokenCount: Math.floor(modelTokenLimit * compressionRatio), compressionRatio }`

- [ ] Task 4: Create `packages/factory/src/context/summary-engine.ts` — SummaryEngine interface (AC: #3, #4)
  - [ ] Export `SummaryEngine` interface with two methods: `summarize(content: string, targetLevel: SummaryLevel, opts?: SummarizeOptions): Promise<Summary>` and `expand(summary: Summary, targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string>`
  - [ ] Add JSDoc comment on `SummaryEngine` referencing the reversibility contract: expand(summarize(content, level), 'full') must preserve all code blocks, file paths, error messages, and decisions from the original
  - [ ] Add `readonly name: string` property to `SummaryEngine` for traceability in logs and metrics
  - [ ] Zero runtime imports — pure TypeScript interface declarations only

- [ ] Task 5: Create barrel export `packages/factory/src/context/index.ts` (AC: #6)
  - [ ] Re-export everything from `./summary-types.js`
  - [ ] Re-export everything from `./summary-engine.js`
  - [ ] File must contain only re-export lines, no logic

- [ ] Task 6: Write unit tests in `packages/factory/src/context/__tests__/summary-types.test.ts` (AC: #7)
  - [ ] Import all key types and functions using `import type` for interfaces, value imports for `SUMMARY_BUDGET`, `DEFAULT_SUMMARY_LEVEL`, `computeBudget`
  - [ ] **AC1 tests (4 cases):** Assert `SUMMARY_BUDGET['full'] === 1.0`, `SUMMARY_BUDGET['high'] === 0.75`, `SUMMARY_BUDGET['medium'] === 0.50`, `SUMMARY_BUDGET['low'] === 0.25`
  - [ ] **AC2 test (2 cases):** Construct a minimal `Summary` object with all required fields and verify shape via `expect(summary).toMatchObject({...})`; construct a full `Summary` with all optional fields and verify no TypeScript errors
  - [ ] **AC3/AC4 tests (3 cases):** Define a local `MockSummaryEngine` class implementing `SummaryEngine`; verify `engine.name` is a string; verify `await engine.summarize(content, 'medium')` returns a `Summary` with `level === 'medium'`; verify `await engine.expand(summary, 'full')` returns a string
  - [ ] **AC5 tests (4 cases):** Call `computeBudget(100_000, 'full')` and assert `targetTokenCount === 100_000`; call `computeBudget(100_000, 'medium')` and assert `targetTokenCount === 50_000`; call `computeBudget(100_000, 'low')` and assert `targetTokenCount === 25_000`; call `computeBudget(200_000, 'high')` and assert `targetTokenCount === 150_000`
  - [ ] **AC6 test (1 case):** Verify `DEFAULT_SUMMARY_LEVEL === 'medium'`
  - [ ] Ensure at least 14 `it(...)` cases total
  - [ ] Run `npm run build` first to catch TypeScript errors; then run `npm run test:fast` with `timeout: 300000`; NEVER pipe output; confirm "Test Files" summary line in raw output

- [ ] Task 7: Run build and tests to confirm zero errors (AC: #6, #7)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line with zero failures
  - [ ] Verify no test output is piped through `grep`, `head`, `tail`, or any other filter

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { computeBudget } from './summary-types.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `packages/factory/src/context/summary-types.ts` and `summary-engine.ts` must have **zero runtime imports** — no external package imports, no Node builtins. Pure TypeScript interface/type/const declarations only.
- `computeBudget()` is the only runtime function in this story; it must be a pure function (no I/O, no async)
- No Zod schemas in this story — types and interfaces only. Zod validation is added by implementing stories (49-2+) as needed.
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`) — no Jest globals. No `vi.mock()` needed (no runtime side-effects to mock).
- `packages/factory/src/context/` directory does NOT exist yet — dev agent must create it

### New File Paths
```
packages/factory/src/context/summary-types.ts           — SummaryLevel, SUMMARY_BUDGET, Summary, ContextBudget, computeBudget, SummarizeOptions, ExpandOptions
packages/factory/src/context/summary-engine.ts          — SummaryEngine interface (zero runtime imports)
packages/factory/src/context/index.ts                   — barrel export (re-exports from both files)
packages/factory/src/context/__tests__/summary-types.test.ts  — unit tests (≥14 test cases)
```

### Key Type Definitions

```typescript
// packages/factory/src/context/summary-types.ts — no imports required

export type SummaryLevel = 'full' | 'high' | 'medium' | 'low'

export const SUMMARY_BUDGET: Record<SummaryLevel, number> = {
  full: 1.0,
  high: 0.75,
  medium: 0.50,
  low: 0.25,
}

export const DEFAULT_SUMMARY_LEVEL: SummaryLevel = 'medium'

export interface Summary {
  level: SummaryLevel
  content: string
  originalHash: string      // SHA-256 hex of the original content
  createdAt: string         // ISO-8601 timestamp
  originalTokenCount?: number
  summaryTokenCount?: number
  metadata?: Record<string, unknown>
}

export interface SummarizeOptions {
  modelTokenLimit?: number
  preserveCodeBlocks?: boolean    // default true in implementations
  preserveFilePaths?: boolean     // default true in implementations
  preserveErrorMessages?: boolean // default true in implementations
}

export interface ExpandOptions {
  originalContent?: string        // if available, enables lossless expansion
  metadata?: Record<string, unknown>
}

export interface ContextBudget {
  modelTokenLimit: number
  level: SummaryLevel
  targetTokenCount: number   // = Math.floor(modelTokenLimit * SUMMARY_BUDGET[level])
  compressionRatio: number   // = SUMMARY_BUDGET[level]
}

export function computeBudget(modelTokenLimit: number, level: SummaryLevel): ContextBudget {
  const compressionRatio = SUMMARY_BUDGET[level]
  return {
    modelTokenLimit,
    level,
    targetTokenCount: Math.floor(modelTokenLimit * compressionRatio),
    compressionRatio,
  }
}
```

```typescript
// packages/factory/src/context/summary-engine.ts — no imports required
import type { Summary, SummaryLevel, SummarizeOptions, ExpandOptions } from './summary-types.js'

/**
 * Reversible multi-level context summarization engine.
 *
 * Contract: expand(summarize(content, level), 'full') must preserve all
 * code blocks, file paths, error messages, and key decisions from the original.
 *
 * Implementations: LLMSummaryEngine (story 49-2), passthrough mock for tests.
 */
export interface SummaryEngine {
  readonly name: string
  summarize(content: string, targetLevel: SummaryLevel, opts?: SummarizeOptions): Promise<Summary>
  expand(summary: Summary, targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string>
}
```

### Test Pattern

```typescript
// packages/factory/src/context/__tests__/summary-types.test.ts
import { describe, it, expect } from 'vitest'
import type { Summary, SummaryEngine } from '../summary-engine.js'
import {
  SUMMARY_BUDGET,
  DEFAULT_SUMMARY_LEVEL,
  computeBudget,
} from '../summary-types.js'
import type { SummaryLevel, SummarizeOptions, ExpandOptions } from '../summary-types.js'

// MockSummaryEngine implements SummaryEngine — compile-time verification
class MockSummaryEngine implements SummaryEngine {
  readonly name = 'mock'

  async summarize(content: string, targetLevel: SummaryLevel, _opts?: SummarizeOptions): Promise<Summary> {
    return {
      level: targetLevel,
      content: content.slice(0, Math.floor(content.length * SUMMARY_BUDGET[targetLevel])),
      originalHash: 'abc123',
      createdAt: new Date().toISOString(),
    }
  }

  async expand(summary: Summary, _targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string> {
    return opts?.originalContent ?? summary.content
  }
}

describe('SUMMARY_BUDGET', () => {
  it('full level has budget 1.0', () => {
    expect(SUMMARY_BUDGET['full']).toBe(1.0)
  })
  it('high level has budget 0.75', () => {
    expect(SUMMARY_BUDGET['high']).toBe(0.75)
  })
  it('medium level has budget 0.50', () => {
    expect(SUMMARY_BUDGET['medium']).toBe(0.50)
  })
  it('low level has budget 0.25', () => {
    expect(SUMMARY_BUDGET['low']).toBe(0.25)
  })
})

describe('computeBudget', () => {
  it('returns 100% of tokens for full level', () => {
    const budget = computeBudget(100_000, 'full')
    expect(budget.targetTokenCount).toBe(100_000)
    expect(budget.compressionRatio).toBe(1.0)
  })
  // ... additional cases
})
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`
- Tests are primarily compile-time type-correctness verifications with runtime shape assertions
- No `vi.mock()` needed — pure type-level tests using a local `MockSummaryEngine` class
- Run tests with: `npm run test:fast` — use `timeout: 300000` (5 min) in Bash tool; NEVER pipe output
- Confirm results by checking for "Test Files" summary line in raw output
- Also run `npm run build` before tests to catch TypeScript compilation errors early
- Minimum 14 `it(...)` cases required

## Interface Contracts

- **Export**: `SummaryLevel` @ `packages/factory/src/context/summary-types.ts` (consumed by stories 49-2 through 49-8)
- **Export**: `SUMMARY_BUDGET` @ `packages/factory/src/context/summary-types.ts` (consumed by stories 49-3, 49-4, 49-6)
- **Export**: `Summary` @ `packages/factory/src/context/summary-types.ts` (consumed by stories 49-2 through 49-8)
- **Export**: `SummarizeOptions`, `ExpandOptions` @ `packages/factory/src/context/summary-types.ts` (consumed by stories 49-2, 49-3)
- **Export**: `ContextBudget`, `computeBudget` @ `packages/factory/src/context/summary-types.ts` (consumed by stories 49-3, 49-5, 49-6)
- **Export**: `SummaryEngine` @ `packages/factory/src/context/summary-engine.ts` (consumed by stories 49-2, 49-3, 49-4, 49-5, 49-7, 49-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
