# Story 31-2: Epic Doc Ingestion

Status: ready-for-dev

## Story

As a pipeline orchestrator,
I want epic planning docs to be parsed and ingested into the Dolt work graph,
so that story metadata and dependencies are queryable SQL rows without any manual Dolt writes.

## Acceptance Criteria

### AC1: Story Map Parsing
**Given** an epic markdown doc with a story map section containing sprint headers (`**Sprint N — Label:**`) and story lines in the format `- {key}: {title} ({priority}, {size})`
**When** `EpicParser.parseStories(content)` is called with the file contents as a string
**Then** it returns a `ParsedStory[]` array where each entry has `story_key`, `epic_num`, `story_num`, `title`, `priority`, `size`, and `sprint` correctly populated

### AC2: Dependency Chain Parsing
**Given** an epic markdown doc with a `**Dependency chain**:` line in the format `A → B → C; B also gates D, E`
**When** `EpicParser.parseDependencies(content)` is called with the file contents
**Then** it returns a `ParsedDependency[]` array where sequential `→` chains produce `blocks` dependencies and `also gates` clauses produce additional `blocks` dependencies, all with `source: 'explicit'`

### AC3: Stories Upserted into Dolt
**Given** a `ParsedStory[]` array from `EpicParser`
**When** `EpicIngester.ingest(stories, dependencies)` is called
**Then** each story is upserted into the `stories` table — new stories are inserted with `status: 'planned'`, and existing stories have `title`, `priority`, `size`, and `sprint` updated without overwriting their current `status`

### AC4: Dependencies Synced into Dolt
**Given** a `ParsedDependency[]` array from `EpicParser`
**When** `EpicIngester.ingest(stories, dependencies)` is called
**Then** all existing `source = 'explicit'` dependency rows for the affected epic are deleted and replaced with the freshly parsed batch, so removed dependencies are cleaned up on re-ingestion

### AC5: CLI Command `substrate ingest-epic`
**Given** a valid path to an epic planning doc (e.g. `_bmad-output/planning-artifacts/epic-31-dolt-work-graph.md`)
**When** `substrate ingest-epic <path>` is run
**Then** the command exits 0 and prints a summary line such as `Ingested 9 stories and 8 dependencies from epic 31`

### AC6: Idempotent Ingestion
**Given** an epic doc that has already been ingested once
**When** `substrate ingest-epic <path>` is run a second time with the same doc and no intervening changes
**Then** the command succeeds (exit 0), no duplicate rows exist in either table, and existing story `status` values are preserved

### AC7: Malformed Doc Error Handling
**Given** an epic doc that is missing the story map section entirely, or contains story lines that do not match the expected format
**When** `substrate ingest-epic <path>` is run
**Then** the command exits with a non-zero code and prints a human-readable error describing the parsing failure (e.g. `Error: No story map section found in <path>` or `Error: Could not parse story line: "<line>"`)

## Interface Contracts

- **Import**: `stories` table DDL constants @ `src/modules/work-graph/schema.ts` (from story 31-1)
- **Import**: `story_dependencies` table DDL constants @ `src/modules/work-graph/schema.ts` (from story 31-1)
- **Export**: `EpicIngester` class @ `src/modules/work-graph/epic-ingester.ts` (consumed by 31-3 for auto-ingest on `substrate run` startup)
- **Export**: `EpicParser` class @ `src/modules/work-graph/epic-parser.ts` (consumed by 31-3 and future tooling)

## Tasks / Subtasks

- [ ] Task 1: Create `EpicParser` class (AC: #1, #2, #7)
  - [ ] Create `src/modules/work-graph/epic-parser.ts`
  - [ ] Implement `parseStories(content: string): ParsedStory[]` — find the `#### Story Map` section, iterate sprint headers to track current sprint number, match story lines with regex `/^- (\d+-\d+): (.+?) \((P\d), (\w+)\)$/`
  - [ ] Implement `parseDependencies(content: string): ParsedDependency[]` — find the `**Dependency chain**:` line, split on `→` for sequential deps, split on `;` then parse `also gates` clause for parallel deps
  - [ ] Throw descriptive `Error` if story map section is absent or yields zero parseable stories
  - [ ] Export types `ParsedStory` and `ParsedDependency` from the same file

- [ ] Task 2: Create `EpicIngester` class (AC: #3, #4, #6)
  - [ ] Create `src/modules/work-graph/epic-ingester.ts`
  - [ ] Constructor accepts a `DatabaseAdapter` (from `src/persistence/adapter.ts`)
  - [ ] Implement `async ingest(stories: ParsedStory[], dependencies: ParsedDependency[]): Promise<IngestResult>` where `IngestResult = { storiesUpserted: number; dependenciesReplaced: number }`
  - [ ] Upsert stories using `INSERT INTO stories (...) VALUES (?) ON DUPLICATE KEY UPDATE title=VALUES(title), priority=VALUES(priority), size=VALUES(size), sprint=VALUES(sprint)` — intentionally omit `status` from the UPDATE clause to preserve runtime state
  - [ ] Sync dependencies: run `DELETE FROM story_dependencies WHERE source = 'explicit' AND story_key LIKE '<epicNum>-%'` then bulk-insert the fresh dependency batch
  - [ ] Wrap both operations in a single `adapter.transaction()` call

- [ ] Task 3: Create `ingest-epic` CLI command (AC: #5, #7)
  - [ ] Create `src/cli/commands/ingest-epic.ts`
  - [ ] Export `registerIngestEpicCommand(program: Command): void`
  - [ ] Accept one positional argument: `<epic-doc-path>`
  - [ ] Validate the file exists and is readable before parsing (exit 1 with message if not)
  - [ ] Instantiate `EpicParser`, call `parseStories` + `parseDependencies`, instantiate `EpicIngester` with `createDatabaseAdapter(config)`, call `ingest()`
  - [ ] On success: print `Ingested {storiesUpserted} stories and {dependenciesReplaced} dependencies from epic {epicNum}`
  - [ ] On `EpicParser` or `EpicIngester` error: print `Error: {message}` and exit 1

- [ ] Task 4: Register command in CLI index (AC: #5)
  - [ ] In `src/cli/index.ts`, add `import { registerIngestEpicCommand } from './commands/ingest-epic.js'`
  - [ ] Call `registerIngestEpicCommand(program)` inside the `registerAll` (or equivalent) function alongside the other command registrations

- [ ] Task 5: Unit tests for `EpicParser` (AC: #1, #2, #7)
  - [ ] Create `src/modules/work-graph/__tests__/epic-parser.test.ts`
  - [ ] Test `parseStories` with inline fixture string: assert correct `story_key`, `sprint`, `priority`, `size`, `title` on each story
  - [ ] Test sprint numbering increments correctly across `**Sprint N —` headers
  - [ ] Test `parseDependencies` with a linear chain (`A → B → C`) and a gating clause (`B also gates D, E`)
  - [ ] Test error: content with no `#### Story Map` section throws with message containing `No story map section`
  - [ ] Test edge case: story map section present but all lines are malformed — throw with descriptive message

- [ ] Task 6: Unit tests for `EpicIngester` (AC: #3, #4, #6)
  - [ ] Create `src/modules/work-graph/__tests__/epic-ingester.test.ts`
  - [ ] Use `InMemoryDatabaseAdapter` from `src/persistence/memory-adapter.ts` — no Dolt process required
  - [ ] Seed the in-memory adapter with the `stories` and `story_dependencies` table DDL from `schema.ts` before each test
  - [ ] Test upsert: inserting a new story creates a row with `status = 'planned'`; re-ingesting the same story with changed title updates title but leaves `status` intact
  - [ ] Test dependency sync: run ingest twice with different dependency sets; after second run only the second set's rows exist
  - [ ] Test idempotency: identical ingest twice → same row counts, no duplicates
  - [ ] Test that both inserts are wrapped in a transaction (verify `adapter.transaction()` is called)

- [ ] Task 7: Integration test for CLI command (AC: #5, #6, #7)
  - [ ] Create `src/cli/commands/__tests__/ingest-epic.test.ts`
  - [ ] Use a trimmed inline fixture string representing an epic doc with 2 stories and 1 dependency
  - [ ] Mock `fs.readFileSync` to return the fixture; mock `createDatabaseAdapter` to return `InMemoryDatabaseAdapter`
  - [ ] Assert exit code 0 and printed summary on valid input
  - [ ] Assert exit code 1 and error message when file path does not exist
  - [ ] Assert exit code 1 and error message when file content has no story map section

## Dev Notes

### Architecture Constraints

- **Database layer**: use `DatabaseAdapter` interface from `src/persistence/adapter.ts` — never import `DoltClient` directly in this module
- **`InMemoryDatabaseAdapter`** for all tests — instantiate from `src/persistence/memory-adapter.ts`; it requires the `stories` and `story_dependencies` CREATE TABLE statements to be executed first via `adapter.exec()`
- **Import style**: named exports, `.js` extensions on all local imports (ESM project)
- **File locations**:
  - Parser: `src/modules/work-graph/epic-parser.ts`
  - Ingester: `src/modules/work-graph/epic-ingester.ts`
  - CLI command: `src/cli/commands/ingest-epic.ts`
  - Tests: `src/modules/work-graph/__tests__/epic-parser.test.ts`, `src/modules/work-graph/__tests__/epic-ingester.test.ts`, `src/cli/commands/__tests__/ingest-epic.test.ts`
- **schema.ts dependency**: story 31-1 creates `src/modules/work-graph/schema.ts` with exported `CREATE_STORIES_TABLE`, `CREATE_STORY_DEPENDENCIES_TABLE`, and `CREATE_READY_STORIES_VIEW` DDL strings. Import these — do not hardcode DDL or column names inline. If 31-1 has not run yet, define a minimal local `schema.ts` placeholder and note in the completion log.
- **Test framework**: Vitest — use `vi.mock`, `vi.fn()`, `vi.hoisted`, `describe`/`it`/`expect`. Do NOT use Jest APIs.

### Epic Doc Format Assumptions

Story map section begins with the heading `#### Story Map` (or similar with `Story Map` in the heading text).
Sprint headers match pattern: `**Sprint \d+ —` (bold, number, em dash).
Story lines match pattern: `- {epicNum}-{storyNum}: {title} ({priority}, {size})` with optional whitespace.
Example: `- 31-2: Epic doc ingestion (P0, Medium)`

Dependency chain line matches pattern: `\*\*Dependency chain\*\*:` followed by the chain string.
Supported chain formats:
- Linear: `31-1 → 31-2 → 31-3`
- Gating clause: `31-3 also gates 31-6, 31-7`
- Combined: `31-1 → 31-2 → 31-3 → 31-4 → 31-5; 31-3 also gates 31-6, 31-7`

If the `**Dependency chain**` line is absent, return an empty `ParsedDependency[]` array (not an error — some epics have no declared dependencies).

### Testing Requirements

- Do NOT use real filesystem paths in tests — use inline string fixtures passed directly to parser methods
- Use `InMemoryDatabaseAdapter` for all DB interactions in tests — always call `adapter.exec(CREATE_STORIES_TABLE)` etc. in `beforeEach`
- All tests must pass `npm run test:fast`
- Coverage: new files must meet the 80% threshold enforced by vitest config

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
