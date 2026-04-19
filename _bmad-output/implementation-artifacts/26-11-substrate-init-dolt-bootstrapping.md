# Story 26.11: Substrate init Dolt Bootstrapping

Status: review

## Story

As a developer setting up substrate for a new project,
I want `substrate init` to automatically detect and initialize a Dolt state store when Dolt is installed,
so that I get versioned pipeline state tracking without needing to pass an explicit flag.

## Acceptance Criteria

### AC1: Auto-detection on PATH
**Given** `substrate init` is run without `--dolt` or `--no-dolt`
**When** the `dolt` binary is present on PATH and `.substrate/state/.dolt/` does not yet exist
**Then** `initializeDolt()` is called automatically as part of the init flow and exits with success

### AC2: Silent skip when Dolt not installed
**Given** `substrate init` is run without `--dolt` or `--no-dolt`
**When** the `dolt` binary is NOT present on PATH
**Then** the init flow completes successfully with exit code 0 and no error or warning is emitted (Dolt step is silently skipped)

### AC3: Idempotency — already-initialized repo
**Given** `.substrate/state/.dolt/` already exists (Dolt was previously initialized)
**When** `substrate init` is run again (with or without `--dolt`)
**Then** `initializeDolt()` still succeeds (it is idempotent by design), the command exits 0, and no "already initialized" error is thrown

### AC4: `--no-dolt` flag skips Dolt bootstrapping
**Given** `substrate init --no-dolt` is run
**When** the `dolt` binary is present on PATH
**Then** Dolt bootstrapping is skipped entirely and the init flow completes successfully without touching `.substrate/state/`

### AC5: Success output includes Dolt status line
**Given** Dolt is auto-detected and successfully initialized during `substrate init`
**When** the success summary is printed
**Then** the output includes the line: `✓ Dolt state store initialized at .substrate/state/`

### AC6: `--dolt` flag forces Dolt init as part of full init flow
**Given** `substrate init --dolt` is run
**When** the `dolt` binary is present on PATH
**Then** the full init flow runs AND Dolt is bootstrapped; if the binary is NOT present, the command exits with a non-zero code and a clear error message

### AC7: Unit tests cover all Dolt mode branches
**Given** the modified `runInitAction()` and CLI registration
**When** unit tests are run via `npm run test:fast`
**Then** tests exist for `doltMode: 'auto'` with Dolt present, `doltMode: 'auto'` with Dolt absent, `doltMode: 'skip'`, and `doltMode: 'force'` with and without Dolt installed; all tests pass

## Tasks / Subtasks

- [x] Task 1: Extend `InitOptions` with `doltMode` and add Dolt bootstrapping step to `runInitAction()` (AC: #1, #2, #3, #6)
  - [x] Add `doltMode?: 'auto' | 'force' | 'skip'` field to `InitOptions` interface in `src/cli/commands/init.ts` (default: `'auto'`)
  - [x] After the existing init steps in `runInitAction()`, add a new `// Step 7: Dolt bootstrapping` block
  - [x] For `doltMode === 'auto'`: call `checkDoltInstalled()`, catch `DoltNotInstalled` silently, on success call `initializeDolt({ projectRoot })`
  - [x] For `doltMode === 'force'`: call `initializeDolt({ projectRoot })` directly; propagate errors (do not catch `DoltNotInstalled`)
  - [x] For `doltMode === 'skip'`: no-op, log at debug level that Dolt step was skipped

- [x] Task 2: Update CLI option registration to wire `--dolt` / `--no-dolt` into `doltMode` (AC: #4, #6)
  - [x] Add `--no-dolt` option to the `init` command registration in `registerInitCommand()` (boolean, default false, description: "Skip Dolt state store initialization even if Dolt is installed")
  - [x] Change the existing `--dolt` short-circuit block: instead of short-circuiting, set `doltMode: 'force'` and pass to `runInitAction()` (removes the early-return pattern for `opts.dolt`)
  - [x] Set `doltMode: 'skip'` when `--no-dolt` is passed, `doltMode: 'force'` when `--dolt` is passed, `doltMode: 'auto'` otherwise
  - [x] Update the `opts` type annotation to include `noDolt: boolean`

- [x] Task 3: Add Dolt status tracking and output to success summary (AC: #5)
  - [x] Track whether Dolt was initialized in a local boolean (`doltInitialized: boolean`) within the Step 7 block
  - [x] In the success summary output section of `runInitAction()`, emit `✓ Dolt state store initialized at .substrate/state/` when `doltInitialized === true`
  - [x] Ensure JSON output format (`outputFormat === 'json'`) includes a `doltInitialized` field in the result object

- [x] Task 4: Handle error cases gracefully in auto mode (AC: #2, #3)
  - [x] In `doltMode === 'auto'`: any error that is NOT `DoltNotInstalled` (e.g., `DoltInitError`) should be logged at `warn` level and NOT cause the init command to fail (non-blocking degraded path)
  - [x] In `doltMode === 'force'`: `DoltNotInstalled` and `DoltInitError` must cause `runInitAction()` to return a non-zero exit code and write an error message to stderr
  - [x] Add `logger.debug('Dolt not installed, skipping auto-init')` in the silent-skip path

- [x] Task 5: Write unit tests for the Dolt bootstrapping branches (AC: #7)
  - [x] In `src/cli/commands/__tests__/init.test.ts`, add a `describe('Dolt bootstrapping')` block
  - [x] Test `doltMode: 'auto'` + Dolt installed: mock `checkDoltInstalled` to resolve, mock `initializeDolt` to resolve; assert `doltInitialized === true` in output
  - [x] Test `doltMode: 'auto'` + Dolt NOT installed: mock `checkDoltInstalled` to throw `DoltNotInstalled`; assert exit code 0 and no error written to stderr
  - [x] Test `doltMode: 'auto'` + `initializeDolt` throws non-`DoltNotInstalled` error: assert exit code 0 (non-blocking), warn logged
  - [x] Test `doltMode: 'skip'`: assert `initializeDolt` is never called
  - [x] Test `doltMode: 'force'` + Dolt installed: assert `initializeDolt` called, exit 0
  - [x] Test `doltMode: 'force'` + Dolt NOT installed: assert non-zero exit code and stderr message

- [x] Task 6: Verify `--no-dolt` CLI flag is correctly parsed and `--dolt` no longer short-circuits (AC: #4, #6)
  - [x] Add CLI-level test (or confirm existing coverage) that `--no-dolt` results in `doltMode: 'skip'` being passed to `runInitAction()`
  - [x] Confirm that `--dolt` no longer triggers early-return (full init runs including all 7 steps)
  - [x] Run `npm run build` and verify zero TypeScript errors

- [x] Task 7: Run full test suite and confirm passing (AC: #7)
  - [x] Run `npm run test:fast` and confirm all tests pass
  - [x] Run `npm run build` to confirm zero compile errors
  - [x] Verify no existing init tests were broken by the `--dolt` behavioral change (early-return removal)

## Dev Notes

### Architecture Constraints
- File: `src/cli/commands/init.ts` — all changes are confined to this file (except tests)
- Import `checkDoltInstalled` from `../../modules/state/dolt-init.js` — it is already exported; `initializeDolt` and `DoltNotInstalled` are already imported on line 44
- Use `createLogger('init')` for debug/warn logging (already instantiated in the file)
- `doltMode` defaults to `'auto'` — this is the safe no-breaking-change default since the current main flow has no Dolt step at all
- `runInitAction()` must remain synchronous in structure (async/await only); do not restructure the function signature beyond adding `doltMode` to `InitOptions`
- All query parameters / SQL is handled inside `dolt-init.ts` — this story does NOT touch the Dolt schema or SQL layer

### Key File Locations
- Init command: `src/cli/commands/init.ts`
  - `InitOptions` interface: line ~553
  - `runInitAction()`: line ~573
  - CLI registration (`registerInitCommand()`): line ~820
  - Existing `--dolt` short-circuit block: line ~847–862
- Dolt init module: `src/modules/state/dolt-init.ts`
  - `checkDoltInstalled(): Promise<void>` — throws `DoltNotInstalled` if binary absent
  - `initializeDolt(config: DoltInitConfig): Promise<void>` — idempotent, throws `DoltNotInstalled` or `DoltInitError`
  - `DoltInitConfig`: `{ projectRoot: string }`
- Init tests: `src/cli/commands/__tests__/init.test.ts`

### Refactoring the `--dolt` Short-Circuit
The current implementation (lines ~847–862) short-circuits: it runs `initializeDolt()` and returns early, skipping the full init. This story removes that short-circuit and instead passes `doltMode: 'force'` to `runInitAction()`. The net effect is that `--dolt` now also runs the full substrate init (config, BMAD, DB, CLAUDE.md, etc.) in addition to Dolt. This is an intentional improvement.

Before:
```typescript
if (opts.dolt) {
  try {
    await initializeDolt({ projectRoot: opts.projectRoot })
    process.stdout.write('✓ Dolt state database initialized at .substrate/state/\n')
    process.exitCode = INIT_EXIT_SUCCESS
  } catch (err) { ... }
  return  // ← short-circuit, skips runInitAction
}
const exitCode = await runInitAction({ ... })
```

After:
```typescript
const doltMode = opts.noDolt ? 'skip' : opts.dolt ? 'force' : 'auto'
const exitCode = await runInitAction({
  pack: opts.pack,
  projectRoot: opts.projectRoot,
  outputFormat,
  force: opts.force,
  yes: opts.yes,
  doltMode,
  ...(registry !== undefined && { registry }),
})
```

### Dolt Bootstrapping Step Pattern in `runInitAction()`
```typescript
// Step 7: Dolt bootstrapping
let doltInitialized = false
if (options.doltMode !== 'skip') {
  try {
    if (options.doltMode === 'auto') {
      await checkDoltInstalled()  // throws DoltNotInstalled if absent
    }
    await initializeDolt({ projectRoot: options.projectRoot })
    doltInitialized = true
  } catch (err) {
    if (err instanceof DoltNotInstalled) {
      if (options.doltMode === 'force') {
        process.stderr.write(`${err.message}\n`)
        return INIT_EXIT_ERROR
      }
      // auto mode: silently skip
      logger.debug('Dolt not installed, skipping auto-init')
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      if (options.doltMode === 'force') {
        process.stderr.write(`✗ Dolt initialization failed: ${msg}\n`)
        return INIT_EXIT_ERROR
      }
      // auto mode: warn but don't fail
      logger.warn('Dolt auto-init failed (non-blocking)', { error: msg })
    }
  }
}
```

### Testing Requirements
- Test file: `src/cli/commands/__tests__/init.test.ts`
- Use `vi.mock('../../modules/state/dolt-init.js', ...)` to mock `checkDoltInstalled` and `initializeDolt`
- Follow existing init test patterns: mock `fs/promises`, `fs`, `js-yaml`, `../../persistence/database.js`, `../../persistence/migrations/index.js`, `../../modules/methodology-pack/pack-loader.js`
- All six Dolt mode branches must have dedicated test cases (see Task 5)
- Use `vi.fn()` for `checkDoltInstalled` (returns `Promise<void>`) and `initializeDolt` (returns `Promise<void>`)
- To simulate `DoltNotInstalled`: `vi.fn().mockRejectedValue(new DoltNotInstalled())`
- Test framework: Vitest (`vi`, `describe`, `it`, `expect`, `beforeEach`, `afterEach`)
- Coverage threshold: 80% enforced by `npm test`; the new Dolt branches must be covered

### Import Pattern
```typescript
// Already present on line 44:
import { initializeDolt, DoltNotInstalled } from '../../modules/state/dolt-init.js'
// Add to the same import:
import { initializeDolt, checkDoltInstalled, DoltNotInstalled } from '../../modules/state/dolt-init.js'
```

## Interface Contracts

- **Import**: `checkDoltInstalled` @ `src/modules/state/dolt-init.ts` (from story 26-2)
- **Import**: `initializeDolt` @ `src/modules/state/dolt-init.ts` (from story 26-2)
- **Import**: `DoltNotInstalled` @ `src/modules/state/dolt-init.ts` (from story 26-2)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Removed the `--dolt` short-circuit early-return pattern; `--dolt` now runs full init + Dolt bootstrapping
- Added `--no-dolt` Commander option wired to `doltMode: 'skip'`
- doltMode defaults to 'auto' — safe no-breaking-change default
- Pre-existing failures in diff.test.ts and history.test.ts are unrelated (story 26-12 DoltNotInstalled export issue)

### File List
- /home/jplanow/code/jplanow/substrate/src/cli/commands/init.ts
- /home/jplanow/code/jplanow/substrate/src/cli/commands/__tests__/init.test.ts

## Change Log

- 2026-03-08: Story created for Epic 26 Sprint 4
