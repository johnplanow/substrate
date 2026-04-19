# Story 26.13: SQLite → Dolt Migration Command

Status: ready-for-dev

## Story

As a developer who has been running substrate on the file backend,
I want a `substrate migrate` command that copies my historical SQLite metrics data into Dolt,
so that my execution history is preserved and queryable after I switch to the Dolt state backend.

## Acceptance Criteria

### AC1: Migrate story_metrics rows from SQLite to Dolt metrics table
**Given** a substrate project with an existing SQLite database at `<repoRoot>/.substrate/substrate.db` containing rows in the `story_metrics` table, and a Dolt state store initialized at `<repoRoot>/.substrate/state/`
**When** I run `substrate migrate`
**Then** all rows from `story_metrics` are written into the Dolt `metrics` table using the column mapping defined in Dev Notes; rows that cannot be mapped (missing story_key, NULL recorded_at) are skipped with a warning

### AC2: Migration is idempotent
**Given** the migration has already been run once successfully
**When** I run `substrate migrate` a second time with the same SQLite database
**Then** no duplicate rows are created in Dolt (`INSERT ... ON DUPLICATE KEY UPDATE` upsert semantics ensure idempotency on the composite PK `(story_key, task_type, recorded_at)`)

### AC3: Dolt commit created after successful migration
**Given** at least one record was written to Dolt during the migration
**When** `substrate migrate` completes
**Then** a Dolt commit with the message `"Migrate historical data from SQLite"` is created in the state repo via `client.exec('add .')` followed by `client.exec('commit -m "Migrate historical data from SQLite"')`

### AC4: No SQLite database — clean exit
**Given** no SQLite database file exists at `<repoRoot>/.substrate/substrate.db` (or the `story_metrics` table is absent or empty)
**When** I run `substrate migrate`
**Then** the command exits with code 0 and prints `"No SQLite data found — nothing to migrate"` to stdout (or `{ migrated: false, reason: "no-sqlite-data" }` in JSON mode)

### AC5: Dolt not initialized — actionable error
**Given** the Dolt binary is not installed or the Dolt repo at `<repoRoot>/.substrate/state/.dolt/` does not exist
**When** I run `substrate migrate`
**Then** the command exits with code 1 and prints `"Dolt not initialized. Run 'substrate init --dolt' first."` to stderr (or `{ error: "ERR_DOLT_NOT_INITIALIZED", message: "..." }` in JSON mode)

### AC6: Progress output shows per-table row counts
**Given** a SQLite database with N story_metrics rows
**When** `substrate migrate` completes successfully
**Then** the command prints `"Migrated N story metrics."` to stdout (or a structured JSON object with `{ migrated: true, counts: { metrics: N } }` in JSON mode)

### AC7: Dry-run flag shows counts without writing
**Given** a SQLite database with existing rows
**When** I run `substrate migrate --dry-run`
**Then** the command prints the row counts that would be migrated (e.g. `"Would migrate N story metrics (dry run — no changes written)"`) without writing any data to Dolt and without creating a Dolt commit; exit code is 0

## Tasks / Subtasks

- [ ] Task 1: Create `src/cli/commands/migrate.ts` command skeleton (AC: #4, #5, #6, #7)
  - [ ] Export `registerMigrateCommand(program: Command): void` following the pattern in `src/cli/commands/diff.ts`
  - [ ] Define `MigrateOptions` interface: `{ dryRun: boolean; outputFormat: string; projectRoot: string }`
  - [ ] Wire `--dry-run` boolean flag and `--output-format <format>` option (default `'text'`) via Commander
  - [ ] Wire `--project-root <path>` option defaulting to `process.cwd()` for testability

- [ ] Task 2: Implement SQLite reader — `readSqliteSnapshot(dbPath: string): SqliteSnapshot` (AC: #1, #4)
  - [ ] Define `SqliteSnapshot` type: `{ storyMetrics: StoryMetricRow[] }` where `StoryMetricRow` maps to `story_metrics` columns
  - [ ] Use `better-sqlite3` directly (not through DatabaseWrapper) with `new Database(dbPath, { readonly: true })`
  - [ ] Catch `better-sqlite3` constructor error (file not found) → return `{ storyMetrics: [] }`
  - [ ] Query `story_metrics` using `db.prepare('SELECT story_key, result, completed_at, created_at, wall_clock_seconds, input_tokens, output_tokens, cost_usd, review_cycles FROM story_metrics').all()`
  - [ ] Wrap table query in try/catch for missing table → return empty array and log warning
  - [ ] Close the database after reading

- [ ] Task 3: Implement Dolt writer with upsert semantics (AC: #1, #2)
  - [ ] Define `MigrationResult` type: `{ metricsWritten: number; skipped: number }`
  - [ ] Map each `StoryMetricRow` to Dolt `metrics` columns per the column mapping in Dev Notes; skip rows with NULL/empty `story_key`
  - [ ] Build batched `INSERT INTO metrics (...) VALUES ?,?,?... ON DUPLICATE KEY UPDATE cost_usd = VALUES(cost_usd), wall_clock_ms = VALUES(wall_clock_ms), result = VALUES(result)` SQL — batch up to 100 rows per query
  - [ ] Execute each batch via `client.query(sql, flatParams)` (DoltClient from `src/modules/state/dolt-client.ts`)
  - [ ] When `dryRun: true`, skip all `client.query` calls and return the count of rows that would be written

- [ ] Task 4: Add Dolt commit after successful migration (AC: #3)
  - [ ] After writes complete (and `dryRun === false` and `result.metricsWritten > 0`), call `await client.exec('add .')`
  - [ ] Then call `await client.exec('commit -m "Migrate historical data from SQLite"')`
  - [ ] Catch exec errors and log as warnings (commit failure is non-fatal if data was written)

- [ ] Task 5: Detect Dolt initialization state and assemble command handler (AC: #5)
  - [ ] Import `checkDoltInstalled`, `DoltNotInstalled`, `createDoltClient` from `../../modules/state/index.js`
  - [ ] In command handler: call `await checkDoltInstalled()` — catch `DoltNotInstalled` → emit error and exit 1
  - [ ] Check `existsSync(join(repoRoot, '.substrate', 'state', '.dolt'))` — if absent → emit error and exit 1
  - [ ] On success: resolve `dbPath = join(repoRoot, '.substrate', 'substrate.db')`, call `readSqliteSnapshot`, call `migrateDataToDolt`, emit progress output, exit 0
  - [ ] Use `resolveMainRepoRoot` imported from `../../utils/repo-root.js` (or equivalent) to determine `repoRoot`; fall back to `projectRoot` option if util is unavailable

- [ ] Task 6: Register command in `src/cli/index.ts` (AC: #6)
  - [ ] Add `import { registerMigrateCommand } from './commands/migrate.js'` in the imports block (maintain alphabetical order)
  - [ ] Add `registerMigrateCommand(program)` call in the `registerAll` function (or equivalent registration site)

- [ ] Task 7: Write unit tests in `src/cli/commands/__tests__/migrate.test.ts` (AC: #1–#7)
  - [ ] Mock `better-sqlite3` module via `vi.mock('better-sqlite3')` with a factory returning `{ prepare: vi.fn().mockReturnValue({ all: vi.fn().mockReturnValue([]) }), close: vi.fn() }`
  - [ ] Mock `DoltClient` query/exec methods via `vi.mock('../../modules/state/index.js', ...)`
  - [ ] Mock `checkDoltInstalled` and `existsSync` for Dolt state detection branches
  - [ ] Test: SQLite file missing → `readSqliteSnapshot` returns empty; command exits 0 with "no data" message
  - [ ] Test: Dolt not installed (DoltNotInstalled thrown) → command exits 1 with actionable message on stderr
  - [ ] Test: Dolt `.dolt` dir absent → command exits 1 with actionable message on stderr
  - [ ] Test: Successful migration — `client.query` called with INSERT SQL; `client.exec` called with 'add .' and commit message; stdout shows row counts
  - [ ] Test: `--dry-run` → `client.query` NOT called; `client.exec` NOT called; stdout shows "Would migrate N" message
  - [ ] Test: JSON output mode → stdout is a valid JSON object with `migrated`, `counts` fields

## Interface Contracts

- **Import**: `DoltClient`, `createDoltClient`, `checkDoltInstalled`, `DoltNotInstalled` @ `src/modules/state/index.ts` (from story 26-3)

## Dev Notes

### Architecture Constraints
- Command file: `src/cli/commands/migrate.ts` — export `registerMigrateCommand(program: Command): void`
- Import order: Node built-ins (`node:fs`, `node:path`) → third-party (`better-sqlite3`, `commander`) → internal (relative `.js` paths); blank line between each group
- Never use `console.log` for informational messages; use `createLogger('cli:migrate')` for debug/warn; write user-facing progress to stdout via `process.stdout.write` or `console.log` only for final output lines
- All errors are typed; CLI handler catches and writes to `process.stderr.write` then calls `process.exit(1)`

### SQLite Database Path
- Path: `join(repoRoot, '.substrate', 'substrate.db')` — discovered from `amend.ts` pattern
- `repoRoot` is resolved via `resolveMainRepoRoot(projectRoot)` (see `src/cli/commands/amend.ts` for the import path)
- If `resolveMainRepoRoot` is not available as a standalone utility, use `process.cwd()` as the fallback
- Open with `new Database(dbPath, { readonly: true })` — never write to the source SQLite

### Dolt State Path
- `repoPath` for `DoltClient` constructor: `process.cwd()` (or resolved `repoRoot`) — matches `createStateStore` factory
- `.dolt` existence check: `existsSync(join(repoRoot, '.substrate', 'state', '.dolt'))`

### Column Mapping: story_metrics (SQLite) → metrics (Dolt)

| Dolt `metrics` column | Source | Notes |
|---|---|---|
| `story_key` | `story_metrics.story_key` | Skip row if NULL or empty string |
| `task_type` | `'pipeline-run'` (constant) | `story_metrics` has no task_type field |
| `recorded_at` | `COALESCE(completed_at, created_at)` | Use JS: `row.completed_at ?? row.created_at` |
| `model` | `NULL` | Not available in legacy data |
| `tokens_in` | `story_metrics.input_tokens` | Default 0 if NULL |
| `tokens_out` | `story_metrics.output_tokens` | Default 0 if NULL |
| `cache_read_tokens` | `0` | Not available in legacy data |
| `cost_usd` | `story_metrics.cost_usd` | Default 0 if NULL |
| `wall_clock_ms` | `Math.round((row.wall_clock_seconds ?? 0) * 1000)` | Convert seconds to ms |
| `review_cycles` | `story_metrics.review_cycles` | Default 0 if NULL |
| `stall_count` | `0` | Not available in legacy data |
| `result` | `story_metrics.result` | Keep as-is; may be NULL |

### Dolt Upsert SQL Pattern
```sql
INSERT INTO metrics
  (story_key, task_type, recorded_at, model, tokens_in, tokens_out, cache_read_tokens, cost_usd, wall_clock_ms, review_cycles, stall_count, result)
VALUES
  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
  (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  cost_usd       = VALUES(cost_usd),
  wall_clock_ms  = VALUES(wall_clock_ms),
  result         = VALUES(result)
```
- Batch rows in groups of 100 to avoid oversized queries
- Build `VALUES` placeholder string dynamically: `Array(batchSize).fill('(?,?,?,?,?,?,?,?,?,?,?,?)').join(', ')`
- Flatten row values into a single params array for `client.query(sql, params)`

### DoltClient Usage
```typescript
import { createDoltClient } from '../../modules/state/index.js'
const client = createDoltClient({ repoPath })
await client.connect()
// ... run queries ...
await client.exec('add .')
await client.exec('commit -m "Migrate historical data from SQLite"')
await client.close()
```

### Error Codes and Exit Behavior
- `ERR_DOLT_NOT_INITIALIZED` — Dolt binary missing or `.dolt` repo absent; exit code 1, message to stderr
- Unexpected errors (e.g. query failure) — log stack via logger.error, write plain message to stderr, exit code 2

### Key File Paths
- **New**: `src/cli/commands/migrate.ts`
- **New**: `src/cli/commands/__tests__/migrate.test.ts`
- **Modified**: `src/cli/index.ts` (import + registration)

### Testing Requirements
- Test file: `src/cli/commands/__tests__/migrate.test.ts`
- Use Vitest only — `vi.mock`, `vi.fn`, `describe`, `it`, `expect` (no jest APIs)
- Run `npm run test:fast` during iteration; `npm run test:changed` for targeted validation
- 80% branch coverage threshold enforced by `npm test`
- Spy pattern for stderr: `vi.spyOn(process.stderr, 'write').mockImplementation(() => true)`
- Mock `node:fs` for `existsSync`: `vi.mock('node:fs', () => ({ existsSync: vi.fn() }))`
- Use `vi.mock('better-sqlite3', () => ({ default: vi.fn().mockImplementation(() => mockDb) }))` pattern
- Do NOT run `npm test` concurrently — only one vitest instance at a time

### Story Dependencies
- **Requires 26-3**: `DoltClient` with `query()` and `exec()` methods must be in place
- **Requires 26-10**: `createDoltClient` exported from state module barrel; auto-detection infrastructure present
- **Requires 26-11**: `substrate init --dolt` must exist (referenced in error message)
- This story does NOT depend on 26-12 (degraded-mode hints) — parallel implementation is safe

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
