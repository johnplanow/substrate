# Story 52-2: Supervisor Locking and Ownership

## Story

As a substrate operator,
I want only one supervisor to be able to attach to a run at a time,
so that cross-session supervisor interference is prevented.

## Acceptance Criteria

### AC1: Flock-Based Lock Acquisition
**Given** a run with a manifest at `.substrate/runs/{run-id}.json`
**When** a supervisor calls `acquire(pid, sessionId)` and an advisory flock is successfully acquired on `.substrate/runs/{run-id}.lock`
**Then** `supervisor_pid` and `supervisor_session_id` are written to the run manifest atomically, and the lock is held until `release()` is called

### AC2: PID-File Fallback on Unsupported Filesystem
**Given** the current filesystem does not support `flock` (throws `ENOSYS` or `EOPNOTSUPP`)
**When** `acquire(pid, sessionId)` is called
**Then** the system automatically falls back to a PID-file at `.substrate/runs/{run-id}.pid`, logs a `warn`-level message indicating flock unavailability, and proceeds with PID-file-based ownership enforcement

### AC3: Concurrent Supervisor Rejected
**Given** a supervisor already holds ownership of the run (lock file held or live PID-file exists)
**When** a second supervisor calls `acquire(pid, sessionId)` without the `--force` flag
**Then** acquisition fails with an `Error` whose message matches exactly: `"Run {run-id} is already supervised by PID {existing-pid}. Use --force to take over."`

### AC4: Force Takeover
**Given** a supervisor holds ownership of a run
**When** a second supervisor calls `acquire(pid, sessionId)` with `force: true`
**Then** the existing supervisor PID is terminated with `SIGTERM`, the manifest's `supervisor_pid` and `supervisor_session_id` are updated to the new supervisor after a brief settle period (≤500ms), and the lock is acquired

### AC5: Stale PID Detection
**Given** a PID-file exists from a previously crashed supervisor
**When** `acquire(pid, sessionId)` is called and `kill(existingPid, 0)` throws `ESRCH` (process not found)
**Then** the stale PID-file is overwritten without requiring `--force`, the new supervisor acquires ownership, and no error is thrown

### AC6: Clean Release Clears Ownership
**Given** a supervisor currently holds ownership
**When** `release()` is called on clean exit
**Then** the `.lock` file (or `.pid` file in fallback mode) is removed, and `supervisor_pid` and `supervisor_session_id` are set to `null` in the run manifest via an atomic write

### AC7: Unit Tests Pass
**Given** the `SupervisorLock` implementation
**When** `npm run test:fast` is executed
**Then** all new unit tests for lock acquisition, PID-file fallback, rejection, force takeover, stale PID cleanup, and release pass with no failures; existing 8,088+ tests continue to pass

## Tasks / Subtasks

- [ ] Task 1: Implement `SupervisorLock` class — primary flock path (AC: #1, #3, #6)
  - [ ] Create `packages/sdlc/src/run-manifest/supervisor-lock.ts`
  - [ ] Define exported types: `SupervisorLockOptions { force?: boolean }`, internal `LockMode = 'flock' | 'pid-file'`
  - [ ] Constructor accepts `runId: string` and `manifest: RunManifest` (from 52-1)
  - [ ] Implement `acquire(pid: number, sessionId: string, opts?: SupervisorLockOptions): Promise<void>`:
    - Ensure `.substrate/runs/` directory exists via `fs.mkdir({ recursive: true })`
    - Attempt exclusive advisory flock on `.substrate/runs/{run-id}.lock` using non-blocking open (check `package.json` for `proper-lockfile`; if absent, use `node:fs` open with `O_CREAT | O_WRONLY` and invoke the flock syscall via a minimal native wrapper or `child_process` shim — document chosen approach)
    - On flock success: call `manifest.update({ supervisor_pid: pid, supervisor_session_id: sessionId })` and set `this.mode = 'flock'`
    - On `EWOULDBLOCK` / lock contention: read `supervisor_pid` from manifest, throw with prescribed message (AC3)
    - On `ENOSYS` / `EOPNOTSUPP`: log warn and delegate to `this.acquireViaPidFile(pid, sessionId, opts)`
  - [ ] Implement `release(): Promise<void>`:
    - If `mode === 'flock'`: release flock fd and unlink `.substrate/runs/{run-id}.lock`
    - Call `manifest.update({ supervisor_pid: null, supervisor_session_id: null })` atomically

- [ ] Task 2: Implement PID-file fallback and stale detection (AC: #2, #5)
  - [ ] Add private `acquireViaPidFile(pid, sessionId, opts): Promise<void>`:
    - PID-file path: `.substrate/runs/{run-id}.pid`
    - If PID-file exists: read existing PID, call `process.kill(existingPid, 0)` to test liveness
      - If `ESRCH` (dead): log debug "overwriting stale PID-file for run {run-id}" and proceed (AC5)
      - If alive and `force` not set: read `supervisor_pid` from manifest, throw with prescribed message (AC3)
      - If alive and `force: true`: delegate to `this.forceKillOwner(existingPid)` then retry (AC4)
    - Write current PID to PID-file via atomic write (`writeFile` with `{ flag: 'w' }`)
    - Call `manifest.update({ supervisor_pid: pid, supervisor_session_id: sessionId })`
  - [ ] Add private `releaseViaPidFile(): Promise<void>`: unlink PID-file, clear manifest fields

- [ ] Task 3: Implement force takeover (AC: #4)
  - [ ] Add private `forceKillOwner(existingPid: number): Promise<void>`:
    - Call `process.kill(existingPid, 'SIGTERM')`
    - Wait 500ms (`await new Promise(r => setTimeout(r, 500))`)
    - Call `process.kill(existingPid, 0)` — if process still alive throw: `"Existing supervisor PID {pid} did not exit after SIGTERM. Kill manually and retry."`
  - [ ] In both flock and PID-file paths, when `force: true` and lock is held, invoke `forceKillOwner` before re-acquiring

- [ ] Task 4: Wire `SupervisorLock` into supervisor command lifecycle (AC: #1, #3, #4, #6)
  - [ ] Locate the supervisor entry point in `src/modules/supervisor/` (check for `supervisor.ts`, `supervisor-command.ts`, or the command registered in `src/cli/`)
  - [ ] On supervisor attach: instantiate `SupervisorLock(runId, manifest)` and call `await lock.acquire(process.pid, sessionId, { force: opts.force })`
  - [ ] Register exit cleanup handlers using `process.once` (not `process.on`):
    - `process.once('exit', () => { lock.release().catch(e => logger.debug('lock release on exit', e)) })`
    - `process.once('SIGTERM', () => lock.release().then(() => process.exit(0)).catch(() => process.exit(1)))`
    - `process.once('SIGINT', () => lock.release().then(() => process.exit(0)).catch(() => process.exit(1)))`
  - [ ] Verify `--force` CLI flag is threaded from supervisor command options through to `lock.acquire()`
  - [ ] Add barrel export for `SupervisorLock` to `packages/sdlc/src/run-manifest/index.ts` (or create the file if 52-1 did not)

- [ ] Task 5: Write unit tests (AC: #1 through #7)
  - [ ] Create `packages/sdlc/src/run-manifest/__tests__/supervisor-lock.test.ts`
  - [ ] Mock filesystem ops: `vi.mock('node:fs/promises')` and `vi.mock('node:fs')` to avoid real disk I/O
  - [ ] Mock `RunManifest` from 52-1: stub `.update()` and `.read()` — do not depend on 52-1's real implementation
  - [ ] Mock `process.kill`: `vi.spyOn(process, 'kill').mockImplementation(() => { ... })`
  - [ ] Required test cases:
    - Flock success → `manifest.update` called with correct `supervisor_pid` and `supervisor_session_id` (AC1)
    - ENOSYS thrown by flock → PID-file path taken, `logger.warn` called (AC2)
    - Live PID-file present, no force → error message matches prescribed format exactly (AC3)
    - Force with live PID-file → `process.kill(existingPid, 'SIGTERM')` called, manifest updated with new PID (AC4)
    - PID-file with dead PID (ESRCH from `kill(pid,0)`) → acquisition succeeds without force (AC5)
    - `release()` flock mode → lock file unlinked, manifest updated with `null` fields (AC6)
    - `release()` PID-file mode → PID-file unlinked, manifest updated with `null` fields (AC6)

## Dev Notes

### Architecture Constraints

- **File paths** (must match exactly):
  - Lock file: `.substrate/runs/{run-id}.lock` (advisory flock, primary path)
  - PID-file: `.substrate/runs/{run-id}.pid` (fallback on ENOSYS/EOPNOTSUPP)
  - Manifest: `.substrate/runs/{run-id}.json` (never write directly — use `RunManifest.update()`)
- **Package placement:** `packages/sdlc/src/run-manifest/supervisor-lock.ts` — co-located with `RunManifest` from story 52-1. The supervisor command wiring (Task 4) goes into `src/modules/supervisor/`.
- **Depends on 52-1:** This story uses the `RunManifest` class from story 52-1. Before writing imports, check the exact export path from 52-1's output. The manifest schema must include `supervisor_pid: number | null` and `supervisor_session_id: string | null` — verify these fields exist before building on them.
- **Atomic manifest writes:** All manifest field updates go through `RunManifest.update()` (or equivalent atomic method from 52-1) — never write the manifest JSON directly with `fs.writeFile`.
- **Flock implementation:** Check `package.json` for `proper-lockfile` or similar before implementing. If a lockfile library is already a dependency, use it. If not, implement via `node:fs` open with `O_CREAT | O_RDWR` and a native flock binding or a minimal wrapper. The key behavioral contract is non-blocking exclusive acquisition: succeed immediately if uncontended, fail immediately (do not wait) if contended. Do NOT add new npm dependencies without checking the project's existing dependency inventory first.
- **Error message format is prescribed** (FR-R3): The exact string `"Run {run-id} is already supervised by PID {pid}. Use --force to take over."` must be produced — substitute actual values for `{run-id}` and `{pid}`. Downstream tooling may parse this string.
- **Force uses SIGTERM, not SIGKILL:** Give the process 500ms to exit cleanly before failing hard.
- **No SQLite:** Per `feedback_no_sqlite_run_manifest.md`, all lock state is file-based only.
- **No new npm packages** without approval. Use what is already in `package.json`.
- **Exit handler pattern:** Use `process.once` (not `process.on`) to avoid double-cleanup. Release errors in exit handlers must not propagate (use `.catch` with debug-level logging per the `addTokenUsage` pattern from v0.18.0).
- **TypeScript strict mode:** All new types must be non-`any`. Use `unknown` + type narrowing where needed.
- **Build must stay under 5 seconds:** Avoid circular imports or heavy new imports that slow the TypeScript build.

### Testing Requirements

- **Framework:** Vitest. Import from `vitest`, never from `jest`.
- **Mocking strategy:** Mock all filesystem operations and `process.kill` — no real disk I/O in unit tests.
- **Timing:** If the 500ms SIGTERM wait is inside `SupervisorLock`, use `vi.useFakeTimers()` to advance time in tests without actual delays.
- **RunManifest mock:** Mock at the import level with `vi.mock('../run-manifest')` (or the correct relative path). The mock should track calls to `.update()` so tests can assert manifest writes.
- **Test file location:** `packages/sdlc/src/run-manifest/__tests__/supervisor-lock.test.ts`
- **Targeted run:** `npm run test:fast` (unit tests only, ~50s). Confirm `pgrep -f vitest` returns nothing before running.
- **Build check:** Run `npm run build` after implementation to catch TypeScript errors before test iteration.

### Related Story Context

- **Story 52-1 (must complete first):** Provides `RunManifest` with atomic I/O. `supervisor_pid` and `supervisor_session_id` must be in its schema — confirm before implementing.
- **Story 52-3 (next):** CLI flag persistence adds `cli_flags` to the manifest at run start; shares the same `RunManifest` write path.
- **Story 52-6 (later):** `substrate health` reads `supervisor_pid` from the manifest. The field name set here (`supervisor_pid`) must match exactly what 52-6 reads.
- **MEMORY.md note:** Never suggest wrapping up; fix substrate bugs in substrate (not workarounds). The locking mechanism is critical safety infrastructure — correctness over velocity.

## Interface Contracts

- **Import**: `RunManifest` @ `packages/sdlc/src/run-manifest/run-manifest.ts` (from story 52-1)
- **Export**: `SupervisorLock` @ `packages/sdlc/src/run-manifest/supervisor-lock.ts` (consumed by supervisor command wiring in Task 4 and by story 52-6 for health reads)
- **Export**: `SupervisorLockOptions` @ `packages/sdlc/src/run-manifest/supervisor-lock.ts` (consumed by supervisor command)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-06 | Initial story created for Epic 52 Phase D |
