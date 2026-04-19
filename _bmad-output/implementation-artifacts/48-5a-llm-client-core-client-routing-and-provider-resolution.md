# Story 48-5a: LLM Client Core — Client Routing and Provider Resolution

## Story

As a factory pipeline component,
I want an `LLMClient` that routes requests to the correct provider adapter based on model string,
so that calling code can use any supported LLM model without managing provider selection manually.

## Acceptance Criteria

### AC1: Model-based routing to Anthropic adapter
**Given** an `LLMClient` with an Anthropic adapter registered under `'anthropic'`
**When** `client.complete({ model: 'claude-sonnet-4-5', ... })` is called
**Then** the request is forwarded to the Anthropic adapter and its response is returned

### AC2: Model-based routing to OpenAI and Gemini adapters
**Given** an `LLMClient` with OpenAI and Gemini adapters registered
**When** `client.complete({ model: 'gpt-4o', ... })` or `client.complete({ model: 'gemini-2.0-flash', ... })` is called
**Then** the request is forwarded to the correct provider adapter respectively (OpenAI for `gpt-*`, Gemini for `gemini-*`)

### AC3: Unknown model throws descriptive error
**Given** an `LLMClient` with Anthropic and OpenAI adapters registered
**When** `client.complete({ model: 'unknown-model-xyz', ... })` is called
**Then** an `Error` is thrown with a message that includes `"unknown-model-xyz"` and lists the names of all registered providers

### AC4: `registerProvider` registers adapter and routes matching models
**Given** a fresh `LLMClient` with no adapters
**When** `client.registerProvider('anthropic', adapter)` is called
**Then** subsequent calls with `model: 'claude-*'` route to that adapter, and calling with a non-matching model still throws

### AC5: `registerModelPattern` allows custom pattern overrides
**Given** an `LLMClient` with a custom adapter registered under `'custom'`
**When** `client.registerModelPattern('my-model-*', 'custom')` is called
**Then** requests with `model: 'my-model-v1'` route to the `'custom'` adapter (custom patterns take precedence over defaults)

### AC6: `stream()` routes requests using the same provider resolution logic
**Given** an `LLMClient` with an Anthropic adapter registered
**When** `client.stream({ model: 'claude-haiku-3-5', ... })` is called
**Then** the async iterable is delegated to the Anthropic adapter's `stream()` method

### AC7: All unit tests pass
**Given** the implementation of `client.ts`, `model-registry.ts`, and their test files
**When** `npm run test:fast` is executed
**Then** all tests in `packages/factory/src/llm/__tests__/client.test.ts` pass with no failures

## Tasks / Subtasks

- [ ] Task 1: Implement `ModelRegistry` class in `packages/factory/src/llm/model-registry.ts` (AC: #1, #2, #4, #5)
  - [ ] Define `DEFAULT_PATTERNS` array with regex entries for `claude-*` → `'anthropic'`, `gpt-*` and `o[0-9]` → `'openai'`, `gemini-*` → `'gemini'`
  - [ ] Implement `register(globPattern: string, provider: string): void` — converts glob-style wildcard (`*`) to a regex and prepends to the pattern list (so custom patterns override defaults)
  - [ ] Implement `resolve(model: string): string | null` — iterates patterns in order and returns the first matching provider name, or `null` if none match
  - [ ] Export `ModelRegistry` class

- [ ] Task 2: Implement `LLMClient` class in `packages/factory/src/llm/client.ts` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Constructor accepts optional `adapters?: Record<string, ProviderAdapter>` and registers each via `registerProvider()`; creates a fresh `ModelRegistry` instance
  - [ ] Implement `registerProvider(name: string, adapter: ProviderAdapter): void` — stores adapter by provider name in a `Map<string, ProviderAdapter>`
  - [ ] Implement `registerModelPattern(pattern: string, providerName: string): void` — delegates to `this.modelRegistry.register(pattern, providerName)`
  - [ ] Implement private `resolveAdapter(model: string): ProviderAdapter` — calls `this.modelRegistry.resolve(model)`, throws descriptive `Error` if no pattern matches or if matched provider name is not registered
  - [ ] Implement `async complete(request: LLMRequest): Promise<LLMResponse>` — calls `resolveAdapter`, delegates to adapter
  - [ ] Implement `async *stream(request: LLMRequest): AsyncIterable<StreamEvent>` — calls `resolveAdapter`, delegates via `yield*`

- [ ] Task 3: Write unit tests in `packages/factory/src/llm/__tests__/client.test.ts` (AC: #7)
  - [ ] Test routing: `claude-sonnet-4-5` → Anthropic mock, `gpt-4o` → OpenAI mock, `gemini-2.0-flash` → Gemini mock
  - [ ] Test o-series routing: `o3-mini` → OpenAI mock
  - [ ] Test unknown model throws error containing model name and registered provider names
  - [ ] Test `registerProvider` on empty client then routing works
  - [ ] Test `registerModelPattern` with custom pattern overrides built-in routing
  - [ ] Test custom pattern is case-insensitive (e.g., `MY-MODEL-V1` matches `my-model-*`)
  - [ ] Test `stream()` delegates to the correct adapter's `stream()` method
  - [ ] Test error when provider name is matched by pattern but adapter not registered
  - [ ] Test constructor with pre-populated adapters map works correctly
  - [ ] At least 12 test cases total (use `describe`/`it` structure from vitest, no Jest globals)

- [ ] Task 4: Update barrel exports in `packages/factory/src/llm/index.ts` (AC: #1)
  - [ ] Add `export * from './client.js'`
  - [ ] Add `export * from './model-registry.js'`

- [ ] Task 5: Build and verify (AC: #7)
  - [ ] Run `npm run build` — confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` — confirm all tests pass; check raw output for `Test Files` summary line

## Dev Notes

### Architecture Constraints
- All relative imports must use `.js` extensions (ESM project): `import { ProviderAdapter } from './types.js'`
- No factory→sdlc circular dependency (ADR-003): only import from `./types.js` and `./model-registry.js` within the `llm/` package
- `model-registry.ts` must have zero runtime imports (pure logic, no external deps)
- `client.ts` imports only from within `packages/factory/src/llm/` (types, model-registry)
- No default exports — use named exports throughout

### File Paths
```
packages/factory/src/llm/client.ts           ← new
packages/factory/src/llm/model-registry.ts   ← new
packages/factory/src/llm/__tests__/client.test.ts  ← new
packages/factory/src/llm/index.ts            ← extend (add two new exports)
```

### ModelRegistry Implementation Guide
```typescript
// packages/factory/src/llm/model-registry.ts
const DEFAULT_PATTERNS: Array<{ pattern: RegExp; provider: string }> = [
  { pattern: /^claude-/i, provider: 'anthropic' },
  { pattern: /^gpt-/i, provider: 'openai' },
  { pattern: /^o\d(-|$)/i, provider: 'openai' },   // o1, o3, o4-mini, etc.
  { pattern: /^gemini-/i, provider: 'gemini' },
]

export class ModelRegistry {
  private patterns: Array<{ pattern: RegExp; provider: string }> = [...DEFAULT_PATTERNS]

  register(globPattern: string, provider: string): void {
    // Escape regex special chars, then replace glob * with .*
    const escaped = globPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    this.patterns.unshift({ pattern: new RegExp(`^${escaped}$`, 'i'), provider })
  }

  resolve(model: string): string | null {
    for (const { pattern, provider } of this.patterns) {
      if (pattern.test(model)) return provider
    }
    return null
  }
}
```

### LLMClient Implementation Guide
```typescript
// packages/factory/src/llm/client.ts
import type { ProviderAdapter, LLMRequest, LLMResponse, StreamEvent } from './types.js'
import { ModelRegistry } from './model-registry.js'

export class LLMClient {
  private adapters = new Map<string, ProviderAdapter>()
  private modelRegistry = new ModelRegistry()

  constructor(adapters?: Record<string, ProviderAdapter>) {
    if (adapters) {
      for (const [name, adapter] of Object.entries(adapters)) {
        this.registerProvider(name, adapter)
      }
    }
  }

  registerProvider(name: string, adapter: ProviderAdapter): void {
    this.adapters.set(name, adapter)
  }

  registerModelPattern(pattern: string, providerName: string): void {
    this.modelRegistry.register(pattern, providerName)
  }

  private resolveAdapter(model: string): ProviderAdapter {
    const providerName = this.modelRegistry.resolve(model)
    const registered = [...this.adapters.keys()]
    if (!providerName) {
      throw new Error(
        `No provider matched model "${model}". Registered providers: ${registered.join(', ') || '(none)'}`
      )
    }
    const adapter = this.adapters.get(providerName)
    if (!adapter) {
      throw new Error(
        `Provider "${providerName}" matched model "${model}" but is not registered. Registered providers: ${registered.join(', ') || '(none)'}`
      )
    }
    return adapter
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return this.resolveAdapter(request.model).complete(request)
  }

  async *stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    yield* this.resolveAdapter(request.model).stream(request)
  }
}
```

### Test Mock Pattern
```typescript
// vitest only — no Jest globals
import { describe, it, expect, vi } from 'vitest'
import { LLMClient } from '../client.js'
import type { ProviderAdapter, LLMRequest, LLMResponse } from '../types.js'

function makeMockAdapter(name: string): ProviderAdapter {
  return {
    name,
    complete: vi.fn().mockResolvedValue({ content: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: name, stopReason: 'stop', providerMetadata: {} } satisfies LLMResponse),
    stream: vi.fn().mockReturnValue((async function* () {})()),
  }
}
```

### Testing Requirements
- Framework: vitest (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Minimum 12 test cases in `client.test.ts`
- Mock provider adapters with `vi.fn()` — do not instantiate real `AnthropicAdapter` etc.
- Test that `vi.fn()` mocks were called with the correct arguments (use `expect(mock).toHaveBeenCalledWith(request)`)
- Use `await expect(promise).rejects.toThrow(...)` for error path tests
- Run with `npm run test:fast` (timeout 300000ms); never pipe output

## Interface Contracts

- **Import**: `ProviderAdapter`, `LLMRequest`, `LLMResponse`, `StreamEvent` @ `packages/factory/src/llm/types.ts` (from story 48-1)
- **Export**: `LLMClient` @ `packages/factory/src/llm/client.ts` (consumed by story 48-5b for middleware wrapping)
- **Export**: `ModelRegistry` @ `packages/factory/src/llm/model-registry.ts` (consumed by story 48-5b if middleware needs routing inspection)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-24: Story created for Epic 48 Phase C (Direct API Backend)
