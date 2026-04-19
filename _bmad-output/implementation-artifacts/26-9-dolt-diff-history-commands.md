# Story 26-9: Dolt Diff + History Commands

Status: complete

## Story

As a developer running substrate pipelines,
I want `substrate diff` and `substrate history` CLI commands,
so that I can inspect what database state changed during a story's execution and trace the full pipeline commit history over time.

## Acceptance Criteria

### AC1: `substrate diff <storyKey>` Shows State Changes for a Story
**Given** a story has been executed with the Dolt backend (branch exists or was already merged)
**When** `substrate diff <storyKey>` is run
**Then** the command prints a table-grouped summary of database rows added, modified, and removed during that story's execution (sourced from `dolt diff main...story/<storyKey> --stat` or the equivalent commit range for merged stories)

### AC2: `substrate diff --sprint <sprintId>` Aggregates Changes Across a Sprint
**Given** multiple stories in a sprint have been executed with the Dolt backend
**When** `substrate diff --sprint <sprintId>` is run
**Then** the command queries all stories in the sprint via `stateStore.queryStories({ sprint: sprintId })`, calls `diffStory` for each, and prints an aggregate summary with per-table totals summed across all stories

### AC3: `substrate history` Shows Pipeline Commit Log
**Given** the Dolt backend is active and at least one story has been executed
**When** `substrate history [--limit N]` is run (default limit 20)
**Then** the command outputs a chronological list of Dolt commits newest-first, each line showing: short hash, ISO timestamp, story key (parsed from commit message, or `-` if absent), and commit message subject

### AC4: Both Commands Support `--output-format json`
**Given** either `substrate diff` or `substrate history` is run with `--output-format json`
**When** the command executes successfully
**Then** structured JSON is printed to stdout:
- `diff`: `{ "storyKey": "26-7", "tables": [{ "table": "stories", "added": 2, "removed": 0, "modified": 1 }] }`
- `history`: `[{ "hash": "a1b2c3d", "timestamp": "2026-03-08T14:23:01Z", "storyKey": "26-7", "message": "Merge story/26-7: branch-per-story complete" }]`

### AC5: File Backend Returns Graceful Empty Responses
**Given** the file backend is active (Dolt not initialized)
**When** `substrate diff <storyKey>` or `substrate history` is run
**Then** the command exits 0 with the message: `Diff/history not available with the file backend. Initialize Dolt with: substrate init --dolt`

### AC6: DoltStateStore Implements `diffStory` and `getHistory`
**Given** `DoltStateStore` from story 26-3 with its `DoltClient`
**When** `diffStory(storyKey)` is called
**Then** it runs `dolt diff main...story/<storyKey> --stat` if the branch exists; otherwise it finds the merge commit via `dolt log --grep "story/<storyKey>"` and diffs `<hash>~..<hash>`; the parsed result is returned as a typed `StoryDiff` object
**And** when `getHistory(options?)` is called, it runs `dolt log --format="%h %aI %s" [--limit N]` and returns `HistoryEntry[]` with hash, ISO timestamp, storyKey (extracted via regex from message), and full message

### AC7: All Tests Pass
**Given** the new CLI commands and DoltStateStore extensions
**When** `npm run test:fast` is run
**Then** all existing tests pass and new unit tests cover: `diff` command (text output, JSON output, sprint aggregation, file-backend message), `history` command (text output, JSON output, empty-state message), `DoltStateStore.diffStory` (branch-exists path, merged-story path, empty diff), and `DoltStateStore.getHistory` (with/without story key in message, limit respected)

## Interface Contracts

- **Import**: `StateStore`, `StoryFilter` @ `src/modules/state/types.ts` (from story 26-1)
- **Import**: `DoltStateStore` @ `src/modules/state/dolt-store.ts` (from story 26-3)
- **Import**: `DoltClient` @ `src/modules/state/dolt-client.ts` (from story 26-3)

## Tasks / Subtasks

- [ ] Task 1: Define `StoryDiff`, `HistoryEntry`, `HistoryOptions` types and extend StateStore interface (AC1, AC3, AC6)
  - [ ] Add to `src/modules/state/types.ts`:
    - `TableDiff`: `{ table: string; added: number; removed: number; modified: number }`
    - `StoryDiff`: `{ storyKey: string; tables: TableDiff[] }`
    - `HistoryEntry`: `{ hash: string; timestamp: string; storyKey: string | null; message: string }`
    - `HistoryOptions`: `{ limit?: number }`
  - [ ] Add `diffStory(storyKey: string): Promise<StoryDiff>` to the `StateStore` interface
  - [ ] Add `getHistory(options?: HistoryOptions): Promise<HistoryEntry[]>` to the `StateStore` interface
  - [ ] Verify `StoryFilter` (from story 26-1) has a `sprint?: string` field; if absent, add it to the interface
  - [ ] Export `StoryDiff`, `TableDiff`, `HistoryEntry`, `HistoryOptions` from `src/modules/state/index.ts`
  - [ ] Verify `npm run build` succeeds (interface extensions are additive)

- [ ] Task 2: Implement `diffStory` and `getHistory` in FileStateStore (AC5, AC7)
  - [ ] `diffStory(storyKey: string)`: return `{ storyKey, tables: [] }` (file backend has no diff data)
  - [ ] `getHistory(options?: HistoryOptions)`: return `[]` (no commit history in file mode)
  - [ ] Add unit tests to `src/modules/state/__tests__/file-store.test.ts` verifying both methods return empty/graceful results

- [ ] Task 3: Implement `diffStory` in DoltStateStore (AC1, AC6, AC7)
  - [ ] Check if branch exists: `await this._client.exec('dolt branch --list story/<storyKey>')`; truthy output means branch exists
  - [ ] Branch exists path: `await this._client.exec('dolt diff main...story/<storyKey> --stat')`
  - [ ] Branch missing (merged) path: `await this._client.exec('dolt log --oneline --grep "story/<storyKey>"')`; take the first line's hash; then `dolt diff <hash>~..<hash> --stat`
  - [ ] Parse `--stat` output line by line using regex `/^\s*(\w+)\s*\|\s*\d+\s*([+\-]+)/`; count `+` chars as added, `-` as removed, `Math.min(added, removed)` as modified (net of each direction)
  - [ ] Return `StoryDiff`; on DoltClient error throw `DoltQueryError` with original error as `cause`
  - [ ] Unit tests in `src/modules/state/__tests__/dolt-store.test.ts`: mock `DoltClient.exec` with `vi.fn()`; cover branch-exists path, merged-story path (two exec calls), empty stat output, and error propagation

- [ ] Task 4: Implement `getHistory` in DoltStateStore (AC3, AC4, AC6, AC7)
  - [ ] Build command: `dolt log --format="%h %aI %s"` + optionally `--limit <n>` (from `options?.limit ?? 20`)
  - [ ] Run via `await this._client.exec(command)`
  - [ ] Parse each non-empty line: split on first space for hash (7 chars), second token for ISO timestamp, remainder as message subject
  - [ ] Extract storyKey: regex `/story\/([0-9]+-[0-9]+)/i` on the message; `null` if no match
  - [ ] Return `HistoryEntry[]` in the order returned by `dolt log` (newest first)
  - [ ] Unit tests: mock `DoltClient.exec`; verify parsing of messages with story key, without story key, and with custom limit

- [ ] Task 5: Create `substrate diff` CLI command (AC1, AC2, AC4, AC5, AC7)
  - [ ] Create `src/cli/commands/diff.ts` exporting `registerDiffCommand(program: Command): void`
  - [ ] Command definition:
    ```
    program.command('diff [storyKey]')
      .description('Show state changes made during a story or sprint execution')
      .option('--sprint <sprintId>', 'Aggregate diff for all stories in a sprint')
      .option('--output-format <format>', 'Output format: text or json', 'text')
    ```
  - [ ] Require at least one of `storyKey` or `--sprint`; if neither, print usage error and exit 1
  - [ ] Instantiate StateStore: `const store = createStateStore(await loadConfig(projectRoot))`; call `store.initialize()`
  - [ ] Sprint path: `const stories = await store.queryStories({ sprint: sprintId })`; call `diffStory` for each; aggregate by summing `added/removed/modified` per table name using a `Map<string, TableDiff>`
  - [ ] Story path: `const diff = await store.diffStory(storyKey)`
  - [ ] File-backend detection: if result has `tables.length === 0` AND backend is `'file'`, print the graceful message and exit 0
  - [ ] Text output: header line `Diff for story <storyKey>:`; one line per table: `  <table>: +<added> -<removed> ~<modified>`; footer `No changes recorded` if tables empty and Dolt backend
  - [ ] JSON output: `console.log(JSON.stringify(result, null, 2))`
  - [ ] Unit tests `src/cli/commands/__tests__/diff.test.ts`: mock StateStore; text output, JSON output, sprint aggregation across 2 stories, file-backend message, missing-argument error

- [ ] Task 6: Create `substrate history` CLI command (AC3, AC4, AC5, AC7)
  - [ ] Create `src/cli/commands/history.ts` exporting `registerHistoryCommand(program: Command): void`
  - [ ] Command definition:
    ```
    program.command('history')
      .description('Show pipeline Dolt commit history')
      .option('--limit <n>', 'Number of commits to show', '20')
      .option('--output-format <format>', 'Output format: text or json', 'text')
    ```
  - [ ] Instantiate StateStore; call `getHistory({ limit: parseInt(options.limit, 10) })`
  - [ ] File-backend / empty: if result is empty array, print `No history available. Initialize Dolt with: substrate init --dolt` and exit 0
  - [ ] Text output: aligned columns — `<hash>  <timestamp>  <storyKey|->  <message>` (pad storyKey column to 8 chars)
  - [ ] JSON output: `console.log(JSON.stringify(entries, null, 2))`
  - [ ] Unit tests `src/cli/commands/__tests__/history.test.ts`: text output with mixed story-key/null entries, JSON output, empty-state message

- [ ] Task 7: Register both commands in CLI index and verify build (AC1, AC3)
  - [ ] In `src/cli/index.ts`: add `import { registerDiffCommand } from './commands/diff.js'`
  - [ ] Add `import { registerHistoryCommand } from './commands/history.js'`
  - [ ] Call `registerDiffCommand(program)` and `registerHistoryCommand(program)` in the `registerAll` function (after existing command registrations)
  - [ ] Run `npm run build` — verify zero TypeScript errors
  - [ ] Smoke-test help output: `npm run substrate:dev -- diff --help` and `npm run substrate:dev -- history --help`

## Dev Notes

### Architecture Constraints
- **New files**: `src/cli/commands/diff.ts`, `src/cli/commands/history.ts`, `src/cli/commands/__tests__/diff.test.ts`, `src/cli/commands/__tests__/history.test.ts`
- **Modified files**: `src/modules/state/types.ts`, `src/modules/state/file-store.ts`, `src/modules/state/dolt-store.ts`, `src/modules/state/index.ts`, `src/cli/index.ts`
- **Import style**: ES modules with `.js` extensions on all local imports (e.g., `import { StateStore } from '../../modules/state/index.js'`)
- **Node builtins**: use `node:` prefix (e.g., `import { execSync } from 'node:child_process'`)
- **Type imports**: use `import type { ... }` for type-only imports
- **Commander pattern**: follow the same registration pattern used in `src/cli/commands/status.ts` and `src/cli/commands/metrics.ts` — export `registerXxxCommand(program: Command): void`, import in `index.ts`, call in `registerAll`
- **DoltClient**: use `this._client.exec(command: string): Promise<string>` from story 26-3; never spawn `dolt` subprocess directly in DoltStateStore methods

### Dolt CLI Commands Used

```bash
# Check if branch exists (truthy output → exists)
dolt branch --list story/<storyKey>

# Diff branch vs main (3-dot = common ancestor base)
dolt diff main...story/<storyKey> --stat

# Find merge commit for a merged story
dolt log --oneline --grep "story/<storyKey>"

# Diff a single merge commit
dolt diff <hash>~..<hash> --stat

# Commit log with timestamps
dolt log --format="%h %aI %s" --limit <n>
```

### Parsing `dolt diff --stat` Output

```
 stories   | 3 ++++--
 contracts | 1 +
2 tables changed, 4 insertions(+), 2 deletions(-)
```

Per-table regex: `/^\s+(\w+)\s+\|\s+\d+\s+([+\-]+)/`
- Group 1 = table name
- Group 2 = `++++--` string: count `+` chars for added, `-` chars for removed, `Math.min(added, removed)` for modified

Skip the summary line (starts with digit).

### Parsing `dolt log --format="%h %aI %s"` Output

```
a1b2c3d 2026-03-08T14:23:01+00:00 Merge story/26-7: branch-per-story complete
e4f5g6h 2026-03-08T12:11:02+00:00 Initialize Dolt state schema
```

Split on first space for hash, second space for timestamp (ISO 8601), rest for message.
Extract storyKey from message with: `/story\/([0-9]+-[0-9]+)/i` → first capture group, or `null`.

### Config and StateStore Instantiation in CLI Commands

```typescript
import { loadConfig } from '../../config/loader.js'
import { createStateStore } from '../../modules/state/index.js'

const projectRoot = process.cwd()
const config = await loadConfig(projectRoot)
const store = createStateStore(config)
await store.initialize()
try {
  // ... use store
} finally {
  await store.close()
}
```

Check whether `config.stateBackend === 'file'` (or equivalent field from story 26-1's config) to generate the graceful message. If the field is not available, detect file backend by checking `store instanceof FileStateStore` after import.

### Sprint Filter on queryStories

`StoryFilter` from story 26-1 must include `sprint?: string`. If the field is not present in the existing type, add it in Task 1 (additive interface extension — no behavioral change to existing callers).

### Testing Requirements
- **Framework**: vitest (NOT jest). Run with `npm run test:fast`.
- **Coverage threshold**: 80% enforced — do not drop below.
- **DoltStateStore tests**: mock `DoltClient` using `vi.fn()` and inject via constructor; skip live `dolt` binary tests
- **CLI unit tests**: use commander `.parseAsync(['diff', '26-7'], { from: 'user' })` in test and inject a mock StateStore via module-level factory spy (`vi.mock('../../modules/state/index.js', ...)`)
- **No integration tests required**: unit tests with mocked DoltClient/StateStore are sufficient for this P2/Small story

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
