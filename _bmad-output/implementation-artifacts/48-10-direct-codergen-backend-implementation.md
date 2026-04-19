# Story 48-10: DirectCodergenBackend Implementation

## Story

As a pipeline orchestrator,
I want a `DirectCodergenBackend` that executes codergen nodes using the Coding Agent Loop and Unified LLM Client,
so that I get per-turn event visibility, loop detection, and output truncation unavailable with the CLI backend.

## Acceptance Criteria

### AC1: Backend Starts Agent Loop with Node Prompt
**Given** `DirectCodergenBackend` configured with an `LLMClient`, `ProviderProfile`, and `ExecutionEnvironment`
**When** `run(node, prompt, context)` is called
**Then** a `CodingAgentSession` is created via `createSession()` and `session.processInput(prompt)` is called with the interpolated prompt string passed to `run()`

### AC2: Natural Completion Maps to SUCCESS
**Given** the agent loop exits naturally (final LLM response contains no tool calls)
**When** the `Outcome` is built after `processInput()` returns
**Then** `{ status: 'SUCCESS', contextUpdates: { [`${node.id}_output`]: finalAssistantText } }` is returned, where `finalAssistantText` is the `content` field of the last `AssistantTurn` in `session.history`; if no assistant turn exists in history, `contextUpdates` is omitted

### AC3: Turn Limit Hit Maps to FAILURE
**Given** the agent loop emits a `TURN_LIMIT` event (from either `max_turns` or `max_tool_rounds_per_input` enforcement)
**When** `processInput()` returns after the limit fires
**Then** returns `{ status: 'FAILURE', failureReason: 'turn limit exceeded' }`

### AC4: Per-Turn Events Forwarded via onEvent Callback
**Given** `DirectBackendOptions.onEvent` is provided as a callback
**When** the agent loop emits any `SessionEvent` (including `TOOL_CALL_START`, `TOOL_CALL_END`, and `LOOP_DETECTION`)
**Then** `onEvent` is called with the full `SessionEvent` object for every event kind emitted during the session lifetime, enabling the host to bridge session events to the factory event bus

### AC5: Node-Level Backend Selection via `backend` Attribute
**Given** `GraphNode.backend === 'direct'` AND `CodergenHandlerOptions.directBackend` is a `DirectCodergenBackend` instance
**When** `createCodergenHandler` processes the node
**Then** it invokes `directBackend.run(node, interpolatedPrompt, context)` instead of the global `backend` or `callLLM`; `GraphNode` includes a `backend: string` field (default `''`) parsed from the DOT attribute `backend`; when `node.backend !== 'direct'`, `directBackend` is not used even if set

### AC6: Errors Propagate as FAILURE Outcome
**Given** an error is thrown during `session.processInput()` (e.g., LLM API failure, network error)
**When** the exception is caught
**Then** `{ status: 'FAILURE', failureReason: err.message }` is returned and `session.close()` is called in the `finally` block; the error is NOT rethrown (unlike the session's own error handling)

## Tasks / Subtasks

- [ ] Task 1: Implement `DirectCodergenBackend` class in `packages/factory/src/backend/direct-backend.ts` (AC: #1, #2, #3, #4, #6)
  - [ ] Define `DirectBackendOptions` interface: `{ llmClient: LLMClient; providerProfile: ProviderProfile; executionEnv: ExecutionEnvironment; config?: Partial<SessionConfig>; onEvent?: (event: SessionEvent) => void }`
  - [ ] Implement `DirectCodergenBackend` class implementing `ICodergenBackend`
  - [ ] In `run(node, prompt, context)`: call `createSession({ llmClient, providerProfile, executionEnv, config })` to get a session
  - [ ] If `onEvent` is provided, subscribe to all `Object.values(EventKind)` using `session.on(kind, onEvent)` before calling `processInput`
  - [ ] Track turn-limit state: subscribe to `EventKind.TURN_LIMIT` and set a local `turnLimitHit = true` flag on receipt
  - [ ] Wrap `await session.processInput(prompt)` in try/catch/finally; in `finally`, call `session.close()`
  - [ ] On catch: return `{ status: 'FAILURE', failureReason: err instanceof Error ? err.message : String(err) }`
  - [ ] On success: if `turnLimitHit`, return `{ status: 'FAILURE', failureReason: 'turn limit exceeded' }`; otherwise extract final assistant text and return SUCCESS outcome
  - [ ] Extract final assistant text: scan `session.history` in reverse for the last entry with `type === 'assistant'`; use `turn.content`; if none found, return SUCCESS with no contextUpdates
  - [ ] Export `createDirectCodergenBackend(options: DirectBackendOptions): DirectCodergenBackend` factory function

- [ ] Task 2: Add `backend: string` to `GraphNode` and update the DOT parser (AC: #5)
  - [ ] Add `backend: string` field to `GraphNode` interface in `packages/factory/src/graph/types.ts` (default value `''`; place it after `toolCommand`)
  - [ ] Add `backend: attrStr(attrs, 'backend', '')` in the node attribute mapping in `packages/factory/src/graph/parser.ts` (alongside `toolCommand` and `llmModel`)
  - [ ] Verify existing parser tests still pass — no functional change to existing DOT parsing

- [ ] Task 3: Extend `CodergenHandlerOptions` and codergen handler for node-level backend selection (AC: #5)
  - [ ] Add `directBackend?: ICodergenBackend` field to `CodergenHandlerOptions` in `packages/factory/src/handlers/codergen-handler.ts`
  - [ ] In `createCodergenHandler`, add a check after the existing `options?.backend` check: if `node.backend === 'direct'` AND `options?.directBackend` is set, call `return options.directBackend.run(node, interpolatedPrompt, context)`
  - [ ] Ensure the existing `options?.backend` global injection remains unchanged (backward compat)

- [ ] Task 4: Update backend barrel exports in `packages/factory/src/backend/index.ts` (AC: all)
  - [ ] Add `export type { DirectBackendOptions } from './direct-backend.js'`
  - [ ] Add `export { DirectCodergenBackend, createDirectCodergenBackend } from './direct-backend.js'`

- [ ] Task 5: Write unit tests in `packages/factory/src/backend/__tests__/direct-backend.test.ts` (AC: #1–#6)
  - [ ] Mock `createSession` from `'../../agent/loop.js'` using `vi.mock`; provide a fake `CodingAgentSession` with `on()`, `processInput()`, `close()`, and `history` array
  - [ ] AC1 test: `processInput` is called with the prompt passed to `run()`; `createSession` called with llmClient, providerProfile, executionEnv
  - [ ] AC2 test: mock history has one `AssistantTurn` with content `'done'`; result is `{ status: 'SUCCESS', contextUpdates: { 'node1_output': 'done' } }`
  - [ ] AC2 edge case: empty history → `{ status: 'SUCCESS' }` with no contextUpdates key
  - [ ] AC3 test: session emits TURN_LIMIT via `on()` handler immediately; result is `{ status: 'FAILURE', failureReason: 'turn limit exceeded' }`
  - [ ] AC4 test: `onEvent` callback receives TOOL_CALL_START and TOOL_CALL_END events emitted during session
  - [ ] AC6 test: `processInput` throws `new Error('api timeout')`; result is `{ status: 'FAILURE', failureReason: 'api timeout' }`; `session.close()` still called
  - [ ] AC6 test: `session.close()` is always called even on success (spy verification)

- [ ] Task 6: Extend codergen handler tests for `directBackend` option (AC: #5)
  - [ ] In `packages/factory/src/handlers/__tests__/codergen-handler.test.ts`, add a test: node with `backend: 'direct'` + `options.directBackend` set → `directBackend.run()` called; `callLLM` not called
  - [ ] Add a test: node with `backend: ''` + `options.directBackend` set → `callLLM` used; `directBackend.run()` NOT called
  - [ ] Add a test: node with `backend: 'direct'` but `options.directBackend` NOT set → falls through to `callLLM` (no crash)

## Dev Notes

### Architecture Constraints
- **ESM imports**: all imports within `packages/factory/` MUST use `.js` extensions (e.g., `import { createSession } from '../agent/loop.js'`)
- **Named exports only** — no default exports in any file
- **ADR-003**: `packages/factory` MUST NOT import from `packages/sdlc`; imports from `@substrate-ai/core` are allowed only for already-established utilities (e.g., cost tracking); no new cross-package dependencies needed for this story
- **Error handling**: `processInput()` rethrows after emitting an `ERROR` event internally. `DirectCodergenBackend.run()` MUST catch and NOT rethrow — it maps errors to FAILURE outcomes so the pipeline executor can handle them normally
- **Session lifecycle**: `session.close()` MUST be called in the `finally` block of every `run()` invocation. The session emits `SESSION_END` on close; do NOT close twice (the session emits `SESSION_END` only once, but multiple `close()` calls are idempotent since state is already CLOSED)
- **`GraphNode.backend` is a new field**: add it to the interface AFTER the existing `toolCommand` field to minimize diff impact on existing code

### Key File Locations
- **New**: `packages/factory/src/backend/direct-backend.ts` — primary deliverable
- **Modify**: `packages/factory/src/backend/index.ts` — add DirectCodergenBackend exports
- **Modify**: `packages/factory/src/graph/types.ts` — add `backend: string` to `GraphNode`
- **Modify**: `packages/factory/src/graph/parser.ts` — parse `backend` DOT attribute
- **Modify**: `packages/factory/src/handlers/codergen-handler.ts` — add `directBackend` option and per-node routing
- **New**: `packages/factory/src/backend/__tests__/direct-backend.test.ts` — unit tests
- **Modify**: `packages/factory/src/handlers/__tests__/codergen-handler.test.ts` — extend for directBackend

### DirectCodergenBackend Implementation Pattern
```typescript
// packages/factory/src/backend/direct-backend.ts

import { createSession } from '../agent/loop.js'
import type { LLMClient } from '../llm/client.js'
import type { ProviderProfile } from '../agent/tools/profiles.js'
import type { ExecutionEnvironment } from '../agent/tools/types.js'
import { EventKind, type SessionConfig, type SessionEvent } from '../agent/types.js'
import type { GraphNode, IGraphContext, Outcome } from '../graph/types.js'
import type { ICodergenBackend } from './types.js'

export interface DirectBackendOptions {
  llmClient: LLMClient
  providerProfile: ProviderProfile
  executionEnv: ExecutionEnvironment
  config?: Partial<SessionConfig>
  onEvent?: (event: SessionEvent) => void
}

export class DirectCodergenBackend implements ICodergenBackend {
  constructor(private readonly options: DirectBackendOptions) {}

  async run(node: GraphNode, prompt: string, _context: IGraphContext): Promise<Outcome> {
    const { llmClient, providerProfile, executionEnv, config, onEvent } = this.options
    const session = createSession({ llmClient, providerProfile, executionEnv, config })

    let turnLimitHit = false

    // Subscribe to all events before processInput
    if (onEvent) {
      for (const kind of Object.values(EventKind)) {
        session.on(kind, onEvent)
      }
    }

    // Separately track turn limit regardless of onEvent
    session.on(EventKind.TURN_LIMIT, () => { turnLimitHit = true })

    try {
      await session.processInput(prompt)
    } catch (err: unknown) {
      const failureReason = err instanceof Error ? err.message : String(err)
      return { status: 'FAILURE', failureReason }
    } finally {
      session.close()
    }

    if (turnLimitHit) {
      return { status: 'FAILURE', failureReason: 'turn limit exceeded' }
    }

    // Extract final assistant text from history
    const finalAssistantTurn = [...session.history]
      .reverse()
      .find(t => t.type === 'assistant')

    if (!finalAssistantTurn || finalAssistantTurn.type !== 'assistant') {
      return { status: 'SUCCESS' }
    }

    return {
      status: 'SUCCESS',
      contextUpdates: { [`${node.id}_output`]: finalAssistantTurn.content },
    }
  }
}

export function createDirectCodergenBackend(options: DirectBackendOptions): DirectCodergenBackend {
  return new DirectCodergenBackend(options)
}
```

### GraphNode Addition Pattern
```typescript
// In packages/factory/src/graph/types.ts — add after toolCommand:
/** Backend selector for codergen nodes ('direct' → DirectCodergenBackend). Story 48-10. */
backend: string

// In packages/factory/src/graph/parser.ts — add alongside toolCommand:
backend: attrStr(attrs, 'backend', ''),
```

### Codergen Handler Extension Pattern
```typescript
// In CodergenHandlerOptions (add field):
/** Backend instance used when node.backend === 'direct'. Story 48-10. */
directBackend?: ICodergenBackend

// In createCodergenHandler, AFTER the existing options?.backend check:
if (node.backend === 'direct' && options?.directBackend) {
  return options.directBackend.run(node, interpolatedPrompt, context)
}
```

### Testing Requirements
- Use vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`)
- Mock `createSession` with `vi.mock('../../agent/loop.js', ...)` — return a fake session object where `on(kind, handler)` stores handlers by kind for later invocation, `processInput()` calls stored handlers to simulate events, and `close()` is a `vi.fn()`
- Do NOT make real LLM calls or spawn real processes
- Simulate TURN_LIMIT event by having the mock `processInput` call the TURN_LIMIT handler before resolving
- Simulate TOOL_CALL_START/END events similarly to verify onEvent forwarding
- Run with `npm run test:fast` (timeout 300000ms) — never pipe output
- Verify `session.close()` spy is called even when `processInput` throws

### Note on Double-Close Safety
`session.close()` transitions state to CLOSED and emits SESSION_END. The `finally` block always calls it. If `processInput` throws, the session internally sets `state = CLOSED` (see loop.ts line 414) but does NOT call `close()` itself — so the `finally` block's `session.close()` is safe and necessary. The `close()` method does not guard against being called twice, but double-close only emits a redundant SESSION_END — acceptable and harmless. If this is a concern, guard with `if (session.state !== 'CLOSED') session.close()`.

## Interface Contracts

- **Import**: `createSession`, `CodingAgentSession`, `CreateSessionOptions` @ `packages/factory/src/agent/loop.ts` (from story 48-7)
- **Import**: `EventKind`, `SessionConfig`, `SessionEvent` @ `packages/factory/src/agent/types.ts` (from story 48-7, extended by 48-9)
- **Import**: `LLMClient` @ `packages/factory/src/llm/client.ts` (from story 48-5a)
- **Import**: `ProviderProfile` @ `packages/factory/src/agent/tools/profiles.ts` (from story 48-6)
- **Import**: `ExecutionEnvironment` @ `packages/factory/src/agent/tools/types.ts` (from story 48-6)
- **Import**: `ICodergenBackend`, `GraphNode`, `IGraphContext`, `Outcome` @ existing types (no new contracts)
- **Export**: `DirectCodergenBackend` (class) @ `packages/factory/src/backend/direct-backend.ts` (consumed by story 48-11 parity tests and pipeline configuration)
- **Export**: `DirectBackendOptions` @ `packages/factory/src/backend/direct-backend.ts` (consumed by story 48-11 and host application setup)
- **Export**: `createDirectCodergenBackend` @ `packages/factory/src/backend/direct-backend.ts` (consumed by story 48-11 and 48-12)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
