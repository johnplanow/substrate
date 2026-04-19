# Story 48-5b: LLM Client Middleware Chain — Logging, Cost-Tracking, Retry

## Story

As a factory pipeline component,
I want the `LLMClient` to support a composable middleware chain for cross-cutting concerns,
so that logging, cost estimation, and retry behavior can be applied uniformly across all LLM calls without embedding that logic in provider adapters.

## Acceptance Criteria

### AC1: Logging middleware writes a structured NDJSON line on success
**Given** a logging middleware configured with a `logsRoot` path
**When** a `complete()` call succeeds
**Then** the middleware appends a single JSON line to `{logsRoot}/llm-calls.ndjson` containing `timestamp` (ISO string), `model`, `inputTokens`, `outputTokens`, `cost_usd` (number, may be 0 if model unknown), `durationMs` (positive number), and `status: "success"`

### AC2: Logging middleware records error status on failure
**Given** a logging middleware configured with a `logsRoot` path
**When** a `complete()` call throws an error
**Then** the middleware appends a JSON line to `{logsRoot}/llm-calls.ndjson` with `status: "error"`, `errorMessage` set to the error message, and `durationMs` still populated — then re-throws the original error

### AC3: Cost-tracking middleware estimates cost per response
**Given** a cost-tracking middleware with an `onCost` callback
**When** a `complete()` call returns a response with token usage
**Then** the middleware computes `costUsd` via `estimateCostSafe()` (using the model's provider prefix to look up rates) and calls `onCost({ model, provider, inputTokens, outputTokens, costUsd, timestamp })` before returning the response

### AC4: Retry middleware retries on retryable HTTP errors
**Given** a retry middleware with default config (max 2 retries, 1 000 ms base, 2× factor)
**When** the downstream throws an error with `statusCode` 429 or 500
**Then** the middleware retries up to the configured maximum, applying exponential backoff (delays: 1 000 ms, 2 000 ms), and returns the first successful response — or re-throws on exhaustion

### AC5: Retry middleware does not retry on non-retryable errors
**Given** a retry middleware
**When** the downstream throws an error with `statusCode` 400 or 401
**Then** no retry is attempted and the error is re-thrown immediately

### AC6: Middleware chain executes in correct onion order
**Given** an `LLMClient` with middleware registered in order `[logging, cost, retry]`
**When** a `complete()` call is made
**Then** logging wraps all inner middleware (observes retried attempts and final response), cost wraps retry (observes the final successful response only), and retry wraps the raw adapter call

### AC7: `LLMClient.use()` registers middleware and applies it to every `complete()` call
**Given** an `LLMClient` created without constructor middleware
**When** `client.use(mw)` is called with a middleware function and then `client.complete(request)` is invoked
**Then** the middleware is applied to that call (request passes through `mw`), and `use()` returns `this` for chaining

## Tasks / Subtasks

- [ ] Task 1: Define middleware types in `packages/factory/src/llm/middleware/types.ts` (AC: #4, #6, #7)
  - [ ] Define `MiddlewareNext` as `(request: LLMRequest) => Promise<LLMResponse>`
  - [ ] Define `MiddlewareFn` as `(request: LLMRequest, next: MiddlewareNext) => Promise<LLMResponse>`
  - [ ] Define `CostRecord` interface: `{ model: string; provider: string; inputTokens: number; outputTokens: number; costUsd: number; timestamp: number }`
  - [ ] Define `LLMHttpError` interface extending `Error` with `statusCode: number` and optional `retryable?: boolean`
  - [ ] Implement `buildMiddlewareChain(middleware: MiddlewareFn[], base: MiddlewareNext): MiddlewareNext` — composes middleware right-to-left so the first in the array is the outermost wrapper
  - [ ] Export all types and `buildMiddlewareChain`

- [ ] Task 2: Implement logging middleware in `packages/factory/src/llm/middleware/logging.ts` (AC: #1, #2)
  - [ ] Import `fs/promises` and `path` from Node built-ins; import `LLMRequest`, `LLMResponse`, `MiddlewareFn` from types
  - [ ] Import `estimateCostSafe` from `@substrate-ai/core` for cost estimation in the log line
  - [ ] Export `createLoggingMiddleware(options: { logsRoot: string }): MiddlewareFn`
  - [ ] On call: record start time, call `next(request)`, on success append NDJSON line with `{ timestamp, model, inputTokens, outputTokens, cost_usd, durationMs, status: 'success' }`; on error append with `{ timestamp, model, durationMs, status: 'error', errorMessage }` then re-throw
  - [ ] Use `fs/promises.appendFile()` — create the file if it does not exist; do NOT require the directory to pre-exist (use `fs/promises.mkdir({ recursive: true })` before first write)
  - [ ] The `cost_usd` in the log line is estimated from the model string using `estimateCostSafe(provider, model, inputTokens, outputTokens)` where provider is derived by matching the model prefix (claude- → anthropic, gpt-/o\d → openai, gemini- → gemini, else empty string which yields 0)

- [ ] Task 3: Implement cost-tracking middleware in `packages/factory/src/llm/middleware/cost-tracking.ts` (AC: #3)
  - [ ] Import `estimateCostSafe`, `TOKEN_RATES` from `@substrate-ai/core`
  - [ ] Define `CostTrackingOptions`: `{ onCost?: (record: CostRecord) => void | Promise<void>; tokenRates?: TokenRates }`
  - [ ] Export `createCostTrackingMiddleware(options?: CostTrackingOptions): MiddlewareFn`
  - [ ] After receiving a successful response: derive provider from model prefix, call `estimateCostSafe(provider, model, inputTokens, outputTokens, tokenRates)`, then call `options.onCost?.({ model, provider, inputTokens, outputTokens, costUsd, timestamp: Date.now() })`
  - [ ] Errors from `onCost` must NOT propagate — catch and ignore silently (cost tracking is non-critical)
  - [ ] Pass through errors from the downstream adapter unchanged

- [ ] Task 4: Implement retry middleware in `packages/factory/src/llm/middleware/retry.ts` (AC: #4, #5)
  - [ ] Define `RetryOptions`: `{ maxRetries?: number; baseDelayMs?: number; factor?: number }` — defaults: `maxRetries=2`, `baseDelayMs=1000`, `factor=2`
  - [ ] Export `createRetryMiddleware(options?: RetryOptions): MiddlewareFn`
  - [ ] Implement `isRetryable(err: unknown): boolean` — returns `true` if `err` has a `statusCode` property equal to 429 or 500 (or 502, 503); returns `false` otherwise (including 400, 401, 4xx, etc.)
  - [ ] Retry loop: on retryable error, wait `baseDelayMs * (factor ** attempt)` ms, then retry; after `maxRetries` attempts, re-throw the last error
  - [ ] Export `isRetryable` for testing

- [ ] Task 5: Extend `LLMClient` with middleware support in `packages/factory/src/llm/client.ts` (AC: #6, #7)
  - [ ] Import `MiddlewareFn`, `buildMiddlewareChain` from `./middleware/types.js`
  - [ ] Add private `_middleware: MiddlewareFn[] = []` field
  - [ ] Add `use(mw: MiddlewareFn): this` method — appends to `_middleware` and returns `this`
  - [ ] In `complete()`: build chain via `buildMiddlewareChain(this._middleware, baseNext)` and call it; `baseNext` remains `(req) => this.resolveAdapter(req.model).complete(req)`
  - [ ] `stream()` is NOT wrapped by middleware in this story — it delegates directly to the adapter as before (streaming middleware is out of scope)

- [ ] Task 6: Create barrel exports (AC: #7)
  - [ ] Create `packages/factory/src/llm/middleware/index.ts` that re-exports everything from `./types.js`, `./logging.js`, `./cost-tracking.js`, `./retry.js`
  - [ ] Update `packages/factory/src/llm/index.ts` to add `export * from './middleware/index.js'`

- [ ] Task 7: Write unit tests (AC: #1, #2, #3, #4, #5, #6, #7)
  - [ ] `packages/factory/src/llm/middleware/__tests__/logging.test.ts` — min 6 test cases:
    - Success path writes correct NDJSON fields (parse JSON, check keys)
    - Error path writes `status: 'error'` and `errorMessage`, then re-throws
    - `durationMs` is a positive number in both paths
    - File is created if it does not exist
    - Multiple calls append (file has N lines after N calls)
    - `cost_usd` is 0 for an unknown model, positive for `claude-opus-4-6`
  - [ ] `packages/factory/src/llm/middleware/__tests__/cost-tracking.test.ts` — min 5 test cases:
    - `onCost` is called with correct model/provider/tokens/costUsd
    - `costUsd` is positive for known model, 0 for unknown
    - Error in `onCost` does NOT propagate
    - Response is returned unchanged after `onCost`
    - Middleware is a no-op (no crash) when `onCost` is undefined
  - [ ] `packages/factory/src/llm/middleware/__tests__/retry.test.ts` — min 7 test cases:
    - Retries twice on 429 then returns success
    - Re-throws after `maxRetries` exhausted
    - Does NOT retry on 400 (immediate re-throw)
    - Does NOT retry on 401
    - `isRetryable()` returns true for 500, false for 400
    - Delay between retries (mock `setTimeout` / `vi.useFakeTimers()`)
    - Respects custom `maxRetries=0` (no retry at all)

- [ ] Task 8: Build and verify (AC: #7)
  - [ ] Run `npm run build` — confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` — confirm all tests pass; check raw output for `Test Files` summary line

## Dev Notes

### Architecture Constraints
- All relative imports must use `.js` extensions (ESM): `import { MiddlewareFn } from './types.js'`
- Import from `@substrate-ai/core` for `estimateCostSafe`, `TOKEN_RATES` (no circular dep — factory imports core, not sdlc)
- `middleware/types.ts` must have zero runtime imports (pure types + pure logic for `buildMiddlewareChain`)
- `logging.ts` uses Node built-in `fs/promises` and `path` — no external dependencies
- `cost-tracking.ts` imports only from `@substrate-ai/core` and `./types.js`
- `retry.ts` imports only from `./types.js` (no external deps)
- No default exports — named exports throughout

### File Paths
```
packages/factory/src/llm/middleware/types.ts              ← new
packages/factory/src/llm/middleware/logging.ts            ← new
packages/factory/src/llm/middleware/cost-tracking.ts      ← new
packages/factory/src/llm/middleware/retry.ts              ← new
packages/factory/src/llm/middleware/index.ts              ← new (barrel)
packages/factory/src/llm/middleware/__tests__/logging.test.ts       ← new
packages/factory/src/llm/middleware/__tests__/cost-tracking.test.ts ← new
packages/factory/src/llm/middleware/__tests__/retry.test.ts         ← new
packages/factory/src/llm/client.ts                        ← extend (add use() + middleware pipeline)
packages/factory/src/llm/index.ts                         ← extend (add middleware barrel export)
```

### Middleware Type Design
```typescript
// packages/factory/src/llm/middleware/types.ts
import type { LLMRequest, LLMResponse } from '../types.js'

export type MiddlewareNext = (request: LLMRequest) => Promise<LLMResponse>
export type MiddlewareFn = (request: LLMRequest, next: MiddlewareNext) => Promise<LLMResponse>

export interface CostRecord {
  model: string
  provider: string
  inputTokens: number
  outputTokens: number
  costUsd: number
  timestamp: number
}

export interface LLMHttpError extends Error {
  statusCode: number
  retryable?: boolean
}

/** Composes middleware into a single next-function. First middleware is outermost. */
export function buildMiddlewareChain(
  middleware: MiddlewareFn[],
  base: MiddlewareNext,
): MiddlewareNext {
  return middleware.reduceRight<MiddlewareNext>(
    (next, mw) => (req) => mw(req, next),
    base,
  )
}
```

### Provider Prefix Resolver (shared helper used in logging + cost-tracking)
```typescript
// Derive a provider string from a model identifier — used for cost estimation
function deriveProvider(model: string): string {
  if (/^claude-/i.test(model)) return 'anthropic'
  if (/^gpt-/i.test(model) || /^o\d(-|$)/i.test(model)) return 'openai'
  if (/^gemini-/i.test(model)) return 'gemini'
  return ''
}
```

### Retry Middleware Implementation Guide
```typescript
// packages/factory/src/llm/middleware/retry.ts
export function isRetryable(err: unknown): boolean {
  if (err instanceof Error && 'statusCode' in err) {
    const code = (err as { statusCode: number }).statusCode
    return code === 429 || code === 500 || code === 502 || code === 503
  }
  return false
}

export function createRetryMiddleware(options?: RetryOptions): MiddlewareFn {
  const maxRetries = options?.maxRetries ?? 2
  const baseDelayMs = options?.baseDelayMs ?? 1000
  const factor = options?.factor ?? 2

  return async (request, next) => {
    let lastError: unknown
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await next(request)
      } catch (err) {
        lastError = err
        if (!isRetryable(err) || attempt === maxRetries) throw err
        await new Promise(resolve => setTimeout(resolve, baseDelayMs * Math.pow(factor, attempt)))
      }
    }
    throw lastError
  }
}
```

### LLMClient Extension
```typescript
// In packages/factory/src/llm/client.ts — additions only
import type { MiddlewareFn } from './middleware/types.js'
import { buildMiddlewareChain } from './middleware/types.js'

export class LLMClient {
  // ... existing fields ...
  private _middleware: MiddlewareFn[] = []

  use(mw: MiddlewareFn): this {
    this._middleware.push(mw)
    return this
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const baseNext: MiddlewareNext = (req) => this.resolveAdapter(req.model).complete(req)
    const chain = buildMiddlewareChain(this._middleware, baseNext)
    return chain(request)
  }
  // stream() remains unchanged — no middleware wrapping for streaming in this story
}
```

### Testing Requirements
- Framework: vitest (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Use `vi.useFakeTimers()` in retry tests to avoid real delays
- Use `os.tmpdir()` + unique subdirectory for filesystem tests (clean up in `afterEach`)
- Minimum test counts: logging ≥ 6, cost-tracking ≥ 5, retry ≥ 7
- Test that `vi.fn()` mock `next` was called the expected number of times
- Run with `npm run test:fast` (timeout 300000 ms); never pipe output

### Key `@substrate-ai/core` Imports
```typescript
import { estimateCostSafe, TOKEN_RATES } from '@substrate-ai/core'
import type { TokenRates } from '@substrate-ai/core'
```

## Interface Contracts

- **Import**: `ProviderAdapter`, `LLMRequest`, `LLMResponse`, `StreamEvent` @ `packages/factory/src/llm/types.ts` (from story 48-1)
- **Import**: `LLMClient`, `ModelRegistry` @ `packages/factory/src/llm/client.ts`, `model-registry.ts` (from story 48-5a)
- **Export**: `MiddlewareFn`, `MiddlewareNext`, `buildMiddlewareChain`, `CostRecord`, `LLMHttpError` @ `packages/factory/src/llm/middleware/types.ts` (consumed by stories 48-7, 48-10, and future middleware authors)
- **Export**: `createLoggingMiddleware` @ `packages/factory/src/llm/middleware/logging.ts` (consumed by DirectCodergenBackend, story 48-10)
- **Export**: `createCostTrackingMiddleware` @ `packages/factory/src/llm/middleware/cost-tracking.ts` (consumed by DirectCodergenBackend, story 48-10)
- **Export**: `createRetryMiddleware`, `isRetryable` @ `packages/factory/src/llm/middleware/retry.ts` (consumed by story 48-10 and provider adapters 48-2/48-3/48-4 if they switch to client-level retry)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-24: Story created for Epic 48 Phase C (Direct API Backend)
