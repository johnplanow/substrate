# Story 51-4: Build Verification Check

## Story

As a substrate operator,
I want the target project's build to be verified after each story completes,
so that stories that break the build are caught immediately before the next story dispatch.

## Acceptance Criteria

### AC1: Passing Build Returns Pass Status
**Given** a completed story dispatch with `workingDir` pointing to a project whose detected build command exits with code 0
**When** `BuildCheck.run(context)` is called
**Then** the check returns `{ status: 'pass', details: 'build passed', duration_ms: <number> }`

### AC2: Failing Build Returns Fail Status With Truncated Output
**Given** a completed story dispatch where the build command exits with a non-zero code
**When** `BuildCheck.run(context)` is called
**Then** the check returns `{ status: 'fail', details: 'build failed (exit <code>): <combined stdout+stderr, truncated to 2000 chars>', duration_ms: <number> }`

### AC3: Build Timeout Returns Fail With Process Group Kill
**Given** a build command that does not complete within 60 seconds
**When** the timeout fires
**Then** `process.kill(-child.pid!, 'SIGKILL')` is called to kill the entire process group, and the check returns `{ status: 'fail', details: 'build-timeout: command exceeded 60000ms', duration_ms: >= 60000 }`

### AC4: No Recognized Build System Skips Check With Warn
**Given** a `workingDir` with no recognized build system (no `package.json`, `turbo.json`, `pyproject.toml`, `Cargo.toml`, or `go.mod`) and no explicit `buildCommand` override
**When** `BuildCheck.run(context)` is called
**Then** the check returns `{ status: 'warn', details: 'build-skip: no build command detected for project at <workingDir>', duration_ms: <number> }` and does not block subsequent checks

### AC5: Explicit buildCommand Override Is Respected
**Given** a `VerificationContext` with `buildCommand: 'make release'` set explicitly
**When** `BuildCheck.run(context)` is called
**Then** the check runs the override command instead of auto-detecting from `workingDir`; if `buildCommand` is an empty string, it behaves the same as no build system detected (returns `warn`)

### AC6: BuildCheck Correctly Implements VerificationCheck Interface
**Given** the `VerificationCheck` interface from story 51-1 (`{ name: string, tier: 'A' | 'B', run(context): Promise<VerificationResult> }`)
**When** `BuildCheck` is constructed and inspected
**Then** `check.name === 'build'`, `check.tier === 'A'`, and `check.run` is a function returning `Promise<VerificationResult>`

### AC7: Unit Tests Cover All Branches With ≥8 Test Cases
**Given** the unit test file for `BuildCheck`
**When** `npm run test:fast` executes
**Then** at least 8 `it(...)` cases pass covering: passing build, failing build with output, timeout + process group kill, no build system (warn), explicit buildCommand override (used), empty buildCommand override (warn), check name/tier assertions, and duration_ms type — confirmed by "Test Files" summary line showing the file green with zero failures

## Tasks / Subtasks

- [ ] Task 1: Extend `VerificationContext` with optional `buildCommand` field (AC: #5)
  - [ ] Before editing, read the existing types file: `grep -n "VerificationContext\|buildCommand" packages/sdlc/src/verification/types.ts`
  - [ ] Add `buildCommand?: string` to the `VerificationContext` interface in `packages/sdlc/src/verification/types.ts`
    - Semantic: if provided, this exact command is used instead of auto-detection; empty string means "skip" (same as no build system found)
  - [ ] Run `npm run build` to confirm the TypeScript change compiles cleanly; fix any errors before proceeding

- [ ] Task 2: Implement `BuildCheck` class (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Create `packages/sdlc/src/verification/checks/build-check.ts`
  - [ ] Import types with `.js` extensions (ESM): `import type { VerificationCheck, VerificationContext, VerificationResult } from '../types.js'`
  - [ ] Import Node builtins: `import { spawn } from 'node:child_process'`, `import { existsSync } from 'node:fs'`, `import { join } from 'node:path'`
  - [ ] Define `BUILD_CHECK_TIMEOUT_MS = 60_000` as a named export constant
  - [ ] Implement `detectBuildCommand(workingDir: string): string` as a module-level helper (returns resolved command or `''` when no build system is found):
    - Priority 1: `turbo.json` in `workingDir` → `'turbo build'`
    - Priority 2: `pnpm-lock.yaml` → `'pnpm run build'`
    - Priority 3: `yarn.lock` → `'yarn build'`
    - Priority 4: `bun.lockb` → `'bun run build'`
    - Priority 5: `package.json` → `'npm run build'`
    - Non-Node markers (`pyproject.toml`, `poetry.lock`, `setup.py`, `Cargo.toml`, `go.mod`) → `''` (skip, no universal build step)
    - Nothing found → `''`
  - [ ] Implement `BuildCheck` class:
    ```typescript
    export class BuildCheck implements VerificationCheck {
      readonly name = 'build';
      readonly tier = 'A' as const;
      async run(context: VerificationContext): Promise<VerificationResult> { ... }
    }
    ```
  - [ ] In `run()`:
    1. Record `start = Date.now()`
    2. Resolve command: use `context.buildCommand` if defined; otherwise call `detectBuildCommand(context.workingDir)`
    3. If command is `''`, return `{ status: 'warn', details: 'build-skip: no build command detected for project at <workingDir>', duration_ms: Date.now() - start }`
    4. Spawn with `spawn(cmd, args, { cwd: context.workingDir, detached: true, shell: true })` (split command string on first space for `cmd`/`args`, or use `shell: true` to pass full command as string)
    5. Collect stdout and stderr into a single `output` string buffer
    6. Set `timeoutHandle = setTimeout(() => { process.kill(-child.pid!, 'SIGKILL'); resolve({ status: 'fail', details: 'build-timeout: command exceeded 60000ms', duration_ms: Date.now() - start }) }, BUILD_CHECK_TIMEOUT_MS)`
    7. On `child.on('close', (code) => { clearTimeout(timeoutHandle); ... })`: if `code === 0`, return pass; otherwise return fail with `'build failed (exit <code>): <output truncated to 2000 chars>'`
    8. Wrap entire spawn in a `new Promise<VerificationResult>` and return it
  - [ ] Export `BuildCheck` and `BUILD_CHECK_TIMEOUT_MS` from `packages/sdlc/src/verification/checks/index.ts` (create barrel if missing, following pattern from story 51-3)
  - [ ] Export `BuildCheck` from `packages/sdlc/src/verification/index.ts` (re-export from checks barrel)

- [ ] Task 3: Register `BuildCheck` in `VerificationPipeline` (AC: #6)
  - [ ] Read how the pipeline registers checks: `grep -n "register\|addCheck\|checks\|PhantomReview\|TrivialOutput" packages/sdlc/src/verification/verification-pipeline.ts`
  - [ ] Add `BuildCheck` as the third Tier A check in the pipeline's default ordered list — after `PhantomReviewCheck` and `TrivialOutputCheck`, following the architecture sequence: 1→PhantomReview, 2→TrivialOutput, 3→Build
  - [ ] Confirm ordering is correct by inspecting the registered list or adding a brief comment

- [ ] Task 4: Write unit tests for `BuildCheck` (AC: #7)
  - [ ] Create `packages/sdlc/src/__tests__/verification/build-check.test.ts`
  - [ ] Discover correct import paths before writing: `grep -n "^export" packages/sdlc/src/verification/checks/build-check.ts`
  - [ ] Import: `import { BuildCheck, BUILD_CHECK_TIMEOUT_MS } from '../../verification/checks/build-check.js'`
  - [ ] Import: `import type { VerificationContext } from '../../verification/types.js'`
  - [ ] **CRITICAL — mock `child_process` spawn to avoid running real shell commands in tests:**
    ```typescript
    vi.mock('node:child_process', () => ({
      spawn: vi.fn(),
    }))
    import { spawn } from 'node:child_process'
    const mockSpawn = vi.mocked(spawn)
    ```
  - [ ] **Also mock `node:fs` `existsSync` to control `detectBuildCommand` results in tests:**
    ```typescript
    vi.mock('node:fs', () => ({ existsSync: vi.fn() }))
    import { existsSync } from 'node:fs'
    const mockExistsSync = vi.mocked(existsSync)
    ```
  - [ ] Build a helper: `makeContext(overrides: Partial<VerificationContext>): VerificationContext` — fills required fields with valid defaults: `{ storyKey: '51-4', workingDir: '/tmp/test-project', commitSha: 'abc123', timeout: 30000, priorStoryFiles: new Map() }`
  - [ ] Build a helper: `makeMockChild(exitCode: number | null, stdout = '', stderr = '')` — returns a mock `ChildProcess` with `on()`, `stdout.on()`, `stderr.on()`, and `pid: 12345`
  - [ ] Test cases:
    1. (passing build) spawn exits with code 0 → `status: 'pass'`, `details: 'build passed'`
    2. (failing build) spawn exits with code 1 and stderr output → `status: 'fail'`, details includes "build failed" and the output
    3. (timeout) spawn never closes within timeout → `status: 'fail'`, details includes "build-timeout", `process.kill` called with `-12345`
    4. (no build system) `existsSync` returns false for all markers, no `buildCommand` override → `status: 'warn'`, details includes "build-skip"
    5. (explicit buildCommand override) `context.buildCommand: 'make release'` → spawn called with that command regardless of filesystem state
    6. (empty buildCommand override) `context.buildCommand: ''` → `status: 'warn'` (skip without detection)
    7. (check name) `new BuildCheck().name === 'build'`
    8. (check tier) `new BuildCheck().tier === 'A'`
    9. (duration_ms) result has `typeof duration_ms === 'number'` and `duration_ms >= 0`
  - [ ] Minimum 9 `it(...)` cases; verify: `grep -c "it(" packages/sdlc/src/__tests__/verification/build-check.test.ts`

- [ ] Task 5: Build and run tests to confirm all changes pass (AC: #7)
  - [ ] Run `npm run build`; confirm zero TypeScript errors in new and modified files
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line shows the new test file green with zero failures
  - [ ] NEVER pipe test output through `tail`, `head`, `grep`, or any filtering command

## Dev Notes

### Architecture Constraints
- All relative imports within `packages/sdlc/` MUST use `.js` extensions (ESM): e.g., `import { ... } from '../types.js'`
- `BuildCheck` lives at `packages/sdlc/src/verification/checks/build-check.ts` — matches the file organization in the Phase D architecture doc (section 3.5)
- `VerificationCheck` interface and `VerificationContext`/`VerificationResult` types live in `packages/sdlc/src/verification/types.ts` — do NOT put them in `packages/core/`
- This check is Tier A: **no run model dependency** (Epic 52 not needed). Everything comes from `VerificationContext`
- **No LLM calls** — pure shell invocation (architecture constraint FR-V9)
- **Hard 60-second timeout** (FR-V11). Timeout or crash returns `verification-failed` (reflected as `status: 'fail'` here), does not block subsequent stories
- Use `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals, no `jest.fn()`

### Process Group Kill Pattern
Spawn the build command with `detached: true` so the child process becomes a process group leader. On timeout, kill the entire group:
```typescript
const child = spawn(cmd, [], {
  cwd: context.workingDir,
  detached: true,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe'],
})
// On timeout:
process.kill(-child.pid!, 'SIGKILL')  // negative PID = entire process group
```
This mirrors the supervisor's orphan-cleanup approach (`getAllDescendantPids` pattern). The `-pid` form sends SIGKILL to the process group, ensuring no compiler sub-processes outlive the parent.

### Build Command Detection Priority
`detectBuildCommand(workingDir)` checks files in `workingDir` in order:
1. `turbo.json` → `'turbo build'`
2. `pnpm-lock.yaml` → `'pnpm run build'`
3. `yarn.lock` → `'yarn build'`
4. `bun.lockb` → `'bun run build'`
5. `package.json` (no turbo/lockfile match) → `'npm run build'`
6. Non-Node markers (`pyproject.toml`, `setup.py`, `Cargo.toml`, `go.mod`) → `''` (no build step)
7. Nothing found → `''`

This mirrors the logic in `src/modules/agent-dispatch/dispatcher-impl.ts:detectPackageManager()`. Do NOT import from that file directly — `packages/sdlc/` cannot import from the monolith `src/` without creating a circular dependency. Inline the detection logic in `build-check.ts`.

### VerificationPipeline Registration Order
Per architecture document section 3.5 and Decision 2, the canonical Tier A check order is:
1. `PhantomReviewCheck` (story 51-2)
2. `TrivialOutputCheck` (story 51-3)
3. `BuildCheck` (this story — 51-4)

This ordering is intentional: phantom review detection runs first (a story never reviewed shouldn't incur build cost), then trivial output (fast, no shell invocation), then build (expensive, 60s worst-case).

### Output Truncation
Build output can be very long (hundreds of KB for large monorepos). Truncate `stdout + stderr` to a maximum of 2000 characters in the `details` string to keep the `VerificationResult` payload bounded for storage in the run manifest (Epic 52). If truncated, append `'... (truncated)'` to the details string.

### Error Handling for process.kill on Timeout
`process.kill(-pid, 'SIGKILL')` can throw if the process already exited between the timeout firing and the kill call. Wrap it in try/catch to avoid crashing the check:
```typescript
try { process.kill(-child.pid!, 'SIGKILL') } catch { /* already exited */ }
```

### Testing Requirements
- Framework: `vitest` (`describe`, `it`, `expect`, `vi`) — no Jest globals
- Mock `node:child_process` `spawn` and `node:fs` `existsSync` — no real shell commands in unit tests
- Build `makeMockChild` helper to return an EventEmitter-like mock that lets tests control stdout/stderr data and `close` events
- Use `vi.useFakeTimers()` to control timeout behavior in the timeout test case — call `vi.advanceTimersByTime(BUILD_CHECK_TIMEOUT_MS + 1)` to trigger timeout without waiting 60 real seconds
- Minimum 9 `it(...)` test cases
- Run `npm run build` first; then `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line; NEVER pipe output through any filter

### New File Paths
```
packages/sdlc/src/verification/checks/build-check.ts           — BuildCheck implementation + detectBuildCommand helper
packages/sdlc/src/__tests__/verification/build-check.test.ts   — unit tests (≥9 cases)
```

### Modified File Paths
```
packages/sdlc/src/verification/types.ts                        — add buildCommand?: string to VerificationContext
packages/sdlc/src/verification/checks/index.ts                 — export BuildCheck, BUILD_CHECK_TIMEOUT_MS (create if missing)
packages/sdlc/src/verification/index.ts                        — re-export BuildCheck (create if missing)
packages/sdlc/src/verification/verification-pipeline.ts        — register BuildCheck as 3rd Tier A check
```

## Interface Contracts

- **Import**: `VerificationCheck`, `VerificationContext`, `VerificationResult` @ `packages/sdlc/src/verification/types.ts` (from story 51-1)
- **Import**: `VerificationPipeline` @ `packages/sdlc/src/verification/verification-pipeline.ts` (from story 51-1 — registration target)
- **Export**: `BuildCheck` @ `packages/sdlc/src/verification/checks/build-check.ts` (consumed by story 51-5 for pipeline integration)
- **Export**: `BUILD_CHECK_TIMEOUT_MS` @ `packages/sdlc/src/verification/checks/build-check.ts` (consumed by story 51-5 for context assembly and story 54-4 for diff validation ordering logic)
- **Export**: `detectBuildCommand` @ `packages/sdlc/src/verification/checks/build-check.ts` (consumed by story 51-5 when populating `VerificationContext.buildCommand` at the orchestrator dispatch site)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-05 | Initial story created for Epic 51 Phase D |
