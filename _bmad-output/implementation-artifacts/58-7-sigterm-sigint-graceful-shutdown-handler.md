# Story 58-7: SIGTERM / SIGINT Graceful Shutdown Handler

## Story

As a substrate operator,
I want `substrate run` to flush pipeline state cleanly when killed via SIGTERM or SIGINT,
so that `pipeline_runs.status` and the run manifest reflect `stopped` — not the stale `running` state that has required three manual Dolt UPDATE chore commits in the past two weeks.

## Acceptance Criteria

### AC1: Signal Handler Installation
Orchestrator startup in `src/modules/implementation-orchestrator/orchestrator-impl.ts`
(or a new signal-handler module if the scope warrants it) installs
`process.on('SIGTERM', handler)` and `process.on('SIGINT', handler)` at the first
`orchestrator.run()` invocation. Handlers are removed on `orchestrator.run()` completion
(clean exit path) to avoid leaking between orchestrator instances in tests.

### AC2: Graceful Shutdown Handler Behavior
Handler (`shutdownGracefully(reason: string)`) implements all of the following:
- Sets an in-memory shutdown flag checked by the dispatch loop so no new story phases are scheduled
- Awaits any in-flight dispatches for up to 5 seconds (new `config.shutdownGracePeriodMs` with default 5000)
- Calls `runManifest.patchRunStatus({ status: 'stopped', stopped_reason: reason, stopped_at: new Date().toISOString() })` using Epic 57-1's serialized write chain (requires a new `patchRunStatus` method on RunManifest; partner story surface)
- Updates Dolt `pipeline_runs.status = 'stopped'` with `updatePipelineRun(db, runId, { status: 'stopped', ... })` (best-effort; wrapped in try/catch)
- Transitions any `wg_stories` rows still in active-state (`planned`, `in_progress`) to `cancelled` via the work-graph repo's existing `updateStoryStatus` — best-effort
- Calls `process.exit(130)` for SIGINT convention; SIGTERM exits 143 (128 + 15) to match the POSIX convention

### AC3: Optional `substrate stop` CLI Subcommand
New optional CLI: `substrate stop [--run-id <id>]` finds the running orchestrator PID
(via `pipeline_runs.orchestrator_pid` or an on-disk pidfile) and sends SIGTERM, then
polls until the PID exits or a 30s timeout. Cleaner than `pgrep -f substrate | xargs kill`.
This sub-story may be deferred to a separate story if scope grows; the SIGTERM handler
itself is in scope for 58-7.

### AC4: OrchestratorConfig Extension
`OrchestratorConfig` in `src/modules/implementation-orchestrator/types.ts` gains
`shutdownGracePeriodMs?: number` (default 5000) with a JSDoc comment describing SIGTERM
behavior.

### AC5: RunManifestData Schema Extension
`RunManifestData` type in `packages/sdlc/src/run-model/types.ts` gains an optional
`stopped_reason?: string` and `stopped_at?: string` field on the top level. Schema is
backward-compatible (both optional, absent on pre-58-7 manifests).

### AC6: Unit Tests
Unit tests at `src/modules/implementation-orchestrator/__tests__/sigterm-shutdown.test.ts` cover:
- Signal handler calls `shutdownGracefully` on SIGTERM
- `shutdownGracefully` flips the shutdown flag, awaits in-flight dispatches, and writes the expected manifest state
- Dispatch loop respects the flag and stops scheduling
- Exit code is 143 for SIGTERM / 130 for SIGINT

### AC7: Integration Test
Integration test: orchestrator running with a blocked dispatch mock; send SIGTERM to the
test's own process; assert the manifest's `stopped_reason` is `killed_by_user` within the
grace period; assert exit code 143.

## Tasks / Subtasks

- [ ] Task 1: Extend types and schemas (AC4, AC5)
  - [ ] Subtask 1a: In `src/modules/implementation-orchestrator/types.ts`, add `shutdownGracePeriodMs?: number` to `OrchestratorConfig` with a JSDoc comment: `/** Grace period in ms to await in-flight dispatches before SIGTERM/SIGINT exits. Default 5000. */`
  - [ ] Subtask 1b: In `packages/sdlc/src/run-model/types.ts`, add `stopped_reason?: string` and `stopped_at?: string` as optional top-level fields on `RunManifestData` (backward-compatible — absent in pre-58-7 manifests)
  - [ ] Subtask 1c: In `packages/sdlc/src/run-model/schemas.ts`, extend the `RunManifestDataSchema` Zod object with `stopped_reason: z.string().optional()` and `stopped_at: z.string().optional()`; confirm existing manifest files without these fields still parse correctly (no `.strict()` rejection)
  - [ ] Subtask 1d: In `packages/sdlc/src/run-model/run-manifest.ts`, add a `patchRunStatus(updates: { status: RunManifestData['run_status']; stopped_reason?: string; stopped_at?: string })` method that routes through `_enqueue()` — reads current data, merges the updates at the top level, calls `_writeImpl()`. Mirror the pattern of the existing `patchCLIFlags` method.

- [ ] Task 2: Install signal handlers and implement `shutdownGracefully` (AC1, AC2)
  - [ ] Subtask 2a: In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, at the start of `orchestrator.run()` (or an equivalent lifecycle hook), create an in-memory `shutdownRequested: boolean` flag (scoped to the run, not module-level) and a promise-based `inFlightDone: Promise<void>` tracker that resolves when all in-flight dispatches have settled
  - [ ] Subtask 2b: Implement `async function shutdownGracefully(reason: string, signal: 'SIGTERM' | 'SIGINT'): Promise<void>` — set the shutdown flag; log an info line; wait for in-flight dispatches with `Promise.race([inFlightDone, sleep(config.shutdownGracePeriodMs ?? 5000)])`; call `runManifest.patchRunStatus({ status: 'stopped', stopped_reason: reason, stopped_at: new Date().toISOString() })`; call `updatePipelineRun(db, runId, { status: 'stopped' })` wrapped in try/catch (best-effort); call `updateStoryStatus` for each active wg_story row (best-effort); then `process.exit(signal === 'SIGINT' ? 130 : 143)`
  - [ ] Subtask 2c: Install signal handlers via `process.on('SIGTERM', sigtermHandler)` and `process.on('SIGINT', sigintHandler)` immediately after the orchestrator run starts. Each handler calls `shutdownGracefully('killed_by_user', 'SIGTERM'|'SIGINT')`.
  - [ ] Subtask 2d: Remove both signal handlers via `process.off()` at the point `orchestrator.run()` completes normally (finally block or explicit teardown) to prevent test leakage between orchestrator instances
  - [ ] Subtask 2e: Wire the `shutdownRequested` flag into the dispatch loop — wherever the loop calls `scheduleNextStory()` or equivalent, add an early-return guard: `if (shutdownRequested) return`

- [ ] Task 3: Implement `substrate stop` CLI subcommand (AC3) — defer to 58-7b if scope is tight
  - [ ] Subtask 3a: Add `stop` command handler in the CLI entry point; accept optional `--run-id <id>` flag; when no run ID provided, query `pipeline_runs` for the most recent `running` row and read its `orchestrator_pid`
  - [ ] Subtask 3b: Send SIGTERM to the found PID; poll every 500ms checking whether the process is still alive (`process.kill(pid, 0)` throws when gone); exit 0 when gone or emit error after 30s timeout

- [ ] Task 4: Write unit tests (AC6)
  - [ ] Subtask 4a: Create `src/modules/implementation-orchestrator/__tests__/sigterm-shutdown.test.ts`; use vitest and vi.fn() mocks for `runManifest.patchRunStatus`, `updatePipelineRun`, `updateStoryStatus`, and `process.exit`
  - [ ] Subtask 4b: Test: SIGTERM handler calls `shutdownGracefully('killed_by_user', 'SIGTERM')` — verify via spy that the handler is invoked and eventually calls `patchRunStatus` with `{ status: 'stopped', stopped_reason: 'killed_by_user' }`
  - [ ] Subtask 4c: Test: `shutdownGracefully` sets the in-memory `shutdownRequested` flag synchronously, so a subsequent dispatch loop check sees `true` and skips scheduling
  - [ ] Subtask 4d: Test: SIGTERM calls `process.exit(143)`; SIGINT calls `process.exit(130)` — verify via spy
  - [ ] Subtask 4e: Test: when `shutdownRequested` is set, the dispatch loop guard prevents `scheduleNextStory` from being called; verify via spy call count

- [ ] Task 5: Write integration test (AC7)
  - [ ] Subtask 5a: Add an integration test in `sigterm-shutdown.test.ts` (or a dedicated e2e file) that: instantiates an orchestrator with a blocked dispatch mock (a promise that never resolves within the test window); sends SIGTERM to `process` by calling `process.emit('SIGTERM')` directly (no cross-process fork needed); asserts that `runManifest.patchRunStatus` was called with `stopped_reason: 'killed_by_user'` within the grace period; asserts `process.exit` was called with 143
  - [ ] Subtask 5b: Verify the manifest file on disk (tempdir) contains `stopped_reason: 'killed_by_user'` and `stopped_at` as an ISO string

## Dev Notes

### Architecture Constraints

- **Signal handler scope**: The `shutdownRequested` flag and the signal handler references MUST be scoped to each `orchestrator.run()` invocation — not module-level singletons. Module-level state leaks between orchestrator instances created in the same test suite (vi.resetModules() is not called between every test). The handler must be registered at run start and deregistered at run end.
- **Write chain serialization**: `patchRunStatus` MUST route through the existing `_enqueue()` private method in `run-manifest.ts` (Epic 57-1's write chain). Do NOT call `_writeImpl()` directly. This preserves the single-writer guarantee under concurrent patches.
- **Best-effort Dolt writes**: `updatePipelineRun` and `updateStoryStatus` calls in `shutdownGracefully` are wrapped in `try/catch` — Dolt may be offline or read-only (the v0.20.9 "database is read only" scenario). Log the error at warn level, but do NOT let it block the `process.exit` call.
- **Import style**: All relative imports within `packages/sdlc/src/run-model/` use `.js` extension (ESM). When modifying `types.ts`, `schemas.ts`, and `run-manifest.ts`, keep the `.js` import convention consistent with adjacent code.
- **No new module file required**: Unless the signal-handler logic grows beyond ~60 lines, implement it inline in `orchestrator-impl.ts` rather than creating a new `signal-handler.ts`. Minimize surface area.

### patchRunStatus Method Pattern

Mirror the existing `patchCLIFlags` pattern in `run-manifest.ts`:

```typescript
async patchRunStatus(updates: {
  status?: RunManifestData['run_status']
  stopped_reason?: string
  stopped_at?: string
}): Promise<void> {
  return this._enqueue(async () => {
    const current = await this.read()
    await this._writeImpl({
      ...current,
      ...updates,
    })
  })
}
```

### Shutdown Flag and Dispatch Loop Guard

The `shutdownRequested` flag lives as a local `let` in the closure wrapping `orchestrator.run()`. Wire it into the dispatch loop at the earliest scheduling gate:

```typescript
let shutdownRequested = false

// In the dispatch loop:
if (shutdownRequested) {
  logger.info({ storyKey }, 'shutdown requested — skipping dispatch')
  return
}
```

### In-Flight Dispatch Tracking

Track in-flight dispatches with a simple counter + drain promise:

```typescript
let inFlightCount = 0
let drainResolve: (() => void) | null = null
const drainPromise = new Promise<void>(resolve => { drainResolve = resolve })

// On dispatch start:
inFlightCount++

// On dispatch settle (finally):
inFlightCount--
if (inFlightCount === 0 && shutdownRequested) drainResolve?.()
```

In `shutdownGracefully`, await:

```typescript
const gracePeriod = config.shutdownGracePeriodMs ?? 5000
await Promise.race([drainPromise, new Promise(r => setTimeout(r, gracePeriod))])
```

### Exit Code Convention

| Signal | Exit Code | Rationale |
|--------|-----------|-----------|
| SIGTERM | 143 | 128 + 15 — POSIX convention |
| SIGINT | 130 | 128 + 2 — standard Ctrl-C convention |

### `substrate stop` CLI Pattern

If not deferred:
- Query `pipeline_runs WHERE status = 'running' ORDER BY started_at DESC LIMIT 1` to find the active run's `orchestrator_pid`
- Use `process.kill(pid, 'SIGTERM')` to send the signal
- Poll alive check with `try { process.kill(pid, 0); return true } catch { return false }` every 500ms
- Timeout after 30s with a non-zero exit and diagnostic message

### Testing Requirements

- **Test framework**: vitest (matching the rest of the codebase)
- **Run during development**: `npm run test:fast` (unit tests only, ~50s)
- **Never run tests concurrently**: verify `pgrep -f vitest` returns nothing before running
- **Do NOT pipe test output** through head/tail/grep — read the vitest summary line directly
- **Mock `process.exit`**: use `vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called') })` or mock with `vi.fn()` to capture the exit code without actually exiting the test process
- **Signal emission in tests**: use `process.emit('SIGTERM')` to trigger handlers without spawning child processes
- **Timeout for integration test**: use `{ timeout: 10000 }` on the integration test — it's timing-sensitive but should complete well under 10s with a 5s grace period

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
