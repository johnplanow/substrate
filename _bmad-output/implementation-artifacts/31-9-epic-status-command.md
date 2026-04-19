# Story 31-9: substrate epic-status Command

Status: ready-for-dev

## Story

As a developer using substrate,
I want `substrate epic-status <epic>` to display a generated view of all stories in an epic from the Dolt work graph,
so that I can see the complete picture of epic progress — which stories are done, in-progress, ready to dispatch, or blocked — without reading epic docs or cross-referencing MEMORY.md.

## Acceptance Criteria

### AC1: Lists All Stories for the Requested Epic
**Given** stories are present in `wg_stories` for epic `<epic>`
**When** the user runs `substrate epic-status <epic>`
**Then** every story in that epic is printed, ordered by `story_key` (natural sort: `31-1` before `31-2` before `31-10`), showing the story key, status badge, and title

### AC2: Status Badges Distinguish Story States
**Given** stories in the epic with various statuses (`planned`, `ready`, `in_progress`, `complete`, `escalated`)
**When** the output is rendered in human-readable mode
**Then** each story line displays a fixed-width status badge (e.g. `[complete]`, `[in_progress]`, `[ready    ]`, `[planned  ]`, `[escalated]`) for at-a-glance scanning

### AC3: Blocked Stories Show Dependency Explanation
**Given** a story in the epic has an unsatisfied `blocks`-type dependency
**When** the user runs `substrate epic-status <epic>`
**Then** that story is annotated with its unsatisfied blockers (e.g. `  [blocked  ] 31-4  Status lifecycle  [waiting on: 31-3 (in_progress)]`), replacing the standard status badge

### AC4: Summary Line Shows Epic Progress
**Given** stories are present in `wg_stories` for the requested epic
**When** `substrate epic-status <epic>` completes
**Then** a summary line is printed after the story list showing counts by status: `Epic 31: 3 complete · 1 in_progress · 2 ready · 1 blocked · 2 planned`

### AC5: JSON Output Returns Structured Epic Data
**Given** stories are present in `wg_stories` for the requested epic
**When** the user runs `substrate epic-status <epic> --output-format json`
**Then** the command emits a single JSON object with:
- `epic`: the requested epic string (e.g. `"31"`)
- `stories`: array of `{ key: string, title: string | null, status: string, blockers?: Array<{ key: string, title: string, status: string }> }` sorted by key
- `summary`: `{ total: number, complete: number, inProgress: number, ready: number, blocked: number, planned: number, escalated: number }`

### AC6: Unknown Epic Exits Cleanly with Informative Message
**Given** no stories are present in `wg_stories` for the requested epic
**When** the user runs `substrate epic-status <epic>`
**Then** the command writes `No stories found for epic <epic> (work graph not populated — run \`substrate ingest-epic\` first)` to stderr and exits with code 1

### AC7: Command Registered in CLI and Discoverable via Help
**Given** the `epic-status` command is implemented
**When** the user runs `substrate --help`
**Then** `epic-status` appears in the command list with a one-line description; `substrate epic-status --help` shows usage including `--output-format`

## Tasks / Subtasks

- [ ] Task 1: Create `src/cli/commands/epic-status.ts` (AC: #1, #2, #3, #4, #5, #6, #7)
  - [ ] Add file header comment matching the style of `ingest-epic.ts` — document command purpose, usage, and examples
  - [ ] Import `type { Command }` from `'commander'`, `createDatabaseAdapter` from `'../../persistence/adapter.js'`, `WorkGraphRepository, BlockedStoryInfo` from `'../../modules/state/index.js'`, and `CREATE_STORIES_TABLE, CREATE_STORY_DEPENDENCIES_TABLE` from `'../../modules/work-graph/schema.js'`
  - [ ] Declare `type OutputFormat = 'human' | 'json'` locally (same as used in other commands)
  - [ ] Define `EpicStatusOptions` interface: `{ outputFormat: OutputFormat }`
  - [ ] Export `async function runEpicStatusAction(epicNum: string, opts: EpicStatusOptions): Promise<void>` — this is the testable entry point (separates action from Commander wiring)
  - [ ] In the action function: create adapter with `createDatabaseAdapter({ backend: 'auto', basePath: process.cwd() })`, wrap in try/finally to always call `adapter.close()`
  - [ ] Call `adapter.exec(CREATE_STORIES_TABLE)` and `adapter.exec(CREATE_STORY_DEPENDENCIES_TABLE)` (idempotent schema init, same pattern as `ingest-epic.ts`)
  - [ ] Construct `new WorkGraphRepository(adapter)`, call `repo.listStories({ epic: epicNum })` to get all stories for the epic; if empty, write to stderr + set `process.exitCode = 1` + return (AC6)
  - [ ] Call `repo.getBlockedStories()` and filter result to only stories in the requested epic; build `blockedMap = new Map<string, BlockedStoryInfo>()` keyed by `story_key`
  - [ ] Call `repo.getReadyStories()` and filter to the requested epic; build `readySet = new Set<string>()` of ready story keys
  - [ ] Sort stories by story key (natural sort on numeric suffix: `parseInt(key.split('-')[1]!)`)
  - [ ] Build the `summary` object: iterate sorted stories, count by status; for blocked detection: story is "effectively blocked" if `blockedMap.has(story.story_key)` regardless of its stored status
  - [ ] In JSON branch: emit `JSON.stringify({ epic: epicNum, stories: [...], summary }, null, 2)` followed by newline (AC5)
  - [ ] In human branch: emit story list + summary line (AC1, AC2, AC3, AC4) — see Human Output Pattern in Dev Notes
  - [ ] Export `registerEpicStatusCommand(program: Command): void` that wires the Commander command with `.option('--output-format <format>', 'Output format (human|json)', 'human')` and calls `runEpicStatusAction`

- [ ] Task 2: Register the command in `src/cli/index.ts` (AC: #7)
  - [ ] Add import: `import { registerEpicStatusCommand } from './commands/epic-status.js'`
  - [ ] Add call after the existing `registerIngestEpicCommand(program)` line in the Work-graph commands section: `registerEpicStatusCommand(program)`
  - [ ] Confirm the comment block reads `// Work-graph commands (Epic 31)` and add `epic-status` after `ingest-epic`

- [ ] Task 3: Write unit tests for `runEpicStatusAction` (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Create `src/cli/commands/__tests__/epic-status.test.ts`
  - [ ] Mock `createDatabaseAdapter` via `vi.mock('../../persistence/adapter.js', ...)` to return a fake adapter backed by `InMemoryDatabaseAdapter`; initialize the schema tables in `beforeEach`
  - [ ] Alternatively, directly mock `WorkGraphRepository` methods with `vi.mock('../../modules/state/index.js', ...)` for a lighter-weight approach: mock `listStories`, `getBlockedStories`, `getReadyStories` on the prototype
  - [ ] Use `vi.spyOn(process.stdout, 'write')` and `vi.spyOn(process.stderr, 'write')` to capture output
  - [ ] Test (human mode): stories with mixed statuses → output contains story keys, status badges, summary line with correct counts
  - [ ] Test (human mode): story with `blockedMap` entry → output shows `[blocked  ]` badge and `[waiting on: X-Y (status)]` annotation
  - [ ] Test (JSON mode): returns valid JSON with `epic`, `stories`, `summary` fields; `stories` array sorted by key
  - [ ] Test (JSON mode): `summary.blocked` counts blocked stories correctly
  - [ ] Test (no stories): stderr receives "No stories found" message, `process.exitCode` set to 1
  - [ ] Test: `listStories` returning only stories for the requested epic (verify filter is applied)

- [ ] Task 4: Build and validate (AC: all)
  - [ ] Run `npm run build` — must exit 0, zero TypeScript errors
  - [ ] Run `npm run test:fast` — confirm output contains "Test Files" summary line with all tests passing; do NOT pipe output

## Dev Notes

### Architecture Constraints

- **New file to create**:
  - `src/cli/commands/epic-status.ts` — full command implementation

- **Files to modify**:
  - `src/cli/index.ts` — add import + `registerEpicStatusCommand(program)` call in the Work-graph commands section (after `registerIngestEpicCommand`)
  - `src/cli/commands/__tests__/epic-status.test.ts` — new test file

- **Import style**: All local imports use `.js` extension (ESM project):
  ```typescript
  import { WorkGraphRepository } from '../../modules/state/index.js'
  import type { BlockedStoryInfo } from '../../modules/state/index.js'
  import { CREATE_STORIES_TABLE, CREATE_STORY_DEPENDENCIES_TABLE } from '../../modules/work-graph/schema.js'
  import { createDatabaseAdapter } from '../../persistence/adapter.js'
  ```

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`. Do NOT use Jest APIs.

### Human Output Pattern

Render story rows like this:

```
Epic 31 — 9 stories

  [complete  ] 31-1  Create Dolt Work Graph Schema
  [complete  ] 31-2  Epic Doc Ingestion
  [complete  ] 31-3  Dispatch Gating via ready_stories View
  [in_progress] 31-4  Status Lifecycle — WG Writes
  [complete  ] 31-5  substrate status Shows Work Graph
  [ready     ] 31-6  Contract Deps to story_dependencies
  [complete  ] 31-7  Cycle Detection in Work Graph
  [ready     ] 31-8  Deprecate Status Field in Story Spec Frontmatter
  [blocked   ] 31-9  substrate epic-status Command  [waiting on: 31-8 (ready)]

Epic 31: 5 complete · 1 in_progress · 2 ready · 1 blocked · 0 planned
```

Key formatting rules:
- Header: `Epic <num> — <total> stories\n` followed by a blank line
- Story row: `  <badge> <key padded to 6>  <title>\n`
- Badge: fixed 12-char width including brackets: `[complete  ]`, `[in_progress]`, `[ready     ]`, `[planned   ]`, `[escalated ]`, `[blocked   ]`
- Blocked annotation appended to the title: `  [waiting on: <key> (<status>), <key> (<status>)]`
- Summary line after blank line: `Epic <num>: X complete · Y in_progress · Z ready · A blocked · B planned`
- Stories without a title: use the `story_key` as the display name

### Natural Sort for Story Keys

Story keys follow the pattern `<epic>-<num>`. Sort by numeric suffix to avoid lexicographic ordering (`31-10` before `31-9` with lexicographic sort):

```typescript
function sortByStoryKey(stories: WgStory[]): WgStory[] {
  return [...stories].sort((a, b) => {
    const numA = parseInt(a.story_key.split('-')[1] ?? '0', 10)
    const numB = parseInt(b.story_key.split('-')[1] ?? '0', 10)
    return numA - numB
  })
}
```

### Blocked Story Detection

A story should be shown as `[blocked   ]` when it appears in the result of `getBlockedStories()` (i.e., it has at least one unsatisfied `blocks`-type dependency), regardless of its stored `status` value (which may be `planned` or `ready`). Build a `Set<string>` or `Map` from the blocked results before rendering rows:

```typescript
const blocked = await repo.getBlockedStories()
// Filter to only stories in this epic
const epicBlockedMap = new Map(
  blocked
    .filter((b) => b.story.epic === epicNum)
    .map((b) => [b.story.story_key, b])
)
```

### Schema Init Pattern (from ingest-epic.ts)

Always ensure tables exist before querying — the `ingest-epic.ts` command does this and `epic-status` must follow the same pattern. The `CREATE_STORIES_TABLE` / `CREATE_STORY_DEPENDENCIES_TABLE` DDL strings use `CREATE TABLE IF NOT EXISTS` so they are idempotent.

### Summary Count Logic

The `summary.blocked` count comes from the epic-filtered `getBlockedStories()` result — not from `status = 'blocked'` in the DB. The other counts (`complete`, `inProgress`, `ready`, `planned`, `escalated`) come from `story.status` on all stories. However, stories that appear in `epicBlockedMap` should be excluded from `ready` and `planned` counts to avoid double-counting (a blocked story has `status = 'planned'` or `'ready'` in the DB but is displayed as blocked):

```typescript
const summary = {
  total: stories.length,
  complete: stories.filter((s) => s.status === 'complete').length,
  inProgress: stories.filter((s) => s.status === 'in_progress').length,
  escalated: stories.filter((s) => s.status === 'escalated').length,
  blocked: epicBlockedMap.size,
  ready: epicReadySet.size - epicBlockedMap.size,   // ready but not blocked
  planned: stories.filter(
    (s) => (s.status === 'planned' || s.status === 'ready') && !epicBlockedMap.has(s.story_key) && !epicReadySet.has(s.story_key)
  ).length,
}
```

Note: `epicReadySet` comes from filtering `getReadyStories()` to the epic. A "ready" story is dispatachable (unblocked). "Planned" stories are neither ready nor blocked — they have dependencies not yet satisfied (blockers are complete, but story itself hasn't transitioned to ready), or no deps and not yet dispatched.

### Testing Requirements

- Unit tests must mock `WorkGraphRepository` methods — do NOT attempt to start a Dolt process
- Use `vi.mock` at the module level to intercept `createDatabaseAdapter` or mock the repository prototype methods
- Capture stdout/stderr with `vi.spyOn(process.stdout, 'write')` and `vi.spyOn(process.stderr, 'write')` (with `.mockImplementation(() => true)`)
- Reset `process.exitCode` in `beforeEach` / `afterEach` to avoid test contamination: `process.exitCode = 0`
- All new code must remain above the 80% coverage threshold
- Run `npm run test:fast` during development (not `npm test`); confirm "Test Files" in raw output; never pipe

### Commander Registration Pattern

Follow the `ingest-epic.ts` pattern exactly:

```typescript
export function registerEpicStatusCommand(program: Command): void {
  program
    .command('epic-status <epic>')
    .description('Show a generated status view of an epic from the Dolt work graph')
    .option('--output-format <format>', 'Output format: human (default) or json', 'human')
    .action(async (epic: string, options: { outputFormat: string }) => {
      const fmt = options.outputFormat === 'json' ? 'json' : 'human'
      await runEpicStatusAction(epic, { outputFormat: fmt })
    })
}
```

## Interface Contracts

- **Import**: `WorkGraphRepository`, `BlockedStoryInfo` @ `src/modules/state/index.ts` (defined in stories 31-1 / 31-5)
- **Import**: `WgStory` @ `src/modules/state/types.ts` (via `src/modules/state/index.ts`)
- **Import**: `CREATE_STORIES_TABLE`, `CREATE_STORY_DEPENDENCIES_TABLE` @ `src/modules/work-graph/schema.js` (from story 31-1)
- **Import**: `createDatabaseAdapter` @ `src/persistence/adapter.js` (existing infrastructure)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
