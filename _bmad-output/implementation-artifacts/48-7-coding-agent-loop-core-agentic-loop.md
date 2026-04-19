# Story 48-7: Coding Agent Loop — Core Agentic Loop

## Story

As a host application,
I want a programmable core agentic loop that coordinates LLM calls and tool execution with per-turn event visibility,
so that I can build autonomous coding workflows with fine-grained control over session lifecycle, tool dispatch, and stop conditions.

## Acceptance Criteria

### AC1: Session Types and Configuration Exported
**Given** the agent loop package needs a shared type system
**When** `packages/factory/src/agent/types.ts` is imported
**Then** the following are exported: `SessionConfig` record (with `max_turns: number`, `max_tool_rounds_per_input: number`, `default_command_timeout_ms: number`, `max_command_timeout_ms: number`, `reasoning_effort: string | null`, `tool_output_limits: Map<string, number>`, `enable_loop_detection: boolean`, `loop_detection_window: number`); `SessionState` enum (`IDLE`, `PROCESSING`, `AWAITING_INPUT`, `CLOSED`); turn types `UserTurn`, `AssistantTurn`, `ToolResultsTurn`, `SteeringTurn`, `SystemTurn` each with `timestamp: Date`; `EventKind` enum covering all 14 event types from the spec; and `SessionEvent` type with `kind`, `timestamp`, `session_id`, and `data` fields

### AC2: CodingAgentSession Created and Emits SESSION_START
**Given** a valid `LLMClient`, `ProviderProfile`, and `ExecutionEnvironment`
**When** `createSession(options)` is called
**Then** a `CodingAgentSession` instance is returned in `IDLE` state with a UUID `id`, an event emitter accessible via `session.on(kind, handler)`, and a `SESSION_START` event is emitted synchronously with `session_id` in the event data; calling `session.close()` transitions state to `CLOSED` and emits `SESSION_END`

### AC3: Core Loop — Natural Completion
**Given** a `CodingAgentSession` in `IDLE` state
**When** `session.processInput(userInput)` is called and the LLM returns tool calls followed by a text-only response
**Then** the loop: appends a `UserTurn` to history, drains the steering queue, calls `llm_client.complete()` with a request built from history and provider profile, appends an `AssistantTurn`, executes tool calls (appending a `ToolResultsTurn`), calls `llm_client.complete()` again, and on a text-only response exits the loop and emits `PROCESSING_END`; events emitted in order: `USER_INPUT`, `ASSISTANT_TEXT_END` (first turn with tool calls), `TOOL_CALL_START` and `TOOL_CALL_END` per tool, `ASSISTANT_TEXT_END` (final text-only turn), `PROCESSING_END`

### AC4: Round Limit Enforcement
**Given** a `SessionConfig` with `max_tool_rounds_per_input: 3`
**When** tool rounds for the current `processInput` call reach 3 without natural completion
**Then** the loop breaks, a `TURN_LIMIT` event is emitted with `{ round: 3, reason: 'max_tool_rounds_per_input' }`, the session returns to `IDLE` state, and `PROCESSING_END` is emitted after `TURN_LIMIT`

### AC5: Turn Limit Enforcement
**Given** a `SessionConfig` with `max_turns: 5`
**When** the total turn count in `session.history` reaches 5 at the start of any loop iteration
**Then** the loop breaks with a `TURN_LIMIT` event with `{ total_turns: 5, reason: 'max_turns' }`, the session returns to `IDLE`, and `PROCESSING_END` is emitted; a value of `0` for either limit means unlimited

### AC6: Tool Execution with Parallel and Sequential Dispatch
**Given** a tool round with multiple tool calls
**When** `provider_profile.supports_parallel_tool_calls` is `true`
**Then** all tool calls in that round are dispatched concurrently via `Promise.all`; when it is `false`, they execute sequentially; each call emits `TOOL_CALL_START` before execution and `TOOL_CALL_END` after, with `TOOL_CALL_END` carrying the **full untruncated** output in its event data regardless of truncation applied to the LLM-bound result; unknown tools return `{ content: 'Unknown tool: <name>', isError: true }` without throwing

### AC7: Basic Output Truncation Applied Before LLM, Full Output in Events
**Given** a tool that produces output exceeding a per-tool character limit
**When** `truncateToolOutput(output, toolName, config)` is called
**Then** it applies the limit from `config.tool_output_limits` for the named tool (falling back to `DEFAULT_TOOL_LIMITS` constants: `read_file` → 50,000; `shell` → 30,000; `grep` → 20,000; `glob` → 20,000; others → 10,000), truncates using a head/tail split with a `[WARNING: Tool output was truncated. N characters removed from the middle.]` marker, and returns the truncated string; the `TOOL_CALL_END` event always carries the original full output; if output is within the limit it is returned unchanged

## Tasks / Subtasks

- [ ] Task 1: Define agent types in `packages/factory/src/agent/types.ts` (AC: #1)
  - [ ] Export `SessionConfig` interface with fields: `max_turns: number` (default 0 = unlimited), `max_tool_rounds_per_input: number` (default 0 = unlimited), `default_command_timeout_ms: number` (default 10000), `max_command_timeout_ms: number` (default 600000), `reasoning_effort: string | null` (default null), `tool_output_limits: Map<string, number>` (default empty), `enable_loop_detection: boolean` (default true), `loop_detection_window: number` (default 10)
  - [ ] Export `SessionState` as a string union or const enum: `'IDLE' | 'PROCESSING' | 'AWAITING_INPUT' | 'CLOSED'`
  - [ ] Export turn types: `UserTurn { content: string; timestamp: Date }`, `AssistantTurn { content: string; tool_calls: LLMToolCall[]; reasoning: string | null; usage: LLMUsage; response_id: string | null; timestamp: Date }`, `ToolResultsTurn { results: ToolCallResult[]; timestamp: Date }`, `SteeringTurn { content: string; timestamp: Date }`, `SystemTurn { content: string; timestamp: Date }`; export `Turn = UserTurn | AssistantTurn | ToolResultsTurn | SteeringTurn | SystemTurn`
  - [ ] Export `ToolCallResult` type: `{ tool_call_id: string; content: string; is_error: boolean }`
  - [ ] Export `EventKind` as a string const enum covering all 14 event kinds from spec Section 2.9: `SESSION_START`, `SESSION_END`, `USER_INPUT`, `PROCESSING_END`, `ASSISTANT_TEXT_START`, `ASSISTANT_TEXT_DELTA`, `ASSISTANT_TEXT_END`, `TOOL_CALL_START`, `TOOL_CALL_OUTPUT_DELTA`, `TOOL_CALL_END`, `STEERING_INJECTED`, `TURN_LIMIT`, `LOOP_DETECTION`, `WARNING`, `ERROR`
  - [ ] Export `SessionEvent<T extends Record<string, unknown> = Record<string, unknown>>` type: `{ kind: EventKind; timestamp: Date; session_id: string; data: T }`
  - [ ] Export `DEFAULT_TOOL_LIMITS` const: `{ read_file: 50000, shell: 30000, grep: 20000, glob: 20000 }` with a default fallback of 10000 for unlisted tools

- [ ] Task 2: Implement `CodingAgentSession` class skeleton in `packages/factory/src/agent/loop.ts` (AC: #2)
  - [ ] Import `LLMClient` from `'../llm/client.js'`, `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMToolCall`, `LLMUsage` from `'../llm/types.js'`, `ProviderProfile` from `'./tools/profiles.js'`, `ExecutionEnvironment` from `'./tools/types.js'`
  - [ ] Import all types from `'./types.js'`
  - [ ] Define `CreateSessionOptions` interface: `{ llmClient: LLMClient; providerProfile: ProviderProfile; executionEnv: ExecutionEnvironment; config?: Partial<SessionConfig> }`
  - [ ] `createSession(options: CreateSessionOptions): CodingAgentSession` — factory function that returns a new instance; resolves defaults for `SessionConfig`; assigns `id = crypto.randomUUID()`, `state = 'IDLE'`; emits `SESSION_START` synchronously after construction
  - [ ] `CodingAgentSession` class has: `readonly id: string`, `state: SessionState`, `history: Turn[]`, private `_steeringQueue: string[]`, private `_followupQueue: string[]`, private `_emitter: EventEmitter` (Node.js `node:events`), private `_abortController: AbortController`
  - [ ] `session.on(kind: EventKind, handler: (event: SessionEvent) => void): void` — subscribes to events
  - [ ] `session.close(): void` — sets state to `'CLOSED'`, emits `SESSION_END`
  - [ ] `session.abort(): void` — signals the abort controller and calls close()
  - [ ] Private `_emit(kind: EventKind, data?: Record<string, unknown>): void` — constructs and emits `SessionEvent`

- [ ] Task 3: Implement `convertHistoryToMessages` and `buildLLMRequest` helpers (AC: #3)
  - [ ] `convertHistoryToMessages(history: Turn[]): LLMMessage[]` — maps each turn to `LLMMessage` format: `UserTurn` and `SteeringTurn` → `{ role: 'user', content: turn.content }`; `AssistantTurn` with tool calls → `{ role: 'assistant', content: [text part, ...tool_use parts] }`; `AssistantTurn` without tool calls → `{ role: 'assistant', content: turn.content }`; `ToolResultsTurn` → `{ role: 'user', content: tool_result parts }` using the LLMMessage format; `SystemTurn` → skip (system prompt is passed separately)
  - [ ] `buildLLMRequest(session: CodingAgentSession): LLMRequest` — assembles `{ model, systemPrompt, messages, tools, tool_choice: 'auto', reasoning_effort, ...provider_options }` using `session.providerProfile.build_system_prompt()`, `session.providerProfile.tools()`, `session.providerProfile.provider_options()`
  - [ ] `_drainSteering(session): void` — dequeues all messages from `_steeringQueue`, appends each as a `SteeringTurn` to history, and emits `STEERING_INJECTED` per message

- [ ] Task 4: Implement `processInput` core loop with natural completion and limit enforcement (AC: #3, #4, #5)
  - [ ] `session.processInput(userInput: string): Promise<void>` — sets state to `'PROCESSING'`, appends `UserTurn`, emits `USER_INPUT`, then enters the agentic loop
  - [ ] At the start of each iteration: check `max_tool_rounds_per_input` (if > 0 and `roundCount >= limit`, emit `TURN_LIMIT { round: roundCount, reason: 'max_tool_rounds_per_input' }` and break); check `max_turns` (count all turns in history; if > 0 and `count >= limit`, emit `TURN_LIMIT { total_turns: count, reason: 'max_turns' }` and break); check `abortController.signal.aborted` and break
  - [ ] Call `_drainSteering()` before the first LLM call in each cycle, and again after tool execution
  - [ ] Call `llmClient.complete(buildLLMRequest(session))`, append `AssistantTurn` to history, emit `ASSISTANT_TEXT_END { text, reasoning }`
  - [ ] If `response.tool_calls` is empty, break (natural completion)
  - [ ] If tool calls present, increment `roundCount`, call `_executeToolCalls()`, append `ToolResultsTurn` to history
  - [ ] After loop exits, set `state = 'IDLE'`, emit `PROCESSING_END`
  - [ ] Handle errors: catch any thrown error from `llmClient.complete()`, emit `ERROR { message: err.message }`, set `state = 'CLOSED'`, rethrow

- [ ] Task 5: Implement `_executeToolCalls` and `_executeSingleTool` (AC: #6)
  - [ ] `private async _executeToolCalls(toolCalls: LLMToolCall[]): Promise<ToolCallResult[]>` — if `providerProfile.supports_parallel_tool_calls && toolCalls.length > 1`, use `Promise.all`; otherwise sequential for-loop
  - [ ] `private async _executeSingleTool(toolCall: LLMToolCall): Promise<ToolCallResult>` — emits `TOOL_CALL_START { tool_name: toolCall.name, call_id: toolCall.id }`; looks up tool via `providerProfile.tool_registry.get(toolCall.name)` — if not found, emits `TOOL_CALL_END` with error and returns `{ tool_call_id, content: 'Unknown tool: name', is_error: true }` without throwing; delegates execution to `ToolRegistry.execute(name, args, executionEnv)` (defined in story 48-6); captures the raw output; applies `truncateToolOutput(rawOutput, toolCall.name, config)`; emits `TOOL_CALL_END { call_id, output: rawOutput }` with full untruncated output; returns `{ tool_call_id, content: truncatedOutput, is_error: result.isError }`
  - [ ] Note: `ToolRegistry.execute()` from story 48-6 already handles schema validation and executor errors — `_executeSingleTool` should call it and inspect `result.isError` rather than re-wrapping errors

- [ ] Task 6: Implement `truncateToolOutput` (AC: #7)
  - [ ] Create `packages/factory/src/agent/truncation.ts` exporting `truncateToolOutput(output: string, toolName: string, config: SessionConfig): string`
  - [ ] Look up limit: `config.tool_output_limits.get(toolName) ?? DEFAULT_TOOL_LIMITS[toolName as keyof typeof DEFAULT_TOOL_LIMITS] ?? 10000`
  - [ ] If `output.length <= limit`, return output unchanged
  - [ ] Otherwise apply head/tail split: `half = Math.floor(limit / 2)`, keep `output.slice(0, half)` + `\n\n[WARNING: Tool output was truncated. ${removed} characters were removed from the middle. The full output is available in the event stream. If you need to see specific parts, re-run the tool with more targeted parameters.]\n\n` + `output.slice(-half)`
  - [ ] Export `DEFAULT_TOOL_LIMITS` from this file (and re-export from `types.ts`); ensure 48-9 can replace the algorithm by importing from this module

- [ ] Task 7: Barrel exports, extend factory index, and write tests (AC: all)
  - [ ] Create `packages/factory/src/agent/index.ts` re-exporting from `'./types.js'`, `'./loop.js'`, `'./truncation.js'`
  - [ ] Extend `packages/factory/src/index.ts` to add `export * from './agent/index.js'`
  - [ ] Create `packages/factory/src/agent/__tests__/loop.test.ts` with ≥10 test cases:
    - `createSession` returns instance in IDLE state with a UUID id
    - `SESSION_START` event emitted on creation
    - `close()` transitions to CLOSED and emits SESSION_END
    - `processInput` emits USER_INPUT then PROCESSING_END for a text-only LLM response (no tool calls)
    - `processInput` loops once for single tool call then natural completion — emits TOOL_CALL_START, TOOL_CALL_END, final ASSISTANT_TEXT_END, PROCESSING_END
    - `max_tool_rounds_per_input=2` stops loop after 2 rounds, emits TURN_LIMIT
    - `max_turns=3` stops loop when history has 3 turns, emits TURN_LIMIT
    - Unknown tool returns `is_error: true` content without throwing
    - TOOL_CALL_END event carries full untruncated output when truncation is applied
    - Parallel tool calls are dispatched via Promise.all when `supports_parallel_tool_calls=true`
  - [ ] Create `packages/factory/src/agent/__tests__/truncation.test.ts` with ≥5 test cases:
    - Output within limit returned unchanged
    - Output exceeding limit gets head/tail split with warning marker
    - `config.tool_output_limits` override is applied
    - DEFAULT_TOOL_LIMITS fallback used when tool not in config map
    - Tools not in DEFAULT_TOOL_LIMITS fall back to 10,000 chars

## Dev Notes

### Architecture Constraints
- **ESM imports**: all cross-file imports within `packages/factory/` MUST use `.js` extensions (e.g., `import { LLMClient } from '../llm/client.js'`)
- **Named exports only** — no default exports in any file
- **Node.js EventEmitter**: use `import { EventEmitter } from 'node:events'`; `CodingAgentSession` wraps an internal emitter; `session.on(kind, handler)` delegates to it
- **ADR-003**: `packages/factory` MUST NOT import from `packages/sdlc` or `packages/core` (except `@substrate-ai/core` for cost utilities already in 48-5b)
- **`ProviderProfile.tool_registry`**: the spec calls for a `tool_registry` property on `ProviderProfile`; however story 48-6 may not have added this to the profiles (it uses `tools()` to get definitions). If `tool_registry` is absent, adapt: build a `ToolRegistry` from `providerProfile.tools()` during session creation and store it on the session. Check `packages/factory/src/agent/tools/profiles.ts` before implementing.
- **`LLMToolCall` format**: Anthropic, OpenAI, and Gemini adapters each return tool calls in the `LLMToolCall` format from `packages/factory/src/llm/types.ts`. The `id`, `name`, and `arguments` fields must be available on each call.
- **`LLMMessage` content parts**: when an `AssistantTurn` has tool calls, the message must encode both text and tool_use parts per the provider's expected history format. Consult `packages/factory/src/llm/types.ts` for `LLMContentPart` and `LLMToolCall` shapes.
- **`crypto.randomUUID()`**: use Node.js built-in `import { randomUUID } from 'node:crypto'`; no UUID library needed
- **File paths**: `packages/factory/src/agent/types.ts`, `packages/factory/src/agent/loop.ts`, `packages/factory/src/agent/truncation.ts`, `packages/factory/src/agent/index.ts`, `packages/factory/src/agent/__tests__/loop.test.ts`, `packages/factory/src/agent/__tests__/truncation.test.ts`
- **`loop.ts` is the integration target for 48-8**: story 48-8 extends `_drainSteering` and adds `steer()`/`follow_up()` methods and loop detection; leave these as stubs or no-ops so 48-8 can fill them in cleanly. `_steeringQueue` and `_followupQueue` must already be declared on the class.

### Testing Requirements
- Use vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`)
- Mock `LLMClient.complete()` with `vi.fn()` returning controlled `LLMResponse` objects — do NOT make real HTTP calls
- Mock `ProviderProfile` as a plain object with `vi.fn()` stubs for `build_system_prompt()`, `tools()`, `provider_options()`, and a `tool_registry` or tool lookup mechanism
- Mock `ToolRegistry.execute()` with `vi.fn()` — do NOT spawn real processes
- Use `vi.fn()` for `ExecutionEnvironment.exec`
- Test event order using an array of collected events (`session.on(kind, e => events.push(e))`)
- Run with `npm run test:fast` (timeout 300000ms) — never pipe output

### Key Imports Pattern
```typescript
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { LLMClient } from '../llm/client.js'
import type { LLMRequest, LLMResponse, LLMMessage, LLMToolCall, LLMUsage } from '../llm/types.js'
import type { ProviderProfile } from './tools/profiles.js'
import type { ExecutionEnvironment, ToolResult } from './tools/types.js'
import type { ToolRegistry } from './tools/registry.js'
import {
  SessionConfig, SessionState, SessionEvent, EventKind,
  UserTurn, AssistantTurn, ToolResultsTurn, SteeringTurn, Turn,
  ToolCallResult, DEFAULT_TOOL_LIMITS
} from './types.js'
```

## Interface Contracts

- **Import**: `LLMClient` @ `packages/factory/src/llm/client.ts` (from story 48-5a)
- **Import**: `LLMRequest`, `LLMResponse`, `LLMMessage`, `LLMToolCall`, `LLMUsage` @ `packages/factory/src/llm/types.ts` (from story 48-1)
- **Import**: `ProviderProfile` @ `packages/factory/src/agent/tools/profiles.ts` (from story 48-6)
- **Import**: `ToolRegistry` @ `packages/factory/src/agent/tools/registry.ts` (from story 48-6)
- **Import**: `ExecutionEnvironment`, `ToolResult` @ `packages/factory/src/agent/tools/types.ts` (from story 48-6)
- **Export**: `CodingAgentSession` (class) @ `packages/factory/src/agent/loop.ts` (consumed by stories 48-8 and 48-10)
- **Export**: `createSession`, `CreateSessionOptions` @ `packages/factory/src/agent/loop.ts` (consumed by stories 48-8 and 48-10)
- **Export**: `SessionConfig`, `SessionState`, `EventKind`, `SessionEvent`, `Turn` types @ `packages/factory/src/agent/types.ts` (consumed by stories 48-8 and 48-10)
- **Export**: `truncateToolOutput` @ `packages/factory/src/agent/truncation.ts` (extended by story 48-9 with two-phase algorithm)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
