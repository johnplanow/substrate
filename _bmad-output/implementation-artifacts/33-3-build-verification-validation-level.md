# Story 33-3: Level 1 — Build Verification Validation Level

## Story

As a pipeline orchestrator,
I want build verification to run as a pluggable `ValidationLevel` in the cascade,
so that TypeScript compiler errors produce structured `RemediationContext` that the retry loop can feed back to the agent instead of escalating immediately.

## Acceptance Criteria

### AC1: BuildValidationLevel Implements ValidationLevel Interface
**Given** the `ValidationLevel` interface defined in story 33-1 (`src/modules/validation/types.ts`)
**When** `BuildValidationLevel` is instantiated and registered with the cascade runner
**Then** it implements `run(context): Promise<LevelResult>`, executes `tsc --noEmit` followed by `npm run build`, and returns a structured `LevelResult`

### AC2: TypeScript Diagnostic Parsing
**Given** `tsc --noEmit` exits with a non-zero code and emits diagnostic output
**When** `BuildValidationLevel.run()` processes the compiler output
**Then** each diagnostic is parsed into `{ file: string, line: number, message: string }` with the file path relative to the project root, line number, and full error message extracted

### AC3: Structured RemediationContext for Build Failures
**Given** one or more TypeScript diagnostics are detected after `tsc --noEmit` or `npm run build` fails
**When** `BuildValidationLevel` constructs the `LevelResult`
**Then** it returns `passed: false` with a `RemediationContext` containing `category: 'build'`, `location` set to `file:line` for each diagnostic, and the full compiler output as `evidence`

### AC4: Scope Determination — Surgical vs Partial
**Given** compiler diagnostics span one or more files
**When** `BuildValidationLevel` determines remediation scope
**Then** scope is `'surgical'` when diagnostics are in ≤2 distinct files, and `'partial'` when diagnostics span >2 distinct files

### AC5: Timeout Protection Per Build Step
**Given** `tsc --noEmit` or `npm run build` is executing
**When** the step exceeds 30 000 ms (configurable via `BuildValidatorConfig.timeoutMs`)
**Then** the process is killed, `BuildValidationLevel` returns `passed: false` with `category: 'build'`, `evidence` set to `"Build step timed out after {timeoutMs}ms"`, and `canAutoRemediate: false`

### AC6: Unit Tests Cover All Pass/Fail Paths
**Given** a test suite in `src/modules/validation/levels/__tests__/build.test.ts`
**When** the tests run under vitest
**Then** they cover: (a) clean build passes and returns `passed: true`, (b) single-file type error yields `surgical` scope and structured diagnostics, (c) errors in 3+ files yield `partial` scope, (d) build step timeout yields failure with timeout evidence, (e) `npm run build` failure (non-zero exit after `tsc` passes) is captured

## Tasks / Subtasks

- [ ] Task 1: Define `BuildValidationLevel` class and config type (AC: #1)
  - [ ] Create `src/modules/validation/levels/build.ts`
  - [ ] Define `BuildValidatorConfig` interface: `{ timeoutMs?: number, projectRoot?: string }`
  - [ ] Implement `BuildValidationLevel` class with `run(context: ValidationContext): Promise<LevelResult>` method
  - [ ] Import `ValidationLevel`, `LevelResult`, `ValidationContext` from `../types.js` (33-1 types)

- [ ] Task 2: Implement TypeScript diagnostic parser (AC: #2)
  - [ ] Write `parseTscDiagnostics(output: string): TscDiagnostic[]` function
  - [ ] Regex to match tsc output format: `<file>(<line>,<col>): error TS<code>: <message>`
  - [ ] Normalize file paths to be relative to `projectRoot`
  - [ ] Handle multi-line error output (e.g., supplemental context lines)

- [ ] Task 3: Implement scope determination logic (AC: #4)
  - [ ] `determineBuildScope(diagnostics: TscDiagnostic[]): 'surgical' | 'partial'`
  - [ ] Count distinct file paths; return `'surgical'` if ≤2, `'partial'` if >2

- [ ] Task 4: Implement build execution with timeout (AC: #1, #5)
  - [ ] Use `spawnSync` (or `execSync` with `timeout` option) from `node:child_process` for both `tsc --noEmit` and `npm run build`
  - [ ] Pass `timeout: config.timeoutMs ?? 30_000` and `cwd: context.projectRoot`
  - [ ] Detect timeout via `spawnSync` result `signal === 'SIGTERM'` or `error?.code === 'ETIMEDOUT'`
  - [ ] Run `tsc --noEmit` first; if it fails, skip `npm run build` (short-circuit within level)

- [ ] Task 5: Build RemediationContext from failures (AC: #3, #5)
  - [ ] Assemble `RemediationContext.failures` array from parsed diagnostics
  - [ ] Set `category: 'build'`, `location: 'file:line'`, `evidence: <compiler output>`, `suggestedAction: 'Fix type errors'`
  - [ ] Set `canAutoRemediate: true` for compiler errors (agent can fix); `false` for timeouts
  - [ ] Set `scope` via `determineBuildScope`

- [ ] Task 6: Export from validation module index and write unit tests (AC: #6)
  - [ ] Add `BuildValidationLevel` export to `src/modules/validation/index.ts`
  - [ ] Create `src/modules/validation/levels/__tests__/build.test.ts` with vitest
  - [ ] Mock `spawnSync` / `execSync` to simulate: clean pass, single-file error, multi-file error, timeout, `npm run build` failure
  - [ ] Verify `LevelResult` shape, `scope`, `canAutoRemediate`, and diagnostic count in each case

## Dev Notes

### Architecture Constraints
- **Depends on Story 33-1**: `ValidationLevel`, `LevelResult`, `ValidationContext`, and `RemediationContext` types must come from `src/modules/validation/types.ts`. Do not re-define them here.
- **File paths**:
  - `src/modules/validation/levels/build.ts` — `BuildValidationLevel` implementation
  - `src/modules/validation/levels/__tests__/build.test.ts` — unit tests
  - `src/modules/validation/index.ts` — add `BuildValidationLevel` export (update existing, don't create anew if 33-1 already created it)
- **Import style**: `.js` extension on all local imports (ESM). Example: `import type { ValidationLevel } from '../types.js'`
- **Test framework**: vitest (not jest). No `jest.mock` — use `vi.mock` / `vi.spyOn`.
- **Subprocess**: Use `spawnSync` from `node:child_process` for subprocess execution (gives direct access to `status`, `signal`, `stdout`, `stderr` without needing promisification). This avoids the `execSync` ETIMEDOUT exception-based timeout handling.
- **Do NOT modify** `src/modules/agent-dispatch/dispatcher-impl.ts` — the existing `runBuildVerification` there is a monolith-level gate. This story builds a cascade-pluggable `ValidationLevel` implementation that is architecturally separate.
- **Project root**: `ValidationContext` (from 33-1) should include `projectRoot: string`. Build level reads `cwd` from this field when spawning subprocesses.
- **tsc path**: invoke as `npx tsc --noEmit` to avoid path resolution issues; or rely on `node_modules/.bin/tsc` if `npx` is undesirable. Check how 24-2's `runBuildVerification` resolves this for consistency.

### Testing Requirements
- Use `vi.mock('node:child_process', ...)` to mock `spawnSync`
- Simulate tsc diagnostic output using realistic compiler error strings (e.g., `src/foo.ts(12,5): error TS2345: Argument of type 'string' is not assignable...`)
- Test the timeout case by returning `{ signal: 'SIGTERM', status: null, stdout: Buffer.from(''), stderr: Buffer.from('') }` from the mock
- Coverage target: all 6 AC paths (pass, single-file error, multi-file error, timeout, npm build failure)
- Run targeted: `npm run test:changed` during iteration; verify with `npm run test:fast` before marking complete

## Interface Contracts

- **Import**: `ValidationLevel`, `LevelResult`, `ValidationContext`, `RemediationContext`, `FailureDetail` @ `src/modules/validation/types.ts` (from story 33-1)
- **Export**: `BuildValidationLevel` @ `src/modules/validation/levels/build.ts`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
