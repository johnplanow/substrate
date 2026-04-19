# Story 48-4: Gemini Provider Adapter

## Story

As a factory pipeline developer,
I want a `GeminiAdapter` class that implements `ProviderAdapter` using the native Gemini API,
so that the LLM client can route requests to Gemini models with correct request translation, synthetic tool call ID generation, response parsing, and usage extraction.

## Acceptance Criteria

### AC1: Adapter Construction and Authentication
**Given** `GEMINI_API_KEY` (or `GOOGLE_API_KEY` as fallback) is set in the environment
**When** `new GeminiAdapter()` is called (no arguments) or `new GeminiAdapter({ apiKey, baseUrl })` is called
**Then** it initializes with the API key stored for use as the `key` query parameter, defaults `baseUrl` to `https://generativelanguage.googleapis.com`, reads `GEMINI_API_KEY` first and `GOOGLE_API_KEY` as a fallback from the environment when no explicit `apiKey` is provided, and throws `Error` if no API key is found

### AC2: System Prompt Extraction to `systemInstruction`
**Given** an `LLMRequest` with `systemPrompt` set to a non-empty string
**When** the adapter builds the Gemini API request body
**Then** `systemPrompt` is sent as `systemInstruction: { parts: [{ text: systemPrompt }] }` at the top level of the request body, and no system-role entry appears in the `contents` array

### AC3: Message Array Translation to Gemini `contents` Format
**Given** `LLMRequest.messages` containing `user`, `assistant`, and `tool` role messages
**When** the adapter translates them
**Then** user messages become `{ role: "user", parts: [...] }`, assistant messages become `{ role: "model", parts: [...] }`, and tool-result messages (`LLMRole = "tool"`) become `{ role: "user", parts: [{ functionResponse: { name: <functionName>, response: <responseDict> } }] }` entries in the `contents` array; text content parts become `{ text: "..." }` Gemini parts, and tool-call content parts become `{ functionCall: { name, args } }` Gemini parts

### AC4: Synthetic Tool Call ID Generation and Function Name Mapping
**Given** a Gemini API response containing `functionCall` parts (which have no provider-assigned IDs)
**When** the adapter parses the response
**Then** it generates a synthetic unique ID of the form `"call_" + randomUUID()` for each function call, populates `LLMToolCall.id` with this synthetic ID, and internally maintains a per-request mapping from synthetic ID to function name so that subsequent tool-result messages (which reference the synthetic ID) can be translated back to the function name required by Gemini's `functionResponse` format

### AC5: `complete()` Returns Normalized `LLMResponse` with Correct Stop Reason
**Given** a successful Gemini API response with candidate content
**When** the adapter parses it
**Then** `LLMResponse.content` contains concatenated text from all non-thought text parts in `candidates[0].content.parts`, `LLMResponse.toolCalls` contains `LLMToolCall[]` with synthetic IDs and parsed `arguments` from `functionCall.args`, `LLMResponse.stopReason` is mapped from `candidates[0].finishReason`: `"STOP"` → `"stop"`, `"MAX_TOKENS"` → `"length"`, `"SAFETY"` or `"RECITATION"` → `"content_filter"`, absent or `null` when function calls are present → `"tool_calls"`, and `LLMResponse.model` reflects the model name from the request

### AC6: Usage Token Extraction Including Reasoning and Cache Tokens
**Given** a Gemini API response with a `usageMetadata` object
**When** the adapter populates `LLMUsage`
**Then** `inputTokens = usageMetadata.promptTokenCount`, `outputTokens = usageMetadata.candidatesTokenCount`, `totalTokens = inputTokens + outputTokens`, `reasoningTokens = usageMetadata.thoughtsTokenCount` (omitted when absent or zero), `cacheReadTokens = usageMetadata.cachedContentTokenCount` (omitted when absent or zero), and no cache write tokens are emitted (Gemini caching is fully automatic)

### AC7: Tool Definition Translation and Tool Choice Mapping
**Given** `LLMRequest.tools` with one or more `LLMToolDefinition` entries and an optional `LLMRequest.toolChoice`
**When** the adapter builds the Gemini API request
**Then** tools are grouped as `[{ functionDeclarations: [{ name, description, parameters }] }]`, and `toolChoice` maps: `"auto"` → `toolConfig: { functionCallingConfig: { mode: "AUTO" } }`, `"none"` → `toolConfig: { functionCallingConfig: { mode: "NONE" } }`, `"required"` → `toolConfig: { functionCallingConfig: { mode: "ANY" } }`, `{ type: "function", name: "foo" }` → `toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["foo"] } }`; when `toolChoice` is undefined and tools are present the `toolConfig` field is omitted

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/llm/providers/gemini.ts` — class skeleton, constructor, and authentication (AC: #1)
  - [ ] Export `GeminiAdapterOptions` interface: `{ apiKey?: string; baseUrl?: string; timeout?: number }`
  - [ ] Export `GeminiAdapter` class implementing `ProviderAdapter` with `readonly name = 'gemini'`
  - [ ] Constructor reads `GEMINI_API_KEY` first, then `GOOGLE_API_KEY` from `process.env` as fallbacks; throws `Error('GEMINI_API_KEY is required')` if no key is found
  - [ ] Store `baseUrl` (stripped trailing slash), default `https://generativelanguage.googleapis.com`
  - [ ] Build a `_buildUrl(model: string, streaming: boolean): string` helper that returns `{baseUrl}/v1beta/models/{model}:{streaming ? 'streamGenerateContent' : 'generateContent'}?key={apiKey}` (append `&alt=sse` for streaming)

- [ ] Task 2: Implement `_translateMessages()` — system prompt extraction and contents array translation (AC: #2, #3)
  - [ ] If `request.systemPrompt` is set, add `systemInstruction: { parts: [{ text: request.systemPrompt }] }` to the request body; skip any messages with `role === 'system'`
  - [ ] For each `LLMMessage` with `role === 'user'`: emit `{ role: "user", parts: _translateParts(msg.content) }`
  - [ ] For each `LLMMessage` with `role === 'assistant'`: emit `{ role: "model", parts: _translateParts(msg.content) }`
  - [ ] For each `LLMMessage` with `role === 'tool'`: emit `{ role: "user", parts: [{ functionResponse: { name: <lookupFunctionName(msg.toolCallId)>, response: _wrapResponse(<text content>) } }] }`
  - [ ] Content part translation: `kind === 'text'` → `{ text }`, `kind === 'tool_call'` → `{ functionCall: { name, args: toolCall.arguments } }`
  - [ ] `_wrapResponse(content)`: if content is a string, return `{ result: content }`; if it parses as an object, return the parsed object directly
  - [ ] `_lookupFunctionName(id)`: look up function name from the per-request ID→name mapping (built during the current request's tool call parsing); throw descriptive error if not found

- [ ] Task 3: Implement `_translateTools()` — tool definitions and tool choice mapping (AC: #7)
  - [ ] If `request.tools` is set and non-empty, add `tools: [{ functionDeclarations: request.tools.map(t => ({ name: t.name, description: t.description, parameters: t.parameters })) }]` to the request body
  - [ ] Map `request.toolChoice`: `"auto"` → `toolConfig: { functionCallingConfig: { mode: "AUTO" } }`, `"none"` → `toolConfig: { functionCallingConfig: { mode: "NONE" } }`, `"required"` → `toolConfig: { functionCallingConfig: { mode: "ANY" } }`, `{ type: "function", name }` → `toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: [name] } }`; omit `toolConfig` entirely when `toolChoice` is undefined
  - [ ] Add `generationConfig.maxOutputTokens = request.maxTokens` when set
  - [ ] Add `generationConfig.temperature = request.temperature` when set
  - [ ] Merge `request.extra` fields into the request body as the provider escape hatch

- [ ] Task 4: Implement `complete()` — build request body, send HTTP request, parse response, generate synthetic IDs (AC: #4, #5)
  - [ ] Build request body with translated contents, systemInstruction, tools, toolConfig, generationConfig
  - [ ] Send `POST _buildUrl(request.model, false)` using Node.js `fetch` with `Content-Type: application/json` and 5 min timeout; API key is in the URL as `?key=` (no Authorization header)
  - [ ] On non-2xx HTTP status, parse error body and throw `Error('[gemini] <status>: <error.message>')`
  - [ ] Parse `candidates[0].content.parts`: collect text from parts where `text` is present and `thought !== true`; collect function calls from parts where `functionCall` is present
  - [ ] For each `functionCall` part: generate synthetic ID via `crypto.randomUUID()` (Node 19+) or `require('crypto').randomUUID()`; store `{ [syntheticId]: functionCall.name }` in a per-request Map; create `LLMToolCall { id: syntheticId, name: functionCall.name, arguments: functionCall.args ?? {}, rawArguments: JSON.stringify(functionCall.args) }`
  - [ ] Map `candidates[0].finishReason` to `StopReason` per AC5 spec (infer `"tool_calls"` when function calls are present and finishReason is absent or non-terminal)
  - [ ] Return `LLMResponse` with all required fields; set `providerMetadata: { model: response.modelVersion ?? request.model, ...any remaining fields }`

- [ ] Task 5: Implement `_parseUsage()` — Gemini usageMetadata extraction (AC: #6)
  - [ ] Accept raw `usageMetadata` object from the Gemini response
  - [ ] Map to `LLMUsage`: `inputTokens = usageMetadata.promptTokenCount ?? 0`, `outputTokens = usageMetadata.candidatesTokenCount ?? 0`, `totalTokens = inputTokens + outputTokens`
  - [ ] Conditionally add `reasoningTokens` from `usageMetadata.thoughtsTokenCount` (only when present and > 0)
  - [ ] Conditionally add `cacheReadTokens` from `usageMetadata.cachedContentTokenCount` (only when present and > 0)
  - [ ] No cache write tokens for Gemini (prefix caching is fully automatic server-side)

- [ ] Task 6: Implement `stream()` — SSE streaming from Gemini API (AC: #5 streaming path)
  - [ ] Send `POST _buildUrl(request.model, true)` (URL includes `?alt=sse`) with same request body as `complete()`
  - [ ] Parse SSE lines from the response body: split by newlines, accumulate `data:` lines, parse JSON
  - [ ] Yield `{ type: 'message_start' }` on first chunk received
  - [ ] For each chunk with `candidates[0].content.parts[].text` (non-thought): yield `{ type: 'text_delta', delta: part.text }`
  - [ ] For each chunk with `candidates[0].content.parts[].functionCall`: generate synthetic ID, yield `{ type: 'tool_call_delta', toolCall: { id, name, arguments: part.functionCall.args } }` (Gemini delivers function calls whole, not incrementally)
  - [ ] On final chunk (when `usageMetadata` is present): yield `{ type: 'message_stop', usage: _parseUsage(chunk.usageMetadata), finishReason: { reason: <mapped stop reason> } }`

- [ ] Task 7: Write unit tests in `packages/factory/src/llm/providers/__tests__/gemini.test.ts` (AC: #1–#7)
  - [ ] Use vitest (`describe`, `it`, `expect`, `vi`); mock `global.fetch` with `vi.stubGlobal`
  - [ ] **AC1 tests (≥2 cases):** Verify constructor reads `GEMINI_API_KEY` from env; verify fallback to `GOOGLE_API_KEY`; verify it throws when neither key is present; verify explicit `apiKey` option overrides env vars
  - [ ] **AC2 test (≥1 case):** Capture the fetch body and assert `systemInstruction.parts[0].text === systemPrompt` and no system entry in `contents`
  - [ ] **AC3 tests (≥2 cases):** Assert user → `{ role:"user", parts:[{text}] }`; assert assistant → `{ role:"model", parts:[...] }`; assert tool-result → `{ role:"user", parts:[{ functionResponse: { name, response } }] }`
  - [ ] **AC4 tests (≥2 cases):** Mock a response with two `functionCall` parts — verify each `LLMToolCall.id` starts with `"call_"`, verify the two IDs are distinct, verify `toolCalls[0].name` and `toolCalls[0].arguments` are correct
  - [ ] **AC5 tests (≥2 cases):** Mock a response with `finishReason: "STOP"` and a text part — verify `stopReason === "stop"` and `content` equals the text; mock a response with `finishReason: "SAFETY"` — verify `stopReason === "content_filter"`; mock a response with a `functionCall` part and no finishReason — verify `stopReason === "tool_calls"`
  - [ ] **AC6 tests (≥2 cases):** Mock `usageMetadata` with `thoughtsTokenCount: 300` and `cachedContentTokenCount: 50` — verify `reasoningTokens: 300` and `cacheReadTokens: 50`; mock without optional fields — verify they are absent from returned `LLMUsage`
  - [ ] **AC7 tests (≥2 cases):** Assert tool definitions are wrapped in `functionDeclarations`; assert `toolChoice: "required"` → `toolConfig.functionCallingConfig.mode === "ANY"`; assert specific function tool choice includes `allowedFunctionNames`
  - [ ] Ensure at least 14 `it(...)` cases total
  - [ ] Run `npm run build` first, then `npm run test:fast` with `timeout: 300000`; check for "Test Files" summary line; NEVER pipe output

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/factory/` MUST use `.js` extensions (ESM): `import { foo } from '../types.js'`
- Factory package MUST NOT import from `@substrate-ai/sdlc` (ADR-003: no circular dependency)
- Import shared types from `'../types.js'` (the barrel in `packages/factory/src/llm/index.ts`)
- **MUST target the native Gemini API** (`/v1beta/models/*/generateContent`), NOT an OpenAI-compatible shim. Per `docs/reference/unified-llm-spec.md § 2.7`, using the native API is required to access full capabilities.
- Use Node.js native `fetch` (built-in since Node 18) for HTTP calls — do NOT add the `@google/generative-ai` npm SDK as a dependency
- **Authentication is via `key` query parameter**, NOT an Authorization header — `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`
- Use `crypto.randomUUID()` (available in Node 19+ without import; or `import { randomUUID } from 'node:crypto'` for Node 18 compat) for synthetic tool call ID generation
- Test files belong in `__tests__/` subdirectory co-located with source, using `*.test.ts` naming
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals

### New File Paths
```
packages/factory/src/llm/providers/gemini.ts                    — Gemini API adapter
packages/factory/src/llm/providers/__tests__/gemini.test.ts     — unit tests (≥14 test cases)
```

### Gemini API Request Body Shape

```typescript
// POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}
interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: GeminiPart[] }       // extracted from systemPrompt
  tools?: GeminiToolSpec[]                           // wrapped as functionDeclarations
  toolConfig?: GeminiToolConfig                      // mapped from toolChoice
  generationConfig?: {
    maxOutputTokens?: number                         // maps to LLMRequest.maxTokens
    temperature?: number
    thinkingConfig?: { thinkingBudget?: number }     // via request.extra for reasoning control
  }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

type GeminiPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown> } }
  | { functionResponse: { name: string; response: Record<string, unknown> } }
  | { inlineData: { mimeType: string; data: string } }    // images (future)

interface GeminiToolSpec {
  functionDeclarations: Array<{
    name: string
    description: string
    parameters: Record<string, unknown>  // JSON Schema
  }>
}

interface GeminiToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'NONE' | 'ANY'
    allowedFunctionNames?: string[]      // used when mode is 'ANY' for specific function
  }
}
```

### Gemini API Response Shape

```typescript
// Partial shape — only fields the adapter uses
interface GeminiResponse {
  candidates: GeminiCandidate[]
  usageMetadata: GeminiUsageMetadata
  modelVersion?: string
}

interface GeminiCandidate {
  content: {
    role: 'model'
    parts: GeminiPart[]
  }
  finishReason?: 'STOP' | 'MAX_TOKENS' | 'SAFETY' | 'RECITATION' | 'OTHER' | 'FINISH_REASON_UNSPECIFIED'
  safetyRatings?: unknown[]
}

// A thought part looks like: { text: "...", thought: true }
// The adapter must filter out thought parts from LLMResponse.content
// but may include them in providerMetadata for debugging

interface GeminiUsageMetadata {
  promptTokenCount: number
  candidatesTokenCount: number
  totalTokenCount?: number
  thoughtsTokenCount?: number          // reasoning tokens (Gemini 3+ with thinking)
  cachedContentTokenCount?: number     // cache read tokens (automatic prefix caching)
}
```

### Stop Reason Mapping

| `candidate.finishReason` | Tool calls present | `StopReason` |
|---|---|---|
| `"STOP"` | no | `"stop"` |
| `"STOP"` | yes | `"tool_calls"` |
| absent / `null` / `"FINISH_REASON_UNSPECIFIED"` | yes | `"tool_calls"` |
| `"MAX_TOKENS"` | — | `"length"` |
| `"SAFETY"` | — | `"content_filter"` |
| `"RECITATION"` | — | `"content_filter"` |
| other | — | `"other"` |

**Important:** Gemini does not have a dedicated `tool_calls` finish reason. When `functionCall` parts are present in the response, override the stop reason to `"tool_calls"` regardless of what `finishReason` says.

### Synthetic Tool Call ID Pattern

```typescript
import { randomUUID } from 'node:crypto'

// During complete():
const syntheticIdMap = new Map<string, string>()  // synthId → functionName

for (const part of parts) {
  if (part.functionCall) {
    const synthId = `call_${randomUUID()}`
    syntheticIdMap.set(synthId, part.functionCall.name)
    toolCalls.push({
      id: synthId,
      name: part.functionCall.name,
      arguments: part.functionCall.args ?? {},
      rawArguments: JSON.stringify(part.functionCall.args),
    })
  }
}
```

The `syntheticIdMap` is ephemeral per-request inside `complete()`. Callers that want to send tool results back must rely on the `LLMToolCall.name` field (which is always present) to route results. The `functionResponse.name` field in the Gemini tool result message uses the function name, not the synthetic ID.

**For tool result translation (in `_translateMessages`):** When processing a `role === 'tool'` message, use the `name` field from the corresponding `LLMContentPart.toolResult?.toolCallId` to look up the function name. Because tool result messages come in after a prior assistant turn, the caller must supply function name routing — the adapter may derive this from the `name` field of the `LLMMessage` or from any `toolResult` content parts.

Practical approach: process `tool` messages by looking at each `LLMContentPart` with `kind === 'tool_result'`; the `toolResult.toolCallId` is the synthetic ID; look up the function name from a map built during this method's execution by scanning prior `assistant` messages for `kind === 'tool_call'` parts.

### Tool Result Format

Gemini's `functionResponse` requires a dict, not a string. The adapter must wrap string responses:

```typescript
function _wrapResponse(content: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content)
    if (typeof parsed === 'object' && parsed !== null) return parsed as Record<string, unknown>
  } catch { /* not JSON */ }
  return { result: content }
}
```

### Authentication Note

Gemini uses a `key` query parameter — NOT a Bearer token or `x-api-key` header:

```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=AIza...
Content-Type: application/json
```

For streaming:
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:streamGenerateContent?key=AIza...&alt=sse
```

### Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `GEMINI_API_KEY` | Yes (checked first) | — | Google AI API key |
| `GOOGLE_API_KEY` | Yes (fallback if GEMINI_API_KEY absent) | — | Alternative key name |
| `GEMINI_BASE_URL` | No | `https://generativelanguage.googleapis.com` | Custom endpoint (e.g. proxy) |

### Test Pattern

```typescript
// packages/factory/src/llm/providers/__tests__/gemini.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { GeminiAdapter } from '../gemini.js'

function makeMockResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response
}

const MOCK_GEMINI_RESPONSE = {
  candidates: [{
    content: {
      role: 'model',
      parts: [{ text: 'Hello, world!' }],
    },
    finishReason: 'STOP',
  }],
  usageMetadata: {
    promptTokenCount: 10,
    candidatesTokenCount: 5,
    totalTokenCount: 15,
  },
}

describe('GeminiAdapter', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key'
    vi.stubGlobal('fetch', vi.fn())
  })

  afterEach(() => {
    delete process.env.GEMINI_API_KEY
    vi.unstubAllGlobals()
  })

  it('constructs with GEMINI_API_KEY from env', () => {
    const adapter = new GeminiAdapter()
    expect(adapter.name).toBe('gemini')
  })

  it('falls back to GOOGLE_API_KEY when GEMINI_API_KEY is absent', () => {
    delete process.env.GEMINI_API_KEY
    process.env.GOOGLE_API_KEY = 'test-google-key'
    expect(() => new GeminiAdapter()).not.toThrow()
    delete process.env.GOOGLE_API_KEY
  })

  it('throws when no API key is available', () => {
    delete process.env.GEMINI_API_KEY
    expect(() => new GeminiAdapter()).toThrow('GEMINI_API_KEY')
  })

  it('sends systemPrompt as systemInstruction, not in contents', async () => {
    vi.mocked(fetch).mockResolvedValue(makeMockResponse(MOCK_GEMINI_RESPONSE))
    const adapter = new GeminiAdapter()
    await adapter.complete({
      model: 'gemini-3-flash-preview',
      messages: [{ role: 'user', content: [{ kind: 'text', text: 'Hi' }] }],
      systemPrompt: 'You are helpful.',
    })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string)
    expect(body.systemInstruction.parts[0].text).toBe('You are helpful.')
    expect(body.contents.every((c: { role?: string }) => c.role !== 'system')).toBe(true)
  })

  // ... additional tests
})
```

### Key Implementation Patterns
- Never retry inside the adapter itself — retry middleware is handled at the `LLMClient` layer (story 48-5b)
- The URL must include `?key={apiKey}` — no Authorization header is sent
- When no `finishReason` is present in the response but `functionCall` parts exist, treat as `"tool_calls"`
- Parse JSON arguments from `functionCall.args` defensively — Gemini returns them as an object already (not a string), so no `JSON.parse` needed; just use the object directly
- For `stream()`, Gemini's SSE is simpler than OpenAI/Anthropic: each data chunk is a full (partial) response JSON object; function calls arrive complete (not streamed incrementally)
- Keep `stream()` implementation straightforward: the dev agent may stub it with `throw new Error('GeminiAdapter.stream() not yet implemented')` if time-constrained — the key deliverable is `complete()`

### Testing Requirements
- Framework: `vitest` with `describe`, `it`, `expect`, `vi`
- Use `vi.stubGlobal('fetch', vi.fn())` to mock HTTP calls — no real network calls in tests
- Run `npm run build` first to catch TypeScript errors, then `npm run test:fast` with `timeout: 300000`
- NEVER pipe test output through `grep`, `head`, `tail`, or any filtering — check raw output for "Test Files" summary line
- Confirm zero TypeScript errors before marking done

## Interface Contracts

- **Import**: `ProviderAdapter`, `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMContentPart`, `LLMToolCall`, `LLMUsage`, `StreamEvent`, `StopReason` @ `packages/factory/src/llm/types.ts` (from story 48-1)
- **Export**: `GeminiAdapter` @ `packages/factory/src/llm/providers/gemini.ts` (consumed by story 48-5a for provider registration)
- **Export**: `GeminiAdapterOptions` @ `packages/factory/src/llm/providers/gemini.ts` (consumed by story 48-5a)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
