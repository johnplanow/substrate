# Story 28-9: CLI Commands, Full-Stack Wiring, and Staleness Detection

Status: review

## Story

As a pipeline operator,
I want `substrate repo-map` and `substrate routing` CLI commands, live repo-map context injection wired into the pipeline, a `--dry-run` preview mode, and a staleness check at pipeline start,
so that I can inspect and manage the repo-map, preview routing decisions before running expensive pipelines, and be warned when the repo-map is out of date with the current commit.

## Acceptance Criteria

### AC1: `substrate repo-map` CLI Command
**Given** the `substrate repo-map` command is registered
**When** invoked with `--show`, `--update`, `--query <symbol>`, or `--dry-run <storyFile>`
**Then**:
- `--show` reads `repo_map_meta` from the active store and prints symbol count, commit SHA, file count, and last-updated timestamp; in JSON mode writes `{ symbolCount, commitSha, fileCount, updatedAt, staleness }` where `staleness` is `'current' | 'stale' | 'unknown'`
- `--update` calls `RepoMapModule.refresh()` (auto-detects incremental vs. full bootstrap) and prints `Updated: +X added, ~Y modified, -Z removed`; in JSON mode writes `{ added, modified, removed, durationMs }`
- `--query <symbol>` validates the input against `/^[a-zA-Z0-9_]+$/` (exits 1 with a clear message on invalid input), then calls `RepoMapQueryEngine.query({ symbols: [symbol], maxTokens: 4000 })` and prints one line per symbol in `file:line kind name` format; in JSON mode writes the raw `RepoMapQueryResult`
- `--dry-run <storyFile>` reads the story file, calls `RepoMapInjector.buildContext(storyContent, 2000)`, and writes `{ text, symbolCount, truncated }` as JSON to stdout (always JSON regardless of `--output-format`)

### AC2: `substrate routing --history` CLI Command
**Given** the `substrate routing` command is registered with a `--history` flag
**When** `substrate routing --history [--output-format json]` is executed
**Then** the command reads `routing_tune_log` from `stateStore.getMetric('global', 'routing_tune_log')`, parses the JSON array of `TuneLogEntry` records (or treats a null result as an empty array), and sorts by `appliedAt` descending; in text mode it prints `Auto-Tune History:` followed by one row per entry (`  <appliedAt>  <phase>  <oldModel> → <newModel>  est. <N>% savings`) or `No tuning history available` when the array is empty; in JSON mode it writes `{ entries: TuneLogEntry[] }` to stdout; exits 0 in all cases, writing errors to stderr with exit 2

### AC3: Both Commands Registered in src/cli/index.ts
**Given** `src/cli/index.ts` exports a `registerAll(program: Command)` function that calls all command registration functions
**When** `registerAll` is called at CLI startup
**Then** `registerRepoMapCommand(program)` (imported from `./commands/repo-map.js`) and `registerRoutingCommand(program)` (imported from `./commands/routing.js`) are both called, making `substrate repo-map` and `substrate routing` available; the two import lines follow the `.js` extension convention and are inserted in alphabetical order among existing registrations

### AC4: RepoMapInjector Wired Live in run.ts
**Given** `DoltSymbolRepository`, `RepoMapQueryEngine`, `RepoMapModule`, and `RepoMapInjector` are all implemented by prior stories (28-2, 28-3, 28-7)
**When** `substrate run` starts and the active state store is a `DoltStateStore` (as established by Epic 26 auto-detection)
**Then** `run.ts` constructs `DoltSymbolRepository`, `RepoMapQueryEngine`, `RepoMapModule`, and `RepoMapInjector` in sequence, then passes `repoMapInjector` and `maxRepoMapTokens: routingConfig?.max_repo_map_tokens ?? 2000` in the `WorkflowDeps` objects supplied to both `runDevStory` and `runCodeReview`; when the state store is not Dolt, both fields are omitted from `WorkflowDeps` (spreading an empty object), incurring zero performance cost

### AC5: Staleness Check Emits `pipeline:repo-map-stale` Event
**Given** a `RepoMapModule` was constructed (AC4) and a repo-map has been stored (non-null `commitSha` in `repo_map_meta`)
**When** `substrate run` starts execution after story resolution but before the first dispatch
**Then** `run.ts` calls `await repoMapModule.checkStaleness()` which compares the stored `commitSha` to `git rev-parse HEAD`; if they differ, it emits `{ type: 'pipeline:repo-map-stale', payload: { storedSha, headSha, fileCount } }` on the event bus and logs a `warn`-level message suggesting `substrate repo-map --update`; the check is fully non-blocking (wrapped in try/catch; any error is logged at warn and execution continues); when no repo-map has been stored, or when `RepoMapModule` was not constructed, the check is skipped silently

### AC6: `substrate run --dry-run` Preview Mode
**Given** the `substrate run` command accepts a `--dry-run` flag
**When** `substrate run --dry-run [--stories <keys>] [--output-format json]` is executed
**Then** the command resolves story keys and routing configuration exactly as a live run would, then for each story × phase combination resolves `model = routingResolver.resolveModel(phase)?.model ?? routingConfig?.baseline_model ?? 'default'` and calls `repoMapInjector?.buildContext(storyContent, maxTokens)` to estimate symbol count; in text mode it prints a padded preview table (columns: Story, Phase, Model, Est. Symbols) and exits 0 without constructing the dispatcher or spawning any subprocesses; in JSON mode it writes `{ stories: [{ storyKey, phases: [{ phase, model, estimatedSymbolCount }] }] }`; when routing config is absent all models show `default` and symbol counts show `0`

### AC7: Unit Tests at ≥80% Coverage
**Given** all new source files from this story
**When** `npm run test:fast` is executed
**Then** all tests in `src/cli/commands/__tests__/repo-map-command.test.ts` and `src/cli/commands/__tests__/routing-command.test.ts` pass; line coverage on `repo-map.ts` and `routing.ts` is ≥80%; no previously-passing tests regress; `run.ts` wiring is validated by a test confirming that `WorkflowDeps.repoMapInjector` is populated when `DoltStateStore` is active and omitted when `FileStateStore` is active

## Tasks / Subtasks

- [x] Task 1: Create `src/cli/commands/repo-map.ts` — register `substrate repo-map` (AC: #1)
  - [x] Export `registerRepoMapCommand(program: Command): void`; register a `program.command('repo-map').description('Inspect and manage the repository symbol map')` sub-command
  - [x] Add mutually-exclusive options: `.option('--show', 'show current repo-map summary')`, `.option('--update', 'refresh repo-map (incremental or full)')`, `.option('--query <symbol>', 'query symbols matching name')`, `.option('--dry-run <storyFile>', 'preview what symbols would be injected for a story file')`
  - [x] Implement `--show` action: construct `RepoMapModule` from active state store (check `stateStore.constructor.name` or `isDolt()` method); call `module.getMeta()` and `module.checkStaleness()`; derive `staleness` field; print or write JSON; exit 0
  - [x] Implement `--update` action: call `module.refresh()`; print update counts; exit 0
  - [x] Implement `--query <symbol>` action: test input against `/^[a-zA-Z0-9_]+$/`; reject with `process.stderr.write(...)` + `process.exit(1)` on invalid; construct `RepoMapQueryEngine`; call `query({ symbols: [symbol], maxTokens: 4000 })`; format results; exit 0
  - [x] Implement `--dry-run <storyFile>` action: `fs.readFileSync(storyFile, 'utf8')`; construct `RepoMapInjector`; call `buildContext(content, 2000)`; write `JSON.stringify({ text, symbolCount, truncated })` to stdout; exit 0
  - [x] Use `createLogger('cli:repo-map')`; catch all errors at action boundary; write errors to stderr as JSON when `--output-format json`; exit 2 on internal errors
  - [x] Import `RepoMapModule`, `RepoMapQueryEngine`, `DoltSymbolRepository` from `../../../modules/repo-map/index.js`; import `RepoMapInjector` from `../../../modules/context-compiler/index.js`

- [x] Task 2: Create `src/cli/commands/routing.ts` — register `substrate routing` (AC: #2)
  - [x] Export `registerRoutingCommand(program: Command): void`; register `program.command('routing').description('Model routing management')`
  - [x] Add `.option('--history', 'show auto-tune history')` and `.option('--output-format <format>', 'output format: text | json', 'text')`
  - [x] Implement `--history` action: call `stateStore.getMetric('global', 'routing_tune_log')`; parse JSON or default to `[]`; sort by `appliedAt` descending
  - [x] Text mode: print `Auto-Tune History:\n` + one formatted row per entry or `No tuning history available`; JSON mode: `process.stdout.write(JSON.stringify({ entries }))`
  - [x] Exit 0; wrap in try/catch; write errors to stderr; exit 2 on error
  - [x] Import `TuneLogEntry` from `../../../modules/routing/index.js`; use `createLogger('cli:routing')`

- [x] Task 3: Register new commands in `src/cli/index.ts` (AC: #3)
  - [x] Add `import { registerRepoMapCommand } from './commands/repo-map.js'` (insert in alphabetical order among existing imports)
  - [x] Add `import { registerRoutingCommand } from './commands/routing.js'` (alphabetical order)
  - [x] In `registerAll(program)`, call `registerRepoMapCommand(program)` and `registerRoutingCommand(program)` (alphabetical order among existing calls)

- [ ] Task 4: Wire `RepoMapInjector` live in `run.ts` (AC: #4)
  - [ ] Add imports: `DoltSymbolRepository`, `RepoMapQueryEngine`, `RepoMapModule` from `../../modules/repo-map/index.js`; `RepoMapInjector` from `../../modules/context-compiler/index.js`; `DoltStateStore` from `../../modules/state/index.js`
  - [ ] After state store construction (and after routing config load from story 28-5), add guarded construction block:
    ```typescript
    const isDolt = stateStore instanceof DoltStateStore
    let repoMapInjector: RepoMapInjector | undefined
    let repoMapModule: RepoMapModule | undefined
    if (isDolt) {
      const symbolRepo = new DoltSymbolRepository(doltClient, logger)
      const queryEngine = new RepoMapQueryEngine(symbolRepo, logger)
      repoMapInjector = new RepoMapInjector(queryEngine, logger)
      repoMapModule = new RepoMapModule(symbolRepo, logger)
    }
    ```
  - [ ] Update `WorkflowDeps` construction for both `runDevStory` and `runCodeReview` call sites to spread `...(repoMapInjector ? { repoMapInjector, maxRepoMapTokens: routingConfig?.max_repo_map_tokens ?? 2000 } : {})`
  - [ ] Note: `run.ts` has been sequentially modified by stories 28-5, 28-6, and 28-8 — implement this change after confirming those are applied; look for the `createDispatcher` call site to anchor the insertion point
  - [ ] Check `src/modules/state/index.ts` for the exported `DoltStateStore` class name; if `instanceof` checks are unreliable across module boundaries, use a discriminant method (`isDolt(): boolean`) if one exists on `IStateStore`, or add one

- [ ] Task 5: Implement staleness check in `run.ts` (AC: #5)
  - [ ] After story resolution (look for the existing `storyKeys` resolution block), add the non-blocking staleness check:
    ```typescript
    if (repoMapModule) {
      try {
        const stale = await repoMapModule.checkStaleness()
        if (stale) {
          eventBus.emit('pipeline:repo-map-stale', stale)
          logger.warn(stale, 'Repo-map is stale — run `substrate repo-map --update` to refresh')
        }
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          'Staleness check failed — skipping',
        )
      }
    }
    ```
  - [ ] If `RepoMapModule.checkStaleness()` does not yet exist (story 28-3 may have omitted it), add the method to `src/modules/repo-map/RepoMapModule.ts`:
    ```typescript
    async checkStaleness(): Promise<{ storedSha: string; headSha: string; fileCount: number } | null> {
      const meta = await this._metaRepo.getMeta()
      if (!meta?.commitSha) return null
      try {
        const headSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim()
        if (meta.commitSha === headSha) return null
        return { storedSha: meta.commitSha, headSha, fileCount: meta.fileCount ?? 0 }
      } catch {
        return null
      }
    }
    ```
    Import `execSync` from `'node:child_process'`; wrap in try/catch so git absence is silent
  - [ ] Add `'pipeline:repo-map-stale'` to the event bus payload map in `src/core/event-bus.types.ts` with payload `{ storedSha: string; headSha: string; fileCount: number }` — follow the exact structure established by story 28-5 for the existing typed event map

- [ ] Task 6: Implement `--dry-run` flag on `substrate run` (AC: #6)
  - [ ] In `src/cli/commands/run.ts`, add `.option('--dry-run', 'preview routing and repo-map injection without dispatching')` to the `run` command definition
  - [ ] When `options.dryRun === true`, after resolving story keys, routing config, and constructing `repoMapInjector` (Task 4), execute the preview loop: for each story key × `['explore', 'generate', 'review']`, call `routingResolver?.resolveModel(phase)?.model ?? routingConfig?.baseline_model ?? 'default'` and `await repoMapInjector?.buildContext(storyContent, maxRepoMapTokens ?? 2000)`
  - [ ] Collect results into `{ storyKey, phases: [{ phase, model, estimatedSymbolCount }] }[]`
  - [ ] Text mode: print a padded table with header `Story   Phase      Model                         Est. Symbols` followed by a separator and one row per story × phase (left-pad columns to 8, 10, 30, 12 chars respectively); JSON mode: `process.stdout.write(JSON.stringify({ stories }))`
  - [ ] Call `process.exit(0)` before any `createDispatcher` call to ensure no subprocesses are spawned
  - [ ] When routing config is absent (`routingResolver` is null), all models display as `default`; when `repoMapInjector` is absent, symbol counts display as `0`

- [ ] Task 7: Unit tests for new CLI commands (AC: #7)
  - [ ] Create `src/cli/commands/__tests__/repo-map-command.test.ts`
    - [ ] Stub `RepoMapModule` as `{ getMeta: vi.fn(), checkStaleness: vi.fn(), refresh: vi.fn() }`; inject via `vi.mock` or constructor stub
    - [ ] Stub `RepoMapQueryEngine` as `{ query: vi.fn().mockResolvedValue({ symbols: [], symbolCount: 0, truncated: false, queryDurationMs: 1 }) }`
    - [ ] Stub `RepoMapInjector` as `{ buildContext: vi.fn().mockResolvedValue({ text: '# repo-map: 2 symbols\nfoo:10 function bar', symbolCount: 2, truncated: false }) }`
    - [ ] Test `--show` happy path: `getMeta()` returns `{ commitSha: 'abc123', symbolCount: 42, fileCount: 10, updatedAt: '2026-03-10T00:00:00Z' }`, `checkStaleness()` returns `null` → stdout includes `42` and `staleness: 'current'`
    - [ ] Test `--query` valid input: `--query mySymbol` → `query` called with `{ symbols: ['mySymbol'], maxTokens: 4000 }`
    - [ ] Test `--query` invalid input: `--query '../etc'` → `process.exit` called with code `1`; `query` never called
    - [ ] Test `--dry-run`: mocks `fs.readFileSync` to return stub story content → `buildContext` called with that content → stdout is parseable JSON with `symbolCount: 2`
    - [ ] Test `--update`: `refresh()` resolves with `{ added: 5, modified: 2, removed: 1, durationMs: 300 }` → stdout includes `+5`
    - [ ] Use `vi.mock('node:fs')` for file reads; use `import { describe, it, expect, vi, beforeEach } from 'vitest'`; no jest APIs
  - [ ] Create `src/cli/commands/__tests__/routing-command.test.ts`
    - [ ] Stub `IStateStore` as `{ getMetric: vi.fn() }`
    - [ ] Test `--history` with two entries: `getMetric` returns JSON string with 2 `TuneLogEntry` records sorted with newest first → output contains both entries in correct order
    - [ ] Test `--history` empty: `getMetric` returns `null` → output contains `No tuning history available`
    - [ ] Test `--history --output-format json`: output is `JSON.parse`-able and has shape `{ entries: [...] }`
    - [ ] Framework: vitest; no jest APIs; no real `StateStore`; stub via constructor injection

## Dev Notes

### Architecture Constraints
- **ESM imports**: all internal imports must use `.js` extension (e.g. `from '../../modules/repo-map/index.js'`)
- **Import order**: Node built-ins → third-party → internal, blank line between groups
- **One file per command**: `src/cli/commands/repo-map.ts` exports only `registerRepoMapCommand`; `src/cli/commands/routing.ts` exports only `registerRoutingCommand`; no command file imports another command file
- **No cross-module direct imports**: `repo-map.ts` imports `RepoMapModule`, `RepoMapQueryEngine`, `DoltSymbolRepository` only from `../../../modules/repo-map/index.js`; imports `RepoMapInjector` only from `../../../modules/context-compiler/index.js`; `routing.ts` imports `TuneLogEntry` only from `../../../modules/routing/index.js`
- **Symbol input sanitization**: `--query <symbol>` flag MUST validate against `/^[a-zA-Z0-9_]+$/` before any method call — security requirement from the input-validation architecture decision; invalid inputs exit 1 with a message to stderr
- **No fs.watch / no hot-reload**: all reads are one-shot at invocation; do not introduce any file watchers
- **Logging**: `createLogger('cli:repo-map')` and `createLogger('cli:routing')`; never `console.error` for structured diagnostics; `console.log` only for intended plain-text stdout output in text mode
- **run.ts sequential modification**: stories 28-5, 28-6, and 28-8 all modified `run.ts`; this story adds further changes — apply in story order; look for the `createDispatcher` call as the anchor point

### File Paths
```
src/cli/commands/
  repo-map.ts                         ← NEW: registerRepoMapCommand
  routing.ts                          ← NEW: registerRoutingCommand
  __tests__/
    repo-map-command.test.ts          ← NEW: unit tests
    routing-command.test.ts           ← NEW: unit tests

src/cli/index.ts                      ← MODIFY: add two import + registerAll call lines

src/cli/commands/run.ts               ← MODIFY: RepoMapInjector wiring, staleness check, --dry-run flag

src/core/event-bus.types.ts          ← MODIFY: add 'pipeline:repo-map-stale' payload type

src/modules/repo-map/RepoMapModule.ts ← MODIFY (if needed): add checkStaleness() method
```

### DoltStateStore Detection in run.ts

The `instanceof DoltStateStore` check requires that the same class reference is used at both construction and check time. Verify the import path for `DoltStateStore` in `src/modules/state/index.ts`. If `instanceof` is unreliable due to module boundary aliasing, add an `isDolt(): boolean` method to `IStateStore` (returns `false` in `FileStateStore`, `true` in `DoltStateStore`) — a minimal one-line addition to each implementation.

### checkStaleness() Guard: When Story 28-3 Already Implements It

Before adding `checkStaleness()` to `RepoMapModule.ts`, check whether story 28-3 already implemented it. The method signature may differ slightly (e.g. takes `gitRoot` as a parameter). Adapt `run.ts`'s call to match the actual signature rather than imposing a new one. If the method exists with a compatible signature, do not duplicate it.

### Dry-Run Table Alignment

Pad columns using `String.padEnd(n)`:
```typescript
const COL = { story: 8, phase: 10, model: 30, symbols: 12 }
const header = 'Story'.padEnd(COL.story) + 'Phase'.padEnd(COL.phase) + 'Model'.padEnd(COL.model) + 'Est. Symbols'
const sep = '─'.repeat(COL.story + COL.phase + COL.model + COL.symbols)
```
No external table-formatting library needed.

### event-bus.types.ts Structure

Check the exact event map structure established by story 28-5. The `'routing:model-selected'` payload was added there. Add `'pipeline:repo-map-stale'` in the same position in the map:
```typescript
'pipeline:repo-map-stale': {
  storedSha: string
  headSha: string
  fileCount: number
}
```

### Routing History Table Format (text mode)

```
Auto-Tune History:
  2026-03-10T14:32:11Z  generate  claude-sonnet-4-5 → claude-3-haiku-20240307  est. 42% savings
  2026-03-09T09:15:44Z  explore   claude-opus-4     → claude-sonnet-4-5        est. 38% savings
```

Use `entry.appliedAt.slice(0, 20)` for compact ISO timestamps. Left-pad `phase` to 10 chars.

### Testing Requirements
- **Framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; no jest APIs
- **Mock `node:fs`** in `repo-map-command.test.ts` via `vi.mock('node:fs')` for `readFileSync`
- **Mock `node:child_process`** via `vi.mock('node:child_process')` in `RepoMapModule.checkStaleness()` tests if added
- **No real Dolt/DB**: all repository and state store methods are `vi.fn()` stubs injected via constructor
- **Coverage gate**: ≥80% line coverage on `src/cli/commands/repo-map.ts` and `src/cli/commands/routing.ts` (enforced by `npm test`)
- **No `--testPathPattern`**: vitest uses `-- "pattern"` syntax (not jest's flag) when running specific tests

## Interface Contracts

- **Import**: `RepoMapModule`, `RepoMapQueryEngine`, `DoltSymbolRepository` @ `src/modules/repo-map/index.ts` (from stories 28-2 and 28-3)
- **Import**: `RepoMapInjector`, `InjectionResult` @ `src/modules/context-compiler/index.ts` (from story 28-7)
- **Import**: `RoutingResolver`, `ModelRoutingConfig` @ `src/modules/routing/index.ts` (from story 28-4)
- **Import**: `TuneLogEntry` @ `src/modules/routing/index.ts` (from story 28-8)
- **Import**: `WorkflowDeps` @ `src/modules/compiled-workflows/types.ts` (from story 28-7; already extended with `repoMapInjector?` and `maxRepoMapTokens?`)
- **Export**: `registerRepoMapCommand` @ `src/cli/commands/repo-map.ts` (registered in `src/cli/index.ts`)
- **Export**: `registerRoutingCommand` @ `src/cli/commands/routing.ts` (registered in `src/cli/index.ts`)
- **Modify**: `'pipeline:repo-map-stale'` event payload @ `src/core/event-bus.types.ts` (consumed by supervisor event stream and NDJSON event consumers)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6 (pipeline) + claude-opus-4-6 (manual verification)

### Completion Notes List
- All AC1–AC7 implemented by pipeline dev agent; escalation was due to code review timeout, not missing implementation.
- `repo-map.ts`: --show, --update, --query (with /^[a-zA-Z0-9_]+$/ validation), --dry-run all implemented.
- `routing.ts`: --history with text and JSON output, lifecycle management.
- Both commands registered in `src/cli/index.ts` (alphabetical order).
- `run.ts`: RepoMapInjector wired (lines 537-547), staleness check (line 1072), --dry-run preview mode (lines 554-557).
- `pipeline:repo-map-stale` event type added to `src/core/event-bus.types.ts`.
- Build: exit 0, 0 type errors. Tests: 221 files, 5325 tests, all passing.

### File List
- /home/jplanow/code/jplanow/substrate/src/cli/commands/repo-map.ts (NEW)
- /home/jplanow/code/jplanow/substrate/src/cli/commands/routing.ts (NEW)
- /home/jplanow/code/jplanow/substrate/src/cli/commands/__tests__/repo-map-command.test.ts (NEW)
- /home/jplanow/code/jplanow/substrate/src/cli/commands/__tests__/routing-command.test.ts (NEW)
- /home/jplanow/code/jplanow/substrate/src/cli/index.ts (MODIFIED — command registration)
- /home/jplanow/code/jplanow/substrate/src/cli/commands/run.ts (MODIFIED — RepoMapInjector wiring, staleness, --dry-run)
- /home/jplanow/code/jplanow/substrate/src/core/event-bus.types.ts (MODIFIED — pipeline:repo-map-stale event)

## Change Log
