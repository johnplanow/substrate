# Story 48-11: Direct vs CLI Backend Parity Test

## Story

As a pipeline operator,
I want a parity test suite that verifies `DirectCodergenBackend` and the CLI `callLLM` path produce structurally equivalent outcomes for the same codergen tasks,
so that I can confidently deploy either backend knowing their observable differences are intentional and documented.

## Acceptance Criteria

### AC1: SUCCESS Outcome Structure Is Identical Across Both Backends
**Given** `createCodergenHandler()` (CLI path, uses `callLLM`) and `createCodergenHandler({ directBackend })` with `node.backend='direct'`
**When** both receive the same node id and both mock responses return the same response text `'implementation output'`
**Then** both return `{ status: 'SUCCESS', contextUpdates: { node1_output: 'implementation output' } }` — the `status` and `contextUpdates` shape are structurally identical; the CLI path additionally sets `notes` (acceptable documented difference)

### AC2: FAILURE Outcome Is Structurally Comparable
**Given** the CLI path throws a non-transient error (`new Error('unknown failure')`) and the direct backend's mock session emits `TURN_LIMIT`
**When** both handlers execute the same node and prompt
**Then** the CLI path returns `{ status: 'FAILURE' }` and the direct path returns `{ status: 'FAILURE', failureReason: 'turn limit exceeded' }` — both outcomes carry `status: 'FAILURE'`; `failureReason` is available on the direct path but `error` is available on the CLI path

### AC3: Direct Backend Exposes Tool Call Events Absent from CLI Path
**Given** the same codergen task dispatched through both CLI path and `DirectCodergenBackend`
**When** the direct backend session emits `TOOL_CALL_START` and `TOOL_CALL_END` events during tool execution, and an `onEvent` collector is attached to the direct backend
**Then** the collector receives both `TOOL_CALL_START` and `TOOL_CALL_END` events with tool name and call id metadata
**And** the CLI path produces zero session events (no event bus integration in `callLLM`)

### AC4: Direct Backend Exposes Loop Detection Signal Absent from CLI Path
**Given** the direct backend session emits a `LOOP_DETECTION` event (simulating a repetitive tool call pattern)
**When** an `onEvent` collector is active on the direct backend
**Then** the `LOOP_DETECTION` event is captured with its metadata payload
**And** the CLI path emits no equivalent signal — no loop detection is possible via the `callLLM` interface

### AC5: Direct Backend Exposes Per-Turn Token Usage; CLI Path Does Not
**Given** the direct backend's mock session history contains an `AssistantTurn` with `usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 }`
**When** the direct backend completes successfully
**Then** token usage is readable from `session.history` via the last `AssistantTurn.usage` (inputTokens: 100, outputTokens: 50, totalTokens: 150)
**And** the CLI `callLLM` path returns only `LLMCallResult { text: string }` with no token usage field — confirming that token observability is only available through the direct backend

### AC6: Multiple Sequential Invocations Produce Independent Outcomes
**Given** both backends are invoked three times in sequence with the same prompt
**When** each call completes
**Then** all three CLI outcomes and all three direct outcomes independently return `{ status: 'SUCCESS' }`
**And** no state leaks between invocations (each direct backend `run()` call creates a fresh session via `createSession`, as verified by the spy call count)

## Tasks / Subtasks

- [ ] Task 1: Create parity test file with mock scaffolding (AC: all)
  - [ ] Create `packages/factory/src/backend/__tests__/parity.test.ts` with vitest imports
  - [ ] Declare `vi.mock('@substrate-ai/core', () => ({ callLLM: vi.fn() }))` (hoisted) for the CLI path
  - [ ] Declare `vi.mock('../../agent/loop.js', () => ({ createSession: vi.fn(() => mockSession) }))` (hoisted) for the direct path
  - [ ] Import `callLLM` from `@substrate-ai/core` and `createSession` from `../../agent/loop.js` after mock declarations
  - [ ] Implement module-level mutable state (`mockHandlers`, `mockHistory`, `mockProcessInput`, `mockClose`, `mockSession`) following the pattern from `direct-backend.test.ts`
  - [ ] Implement `beforeEach` to reset all mock state and reconstitute `mockSession` with fresh `vi.fn()` instances
  - [ ] Implement helpers: `makeNode(overrides)`, `makeContext()`, `makeGraph()`, `makeAssistantTurn(content, usage?)`, `emitEvent(kind, data)`
  - [ ] Implement `buildDirectBackend(onEvent?)` helper that calls `createDirectCodergenBackend({ llmClient, providerProfile, executionEnv, onEvent })`

- [ ] Task 2: Implement AC1 and AC2 — outcome structure parity tests (AC: #1, #2)
  - [ ] AC1 test: run `createCodergenHandler()` with `mockCallLLM.mockResolvedValue({ text: 'implementation output' })`; assert `outcome.status === 'SUCCESS'` and `outcome.contextUpdates?.['node1_output'] === 'implementation output'`
  - [ ] AC1 test: run `createCodergenHandler({ directBackend })` with `node.backend='direct'` and mock session history containing `makeAssistantTurn('implementation output')`; assert same `status` and `contextUpdates['node1_output']`
  - [ ] AC1 assertion: show `contextUpdates` key names are identical (`node1_output`) and values are identical (`'implementation output'`)
  - [ ] AC1 documented difference test: assert CLI outcome includes `notes === 'implementation output'` while direct outcome does NOT include `notes`
  - [ ] AC2 test: CLI path with `mockCallLLM.mockRejectedValue(new Error('unknown failure'))` → `outcome.status === 'FAILURE'`; direct path with TURN_LIMIT emitted during processInput → `outcome.status === 'FAILURE'`
  - [ ] AC2 assertion: CLI outcome has `error` property; direct outcome has `failureReason === 'turn limit exceeded'`

- [ ] Task 3: Implement AC3 and AC4 — event visibility difference tests (AC: #3, #4)
  - [ ] AC3 setup: configure `mockProcessInput` to emit `TOOL_CALL_START` and `TOOL_CALL_END` before resolving; push an `AssistantTurn` to `mockHistory`
  - [ ] AC3 test: create direct backend with `onEvent` collector array; invoke `createCodergenHandler({ directBackend })` with `node.backend='direct'`; assert collected event kinds include `EventKind.TOOL_CALL_START` and `EventKind.TOOL_CALL_END` with correct metadata (`tool_name`, `call_id`)
  - [ ] AC3 test: invoke CLI handler for the same prompt; assert `mockCallLLM` was called; assert no `TOOL_CALL_START` or `TOOL_CALL_END` events exist (no event bus on CLI path)
  - [ ] AC4 test: configure `mockProcessInput` to emit `LOOP_DETECTION` with metadata `{ message: 'loop detected: pattern length 2 repeated 5 times' }`
  - [ ] AC4 test: attach `onEvent` collector; run direct backend; assert `LOOP_DETECTION` event captured with metadata
  - [ ] AC4 test: confirm CLI path has no equivalent — the mock `callLLM` is a simple function call with no event system

- [ ] Task 4: Implement AC5 — token usage observability tests (AC: #5)
  - [ ] AC5 test: push `makeAssistantTurn('result', { inputTokens: 100, outputTokens: 50, totalTokens: 150 })` to `mockHistory`; run direct backend; read `session.history` to find the last `AssistantTurn`; assert `usage.inputTokens === 100`, `usage.outputTokens === 50`, `usage.totalTokens === 150`
  - [ ] AC5 test: run CLI path with `mockCallLLM.mockResolvedValue({ text: 'result' })`; capture the return value; assert it has no `usage` property — `LLMCallResult` only contains `text`
  - [ ] AC5 assertion: document that token observability requires direct backend; CLI path requires out-of-band instrumentation

- [ ] Task 5: Implement AC6 — isolation and no-state-leak tests (AC: #6)
  - [ ] AC6 test: invoke CLI handler three times sequentially with `mockCallLLM` returning different texts each time (`'output-1'`, `'output-2'`, `'output-3'`); assert each outcome has `status: 'SUCCESS'` and the correct `contextUpdates` value
  - [ ] AC6 test: invoke direct backend three times sequentially; each time `mockHistory` has a different `AssistantTurn`; assert `createSession` was called exactly 3 times (verified via `vi.mocked(createSession).mock.calls.length`)
  - [ ] AC6 test: assert each direct backend invocation's `session.close()` was called (total 3 times), confirming session lifecycle is managed per-invocation

## Dev Notes

### Architecture Constraints
- **Test-only story**: no production source files are added or modified — the single deliverable is `packages/factory/src/backend/__tests__/parity.test.ts`
- **ESM imports with `.js` extensions**: all relative imports must use `.js` (e.g., `../../agent/loop.js`, `../../handlers/codergen-handler.js`)
- **Named exports only**: no default exports
- **No real LLM calls**: all LLM interactions must be mocked; `callLLM` mocked via `vi.mock('@substrate-ai/core')`, `createSession` mocked via `vi.mock('../../agent/loop.js')`
- **Vitest only**: use `describe`, `it`, `expect`, `vi`, `beforeEach`; no external test libraries
- **vi.mock hoisting**: `vi.mock` calls must appear at the top of the file before any imports that transitively load the mocked modules (vitest hoists them at transpile time)
- **packages/factory must not import from packages/sdlc** (ADR-003) — this test only imports from `packages/factory/src/...` and `@substrate-ai/core`

### Key File Locations
- **New**: `packages/factory/src/backend/__tests__/parity.test.ts` — primary deliverable
- **Read** (for patterns): `packages/factory/src/backend/__tests__/direct-backend.test.ts` — session mock pattern
- **Read** (for patterns): `packages/factory/src/handlers/__tests__/codergen-handler.test.ts` — `callLLM` mock pattern

### Mock Session Pattern
Follow the same mock session pattern established in `direct-backend.test.ts`:
```typescript
let mockHandlers: Map<string, Array<(event: SessionEvent) => void>>
let mockHistory: Turn[]
let mockProcessInput: ReturnType<typeof vi.fn>
let mockClose: ReturnType<typeof vi.fn>
let mockSession: { on: ...; processInput: ...; close: ...; history: Turn[] }

vi.mock('../../agent/loop.js', () => ({
  createSession: vi.fn(() => mockSession),
}))

function emitEvent(kind: EventKind, data: Record<string, unknown> = {}): void {
  const handlers = mockHandlers.get(kind) ?? []
  const event: SessionEvent = { kind, timestamp: new Date(), session_id: 'test-session', data }
  for (const h of handlers) h(event)
}
```

### makeAssistantTurn with Usage Pattern
```typescript
import type { AssistantTurn, LLMUsage } from '../../agent/types.js'

function makeAssistantTurn(content: string, usage?: Partial<LLMUsage>): AssistantTurn {
  return {
    type: 'assistant',
    content,
    tool_calls: [],
    reasoning: null,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, ...usage },
    response_id: null,
    timestamp: new Date(),
  }
}
```

### Handler Invocation Pattern
```typescript
import { createCodergenHandler } from '../../handlers/codergen-handler.js'
import { createDirectCodergenBackend } from '../direct-backend.js'
import type { GraphNode, IGraphContext, Graph } from '../../graph/types.js'
import { GraphContext } from '../../graph/context.js'

// Minimal graph stub
const fakeGraph: Graph = { nodes: [], edges: [], stylesheets: [] }

// CLI path (uses callLLM under the hood)
const cliHandler = createCodergenHandler()
const cliOutcome = await cliHandler(makeNode({ id: 'node1' }), makeContext(), fakeGraph)

// Direct path (uses DirectCodergenBackend under the hood)
const collectedEvents: SessionEvent[] = []
const directBackend = createDirectCodergenBackend({
  llmClient: {} as LLMClient,
  providerProfile: {} as ProviderProfile,
  executionEnv: {} as ExecutionEnvironment,
  onEvent: (e) => collectedEvents.push(e),
})
const directHandler = createCodergenHandler({ directBackend })
const directOutcome = await directHandler(makeNode({ id: 'node1', backend: 'direct' }), makeContext(), fakeGraph)
```

### AC1 Documented Difference: notes Field
The CLI path sets `notes: responseText` on the SUCCESS outcome (see `codergen-handler.ts` line ~205). `DirectCodergenBackend` does not set `notes`. This is an intentional, documented difference — the core parity is in `status` and `contextUpdates[nodeId_output]`. The parity test must assert this difference explicitly rather than treating it as a failure.

### AC2 Error Shape Difference
CLI path wraps errors in `{ status: 'FAILURE', error: <Error> }` while `DirectCodergenBackend` wraps them in `{ status: 'FAILURE', failureReason: string }`. These carry the same semantic (failure) via different fields. The parity test must assert `status === 'FAILURE'` on both and verify the appropriate error field on each path.

### Token Usage Difference (AC5)
`LLMCallResult` (from `@substrate-ai/core`) has only `{ text: string }` — no `usage`. Token observability on the CLI path requires out-of-band instrumentation at a higher level (e.g., the dispatch layer). The direct backend exposes `AssistantTurn.usage` on every turn in `session.history`, making per-call token tracking built-in.

### Graph Type for Handler Tests
`createCodergenHandler` returns a `NodeHandler` with signature `(node, context, graph) => Promise<Outcome>`. A minimal stub for `graph` is acceptable: `const fakeGraph = { nodes: [], edges: [], stylesheets: [] } as unknown as Graph`.

### Testing Requirements
- Run with `npm run test:fast` (timeout 300000ms) — never pipe output
- Do NOT use `npm run test:changed` alone — verify with `npm run test:fast` before marking complete
- Minimum 14 test cases covering all 6 ACs
- Verify `pgrep -f vitest` returns nothing before running (no concurrent vitest instances)

## Interface Contracts

- **Import**: `createCodergenHandler`, `CodergenHandlerOptions` @ `packages/factory/src/handlers/codergen-handler.ts` (from story 42-10, extended by 48-10)
- **Import**: `createDirectCodergenBackend`, `DirectBackendOptions` @ `packages/factory/src/backend/direct-backend.ts` (from story 48-10)
- **Import**: `EventKind`, `SessionEvent`, `Turn`, `AssistantTurn`, `LLMUsage` @ `packages/factory/src/agent/types.ts` (from story 48-7)
- **Import**: `createSession` @ `packages/factory/src/agent/loop.ts` (from story 48-7) — mocked only
- **Import**: `callLLM` @ `@substrate-ai/core` (from story 42-10) — mocked only
- **Import**: `GraphContext` @ `packages/factory/src/graph/context.ts` (established utility)
- **Import**: `GraphNode`, `IGraphContext`, `Graph` @ `packages/factory/src/graph/types.ts`
- **Import**: `LLMClient` @ `packages/factory/src/llm/client.ts` — used as type stub only
- **Import**: `ProviderProfile` @ `packages/factory/src/agent/tools/profiles.ts` — used as type stub only
- **Import**: `ExecutionEnvironment` @ `packages/factory/src/agent/tools/types.ts` — used as type stub only

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
