# Story 47-3: Twin Integration with Scenario Runner

## Story

As a pipeline developer,
I want the scenario runner to automatically start required digital twins before scenario execution and stop them after,
so that scenarios can validate behavior against live external-service simulations without any manual setup.

## Acceptance Criteria

### AC1: ScenarioManifest extended with optional `twins` field
**Given** `packages/factory/src/scenarios/types.ts`
**When** it is imported
**Then** `ScenarioManifest` exposes an optional `twins?: string[]` field representing the names of digital twins required for scenario execution (populated from `.substrate/twins/` registry at runtime)

### AC2: Twins started before any scenario script executes
**Given** a `ScenarioManifest` with `twins: ['stripe', 'sendgrid']` and a `twinCoordinator` supplied in `ScenarioRunnerOptions`
**When** `runner.run(manifest, projectRoot)` is called
**Then** `twinCoordinator.startTwins(['stripe', 'sendgrid'])` completes and resolves with an env-var map before the first scenario subprocess is spawned

### AC3: Twin environment variables injected into scenario subprocesses
**Given** `twinCoordinator.startTwins()` resolves with `{ STRIPE_URL: 'http://localhost:4242' }`
**When** scenario scripts are spawned via `child_process.spawn`
**Then** each subprocess receives those key-value pairs merged on top of the current `process.env`, making twin services accessible to the scripts

### AC4: Guaranteed twin teardown via try/finally
**Given** twins were started before scenario execution begins
**When** all scenario scripts complete — whether all pass, some fail, or an unhandled rejection occurs
**Then** `twinCoordinator.stopTwins()` is always called in a `finally` block, guaranteeing cleanup regardless of execution outcome

### AC5: Twin startup failure produces an error result without running any scenarios
**Given** `twinCoordinator.startTwins()` rejects with `Error('Docker not found — twins require Docker')`
**When** `runner.run(manifest, projectRoot)` is called
**Then** no scenario scripts are executed, `stopTwins()` is NOT called (nothing was started), and the returned `ScenarioRunResult` has `summary.failed === manifest.scenarios.length` with each `ScenarioResult` carrying `status: 'fail'`, `exitCode: -1`, and `stderr` containing the startup error message

### AC6: Backward compatibility when no twins are required
**Given** a `ScenarioManifest` with no `twins` field (or `twins: []`) — or a runner created without `twinCoordinator` in options
**When** `runner.run()` is called
**Then** neither `startTwins` nor `stopTwins` is called, and all behaviour is identical to the pre-47-3 implementation

### AC7: Unit tests for twin-integrated runner
**Given** `packages/factory/src/scenarios/__tests__/runner-twins.test.ts`
**When** vitest runs
**Then** tests cover: (a) `startTwins` is called with correct twin names before scenario execution, (b) env vars from `startTwins` are present in subprocess environment, (c) `stopTwins` is called after all scenarios pass, (d) `stopTwins` is called even when a scenario exits with a non-zero code, (e) twin startup failure returns an error `ScenarioRunResult` without executing any scenarios and without calling `stopTwins`, and (f) manifest with no `twins` field triggers no coordinator calls

## Interface Contracts

- **Export**: `TwinCoordinator` @ `packages/factory/src/scenarios/runner.ts` (consumed by story 47-2 adapter, story 47-5 CLI wiring)
- **Import**: twin lifecycle implementation is injected via `ScenarioRunnerOptions.twinCoordinator`; concrete class produced by story 47-2 (`DockerComposeTwinCoordinator` or equivalent adapter)

## Tasks / Subtasks

- [ ] Task 1: Extend `ScenarioManifest` with the `twins` field (AC: #1, #6)
  - [ ] Open `packages/factory/src/scenarios/types.ts`
  - [ ] Add `twins?: string[]` to `ScenarioManifest` with JSDoc: `"Names of digital twins required for scenario execution. Populated from the .substrate/twins/ registry. Omit or leave empty when no twins are needed."`
  - [ ] Run `npm run test:changed` to confirm no existing tests break

- [ ] Task 2: Define `TwinCoordinator` interface and extend `ScenarioRunnerOptions` (AC: #2, #3, #4, #5)
  - [ ] Add `export interface TwinCoordinator` in `packages/factory/src/scenarios/runner.ts` with two methods:
    - `startTwins(names: string[]): Promise<Record<string, string>>` — starts the named twins; resolves with env-var map for injection into scenario subprocesses
    - `stopTwins(): Promise<void>` — stops all running twins; must be idempotent
  - [ ] Add optional `twinCoordinator?: TwinCoordinator` field to `ScenarioRunnerOptions` with JSDoc explaining its role
  - [ ] Store the options object in the `createScenarioRunner` closure so `run()` can access `twinCoordinator`

- [ ] Task 3: Extend `runScenario()` to accept and inject environment variables (AC: #3)
  - [ ] Add optional `env?: Record<string, string>` parameter to the internal `runScenario()` function signature
  - [ ] When `env` is provided, pass `{ ...process.env, ...env }` as the `env` option to `spawn()`; when absent, omit `env` from spawn options (inherits `process.env` as before)
  - [ ] Confirm the function signature change is backward-compatible (env defaults to undefined)

- [ ] Task 4: Implement twin lifecycle in `ScenarioRunner.run()` (AC: #2, #3, #4, #5, #6)
  - [ ] At the start of `run()`, check whether `manifest.twins` is a non-empty array AND `options.twinCoordinator` is set; if either condition is false, run the existing code path unchanged (AC #6)
  - [ ] If twins are required: call `await twinCoordinator.startTwins(manifest.twins!)` inside a try block to get `twinEnv: Record<string, string>`
  - [ ] If `startTwins()` throws, catch the error; map each `manifest.scenarios` entry to a failed `ScenarioResult` with `{ status: 'fail', exitCode: -1, stdout: '', stderr: err.message, durationMs: 0 }`; return the failure `ScenarioRunResult` immediately without calling `stopTwins()`
  - [ ] Wrap the `Promise.all(manifest.scenarios.map(...runScenario...))` in a `try/finally`; pass `twinEnv` into each `runScenario()` call; call `await twinCoordinator.stopTwins()` in the `finally` block

- [ ] Task 5: Export `TwinCoordinator` from the scenarios barrel (AC: #2)
  - [ ] Open `packages/factory/src/scenarios/index.ts`
  - [ ] Add `export type { TwinCoordinator } from './runner.js'` alongside the existing `ScenarioRunner` and `ScenarioRunnerOptions` exports
  - [ ] Run `npm run build` to confirm TypeScript compilation succeeds

- [ ] Task 6: Write unit tests for twin-integrated runner (AC: #7)
  - [ ] Create `packages/factory/src/scenarios/__tests__/runner-twins.test.ts`
  - [ ] Import `createScenarioRunner` and `TwinCoordinator` from `../runner.js`; use `vi.fn()` mocks for both `TwinCoordinator` methods
  - [ ] **Test (a)** — call order: create a real temp `.sh` script that exits 0; assert `startTwins` mock was called with the correct names before the scenario subprocess resolves (use `vi.fn()` call-order assertions or a shared sequence array)
  - [ ] **Test (b)** — env injection: create a temp `.sh` script that does `echo "{\"TWIN_INJECTED\":\"$TWIN_URL\"}"` (prints JSON); mock `startTwins` to return `{ TWIN_URL: 'http://localhost:9999' }`; assert the resulting `ScenarioResult.parsedOutput` contains `{ TWIN_INJECTED: 'http://localhost:9999' }`
  - [ ] **Test (c)** — stop after pass: after all scenarios pass, assert `stopTwins` was called exactly once
  - [ ] **Test (d)** — stop after fail (cleanup): create a temp `.sh` script that exits 1; assert `stopTwins` is still called exactly once despite the scenario failure
  - [ ] **Test (e)** — startup failure: make `startTwins` mock reject with `new Error('Docker not found')`; assert no scenario scripts are run, the returned result has all entries with `status: 'fail'` and `stderr` containing `'Docker not found'`, and `stopTwins` is NOT called
  - [ ] **Test (f)** — no twins: pass a manifest with `twins: undefined` (or `twins: []`); assert neither `startTwins` nor `stopTwins` is called, run completes normally
  - [ ] Use `fs.mkdtempSync(os.tmpdir() + '/')` for temp script files; clean up in `afterEach` with `fs.rmSync`

- [ ] Task 7: Full validation (AC: #6, #7)
  - [ ] Run `npm run test:fast` and confirm all tests pass (no regressions)
  - [ ] Run `npm run build` to confirm zero TypeScript errors
  - [ ] Confirm only files under `packages/factory/src/scenarios/` were modified (git diff)

## Dev Notes

### Architecture Constraints
- **TypeScript only** — all new/modified code in `packages/factory/src/scenarios/` must use explicit type annotations; no `any` types
- **Import style** — use `.js` extension on all relative imports (ESM): `import { ... } from './types.js'`
- **No cross-module concrete imports** — `scenarios/runner.ts` must NOT import concrete classes from `packages/factory/src/twins/`; it only defines the `TwinCoordinator` interface and accepts it via dependency injection; concrete adapters live in the twins module (story 47-2)
- **Options stored in closure** — the current `createScenarioRunner(_options)` discards options (prefixed `_`); this story must remove the underscore prefix, store options, and thread `twinCoordinator` through to `run()`
- **Cleanup on startup failure** — when `startTwins()` throws, do NOT call `stopTwins()`; only started resources should be stopped; use a boolean flag `twinsStarted` to track this
- **Test framework** — vitest (NOT jest); use `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
- **Backward compatibility** — `run(manifest, projectRoot)` call signature is unchanged; all existing runner tests must pass without modification

### Testing Requirements
- New test file: `packages/factory/src/scenarios/__tests__/runner-twins.test.ts`
- Mock `TwinCoordinator` with `vi.fn()` — do NOT use real Docker, TwinRegistry, or TwinManager in these unit tests
- Temp script pattern:
  ```typescript
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-twins-'))
  const scriptPath = path.join(tmpDir, 'scenario-test.sh')
  fs.writeFileSync(scriptPath, '#!/bin/sh\necho "{}"\nexit 0\n')
  fs.chmodSync(scriptPath, 0o755)
  const checksum = crypto.createHash('sha256').update(fs.readFileSync(scriptPath)).digest('hex')
  const manifest: ScenarioManifest = {
    scenarios: [{ name: 'scenario-test.sh', path: scriptPath, checksum }],
    capturedAt: Date.now(),
    twins: ['stripe'],
  }
  ```
- All temp files must be removed in `afterEach` to prevent leakage between tests

### Pattern Reference — Twin-aware run() flow

After this story, the `run()` method internally follows this structure when twins are required:

```typescript
async run(manifest: ScenarioManifest, projectRoot: string): Promise<ScenarioRunResult> {
  const { twinCoordinator } = options ?? {}
  const requiresTwins = (manifest.twins?.length ?? 0) > 0 && twinCoordinator != null

  if (!requiresTwins) {
    // Existing code path — unchanged
  }

  let twinEnv: Record<string, string>
  try {
    twinEnv = await twinCoordinator!.startTwins(manifest.twins!)
  } catch (err) {
    // Map all scenarios to failure result, do NOT call stopTwins
    return buildStartupFailureResult(manifest.scenarios, err as Error)
  }

  try {
    const scenarios = await Promise.all(
      manifest.scenarios.map((entry) => runScenario(entry, projectRoot, twinEnv)),
    )
    // ... build and return result
  } finally {
    await twinCoordinator!.stopTwins()
  }
}
```

### Key File Paths
- `packages/factory/src/scenarios/types.ts` — **modify**: add `twins` field to `ScenarioManifest`
- `packages/factory/src/scenarios/runner.ts` — **modify**: add `TwinCoordinator` interface, extend options, implement lifecycle
- `packages/factory/src/scenarios/index.ts` — **modify**: export `TwinCoordinator` type
- `packages/factory/src/scenarios/__tests__/runner-twins.test.ts` — **new**: unit tests (7 test cases)
- `packages/factory/src/twins/types.ts` — **read-only reference** for `TwinDefinition`, `TwinManager` shapes (created by story 47-1)
- `packages/factory/src/twins/docker-compose.ts` — **read-only reference** (story 47-2 provides concrete `TwinManager`)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
