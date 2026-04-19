# Story 49-7: Pyramid Summary CLI Commands

## Story

As a factory pipeline operator,
I want CLI commands to manually summarize content, expand stored summaries, and inspect compression statistics per run,
so that I can debug context compression behavior, verify summary fidelity, and audit token usage in long-running convergence sessions without modifying pipeline code.

## Acceptance Criteria

### AC1: `factory context summarize` Reads and Compresses an Iteration
**Given** a valid run ID with a stored `.orig` file at `.substrate/runs/{runId}/summaries/{hash}.orig` and a valid `--level` (high | medium | low)
**When** `substrate factory context summarize --run <id> --iteration <n> --level <level>` is run
**Then** the original content is loaded via `SummaryCache.getOriginal()`, passed through `CachingSummaryEngine.summarize()`, the resulting `Summary` is stored via `cache.put()`, and the command prints the resulting hash, target level, and approximate token savings to stdout with exit code 0

### AC2: `factory context expand` Expands a Stored Summary
**Given** a valid run ID and iteration whose summary exists in `.substrate/runs/{runId}/summaries/`
**When** `substrate factory context expand --run <id> --iteration <n>` is run
**Then** the most recently stored summary for that iteration is loaded from `SummaryCache.get()`, expanded via `CachingSummaryEngine.expand()` (using the lossless original path when available, LLM fallback otherwise), and the full expanded content is printed to stdout with exit code 0

### AC3: `factory context stats` Reports Per-Run Compression Statistics
**Given** a run ID with one or more summary files in `.substrate/runs/{runId}/summaries/`
**When** `substrate factory context stats --run <id>` is run
**Then** all `.json` summary files are read, parsed as `CachedSummaryRecord` objects, and a table (or JSON array when `--output-format json`) is printed showing: hash (first 8 chars), level, `compressionRatio` (from `computeCompressionRatio()`), `keyFactRetentionRate`, `cachedAt` timestamp; rows are sorted by `cachedAt` ascending; exit code is 0

### AC4: `--output-format json` Produces Machine-Readable Output
**Given** the `--output-format json` flag is passed to any of the three context subcommands
**When** the command succeeds
**Then** output is a single JSON object conforming to `CLIJsonOutput<T>` (with `timestamp`, `version`, `command`, and `data` fields) written to stdout; no human-readable text is mixed in; exit code is 0

### AC5: Invalid Arguments Exit with Error
**Given** an invalid `--level` value (not one of `high`, `medium`, `low`) is passed to `summarize`, **or** the `--run` directory does not exist at `.substrate/runs/{runId}/summaries/`, **or** `--iteration` is a non-integer string
**When** any of the three `factory context` commands is run with these invalid arguments
**Then** a clear error message is printed to stderr, no summary files are written or modified, and the command exits with code 1

### AC6: `factory context` Subcommand Group is Discoverable
**Given** the factory command group is registered in `packages/factory/src/factory-command.ts`
**When** `substrate factory context --help` is run
**Then** the output lists `summarize`, `expand`, and `stats` subcommands with their descriptions and required options; the subcommand group appears alongside `scenarios`, `run`, `validate`, and `twins` in `substrate factory --help`

### AC7: Unit Tests Cover CLI Parsing and Core Logic
**Given** `packages/factory/src/context/__tests__/context-cli-command.test.ts`
**When** run via `npm run test:fast`
**Then** at least 12 `it(...)` cases pass covering: `summarize` action calls `SummaryCache.getOriginal()` and `CachingSummaryEngine.summarize()`; `summarize` writes result via `cache.put()`; `summarize` exits 1 on invalid level; `summarize` exits 1 when original not found; `expand` calls `SummaryCache.get()` then `CachingSummaryEngine.expand()`; `expand` exits 1 when no summary found; `stats` reads all `.json` files and formats rows; `stats` exits 1 when run directory missing; `stats` emits valid `CLIJsonOutput` with `--output-format json`; `summarize` emits valid `CLIJsonOutput` with `--output-format json`; `expand` emits valid `CLIJsonOutput` with `--output-format json`; invalid `--iteration` value exits 1

## Tasks / Subtasks

- [ ] Task 1: Create `packages/factory/src/context/cli-command.ts` with `registerContextCommand(factoryCmd, version)` (AC: #6)
  - [ ] Import `Command` from `'commander'`
  - [ ] Import `SummaryCache` from `'./summary-cache.js'`
  - [ ] Import `CachingSummaryEngine` from `'./summary-cache.js'`
  - [ ] Import `computeCompressionRatio`, `computeKeyFactRetentionRate`, `QualityReport` from `'./summary-metrics.js'`
  - [ ] Import `SummaryLevel`, `SUMMARY_BUDGET` from `'./summary-types.js'`
  - [ ] Export `registerContextCommand(factoryCmd: Command, version: string, storageDir?: string): void` — `storageDir` defaults to `join(process.cwd(), '.substrate')`
  - [ ] Create `contextCmd = factoryCmd.command('context').description('Inspect and manage pyramid summaries for factory runs')`
  - [ ] Register `summarize`, `expand`, and `stats` subcommands on `contextCmd` (see Tasks 2–4)

- [ ] Task 2: Implement `context summarize` subcommand (AC: #1, #2, #4, #5)
  - [ ] Add `.command('summarize')` to `contextCmd` with `--run <id>` (required), `--iteration <n>` (required), `--level <level>` (required, choices: `high`, `medium`, `low`), `--output-format <format>` (default `'text'`)
  - [ ] In action handler: validate `--iteration` is a valid positive integer; if not, print error to stderr and `process.exit(1)`
  - [ ] Construct `SummaryCache` with `{ runId, storageDir }` and check that `.substrate/runs/{runId}/summaries/` exists; if not, print error to stderr and `process.exit(1)`
  - [ ] Call `cache.getOriginal()` using the hash found by listing `{hash}.orig` files in the summaries dir; if none found for iteration, print error to stderr and `process.exit(1)`. **Note:** iteration-to-hash mapping is stored via metadata in summary JSON files — scan all `*-{level}.json` files, parse each, match on `summary.iterationIndex === iteration` (if stored) or default to the first `.orig` file that exists when a single one is present
  - [ ] Instantiate a stub `LLMSummaryEngine` placeholder (or accept an optional `engineFactory` injection for testing) and wrap in `CachingSummaryEngine`; call `engine.summarize(originalContent, level)`
  - [ ] Call `cache.put(summary, originalContent)` to store result
  - [ ] Output result: text mode prints `Summarized iteration ${n} → level ${level} | hash: ${hash.slice(0,8)} | compression: ${ratio.toFixed(2)}`; JSON mode emits `CLIJsonOutput` with `data: { hash, level, compressionRatio, summaryTokenCount, originalTokenCount }`

- [ ] Task 3: Implement `context expand` subcommand (AC: #2, #4, #5)
  - [ ] Add `.command('expand')` to `contextCmd` with `--run <id>` (required), `--iteration <n>` (required), `--output-format <format>` (default `'text'`)
  - [ ] In action handler: validate `--iteration` is a positive integer; if not, print error to stderr and `process.exit(1)`
  - [ ] Construct `SummaryCache`; scan all `*-*.json` files in the summaries dir; parse and find the most recently stored summary whose `summary.level !== 'full'` (or any stored summary matching the iteration metadata); if none, print error to stderr and `process.exit(1)`
  - [ ] Call `CachingSummaryEngine.expand(summary, 'full')` (lossless if `.orig` present, LLM fallback otherwise)
  - [ ] Output result: text mode prints the expanded content directly; JSON mode emits `CLIJsonOutput` with `data: { hash, level, expandedLength, content }`

- [ ] Task 4: Implement `context stats` subcommand (AC: #3, #4, #5)
  - [ ] Add `.command('stats')` to `contextCmd` with `--run <id>` (required), `--output-format <format>` (default `'text'`)
  - [ ] In action handler: resolve `summariesDir = join(storageDir, 'runs', runId, 'summaries')`; if directory does not exist, print error to stderr and `process.exit(1)`
  - [ ] Read all `*.json` files from `summariesDir` using `readdir()` + `readFile()`, parse each as `CachedSummaryRecord`, compute `compressionRatio` via `computeCompressionRatio(record.summary)` and `keyFactRetentionRate` via `computeKeyFactRetentionRate()` if original is available
  - [ ] Sort parsed records by `cachedAt` ascending
  - [ ] Text mode: print a formatted table with columns `hash (8)`, `level`, `compressionRatio`, `keyFactRetention`, `cachedAt`; use consistent column widths with padding
  - [ ] JSON mode: emit `CLIJsonOutput` with `data: StatsRow[]` where each row has `hash`, `level`, `compressionRatio`, `keyFactRetentionRate`, `cachedAt`

- [ ] Task 5: Wire `registerContextCommand` into `factory-command.ts` (AC: #6)
  - [ ] In `packages/factory/src/factory-command.ts`, import `registerContextCommand` from `'./context/cli-command.js'`
  - [ ] Add call `registerContextCommand(factoryCmd, version)` immediately after the `validate` subcommand is registered, passing `version` from the outer `registerFactoryCommand` options if available (default `'0.0.0'`)
  - [ ] Ensure import uses `.js` extension per project conventions

- [ ] Task 6: Write unit tests in `packages/factory/src/context/__tests__/context-cli-command.test.ts` (AC: #7)
  - [ ] Mock `SummaryCache` class with `vi.mock('./summary-cache.js', ...)` — mock `put`, `get`, `getOriginal`, `listAll` (helper added for tests)
  - [ ] Mock `CachingSummaryEngine` — mock `summarize` and `expand` methods
  - [ ] Mock `node:fs/promises` `readdir` and `readFile` for the `stats` tests
  - [ ] Test `summarize` action: verifies `getOriginal` called, `summarize` called, `put` called, success output produced
  - [ ] Test `summarize` exits 1 on invalid level (non-high/medium/low)
  - [ ] Test `summarize` exits 1 when `getOriginal` returns `null`
  - [ ] Test `expand` action: verifies `get` called, `expand` called, content printed
  - [ ] Test `expand` exits 1 when no summaries found
  - [ ] Test `stats` action: reads all `.json` files, computes metrics, prints table
  - [ ] Test `stats` exits 1 when summaries dir missing
  - [ ] Test `--output-format json` produces valid `CLIJsonOutput` for each command
  - [ ] Test invalid `--iteration` string exits 1

## Interface Contracts

- **Import**: `SummaryCache`, `CachingSummaryEngine` @ `packages/factory/src/context/summary-cache.ts` (from story 49-4)
- **Import**: `computeCompressionRatio`, `computeKeyFactRetentionRate`, `QualityReport` @ `packages/factory/src/context/summary-metrics.ts` (from story 49-6)
- **Import**: `SummaryLevel`, `SUMMARY_BUDGET`, `Summary` @ `packages/factory/src/context/summary-types.ts` (from story 49-1)

## Dev Notes

### Architecture Constraints
- All imports use `.js` extensions (ESM project convention): `import { SummaryCache } from './summary-cache.js'`
- Commander.js v12 is the CLI framework — use `.command()`, `.requiredOption()`, `.option()`, `.action()`
- CLI is a composition root — business logic (cache reads, metric computation) must be importable without a live Commander instance
- Separate action handler functions from `registerContextCommand()` for testability: e.g., `export async function summarizeAction(opts, deps): Promise<number>` returns exit code; `registerContextCommand` wires Commander to action functions
- `--output-format json` output must conform to `CLIJsonOutput<T>` from `packages/factory/src/cli/utils/formatting.ts` (or equivalent `buildJsonOutput()` helper)
- No LLM calls in tests — mock `CachingSummaryEngine` via `vi.mock()`

### Storage Path Convention
- Summary JSON files: `.substrate/runs/{runId}/summaries/{hash}-{level}.json`
- Original content files: `.substrate/runs/{runId}/summaries/{hash}.orig`
- Quality metrics log: `.substrate/runs/{runId}/quality-metrics.jsonl`
- The `storageDir` argument to `SummaryCache` is the parent of `runs/`, e.g., `.substrate`

### Iteration-to-Hash Resolution
The summaries directory does not have a built-in index keyed by iteration number. Story 49-7 should adopt a pragmatic approach:
- When `--iteration <n>` is provided, scan all `*-*.json` files, parse the `CachedSummaryRecord`, and match on `record.summary.iterationIndex` if that field exists (added as an optional field on the `Summary` type by this story if not already present)
- If no `iterationIndex` metadata is available (summaries from earlier stories), fall back to listing all `.orig` files and using the first one found (with a warning to stderr)
- If no match is found at all, exit 1 with a clear message

### Testing Requirements
- Use `vitest` with `vi.mock()` for all file system and engine calls
- Export action functions separately from Commander registration for direct unit testing
- Minimum 12 test cases in `context-cli-command.test.ts`
- Test file location: `packages/factory/src/context/__tests__/context-cli-command.test.ts`
- Run test validation with: `npm run test:fast`

### File Paths
- **New file**: `packages/factory/src/context/cli-command.ts`
- **New file**: `packages/factory/src/context/__tests__/context-cli-command.test.ts`
- **Modified**: `packages/factory/src/factory-command.ts` — add `registerContextCommand` import and call
- **Possibly modified**: `packages/factory/src/context/summary-types.ts` — add optional `iterationIndex?: number` to `Summary` interface if not already present
- **Possibly modified**: `packages/factory/src/context/index.ts` — export `registerContextCommand`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
