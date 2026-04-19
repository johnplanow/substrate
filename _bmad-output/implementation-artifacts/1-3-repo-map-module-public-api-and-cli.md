# Story 1-3: RepoMap Module Public API and CLI Command

Status: review

## Story

As a pipeline developer,
I want a `RepoMapModule` orchestration class with a clean public API and a `substrate repo-map` CLI command,
so that agents and developers can bootstrap, update, query, and inspect the repo-map symbol index through a consistent interface that other modules can depend on.

## Acceptance Criteria

### AC1: RepoMapModule Orchestration Class
**Given** concrete implementations of `ISymbolRepository`, `IRepoMapMetaRepository`, `ISymbolParser`, `IGitClient`, and `IRepoMapStorage` are wired at startup
**When** `RepoMapModule` is constructed via `createRepoMapModule(deps)` factory
**Then** the instance exposes: `update(projectRoot, opts?)`, `show(projectRoot)`, `query(projectRoot, filter)`, and `isStale(projectRoot)` methods; all dependencies are stored as private readonly fields and never re-instantiated after construction

### AC2: Update — Bootstrap or Incremental
**Given** a project root exists and a `RepoMapModule` instance is available
**When** `RepoMapModule.update(projectRoot, { force: false })` is called and the repo-map meta has a stored commit SHA
**Then** it calls `RepoMapStorage.incrementalUpdate(projectRoot, parser)` and logs `info` on completion; when `force: true` or meta is absent, it calls `RepoMapStorage.fullBootstrap(projectRoot, parser)` instead; both paths update `repo_map_meta` and resolve when storage confirms completion

### AC3: Show — Symbol Text Output
**Given** `repo_map_symbols` contains symbols from multiple files
**When** `RepoMapModule.show(projectRoot)` is called
**Then** it calls `ISymbolRepository.getSymbols()` with no filter, passes the result to `RepoMapGenerator.formatAsText(symbols, projectRoot)`, and returns the formatted string; an empty table returns an empty string without throwing

### AC4: Query — Filtered Symbol Lookup
**Given** `repo_map_symbols` contains symbols
**When** `RepoMapModule.query(projectRoot, { symbolName?, filePaths?, kinds?, limit? })` is called
**Then** it calls `ISymbolRepository.getSymbols({ filePaths, kinds })`, filters the result in-memory to entries whose `name` contains `symbolName` (case-insensitive, omitted means no name filter), truncates to `limit` (default 50), and returns `ParsedSymbol[]`

### AC5: CLI `substrate repo-map --update` Command
**Given** the user invokes `substrate repo-map --update [--force]` from a git repository root
**When** Commander.js parses the command
**Then** it calls `RepoMapModule.update(process.cwd(), { force })` and prints `Repo-map updated.` to stdout on success; on error it writes the error message to stderr and exits with code 1

### AC6: CLI `substrate repo-map --show` and `--query <symbol>` Commands
**Given** the repo-map has been bootstrapped
**When** `substrate repo-map --show` is invoked
**Then** the formatted text output is printed to stdout; when `substrate repo-map --query <symbol>` is invoked, `--output-format json` prints a JSON array of matching `ParsedSymbol` objects to stdout, default text format prints one `  <kind> <name>` line per result; invalid symbol names (not matching `/^[a-zA-Z0-9_]+$/`) are rejected with a stderr message and exit code 1

### AC7: Module Barrel and CLI Registration
**Given** the implementation is complete
**When** other modules import from `src/modules/repo-map/index.ts`
**Then** they can access: `RepoMapModule`, `IRepoMapModule`, `createRepoMapModule`, `ParsedSymbol`, `SymbolFilter`, `RepoMapMeta`, `ISymbolRepository`, `IRepoMapMetaRepository`, `IGitClient`; the CLI command file at `src/cli/commands/repo-map.ts` exports `registerRepoMapCommand(program: Command): void` and is called in `src/cli/index.ts` `registerAll()` function

## Interface Contracts

- **Export**: `IRepoMapModule` @ `src/modules/repo-map/interfaces.ts` (consumed by stories 1-6, 1-7)
- **Export**: `createRepoMapModule` @ `src/modules/repo-map/index.ts` (consumed by stories 1-5, 1-6)
- **Import**: `ISymbolRepository`, `IRepoMapMetaRepository`, `IGitClient`, `ISymbolParser`, `SymbolFilter`, `ParsedSymbol`, `RepoMapMeta` @ `src/modules/repo-map/interfaces.ts` (from stories 1-1, 1-2)
- **Import**: `RepoMapStorage` @ `src/modules/repo-map/storage.ts` (from story 1-2)
- **Import**: `RepoMapGenerator` @ `src/modules/repo-map/generator.ts` (from story 1-1)

## Tasks / Subtasks

- [x] Task 1: Define `IRepoMapModule` interface and add to `interfaces.ts` (AC: #1, #3, #4)
  - [x] Append to `src/modules/repo-map/interfaces.ts`: `UpdateOptions` interface `{ force?: boolean }`, `QueryFilter` interface `{ symbolName?: string; filePaths?: string[]; kinds?: SymbolKind[]; limit?: number }`
  - [x] Append `IRepoMapModule` interface with methods: `update(projectRoot: string, opts?: UpdateOptions): Promise<void>`, `show(projectRoot: string): Promise<string>`, `query(projectRoot: string, filter?: QueryFilter): Promise<ParsedSymbol[]>`, `isStale(projectRoot: string): Promise<boolean>`
  - [x] Re-export `IRepoMapModule`, `UpdateOptions`, `QueryFilter` from `src/modules/repo-map/index.ts`

- [x] Task 2: Implement `RepoMapModule` class (AC: #1, #2, #3, #4)
  - [x] Create `src/modules/repo-map/RepoMapModule.ts`; constructor accepts `{ storage: RepoMapStorage, symbolRepository: ISymbolRepository, symbolParser: ISymbolParser, generator: RepoMapGenerator, logger: ILogger }` stored as `private readonly` fields; create child logger with `{ component: 'repo-map:module' }`
  - [x] Implement `isStale(projectRoot)`: delegate to `this.storage.isStale(projectRoot)`, return boolean
  - [x] Implement `update(projectRoot, opts?)`: check `opts?.force` or `await this.storage.isStale(projectRoot)` returns true or meta is null → call `this.storage.fullBootstrap(projectRoot, this.symbolParser)`; else call `this.storage.incrementalUpdate(projectRoot, this.symbolParser)`; log `info` with `{ projectRoot, mode: 'bootstrap'|'incremental' }` on completion
  - [x] Implement `show(projectRoot)`: call `this.symbolRepository.getSymbols()`, return `this.generator.formatAsText(symbols, projectRoot)` (return `''` for empty array)
  - [x] Implement `query(projectRoot, filter?)`: call `this.symbolRepository.getSymbols({ filePaths: filter?.filePaths, kinds: filter?.kinds })`, filter by `symbolName` case-insensitively if provided, slice to `filter?.limit ?? 50`, return result

- [x] Task 3: Implement `createRepoMapModule` factory (AC: #1)
  - [x] Create `src/modules/repo-map/factory.ts` exporting `createRepoMapModule(deps: { client: DoltClient; gitClient?: IGitClient; logger: ILogger }): RepoMapModule`
  - [x] Factory instantiates: `GrammarLoader`, `SymbolParser`, `DoltSymbolRepository`, `DoltRepoMapMetaRepository`, `GitClient` (or use provided `gitClient`), `RepoMapStorage`, `RepoMapGenerator`, then `new RepoMapModule({ storage, symbolRepository, symbolParser, generator, logger })`
  - [x] Export `createRepoMapModule` from `src/modules/repo-map/index.ts`

- [x] Task 4: Implement CLI command file (AC: #5, #6)
  - [x] Create `src/cli/commands/repo-map.ts`; export `registerRepoMapCommand(program: Command): void`
  - [x] Register `program.command('repo-map')` with options: `--update`, `--force`, `--show`, `--query <symbol>`, `--output-format <format>` (choices: `text`, `json`; default: `text`)
  - [x] `--query <symbol>`: validate symbol with `/^[a-zA-Z0-9_]+$/`; on mismatch, print to stderr `Error: symbol name must match /^[a-zA-Z0-9_]+$/` and `process.exit(1)`; on valid, call `module.query(cwd, { symbolName: symbol })` and output results
  - [x] `--show`: call `module.show(cwd)`, print result to stdout
  - [x] `--update`: call `module.update(cwd, { force: !!opts.force })`; print `Repo-map updated.` on success
  - [x] All command actions catch errors: write `Error: ${err.message}` to stderr and `process.exit(1)`
  - [x] JSON output for `--query --output-format json`: `process.stdout.write(JSON.stringify(results, null, 2) + '\n')`; text output: one line per symbol `  <kind> <name>`

- [x] Task 5: Register CLI command in index.ts (AC: #7)
  - [x] Add `import { registerRepoMapCommand } from './commands/repo-map.js'` to `src/cli/index.ts` (after existing imports, in the internal-modules group)
  - [x] Call `registerRepoMapCommand(program)` inside the `registerAll(program)` function, following the pattern of all existing command registrations

- [x] Task 6: Update module barrel `src/modules/repo-map/index.ts` (AC: #7)
  - [x] Ensure all public exports are present: `RepoMapModule`, `createRepoMapModule`, `IRepoMapModule`, `UpdateOptions`, `QueryFilter`, `ParsedSymbol`, `SymbolFilter`, `RepoMapMeta`, `ISymbolRepository`, `IRepoMapMetaRepository`, `IGitClient`, `ISymbolParser`, `SymbolKind`
  - [x] No implementation files (e.g., `DoltSymbolRepository`, `GitClient`) exposed through the barrel — only interfaces and public classes/functions

- [x] Task 7: Unit tests for `RepoMapModule` (AC: #1, #2, #3, #4)
  - [x] Create `src/modules/repo-map/__tests__/RepoMapModule.test.ts`
  - [x] Inject in-memory stubs: `MockStorage` (tracks calls to `fullBootstrap`, `incrementalUpdate`, `isStale`), `MockSymbolRepository` (returns preset `ParsedSymbol[]`), mock `RepoMapGenerator` via `vi.fn()`
  - [x] Test `update` with `force: true` calls `fullBootstrap` regardless of staleness
  - [x] Test `update` with `force: false` and `isStale = true` calls `fullBootstrap`; with `isStale = false` calls `incrementalUpdate`
  - [x] Test `show` returns formatted string from generator; test empty symbols returns `''`
  - [x] Test `query` with `symbolName` filter is case-insensitive; test `limit` truncation; test empty `filePaths` returns all symbols up to limit

- [x] Task 8: Unit tests for CLI command (AC: #5, #6)
  - [x] Create `src/cli/commands/__tests__/repo-map.test.ts`
  - [x] Mock `createRepoMapModule` via `vi.mock('../../../modules/repo-map/index.js')` returning a stub `RepoMapModule`
  - [x] Test `--update` calls `module.update` and prints `Repo-map updated.` to stdout
  - [x] Test `--query invalidName!` prints error to stderr and exits with code 1 (use `vi.spyOn(process, 'exit')`)
  - [x] Test `--query validName --output-format json` prints valid JSON array to stdout
  - [x] Test `--show` prints formatted text output
  - [x] Test command-level error handling: `module.show` throws → stderr message + exit(1)

## Dev Notes

### File Paths
- `src/modules/repo-map/RepoMapModule.ts` — orchestration class (new)
- `src/modules/repo-map/factory.ts` — `createRepoMapModule` wiring (new)
- `src/modules/repo-map/interfaces.ts` — extend with `IRepoMapModule`, `UpdateOptions`, `QueryFilter` (append to existing file from stories 1-1, 1-2)
- `src/modules/repo-map/index.ts` — public barrel (update to add new exports)
- `src/cli/commands/repo-map.ts` — CLI command file (new)
- `src/cli/index.ts` — add import + `registerRepoMapCommand` call (append only)
- `src/modules/repo-map/__tests__/RepoMapModule.test.ts` — unit tests (new)
- `src/cli/commands/__tests__/repo-map.test.ts` — CLI unit tests (new)

### Architecture Constraints
- `RepoMapModule` takes only interfaces in its constructor — never concrete classes directly; `createRepoMapModule` factory is the single wiring point
- CLI command file (`repo-map.ts`) must import `createRepoMapModule` from `'../../../modules/repo-map/index.js'` (relative import, `.js` extension for ESM compatibility)
- `src/cli/index.ts` changes: add import in the internal-modules group (third group, after blank line); add `registerRepoMapCommand(program)` call — do NOT reorder existing calls
- `show` and `query` must not call git — they are pure read operations against Dolt; only `update` and `isStale` touch git via `RepoMapStorage`
- Symbol name validation regex is `/^[a-zA-Z0-9_]+$/` — enforce before any method call, not inside `query()`
- Import order in all new files: Node built-ins first, then third-party, then internal (relative paths); blank line between groups; no `console.log` anywhere
- Logger instances: `createLogger('repo-map:module')` in `RepoMapModule`, `createLogger('repo-map:cli')` in the CLI command file

### Dependency Chain (must exist from prior stories)
- `RepoMapStorage` class with `isStale`, `fullBootstrap`, `incrementalUpdate` — from story 1-2 (`src/modules/repo-map/storage.ts`)
- `ISymbolRepository.getSymbols(filter?)` — from story 1-2 (`src/modules/repo-map/interfaces.ts`)
- `RepoMapGenerator.formatAsText(symbols, projectRoot)` — from story 1-1 (`src/modules/repo-map/generator.ts`)
- `DoltSymbolRepository`, `DoltRepoMapMetaRepository` — from story 1-2 (`src/modules/repo-map/storage.ts`)
- `GrammarLoader`, `SymbolParser` — from story 1-1
- `GitClient` — from story 1-2 (`src/modules/repo-map/git-client.ts`)

### Testing Requirements
- Vitest (not Jest); use `vi.mock`, `vi.fn()`, `vi.spyOn` — never `jest.*`
- Unit tests mock all I/O: no real filesystem reads, no real Dolt connections, no real git subprocess calls
- For `process.exit` testing: `const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit') })`; wrap command invocation in `expect(...).rejects.toThrow('exit')` or use a try/catch
- 80% coverage threshold enforced — test files at `src/modules/repo-map/__tests__/` and `src/cli/commands/__tests__/`
- `vi.mock` for `createRepoMapModule` in CLI tests must be hoisted above imports using `vi.mock(...)` at top of test file (Vitest hoisting applies automatically)

### Output Format Examples
`--show` text output (from `RepoMapGenerator.formatAsText`):
```
src/modules/repo-map/RepoMapModule.ts
  class RepoMapModule
  function createRepoMapModule()
```

`--query foo --output-format json`:
```json
[
  { "name": "fooBar", "kind": "function", "filePath": "src/...", "lineNumber": 42, "signature": "(x: string)", "exported": true }
]
```

`--query foo` (text, default):
```
  function fooBar
  class FooFactory
```

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 8 tasks completed successfully
- 252 test files passed (5963 tests total), 0 failures
- Barrel exports updated to expose only public interfaces/classes (removed DoltSymbolRepository, DoltRepoMapMetaRepository, computeFileHash per story spec)
- `RepoMapModule` constructor uses `pino.Logger` directly (consistent with codebase pattern)
- CLI command uses dynamic imports for `DoltClient` and `resolveMainRepoRoot` to match lazy-load pattern

### File List
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/interfaces.ts (modified — added UpdateOptions, QueryFilter, IRepoMapModule)
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/RepoMapModule.ts (new)
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/factory.ts (new)
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/index.ts (modified — updated barrel exports)
- /home/jplanow/code/jplanow/substrate/src/cli/commands/repo-map.ts (new)
- /home/jplanow/code/jplanow/substrate/src/cli/index.ts (modified — added import and registration)
- /home/jplanow/code/jplanow/substrate/src/modules/repo-map/__tests__/RepoMapModule.test.ts (new)
- /home/jplanow/code/jplanow/substrate/src/cli/commands/__tests__/repo-map.test.ts (new)

## Change Log
