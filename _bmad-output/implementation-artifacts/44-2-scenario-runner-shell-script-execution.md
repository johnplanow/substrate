# Story 44-2: Scenario Runner — Shell-Script Execution

## Story

As a factory pipeline author,
I want scenarios to execute as isolated child processes and return structured pass/fail results,
so that the pipeline can measure implementation quality and route based on scenario outcomes.

## Acceptance Criteria

### AC1: Passing scenario produces correct ScenarioResult
**Given** a scenario script that exits with code 0 and writes text to stdout
**When** `ScenarioRunner.run()` executes that scenario
**Then** the returned `ScenarioResult` has `status: 'pass'`, `exitCode: 0`, the captured `stdout`, captured `stderr`, and a non-negative `durationMs`

### AC2: Failing scenario produces correct ScenarioResult
**Given** a scenario script that exits with code 1
**When** `ScenarioRunner.run()` executes that scenario
**Then** the returned `ScenarioResult` has `status: 'fail'` and `exitCode: 1`

### AC3: Non-zero exit codes other than 1 also produce failing ScenarioResult
**Given** a scenario script that exits with code 2 (or any non-zero value)
**When** `ScenarioRunner.run()` executes that scenario
**Then** the returned `ScenarioResult` has `status: 'fail'` and `exitCode` matching the actual exit code

### AC4: Structured JSON stdout is parsed and attached to ScenarioResult
**Given** a scenario script that exits with code 0 and writes valid JSON to stdout (e.g., `{"checks": ["auth", "logout"], "details": "all passing"}`)
**When** `ScenarioRunner.run()` executes that scenario
**Then** the `ScenarioResult` includes a `parsedOutput` field containing the parsed JSON object

### AC5: Summary statistics are correct for a mixed-result run
**Given** a manifest with 3 scenarios (2 that pass, 1 that fails)
**When** `ScenarioRunner.run()` executes all three
**Then** `ScenarioRunResult.summary` equals `{ total: 3, passed: 2, failed: 1 }` and `scenarios` contains all 3 `ScenarioResult` entries

### AC6: Each scenario runs with the project working directory as CWD
**Given** a working directory path is passed to `ScenarioRunner.run()`
**When** scenarios are executed as child processes
**Then** each spawned child process has its `cwd` set to the provided working directory

### AC7: Runner is exported from the factory package public API
**Given** the `packages/factory/src/index.ts` barrel export
**When** a consumer imports from `@substrate-ai/factory`
**Then** `createScenarioRunner` and the `ScenarioRunner` type are available

## Tasks / Subtasks

- [ ] Task 1: Define `ScenarioRunner` interface and options type (AC: #1, #6)
  - [ ] Create `packages/factory/src/scenarios/runner.ts`
  - [ ] Define `ScenarioRunnerOptions` (optional timeout per scenario in ms, default 30 000)
  - [ ] Define `ScenarioRunner` interface with `run(manifest: ScenarioManifest, workingDir: string): Promise<ScenarioRunResult>` method

- [ ] Task 2: Implement child process execution for a single scenario (AC: #1, #2, #3, #6)
  - [ ] Write `runOneScenario(scenario: ScenarioFile, workingDir: string, options: ScenarioRunnerOptions): Promise<ScenarioResult>` helper
  - [ ] Spawn the scenario file as a child process using `spawn(scenario.path, [], { cwd: workingDir, shell: true })`
  - [ ] Collect `stdout` and `stderr` via `data` event listeners on the stream objects
  - [ ] Resolve on `close` event with exit code (non-null) or `1` if signal-killed
  - [ ] Measure `durationMs` using `performance.now()` before and after execution
  - [ ] Map `exitCode === 0` → `status: 'pass'`, anything else → `status: 'fail'`

- [ ] Task 3: Implement JSON stdout parsing (AC: #4)
  - [ ] After collecting full stdout string, attempt `JSON.parse(stdout.trim())`
  - [ ] If parse succeeds, attach result as `parsedOutput` on `ScenarioResult`
  - [ ] If parse fails (stdout is plain text), omit `parsedOutput` field (do not set to `null`)

- [ ] Task 4: Implement `run()` aggregation method (AC: #5)
  - [ ] Call `runOneScenario()` for each scenario in `manifest.scenarios` sequentially
  - [ ] Collect all `ScenarioResult` entries into `scenarios` array
  - [ ] Compute `summary: { total, passed, failed }` from results
  - [ ] Measure overall `durationMs` for the full run
  - [ ] Return `ScenarioRunResult` using the existing type from `events.ts`

- [ ] Task 5: Export from barrel and wire up factory function (AC: #7)
  - [ ] Implement `createScenarioRunner(options?: ScenarioRunnerOptions): ScenarioRunner` factory function
  - [ ] Add exports to `packages/factory/src/index.ts`: `createScenarioRunner` and `ScenarioRunner` type

- [ ] Task 6: Write unit tests (AC: #1–#6)
  - [ ] Create `packages/factory/src/scenarios/__tests__/runner.test.ts`
  - [ ] Mock `child_process` module via `vi.mock('child_process', ...)`
  - [ ] Write helper `createMockProcess({ stdout, stderr, exitCode })` that returns a fake `ChildProcess` with event emitters
  - [ ] Test AC1: exit code 0 → `status: 'pass'`, correct stdout/stderr/durationMs
  - [ ] Test AC2: exit code 1 → `status: 'fail'`
  - [ ] Test AC3: exit code 2 → `status: 'fail'` with `exitCode: 2`
  - [ ] Test AC4: valid JSON stdout → `parsedOutput` populated; plain text stdout → no `parsedOutput`
  - [ ] Test AC5: mixed 3-scenario manifest → correct summary counts
  - [ ] Test AC6: verify `spawn` was called with `cwd` matching the provided working directory

## Dev Notes

### Architecture Constraints
- File must be created at exactly `packages/factory/src/scenarios/runner.ts` — no other location
- Import `ScenarioManifest` and `ScenarioFile` from `./types.js` (story 44-1 output)
- Import `ScenarioResult` and `ScenarioRunResult` from `../events.js` — these types are already defined there; do NOT redefine them
- Use Node's `child_process.spawn` (not `exec`, not `execFile`) — consistent with tool handler pattern in `packages/factory/src/handlers/tool.ts`
- Use `performance.now()` for timing (already available in Node 16+)
- All imports must use `.js` extension (ESM project)

### Child Process Pattern
Follow the established pattern in `packages/factory/src/handlers/tool.ts`:
```typescript
import { spawn } from 'child_process'

const child = spawn(scenario.path, [], { cwd: workingDir, shell: true })
let stdout = ''
let stderr = ''
child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
const exitCode = await new Promise<number>((resolve) => {
  child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)))
})
```

### JSON Parsing
Use a safe parse helper to avoid throwing on malformed stdout:
```typescript
function tryParseJson(text: string): unknown | undefined {
  try { return JSON.parse(text.trim()) } catch { return undefined }
}
```
Attach result to `ScenarioResult` only when defined. The `parsedOutput` field should be typed as `unknown` to accommodate any valid JSON structure.

### ScenarioResult Extension
The `ScenarioResult` type in `events.ts` may not yet include `parsedOutput`. If it does not, extend it locally within the runner or update the `events.ts` type to add `parsedOutput?: unknown`. Prefer updating `events.ts` so the type is consistent across consumers.

### Testing Requirements
- Framework: Vitest (`import { describe, it, expect, vi, beforeEach } from 'vitest'`)
- Mock `child_process` at the module level with `vi.mock('child_process', () => ({ spawn: vi.fn() }))`
- Create a reusable `createMockProcess` factory that emits `data` events and fires `close` in a `setImmediate` callback so the promise resolves correctly
- Minimum 10 test cases covering all 6 ACs plus edge cases (e.g., empty stdout, signal kill, multiple scenarios running sequentially)
- Do NOT use real child processes — all execution must be mocked

### Sequencing Note
Scenarios run **sequentially** (not concurrently) in this story. Parallel execution may be added in a future story if needed. Sequential execution keeps the implementation simple and avoids port/resource conflicts between scenario scripts.

## Interface Contracts

- **Import**: `ScenarioManifest`, `ScenarioFile` @ `packages/factory/src/scenarios/types.ts` (from story 44-1)
- **Import**: `ScenarioResult`, `ScenarioRunResult` @ `packages/factory/src/events.ts` (already defined)
- **Export**: `ScenarioRunner` @ `packages/factory/src/scenarios/runner.ts` (consumed by stories 44-4, 44-5, 44-8)
- **Export**: `createScenarioRunner` @ `packages/factory/src/scenarios/runner.ts` (consumed by stories 44-4, 44-5, 44-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
