# Story 44-8: `substrate factory scenarios` CLI Commands

## Story

As a factory pipeline operator,
I want `substrate factory scenarios list` and `substrate factory scenarios run` commands,
so that I can inspect discovered scenario files (with their integrity checksums) and execute validation scenarios directly from the CLI without invoking the full factory pipeline.

## Acceptance Criteria

### AC1: `substrate factory scenarios list` displays each scenario's name and checksum
**Given** `.substrate/scenarios/` contains two valid scenario files
**When** `substrate factory scenarios list` is invoked from the project root
**Then** it prints each scenario's filename and SHA-256 checksum (one per line, tab-separated) and exits with code 0

### AC2: `substrate factory scenarios list` handles empty or missing scenario directory gracefully
**Given** `.substrate/scenarios/` does not exist or contains no files matching `scenario-*.{sh,py,js,ts}`
**When** `substrate factory scenarios list` is invoked
**Then** it prints `No scenarios found in .substrate/scenarios/` and exits with code 0

### AC3: `substrate factory scenarios run` displays a human-readable summary
**Given** `.substrate/scenarios/` contains at least one passing and one failing scenario
**When** `substrate factory scenarios run` is invoked (without `--format`)
**Then** it prints a summary line `Scenarios: X passed, Y failed, Z total` followed by per-scenario `[PASS]`/`[FAIL]` lines and exits with code 0

### AC4: `substrate factory scenarios run --format json` emits `ScenarioRunResult` JSON to stdout
**Given** `.substrate/scenarios/` contains scenario files
**When** `substrate factory scenarios run --format json` is invoked
**Then** it writes a single-line JSON object to stdout with `.scenarios[]`, `.summary.{total,passed,failed}`, and `.durationMs` fields, and exits with code 0

### AC5: `substrate factory` command group is registered in the CLI
**Given** the `substrate` CLI binary is invoked
**When** `substrate factory --help` is run
**Then** the output lists `factory` as a known command with `scenarios` shown as a subcommand group

### AC6: `registerFactoryCommand` is exported from `@substrate-ai/factory` public API
**Given** a consumer imports from `@substrate-ai/factory`
**When** they call `registerFactoryCommand(program)` with a Commander `Command` object
**Then** it registers `factory scenarios list` and `factory scenarios run [--format json|text]` subcommands on `program` without throwing

### AC7: Existing `substrate scenarios run` top-level command is not broken
**Given** the `substrate scenarios` command was registered by story 44-5
**When** `substrate scenarios run` is invoked after this story is implemented
**Then** it still executes all scenarios and prints results exactly as before (backward compatibility)

## Tasks / Subtasks

- [ ] Task 1: Add `list` subcommand to `registerScenariosCommand` (AC: #1, #2)
  - [ ] Open `packages/factory/src/scenarios/cli-command.ts`
  - [ ] Below the existing `scenariosCmd.command('run')` block, add `scenariosCmd.command('list')`
  - [ ] In the `list` action: call `const store = new ScenarioStore()` and `const manifest = await store.discover(process.cwd())`
  - [ ] If `manifest.scenarios.length === 0`, call `console.log('No scenarios found in .substrate/scenarios/')` and return
  - [ ] Otherwise, for each `entry` in `manifest.scenarios`, call `console.log(\`${entry.name}\t${entry.checksum}\`)`
  - [ ] Verify the action is async and properly awaited

- [ ] Task 2: Create `packages/factory/src/factory-command.ts` with `registerFactoryCommand` (AC: #5, #6)
  - [ ] Create `packages/factory/src/factory-command.ts`
  - [ ] Import `type { Command } from 'commander'`
  - [ ] Import `{ registerScenariosCommand } from './scenarios/cli-command.js'`
  - [ ] Export `registerFactoryCommand(program: Command): void`
  - [ ] In the function body:
    - [ ] Create: `const factoryCmd = program.command('factory').description('Factory pipeline and scenario management commands')`
    - [ ] Register: `registerScenariosCommand(factoryCmd)` — this attaches `scenarios list` and `scenarios run` under `factory`

- [ ] Task 3: Export `registerFactoryCommand` from factory package public API (AC: #6)
  - [ ] Open `packages/factory/src/index.ts`
  - [ ] Add a line: `export { registerFactoryCommand } from './factory-command.js'`
  - [ ] Place it after the existing scenarios export block with comment `// Factory CLI command group (story 44-8)`

- [ ] Task 4: Create `src/cli/commands/factory.ts` thin re-export (AC: #5)
  - [ ] Create `src/cli/commands/factory.ts`
  - [ ] Content: a JSDoc comment referencing story 44-8 and a single re-export line:
    ```typescript
    export { registerFactoryCommand } from '@substrate-ai/factory'
    ```

- [ ] Task 5: Register `substrate factory` in the main CLI entry point (AC: #5, #7)
  - [ ] Open `src/cli/index.ts`
  - [ ] Add import: `import { registerFactoryCommand } from './commands/factory.js'`
  - [ ] In `createProgram()`, after the existing `registerScenariosCommand(program)` call, add:
    ```typescript
    // Factory command group — scenarios list/run + future factory run (Epic 44, story 44-8)
    registerFactoryCommand(program)
    ```
  - [ ] Confirm `registerScenariosCommand(program)` call from story 44-5 is NOT removed (AC7)

- [ ] Task 6: Write unit tests for the new CLI behaviour (AC: #1–#4, #6)
  - [ ] Create `packages/factory/src/scenarios/__tests__/cli-command-list.test.ts`
  - [ ] Import `{ describe, it, expect, vi, beforeEach, afterEach }` from `'vitest'`
  - [ ] Import `{ Command }` from `'commander'` and `{ registerScenariosCommand }` from `'../cli-command.js'`
  - [ ] Mock `ScenarioStore` via `vi.mock('../store.js', ...)` using `vi.fn()` for `discover`
  - [ ] Mock `createScenarioRunner` via `vi.mock('../runner.js', ...)` returning a runner with a mock `run`
  - [ ] Helper `captureConsoleLog()`: spy on `console.log` with `vi.spyOn`, restore in `afterEach`
  - [ ] Helper `runCmd(args: string[])`: create `new Command()`, call `registerScenariosCommand(cmd)`, then `await cmd.parseAsync(['node', 'scenarios', ...args])`
  - [ ] **Test AC1**: `discover` returns 2 entries `[{name:'scenario-a.sh', checksum:'abc'}, ...]` → stdout contains `'scenario-a.sh\tabc'`
  - [ ] **Test AC2**: `discover` returns `{ scenarios: [], capturedAt: 0 }` → stdout contains `'No scenarios found in .substrate/scenarios/'`
  - [ ] **Test AC3**: `run` returns `{ summary: {total:2, passed:1, failed:1}, scenarios: [{name:'s.sh', status:'pass', ...}, {name:'f.sh', status:'fail', stderr:'err', ...}], durationMs:10 }` → stdout contains `'Scenarios: 1 passed, 1 failed, 2 total'` and `'[PASS] s.sh'` and `'[FAIL] f.sh'`
  - [ ] **Test AC4**: `run` with `--format json` → `console.log` called with a string that parses as valid JSON containing `.summary.total`
  - [ ] Create `packages/factory/src/factory-command.test.ts`
  - [ ] **Test AC6**: import `{ registerFactoryCommand }` from `'./factory-command.js'`, call `registerFactoryCommand(new Command())` — verify no throw and that `program.commands` includes a command named `'factory'`

- [ ] Task 7: Build and validate (AC: #1–#7)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" line in output, no regressions
  - [ ] Confirm `registerFactoryCommand` is importable from `@substrate-ai/factory`
  - [ ] Confirm `registerScenariosCommand` still works as a standalone top-level command (AC7 regression check)

## Dev Notes

### Architecture Constraints

- **New files:**
  - `packages/factory/src/factory-command.ts` — `registerFactoryCommand` implementation
  - `packages/factory/src/factory-command.test.ts` — tests for factory command registration
  - `packages/factory/src/scenarios/__tests__/cli-command-list.test.ts` — list subcommand tests
  - `src/cli/commands/factory.ts` — thin CLI re-export

- **Modified files:**
  - `packages/factory/src/scenarios/cli-command.ts` — add `list` subcommand
  - `packages/factory/src/index.ts` — re-export `registerFactoryCommand`
  - `src/cli/index.ts` — import and register `registerFactoryCommand`

- **Import style:** All relative imports within the factory package use `.js` extensions (ESM). Example: `import { registerScenariosCommand } from './scenarios/cli-command.js'`

- **Do NOT remove the top-level `registerScenariosCommand(program)` call** in `src/cli/index.ts` — the `substrate scenarios run` path (established in story 44-5) must remain intact for AC7.

- **Do NOT re-implement scenario discovery or runner logic** — `registerScenariosCommand` already encapsulates the `run` behaviour from story 44-5. The `list` subcommand is the only net-new scenario behaviour.

### registerFactoryCommand Implementation Pattern

```typescript
// packages/factory/src/factory-command.ts

import type { Command } from 'commander'
import { registerScenariosCommand } from './scenarios/cli-command.js'

/**
 * Register the `factory` command group on the provided Commander program.
 *
 * Subcommand tree:
 *   factory
 *     scenarios
 *       list              — list discovered scenario files with SHA-256 checksums
 *       run [--format]    — execute all scenarios; text summary or JSON output
 *
 * Future story 44-9 will extend this with `factory run --graph <file>`.
 *
 * Story 44-8.
 */
export function registerFactoryCommand(program: Command): void {
  const factoryCmd = program
    .command('factory')
    .description('Factory pipeline and scenario management commands')

  registerScenariosCommand(factoryCmd)
}
```

### list Subcommand Implementation Pattern

Add inside `registerScenariosCommand`, after the `run` command block:

```typescript
scenariosCmd
  .command('list')
  .description('List discovered scenario files with SHA-256 checksums')
  .action(async () => {
    const store = new ScenarioStore()
    const manifest = await store.discover(process.cwd())

    if (manifest.scenarios.length === 0) {
      console.log('No scenarios found in .substrate/scenarios/')
      return
    }

    for (const entry of manifest.scenarios) {
      console.log(`${entry.name}\t${entry.checksum}`)
    }
  })
```

### CLI Command Structure After This Story

```
substrate scenarios run [--format json|text]          # top-level from story 44-5
substrate factory scenarios list                       # NEW — story 44-8
substrate factory scenarios run [--format json|text]   # NEW — story 44-8
substrate factory run --graph <file>                   # future — story 44-9
```

The `substrate factory` command group is intentionally sparse after this story (only `scenarios` subcommand). Story 44-9 extends it with `run`.

### Commander Testing Pattern

```typescript
import { Command } from 'commander'
import { registerScenariosCommand } from '../cli-command.js'

async function runCmd(args: string[]) {
  const cmd = new Command()
  cmd.exitOverride() // prevent process.exit in tests
  registerScenariosCommand(cmd)
  await cmd.parseAsync(['node', 'scenarios', ...args])
}
```

Using `.exitOverride()` prevents `commander` from calling `process.exit()` on help/error, keeping tests clean.

### Mocking ScenarioStore in Tests

```typescript
import { vi } from 'vitest'

vi.mock('../store.js', () => ({
  ScenarioStore: vi.fn().mockImplementation(() => ({
    discover: vi.fn().mockResolvedValue({
      scenarios: [
        { name: 'scenario-a.sh', path: '/abs/path/scenario-a.sh', checksum: 'abc123' },
      ],
      capturedAt: Date.now(),
    }),
  })),
}))
```

### Testing Requirements

- **Framework:** Vitest — `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
- **console.log mocking:** `const spy = vi.spyOn(console, 'log').mockImplementation(() => {})` — restore with `spy.mockRestore()` in `afterEach`
- **No filesystem I/O in tests** — mock `ScenarioStore.discover` and `createScenarioRunner` entirely
- **Test count target:** ≥5 tests in `cli-command-list.test.ts` + ≥2 in `factory-command.test.ts`
- **Run tests:** `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line; never pipe output

### Dependency Chain

- **Depends on:** 44-1 (`ScenarioStore.discover()` — already in `store.ts`)
- **Depends on:** 44-2 (`createScenarioRunner`, `ScenarioRunResult` — already in `runner.ts`)
- **Depends on:** 44-5 (`registerScenariosCommand` — already in `cli-command.ts`; extended here with `list`)
- **Unblocks:** 44-9 (`substrate factory run --graph` — extends the same `factoryCmd` returned from `registerFactoryCommand` or separately registered)
- **Unblocks:** 44-10 (integration test — validates end-to-end scenario validation flow including CLI)

## Interface Contracts

- **Export**: `registerFactoryCommand(program: Command): void` @ `packages/factory/src/factory-command.ts` (consumed by `src/cli/commands/factory.ts` and story 44-9)
- **Import**: `registerScenariosCommand` @ `packages/factory/src/scenarios/cli-command.ts` (from story 44-5)
- **Import**: `ScenarioStore` @ `packages/factory/src/scenarios/store.ts` (from story 44-1)

## Dev Agent Record

### Agent Model Used
claude-opus-4-5

### Completion Notes List
- `packages/factory/src/scenarios/cli-command.ts` was created as a **new file** in this story. Despite Task 1 describing it as an existing file to modify (from story 44-5), story 44-5 left both the `cli-command.ts` creation and the top-level CLI registration incomplete. This story bundled both the story 44-5 scope (full `cli-command.ts` with `run` subcommand) and the story 44-8 scope (`list` subcommand) into one delivery.
- `registerScenariosCommand(program)` in `src/cli/index.ts` was added as a **net-new registration** (not an edit to a pre-existing call), confirming story 44-5 did not complete the top-level CLI wiring. Both the `registerScenariosCommand(program)` call (top-level, line 151) and the `registerFactoryCommand(program)` call (line 154) are new in this story.
- `packages/factory/src/scenarios/index.ts` already contained `export { registerScenariosCommand } from './cli-command.js'` (line 13) — the review's Issue 1 concern was already resolved in the initial implementation.
- AC7 backward compatibility test added to `cli-command-list.test.ts` (review fix cycle): verifies that dual registration of `registerScenariosCommand` (top-level + under factory) does not break the top-level `scenarios run` path.

### File List
- packages/factory/src/scenarios/cli-command.ts (new — created here; story 44-5 scope bundled)
- packages/factory/src/factory-command.ts (new)
- packages/factory/src/factory-command.test.ts (new)
- packages/factory/src/scenarios/__tests__/cli-command-list.test.ts (new)
- packages/factory/src/index.ts (modified — added registerFactoryCommand export)
- packages/factory/src/scenarios/index.ts (verified existing — registerScenariosCommand already exported)
- src/cli/commands/factory.ts (new)
- src/cli/commands/scenarios.ts (new — created here; story 44-5 scope bundled)
- src/cli/index.ts (modified — added registerScenariosCommand + registerFactoryCommand registrations)

## Change Log

- 2026-03-23: Story created for Epic 44, Phase B — Scenario Store + Runner
