# Story 48-1: Unified LLM Client — Provider Adapter Interface

## Story

As a factory pipeline developer,
I want a typed `ProviderAdapter` interface and shared LLM types defined in the factory package,
so that provider adapters (Anthropic, OpenAI, Gemini) can be implemented independently in subsequent stories against a stable, shared contract.

## Acceptance Criteria

### AC1: ProviderAdapter Interface Export
**Given** `packages/factory/src/llm/types.ts`
**When** imported by another TypeScript module
**Then** it exports a `ProviderAdapter` interface with `complete(request: LLMRequest): Promise<LLMResponse>` and `stream(request: LLMRequest): AsyncIterable<StreamEvent>` methods, plus a `name: string` readonly property and optional `close()`, `initialize()`, and `supportsToolChoice()` methods

### AC2: LLMRequest Type — All Required and Optional Fields
**Given** the `LLMRequest` type
**When** a developer constructs a request object
**Then** the type requires only `model: string` and `messages: LLMMessage[]`, and accepts optional `systemPrompt`, `tools`, `toolChoice`, `maxTokens`, `temperature`, `reasoningEffort`, `metadata`, and `extra: Record<string, unknown>` as the provider-specific escape hatch

### AC3: LLMResponse Type — All Required Fields
**Given** the `LLMResponse` type
**When** a mock adapter implements `complete()` and returns a value
**Then** the returned value must satisfy `content: string`, `toolCalls: LLMToolCall[]`, `usage: LLMUsage`, `model: string`, `stopReason: StopReason`, and `providerMetadata: Record<string, unknown>` — and TypeScript accepts it without errors

### AC4: LLMToolCall Type — Parsed Arguments
**Given** the `LLMToolCall` type
**When** a test object is constructed to represent a tool call extracted from a response
**Then** it contains `id: string`, `name: string`, `arguments: Record<string, unknown>` (parsed JSON), and optional `rawArguments: string`

### AC5: LLMMessage and LLMRole Types
**Given** the `LLMMessage` type and `LLMRole` string-union
**When** conversation messages are constructed for each role
**Then** `LLMMessage` accepts `role: LLMRole`, `content: LLMContentPart[]`, optional `toolCallId: string`, and `LLMRole` includes `'system'`, `'user'`, `'assistant'`, `'tool'` values; TypeScript rejects unknown role strings

### AC6: LLMUsage Token Tracking
**Given** the `LLMUsage` type
**When** populated with token counts from a provider response
**Then** it requires `inputTokens: number`, `outputTokens: number`, `totalTokens: number` and accepts optional `reasoningTokens?: number`, `cacheReadTokens?: number`, `cacheWriteTokens?: number` — omitting optional fields does not cause a TypeScript error

### AC7: Barrel Export and TypeScript Compilation
**Given** `packages/factory/src/llm/index.ts`
**When** built via `npm run build`
**Then** it re-exports all types from `./types.js`, the build produces zero TypeScript errors, and a test file that implements `ProviderAdapter` as a class compiles and passes

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/llm/types.ts` — enums, roles, and content types (AC: #5)
  - [ ] Export `LLMRole` as a const string-union type: `'system' | 'user' | 'assistant' | 'tool'`
  - [ ] Export `StopReason` as a const string-union: `'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other'`
  - [ ] Export `ContentKind` as a const string-union: `'text' | 'tool_call' | 'tool_result' | 'thinking' | 'image'`
  - [ ] Export `LLMToolCallData` (embedded in content parts): `{ id: string; name: string; arguments: Record<string, unknown>; rawArguments?: string }`
  - [ ] Export `LLMToolResultData` (embedded in content parts): `{ toolCallId: string; content: string; isError: boolean }`
  - [ ] Export `LLMContentPart` as a tagged union: `{ kind: ContentKind | string; text?: string; toolCall?: LLMToolCallData; toolResult?: LLMToolResultData }`
  - [ ] Export `LLMMessage` interface: `{ role: LLMRole; content: LLMContentPart[]; toolCallId?: string; name?: string }`

- [ ] Task 2: Define `LLMUsage`, `LLMToolCall`, `LLMToolResult`, and `LLMToolDefinition` in `types.ts` (AC: #4, #6)
  - [ ] Export `LLMUsage` interface: required `inputTokens: number`, `outputTokens: number`, `totalTokens: number`; optional `reasoningTokens?: number`, `cacheReadTokens?: number`, `cacheWriteTokens?: number`
  - [ ] Export `LLMToolCall` (extracted from response for execution, distinct from `LLMToolCallData`): `{ id: string; name: string; arguments: Record<string, unknown>; rawArguments?: string }`
  - [ ] Export `LLMToolResult` (produced after execution): `{ toolCallId: string; content: string | Record<string, unknown>; isError: boolean }`
  - [ ] Export `LLMToolDefinition`: `{ name: string; description: string; parameters: Record<string, unknown> }` — `parameters` is a JSON Schema object

- [ ] Task 3: Define `LLMRequest` in `types.ts` (AC: #2)
  - [ ] Export `LLMToolChoice` as: `'auto' | 'none' | 'required' | { type: 'function'; name: string }`
  - [ ] Export `LLMRequest` interface with required fields: `model: string`, `messages: LLMMessage[]`
  - [ ] Add optional fields: `systemPrompt?: string`, `tools?: LLMToolDefinition[]`, `toolChoice?: LLMToolChoice`, `maxTokens?: number`, `temperature?: number`, `reasoningEffort?: 'low' | 'medium' | 'high'`, `metadata?: Record<string, string>`
  - [ ] Add `extra?: Record<string, unknown>` as the provider escape hatch — stores provider-specific params; each adapter extracts the keys it understands and ignores the rest

- [ ] Task 4: Define `LLMResponse`, `FinishReason`, and `StreamEvent` in `types.ts` (AC: #3)
  - [ ] Export `FinishReason` interface: `{ reason: StopReason; raw?: string }`
  - [ ] Export `LLMResponse` interface with required fields: `content: string`, `toolCalls: LLMToolCall[]`, `usage: LLMUsage`, `model: string`, `stopReason: StopReason`, `providerMetadata: Record<string, unknown>`
  - [ ] Add optional response fields: `id?: string`, `finishReason?: FinishReason`, `warnings?: Array<{ message: string; code?: string }>`
  - [ ] Export `StreamEventType` as a string-union: `'text_delta' | 'reasoning_delta' | 'tool_call_delta' | 'message_start' | 'message_stop' | 'error' | 'usage'`
  - [ ] Export `StreamEvent` interface: `{ type: StreamEventType | string; delta?: string; reasoningDelta?: string; toolCall?: Partial<LLMToolCall>; finishReason?: FinishReason; usage?: LLMUsage; error?: Error; raw?: unknown }`

- [ ] Task 5: Define `ProviderAdapter` interface in `types.ts` (AC: #1)
  - [ ] Export `ProviderAdapter` interface with JSDoc comment referencing `docs/reference/unified-llm-spec.md § 7.1`
  - [ ] Add `readonly name: string` property
  - [ ] Add `complete(request: LLMRequest): Promise<LLMResponse>` method
  - [ ] Add `stream(request: LLMRequest): AsyncIterable<StreamEvent>` method
  - [ ] Add optional methods: `close?(): void | Promise<void>`, `initialize?(): void | Promise<void>`, `supportsToolChoice?(mode: string): boolean`

- [ ] Task 6: Create barrel export in `packages/factory/src/llm/index.ts` (AC: #7)
  - [ ] Write single line: `export * from './types.js'`
  - [ ] Verify the file contains only re-exports, no logic

- [ ] Task 7: Write unit tests and confirm compilation (AC: #1–#7)
  - [ ] Create `packages/factory/src/llm/__tests__/types.test.ts` using vitest
  - [ ] Import all key types from `'../types.js'` using `import type` for interfaces and value imports for any runtime exports
  - [ ] **AC1 test (≥2 cases):** Define a local `MockAdapter` class implementing `ProviderAdapter`; verify `adapter.name` is a string; verify `await adapter.complete(...)` returns a value satisfying `LLMResponse` shape
  - [ ] **AC2 tests (≥2 cases):** Construct a minimal `LLMRequest` (`model` + `messages` only) and verify no TypeScript error; construct a maximal request with all optional fields and verify object shape at runtime using `expect(req).toMatchObject({...})`
  - [ ] **AC3 test (≥1 case):** Construct a mock `LLMResponse` satisfying all required fields; verify all six required fields are present via runtime assertions
  - [ ] **AC4 test (≥1 case):** Construct an `LLMToolCall` object and verify `id`, `name`, `arguments` are present; verify `rawArguments` is optional (omit it and confirm no error)
  - [ ] **AC5 tests (≥2 cases):** Construct `LLMMessage` for each role (`'user'`, `'assistant'`, `'tool'`); verify `content` is an array; verify `LLMContentPart` with `kind: 'text'` and `text` field is valid
  - [ ] **AC6 tests (≥2 cases):** Construct minimal `LLMUsage` (required fields only) and verify it has `inputTokens`, `outputTokens`, `totalTokens`; construct full usage with all optional fields and verify shape
  - [ ] **AC7:** Run `npm run build` first to confirm zero TypeScript errors; then run `npm run test:fast` with `timeout: 300000` and confirm "Test Files" summary line appears with zero failures
  - [ ] Ensure at least 12 `it(...)` cases total
  - [ ] Do NOT pipe test output through `grep`, `head`, `tail`, or any filtering — check raw output for the summary line

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { foo } from './bar.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- `packages/factory/src/llm/types.ts` must have **zero runtime imports** — no `import` from external provider SDKs (Anthropic, OpenAI, Google), no `import` from Node builtins. Pure TypeScript interface/type declarations only.
- No Zod schemas in this story — types only. Zod validation is added by provider adapter stories (48-2, 48-3, 48-4) as needed.
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`) — no Jest globals. No `vi.mock()` needed (no runtime side-effects to mock).

### New File Paths
```
packages/factory/src/llm/types.ts                      — all shared LLM types and ProviderAdapter interface
packages/factory/src/llm/index.ts                      — barrel export (re-exports from types.ts)
packages/factory/src/llm/__tests__/types.test.ts       — unit tests (≥12 test cases)
```

### Key Type Definitions

```typescript
// packages/factory/src/llm/types.ts — no imports required

export type LLMRole = 'system' | 'user' | 'assistant' | 'tool'
export type StopReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error' | 'other'
export type ContentKind = 'text' | 'tool_call' | 'tool_result' | 'thinking' | 'image'

export interface LLMToolCallData {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments?: string
}

export interface LLMToolResultData {
  toolCallId: string
  content: string
  isError: boolean
}

export interface LLMContentPart {
  kind: ContentKind | string
  text?: string
  toolCall?: LLMToolCallData
  toolResult?: LLMToolResultData
}

export interface LLMMessage {
  role: LLMRole
  content: LLMContentPart[]
  toolCallId?: string
  name?: string
}

export interface LLMUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface LLMToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
  rawArguments?: string
}

export interface LLMToolResult {
  toolCallId: string
  content: string | Record<string, unknown>
  isError: boolean
}

export interface LLMToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export type LLMToolChoice =
  | 'auto'
  | 'none'
  | 'required'
  | { type: 'function'; name: string }

export interface LLMRequest {
  model: string
  messages: LLMMessage[]
  systemPrompt?: string
  tools?: LLMToolDefinition[]
  toolChoice?: LLMToolChoice
  maxTokens?: number
  temperature?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
  metadata?: Record<string, string>
  extra?: Record<string, unknown>  // provider escape hatch
}

export interface FinishReason {
  reason: StopReason
  raw?: string
}

export interface LLMResponse {
  content: string
  toolCalls: LLMToolCall[]
  usage: LLMUsage
  model: string
  stopReason: StopReason
  providerMetadata: Record<string, unknown>
  id?: string
  finishReason?: FinishReason
  warnings?: Array<{ message: string; code?: string }>
}

export type StreamEventType =
  | 'text_delta'
  | 'reasoning_delta'
  | 'tool_call_delta'
  | 'message_start'
  | 'message_stop'
  | 'error'
  | 'usage'

export interface StreamEvent {
  type: StreamEventType | string
  delta?: string
  reasoningDelta?: string
  toolCall?: Partial<LLMToolCall>
  finishReason?: FinishReason
  usage?: LLMUsage
  error?: Error
  raw?: unknown
}

/**
 * Layer 1 of the Unified LLM Client spec.
 * Each provider adapter (Anthropic, OpenAI, Gemini) implements this interface.
 * @see docs/reference/unified-llm-spec.md § 7.1
 */
export interface ProviderAdapter {
  readonly name: string
  complete(request: LLMRequest): Promise<LLMResponse>
  stream(request: LLMRequest): AsyncIterable<StreamEvent>
  close?(): void | Promise<void>
  initialize?(): void | Promise<void>
  supportsToolChoice?(mode: string): boolean
}
```

### Test Pattern

```typescript
// packages/factory/src/llm/__tests__/types.test.ts
import { describe, it, expect } from 'vitest'
import type {
  ProviderAdapter,
  LLMRequest,
  LLMResponse,
  LLMMessage,
  LLMUsage,
  LLMToolCall,
  StreamEvent,
} from '../types.js'

// MockAdapter implements ProviderAdapter — TypeScript compile-time verification
class MockAdapter implements ProviderAdapter {
  readonly name = 'mock'

  async complete(request: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'hello',
      toolCalls: [],
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      model: request.model,
      stopReason: 'stop',
      providerMetadata: {},
    }
  }

  async *stream(_request: LLMRequest): AsyncIterable<StreamEvent> {
    yield { type: 'text_delta', delta: 'hello' }
    yield { type: 'message_stop', finishReason: { reason: 'stop' } }
  }
}

describe('ProviderAdapter interface', () => {
  it('MockAdapter satisfies ProviderAdapter at runtime', async () => {
    const adapter: ProviderAdapter = new MockAdapter()
    expect(adapter.name).toBe('mock')
    const response = await adapter.complete({
      model: 'test-model',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'hi' }] }],
    })
    expect(response.content).toBe('hello')
    expect(response.toolCalls).toEqual([])
    expect(response.stopReason).toBe('stop')
  })
  // ... additional cases
})
```

### Spec Field Mapping
Types are mapped from the Unified LLM Client spec (`docs/reference/unified-llm-spec.md`) with TypeScript-idiomatic camelCase names:

| Spec Type       | TypeScript Name    | Notes                                                       |
|-----------------|--------------------|-------------------------------------------------------------|
| `Request`       | `LLMRequest`       | `provider_options` → `extra`; `system` messages → `systemPrompt` |
| `Response`      | `LLMResponse`      | `message.text` → `content`; `finish_reason.reason` → `stopReason`; `raw` → `providerMetadata` |
| `Usage`         | `LLMUsage`         | `input_tokens` → `inputTokens`, etc.                        |
| `ToolCall`      | `LLMToolCall`      | Extracted form for execution; `LLMToolCallData` is embedded in `LLMContentPart` |
| `Message`       | `LLMMessage`       | `tool_call_id` → `toolCallId`                               |
| `StreamEvent`   | `StreamEvent`      | `reasoning_delta` → `reasoningDelta`                        |
| `ProviderAdapter` | `ProviderAdapter` | Layer 1 interface, unchanged name                           |

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`
- Tests are primarily compile-time type-correctness verifications with runtime shape assertions
- No `vi.mock()` needed — pure type-level tests using a local `MockAdapter` class
- Run tests with: `npm run test:fast` — use `timeout: 300000` (5 min) in Bash tool; NEVER pipe output
- Confirm results by checking for "Test Files" summary line in raw output
- Also run `npm run build` before tests to catch TypeScript compilation errors early

## Interface Contracts

- **Export**: `ProviderAdapter` @ `packages/factory/src/llm/types.ts` (consumed by stories 48-2, 48-3, 48-4, 48-5a)
- **Export**: `LLMRequest` @ `packages/factory/src/llm/types.ts` (consumed by stories 48-2, 48-3, 48-4, 48-5a, 48-5b, 48-6, 48-7)
- **Export**: `LLMResponse` @ `packages/factory/src/llm/types.ts` (consumed by stories 48-2, 48-3, 48-4, 48-5a, 48-5b, 48-7)
- **Export**: `LLMMessage`, `LLMRole`, `LLMContentPart` @ `packages/factory/src/llm/types.ts` (consumed by stories 48-2, 48-3, 48-4, 48-7)
- **Export**: `LLMToolCall`, `LLMToolResult`, `LLMToolDefinition` @ `packages/factory/src/llm/types.ts` (consumed by stories 48-6, 48-7)
- **Export**: `LLMUsage` @ `packages/factory/src/llm/types.ts` (consumed by stories 48-5b, 48-10)
- **Export**: `StreamEvent`, `StreamEventType` @ `packages/factory/src/llm/types.ts` (consumed by stories 48-2, 48-3, 48-4, 48-7)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
