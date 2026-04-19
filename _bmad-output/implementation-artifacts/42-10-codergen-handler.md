# Story 42-10: Codergen Handler

## Story

As a graph executor,
I want a codergen handler that invokes an LLM with a prompt derived from node attributes and GraphContext,
so that codergen nodes perform AI-powered text generation and code synthesis within the graph, with results available to downstream nodes via shared context.

## Acceptance Criteria

### AC1: Prompt Template Interpolation
**Given** a codergen node whose `prompt` (or `label` as fallback) contains `{{variable}}` placeholders and a GraphContext with values for those keys
**When** the codergen handler is invoked
**Then** all `{{variable}}` references are replaced with `context.getString(key, "")` — missing keys resolve to empty string `""` without throwing

### AC2: Model Resolution via Stylesheet
**Given** a codergen node and an optional `ParsedStylesheet` supplied via handler options
**When** the handler prepares the LLM call
**Then** it calls `resolveNodeStyles(node, stylesheet)` to obtain `llm_model`, `llm_provider`, and `reasoning_effort`; values not set by the stylesheet fall back to system defaults (`claude-sonnet-4-5`, `anthropic`, `medium`)

### AC3: LLM Invocation with Resolved Parameters
**Given** a resolved model configuration and an interpolated prompt
**When** the handler calls the LLM client from `@substrate-ai/core`
**Then** the client is invoked with the correct model, provider, reasoning_effort, and prompt; the raw response text is captured for outcome construction

### AC4: Successful Response Mapped to SUCCESS Outcome
**Given** the LLM returns a successful response
**When** the handler processes the response
**Then** it returns an `Outcome` with `status: 'SUCCESS'`, the raw response text in `notes`, and `contextUpdates` containing `{ [node.id + "_output"]: responseText }` so downstream nodes can reference `{{nodeId_output}}` in their own prompts

### AC5: Transient LLM Errors Mapped to NEEDS_RETRY
**Given** the LLM client throws a transient error (rate limit 429, timeout, or network reset)
**When** the handler catches the error
**Then** it returns an `Outcome` with `status: 'NEEDS_RETRY'` and the original error in `outcome.error`

### AC6: Non-Transient LLM Errors Mapped to FAILURE
**Given** the LLM client throws a non-transient error (e.g., invalid request, authentication failure, unknown error type)
**When** the handler catches the error
**Then** it returns an `Outcome` with `status: 'FAILURE'` and the original error in `outcome.error`

### AC7: Codergen Handler Is the Default in createDefaultRegistry()
**Given** the default handler registry returned by `createDefaultRegistry()`
**When** `registry.resolve(node)` is called for a node whose `type` is absent or unrecognized and whose `shape` has no registered mapping (e.g., shape `"box"` or type `"codergen"`)
**Then** the codergen handler is returned — either via explicit `"codergen"` type registration and `box` shape mapping, or via `registry.setDefault(codergenHandler)`

## Tasks / Subtasks

- [ ] Task 1: Scaffold codergen handler file and option types (AC: #2, #3)
  - [ ] Create `/packages/factory/src/handlers/codergen-handler.ts`
  - [ ] Define `CodergenHandlerOptions` interface: `{ stylesheet?: ParsedStylesheet; defaultModel?: string; defaultProvider?: string; defaultReasoningEffort?: string }`
  - [ ] Define `createCodergenHandler(options?: CodergenHandlerOptions): NodeHandler` factory function signature
  - [ ] Import `GraphNode`, `Graph`, `IGraphContext`, `Outcome` from `../graph/types.js`
  - [ ] Import `NodeHandler` from `./types.js`
  - [ ] Import `ParsedStylesheet`, `resolveNodeStyles` from `../stylesheet/resolver.js` (discover exact path by reading the stylesheet module)

- [ ] Task 2: Implement prompt template interpolation (AC: #1)
  - [ ] Implement `interpolatePrompt(template: string, context: IGraphContext): string`
  - [ ] Use regex `/\{\{(\w+)\}\}/g` to match all `{{key}}` placeholders
  - [ ] Replace each placeholder with `context.getString(key, "")` — missing keys → empty string
  - [ ] Prompt source priority: `node.prompt` if non-empty, else `node.label`, else empty string
  - [ ] Export `interpolatePrompt` as a named export for unit-test access

- [ ] Task 3: Implement model resolution (AC: #2)
  - [ ] Implement `resolveModel(node: GraphNode, stylesheet?: ParsedStylesheet): { llm_model: string; llm_provider: string; reasoning_effort: string }`
  - [ ] When `stylesheet` is provided, call `resolveNodeStyles(node, stylesheet)` and extract `llm_model`, `llm_provider`, `reasoning_effort`
  - [ ] Merge with per-option defaults then system defaults: model `"claude-sonnet-4-5"`, provider `"anthropic"`, reasoning_effort `"medium"`
  - [ ] Node-level attributes (`node.llmModel`, `node.llmProvider`, `node.reasoningEffort`) take precedence over stylesheet results when explicitly set

- [ ] Task 4: Discover and implement LLM invocation (AC: #3, #4)
  - [ ] **Before coding**: read `packages/core/src/` to discover the LLM client API (function name, parameter shape, return type, import path)
  - [ ] Invoke the discovered LLM client with resolved model parameters and the interpolated prompt
  - [ ] Capture the response text; construct a SUCCESS `Outcome`:
    - `status: 'SUCCESS'`
    - `notes: responseText`
    - `contextUpdates: { [node.id + "_output"]: responseText }`

- [ ] Task 5: Implement error classification and outcome mapping (AC: #5, #6)
  - [ ] Implement `isTransientError(error: unknown): boolean`:
    - Returns `true` for HTTP status 429 (rate limit)
    - Returns `true` for errors whose message contains `"timeout"`, `"ETIMEDOUT"`, `"ECONNRESET"`, or `"ECONNREFUSED"`
    - Returns `false` for all other errors
  - [ ] Wrap LLM call in try/catch
  - [ ] Transient errors → `{ status: 'NEEDS_RETRY', error }` outcome
  - [ ] Non-transient errors → `{ status: 'FAILURE', error }` outcome
  - [ ] Export `isTransientError` as a named export for unit-test access

- [ ] Task 6: Register codergen handler in createDefaultRegistry() (AC: #7)
  - [ ] Update `createDefaultRegistry()` in `/packages/factory/src/handlers/registry.ts`
  - [ ] Call `registry.register("codergen", createCodergenHandler())` for explicit type routing
  - [ ] Call `registry.registerShape("box", "codergen")` so DOT `shape=box` nodes route to codergen
  - [ ] Call `registry.setDefault(createCodergenHandler())` so nodes with no recognizable type or shape fall back to codergen
  - [ ] Update the barrel `packages/factory/src/handlers/index.ts` to re-export `createCodergenHandler` and `CodergenHandlerOptions` from `./codergen-handler.js`

- [ ] Task 7: Write unit tests (AC: #1–#7)
  - [ ] Create `/packages/factory/src/handlers/__tests__/codergen-handler.test.ts`
  - [ ] Mock the LLM client from `@substrate-ai/core` using `vi.mock()` — no real API calls
  - [ ] Test `interpolatePrompt`: multiple placeholders, missing keys → `""`, node with no prompt falls back to `label`
  - [ ] Test `resolveModel`: with no stylesheet uses system defaults; with stylesheet merges correctly; node-level attributes win over stylesheet
  - [ ] Test success path: mock LLM returns text, verify outcome `status`, `notes`, and `contextUpdates` key pattern
  - [ ] Test transient error path (status 429): verify `NEEDS_RETRY` outcome with `error` set
  - [ ] Test non-transient error path: verify `FAILURE` outcome with `error` set
  - [ ] Test `isTransientError` edge cases: 429, ETIMEDOUT, ECONNRESET, unknown string, generic Error
  - [ ] Test `createDefaultRegistry()` resolves `type="codergen"`, `shape="box"`, and an unrecognized node to the codergen handler

## Dev Notes

### Architecture Constraints
- **New file:** `/packages/factory/src/handlers/codergen-handler.ts`
- **Modified files:** `/packages/factory/src/handlers/registry.ts` (update `createDefaultRegistry`), `/packages/factory/src/handlers/index.ts` (add barrel re-export)
- All relative imports use ESM `.js` extensions (e.g., `import { resolveNodeStyles } from '../stylesheet/resolver.js'`)
- Allowed external imports: `@substrate-ai/core`, `@substrate-ai/sdlc`, Node built-ins — no other third-party packages
- No circular dependencies: this module imports from `graph/types`, `handlers/types`, `stylesheet/resolver` but nothing imports from `codergen-handler` within handlers (the executor will import it via the registry)

### LLM Client Discovery (CRITICAL — do before Task 4)
Read `packages/core/src/` to find the LLM invocation API before writing any LLM call code. Look for:
- A function like `callLLM`, `createLLMClient`, `dispatch`, or a class with an `invoke`/`generate` method
- The parameter shape: how model, provider, reasoning effort, and prompt are passed
- The return type: likely `{ text: string }` or similar
- The correct import path from `@substrate-ai/core`

Do not guess or invent an API — read the actual source.

### Context Output Key Pattern
After a successful LLM call, store the response as:
```ts
contextUpdates: { [`${node.id}_output`]: responseText }
```
Downstream nodes reference this via `{{nodeId_output}}` in their prompt templates.

### Node Attribute Naming
Story 42-2 defines camelCase TypeScript properties for node attributes. The relevant ones:
- `node.prompt` — the prompt text (possibly with `{{variables}}`)
- `node.label` — fallback if prompt is absent
- `node.llmModel` — node-level model override (from `llm_model` DOT attribute)
- `node.llmProvider` — node-level provider override
- `node.reasoningEffort` — node-level reasoning effort override

### Error Classification Details
Check `(error as any).status` or `(error as any).statusCode` for HTTP status codes. Check `(error as Error).message` for string patterns. Do not import any error classification library — implement inline.

### Testing Requirements
- Test framework: Vitest (already configured; `import { describe, it, expect, vi } from 'vitest'`)
- Run: `npm run test:fast` — never pipe output; confirm "Test Files" summary line
- Never run tests concurrently (`pgrep -f vitest` must return nothing first)
- Use `vi.mock('@substrate-ai/core', ...)` to mock the LLM client before each test; reset mocks with `vi.clearAllMocks()` in `afterEach`
- Use real `GraphContext` from `../graph/context.js` in tests — do not stub it

## Interface Contracts

- **Import**: `GraphNode`, `Graph`, `IGraphContext`, `Outcome`, `OutcomeStatus` @ `packages/factory/src/graph/types.ts` (from stories 42-1, 42-2, 42-8)
- **Import**: `NodeHandler`, `IHandlerRegistry` @ `packages/factory/src/handlers/types.ts` (from story 42-9)
- **Import**: `HandlerRegistry`, `createDefaultRegistry` @ `packages/factory/src/handlers/registry.ts` (from story 42-9, modified here)
- **Import**: `ParsedStylesheet`, `resolveNodeStyles`, `ResolvedNodeStyles` @ `packages/factory/src/stylesheet/resolver.ts` (from story 42-7)
- **Export**: `createCodergenHandler` @ `packages/factory/src/handlers/codergen-handler.ts` (consumed by executor in story 42-14)
- **Export**: `CodergenHandlerOptions` @ `packages/factory/src/handlers/codergen-handler.ts` (consumed by executor in story 42-14 for runtime wiring)

## Dev Agent Record

### Agent Model Used
claude-opus-4-5

### Completion Notes List
- Discovered no existing LLM client in @substrate-ai/core; created minimal callLLM() function in packages/core/src/llm/client.ts with the expected parameter shape (model, provider, reasoningEffort, prompt) and result type ({ text: string }).
- Updated createDefaultRegistry() to register codergen as explicit type, box shape mapping, and default handler. Updated the pre-existing registry test that anticipated this change.
- All 263 test files pass (6265 tests); build is clean.

### File List
- /home/jplanow/code/jplanow/substrate/packages/core/src/llm/client.ts (new)
- /home/jplanow/code/jplanow/substrate/packages/core/src/index.ts (modified)
- /home/jplanow/code/jplanow/substrate/packages/factory/src/handlers/codergen-handler.ts (new)
- /home/jplanow/code/jplanow/substrate/packages/factory/src/handlers/registry.ts (modified)
- /home/jplanow/code/jplanow/substrate/packages/factory/src/handlers/index.ts (modified)
- /home/jplanow/code/jplanow/substrate/packages/factory/src/handlers/__tests__/registry.test.ts (modified)
- /home/jplanow/code/jplanow/substrate/packages/factory/src/handlers/__tests__/codergen-handler.test.ts (new)

## Change Log
