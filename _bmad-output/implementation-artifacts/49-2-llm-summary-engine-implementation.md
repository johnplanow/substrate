# Story 49-2: LLM Summary Engine Implementation

## Story

As a factory pipeline developer,
I want an `LLMSummaryEngine` class that implements the `SummaryEngine` interface using an LLM,
so that the pipeline can compress long context strings to a target level while preserving structural elements (code blocks, file paths, error messages) for faithful recovery.

## Acceptance Criteria

### AC1: Structural Preservation in summarize()
**Given** content containing code blocks (triple-backtick fenced sections), file paths (e.g., `src/foo/bar.ts`), and error messages
**When** `summarize(content, 'medium')` is called on an `LLMSummaryEngine` instance
**Then** the LLM request prompt explicitly instructs the model to copy all code blocks, file paths, and error messages verbatim, and the returned `Summary` object conforms to the `Summary` interface with all required fields populated

### AC2: Prompt Targets Token Budget
**Given** a summarization call with `opts.modelTokenLimit` provided
**When** `summarize(content, targetLevel, { modelTokenLimit: N })` is called
**Then** the LLM request prompt includes the computed target token count (`Math.floor(N * SUMMARY_BUDGET[targetLevel])`) as a budget constraint, and when `modelTokenLimit` is omitted, the prompt uses a sensible default (100 000 tokens)

### AC3: SHA-256 originalHash and Token Count Population
**Given** any content string passed to `summarize()`
**When** the `Summary` is returned
**Then** `Summary.originalHash` is the lowercase hex SHA-256 digest of the original content string (computed with Node `crypto.createHash('sha256')`), `Summary.originalTokenCount` is set from `LLMResponse.usage.inputTokens`, and `Summary.summaryTokenCount` is set from `LLMResponse.usage.outputTokens`

### AC4: expand() Lossless Path — originalContent Provided
**Given** a `Summary` object and `ExpandOptions.originalContent` is a non-empty string
**When** `expand(summary, 'full', { originalContent })` is called
**Then** the method returns `originalContent` directly **without** making an LLM call, providing a perfectly lossless round-trip

### AC5: expand() LLM Path — originalContent Not Provided
**Given** a `Summary` object and `ExpandOptions.originalContent` is absent or empty
**When** `expand(summary, 'full')` is called
**Then** the method calls the LLM with a prompt that includes `summary.content` and instructs it to reconstruct the full detail, returning the LLM response `content` string

### AC6: Round-Trip Structural Fidelity
**Given** content containing at least one code block and at least one file path
**When** `summarize(content, 'medium')` is called, followed by `expand(summary, 'full', { originalContent: content })`
**Then** the string returned by `expand()` equals the original `content` exactly (lossless round-trip via the `originalContent` path)

### AC7: Barrel Export and TypeScript Compilation
**Given** `packages/factory/src/context/index.ts`
**When** built via `npm run build`
**Then** it exports `LLMSummaryEngine` from `./summarizer.js`, zero TypeScript errors are reported, and a consuming module can construct `new LLMSummaryEngine(llmClient)` without type errors

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/context/summarizer.ts` — class skeleton with constructor (AC: #7)
  - [ ] Import `LLMClient` from `../llm/client.js` and `LLMMessage`, `LLMRequest` from `../llm/types.js`
  - [ ] Import `SummaryEngine`, `Summary`, `SummaryLevel`, `SummarizeOptions`, `ExpandOptions`, `SUMMARY_BUDGET` from `./summary-types.js` and `./summary-engine.js`
  - [ ] Import Node `crypto` for SHA-256 hashing: `import { createHash } from 'node:crypto'`
  - [ ] Declare `export class LLMSummaryEngine implements SummaryEngine` with `readonly name = 'llm'`
  - [ ] Constructor signature: `constructor(private readonly llmClient: LLMClient, private readonly modelName: string = 'claude-opus-4-5')`

- [ ] Task 2: Implement `summarize()` method (AC: #1, #2, #3)
  - [ ] Compute `originalHash` via `createHash('sha256').update(content).digest('hex')`
  - [ ] Resolve `targetTokenCount` from `opts?.modelTokenLimit ?? 100_000` multiplied by `SUMMARY_BUDGET[targetLevel]`, using `Math.floor`
  - [ ] Build preservation instructions block listing: code blocks (triple-backtick), file paths, error messages, and key decisions as MANDATORY copy-verbatim items
  - [ ] Build reduction instructions block listing acceptable ways to shorten: removing verbose commentary, condensing repetitive text, shortening transitions
  - [ ] Construct `LLMRequest` with `model: this.modelName`, a single `user` message containing the assembled prompt, and `maxTokens` set to `targetTokenCount + 500` (headroom for the response)
  - [ ] Call `await this.llmClient.complete(request)` and capture the `LLMResponse`
  - [ ] Return a `Summary` object: `{ level: targetLevel, content: response.content, originalHash, createdAt: new Date().toISOString(), originalTokenCount: response.usage.inputTokens, summaryTokenCount: response.usage.outputTokens }`

- [ ] Task 3: Implement `expand()` method (AC: #4, #5)
  - [ ] If `opts?.originalContent` is a non-empty string, return it immediately without calling the LLM
  - [ ] Otherwise build an expansion prompt that includes `summary.level`, `summary.content`, and instructions to reconstruct full detail, preserving all code blocks and file paths verbatim
  - [ ] Construct `LLMRequest` with no `maxTokens` cap (let model decide) and call `await this.llmClient.complete(request)`
  - [ ] Return `response.content`

- [ ] Task 4: Update `packages/factory/src/context/index.ts` to export `LLMSummaryEngine` (AC: #7)
  - [ ] Add `export * from './summarizer.js'` as a new line in the barrel file
  - [ ] Verify existing `summary-types.js` and `summary-engine.js` re-exports are undisturbed

- [ ] Task 5: Write unit tests in `packages/factory/src/context/__tests__/summarizer.test.ts` (AC: all)
  - [ ] Define a `MockLLMClient` class with a `complete(request: LLMRequest): Promise<LLMResponse>` method that captures the last request for inspection and returns a canned `LLMResponse` (content `'summarized text'`, usage `{ inputTokens: 500, outputTokens: 100, totalTokens: 600 }`)
  - [ ] **AC1 tests (2 cases):** Verify the captured prompt contains the phrases `'verbatim'` and `'code block'`; verify the returned `Summary.content` equals the mock response content
  - [ ] **AC2 tests (2 cases):** Call `summarize(content, 'medium', { modelTokenLimit: 200_000 })`; verify the captured prompt contains `'50000'` (= `Math.floor(200_000 * 0.5)`); call without `modelTokenLimit` and verify prompt contains `'50000'` (default 100 000 × 0.5)
  - [ ] **AC3 tests (3 cases):** Compute expected SHA-256 of the test content string in the test itself and assert `summary.originalHash` matches; assert `summary.originalTokenCount === 500`; assert `summary.summaryTokenCount === 100`
  - [ ] **AC4 test (2 cases):** Call `expand(summary, 'full', { originalContent: 'original text' })` and assert the return value is `'original text'` exactly; assert `mockClient.complete` was NOT called (call count stays at 0 after the expand)
  - [ ] **AC5 test (2 cases):** Call `expand(summary, 'full')` with no opts and assert `mockClient.complete` WAS called; assert the captured prompt contains `summary.content`
  - [ ] **AC6 test (1 case):** Construct content string with a fenced code block and a file path; call `summarize` then `expand` with `originalContent`; assert the final string equals the original content
  - [ ] **AC7 test (1 case):** Verify that `new LLMSummaryEngine(mockClient)` produces an object with `name === 'llm'` and both methods present
  - [ ] Minimum 13 `it(...)` cases total

- [ ] Task 6: Run build and tests to confirm zero errors (AC: all)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000`; NEVER pipe output; confirm "Test Files" summary line with zero failures

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` **MUST** use `.js` extensions (ESM): e.g., `import { LLMClient } from '../llm/client.js'`
- Factory package **MUST NOT** import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- Use `import { createHash } from 'node:crypto'` for SHA-256 — Node built-in, no external dep
- No Zod schemas in this story — TypeScript interfaces only; Zod validation is added by downstream stories as needed
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals

### New File Paths
```
packages/factory/src/context/summarizer.ts                    — LLMSummaryEngine class
packages/factory/src/context/__tests__/summarizer.test.ts     — unit tests (≥13 test cases)
```

### Modified File Paths
```
packages/factory/src/context/index.ts                         — add export * from './summarizer.js'
```

### LLMClient Interface (from Epic 48)

```typescript
// packages/factory/src/llm/client.ts — relevant shape
class LLMClient {
  async complete(request: LLMRequest): Promise<LLMResponse>
}

// packages/factory/src/llm/types.ts — relevant shape
interface LLMRequest {
  model: string
  messages: LLMMessage[]     // [{ role: 'user', content: [{ kind: 'text', text: '...' }] }]
  maxTokens?: number
}

interface LLMResponse {
  content: string
  toolCalls: LLMToolCall[]
  usage: { inputTokens: number; outputTokens: number; totalTokens: number }
  model: string
  stopReason: StopReason
  providerMetadata: Record<string, unknown>
}
```

### Summarize Prompt Template

```typescript
function buildSummarizePrompt(content: string, targetTokenCount: number, opts: SummarizeOptions): string {
  const preserveCodeBlocks = opts.preserveCodeBlocks ?? true
  const preserveFilePaths = opts.preserveFilePaths ?? true
  const preserveErrorMessages = opts.preserveErrorMessages ?? true

  return `Summarize the following content to approximately ${targetTokenCount} tokens.

PRESERVATION RULES (MANDATORY — do NOT paraphrase or omit):
${preserveCodeBlocks ? '- Code blocks (triple-backtick fenced sections): copy VERBATIM' : ''}
${preserveFilePaths ? '- File paths (e.g. src/foo/bar.ts, /absolute/path): copy VERBATIM' : ''}
${preserveErrorMessages ? '- Error messages and stack traces: copy VERBATIM' : ''}
- Key decisions, conclusions, and action items: preserve the substance

REDUCTION RULES (apply in order of preference):
1. Remove verbose explanations and commentary
2. Shorten transition sentences between sections
3. Condense repetitive content to a single representative example
4. Summarize narrative prose into concise bullet points

Content:
---
${content}
---`
}
```

### Expand Prompt Template

```typescript
function buildExpandPrompt(summary: Summary): string {
  return `The following is a ${summary.level}-level summary of a longer technical document.
Expand it back toward the full version by restoring context, explanations, and detail that would have been in the original.

EXPANSION RULES:
- Preserve all code blocks VERBATIM as they appear in the summary
- Preserve all file paths VERBATIM as they appear in the summary
- Preserve all error messages VERBATIM as they appear in the summary
- Infer and restore narrative context and explanations from the summary's content

Summary (${summary.level} level):
---
${summary.content}
---`
}
```

### SHA-256 Hash Pattern

```typescript
import { createHash } from 'node:crypto'

const originalHash = createHash('sha256').update(content).digest('hex')
```

### Mock LLMClient Pattern for Tests

```typescript
import { describe, it, expect, vi } from 'vitest'
import type { LLMRequest, LLMResponse } from '../../llm/types.js'

class MockLLMClient {
  public lastRequest: LLMRequest | undefined
  public callCount = 0
  public responseContent = 'summarized text'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = request
    this.callCount++
    return {
      content: this.responseContent,
      toolCalls: [],
      usage: { inputTokens: 500, outputTokens: 100, totalTokens: 600 },
      model: request.model,
      stopReason: 'stop' as const,
      providerMetadata: {},
    }
  }
}
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`
- No real LLM calls — use `MockLLMClient` defined locally in the test file
- SHA-256 expected values can be computed in the test using the same `createHash('sha256')` approach
- Run tests with: `npm run test:fast` — use `timeout: 300000` in Bash tool; NEVER pipe output
- Confirm results by checking for "Test Files" summary line in raw output
- Run `npm run build` before tests to catch TypeScript compilation errors early
- Minimum 13 `it(...)` cases required

## Interface Contracts

- **Import**: `SummaryEngine` @ `packages/factory/src/context/summary-engine.ts` (from story 49-1)
- **Import**: `Summary`, `SummaryLevel`, `SummarizeOptions`, `ExpandOptions`, `SUMMARY_BUDGET` @ `packages/factory/src/context/summary-types.ts` (from story 49-1)
- **Import**: `LLMClient` @ `packages/factory/src/llm/client.ts` (from story 48-5a)
- **Import**: `LLMRequest`, `LLMResponse`, `LLMMessage` @ `packages/factory/src/llm/types.ts` (from story 48-1)
- **Export**: `LLMSummaryEngine` @ `packages/factory/src/context/summarizer.ts` (consumed by stories 49-3, 49-4, 49-7, 49-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
