# Story 44-9: Factory Config Schema and `substrate factory run` Command

## Story

As a factory pipeline operator,
I want a validated `FactoryConfigSchema` and a `substrate factory run` CLI command,
so that I can define factory pipeline settings in `config.yaml` and execute a DOT graph pipeline from the command line with full event visibility.

## Acceptance Criteria

### AC1: `FactoryConfigSchema` validates all documented fields with defaults
**Given** a `config.yaml` with a `factory:` section containing `graph`, `scenario_dir`, `satisfaction_threshold`, `budget_cap_usd`, `wall_clock_cap_seconds`, `plateau_window`, `plateau_threshold`, and `backend`
**When** the YAML is loaded and the `factory` section is parsed through `FactoryConfigSchema`
**Then** all fields validate successfully, enum and range constraints are enforced (`satisfaction_threshold` ∈ [0,1], `backend` ∈ `['cli','direct']`), and missing optional fields default to their specified values (`scenario_dir='.substrate/scenarios/'`, `satisfaction_threshold=0.8`, `budget_cap_usd=0`, `wall_clock_cap_seconds=0`, `plateau_window=3`, `plateau_threshold=0.05`, `backend='cli'`)

### AC2: `FactoryExtendedConfigSchema` extends `SubstrateConfigSchema` with optional `factory` key
**Given** a `config.yaml` that includes both core substrate fields and a `factory:` section
**When** the full file is parsed through `FactoryExtendedConfigSchema`
**Then** core fields validate normally, the `factory` key is validated by `FactoryConfigSchema`, and an absent `factory` key results in `undefined` (not an error)

### AC3: `loadFactoryConfig` reads `config.yaml` and returns parsed `FactoryExtendedConfig`
**Given** a project directory containing a valid `config.yaml` at `.substrate/config.yaml`
**When** `loadFactoryConfig(projectDir)` is called
**Then** it reads the file, parses YAML, validates against `FactoryExtendedConfigSchema`, and returns the typed `FactoryExtendedConfig` object with all defaults applied

### AC4: `substrate factory run --graph pipeline.dot` parses and executes the graph
**Given** a valid DOT file `pipeline.dot` in the working directory
**When** `substrate factory run --graph pipeline.dot` is invoked
**Then** it reads the DOT file, parses it via `parseGraph`, validates via `createValidator`, creates a `GraphExecutor` with a `RunStateManager` and default handler registry, and begins execution, printing at minimum a start confirmation to stdout

### AC5: `substrate factory run` without `--graph` falls back to `factory.graph` in config
**Given** no `--graph` flag is provided, but `config.yaml` contains `factory.graph: "pipeline.dot"`
**When** `substrate factory run` is invoked from the project directory
**Then** it reads the graph path from config and executes the graph file as if `--graph pipeline.dot` had been specified

### AC6: `substrate factory run` exits with a clear error when no graph file is found
**Given** no `--graph` flag is provided and either no `config.yaml` exists or it contains no `factory.graph` key
**When** `substrate factory run` is invoked
**Then** it prints `Error: No graph file specified` to stderr and exits with a non-zero exit code

### AC7: `--events` flag emits NDJSON events to stdout during factory run
**Given** `substrate factory run --graph pipeline.dot --events` is invoked with a valid graph
**When** the graph executor processes nodes
**Then** each emitted `FactoryEvent` is serialized as a single-line JSON object and written to stdout, one event per line, compatible with the existing NDJSON event protocol used by `substrate run --events`

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/config.ts` with `FactoryConfigSchema` and `FactoryExtendedConfigSchema` (AC: #1, #2, #3)
  - [ ] Create `packages/factory/src/config.ts`
  - [ ] Import `z` from `'zod'` and `SubstrateConfigSchema` from `'@substrate-ai/core'`
  - [ ] Define and export `FactoryConfigSchema` as a strict Zod object with all 8 fields per architecture section 10.1: `graph` (string, optional), `scenario_dir` (string, default `.substrate/scenarios/`), `satisfaction_threshold` (number 0–1, default 0.8), `budget_cap_usd` (number ≥0, default 0), `wall_clock_cap_seconds` (number ≥0, default 0), `plateau_window` (int ≥2, default 3), `plateau_threshold` (number 0–1, default 0.05), `backend` (enum `['cli','direct']`, default `'cli'`)
  - [ ] Export `type FactoryConfig = z.infer<typeof FactoryConfigSchema>`
  - [ ] Define and export `FactoryExtendedConfigSchema = SubstrateConfigSchema.extend({ factory: FactoryConfigSchema.optional() })`
  - [ ] Export `type FactoryExtendedConfig = z.infer<typeof FactoryExtendedConfigSchema>`
  - [ ] Implement and export `async function loadFactoryConfig(projectDir: string): Promise<FactoryExtendedConfig>`:
    - [ ] Try `.substrate/config.yaml` relative to `projectDir`, then `config.yaml` in `projectDir`
    - [ ] Read file with `readFile`, parse YAML with `js-yaml`
    - [ ] Validate with `FactoryExtendedConfigSchema.parse()` and return result
    - [ ] If no config file found, return `FactoryExtendedConfigSchema.parse({ config_format_version: '1', global: {}, providers: {} })` (all defaults)

- [ ] Task 2: Export config symbols from `packages/factory/src/index.ts` (AC: #1, #2, #3)
  - [ ] Open `packages/factory/src/index.ts`
  - [ ] Add after the factory CLI export block: `// Factory config schema (story 44-9)` followed by `export { FactoryConfigSchema, FactoryExtendedConfigSchema, loadFactoryConfig } from './config.js'`
  - [ ] Add `export type { FactoryConfig, FactoryExtendedConfig } from './config.js'`

- [ ] Task 3: Implement `registerFactoryRunCommand` in `packages/factory/src/factory-command.ts` (AC: #4, #5, #6, #7)
  - [ ] Open `packages/factory/src/factory-command.ts`
  - [ ] Add imports: `readFile` from `'node:fs/promises'`, `path` from `'node:path'`, `{ randomUUID }` from `'node:crypto'`
  - [ ] Add imports: `{ parseGraph }` from `'./graph/parser.js'`, `{ createValidator }` from `'./graph/validator.js'`, `{ createGraphExecutor }` from `'./graph/executor.js'`, `{ createDefaultRegistry }` from `'./handlers/index.js'`, `{ RunStateManager }` from `'./graph/run-state.js'`, `{ loadFactoryConfig }` from `'./config.js'`
  - [ ] Add import for event bus: `{ TypedEventBusImpl }` from `'@substrate-ai/core'` and `type { FactoryEvents }` from `'./events.js'`
  - [ ] Implement `async function resolveGraphPath(opts: { graph?: string }, projectDir: string): Promise<string | null>` that checks CLI `--graph` first, then `config.factory.graph`, then returns `null`
  - [ ] In `registerFactoryCommand`, after `registerScenariosCommand(factoryCmd)`, add a `run` subcommand:
    - `.option('--graph <path>', 'Path to DOT graph file')`
    - `.option('--events', 'Emit NDJSON events to stdout')`
    - `.option('--config <path>', 'Path to config.yaml (default: auto-detect)')`
  - [ ] In the `run` action: call `resolveGraphPath`, exit with error if null, read DOT file, call `parseGraph`, call `createValidator().validate(graph)`, construct `RunStateManager`, construct `GraphExecutor` via `createGraphExecutor`, call `executor.run(graph)`, handle `--events` by attaching event bus listeners that write `JSON.stringify(event)` to stdout
  - [ ] Error handling: wrap in try/catch, print `Error: <message>` to stderr and `process.exit(1)` on failure

- [ ] Task 4: Write unit tests for `FactoryConfigSchema` and `loadFactoryConfig` (AC: #1, #2, #3)
  - [ ] Create `packages/factory/src/__tests__/config.test.ts`
  - [ ] Import `{ describe, it, expect, vi, beforeEach }` from `'vitest'`
  - [ ] Import `{ FactoryConfigSchema, FactoryExtendedConfigSchema, loadFactoryConfig }` from `'../config.js'`
  - [ ] **Test AC1a** — all fields with explicit values parse correctly and equal provided values
  - [ ] **Test AC1b** — empty object `{}` applies all defaults (check each of 7 defaulted fields)
  - [ ] **Test AC1c** — invalid `satisfaction_threshold: 1.5` throws ZodError
  - [ ] **Test AC1d** — invalid `backend: 'invalid'` throws ZodError
  - [ ] **Test AC1e** — invalid `plateau_window: 1` (below min 2) throws ZodError
  - [ ] **Test AC2a** — `FactoryExtendedConfigSchema.parse({ config_format_version: '1', global: {}, providers: {} })` succeeds with `factory: undefined`
  - [ ] **Test AC2b** — extended schema with `factory: { satisfaction_threshold: 0.9 }` parses with correct factory defaults
  - [ ] **Test AC3** — mock `fs/promises.readFile` and `js-yaml.load`, verify `loadFactoryConfig` returns a validated config object; verify it falls back to second path if first is not found; verify it returns all-defaults config when no file found
  - [ ] Aim for ≥10 test cases in this file

- [ ] Task 5: Write unit tests for `substrate factory run` command action (AC: #4, #5, #6, #7)
  - [ ] Create `packages/factory/src/__tests__/factory-run-command.test.ts`
  - [ ] Import `{ describe, it, expect, vi, beforeEach, afterEach }` from `'vitest'`
  - [ ] Mock `'../graph/parser.js'`, `'../graph/validator.js'`, `'../graph/executor.js'`, `'../config.js'`, `'node:fs/promises'`
  - [ ] Use `new Command()` + `registerFactoryCommand(cmd)` + `cmd.parseAsync(['node', 'factory', 'run', ...args])` pattern with `.exitOverride()`
  - [ ] **Test AC4** — `--graph pipeline.dot` with mocked parser/executor runs without throwing
  - [ ] **Test AC5** — no `--graph` flag, config returns `factory.graph = 'pipeline.dot'`, executor runs with that path
  - [ ] **Test AC6** — no `--graph`, config returns no `factory.graph`, `process.stderr.write` captures "No graph file specified" and `process.exit` called with 1
  - [ ] **Test AC7** — `--events` flag causes event bus listeners to write JSON lines to stdout spy
  - [ ] Aim for ≥6 test cases

- [ ] Task 6: Build and validate (AC: #1–#7)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line appears, no regressions
  - [ ] Confirm `FactoryConfigSchema` is importable from `@substrate-ai/factory`
  - [ ] Confirm `substrate factory run --help` shows `--graph`, `--events`, `--config` options
  - [ ] Confirm `substrate factory scenarios list` still works (AC7 regression: 44-8 backward compat)

## Dev Notes

### Architecture Constraints

- **New files:**
  - `packages/factory/src/config.ts` — `FactoryConfigSchema`, `FactoryExtendedConfigSchema`, `loadFactoryConfig`
  - `packages/factory/src/__tests__/config.test.ts` — schema and loader tests
  - `packages/factory/src/__tests__/factory-run-command.test.ts` — CLI command tests

- **Modified files:**
  - `packages/factory/src/factory-command.ts` — add `run` subcommand with `--graph`, `--events`, `--config` options
  - `packages/factory/src/index.ts` — export config schema, types, and loader

- **Import style:** All relative imports within the factory package use `.js` extensions (ESM). Example: `import { loadFactoryConfig } from './config.js'`

- **YAML parsing:** Use `js-yaml` (already a project dependency, used in `src/cli/commands/config.ts` and `init.ts`). Import: `import yaml from 'js-yaml'`

- **Do NOT remove existing factory command registrations** from `registerFactoryCommand` — the `scenarios` subcommand from story 44-8 must remain intact

- **Do NOT import from `@substrate-ai/sdlc`** — factory package may only import from `@substrate-ai/core` (enforced by TypeScript project references)

### `FactoryConfigSchema` Reference (Architecture Section 10.1)

```typescript
// packages/factory/src/config.ts
import { z } from 'zod'
import { SubstrateConfigSchema } from '@substrate-ai/core'

export const FactoryConfigSchema = z.object({
  graph: z.string().optional(),
  scenario_dir: z.string().default('.substrate/scenarios/'),
  satisfaction_threshold: z.number().min(0).max(1).default(0.8),
  budget_cap_usd: z.number().min(0).default(0),
  wall_clock_cap_seconds: z.number().min(0).default(0),
  plateau_window: z.number().int().min(2).default(3),
  plateau_threshold: z.number().min(0).max(1).default(0.05),
  backend: z.enum(['cli', 'direct']).default('cli'),
}).strict()

export type FactoryConfig = z.infer<typeof FactoryConfigSchema>

export const FactoryExtendedConfigSchema = SubstrateConfigSchema.extend({
  factory: FactoryConfigSchema.optional(),
})

export type FactoryExtendedConfig = z.infer<typeof FactoryExtendedConfigSchema>
```

### `loadFactoryConfig` Config File Search Order (Architecture Section 11.3)

1. `.substrate/config.yaml` relative to `projectDir`
2. `config.yaml` relative to `projectDir`
3. Return all-defaults config if neither exists

### `substrate factory run` Graph File Resolution Order (Architecture Section 11.3)

1. `--graph <path>` CLI flag (explicit override)
2. `factory.graph` key in resolved config
3. `pipeline.dot` in `projectDir` (auto-detect fallback)
4. Error: `"No graph file specified"`

> **Note:** Architecture section 11.3 lists `pipeline.dot` auto-detection as step 3. Include this fallback so the story is consistent with the documented auto-detection chain.

### `registerFactoryCommand` Extension Pattern

Extend the existing function in `packages/factory/src/factory-command.ts`:

```typescript
export function registerFactoryCommand(program: Command): void {
  const factoryCmd = program
    .command('factory')
    .description('Factory pipeline and scenario management commands')

  registerScenariosCommand(factoryCmd) // story 44-8 — unchanged

  // Story 44-9: factory run
  factoryCmd
    .command('run')
    .description('Execute a DOT graph pipeline')
    .option('--graph <path>', 'Path to DOT graph file')
    .option('--config <path>', 'Path to config.yaml (default: auto-detect)')
    .option('--events', 'Emit NDJSON events to stdout')
    .action(async (opts) => {
      // ... implementation
    })
}
```

### NDJSON Event Emission Pattern

For `--events` flag, attach listeners to the event bus before calling `executor.run()`:

```typescript
const eventBus = new TypedEventBusImpl<FactoryEvents>()
if (opts.events) {
  // Listen to all relevant factory events and write as NDJSON
  const emit = (event: unknown) => process.stdout.write(JSON.stringify(event) + '\n')
  eventBus.on('graph:node-started', (e) => emit({ type: 'graph:node-started', ...e }))
  eventBus.on('graph:node-completed', (e) => emit({ type: 'graph:node-completed', ...e }))
  eventBus.on('graph:run-started', (e) => emit({ type: 'graph:run-started', ...e }))
  eventBus.on('graph:run-completed', (e) => emit({ type: 'graph:run-completed', ...e }))
}
```

### RunStateManager Wiring

```typescript
const runId = randomUUID()
const logsRoot = path.join(projectDir, '.substrate', 'runs', runId)
const stateManager = new RunStateManager({ runDir: logsRoot })

const executor = createGraphExecutor({
  runId,
  logsRoot,
  handlerRegistry: createDefaultRegistry(),
  eventBus,
  dotSource,  // raw DOT string read from file
})
```

### Testing Requirements

- **Framework:** Vitest — `import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'`
- **No filesystem I/O in unit tests** — mock `fs/promises.readFile` via `vi.mock('node:fs/promises', ...)`
- **Commander exit override:** Use `.exitOverride()` on `new Command()` to prevent `process.exit` during tests
- **console/stderr mocking:** `vi.spyOn(process.stderr, 'write').mockImplementation(() => true)` in tests that verify error messages
- **Run tests:** `npm run test:fast` with `timeout: 300000` — verify "Test Files" summary line; never pipe output
- **Test count target:** ≥10 tests in `config.test.ts` + ≥6 tests in `factory-run-command.test.ts`

### Dependency Chain

- **Depends on:** 42-14 (`GraphExecutor`, `GraphExecutorConfig`, `createGraphExecutor` — in `graph/executor.ts`)
- **Depends on:** 44-7 (`RunStateManager` — in `graph/run-state.ts`)
- **Depends on:** 44-8 (`registerFactoryCommand`, `registerScenariosCommand` — in `factory-command.ts`)
- **Depends on:** 44-1 (`ScenarioStore` — in `scenarios/store.ts`)
- **Unblocks:** 44-10 (integration test — validates end-to-end factory flow including CLI `factory run`)
- **Unblocks:** 45-x (convergence loop stories — consume `FactoryConfig` fields: `plateau_window`, `plateau_threshold`, `satisfaction_threshold`)

## Interface Contracts

- **Export**: `FactoryConfigSchema` @ `packages/factory/src/config.ts` (consumed by Epic 45 convergence loop stories)
- **Export**: `FactoryExtendedConfigSchema` @ `packages/factory/src/config.ts` (consumed by CLI composition root)
- **Export**: `loadFactoryConfig(projectDir: string): Promise<FactoryExtendedConfig>` @ `packages/factory/src/config.ts`
- **Export**: `type FactoryConfig` @ `packages/factory/src/config.ts`
- **Import**: `SubstrateConfigSchema` @ `@substrate-ai/core` (from Epic 40-41 core extraction)
- **Import**: `registerFactoryCommand` @ `packages/factory/src/factory-command.ts` (from story 44-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-23: Story created for Epic 44, Phase B — Factory Config Schema and CLI Run Command
