# Story 48-12: Factory CLI Direct Backend Integration

## Story

As a pipeline operator,
I want to run `substrate factory run --backend direct`,
so that I get per-turn visibility into tool calls, loop detection, and steering injections without relying on the Claude CLI.

## Acceptance Criteria

### AC1: `--backend` CLI Flag and Config Wiring
**Given** `factory run --backend direct` is invoked (or `factory.backend: direct` set in config.yaml)
**When** the factory run command initializes
**Then** the effective backend is resolved with the CLI `--backend` flag taking precedence over the config value; `'direct'` triggers `DirectCodergenBackend` setup; `'cli'` (default) preserves existing behavior unchanged

### AC2: Direct Backend Bootstrap
**Given** `backend=direct` is the effective mode and `factory.direct_backend.provider` resolves to `'anthropic'` (or the configured provider)
**When** the factory run command creates the backend
**Then** the appropriate provider adapter is instantiated from the matching environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `GEMINI_API_KEY`); if the required env var is missing, the command writes a clear error to stderr and exits before dispatching any nodes

### AC3: Direct Backend Injected into Registry
**Given** `DirectCodergenBackend` has been bootstrapped successfully
**When** `createDefaultRegistry` is called
**Then** the backend is passed via `CodergenHandlerOptions.directBackend`; `createDefaultRegistry` is extended to accept an optional `CodergenHandlerOptions` argument and forward it to all `createCodergenHandler()` calls (explicit type, shape mapping, and default); existing behavior is unchanged when no options are passed

### AC4: Agent Events Forwarded to Factory Event Bus
**Given** `backend=direct` is active and the agent loop emits `TOOL_CALL_START`, `TOOL_CALL_END`, `LOOP_DETECTION`, or `STEERING_INJECTED` session events during node execution
**When** the `onEvent` callback on `DirectCodergenBackend` fires
**Then** the factory event bus emits the corresponding `agent:tool-call`, `agent:loop-detected`, or `agent:steering-injected` factory event containing `{ runId, nodeId, ...relevant fields }`; only these four kinds are forwarded — all other session event kinds are ignored

### AC5: New Agent Event Types in FactoryEvents
**Given** the factory event bus emits agent lifecycle events during a `--backend direct` run
**When** `--events` is active
**Then** `agent:tool-call`, `agent:loop-detected`, and `agent:steering-injected` events appear in the NDJSON stream; the `FactoryEvents` type map is extended with these three event types with their documented payload shapes

### AC6: Config Schema Extended with `direct_backend` Section
**Given** the factory config is parsed from config.yaml
**When** `factory.direct_backend` is present (or absent)
**Then** the sub-object validates and provides: `provider` (`'anthropic' | 'openai' | 'gemini'`, default `'anthropic'`), `model` (string, default `'claude-3-5-sonnet-20241022'`), `max_turns` (integer ≥1, default `20`); if the `direct_backend` block is absent entirely, all defaults apply

### AC7: Integration Tests for Direct Backend Wiring
**Given** `bootstrapDirectBackend` is mocked to return a spy `DirectCodergenBackend` and a mock LLM response is configured
**When** factory command tests exercise `--backend direct` with a minimal single-node codergen graph
**Then** `DirectCodergenBackend.run()` is called with the node prompt; agent events passed to `onEvent` are forwarded to the factory event bus; `--events` NDJSON output includes `agent:tool-call` lines

## Tasks / Subtasks

- [ ] Task 1: Extend `FactoryConfigSchema` in `packages/factory/src/config.ts` (AC: #6)
  - [ ] Add `direct_backend` optional object field after `quality_mode` in `FactoryConfigSchema`:
    ```ts
    direct_backend: z.object({
      provider: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
      model: z.string().default('claude-3-5-sonnet-20241022'),
      max_turns: z.number().int().min(1).default(20),
    }).default({}),
    ```
  - [ ] Verify the outer `.strict()` still compiles after adding the new field
  - [ ] Confirm `FactoryConfig` inferred type includes `direct_backend` with correct defaults

- [ ] Task 2: Add agent event types to `packages/factory/src/events.ts` (AC: #5)
  - [ ] Add three new event keys under a `// Agent session events (story 48-12)` comment:
    ```ts
    'agent:tool-call': {
      runId: string
      nodeId: string
      toolName: string
      direction: 'call' | 'result'
      inputSummary?: string
    }
    'agent:loop-detected': {
      runId: string
      nodeId: string
      windowSize: number
      pattern: string[]
    }
    'agent:steering-injected': {
      runId: string
      nodeId: string
      message: string
    }
    ```

- [ ] Task 3: Create `packages/factory/src/backend/direct-bootstrap.ts` (AC: #2)
  - [ ] Define and export `DirectBootstrapOptions` interface:
    ```ts
    export interface DirectBootstrapOptions {
      provider: string
      model: string
      maxTurns: number
      projectDir: string
      onEvent?: (event: SessionEvent) => void
    }
    ```
  - [ ] Implement `export function bootstrapDirectBackend(opts: DirectBootstrapOptions): DirectCodergenBackend`
  - [ ] For each provider, read the matching env var: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`; throw `Error('<VAR> environment variable is required for direct backend with <provider> provider')` when missing
  - [ ] Instantiate the correct provider adapter (`AnthropicAdapter`, `OpenAIAdapter`, or `GeminiAdapter`) with `{ apiKey }`
  - [ ] Create `new LLMClient()`, call `client.registerProvider(provider, adapter)` and `client.registerModelPattern(modelGlob, provider)` (globs: `'claude-*'`, `'gpt-*'`, `'gemini-*'`)
  - [ ] Resolve `providerProfile`: `AnthropicProfile` / `OpenAIProfile` / `GeminiProfile` per provider
  - [ ] Construct `executionEnv` — inspect `ExecutionEnvironment` in `packages/factory/src/agent/tools/types.ts` and satisfy its interface using `child_process.execSync` with `cwd: opts.projectDir`
  - [ ] Return `createDirectCodergenBackend({ llmClient: client, providerProfile, executionEnv, config: { max_turns: opts.maxTurns }, onEvent: opts.onEvent })`
  - [ ] Throw `Error(\`Unknown direct backend provider: ${opts.provider}\`)` for unrecognised provider strings

- [ ] Task 4: Extend `createDefaultRegistry` in `packages/factory/src/handlers/registry.ts` (AC: #3)
  - [ ] Import `CodergenHandlerOptions` type from `'./codergen-handler.js'`
  - [ ] Change signature to `export function createDefaultRegistry(options?: CodergenHandlerOptions): HandlerRegistry`
  - [ ] Pass `options` to all `createCodergenHandler(options)` invocations: the `'codergen'` type registration, the `setDefault(...)` call, and any other references
  - [ ] No functional change when `options` is `undefined` — existing tests must continue to pass

- [ ] Task 5: Wire direct backend in `packages/factory/src/factory-command.ts` (AC: #1, #2, #3, #4, #5)
  - [ ] Add `.option('--backend <mode>', 'Backend: cli | direct (overrides config factory.backend)')` to the `factory run` command
  - [ ] After `factoryConfig` is loaded, compute: `const effectiveBackend = (opts.backend ?? factoryConfig.factory?.backend ?? 'cli') as 'cli' | 'direct'`
  - [ ] If `effectiveBackend === 'direct'`:
    - [ ] Declare `let directBackend: DirectCodergenBackend | undefined`
    - [ ] Track currently-executing node for event correlation: `let currentNodeId = ''`; register `eventBus.on('graph:node-started', (e) => { currentNodeId = e.nodeId })` before the executor runs
    - [ ] Build `onDirectEvent` callback that inspects `event.kind` and emits the matching factory event via `eventBus.emit(...)`:
      - `EventKind.TOOL_CALL_START` → `agent:tool-call` with `direction: 'call'`, `toolName` extracted from event
      - `EventKind.TOOL_CALL_END` → `agent:tool-call` with `direction: 'result'`, `toolName` extracted from event
      - `EventKind.LOOP_DETECTION` → `agent:loop-detected` with `windowSize` and `pattern` from event
      - `EventKind.STEERING_INJECTED` → `agent:steering-injected` with `message` from event
      - All other kinds: no-op
    - [ ] Call `bootstrapDirectBackend` wrapped in try/catch; on error write to stderr and `process.exit(1)`; assign result to `directBackend`
  - [ ] Replace `createDefaultRegistry()` with `createDefaultRegistry(directBackend ? { directBackend } : undefined)`
  - [ ] When `opts.events` is set, register `agent:tool-call`, `agent:loop-detected`, and `agent:steering-injected` events for NDJSON emission (same pattern as existing event registrations)
  - [ ] Add imports: `bootstrapDirectBackend` from `'./backend/direct-bootstrap.js'`; `EventKind` from `'./agent/types.js'`; `DirectCodergenBackend` type from `'./backend/direct-backend.js'`

- [ ] Task 6: Write unit tests in `packages/factory/src/backend/__tests__/direct-bootstrap.test.ts` (AC: #2)
  - [ ] Mock all three provider adapters with `vi.mock('../../llm/providers/anthropic.js', ...)` etc.; each mock returns a sentinel object
  - [ ] Mock `createDirectCodergenBackend` with `vi.mock('../../backend/direct-backend.js', ...)`; capture options passed to it
  - [ ] Use `vi.stubEnv` + `afterEach(() => vi.unstubAllEnvs())` for env var isolation
  - [ ] Test: `provider='anthropic'` + `ANTHROPIC_API_KEY='test-key'` → `AnthropicAdapter` constructor called with `{ apiKey: 'test-key' }`; `createDirectCodergenBackend` called with `AnthropicProfile`
  - [ ] Test: `provider='openai'` + `OPENAI_API_KEY='test-key'` → `OpenAIAdapter` constructor called; `OpenAIProfile` used
  - [ ] Test: `provider='gemini'` + `GEMINI_API_KEY='test-key'` → `GeminiAdapter` constructor called; `GeminiProfile` used
  - [ ] Test: `provider='anthropic'` with `ANTHROPIC_API_KEY` unset → throws with message containing `'ANTHROPIC_API_KEY'`
  - [ ] Test: `provider='openai'` with `OPENAI_API_KEY` unset → throws with message containing `'OPENAI_API_KEY'`
  - [ ] Test: unknown provider string → throws `Error` containing `'Unknown direct backend provider'`
  - [ ] Test: `maxTurns=5` is forwarded to `createDirectCodergenBackend` config
  - [ ] Test: `onEvent` callback is forwarded unchanged to `createDirectCodergenBackend` options

- [ ] Task 7: Write integration tests in `packages/factory/src/factory-command.test.ts` (AC: #7)
  - [ ] Add a `describe('factory run --backend direct', ...)` block in the existing file
  - [ ] Use `vi.mock('./backend/direct-bootstrap.js')` at the top of the test block; provide a mock `bootstrapDirectBackend` that returns a `DirectCodergenBackend` stub whose `run()` resolves to `{ status: 'SUCCESS' }`
  - [ ] Test: invoking `factory run` with `--backend direct` and a minimal valid single-node codergen DOT graph causes the mock `directBackend.run()` to be called
  - [ ] Test: `onEvent` forwarding — simulate a `TOOL_CALL_START` event via the captured `onEvent` callback and assert `eventBus` emitted `agent:tool-call` with `direction: 'call'`
  - [ ] Test: with `--events` flag active, NDJSON output contains a line parseable as `{ type: 'agent:tool-call', ... }` after the `onEvent` fires
  - [ ] Test: missing `ANTHROPIC_API_KEY` (not mocking bootstrap) → process exits with non-zero code and stderr contains the env-var name

- [ ] Task 8: Update barrel exports in `packages/factory/src/backend/index.ts` (AC: all)
  - [ ] Add `export { bootstrapDirectBackend } from './direct-bootstrap.js'`
  - [ ] Add `export type { DirectBootstrapOptions } from './direct-bootstrap.js'`

## Dev Notes

### Architecture Constraints
- **ESM imports**: all imports within `packages/factory/` MUST use `.js` extensions (e.g., `import { bootstrapDirectBackend } from './backend/direct-bootstrap.js'`)
- **Named exports only**: no default exports anywhere in `packages/factory/`
- **ADR-003**: `packages/factory` MUST NOT import from `packages/sdlc`; the new `direct-bootstrap.ts` imports only from within `packages/factory/src/` (agent, llm, backend) — no cross-package violations
- **`createDefaultRegistry` backward compat**: options parameter is optional; passing `undefined` is identical to the current no-arg call — all existing callers and tests continue working without modification
- **Only four session event kinds are forwarded**: `TOOL_CALL_START`, `TOOL_CALL_END`, `LOOP_DETECTION`, `STEERING_INJECTED`; forwarding all 14 kinds would flood the factory event bus with internal agent lifecycle noise
- **Fail-fast on missing API key**: bootstrap error must occur before `executor.run()` is called; the `try/catch` around `bootstrapDirectBackend` must include `process.exit(1)` so the graph never starts
- **`SessionEvent.kind` field access**: inspect `packages/factory/src/agent/types.ts` to confirm exact field names on the event payload for `TOOL_CALL_START` (likely `toolName`), `LOOP_DETECTION` (likely `windowSize`, `pattern`), and `STEERING_INJECTED` (likely `message`) before writing the forwarding lambda

### Key File Locations
- **Modify**: `packages/factory/src/config.ts` — extend `FactoryConfigSchema` with `direct_backend`
- **Modify**: `packages/factory/src/events.ts` — add `agent:tool-call`, `agent:loop-detected`, `agent:steering-injected`
- **New**: `packages/factory/src/backend/direct-bootstrap.ts` — `bootstrapDirectBackend` function
- **Modify**: `packages/factory/src/handlers/registry.ts` — `createDefaultRegistry(options?)` signature
- **Modify**: `packages/factory/src/factory-command.ts` — `--backend` flag, direct backend wiring
- **New**: `packages/factory/src/backend/__tests__/direct-bootstrap.test.ts` — bootstrap unit tests
- **Modify**: `packages/factory/src/factory-command.test.ts` — `--backend direct` integration tests
- **Modify**: `packages/factory/src/backend/index.ts` — add bootstrap exports

### Config Schema Extension Pattern
```typescript
// In FactoryConfigSchema (config.ts), add after quality_mode:
direct_backend: z.object({
  provider: z.enum(['anthropic', 'openai', 'gemini']).default('anthropic'),
  model: z.string().default('claude-3-5-sonnet-20241022'),
  max_turns: z.number().int().min(1).default(20),
}).default({}),
```

### Event Forwarding Pattern
```typescript
// In factory-command.ts — build onDirectEvent after eventBus is created:
let currentNodeId = ''
eventBus.on('graph:node-started', (e) => { currentNodeId = e.nodeId })

const onDirectEvent = (event: SessionEvent) => {
  if (event.kind === EventKind.TOOL_CALL_START) {
    eventBus.emit('agent:tool-call', {
      runId, nodeId: currentNodeId,
      toolName: (event as { toolName?: string }).toolName ?? '',
      direction: 'call',
    })
  } else if (event.kind === EventKind.TOOL_CALL_END) {
    eventBus.emit('agent:tool-call', {
      runId, nodeId: currentNodeId,
      toolName: (event as { toolName?: string }).toolName ?? '',
      direction: 'result',
    })
  } else if (event.kind === EventKind.LOOP_DETECTION) {
    eventBus.emit('agent:loop-detected', {
      runId, nodeId: currentNodeId,
      windowSize: (event as { windowSize?: number }).windowSize ?? 0,
      pattern: (event as { pattern?: string[] }).pattern ?? [],
    })
  } else if (event.kind === EventKind.STEERING_INJECTED) {
    eventBus.emit('agent:steering-injected', {
      runId, nodeId: currentNodeId,
      message: (event as { message?: string }).message ?? '',
    })
  }
}
```
> **Note:** Replace the unsafe casts with proper typed field access after reading `packages/factory/src/agent/types.ts` — the exact payload field names depend on the `SessionEvent` union type defined in story 48-7.

### createDefaultRegistry Extension Pattern
```typescript
// In registry.ts — change signature and propagate options:
import type { CodergenHandlerOptions } from './codergen-handler.js'

export function createDefaultRegistry(options?: CodergenHandlerOptions): HandlerRegistry {
  const registry = new HandlerRegistry()
  registry.register('start', startHandler)
  registry.register('exit', exitHandler)
  registry.register('conditional', conditionalHandler)
  registry.register('codergen', createCodergenHandler(options))  // pass options
  registry.register('tool', createToolHandler())
  registry.register('wait.human', createWaitHumanHandler())
  registry.registerShape('Mdiamond', 'start')
  registry.registerShape('Msquare', 'exit')
  registry.registerShape('diamond', 'conditional')
  registry.registerShape('box', 'codergen')
  registry.setDefault(createCodergenHandler(options))           // pass options
  return registry
}
```

### NDJSON Registration Pattern
```typescript
// In factory-command.ts — add alongside existing event registrations inside if (opts.events):
eventBus.on('agent:tool-call', (e) => emit({ type: 'agent:tool-call', ...e }))
eventBus.on('agent:loop-detected', (e) => emit({ type: 'agent:loop-detected', ...e }))
eventBus.on('agent:steering-injected', (e) => emit({ type: 'agent:steering-injected', ...e }))
```

### Testing Requirements
- Framework: vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`)
- No real LLM API calls — mock all three provider adapters with `vi.mock`
- Use `vi.stubEnv` for env var isolation; call `vi.unstubAllEnvs()` in `afterEach`
- Factory command integration tests: mock `bootstrapDirectBackend` at module level so no adapter is constructed; inject a stub `DirectCodergenBackend` with `vi.fn()` implementations
- Run with `npm run test:fast` (timeout 300000ms) — never pipe test output through grep/head/tail
- Confirm test results by checking for `Test Files` in the output, not just exit code

### LLMClient Constructor Note
Verify `new LLMClient()` constructor signature in `packages/factory/src/llm/client.ts` before implementing `bootstrapDirectBackend`. If it requires a `ModelRegistry` argument, construct one explicitly. If the constructor accepts no arguments (internal registry), use `new LLMClient()` directly.

## Interface Contracts

- **Import**: `EventKind`, `SessionEvent` @ `packages/factory/src/agent/types.ts` (from story 48-7)
- **Import**: `AnthropicAdapter` @ `packages/factory/src/llm/providers/anthropic.ts` (from story 48-2)
- **Import**: `OpenAIAdapter` @ `packages/factory/src/llm/providers/openai.ts` (from story 48-3)
- **Import**: `GeminiAdapter` @ `packages/factory/src/llm/providers/gemini.ts` (from story 48-4)
- **Import**: `LLMClient` @ `packages/factory/src/llm/client.ts` (from story 48-5a)
- **Import**: `AnthropicProfile`, `OpenAIProfile`, `GeminiProfile` @ `packages/factory/src/agent/tools/profiles.ts` (from story 48-6)
- **Import**: `createDirectCodergenBackend`, `DirectCodergenBackend` @ `packages/factory/src/backend/direct-backend.ts` (from story 48-10)
- **Import**: `CodergenHandlerOptions` @ `packages/factory/src/handlers/codergen-handler.ts` (from story 48-10)
- **Export**: `bootstrapDirectBackend`, `DirectBootstrapOptions` @ `packages/factory/src/backend/direct-bootstrap.ts` (consumed by factory-command.ts and tests)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
