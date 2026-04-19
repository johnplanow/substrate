# Story 49-3: Automatic Summary Triggers in Convergence Loops

## Story

As a factory pipeline operator,
I want the convergence loop to automatically compress older iterations' context when approaching the model's token limit,
so that long-running convergence sessions (10+ iterations) complete without context overflow.

## Acceptance Criteria

### AC1: AutoSummarizerConfig, IterationContext, and CompressionResult Types
**Given** `packages/factory/src/context/auto-summarizer.ts`
**When** imported by another TypeScript module
**Then** it exports `AutoSummarizerConfig` interface with `threshold?: number` (default 0.8, valid range [0.5, 0.95]) and `targetLevel?: SummaryLevel` (default 'medium'); `IterationContext` interface with `index: number`, `content: string`, and optional `tokenEstimate?: number`; `CompressedIterationContext` interface with `index: number`, `summary: Summary`, and `compressed: true` discriminant literal; and `CompressionResult` interface with `iterations: (IterationContext | CompressedIterationContext)[]` and `compressedIndices: number[]`

### AC2: Token Estimation Helper
**Given** the exported `estimateTokens(text: string): number` function
**When** called with any string
**Then** it returns `Math.ceil(text.length / 4)` as a token count approximation, and returns `0` for an empty string or falsy input

### AC3: Threshold Detection — shouldTrigger()
**Given** an `AutoSummarizer` instance configured with `modelTokenLimit` and `threshold`
**When** `shouldTrigger(iterations: IterationContext[]): boolean` is called
**Then** it returns `true` when the sum of `iter.tokenEstimate ?? estimateTokens(iter.content)` across all iterations is **strictly greater than** `threshold * modelTokenLimit`, returns `false` when the total is at or below the threshold, and uses a cached `tokenEstimate` when present to avoid recomputation

### AC4: Selective Compression — compress() Method
**Given** an `AutoSummarizer` instance
**When** `compress(iterations: IterationContext[], currentIndex: number): Promise<CompressionResult>` is called
**Then** every iteration with `index < currentIndex` is summarized to `targetLevel` via the injected `SummaryEngine` and replaced with a `CompressedIterationContext`; the iteration at `currentIndex` is **never** compressed and passes through unchanged; and the returned `CompressionResult` contains the updated `iterations` array and a `compressedIndices` array listing every index that was compressed

### AC5: Invalid Config Validation
**Given** `AutoSummarizer` constructor called with a `threshold` value outside the range [0.5, 0.95]
**When** the constructor executes
**Then** it throws `RangeError: context_summarize_threshold must be between 0.5 and 0.95`; threshold values exactly at `0.5` and `0.95` are accepted without error; default threshold of `0.8` (when `config.threshold` is `undefined`) is accepted without error

### AC6: Convergence Controller Integration
**Given** `packages/factory/src/convergence/controller.ts`
**When** a `ConvergenceController` is constructed with an optional `autoSummarizer?: AutoSummarizer` in its config
**Then** before each iteration is dispatched, the controller calls `shouldTrigger()` on the accumulated `IterationContext[]`; if triggered, it calls `compress()` with the current iteration index and replaces stored iteration contexts with the compression result's `iterations`; and the integration is purely opt-in — omitting `autoSummarizer` from config leaves existing controller behavior unchanged

### AC7: Unit Tests — Threshold, Compression, and Current-Iteration Safety
**Given** `packages/factory/src/context/__tests__/auto-summarizer.test.ts`
**When** run via `npm run test:fast`
**Then** at least 14 `it(...)` cases pass, covering: `estimateTokens` for empty, short, and long strings; `shouldTrigger` returning false below threshold, false at exactly threshold, and true above threshold; `compress` preserving current iteration unmodified; `compress` producing `CompressedIterationContext` with `compressed: true` for previous iterations; `compress` populating `compressedIndices` correctly; `CompressionResult` shape validation; `RangeError` thrown for threshold `< 0.5` and `> 0.95`; and boundary values `0.5` and `0.95` accepted without error

## Tasks / Subtasks

- [ ] Task 1: Define types in `packages/factory/src/context/auto-summarizer.ts` (AC: #1)
  - [ ] Export `AutoSummarizerConfig` interface with `threshold?: number` and `targetLevel?: SummaryLevel`; add JSDoc noting valid range [0.5, 0.95] and defaults
  - [ ] Export `IterationContext` interface with `index: number`, `content: string`, `tokenEstimate?: number`; add JSDoc noting token estimate is auto-computed from content if absent
  - [ ] Export `CompressedIterationContext` interface with `index: number`, `summary: Summary`, `compressed: true`; the `compressed: true` literal discriminant enables TypeScript type narrowing
  - [ ] Export `CompressionResult` interface with `iterations: (IterationContext | CompressedIterationContext)[]` and `compressedIndices: number[]`
  - [ ] Import types using `.js` extensions: `import type { SummaryEngine } from './summary-engine.js'` and `import type { Summary, SummaryLevel } from './summary-types.js'`

- [ ] Task 2: Implement `estimateTokens()` and `AutoSummarizer` constructor with validation (AC: #2, #5)
  - [ ] Export `estimateTokens(text: string): number` — returns `0` for falsy input, otherwise `Math.ceil(text.length / 4)`
  - [ ] Implement `AutoSummarizer` class with constructor `(engine: SummaryEngine, modelTokenLimit: number, config?: AutoSummarizerConfig)`
  - [ ] Apply defaults: `const threshold = config?.threshold ?? 0.8` and `const targetLevel = config?.targetLevel ?? 'medium'`
  - [ ] Validate threshold: `if (threshold < 0.5 || threshold > 0.95) throw new RangeError('context_summarize_threshold must be between 0.5 and 0.95')`
  - [ ] Store `engine`, `modelTokenLimit`, `threshold`, `targetLevel` as `private readonly` fields

- [ ] Task 3: Implement `shouldTrigger()` method (AC: #3)
  - [ ] Accept `iterations: IterationContext[]`; return `boolean`
  - [ ] Compute `totalTokens` by summing `iter.tokenEstimate ?? estimateTokens(iter.content)` for each iteration
  - [ ] Return `totalTokens > this.threshold * this.modelTokenLimit` (strict greater-than, not ≥)

- [ ] Task 4: Implement `compress()` method (AC: #4)
  - [ ] Accept `iterations: IterationContext[]` and `currentIndex: number`; return `Promise<CompressionResult>`
  - [ ] For each `iter` where `iter.index < currentIndex`: call `await this.engine.summarize(iter.content, this.targetLevel)` and push `{ index: iter.index, summary, compressed: true }` to result; add `iter.index` to `compressedIndices`
  - [ ] For each `iter` where `iter.index >= currentIndex`: push `iter` unchanged to result (no summarization)
  - [ ] Return `{ iterations: result, compressedIndices }`

- [ ] Task 5: Integrate `AutoSummarizer` into `packages/factory/src/convergence/controller.ts` (AC: #6)
  - [ ] **Read the entire existing controller.ts first** — understand `ConvergenceControllerConfig` type, the iteration loop structure, and how iteration outputs are stored
  - [ ] Add `autoSummarizer?: AutoSummarizer` to the controller config interface (or constructor options object)
  - [ ] Import `AutoSummarizer`, `IterationContext` from `'../context/auto-summarizer.js'`
  - [ ] Add logic before each iteration dispatch to: build `IterationContext[]` from previously stored iteration outputs; call `this.config.autoSummarizer?.shouldTrigger(contexts)`; if true, call `compress(contexts, currentIterationIndex)` and replace stored contexts with `result.iterations`
  - [ ] Ensure omitting `autoSummarizer` from config leaves all existing tests green — integration is purely additive

- [ ] Task 6: Update barrel export and check factory config schema (AC: #1)
  - [ ] Add `export * from './auto-summarizer.js'` to `packages/factory/src/context/index.ts`
  - [ ] Search for the factory pipeline config schema (likely `packages/factory/src/config/` or `packages/factory/src/types.ts`); if a config type or Zod schema exists with a context section, add `contextSummarizeThreshold?: number` with JSDoc `@default 0.8`
  - [ ] If no central factory config schema exists, skip this step and note it in completion notes

- [ ] Task 7: Write unit tests in `packages/factory/src/context/__tests__/auto-summarizer.test.ts` (AC: #7)
  - [ ] Import `AutoSummarizer`, `estimateTokens`, `IterationContext`, `CompressedIterationContext`, `CompressionResult`, `AutoSummarizerConfig`
  - [ ] Define a local `MockSummaryEngine` implementing `SummaryEngine`: `summarize` returns a deterministic `Summary` with `level`, `content: content.slice(0, 10)`, `originalHash: 'mock-hash'`, `createdAt: new Date().toISOString()`; `expand` returns `opts?.originalContent ?? summary.content`
  - [ ] **`estimateTokens` tests (3 cases):** empty string → `0`; `'abcd'` (4 chars) → `1`; 400-char string → `100`
  - [ ] **`shouldTrigger` tests (3 cases):** total tokens below threshold → `false`; total tokens exactly at threshold → `false`; total tokens one above threshold → `true`
  - [ ] **`compress` tests (4 cases):** current-index iteration preserved with original `content` and no `compressed` field; previous iterations have `compressed: true` and a `Summary`; `compressedIndices` lists all previous iteration indices; `CompressionResult` has expected array length
  - [ ] **validation tests (4 cases):** threshold `0.4` throws `RangeError`; threshold `0.96` throws `RangeError`; threshold `0.5` constructs without error; threshold `0.95` constructs without error
  - [ ] Ensure at least 14 `it(...)` cases total

- [ ] Task 8: Build and test verification (AC: all)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line with zero failures
  - [ ] Verify no test output is piped through `grep`, `head`, `tail`, or any filter

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import type { SummaryEngine } from './summary-engine.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- Depend only on the `SummaryEngine` **interface** — do NOT import `LLMSummaryEngine` (the concrete implementation from story 49-2) in this file; inversion of control is the pattern
- `estimateTokens` must be a pure synchronous function — no async, no imports
- `AutoSummarizer.compress()` is async because `SummaryEngine.summarize()` is async (real LLM calls happen in 49-2's implementation)
- The controller integration in Task 5 is the highest-risk task — read the full controller before modifying it

### New File Paths
```
packages/factory/src/context/auto-summarizer.ts                      — AutoSummarizer class, IterationContext, CompressedIterationContext, CompressionResult, estimateTokens
packages/factory/src/context/__tests__/auto-summarizer.test.ts       — unit tests (≥14 test cases)
```

### Modified File Paths
```
packages/factory/src/context/index.ts                                — add: export * from './auto-summarizer.js'
packages/factory/src/convergence/controller.ts                       — add: autoSummarizer integration (read first!)
```

### Key Type Definitions

```typescript
// packages/factory/src/context/auto-summarizer.ts
import type { SummaryEngine } from './summary-engine.js'
import type { Summary, SummaryLevel } from './summary-types.js'

export interface AutoSummarizerConfig {
  /** Fraction of model token limit that triggers compression. Default: 0.8. Valid range: [0.5, 0.95]. */
  threshold?: number
  /** Summary level to compress older iterations to. Default: 'medium'. */
  targetLevel?: SummaryLevel
}

/** Context accumulated during a single convergence iteration. */
export interface IterationContext {
  /** Zero-based iteration index within the convergence loop. */
  index: number
  /** Accumulated text for this iteration (agent output, decisions, diffs). */
  content: string
  /** Cached token estimate. Auto-computed from content if absent. */
  tokenEstimate?: number
}

/** A previous iteration that has been compressed to a summary. */
export interface CompressedIterationContext {
  index: number
  summary: Summary
  /** Discriminant literal — enables TypeScript type narrowing. */
  compressed: true
}

export interface CompressionResult {
  iterations: (IterationContext | CompressedIterationContext)[]
  compressedIndices: number[]
}

/** Approximate token count using the chars/4 heuristic. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

export class AutoSummarizer {
  private readonly engine: SummaryEngine
  private readonly modelTokenLimit: number
  private readonly threshold: number
  private readonly targetLevel: SummaryLevel

  constructor(engine: SummaryEngine, modelTokenLimit: number, config?: AutoSummarizerConfig) {
    const threshold = config?.threshold ?? 0.8
    if (threshold < 0.5 || threshold > 0.95) {
      throw new RangeError('context_summarize_threshold must be between 0.5 and 0.95')
    }
    this.engine = engine
    this.modelTokenLimit = modelTokenLimit
    this.threshold = threshold
    this.targetLevel = config?.targetLevel ?? 'medium'
  }

  shouldTrigger(iterations: IterationContext[]): boolean {
    const total = iterations.reduce(
      (sum, iter) => sum + (iter.tokenEstimate ?? estimateTokens(iter.content)),
      0,
    )
    return total > this.threshold * this.modelTokenLimit
  }

  async compress(iterations: IterationContext[], currentIndex: number): Promise<CompressionResult> {
    const compressedIndices: number[] = []
    const result: (IterationContext | CompressedIterationContext)[] = []

    for (const iter of iterations) {
      if (iter.index < currentIndex) {
        const summary = await this.engine.summarize(iter.content, this.targetLevel)
        result.push({ index: iter.index, summary, compressed: true })
        compressedIndices.push(iter.index)
      } else {
        result.push(iter)
      }
    }

    return { iterations: result, compressedIndices }
  }
}
```

### Convergence Controller Integration Pattern

```typescript
// Sketch for packages/factory/src/convergence/controller.ts
// MUST read existing file fully before applying — this is illustrative only.

// 1. Add to config type:
//    autoSummarizer?: AutoSummarizer

// 2. Add import at top:
//    import type { AutoSummarizer, IterationContext } from '../context/auto-summarizer.js'

// 3. In iteration loop, before dispatching iteration N:
const iterationContexts: IterationContext[] = previousOutputs.map((output, i) => ({
  index: i,
  content: output.agentOutput ?? '',
}))

if (this.config.autoSummarizer && iterationContexts.length > 0) {
  if (this.config.autoSummarizer.shouldTrigger(iterationContexts)) {
    const compressionResult = await this.config.autoSummarizer.compress(
      iterationContexts,
      currentIteration,
    )
    // replace stored contexts with compressed result for next iteration's input
    storedContexts = compressionResult.iterations
    // log for observability: compressionResult.compressedIndices
  }
}
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect` — no Jest globals
- Use a local `MockSummaryEngine` class implementing `SummaryEngine` — no `vi.mock()` needed
- Test the `shouldTrigger` boundary case explicitly: at exactly `threshold * modelTokenLimit` tokens, result must be `false` (strictly greater-than)
- Run build before tests: `npm run build` (catches TypeScript errors early)
- Run tests: `npm run test:fast` — use `timeout: 300000` in Bash tool; NEVER pipe output
- Confirm results by checking for the "Test Files" summary line in raw output
- Minimum 14 `it(...)` cases required

## Interface Contracts

- **Import**: `SummaryEngine` @ `packages/factory/src/context/summary-engine.ts` (from story 49-1)
- **Import**: `Summary`, `SummaryLevel` @ `packages/factory/src/context/summary-types.ts` (from story 49-1)
- **Export**: `AutoSummarizer` @ `packages/factory/src/context/auto-summarizer.ts` (consumed by stories 49-4, 49-5, 49-7, 49-8)
- **Export**: `IterationContext`, `CompressedIterationContext`, `CompressionResult` @ `packages/factory/src/context/auto-summarizer.ts` (consumed by stories 49-4, 49-5, 49-8)
- **Export**: `estimateTokens` @ `packages/factory/src/context/auto-summarizer.ts` (consumed by stories 49-4, 49-6)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
