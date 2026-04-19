# Story 48-6: Provider-Aligned Tool Sets

## Story

As a coding agent loop,
I want provider-specific tool definitions that match each LLM's native format,
so that agents use the tool interfaces they were trained on and perform at peak capability.

## Acceptance Criteria

### AC1: Core Tool Types Defined
**Given** the agent tools package needs a shared type system
**When** the `types` module is imported from `packages/factory/src/agent/tools/types.ts`
**Then** the following are exported with full TypeScript definitions: `ToolDefinition<TArgs>` (with `name`, `description`, `inputSchema: Record<string, unknown>`, `outputTruncation?: number`, `executor`), `ToolResult` (with `content: string` and `isError: boolean`), `ToolValidationError`, `ExecutionEnvironment` (with `workdir: string` and injectable `shell` method), and `ShellResult` (with `stdout`, `stderr`, `exitCode`)

### AC2: ProviderProfile Interface Defined
**Given** different LLM providers require different system prompts and tool sets
**When** the `profiles` module is imported
**Then** `ProviderProfile` interface is exported with fields `id: string`, `model: string`, capability flags (`supports_streaming: boolean`, `context_window_size: number`, `supports_parallel_tool_calls: boolean`), and methods `build_system_prompt(): string`, `tools(): ToolDefinition<unknown>[]` (returns definitions for LLM API registration), and `provider_options(): Record<string, unknown>` (returns provider-specific request parameters)

### AC3: Shared Tools Implemented
**Given** all providers need common filesystem and shell operations
**When** shared tools are created via `createSharedTools(shellTimeoutMs?: number)`
**Then** five tools are returned: `read_file` (reads file with line numbers, `offset`/`limit` params, 50,000 char output cap), `write_file` (full content write, creates parent dirs), `shell` (command + optional `timeout_ms`, process group cleanup, 10,000 char output cap), `grep` (regex `pattern` + `paths` array, returns matching lines with filenames, 10,000 char cap), `glob` (file `pattern` string, returns matching paths, 5,000 char cap) — each with a complete JSON Schema for `inputSchema` and a human-readable `description`

### AC4: Anthropic Provider Profile
**Given** Claude models are trained on Claude Code's native `edit_file` format
**When** `AnthropicProfile` is instantiated with a model string (e.g. `"claude-opus-4-5"`)
**Then** `tools()` includes `edit_file` with `{ path: string, old_string: string, new_string: string }` schema (exact string search-and-replace — throws if `old_string` not found), all five shared tools, uses 120,000ms shell timeout, and `provider_options()` returns `{ max_tokens: 4096 }`; `build_system_prompt()` returns a coding-agent system prompt referencing the available tools

### AC5: OpenAI Provider Profile
**Given** OpenAI models are trained on codex-rs `apply_patch` conventions
**When** `OpenAIProfile` is instantiated with a model string (e.g. `"gpt-4o"`)
**Then** `tools()` includes `apply_patch` with `{ patch: string }` schema (accepts v4a-format patch string — `*** Begin Patch` / `*** Update File:` / `@@` hunk markers / `-`/`+` diff lines / `*** End Patch`), `read_file`, `shell`, `grep`, `glob` — does NOT include `edit_file`; uses 10,000ms shell timeout; `provider_options()` returns `{}`

### AC6: Gemini Provider Profile
**Given** Gemini models are trained on gemini-cli tool conventions
**When** `GeminiProfile` is instantiated with a model string (e.g. `"gemini-2.0-flash"`)
**Then** `tools()` includes `read_many_files` (with `{ paths: string[] }` schema, reads each file, returns concatenated line-numbered content), `list_dir` (with `{ path: string }` schema, returns directory listing with entry types), `edit_file` (with `{ file_path: string, old_string: string, new_string: string }` schema), `write_file`, `shell`, `grep`, `glob`; uses 10,000ms shell timeout

### AC7: ToolRegistry Execution and Validation
**Given** the agentic loop needs to look up and safely execute tools by name
**When** `ToolRegistry.execute(name, args, env)` is called
**Then** it validates `args` against the tool's `inputSchema` (throwing `ToolValidationError` with a descriptive message for invalid args), calls the tool's executor with `(args, env)`, enforces the per-tool `outputTruncation` character limit (truncating silently if exceeded), and returns a `ToolResult`; on executor error it returns `{ content: errorMessage, isError: true }` rather than throwing; `ToolRegistry.getDefinitions()` returns all registered `ToolDefinition[]`; `ToolRegistry.get(name)` returns a single tool or `undefined`

## Tasks / Subtasks

- [ ] Task 1: Define core tool types (AC: #1)
  - [ ] Create `packages/factory/src/agent/tools/types.ts` with `ToolDefinition<TArgs>`, `ToolResult`, `ToolValidationError` (extends `Error`), `ExecutionEnvironment`, `ShellResult`, and the `ToolRegistry` interface (`register`, `execute`, `get`, `getDefinitions` signatures)
  - [ ] `ExecutionEnvironment` must be an interface (not a class) to enable test mocking: `{ workdir: string; exec(command: string, timeoutMs: number): Promise<ShellResult> }`
  - [ ] `outputTruncation` is the max character count; `undefined` means no limit

- [ ] Task 2: Implement ToolRegistry class (AC: #7)
  - [ ] Create `packages/factory/src/agent/tools/registry.ts` implementing the `ToolRegistry` interface
  - [ ] `register(tool)` stores tool by `tool.name` (overwrite if duplicate)
  - [ ] `execute(name, args, env)`: (1) look up tool — return `{ content: 'Unknown tool: name', isError: true }` if missing, (2) validate `args` against `tool.inputSchema` using a lightweight JSON Schema validator (use `ajv` if available as a transitive dep, otherwise implement required-field + type checking manually), (3) call executor, (4) truncate output at `outputTruncation` chars if set, (5) catch executor errors and return as `ToolResult` with `isError: true`
  - [ ] `getDefinitions()` returns `Array.from(this._tools.values())`
  - [ ] `get(name)` returns `this._tools.get(name)`

- [ ] Task 3: Implement shared tools (AC: #3)
  - [ ] Create `packages/factory/src/agent/tools/shared.ts` exporting `createSharedTools(shellTimeoutMs = 10_000): ToolDefinition<unknown>[]`
  - [ ] `read_file`: params `{ path: string, offset?: number, limit?: number }` — reads with `fs/promises.readFile`, splits on `\n`, slices by offset/limit, prepends 1-based line numbers (format: `"  1\t<content>"`), joins, 50,000 char truncation
  - [ ] `write_file`: params `{ path: string, content: string }` — `mkdir({ recursive: true })` on dirname, then `writeFile`; returns `"Wrote <n> bytes to <path>"`
  - [ ] `shell`: params `{ command: string, timeout_ms?: number }` — use `promisify(exec)` with `timeout: timeout_ms ?? shellTimeoutMs`, `killSignal: 'SIGKILL'`; combine stdout + stderr into single string; 10,000 char truncation
  - [ ] `grep`: params `{ pattern: string, paths: string[] }` — spawn `rg --no-heading -n <pattern> <paths...>` via shell; fall back to Node regex line scan if rg not found; 10,000 char truncation
  - [ ] `glob`: params `{ pattern: string }` — use `node:fs/promises` glob or manual recursive readdir with micromatch; return newline-joined paths; 5,000 char truncation

- [ ] Task 4: Implement Anthropic `edit_file` tool (AC: #4)
  - [ ] Create `packages/factory/src/agent/tools/anthropic-tools.ts` exporting `createEditFileTool(): ToolDefinition<{ path: string; old_string: string; new_string: string }>`
  - [ ] Executor: read file content, verify `old_string` appears exactly once (throw `Error('old_string not found in file')` if zero occurrences, throw `Error('old_string is ambiguous (found N times)')` if >1), replace first occurrence with `new_string`, write back, return `"Edited <path>"`
  - [ ] `inputSchema` must match Anthropic tool `input_schema` conventions (type: "object", properties, required array)

- [ ] Task 5: Implement OpenAI `apply_patch` tool (AC: #5)
  - [ ] Create `packages/factory/src/agent/tools/openai-tools.ts` exporting `createApplyPatchTool(): ToolDefinition<{ patch: string }>`
  - [ ] Export `applyV4aPatch(patch: string, workdir: string): Promise<string>` as a pure helper (testable independently)
  - [ ] v4a parser: split on `\n`, scan for `*** Begin Patch` / `*** End Patch` delimiters, parse `*** Update File: <path>` headers, parse `@@` hunk markers, apply `-`/`+` lines as context-guided text substitution, write modified files back, return summary of changed files
  - [ ] For `*** Add File: <path>` blocks, create the file with the `+` lines as content
  - [ ] `inputSchema`: `{ type: "object", properties: { patch: { type: "string", description: "v4a format patch..." } }, required: ["patch"] }`

- [ ] Task 6: Implement Gemini-specific tools (AC: #6)
  - [ ] Create `packages/factory/src/agent/tools/gemini-tools.ts` exporting `createReadManyFilesTool()` and `createListDirTool()`
  - [ ] `read_many_files`: params `{ paths: string[] }` — read each path, prepend `=== <path> ===` header, concatenate with double newline, 100,000 char total truncation
  - [ ] `list_dir`: params `{ path: string }` — use `fs/promises.readdir` with `{ withFileTypes: true }`, return lines in format `"[DIR] name"` or `"[FILE] name"`, sorted dirs-first then alpha

- [ ] Task 7: Implement ProviderProfile and three profile classes (AC: #2, #4, #5, #6)
  - [ ] Create `packages/factory/src/agent/tools/profiles.ts` exporting `ProviderProfile` interface and `AnthropicProfile`, `OpenAIProfile`, `GeminiProfile` classes
  - [ ] Each class constructor accepts `model: string`; stores in `this.model`
  - [ ] `AnthropicProfile`: `id = 'anthropic'`, `context_window_size = 200_000`, 120s shell timeout; `build_system_prompt()` returns a short multi-tool coding-agent prompt; `provider_options()` returns `{ max_tokens: 4096 }`; `tools()` = `[...createSharedTools(120_000), createEditFileTool()]`
  - [ ] `OpenAIProfile`: `id = 'openai'`, `context_window_size = 128_000`, 10s shell timeout; `provider_options()` returns `{}`; `tools()` = `[...createSharedTools(10_000), createApplyPatchTool()]` (no `edit_file`)
  - [ ] `GeminiProfile`: `id = 'gemini'`, `context_window_size = 1_000_000`, 10s shell timeout; `tools()` = `[...createSharedTools(10_000), createReadManyFilesTool(), createListDirTool()]` (also uses `edit_file` from gemini-tools — implement as a thin alias of Anthropic's with `file_path` param name instead of `path`)

- [ ] Task 8: Barrel index, tests, and factory package export (AC: all)
  - [ ] Create `packages/factory/src/agent/tools/index.ts` re-exporting everything from `types.js`, `registry.js`, `shared.js`, `anthropic-tools.js`, `openai-tools.js`, `gemini-tools.js`, `profiles.js`
  - [ ] Extend `packages/factory/src/index.ts` to add `export * from './agent/tools/index.js'`
  - [ ] Create `packages/factory/src/agent/tools/__tests__/shared.test.ts` (≥7 cases: read_file with line numbers, read_file offset/limit, write_file creates parent dirs, shell captures output, shell timeout enforced, grep returns matches, glob returns files matching pattern)
  - [ ] Create `packages/factory/src/agent/tools/__tests__/registry.test.ts` (≥5 cases: execute success with truncation, unknown tool returns isError, schema validation error throws ToolValidationError, executor error returns isError result, getDefinitions returns all registered)
  - [ ] Create `packages/factory/src/agent/tools/__tests__/profiles.test.ts` (≥7 cases: Anthropic tools() has edit_file, OpenAI tools() has apply_patch and NOT edit_file, Gemini tools() has read_many_files, all profiles include shared tools, Anthropic shell timeout is 120s, provider_options() shape per profile, ProviderProfile interface conformance check)
  - [ ] Create `packages/factory/src/agent/tools/__tests__/patch.test.ts` (≥5 cases for `applyV4aPatch`: update existing file, add new file, multiple hunks, file-not-found error, malformed patch error)

## Dev Notes

### Architecture Constraints
- **ESM imports**: all cross-file imports must use `.js` extensions (e.g., `import { ToolResult } from './types.js'`)
- **Named exports only** — no default exports in any file
- **No heavy new dependencies** — use `ajv` if it is already in `node_modules`; if not available, implement a minimal required-field + primitive-type validator rather than adding a new dep. Check with `ls node_modules/ajv` first.
- **`ExecutionEnvironment` is an interface for DI** — shared tool executors receive `env: ExecutionEnvironment` so tests can mock the `exec` method without spawning real processes
- **Shell via `util.promisify(exec)`** — use Node's built-in `child_process.exec`; set `timeout` option and `killSignal: 'SIGKILL'` for timeout enforcement; wrap in try/catch and surface exit code in `ShellResult`
- **File paths**: all new files go under `packages/factory/src/agent/tools/`; the `agent/` subdirectory may need to be created
- **JSON Schema format**: `inputSchema` must be a plain object compatible with both Anthropic (`input_schema`) and OpenAI (`parameters`) tool formats — use `{ type: "object", properties: {...}, required: [...] }` structure
- **Output truncation**: apply AFTER executor returns; silently slice at `outputTruncation` chars (no warning needed in this story)
- **v4a patch format** is used by OpenAI codex; see [codex-rs apply_patch](https://github.com/openai/codex) for reference; the parser only needs to handle `*** Update File` and `*** Add File` block types for this story

### Testing Requirements
- Use vitest (`describe`, `it`, `expect`, `vi`, `beforeEach`, `afterEach`)
- Use `os.tmpdir()` + unique subdirectory (`crypto.randomUUID()`) for all filesystem tests
- Clean up temp directories in `afterEach` using `fs.rm(dir, { recursive: true, force: true })`
- Mock `ExecutionEnvironment.exec` with `vi.fn()` for unit tests — do NOT spawn real processes in unit tests (only integration/e2e tests may do so)
- Test `edit_file` error path: create a file where `old_string` is absent — verify `ToolValidationError` or executor error propagates correctly
- Test `apply_patch` with a minimal 3-line fixture: one removed line, one added line
- Run with `npm run test:fast` (timeout 300000ms) — never pipe output

### Key Imports Pattern
```typescript
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
```

## Interface Contracts

- **Export**: `ProviderProfile` @ `packages/factory/src/agent/tools/profiles.ts` (consumed by story 48-7: Coding Agent Loop Core Agentic Loop)
- **Export**: `ToolRegistry` (class + interface) @ `packages/factory/src/agent/tools/registry.ts` (consumed by story 48-7)
- **Export**: `ExecutionEnvironment` @ `packages/factory/src/agent/tools/types.ts` (consumed by story 48-7)
- **Export**: `AnthropicProfile`, `OpenAIProfile`, `GeminiProfile` @ `packages/factory/src/agent/tools/profiles.ts` (consumed by story 48-10: DirectCodergenBackend Implementation)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-24: Story created for Epic 48 Phase C (Direct API Backend)
