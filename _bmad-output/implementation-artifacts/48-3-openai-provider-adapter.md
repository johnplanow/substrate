# Story 48-3: OpenAI Provider Adapter

## Story

As a factory pipeline developer,
I want an `OpenAIAdapter` class that implements `ProviderAdapter` using the OpenAI Responses API,
so that the LLM client can route requests to OpenAI models with correct request translation, response parsing, and reasoning token extraction.

## Acceptance Criteria

### AC1: Adapter Construction and Authentication
**Given** `OPENAI_API_KEY` is set in the environment
**When** `new OpenAIAdapter()` is called (no arguments) or `new OpenAIAdapter({ apiKey, baseUrl, orgId, projectId })` is called
**Then** it initializes with the API key in `Authorization: Bearer` headers, defaults `baseUrl` to `https://api.openai.com/v1`, and additionally reads `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, and `OPENAI_PROJECT_ID` from the environment when not provided explicitly; throws `Error` if no API key is found

### AC2: System Prompt Extraction to `instructions` Parameter
**Given** an `LLMRequest` with `systemPrompt` set to a non-empty string
**When** the adapter builds the Responses API request body
**Then** `systemPrompt` is sent as the `instructions` field at the top level of the request body, and no system-role entry appears in the `input` array

### AC3: Message Array Translation to Responses API `input` Format
**Given** `LLMRequest.messages` containing `user`, `assistant`, and `tool` role messages
**When** the adapter translates them
**Then** user messages become `{ type: "message", role: "user", content: [...] }`, assistant messages become `{ type: "message", role: "assistant", content: [...] }`, and tool-result messages (`LLMRole = "tool"`) become `{ type: "function_call_output", call_id: <toolCallId>, output: <text content> }` entries in the `input` array

### AC4: Tool Definition and Tool Choice Translation
**Given** `LLMRequest.tools` with one or more `LLMToolDefinition` entries and an optional `LLMRequest.toolChoice`
**When** the adapter builds the Responses API request
**Then** each tool becomes `{ type: "function", function: { name, description, parameters } }`, and `toolChoice` maps: `"auto"` → `"auto"`, `"none"` → `"none"`, `"required"` → `"required"`, `{ type: "function", name: "foo" }` → `{ type: "function", function: { name: "foo" } }`

### AC5: `complete()` Returns Normalized `LLMResponse`
**Given** a successful Responses API response with output items (text and/or function calls)
**When** the adapter parses it
**Then** `LLMResponse.content` contains concatenated text from all text output items, `LLMResponse.toolCalls` contains `LLMToolCall[]` with provider-assigned `id`, `name`, and `arguments` (parsed from JSON string), `LLMResponse.model` reflects the model returned by the API, and `LLMResponse.stopReason` is mapped from the response `status` field: `"completed"` → `"stop"`, `"incomplete"` with `incomplete_details.reason = "max_output_tokens"` → `"length"`, tool calls present → `"tool_calls"`, `"content_filter"` → `"content_filter"`

### AC6: Usage Token Extraction Including Reasoning and Cache Tokens
**Given** a Responses API response with a `usage` object
**When** the adapter populates `LLMUsage`
**Then** `inputTokens = usage.input_tokens`, `outputTokens = usage.output_tokens`, `totalTokens = inputTokens + outputTokens`, `reasoningTokens = usage.output_tokens_details?.reasoning_tokens` (omitted when absent), `cacheReadTokens = usage.input_tokens_details?.cached_tokens` (omitted when absent), and automatic prompt caching requires no client-side headers or annotations

### AC7: Reasoning Effort Pass-Through
**Given** `LLMRequest.reasoningEffort` is set to `"low"`, `"medium"`, or `"high"`
**When** the adapter builds the Responses API request body
**Then** the body includes `reasoning: { effort: "<value>" }`, and when `reasoningEffort` is `undefined` the `reasoning` field is omitted entirely from the request body

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/llm/providers/openai.ts` — class skeleton, constructor, and authentication (AC: #1)
  - [ ] Export `OpenAIAdapterOptions` interface: `{ apiKey?: string; baseUrl?: string; orgId?: string; projectId?: string; timeout?: number }`
  - [ ] Export `OpenAIAdapter` class implementing `ProviderAdapter` with `readonly name = 'openai'`
  - [ ] Constructor reads `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` from `process.env` as fallbacks; throws `Error('OPENAI_API_KEY is required')` if no key is found
  - [ ] Store `baseUrl` (stripped trailing slash), default `https://api.openai.com/v1`
  - [ ] Build a `_defaultHeaders()` method that returns `{ 'Authorization': 'Bearer <key>', 'Content-Type': 'application/json', 'OpenAI-Organization': orgId (if set), 'OpenAI-Project': projectId (if set) }`

- [ ] Task 2: Implement `_translateMessages()` — system prompt extraction and input array translation (AC: #2, #3)
  - [ ] If `request.systemPrompt` is set, add it as `instructions` field in the request body; skip any messages with `role === 'system'`
  - [ ] For each `LLMMessage` with `role === 'user'`: emit `{ type: "message", role: "user", content: _translateContentParts(msg.content) }`
  - [ ] For each `LLMMessage` with `role === 'assistant'`: emit `{ type: "message", role: "assistant", content: _translateContentParts(msg.content) }` — include any `tool_call` content parts as `{ type: "function_call", call_id, name, arguments }` items
  - [ ] For each `LLMMessage` with `role === 'tool'`: emit `{ type: "function_call_output", call_id: msg.toolCallId ?? <first toolResult part's toolCallId>, output: <text from first content part> }`
  - [ ] Content part translation: `kind === 'text'` → `{ type: "output_text", text }` for assistant, `{ type: "input_text", text }` for user

- [ ] Task 3: Implement `_translateTools()` — tool definitions and tool choice mapping (AC: #4)
  - [ ] If `request.tools` is set and non-empty, add `tools: request.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }))` to the request body
  - [ ] Map `request.toolChoice`: `"auto"` → `"auto"`, `"none"` → `"none"`, `"required"` → `"required"`, `{ type: "function", name }` → `{ type: "function", function: { name } }`; omit `tool_choice` field entirely when `toolChoice` is undefined

- [ ] Task 4: Implement `complete()` — build request body, send HTTP request, parse response (AC: #5)
  - [ ] Build request body: `{ model: request.model, input: <translated messages>, ...instructions, ...tools, ...tool_choice, max_output_tokens: request.maxTokens, temperature: request.temperature }`
  - [ ] Merge `request.extra` fields into request body (provider escape hatch)
  - [ ] Send `POST {baseUrl}/responses` using Node.js `fetch` with `_defaultHeaders()` and 5 min timeout
  - [ ] On non-2xx HTTP status, parse error body and throw `Error` with provider error message and HTTP status code
  - [ ] Parse response: collect text from `response.output[]` where `type === "message"`, collecting `.content[].text` strings
  - [ ] Parse tool calls from `response.output[]` where `type === "function_call"`: map each to `LLMToolCall { id: item.call_id, name: item.name, arguments: JSON.parse(item.arguments), rawArguments: item.arguments }`
  - [ ] Map `response.status`/`response.incomplete_details` to `StopReason` per AC5 spec
  - [ ] Return `LLMResponse` with all required fields populated; set `providerMetadata: { id: response.id, ...any remaining fields }`

- [ ] Task 5: Implement `_parseUsage()` — token extraction including reasoning and cache (AC: #6)
  - [ ] Accept raw `usage` object from the Responses API response
  - [ ] Map to `LLMUsage`: `inputTokens`, `outputTokens`, `totalTokens = inputTokens + outputTokens`
  - [ ] Conditionally add `reasoningTokens` from `usage.output_tokens_details?.reasoning_tokens` (only when value is present and > 0)
  - [ ] Conditionally add `cacheReadTokens` from `usage.input_tokens_details?.cached_tokens` (only when value is present and > 0)
  - [ ] No cache write tokens for OpenAI (caching is fully automatic server-side)

- [ ] Task 6: Implement reasoning effort pass-through (AC: #7)
  - [ ] In `complete()` request builder, if `request.reasoningEffort` is defined, add `reasoning: { effort: request.reasoningEffort }` to the request body
  - [ ] Verify that when `reasoningEffort` is `undefined`, no `reasoning` key appears in the serialized JSON body

- [ ] Task 7: Implement `stream()` — SSE streaming from Responses API (AC: #5 streaming path)
  - [ ] Send `POST {baseUrl}/responses` with `stream: true` in the request body
  - [ ] Parse Server-Sent Events from the response body using a line-by-line reader
  - [ ] Map `response.output_text.delta` events → `{ type: 'text_delta', delta: event.delta }` StreamEvent
  - [ ] Map `response.function_call_arguments.delta` events → `{ type: 'tool_call_delta', toolCall: { id, name, rawArguments: delta } }` StreamEvent
  - [ ] Map `response.output_item.done` with function_call → `{ type: 'tool_call_delta', toolCall: { id, name, arguments: JSON.parse(item.arguments) } }` StreamEvent
  - [ ] Map `response.completed` → `{ type: 'message_stop', usage: _parseUsage(event.response.usage), finishReason: { reason: <mapped stop reason> } }` StreamEvent
  - [ ] Yield `{ type: 'message_start' }` on first event

- [ ] Task 8: Write unit tests in `packages/factory/src/llm/providers/__tests__/openai.test.ts` (AC: #1–#7)
  - [ ] Use vitest (`describe`, `it`, `expect`, `vi`); mock `global.fetch` with `vi.stubGlobal`
  - [ ] **AC1 tests (≥2 cases):** Verify constructor reads `OPENAI_API_KEY` from env; verify it throws when no key is present; verify explicit `apiKey` option overrides env var
  - [ ] **AC2 test (≥1 case):** Capture the fetch body and assert `instructions === systemPrompt` and no system entry in `input`
  - [ ] **AC3 tests (≥2 cases):** Assert user → `{ type:"message", role:"user" }`, assert tool-result → `{ type:"function_call_output", call_id, output }`
  - [ ] **AC4 test (≥1 case):** Assert tool definition format; assert `tool_choice: "required"` maps correctly
  - [ ] **AC5 tests (≥2 cases):** Mock a response with one text output item — verify `content`, `stopReason: "stop"`, and correct `model`; mock a response with one function_call item — verify `toolCalls[0].id`, `toolCalls[0].name`, `toolCalls[0].arguments`
  - [ ] **AC6 tests (≥2 cases):** Mock usage with `output_tokens_details.reasoning_tokens: 500` — verify `reasoningTokens: 500`; mock usage without reasoning details — verify `reasoningTokens` is absent from returned `LLMUsage`
  - [ ] **AC7 test (≥1 case):** Capture fetch body with `reasoningEffort: "high"` set — verify `body.reasoning.effort === "high"`; capture with `reasoningEffort` undefined — verify `"reasoning"` key is absent
  - [ ] Ensure at least 12 `it(...)` cases total
  - [ ] Run `npm run build` first, then `npm run test:fast` with `timeout: 300000`; check for "Test Files" summary line; NEVER pipe output

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { foo } from '../types.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- Import shared types from `'../types.js'` (the barrel in `packages/factory/src/llm/index.ts`)
- **MUST target the Responses API** (`POST /v1/responses`), NOT the Chat Completions API (`/v1/chat/completions`). This is a critical architectural requirement per `docs/reference/unified-llm-spec.md § 2.7`.
- Use Node.js native `fetch` (built-in since Node 18) for HTTP calls — do NOT add the `openai` npm SDK as a dependency. Direct HTTP gives full control over the Responses API request format and avoids SDK version coupling.
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals

### New File Paths
```
packages/factory/src/llm/providers/openai.ts                    — OpenAI Responses API adapter
packages/factory/src/llm/providers/__tests__/openai.test.ts     — unit tests (≥12 test cases)
```

### OpenAI Responses API Request Body Shape

```typescript
// POST https://api.openai.com/v1/responses
interface ResponsesAPIRequest {
  model: string                          // e.g., "gpt-5.2"
  input: ResponsesAPIInputItem[]         // translated messages
  instructions?: string                  // system prompt
  tools?: ResponsesAPITool[]             // tool definitions
  tool_choice?: string | object          // "auto" | "none" | "required" | {type:"function",...}
  max_output_tokens?: number             // maps to LLMRequest.maxTokens
  temperature?: number
  reasoning?: { effort: 'low' | 'medium' | 'high' }  // only when reasoningEffort is set
  stream?: boolean                       // true for stream()
  // extra fields from LLMRequest.extra are merged in
}

type ResponsesAPIInputItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: ResponsesAPIContentPart[] }
  | { type: 'function_call_output'; call_id: string; output: string }

interface ResponsesAPITool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}
```

### OpenAI Responses API Response Shape

```typescript
// Partial shape — only fields the adapter uses
interface ResponsesAPIResponse {
  id: string
  model: string
  status: 'completed' | 'incomplete' | 'in_progress' | 'failed' | 'cancelled'
  incomplete_details?: { reason: 'max_output_tokens' | 'content_filter' }
  output: ResponsesAPIOutputItem[]
  usage: {
    input_tokens: number
    output_tokens: number
    input_tokens_details?: { cached_tokens?: number }
    output_tokens_details?: { reasoning_tokens?: number }
  }
}

type ResponsesAPIOutputItem =
  | { type: 'message'; role: 'assistant'; content: Array<{ type: 'output_text'; text: string }> }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
```

### Stop Reason Mapping

| `response.status` | `incomplete_details.reason` | Tool calls present | `StopReason` |
|---|---|---|---|
| `"completed"` | — | no | `"stop"` |
| `"completed"` | — | yes | `"tool_calls"` |
| `"incomplete"` | `"max_output_tokens"` | — | `"length"` |
| `"incomplete"` | `"content_filter"` | — | `"content_filter"` |
| other | — | — | `"other"` |

### SSE Streaming Events (Responses API)

```
event: response.created                  → yield { type: 'message_start' }
event: response.output_text.delta        → yield { type: 'text_delta', delta: event.delta }
event: response.function_call_arguments.delta → yield { type: 'tool_call_delta', toolCall: { rawArguments: event.delta } }
event: response.output_item.done         → yield { type: 'tool_call_delta', toolCall: { id, name, arguments: JSON.parse } }  (when type=function_call)
event: response.completed                → yield { type: 'message_stop', usage: ..., finishReason: ... }
```

### Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENAI_API_KEY` | Yes (unless passed explicitly) | — | API authentication |
| `OPENAI_BASE_URL` | No | `https://api.openai.com/v1` | Custom endpoint (e.g. Azure, proxy) |
| `OPENAI_ORG_ID` | No | — | OpenAI organization ID header |
| `OPENAI_PROJECT_ID` | No | — | OpenAI project ID header |

### Test Pattern

```typescript
// packages/factory/src/llm/providers/__tests__/openai.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenAIAdapter } from '../openai.js'

function makeMockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

describe('OpenAIAdapter', () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = 'sk-test-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env.OPENAI_API_KEY
    vi.unstubAllGlobals()
  })

  it('constructs with OPENAI_API_KEY from env', () => {
    const adapter = new OpenAIAdapter()
    expect(adapter.name).toBe('openai')
  })

  it('throws when no API key is available', () => {
    delete process.env.OPENAI_API_KEY
    expect(() => new OpenAIAdapter()).toThrow('OPENAI_API_KEY')
  })

  it('sends systemPrompt as instructions, not in input array', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse({
      id: 'resp_1', model: 'gpt-5.2', status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello' }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }))
    const adapter = new OpenAIAdapter()
    await adapter.complete({
      model: 'gpt-5.2',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hi' }] }],
      systemPrompt: 'You are helpful.',
    })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.instructions).toBe('You are helpful.')
    expect(body.input.every((item: { role?: string }) => item.role !== 'system')).toBe(true)
  })

  // ... additional tests
})
```

### Key Implementation Patterns
- Never retry inside the adapter itself — retry middleware is handled at the `LLMClient` layer (story 48-5b)
- Parse JSON arguments defensively: wrap in try/catch; if `JSON.parse` fails, set `arguments: {}` and preserve `rawArguments`
- For content translation, only handle `kind === 'text'` in this story — image/tool_call content parts will be extended in story 48-6
- Keep SSE parser simple: split response body by `\n`, accumulate `data:` lines, parse JSON

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- Use `vi.stubGlobal('fetch', vi.fn())` to mock HTTP calls — no real network calls in tests
- Run `npm run build` first to catch TypeScript errors, then `npm run test:fast` with `timeout: 300000`
- NEVER pipe test output through `grep`, `head`, `tail`, or any filtering — check raw output for "Test Files" summary line
- Confirm zero TypeScript errors before marking done

## Interface Contracts

- **Import**: `ProviderAdapter`, `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMContentPart`, `LLMToolCall`, `LLMUsage`, `StreamEvent`, `StopReason` @ `packages/factory/src/llm/types.ts` (from story 48-1)
- **Export**: `OpenAIAdapter` @ `packages/factory/src/llm/providers/openai.ts` (consumed by story 48-5a for provider registration)
- **Export**: `OpenAIAdapterOptions` @ `packages/factory/src/llm/providers/openai.ts` (consumed by story 48-5a)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
