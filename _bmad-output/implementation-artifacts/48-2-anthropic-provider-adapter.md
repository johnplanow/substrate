# Story 48-2: Anthropic Provider Adapter

## Story

As a factory pipeline developer,
I want an `AnthropicAdapter` that implements `ProviderAdapter` using the Anthropic Messages API,
so that the unified LLM client can call Claude models with correct message alternation, prompt caching, and retry behavior without any provider-specific logic leaking into callers.

## Acceptance Criteria

### AC1: Complete Request Returns Normalized LLMResponse
**Given** an `AnthropicAdapter` constructed with `ANTHROPIC_API_KEY`
**When** `complete(request)` is called with a valid `LLMRequest`
**Then** it sends an HTTP POST to the Anthropic Messages API (`/v1/messages`) and returns a normalized `LLMResponse` with `content`, `toolCalls`, `usage`, `model`, `stopReason`, and `providerMetadata` populated

### AC2: Strict Message Alternation Enforcement
**Given** an `LLMRequest` containing consecutive same-role messages (e.g., two consecutive `user` messages)
**When** the adapter translates messages for the Anthropic API
**Then** it merges consecutive same-role messages by concatenating their `content` arrays before sending — the API request never contains two adjacent messages with the same role

### AC3: max_tokens Default Injection
**Given** an `LLMRequest` where `maxTokens` is not specified
**When** the adapter builds the Anthropic request body
**Then** the request body contains `max_tokens: 4096` (Anthropic requires this field — absence causes a 400 error)

### AC4: 429 Retry with Exponential Backoff
**Given** the Anthropic API responds with HTTP 429 (rate limit) with a `Retry-After: 2` header
**When** the adapter receives this response
**Then** it waits at least the `Retry-After` duration, retries up to 3 times with exponential backoff, and eventually returns a successful `LLMResponse` if a subsequent attempt succeeds (or throws after max retries)

### AC5: Automatic Prompt Caching via cache_control
**Given** an `LLMRequest` with a `systemPrompt` and `auto_cache` is not explicitly disabled via `request.extra`
**When** the adapter builds the Anthropic request body
**Then** the system content block has `cache_control: { type: "ephemeral" }` appended, and the `anthropic-beta` request header includes `prompt-caching-2024-07-31`

### AC6: Tool Definition Translation
**Given** an `LLMRequest` with `tools` containing `LLMToolDefinition` objects
**When** the adapter translates the request
**Then** each tool is formatted as `{ name, description, input_schema: parameters }` (Anthropic's native format), and if `toolChoice` is `'none'`, the tools array is omitted entirely from the request body (Anthropic does not support `tool_choice: none` with tools present)

### AC7: Stop Reason and Usage Mapping
**Given** an Anthropic API response with `stop_reason: "tool_use"` and cache usage fields
**When** the adapter parses the response
**Then** `LLMResponse.stopReason` is `'tool_calls'`, `LLMResponse.usage.cacheReadTokens` is populated from `cache_read_input_tokens`, and `LLMResponse.usage.cacheWriteTokens` is populated from `cache_creation_input_tokens`

## Tasks / Subtasks

- [ ] Task 1: Create `AnthropicAdapter` class scaffold and request body builder (AC: #1, #3)
  - [ ] Create `packages/factory/src/llm/providers/anthropic.ts`
  - [ ] Export `AnthropicAdapterOptions` interface: `{ apiKey: string; baseUrl?: string; fetch?: typeof globalThis.fetch; anthropicVersion?: string }`
  - [ ] Export `AnthropicAdapter` class implementing `ProviderAdapter` with `readonly name = 'anthropic'`
  - [ ] Implement `buildRequestBody(request: LLMRequest): AnthropicRequestBody` private method that maps `LLMRequest` to Anthropic API format
  - [ ] Extract `systemPrompt` to the Anthropic `system` parameter (array of content blocks, not a string); if `request.systemPrompt` is present, create a text content block `{ type: "text", text: systemPrompt }`
  - [ ] Set `max_tokens` to `request.maxTokens ?? 4096`
  - [ ] Map `request.temperature` to `temperature` field (omit if undefined)
  - [ ] Map `request.reasoningEffort` to `thinking.budget_tokens` heuristic (low→1024, medium→8096, high→32000) and include `thinking: { type: "enabled", budget_tokens: N }` if set

- [ ] Task 2: Message translation with strict alternation enforcement (AC: #2)
  - [ ] Implement `translateMessages(messages: LLMMessage[]): AnthropicMessage[]` private method
  - [ ] Filter out `role: 'system'` messages (they're handled via the `system` parameter)
  - [ ] Map `role: 'tool'` messages to `role: 'user'` with `tool_result` content blocks: `{ type: "tool_result", tool_use_id: part.toolResult!.toolCallId, content: part.toolResult!.content, is_error: part.toolResult!.isError }`
  - [ ] Translate content parts: `kind: 'text'` → `{ type: "text", text }`, `kind: 'tool_call'` → `{ type: "tool_use", id, name, input: arguments }`, `kind: 'tool_result'` → tool_result block
  - [ ] Merge consecutive same-role messages: after initial translation, scan the array and combine adjacent messages with the same role by spreading their `content` arrays together

- [ ] Task 3: Tool definition translation and toolChoice handling (AC: #6)
  - [ ] Implement `translateTools(tools: LLMToolDefinition[]): AnthropicTool[]` private method: each tool → `{ name, description, input_schema: parameters }`
  - [ ] Handle `toolChoice` mapping: `'auto'` → `{ type: "auto" }`, `'required'` → `{ type: "any" }`, specific tool → `{ type: "tool", name }`. Do NOT map `'none'` — when `toolChoice === 'none'`, omit `tools` and `tool_choice` from request body entirely
  - [ ] Extract `beta_headers` from `request.extra?.anthropic?.beta_headers` (array of strings) and merge into `anthropic-beta` header

- [ ] Task 4: Prompt caching injection (AC: #5)
  - [ ] Read `autoCache` flag: `request.extra?.anthropic?.auto_cache !== false` (default true)
  - [ ] When `autoCache` is true and `systemPrompt` is present: append `cache_control: { type: "ephemeral" }` to the last system content block
  - [ ] When `autoCache` is true and `tools` are present: append `cache_control: { type: "ephemeral" }` to the last tool definition
  - [ ] Automatically add `prompt-caching-2024-07-31` to the `anthropic-beta` header when any `cache_control` is injected
  - [ ] Keep caching injection idempotent: if a block already has `cache_control`, do not add another

- [ ] Task 5: Response parsing — content extraction, stop reason mapping, usage (AC: #1, #7)
  - [ ] Implement `parseResponse(raw: AnthropicRawResponse, model: string): LLMResponse` private method
  - [ ] Extract text content: concatenate all `{ type: "text" }` block texts into `LLMResponse.content`
  - [ ] Extract tool calls: for each `{ type: "tool_use" }` block, create `LLMToolCall { id, name, arguments: block.input, rawArguments: JSON.stringify(block.input) }`
  - [ ] Map stop reasons: `"end_turn"` → `'stop'`, `"stop_sequence"` → `'stop'`, `"max_tokens"` → `'length'`, `"tool_use"` → `'tool_calls'`; anything else → `'other'`
  - [ ] Map usage: `input_tokens → inputTokens`, `output_tokens → outputTokens`, `(input_tokens + output_tokens) → totalTokens`, `cache_read_input_tokens → cacheReadTokens`, `cache_creation_input_tokens → cacheWriteTokens`
  - [ ] Store the full raw response in `providerMetadata: { raw }`

- [ ] Task 6: HTTP request execution and 429 retry logic (AC: #1, #4)
  - [ ] Implement `complete(request: LLMRequest): Promise<LLMResponse>` using the injected (or global) `fetch`
  - [ ] Build headers: `Content-Type: application/json`, `x-api-key: <apiKey>`, `anthropic-version: <version ?? "2023-06-01">`, and computed `anthropic-beta` if any betas apply
  - [ ] Implement retry loop: max 3 attempts with exponential backoff (1s, 2s, 4s base, respect `Retry-After` header when present)
  - [ ] On HTTP error (non-2xx), parse error body and throw `Error` with message `[anthropic] <status>: <error.message>` — include the raw response in the error for debugging
  - [ ] Implement `stream(request: LLMRequest): AsyncIterable<StreamEvent>` using SSE — add `stream: true` to request body and parse `data: {...}` lines into `StreamEvent` objects; yield `text_delta`, `tool_call_delta`, `message_stop` events; detailed streaming implementation may be deferred with a `// TODO: streaming` comment and `throw new Error('streaming not yet implemented')` as a placeholder

- [ ] Task 7: Write unit tests (AC: #1–#7)
  - [ ] Create `packages/factory/src/llm/providers/__tests__/anthropic.test.ts` using vitest
  - [ ] Use a mock `fetch` function (injected via `AnthropicAdapterOptions.fetch`) — do NOT make real HTTP calls
  - [ ] **AC1 tests (≥2 cases):** Mock fetch returns a valid Messages API response; verify `LLMResponse` shape (all required fields present); verify `providerMetadata.raw` is the raw response
  - [ ] **AC2 tests (≥2 cases):** Provide two consecutive `user` messages; verify the sent request body has exactly one merged user message with combined content; provide user/assistant/user sequence; verify no merging occurs
  - [ ] **AC3 test (≥1 case):** Omit `maxTokens` in request; capture fetch call body; verify `max_tokens === 4096` in the serialized body
  - [ ] **AC4 tests (≥2 cases):** Mock fetch returns 429 with `Retry-After: 0` on first call, then success; verify the adapter retried and returned the successful response; mock 3 consecutive 429s; verify the adapter throws after max retries
  - [ ] **AC5 tests (≥2 cases):** Provide `systemPrompt`; verify the system block has `cache_control: { type: "ephemeral" }`; verify `anthropic-beta` header includes `prompt-caching-2024-07-31`; set `request.extra = { anthropic: { auto_cache: false } }`; verify no `cache_control` is injected
  - [ ] **AC6 tests (≥2 cases):** Provide tools; verify they appear in the request body as `{ name, description, input_schema }`; set `toolChoice: 'none'`; verify `tools` is absent from the request body
  - [ ] **AC7 tests (≥2 cases):** Mock response with `stop_reason: "tool_use"` and `cache_read_input_tokens: 500`; verify `stopReason === 'tool_calls'` and `usage.cacheReadTokens === 500`
  - [ ] Ensure at least 15 `it(...)` cases total
  - [ ] Run `npm run build` first to confirm zero TypeScript errors; then run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line appears with zero failures
  - [ ] Do NOT pipe test output through `grep`, `head`, `tail`, or any filtering

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { LLMRequest } from '../types.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- Do NOT import the `@anthropic-ai/sdk` npm package — the adapter calls the Anthropic HTTP API directly using the injected or global `fetch`. This avoids an SDK dependency and keeps the adapter testable with a mock fetch.
- `fetch` is injected via `AnthropicAdapterOptions.fetch` for testability — never call `global.fetch` directly in the implementation; always use `this.fetch` (set in constructor from options, falling back to `globalThis.fetch`)
- Tests belong in `packages/factory/src/llm/providers/__tests__/anthropic.test.ts`
- Use `vitest` (`describe`, `it`, `expect`) — no Jest globals

### New File Paths
```
packages/factory/src/llm/providers/anthropic.ts            — AnthropicAdapter implementation
packages/factory/src/llm/providers/__tests__/
    anthropic.test.ts                                       — unit tests (≥15 test cases)
```

### Anthropic API Reference

**Endpoint:** `POST https://api.anthropic.com/v1/messages`

**Required headers:**
```
Content-Type: application/json
x-api-key: <ANTHROPIC_API_KEY>
anthropic-version: 2023-06-01
anthropic-beta: prompt-caching-2024-07-31   (when cache_control is present)
```

**Request body shape:**
```typescript
interface AnthropicRequestBody {
  model: string
  max_tokens: number                       // required, default 4096
  messages: AnthropicMessage[]
  system?: AnthropicContentBlock[]         // extracted from systemPrompt
  tools?: AnthropicTool[]                  // omit when toolChoice === 'none'
  tool_choice?: AnthropicToolChoice
  temperature?: number
  stream?: boolean
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: AnthropicContentBlock[]
}

type AnthropicContentBlock =
  | { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown>; cache_control?: { type: 'ephemeral' } }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }

interface AnthropicTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  cache_control?: { type: 'ephemeral' }
}

type AnthropicToolChoice =
  | { type: 'auto' }
  | { type: 'any' }
  | { type: 'tool'; name: string }
```

**Response body shape:**
```typescript
interface AnthropicRawResponse {
  id: string
  type: 'message'
  role: 'assistant'
  content: AnthropicContentBlock[]
  model: string
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | string
  stop_sequence: string | null
  usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  }
}
```

### Stop Reason Mapping
| Anthropic `stop_reason` | `LLMResponse.stopReason` |
|-------------------------|--------------------------|
| `end_turn`              | `'stop'`                 |
| `stop_sequence`         | `'stop'`                 |
| `max_tokens`            | `'length'`               |
| `tool_use`              | `'tool_calls'`           |
| *(anything else)*       | `'other'`                |

### Prompt Caching Heuristic
The default caching strategy (when `auto_cache !== false`) is:
1. Apply `cache_control: { type: "ephemeral" }` to the **last** system content block (the stable system prompt prefix)
2. Apply `cache_control: { type: "ephemeral" }` to the **last** tool definition (the stable tool schema prefix)
3. Add `prompt-caching-2024-07-31` to `anthropic-beta` whenever any `cache_control` is injected

This ensures the system prompt and tool definitions are cached across turns, providing up to 90% cost reduction for repeated inputs in agentic workloads.

### Retry Logic
```typescript
const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000

for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
  const response = await this.fetch(url, options)
  if (response.status === 429) {
    if (attempt === MAX_RETRIES) throw new Error(`[anthropic] Rate limit exceeded after ${MAX_RETRIES} retries`)
    const retryAfter = parseInt(response.headers.get('Retry-After') ?? '1', 10) * 1000
    const backoff = Math.max(retryAfter, BASE_DELAY_MS * 2 ** attempt)
    await new Promise(resolve => setTimeout(resolve, backoff))
    continue
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new Error(`[anthropic] ${response.status}: ${body?.error?.message ?? response.statusText}`)
  }
  const raw = await response.json()
  return this.parseResponse(raw, request.model)
}
```

### Testing Pattern (Mock Fetch)
```typescript
// packages/factory/src/llm/providers/__tests__/anthropic.test.ts
import { describe, it, expect, vi } from 'vitest'
import { AnthropicAdapter } from '../anthropic.js'

function makeMockFetch(response: object, status = 200): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => null },
    json: () => Promise.resolve(response),
  } as unknown as Response)
}

const MOCK_RESPONSE = {
  id: 'msg_123',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'Hello, world!' }],
  model: 'claude-sonnet-4-5',
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
}

describe('AnthropicAdapter', () => {
  it('returns normalized LLMResponse on success', async () => {
    const mockFetch = makeMockFetch(MOCK_RESPONSE)
    const adapter = new AnthropicAdapter({ apiKey: 'test-key', fetch: mockFetch })
    const response = await adapter.complete({
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hello' }] }],
    })
    expect(response.content).toBe('Hello, world!')
    expect(response.stopReason).toBe('stop')
    expect(response.usage.inputTokens).toBe(10)
    expect(response.usage.outputTokens).toBe(5)
    expect(response.usage.totalTokens).toBe(15)
  })
  // ... additional cases
})
```

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- Use mock `fetch` (injected via options) — no real HTTP calls in tests
- Test the request body sent to fetch using `vi.fn()` and inspecting call args: `mockFetch.mock.calls[0][1].body`
- Run tests with: `npm run test:fast` — use `timeout: 300000` (5 min) in Bash tool; NEVER pipe output
- Also run `npm run build` before tests to catch TypeScript compilation errors
- Confirm results by checking for "Test Files" summary line in raw output

## Interface Contracts

- **Import**: `ProviderAdapter`, `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMContentPart`, `LLMToolCall`, `LLMToolDefinition`, `StreamEvent`, `StopReason` @ `packages/factory/src/llm/types.ts` (from story 48-1)
- **Export**: `AnthropicAdapter` @ `packages/factory/src/llm/providers/anthropic.ts` (consumed by story 48-5a for adapter registration)
- **Export**: `AnthropicAdapterOptions` @ `packages/factory/src/llm/providers/anthropic.ts` (consumed by story 48-5a)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
