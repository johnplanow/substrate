# Story 47-5: `substrate factory twins` CLI Commands (start, stop, status, list)

## Story

As a developer using the substrate factory,
I want CLI commands to start, stop, check the status of, and list my digital twins,
so that I can manage the full twin lifecycle from the command line without writing Docker commands manually.

## Acceptance Criteria

### AC1: `twins start` starts all discovered twins and persists run state
**Given** one or more twin definition YAML files exist in `<project>/.substrate/twins/`
**When** `substrate factory twins start` is executed from the project root
**Then** all discovered twins are started via `TwinManager`, a run state file is written to `.substrate/twins/.run-state.json` containing the compose directory path and started twin names, and stdout lists each started twin with a success confirmation line

### AC2: `twins stop` stops running twins and clears run state
**Given** `.substrate/twins/.run-state.json` exists with a valid compose directory path
**When** `substrate factory twins stop` is executed
**Then** `docker compose down --remove-orphans` is executed in the saved compose directory, the compose temp directory is removed, `.run-state.json` is deleted, and stdout confirms all twins were stopped

### AC3: `twins status` displays each twin's name, status, and port mappings
**Given** twin definitions exist in `.substrate/twins/` (with or without a run state file)
**When** `substrate factory twins status` is executed
**Then** stdout shows one line per twin with its name (padded), status (`running` or `stopped` derived from the run state file), and port mappings in `host:container` format

### AC4: `twins list` displays all discovered twin definitions
**Given** one or more twin definition YAML files exist in `.substrate/twins/`
**When** `substrate factory twins list` is executed
**Then** stdout shows one line per twin with name, Docker image, ports, and healthcheck URL (if configured); twins with no healthcheck show `—` for that column

### AC5: `twins start` exits with code 1 if no twin definitions are found
**Given** `.substrate/twins/` does not exist or contains no `.yaml`/`.yml` files
**When** `substrate factory twins start` is executed
**Then** the process exits with code 1 and stderr contains a message indicating no twin definitions were found (e.g., `"No twin definitions found in .substrate/twins/"`)

### AC6: `twins stop` exits with code 1 if no twins are currently running
**Given** `.substrate/twins/.run-state.json` does not exist
**When** `substrate factory twins stop` is executed
**Then** the process exits with code 1 and stderr contains `"No twins are currently running"`

### AC7: Unit tests cover run-state helpers and all four command handlers
**Given** mocked `node:fs/promises`, `node:child_process`, and `TwinManager`
**When** the test suite for run-state and twins CLI is run via `npm run test:fast`
**Then** all tests pass with ≥ 14 test cases covering `readRunState`, `writeRunState`, `clearRunState`, and the happy-path and error-path for each of the four subcommands

## Interface Contracts

- **Export**: `TwinRunState` @ `packages/factory/src/twins/run-state.ts` (consumed by `factory-command.ts`)
- **Export**: `readRunState`, `writeRunState`, `clearRunState`, `runStatePath` @ `packages/factory/src/twins/run-state.ts` (consumed by `factory-command.ts`)
- **Import**: `TwinDefinition` @ `packages/factory/src/twins/types.ts` (from story 47-1)
- **Import**: `TwinRegistry`, `createTwinRegistry` @ `packages/factory/src/twins/registry.ts` (from story 47-1)
- **Import**: `createTwinManager`, `TwinError` @ `packages/factory/src/twins/docker-compose.ts` (from story 47-2)

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/twins/run-state.ts` — run state management module (AC: #1, #2, #3, #6)
  - [ ] Define and export `TwinRunState` interface: `{ composeDir: string; twinNames: string[]; startedAt: string }`
  - [ ] Export `runStatePath(projectDir: string): string` — returns `path.join(projectDir, '.substrate', 'twins', '.run-state.json')`
  - [ ] Export `readRunState(projectDir: string): Promise<TwinRunState | null>` — reads and JSON-parses the file; returns `null` if the file doesn't exist (`ENOENT`); throws on any other I/O error or JSON parse failure
  - [ ] Export `writeRunState(projectDir: string, state: TwinRunState): Promise<void>` — creates parent directories with `mkdir({ recursive: true })` then writes JSON to the state file path
  - [ ] Export `clearRunState(projectDir: string): Promise<void>` — deletes the state file; no-op if the file doesn't exist (`ENOENT`)
  - [ ] No `any` types; use `node:fs/promises` (`readFile`, `writeFile`, `unlink`, `mkdir`); `.js` extension on all relative imports

- [ ] Task 2: Export run-state helpers from the twins barrel (AC: #1, #2, #3)
  - [ ] Open `packages/factory/src/twins/index.ts`
  - [ ] Add: `export { readRunState, writeRunState, clearRunState, runStatePath } from './run-state.js'`
  - [ ] Add: `export type { TwinRunState } from './run-state.js'`
  - [ ] Run `npm run build` to confirm zero TypeScript errors before proceeding

- [ ] Task 3: Implement `twins start` subcommand in `factory-command.ts` (AC: #1, #5)
  - [ ] Add imports: `import { createTwinRegistry } from './twins/index.js'`, `import { readRunState, writeRunState } from './twins/run-state.js'` (note: `createTwinManager` is already imported or add it here)
  - [ ] Also add `import { TypedEventBusImpl } from '@substrate-ai/core'` if not already present
  - [ ] After the existing `twins init` block in `registerFactoryCommand`, register:
    ```typescript
    twinsCmd
      .command('start')
      .description('Start all discovered twin definitions via Docker Compose')
      .action(async () => { ... })
    ```
  - [ ] Inside the action:
    - [ ] Discover twins: call `createTwinRegistry()`, then `registry.discover(path.join(process.cwd(), '.substrate', 'twins'))` in a try/catch; on `TwinDefinitionError`, write to stderr and `process.exit(1)`
    - [ ] After discovery, call `registry.list()`; if the returned array is empty, write `"No twin definitions found in .substrate/twins/"` to stderr and `process.exit(1)`
    - [ ] Create a minimal event bus: `const eventBus = new TypedEventBusImpl<FactoryEvents>()`; attach a `twin:started` listener that writes `"  Started: ${e.twinName}\n"` to stdout
    - [ ] Create `const manager = createTwinManager(eventBus)` and call `await manager.start(twins)`; wrap in try/catch, on `TwinError` write to stderr and `process.exit(1)`
    - [ ] After start: call `await writeRunState(process.cwd(), { composeDir: <capture from manager — see note>, twinNames: twins.map(t => t.name), startedAt: new Date().toISOString() })`
    - [ ] **Note on composeDir capture**: `TwinManager.start()` currently does not expose the compose directory. To capture it, either (a) extend the `TwinManager` interface with a `getComposeDir(): string | null` method, or (b) create a thin wrapper in `factory-command.ts` that intercepts the `twin:started` events and reads the temp dir from a shared closure. The recommended approach is option (a): add `getComposeDir(): string | null` to the `TwinManager` interface in `docker-compose.ts` and return `composeDir` from the closure. This is a non-breaking additive change.
    - [ ] Write `"\nAll twins started successfully.\n"` to stdout on success

- [ ] Task 4: Implement `twins stop` subcommand in `factory-command.ts` (AC: #2, #6)
  - [ ] Add import: `import { readRunState, clearRunState } from './twins/run-state.js'`
  - [ ] Register `twinsCmd.command('stop').description('Stop all running twins').action(async () => { ... })`
  - [ ] Inside the action:
    - [ ] Read run state: `const state = await readRunState(process.cwd())`; if `null`, write `"No twins are currently running"` to stderr and `process.exit(1)`
    - [ ] Execute shutdown: `execSync('docker compose down --remove-orphans', { cwd: state.composeDir, stdio: 'pipe' })` in a try/catch; catch and write error to stderr (but still proceed to cleanup)
    - [ ] Clean up: `rmSync(state.composeDir, { recursive: true, force: true })`
    - [ ] Clear run state: `await clearRunState(process.cwd())`
    - [ ] Write `"Stopped twins: ${state.twinNames.join(', ')}\n"` to stdout
  - [ ] Import `execSync` from `'node:child_process'` and `rmSync` from `'node:fs'` at top of file (add to existing node imports or add new ones)

- [ ] Task 5: Implement `twins status` subcommand in `factory-command.ts` (AC: #3)
  - [ ] Register `twinsCmd.command('status').description('Show status of all discovered twins').action(async () => { ... })`
  - [ ] Inside the action:
    - [ ] Read run state: `const state = await readRunState(process.cwd())`; compute the set `runningNames = new Set(state?.twinNames ?? [])`
    - [ ] Discover twins: call `createTwinRegistry()` and `registry.discover(path.join(process.cwd(), '.substrate', 'twins'))` in a try/catch; if discovery fails, proceed with empty list (display message)
    - [ ] For each discovered twin:
      - [ ] Determine status string: `runningNames.has(twin.name) ? 'running' : 'stopped'`
      - [ ] Format ports as `twin.ports.map(p => \`${p.host}:${p.container}\`).join(', ')` (or `'—'` if no ports)
      - [ ] Write: `"  ${twin.name.padEnd(20)}  ${status.padEnd(10)}  ${portsStr}\n"` to stdout
    - [ ] If no twins discovered, write `"No twin definitions found in .substrate/twins/\n"` to stdout

- [ ] Task 6: Implement `twins list` subcommand in `factory-command.ts` (AC: #4)
  - [ ] Register `twinsCmd.command('list').description('List all discovered twin definitions').action(async () => { ... })`
  - [ ] Inside the action:
    - [ ] Discover twins using `createTwinRegistry()` and `registry.discover(...)` in a try/catch
    - [ ] If no twins found, write `"No twin definitions found in .substrate/twins/\n"` to stdout and return
    - [ ] Print a header line: `"  NAME                 IMAGE                                  PORTS           HEALTHCHECK\n"`
    - [ ] For each twin:
      - [ ] Ports: `twin.ports.map(p => \`${p.host}:${p.container}\`).join(', ')` or `'—'`
      - [ ] Healthcheck: `twin.healthcheck?.url ?? '—'`
      - [ ] Write: `"  ${twin.name.padEnd(20)}  ${twin.image.padEnd(38)}  ${ports.padEnd(16)}  ${healthcheck}\n"`
  - [ ] Update the JSDoc subcommand tree comment at the top of `factory-command.ts` to include `start`, `stop`, `status`, `list` under the `twins` entry
  - [ ] Update `story 47-4` reference in the JSDoc to add `Story 47-5 (twins lifecycle)`

- [ ] Task 7: Write unit tests for run-state helpers and CLI command logic (AC: #7)
  - [ ] Create `packages/factory/src/twins/__tests__/run-state.test.ts`
    - [ ] Use vitest: `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
    - [ ] **`runStatePath` test**: assert returns correct path ending in `.substrate/twins/.run-state.json`
    - [ ] **`readRunState` — file not found**: mock `readFile` to throw `{ code: 'ENOENT' }`; assert returns `null`
    - [ ] **`readRunState` — valid file**: mock `readFile` to return a valid JSON string; assert returned object matches expected `TwinRunState`
    - [ ] **`readRunState` — invalid JSON**: mock `readFile` to return `"not json"`; assert throws
    - [ ] **`writeRunState`**: mock `mkdir` and `writeFile`; assert `mkdir` called with `{ recursive: true }` and `writeFile` called with correct JSON string
    - [ ] **`clearRunState` — file exists**: mock `unlink` to resolve; assert `unlink` called with correct path
    - [ ] **`clearRunState` — file not found**: mock `unlink` to throw `{ code: 'ENOENT' }`; assert no error thrown
  - [ ] Create `packages/factory/src/twins/__tests__/twins-cli.test.ts`
    - [ ] Mock `node:child_process` using `vi.mock` — `execSync` never calls real Docker
    - [ ] Mock `node:fs` (sync methods) and `node:fs/promises` (async methods)
    - [ ] Mock `createTwinRegistry` and `createTwinManager` to return spy objects
    - [ ] **`twins start` — happy path**: mock registry discovering 1 twin; assert `manager.start()` called; assert `writeRunState` called with twinNames array
    - [ ] **`twins start` — no twins found**: mock `registry.list()` returning `[]`; assert `process.exit(1)` called
    - [ ] **`twins start` — TwinError**: mock `manager.start()` rejecting with `TwinError`; assert `process.exit(1)` called
    - [ ] **`twins stop` — happy path**: mock `readRunState` returning a valid state; assert `execSync` called with `'docker compose down --remove-orphans'`; assert `clearRunState` called
    - [ ] **`twins stop` — no run state**: mock `readRunState` returning `null`; assert `process.exit(1)` called
    - [ ] **`twins status` — running**: mock `readRunState` returning state with twin names; mock registry discovering those twins; assert stdout contains `'running'` for those twins
    - [ ] **`twins status` — stopped**: mock `readRunState` returning `null`; assert stdout contains `'stopped'`
    - [ ] **`twins list` — happy path**: mock registry discovering 2 twins; assert stdout contains both twin names and images
    - [ ] **`twins list` — no twins**: mock registry discovering 0 twins; assert stdout contains `'No twin definitions found'`
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" line appears with all tests passing

- [ ] Task 8: Build and regression validation (AC: all)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors required
  - [ ] Run `npm run test:fast` with `timeout: 300000` — all new tests pass; no regression in existing baseline

## Dev Notes

### Architecture Constraints
- **TypeScript only** — all new/modified code must use explicit type annotations; no `any` types
- **Import style** — use `.js` extension on all relative imports (ESM): `import { ... } from './run-state.js'`
- **Test framework** — vitest (NOT jest); use `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
- **No Docker in tests** — mock `node:child_process.execSync` entirely; tests must pass without Docker installed
- **Exit code discipline** — call `process.exit(1)` for error conditions; never throw unhandled rejections from CLI actions
- **No circular imports** — `run-state.ts` must not import from `registry.ts`, `docker-compose.ts`, or `factory-command.ts`
- **Event bus pattern** — create `new TypedEventBusImpl<FactoryEvents>()` locally inside the `start` action handler; do NOT use a module-level singleton
- **Existing imports in factory-command.ts** — `TypedEventBusImpl` is imported from `@substrate-ai/core`; `readFile`, `mkdir`, `writeFile`, `access` are imported from `'node:fs/promises'`; add `execSync` from `'node:child_process'` and `rmSync` from `'node:fs'` as new imports

### TwinManager Interface Extension (for `getComposeDir`)

Story 47-5 requires capturing the compose directory path after `start()` so it can be written to run state. Extend the `TwinManager` interface in `packages/factory/src/twins/docker-compose.ts`:

```typescript
export interface TwinManager {
  start(twins: TwinDefinition[]): Promise<void>
  stop(): Promise<void>
  /** Returns the temp directory path of the active docker-compose.yml, or null if not started. */
  getComposeDir(): string | null
}
```

In `createTwinManager`, the closure already has `composeDir: string | null`. Add:
```typescript
getComposeDir(): string | null {
  return composeDir
}
```

This is a non-breaking additive change — existing callers of `start()` and `stop()` are unaffected.

### Key File Paths

- `packages/factory/src/twins/run-state.ts` — **new**: run state management (TwinRunState, read/write/clear helpers)
- `packages/factory/src/twins/index.ts` — **modify**: add run-state exports
- `packages/factory/src/twins/docker-compose.ts` — **modify**: add `getComposeDir()` to `TwinManager` interface and implementation
- `packages/factory/src/factory-command.ts` — **modify**: add `start`, `stop`, `status`, `list` subcommands to `twinsCmd`; update JSDoc comment
- `packages/factory/src/twins/__tests__/run-state.test.ts` — **new**: unit tests for run-state helpers (7 cases)
- `packages/factory/src/twins/__tests__/twins-cli.test.ts` — **new**: unit tests for CLI command logic (9 cases)

### `TwinRunState` Interface

```typescript
export interface TwinRunState {
  /** Absolute path to the temp directory containing the active docker-compose.yml */
  composeDir: string
  /** Names of all twins included in this run */
  twinNames: string[]
  /** ISO 8601 timestamp of when the twins were started */
  startedAt: string
}
```

### `run-state.ts` Implementation Sketch

```typescript
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface TwinRunState {
  composeDir: string
  twinNames: string[]
  startedAt: string
}

export function runStatePath(projectDir: string): string {
  return path.join(projectDir, '.substrate', 'twins', '.run-state.json')
}

export async function readRunState(projectDir: string): Promise<TwinRunState | null> {
  const filePath = runStatePath(projectDir)
  try {
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as TwinRunState
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}

export async function writeRunState(projectDir: string, state: TwinRunState): Promise<void> {
  const filePath = runStatePath(projectDir)
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8')
}

export async function clearRunState(projectDir: string): Promise<void> {
  const filePath = runStatePath(projectDir)
  try {
    await unlink(filePath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
```

### `twins start` Action Sketch

```typescript
twinsCmd
  .command('start')
  .description('Start all discovered twin definitions via Docker Compose')
  .action(async () => {
    try {
      const projectDir = process.cwd()
      const twinsDir = path.join(projectDir, '.substrate', 'twins')

      const registry = createTwinRegistry()
      try {
        await registry.discover(twinsDir)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
        return
      }

      const twins = registry.list()
      if (twins.length === 0) {
        process.stderr.write(`No twin definitions found in .substrate/twins/\n`)
        process.exit(1)
        return
      }

      const eventBus = new TypedEventBusImpl<FactoryEvents>()
      eventBus.on('twin:started', (e) => {
        process.stdout.write(`  Started: ${e.twinName}\n`)
      })

      const manager = createTwinManager(eventBus)
      try {
        await manager.start(twins)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        process.stderr.write(`Error: ${msg}\n`)
        process.exit(1)
        return
      }

      const composeDir = manager.getComposeDir()!
      await writeRunState(projectDir, {
        composeDir,
        twinNames: twins.map((t) => t.name),
        startedAt: new Date().toISOString(),
      })

      process.stdout.write('\nAll twins started successfully.\n')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
      process.exit(1)
    }
  })
```

### `twins stop` Action Sketch

```typescript
twinsCmd
  .command('stop')
  .description('Stop all running twins')
  .action(async () => {
    try {
      const projectDir = process.cwd()
      const state = await readRunState(projectDir)

      if (!state) {
        process.stderr.write('No twins are currently running\n')
        process.exit(1)
        return
      }

      try {
        execSync('docker compose down --remove-orphans', {
          cwd: state.composeDir,
          stdio: 'pipe',
        })
      } catch {
        // Best-effort shutdown; still clean up
      }

      rmSync(state.composeDir, { recursive: true, force: true })
      await clearRunState(projectDir)

      process.stdout.write(`Stopped twins: ${state.twinNames.join(', ')}\n`)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`Error: ${msg}\n`)
      process.exit(1)
    }
  })
```

### Testing Requirements
- **Framework**: vitest — `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
- **Mock strategy for run-state tests**: `vi.mock('node:fs/promises', ...)` to inject spy implementations for `readFile`, `writeFile`, `unlink`, `mkdir`
- **Mock strategy for CLI tests**: `vi.mock('../twins/index.js', ...)` to mock `createTwinRegistry` and `createTwinManager`; `vi.mock('node:child_process', ...)` to mock `execSync`; `vi.mock('node:fs', ...)` to mock `rmSync`
- **Do NOT** test via `execSync('substrate factory twins ...')` subprocess calls — invoke the action handler logic directly through extracted helper functions or by calling the registered Commander action in-process
- **Preferred test pattern**: extract CLI action logic into small async functions (e.g., `startTwinsAction(projectDir)`) that can be imported and tested directly without Commander overhead
- Run `npm run test:fast` with `timeout: 300000`; never pipe output; confirm "Test Files" summary line in output
- Minimum 14 test cases across both new test files

### Alignment Note: `factory-command.ts` JSDoc Update

Update the file-level JSDoc subcommand tree comment to:
```typescript
/**
 * ...
 *     twins
 *       templates         — list available built-in twin templates
 *       init --template   — initialize a twin definition file from a template
 *       start             — start all discovered twins via Docker Compose
 *       stop              — stop all running twins and clean up
 *       status            — show each twin's name, status, and port mappings
 *       list              — list all discovered twin definitions
 * ...
 * Story 44-8 (scenarios), Story 44-9 (factory run), Story 46-7 (validate),
 * Story 47-4 (twins init/templates), Story 47-5 (twins lifecycle).
 */
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 47 — Digital Twin Foundation
