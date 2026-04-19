# Story 42-11: Tool and wait.human Handlers

## Story

As a graph executor,
I want `tool` and `wait.human` handlers that extend the handler registry with shell command execution and human-gate capabilities,
so that graphs can run arbitrary shell commands and pause for human input at decision points, with results surfaced to downstream nodes via shared context and edge selection.

## Acceptance Criteria

### AC1: Tool Handler — Successful Command Returns SUCCESS with stdout in Context
**Given** a tool node with `tool_command="echo hello"` (node id `"tool"`)
**When** the handler executes
**Then** it spawns a child process, captures stdout, trims trailing whitespace, and returns `{ status: 'SUCCESS', contextUpdates: { 'tool.output': 'hello' } }` — context key follows the pattern `{node.id}.output`

### AC2: Tool Handler — Failing Command Returns FAIL with stderr as failureReason
**Given** a tool node whose command exits with a non-zero exit code and writes text to stderr
**When** the handler executes
**Then** it returns `{ status: 'FAIL', failureReason: <stderr_content> }` with no `contextUpdates` set

### AC3: Tool Handler — Working Directory Resolved from Context
**Given** the tool handler is executing
**When** it prepares the child process
**Then** the working directory is `context.getString('workingDirectory', process.cwd())` — a value in context overrides the default CWD

### AC4: wait.human Handler — Accelerator Key Parsing from Edge Labels
**Given** a wait.human node with outgoing edges labeled `"[Y] Yes"` and `"[N] No"` in the graph
**When** the handler derives choices from the graph
**Then** it parses accelerator keys yielding `[{ key: 'Y', label: 'Yes' }, { key: 'N', label: 'No' }]`; labels without a `[X]` prefix have `key` equal to the first character of the label

### AC5: wait.human Handler — Returns preferredLabel Matching Human Selection
**Given** a wait.human node and a `promptFn` injected via options that resolves with `"[Y] Yes"`
**When** the handler executes and the human selects that option
**Then** the outcome is `{ status: 'SUCCESS', preferredLabel: '[Y] Yes', contextUpdates: { '{node.id}.choice': '[Y] Yes' } }` so that edge selection (story 42-12, Step 2) can match the correct outgoing edge

### AC6: Handler Registration in createDefaultRegistry()
**Given** the `createDefaultRegistry()` factory function
**When** it constructs the registry
**Then** `registry.resolve(node)` for a node with `type="tool"` returns the tool handler, and for `type="wait.human"` returns the wait.human handler — both registered by explicit type (resolution step 1)

### AC7: All Unit Tests Pass
**Given** the tool and wait.human handlers are implemented
**When** `npm run test:fast` is run
**Then** all unit tests for this story pass with zero failures; the "Test Files" summary line is visible in output confirming vitest completed

## Tasks / Subtasks

- [ ] Task 1: Scaffold tool handler file and option types (AC: #1, #2, #3)
  - [ ] Create `packages/factory/src/handlers/tool.ts`
  - [ ] Define `ToolHandlerOptions` interface: `{ defaultWorkingDir?: string }` (optional override for testing)
  - [ ] Define `createToolHandler(options?: ToolHandlerOptions): NodeHandler` factory function signature
  - [ ] Import `GraphNode`, `Graph`, `IGraphContext`, `Outcome` from `../graph/types.js`
  - [ ] Import `NodeHandler` from `./types.js`
  - [ ] Read `packages/factory/src/graph/types.ts` before coding to confirm exact type names

- [ ] Task 2: Implement tool command execution (AC: #1, #2, #3)
  - [ ] Read `node.toolCommand` (the camelCase form of DOT attribute `tool_command`; verify camelCase name in graph/types.ts from story 42-2)
  - [ ] Resolve working directory: `context.getString('workingDirectory', options?.defaultWorkingDir ?? process.cwd())`
  - [ ] Spawn child process using Node built-in `child_process.execFile` or `spawn` with `{ cwd, shell: true }` — do not use any third-party process library
  - [ ] Capture stdout and stderr buffers; await process close event
  - [ ] On exit code 0: return `{ status: 'SUCCESS', contextUpdates: { [\`\${node.id}.output\`]: stdout.trim() } }`
  - [ ] On exit code != 0: return `{ status: 'FAIL', failureReason: stderr.trim() || \`Command exited with code \${code}\` }`
  - [ ] Export `createToolHandler` as a named export

- [ ] Task 3: Scaffold wait.human handler file and option types (AC: #4, #5)
  - [ ] Create `packages/factory/src/handlers/wait-human.ts`
  - [ ] Define `Choice` interface: `{ key: string; label: string }`
  - [ ] Define `WaitHumanHandlerOptions` interface: `{ promptFn?: (nodeLabel: string, choices: Choice[]) => Promise<string> }` — injected for testability; defaults to a readline-based CLI prompt
  - [ ] Define `createWaitHumanHandler(options?: WaitHumanHandlerOptions): NodeHandler` factory function signature
  - [ ] Import `GraphNode`, `Graph`, `GraphEdge`, `IGraphContext`, `Outcome` from `../graph/types.js`; import `NodeHandler` from `./types.js`

- [ ] Task 4: Implement accelerator key parsing and choice derivation (AC: #4)
  - [ ] Export `parseAcceleratorKey(edgeLabel: string): Choice` as a named export for unit-test access
  - [ ] Regex to detect `[X]` prefix: `/^\[([A-Za-z0-9])\]\s*(.*)$/` — key is capture group 1 (uppercased), label is capture group 2 (trimmed)
  - [ ] Fallback for labels without `[X]` prefix: key = first character of label uppercased, label = full label string
  - [ ] Implement `deriveChoices(node: GraphNode, graph: Graph): Choice[]` — filter `graph.edges` where `edge.from === node.id`, map each edge's `label` through `parseAcceleratorKey`
  - [ ] Export `deriveChoices` for unit-test access

- [ ] Task 5: Implement wait.human user prompt and outcome construction (AC: #5)
  - [ ] Implement default `promptFn` using Node `readline` (built-in): display node label as the question header, list choices as `[Key] Label` lines, read a single line of input, match input (case-insensitive) to a choice key or full label; re-prompt on invalid input
  - [ ] In the handler body: call `deriveChoices(node, graph)` to build the choices list
  - [ ] Call `promptFn(node.label, choices)` and await the resolved full edge label (e.g., `"[Y] Yes"`)
  - [ ] Return `{ status: 'SUCCESS', preferredLabel: selectedLabel, contextUpdates: { [\`\${node.id}.choice\`]: selectedLabel } }`
  - [ ] Export `createWaitHumanHandler` as a named export

- [ ] Task 6: Register handlers in createDefaultRegistry() and update barrel (AC: #6)
  - [ ] Update `createDefaultRegistry()` in `packages/factory/src/handlers/registry.ts`:
    - [ ] Import `createToolHandler` from `./tool.js`
    - [ ] Import `createWaitHumanHandler` from `./wait-human.js`
    - [ ] Call `registry.register('tool', createToolHandler())` for explicit type `"tool"`
    - [ ] Call `registry.register('wait.human', createWaitHumanHandler())` for explicit type `"wait.human"`
  - [ ] Update barrel `packages/factory/src/handlers/index.ts` to re-export:
    - `createToolHandler`, `ToolHandlerOptions` from `./tool.js`
    - `createWaitHumanHandler`, `WaitHumanHandlerOptions`, `Choice` from `./wait-human.js`

- [ ] Task 7: Write unit tests for tool handler (AC: #1, #2, #3, #7)
  - [ ] Create `packages/factory/src/handlers/__tests__/tool-handler.test.ts`
  - [ ] Mock `child_process` using `vi.mock('child_process', ...)` — do not spawn real processes
  - [ ] Test success path: mock process that writes "hello\n" to stdout, exits 0 → verify `status: 'SUCCESS'` and `contextUpdates['tool.output'] === 'hello'`
  - [ ] Test failure path: mock process that writes "bad thing" to stderr, exits 1 → verify `status: 'FAIL'` and `failureReason: 'bad thing'`
  - [ ] Test failure fallback: mock process exits 2 with empty stderr → verify `failureReason` contains the exit code
  - [ ] Test working directory: pass `{ workingDir: '/tmp' }` option; verify the spawned process received `cwd: '/tmp'`
  - [ ] Test working directory from context: set `context.getString('workingDirectory', ...)` to return `/custom/path`; verify `cwd: '/custom/path'`

- [ ] Task 8: Write unit tests for wait.human handler (AC: #4, #5, #7)
  - [ ] Create `packages/factory/src/handlers/__tests__/wait-human-handler.test.ts`
  - [ ] Test `parseAcceleratorKey('[Y] Yes')` → `{ key: 'Y', label: 'Yes' }`
  - [ ] Test `parseAcceleratorKey('[N] No')` → `{ key: 'N', label: 'No' }`
  - [ ] Test `parseAcceleratorKey('Continue')` → `{ key: 'C', label: 'Continue' }` (no prefix fallback)
  - [ ] Test `deriveChoices`: build a minimal `Graph` with two outgoing edges labeled `"[Y] Yes"` and `"[N] No"` → verify both choices are returned
  - [ ] Test handler success path: inject `promptFn` that resolves `"[Y] Yes"`; verify outcome `{ status: 'SUCCESS', preferredLabel: '[Y] Yes', contextUpdates: { 'my_node.choice': '[Y] Yes' } }`
  - [ ] Test `createDefaultRegistry()` resolves `type="wait.human"` to the wait.human handler and `type="tool"` to the tool handler

## Dev Notes

### Architecture Constraints
- **New files:**
  - `packages/factory/src/handlers/tool.ts`
  - `packages/factory/src/handlers/wait-human.ts`
  - `packages/factory/src/handlers/__tests__/tool-handler.test.ts`
  - `packages/factory/src/handlers/__tests__/wait-human-handler.test.ts`
- **Modified files:**
  - `packages/factory/src/handlers/registry.ts` — update `createDefaultRegistry` to register tool and wait.human
  - `packages/factory/src/handlers/index.ts` — add barrel re-exports
- All relative imports use ESM `.js` extensions (e.g., `import { NodeHandler } from './types.js'`)
- Allowed external imports: `@substrate-ai/core`, Node built-ins (`child_process`, `readline`) — no other third-party packages
- No circular dependencies: tool/wait-human handlers import from `graph/types` and `handlers/types` only

### Node Attribute Naming
Story 42-2 defines camelCase TypeScript properties for node attributes. The relevant ones:
- `node.toolCommand` — the shell command string (from `tool_command` DOT attribute)
- `node.label` — the human-readable node label (used as the question header for wait.human)
- `node.id` — the node identifier (used as the context output key prefix)

**Before coding** `node.toolCommand`, read `packages/factory/src/graph/types.ts` to confirm the exact property name produced by story 42-2's attribute extraction. Do not guess or invent property names.

### Context Output Key Pattern
- **Tool handler:** stores stdout as `{node.id}.output` (dot separator), e.g., `tool.output` for a node with id `"tool"`. Downstream nodes reference this via `{{tool.output}}` in prompt templates.
- **wait.human handler:** stores the selected label as `{node.id}.choice`, e.g., `gate.choice` for a node with id `"gate"`.

### Tool Command Execution
Use `child_process.exec` or `child_process.spawn` with `{ cwd, shell: true }`. Wrap in a Promise that resolves/rejects on the `'close'` event. Capture stdout and stderr via `data` events on the respective streams. Do not use `execSync` or any synchronous form — the executor always awaits handlers.

### wait.human Prompt Implementation
The `promptFn` factory option exists solely for testability. The default implementation (used at runtime) should use Node's built-in `readline.createInterface({ input: process.stdin, output: process.stdout })` to display choices and read user input. The handler re-prompts until the input matches a valid choice key (case-insensitive) or a full edge label.

The choices are derived from the `graph.edges` array: filter edges where `edge.from === node.id`, then map each edge's `label` attribute through `parseAcceleratorKey`. If an edge has no label, skip it (do not include it as a choice).

### Handler Registration
The `"wait.human"` type string contains a dot, which is valid as a Map key. The registry's `register(type, handler)` method uses a `Map<string, NodeHandler>` so any string is valid. Verify this by reading `packages/factory/src/handlers/registry.ts` before modifying it.

### Testing Requirements
- Test framework: Vitest (`import { describe, it, expect, vi } from 'vitest'`)
- Run: `npm run test:fast` — never pipe output; confirm "Test Files" summary line
- Never run tests concurrently (`pgrep -f vitest` must return nothing first)
- Use `vi.mock('child_process', ...)` to mock child process — no real subprocesses in tests
- Inject `promptFn` via options to test wait.human — no readline in tests
- Use real `GraphContext` from `../graph/context.js` in tests — do not stub it
- Reset mocks with `vi.clearAllMocks()` in `afterEach`

## Interface Contracts

- **Import**: `GraphNode`, `Graph`, `GraphEdge`, `IGraphContext`, `Outcome` @ `packages/factory/src/graph/types.ts` (from stories 42-1, 42-2, 42-8)
- **Import**: `NodeHandler`, `IHandlerRegistry` @ `packages/factory/src/handlers/types.ts` (from story 42-9)
- **Import**: `HandlerRegistry`, `createDefaultRegistry` @ `packages/factory/src/handlers/registry.ts` (from story 42-9, modified here)
- **Export**: `createToolHandler`, `ToolHandlerOptions` @ `packages/factory/src/handlers/tool.ts` (consumed by executor wiring in story 42-14)
- **Export**: `createWaitHumanHandler`, `WaitHumanHandlerOptions`, `Choice` @ `packages/factory/src/handlers/wait-human.ts` (consumed by executor wiring in story 42-14)
- **Export**: `parseAcceleratorKey`, `deriveChoices` @ `packages/factory/src/handlers/wait-human.ts` (consumed by edge selection label normalization in story 42-12)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
