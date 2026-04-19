# Story 49-8: Pyramid Summary Integration Test

## Story

As a factory pipeline developer,
I want a comprehensive integration test suite for the pyramid summarization system,
so that cross-component flows between `LLMSummaryEngine`, `AutoSummarizer`, and `ConvergenceController` are verified to work correctly end-to-end.

## Acceptance Criteria

### AC1: Full 12-Iteration Pipeline Simulation
**Given** an `AutoSummarizer` with `modelTokenLimit=1000`, `threshold=0.8`, backed by a `MockSummaryEngine`; and 12 `IterationContext` objects each with `tokenEstimate=90` (total 1080 tokens)
**When** `shouldTrigger()` is called with the first 9 iterations (total 810 > 800), then `compress()` is called with all 9 of those contexts and `currentIndex=8`
**Then** `shouldTrigger` returns `true`, `compress` returns a `CompressionResult` where `iterations.length === 9`, all 8 entries with `index < 8` have `compressed: true` discriminants, the entry at `index=8` is an unmodified `IterationContext`, and `compressedIndices` equals `[0, 1, 2, 3, 4, 5, 6, 7]`

### AC2: Lossless Round-Trip Across All Summary Levels
**Given** an `LLMSummaryEngine` backed by a `MockLLMClient` that returns a fixed summary content string
**When** `summarize()` is called at each of the four levels (`'full'`, `'high'`, `'medium'`, `'low'`), then `expand()` is called on the resulting `Summary` with `opts.originalContent` set to the original content string
**Then** every `expand()` call returns the exact original content string; `MockLLMClient.complete` is not called during any of the four `expand()` calls (call count unchanged); and each `Summary.originalHash` equals the SHA-256 hex digest of the original content

### AC3: LLM Expansion Path Invokes LLM and Returns Content
**Given** an `LLMSummaryEngine` backed by a `MockLLMClient`; and a `Summary` previously created via `summarize()` at `'medium'` level (without storing `originalContent`)
**When** `expand(summary, 'full')` is called without `opts.originalContent`
**Then** `MockLLMClient.complete` is called exactly once during the expand; the returned string equals the mock LLM response content; and both `summary.summaryTokenCount` and `summary.originalTokenCount` are positive integers set from the LLM response usage stats

### AC4: ConvergenceController Integration with Auto-Compression
**Given** a `ConvergenceController` created via `createConvergenceController({ autoSummarizer })` where `autoSummarizer` has `modelTokenLimit=200`, `threshold=0.8`, `targetLevel='medium'`; and 5 `IterationContext` objects recorded via `recordIterationContext()` each with `tokenEstimate=40` (total 200 tokens, which is exactly at threshold)
**When** one more context is recorded to push total to 240 tokens (>160), then `prepareForIteration(5)` is called
**Then** the returned array contains `CompressedIterationContext` objects for indices 0–4 (all `compressed: true`) and `IterationContext` for index 5 (current); each compressed entry's `summary.level` equals `'medium'`; and `getStoredContexts()` returns the same merged array

### AC5: Hash and Metadata Integrity
**Given** content containing a code block, a file path, and an error message
**When** `LLMSummaryEngine.summarize()` is called on that content at `'medium'` level
**Then** `Summary.originalHash` is a 64-character lowercase hexadecimal string matching the SHA-256 of the input content; `Summary.createdAt` can be parsed by `new Date()` yielding a valid non-NaN date; `Summary.summaryTokenCount` is a positive integer; and `Summary.originalTokenCount` is a positive integer

### AC6: Boundary Conditions for shouldTrigger and estimateTokens
**Given** an `AutoSummarizer` with `modelTokenLimit=100`, `threshold=0.8` (trigger point: total strictly greater than 80)
**When** `shouldTrigger()` is called with: (a) iterations summing to exactly 80 tokens; (b) iterations summing to 81 tokens; (c) an iteration with no `tokenEstimate` and 40-character content; (d) an iteration with explicit `tokenEstimate=90`
**Then** (a) returns `false` (exactly-at-threshold is not a trigger); (b) returns `true`; (c) uses `estimateTokens()` → `Math.ceil(40/4)=10` and triggers based on that sum; (d) uses the explicit `tokenEstimate=90` (not the content length), triggering if total > 80

### AC7: Multi-Round Compression Through ConvergenceController
**Given** a `ConvergenceController` with `AutoSummarizer` (modelTokenLimit=100, threshold=0.8); and after a first `prepareForIteration(4)` call that compressed iterations 0–3 into `CompressedIterationContext` entries
**When** `recordIterationContext({ index: 4, content: '...', tokenEstimate: 90 })` is added (exceeding threshold again) and `prepareForIteration(5)` is called
**Then** the already-compressed entries (indices 0–3) are preserved unchanged and not re-summarized; only the uncompressed entry at index 4 is compressed; and the final `getStoredContexts()` array has length 6, sorted by index, with indices 0–4 all `compressed: true` and index 5 as `IterationContext`

## Tasks / Subtasks

- [ ] Task 1: Create integration test file with shared mock helpers (AC: all)
  - [ ] Create `packages/factory/src/context/__tests__/pyramid-summary-integration.test.ts`
  - [ ] Define `MockLLMClient` class: tracks `callCount: number` and `lastRequest`; `complete()` returns `Promise<{ content: string, usage: { inputTokens: number, outputTokens: number }, stopReason: 'stop' }>`; expose a `setResponse(content: string)` method to control return value per test
  - [ ] Define `MockSummaryEngine` class implementing `SummaryEngine`: tracks `callCount: number`; `summarize()` returns a deterministic `Summary` with `level`, `content: content.slice(0, 20)`, `originalHash: 'mock-hash'`, `createdAt: new Date().toISOString()`; `expand()` returns `opts?.originalContent ?? summary.content`
  - [ ] Import all needed symbols using `.js` extensions: `LLMSummaryEngine` from `'../summarizer.js'`; `AutoSummarizer`, `estimateTokens`, `IterationContext`, `CompressedIterationContext` from `'../auto-summarizer.js'`; `createConvergenceController` from `'../../convergence/controller.js'`; `SUMMARY_BUDGET` from `'../summary-types.js'`

- [ ] Task 2: Write 12-iteration simulation tests (AC: #1)
  - [ ] Create `describe('Full 12-iteration pipeline simulation')` block
  - [ ] Test: `shouldTrigger` returns `false` for 8 × 90-token iterations (720 < 800)
  - [ ] Test: `shouldTrigger` returns `true` for 9 × 90-token iterations (810 > 800)
  - [ ] Test: `compress(iterations[0..8], 8)` returns `CompressionResult` with `iterations.length === 9`
  - [ ] Test: entries at indices 0–7 all have `'compressed' in entry === true`
  - [ ] Test: entry at index 8 does not have `'compressed'` property (is plain `IterationContext`)
  - [ ] Test: `compressedIndices` equals `[0, 1, 2, 3, 4, 5, 6, 7]`

- [ ] Task 3: Write lossless round-trip tests for all summary levels (AC: #2)
  - [ ] Create `describe('Lossless round-trip — all summary levels')` block
  - [ ] For each level in `['full', 'high', 'medium', 'low']`: test that `expand(await summarize(content, level), 'full', { originalContent: content })` returns `content` exactly
  - [ ] Test: `MockLLMClient.callCount` is unchanged (same as after summarize calls only) when all 4 expands use `originalContent`
  - [ ] Test: SHA-256 hash — for `'high'` level summary, `summary.originalHash` equals `createHash('sha256').update(content).digest('hex')`
  - [ ] Test: `summary.createdAt` for `'low'` level is a valid ISO-8601 string parseable by `new Date()`

- [ ] Task 4: Write LLM expansion path tests (AC: #3)
  - [ ] Create `describe('LLM expansion path — no originalContent')` block
  - [ ] Set MockLLMClient to return different content on summarize vs expand calls (use `callCount` in mock to vary response)
  - [ ] Test: after `summarize()`, `MockLLMClient.callCount === 1`; after `expand(summary, 'full')`, `callCount === 2`
  - [ ] Test: returned string from `expand` equals the mock LLM expand response content string
  - [ ] Test: `summary.summaryTokenCount` equals mock response `usage.outputTokens` (e.g., 30)
  - [ ] Test: `summary.originalTokenCount` equals mock response `usage.inputTokens` (e.g., 100)

- [ ] Task 5: Write ConvergenceController integration tests (AC: #4)
  - [ ] Create `describe('ConvergenceController with AutoSummarizer integration')` block
  - [ ] Test: `recordIterationContext` appends to `getStoredContexts()` — after 3 calls, `getStoredContexts().length === 3`
  - [ ] Test: `prepareForIteration` without `autoSummarizer` config returns contexts unchanged
  - [ ] Test: after recording 6 contexts at 40 tokens each (total 240 > 160), `prepareForIteration(5)` returns compressed contexts
  - [ ] Test: all returned entries with index < 5 have `compressed: true`; entry at index 5 lacks `'compressed'` key
  - [ ] Test: each compressed entry's `summary.level === 'medium'` (the configured targetLevel)
  - [ ] Test: `getStoredContexts().length === 6` after compression (all entries preserved, some compressed)
  - [ ] Test: `MockSummaryEngine.callCount === 5` (indices 0–4 compressed, not index 5)

- [ ] Task 6: Write hash and metadata integrity tests (AC: #5)
  - [ ] Create `describe('Hash and metadata integrity')` block
  - [ ] Prepare content string with a code block (`\`\`\`js\nconst x = 1\n\`\`\``), file path (`src/foo/bar.ts`), and error message (`Error: ENOENT: file not found`)
  - [ ] Test: `summary.originalHash.length === 64` (SHA-256 hex)
  - [ ] Test: `summary.originalHash === createHash('sha256').update(content).digest('hex')` — import `createHash` from `'node:crypto'`
  - [ ] Test: `new Date(summary.createdAt).getTime()` is a positive, non-NaN number
  - [ ] Test: `summary.summaryTokenCount > 0`
  - [ ] Test: `summary.originalTokenCount > 0`

- [ ] Task 7: Write boundary condition and multi-round tests (AC: #6, #7)
  - [ ] Create `describe('shouldTrigger boundary conditions')` block
  - [ ] Test: exactly-at-threshold (total === 80 for limit=100, threshold=0.8) → `shouldTrigger` returns `false`
  - [ ] Test: one-above-threshold (total === 81) → returns `true`
  - [ ] Test: well-below-threshold (total === 40) → returns `false`
  - [ ] Test: iteration without `tokenEstimate`, content length 40 chars → `estimateTokens` used; `shouldTrigger` matches manually computed value
  - [ ] Test: iteration with explicit `tokenEstimate=90` overrides content-based estimate; `shouldTrigger({ index:0, content:'a', tokenEstimate:90 })` returns `true` for limit=100
  - [ ] Test: `AutoSummarizer` with `threshold=0.5`: trigger fires when total > 50 for `limit=100`
  - [ ] Test: `AutoSummarizer` with `threshold=0.95`: trigger does not fire at 94 tokens but fires at 96
  - [ ] Create `describe('Multi-round compression via ConvergenceController')` block
  - [ ] Test: after first `prepareForIteration(4)`, `getStoredContexts()` has 5 entries with indices 0–3 compressed
  - [ ] Test: after recording index=4 and calling `prepareForIteration(5)`, `MockSummaryEngine.callCount` increases by only 1 (only index 4 is newly compressed, not 0–3 again)
  - [ ] Test: `getStoredContexts()` after second round has length 6, indices 0–4 all `compressed: true`, index 5 is plain `IterationContext`
  - [ ] Test: merged array is sorted by index (index 0 first, index 5 last)
  - [ ] Test: `compressedIndices` from `AutoSummarizer.compress()` on second call equals `[4]` (not `[0,1,2,3,4]`)

- [ ] Task 8: Build and test verification (AC: all)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` in the Bash tool — NEVER pipe output
  - [ ] Confirm the raw output contains the "Test Files" summary line and zero failures
  - [ ] Verify `pyramid-summary-integration.test.ts` appears in the passing test file list

## Dev Notes

### Architecture Constraints
- Test file location: `packages/factory/src/context/__tests__/pyramid-summary-integration.test.ts`
- All relative imports MUST use `.js` extensions (ESM): e.g., `import { LLMSummaryEngine } from '../summarizer.js'`
- Do NOT import from `@substrate-ai/sdlc` (ADR-003)
- Use `vitest` API (`describe`, `it`, `expect`, `vi`) — no Jest globals
- `vi.fn()` is acceptable for `MockLLMClient.complete` to track calls — no `vi.mock()` module mocking needed
- Import `createHash` from `'node:crypto'` for SHA-256 verification in AC5 tests

### Key File Paths

```
New file:
  packages/factory/src/context/__tests__/pyramid-summary-integration.test.ts

Source files under test (read-only — do NOT modify):
  packages/factory/src/context/summarizer.ts                    — LLMSummaryEngine
  packages/factory/src/context/auto-summarizer.ts               — AutoSummarizer, estimateTokens, types
  packages/factory/src/context/summary-types.ts                 — SummaryLevel, SUMMARY_BUDGET, computeBudget
  packages/factory/src/context/summary-engine.ts                — SummaryEngine interface
  packages/factory/src/convergence/controller.ts                — createConvergenceController
```

### Import Pattern

```typescript
// packages/factory/src/context/__tests__/pyramid-summary-integration.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { LLMSummaryEngine } from '../summarizer.js'
import {
  AutoSummarizer,
  estimateTokens,
  type IterationContext,
  type CompressedIterationContext,
} from '../auto-summarizer.js'
import { SUMMARY_BUDGET, type SummaryLevel, type Summary } from '../summary-types.js'
import type { SummaryEngine, SummarizeOptions, ExpandOptions } from '../summary-engine.js'
import type { LLMClient } from '../../llm/client.js'
import type { LLMRequest } from '../../llm/types.js'
import { createConvergenceController } from '../../convergence/controller.js'
```

### MockLLMClient Pattern

```typescript
// In pyramid-summary-integration.test.ts

function createMockLLMClient(defaultResponse = 'mock summary content') {
  let callCount = 0
  let responseContent = defaultResponse

  const client: LLMClient = {
    complete: vi.fn(async (_req: LLMRequest) => {
      callCount++
      return {
        content: responseContent,
        usage: { inputTokens: 100, outputTokens: 30 },
        stopReason: 'stop' as const,
      }
    }),
  }

  return {
    client,
    get callCount() { return callCount },
    setResponse(content: string) { responseContent = content },
  }
}
```

### MockSummaryEngine Pattern

```typescript
// In pyramid-summary-integration.test.ts

class MockSummaryEngine implements SummaryEngine {
  readonly name = 'mock'
  callCount = 0

  async summarize(content: string, targetLevel: SummaryLevel, _opts?: SummarizeOptions): Promise<Summary> {
    this.callCount++
    return {
      level: targetLevel,
      content: content.slice(0, 20),
      originalHash: 'mock-hash-' + this.callCount,
      createdAt: new Date().toISOString(),
      originalTokenCount: 100,
      summaryTokenCount: 20,
    }
  }

  async expand(summary: Summary, _targetLevel: SummaryLevel, opts?: ExpandOptions): Promise<string> {
    return opts?.originalContent ?? summary.content
  }
}
```

### ConvergenceController Integration Notes

- `createConvergenceController(config?)` returns a `ConvergenceController` object
- `recordIterationContext(ctx)` pushes an `IterationContext` into internal storage
- `prepareForIteration(currentIndex)` — if `autoSummarizer` is configured and threshold is exceeded, compresses all uncompressed contexts with `index < currentIndex`; already-compressed entries from previous rounds are passed through without re-summarization
- `getStoredContexts()` returns the current snapshot (may include a mix of `IterationContext` and `CompressedIterationContext`)
- The controller filters uncompressed contexts before calling `autoSummarizer.shouldTrigger()` — already-compressed entries do NOT count toward the token sum for trigger detection

### Type Narrowing Pattern

```typescript
// Discriminate between IterationContext and CompressedIterationContext
function isCompressed(ctx: IterationContext | CompressedIterationContext): ctx is CompressedIterationContext {
  return 'compressed' in ctx
}

// Usage in tests:
const compressed = result.filter(isCompressed)
const uncompressed = result.filter(c => !isCompressed(c))
```

### Testing Requirements
- Framework: `vitest` (`describe`, `it`, `expect`, `vi`)
- No `vi.mock()` needed — all dependencies injected via constructor
- Minimum **40 `it(...)` cases** in this file (target 43)
- All test groups in separate `describe()` blocks for clear output
- Run `npm run build` before `npm run test:fast` to catch TypeScript errors early
- Use `timeout: 300000` when running tests via Bash — never pipe test output
- Check for "Test Files" in raw output to confirm results (exit code alone is insufficient)

## Interface Contracts

- **Import**: `LLMSummaryEngine` @ `packages/factory/src/context/summarizer.ts` (from story 49-2)
- **Import**: `AutoSummarizer`, `estimateTokens`, `IterationContext`, `CompressedIterationContext`, `CompressionResult` @ `packages/factory/src/context/auto-summarizer.ts` (from story 49-3)
- **Import**: `SummaryLevel`, `SUMMARY_BUDGET`, `Summary`, `SummarizeOptions`, `ExpandOptions` @ `packages/factory/src/context/summary-types.ts` (from story 49-1)
- **Import**: `SummaryEngine` @ `packages/factory/src/context/summary-engine.ts` (from story 49-1)
- **Import**: `createConvergenceController`, `ConvergenceControllerConfig` @ `packages/factory/src/convergence/controller.ts` (from story 49-3)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
