# Story 28-2: Repo-Map Dolt Storage and Incremental Updates

Status: complete

## Story

As a pipeline developer,
I want the repo-map symbol index persisted in Dolt and updated incrementally after each story execution,
so that the structural context is reusable across pipeline runs without re-parsing the full codebase each time.

## Acceptance Criteria

### AC1: Schema Extension — repo_map_symbols and repo_map_meta Tables
**Given** the application initializes against a Dolt state store
**When** the schema SQL in `src/modules/state/schema.sql` is applied
**Then** two new tables exist: `repo_map_symbols` (columns: id, file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash) and `repo_map_meta` (columns: id, commit_sha, updated_at, file_count); `_schema_version` gains a new `INSERT IGNORE` row for version 5; both tables include indexes on `file_path` and `symbol_kind` for query performance

### AC2: Symbol Upsert with File-Level Atomicity
**Given** a `ParsedSymbol[]` array (from story 28-1's SymbolParser) and a computed SHA256 hash of the file's content
**When** `ISymbolRepository.upsertFileSymbols(filePath, symbols, fileHash)` is called
**Then** all existing rows for that `file_path` are deleted first, then the new symbols are inserted in a single batch; each row stores `file_hash`; the operation is atomic per file path (delete then insert runs sequentially for that file path without interleaving)

### AC3: Filtered Symbol Query
**Given** symbols exist in `repo_map_symbols` across multiple files and symbol kinds
**When** `ISymbolRepository.getSymbols(filter?)` is called with an optional `SymbolFilter` specifying `filePaths?: string[]` and/or `kinds?: SymbolKind[]`
**Then** it returns `ParsedSymbol[]` matching all provided filter criteria using only parameterized WHERE clauses; when no filter is provided all rows are returned

### AC4: Per-File Staleness Detection via File Hash
**Given** a file exists on disk with content that may or may not match what was previously parsed
**When** `RepoMapStorage.isFileStale(filePath)` is called
**Then** it reads the current file content, computes its SHA256 hash, and returns `true` if the hash differs from the stored `file_hash` (or no row exists for the file), `false` if they match; the method does not re-parse the file

### AC5: Commit-Level Staleness Check
**Given** `repo_map_meta` may contain a stored `commit_sha`
**When** `RepoMapStorage.isStale(projectRoot)` is called
**Then** it invokes `IGitClient.getCurrentSha(projectRoot)` and compares it to the stored `commit_sha`; returns `true` if they differ or `repo_map_meta` has no rows; returns `false` if they match

### AC6: Incremental Update via git diff
**Given** `repo_map_meta` has a stored `commit_sha` and the project has new commits on top of it
**When** `RepoMapStorage.incrementalUpdate(projectRoot, parser)` is called
**Then** it runs `git diff --name-only <storedSha>..HEAD` via `IGitClient.getChangedFiles()` to identify changed files, re-parses only those files whose extension is supported (.ts, .tsx, .js, .mjs, .cjs, .py) using the provided `ISymbolParser`, upserts their symbols (including deleting symbols for deleted files), and updates `repo_map_meta` with the new HEAD SHA; individual parse failures are logged at warn level and skipped without aborting the operation

### AC7: Full Bootstrap Seed
**Given** a project root with tracked TypeScript/JavaScript/Python source files
**When** `RepoMapStorage.fullBootstrap(projectRoot, parser)` is called
**Then** it enumerates all files via `IGitClient.listTrackedFiles(projectRoot)`, filters to supported extensions, parses each file using the provided `ISymbolParser`, upserts all symbols into Dolt, and updates `repo_map_meta` with the current HEAD SHA and total parsed file count; individual parse failures are logged and skipped; the operation completes within 60 seconds for repositories up to 500 files

## Tasks / Subtasks

- [x] Task 1: Extend schema.sql with repo-map tables (AC: #1)
  - [x] Append `repo_map_symbols` DDL (CREATE TABLE IF NOT EXISTS) to `src/modules/state/schema.sql` with columns: `id BIGINT AUTO_INCREMENT PRIMARY KEY`, `file_path VARCHAR(1000) NOT NULL`, `symbol_name VARCHAR(500) NOT NULL`, `symbol_kind VARCHAR(20) NOT NULL`, `signature TEXT`, `line_number INT NOT NULL DEFAULT 0`, `exported TINYINT(1) NOT NULL DEFAULT 0`, `file_hash VARCHAR(64) NOT NULL`
  - [x] Append `repo_map_meta` DDL with columns: `id INT NOT NULL DEFAULT 1 PRIMARY KEY`, `commit_sha VARCHAR(64)`, `updated_at DATETIME`, `file_count INT NOT NULL DEFAULT 0`
  - [x] Add `CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_file ON repo_map_symbols (file_path)` and `CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_kind ON repo_map_symbols (symbol_kind)`
  - [x] Add `INSERT IGNORE INTO _schema_version (version, description) VALUES (5, 'Add repo_map_symbols and repo_map_meta tables (Epic 28-2)')`

- [x] Task 2: Add new interfaces and error codes (AC: #2, #3, #4, #5, #6, #7)
  - [x] Append `SymbolFilter` interface to `src/modules/repo-map/interfaces.ts`: `{ filePaths?: string[]; kinds?: SymbolKind[] }`
  - [x] Append `RepoMapMeta` interface: `{ commitSha: string; updatedAt: Date; fileCount: number }`
  - [x] Append `ISymbolRepository` interface: `upsertFileSymbols(filePath: string, symbols: ParsedSymbol[], fileHash: string): Promise<void>`, `getSymbols(filter?: SymbolFilter): Promise<ParsedSymbol[]>`, `getFileHash(filePath: string): Promise<string | null>`
  - [x] Append `IRepoMapMetaRepository` interface: `updateMeta(meta: RepoMapMeta): Promise<void>`, `getMeta(): Promise<RepoMapMeta | null>`
  - [x] Append `IGitClient` interface: `getCurrentSha(projectRoot: string): Promise<string>`, `getChangedFiles(projectRoot: string, fromSha: string): Promise<string[]>`, `listTrackedFiles(projectRoot: string): Promise<string[]>`
  - [x] Add `ERR_REPO_MAP_STORAGE_WRITE`, `ERR_REPO_MAP_STORAGE_READ`, `ERR_REPO_MAP_GIT_FAILED` to `src/errors/index.ts` following the `ERR_REPO_MAP_PARSE_FAILED` pattern (already added by story 28-1)

- [x] Task 3: Implement DoltSymbolRepository and DoltRepoMapMetaRepository (AC: #2, #3)
  - [x] Create `src/modules/repo-map/storage.ts`; define a local helper `computeFileHash(filePath: string): Promise<string>` using `crypto.createHash('sha256')` and `fs.readFile`
  - [x] Implement `DoltSymbolRepository` (implements `ISymbolRepository`); constructor accepts `client: DoltClient` and `logger: ILogger`; create child logger with `{ component: 'repo-map:storage' }`
  - [x] `upsertFileSymbols`: run `DELETE FROM repo_map_symbols WHERE file_path = ?` then batch INSERT via multi-row `VALUES` placeholders with one parameterized row per symbol; execute DELETE even when symbols array is empty to handle file deletions
  - [x] `getSymbols(filter?)`: build `SELECT ... FROM repo_map_symbols` with optional `WHERE file_path IN (?)` and/or `AND symbol_kind IN (?)` using parameterized arrays; map rows to `ParsedSymbol` objects
  - [x] `getFileHash(filePath)`: `SELECT file_hash FROM repo_map_symbols WHERE file_path = ? LIMIT 1`; return `null` if no rows
  - [x] Implement `DoltRepoMapMetaRepository` (implements `IRepoMapMetaRepository`); constructor accepts `client: DoltClient`
  - [x] `updateMeta`: use `INSERT INTO repo_map_meta ... ON DUPLICATE KEY UPDATE` with id=1 singleton pattern
  - [x] `getMeta`: `SELECT * FROM repo_map_meta WHERE id = 1`; return `null` if no rows; map row to `RepoMapMeta`

- [x] Task 4: Implement GitClient (AC: #5, #6, #7)
  - [x] Create `src/modules/repo-map/git-client.ts`; define a local `runGit(args: string[], cwd: string): Promise<string>` helper using `execFile` from `node:child_process` wrapped in a Promise (matching DoltClient's `runExecFile` pattern)
  - [x] Implement `GitClient` (implements `IGitClient`); constructor accepts `logger: ILogger`
  - [x] `getCurrentSha(projectRoot)`: run `git rev-parse HEAD` in `projectRoot`, return trimmed stdout; throw `AppError(ERR_REPO_MAP_GIT_FAILED, 2, ...)` on non-zero exit
  - [x] `getChangedFiles(projectRoot, fromSha)`: run `git diff --name-only <fromSha>..HEAD`; return trimmed lines split by newline, filter out empty strings
  - [x] `listTrackedFiles(projectRoot)`: run `git ls-files`; return trimmed lines split by newline, filter out empty strings

- [x] Task 5: Implement RepoMapStorage orchestration class (AC: #4, #5, #6, #7)
  - [x] Add `RepoMapStorage` class to `src/modules/repo-map/storage.ts`; constructor accepts `symbolRepo: ISymbolRepository`, `metaRepo: IRepoMapMetaRepository`, `gitClient: IGitClient`, `logger: ILogger`
  - [x] `isFileStale(filePath)`: compute current file SHA256 hash, compare to `symbolRepo.getFileHash(filePath)`; return `true` if hash differs or stored hash is null
  - [x] `isStale(projectRoot)`: call `metaRepo.getMeta()` and `gitClient.getCurrentSha(projectRoot)`; return `true` if meta is null or `meta.commitSha !== currentSha`
  - [x] `incrementalUpdate(projectRoot, parser)`: get stored SHA from `metaRepo.getMeta()`; if meta is null, call `fullBootstrap` and return; call `gitClient.getChangedFiles(projectRoot, meta.commitSha)`, filter to `SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py'])`; for each changed file: if file still exists on disk, parse + upsert; if deleted, call `symbolRepo.upsertFileSymbols(filePath, [], '')` to clear symbols; on parse error, log warn and continue; after all files processed, call `metaRepo.updateMeta` with current SHA
  - [x] `fullBootstrap(projectRoot, parser)`: call `gitClient.listTrackedFiles(projectRoot)`, filter to supported extensions; for each file parse + upsert (log warn on error, continue); call `metaRepo.updateMeta` with current SHA and parsed file count

- [x] Task 6: Unit tests for DoltSymbolRepository and DoltRepoMapMetaRepository (AC: #2, #3)
  - [x] Create `src/modules/repo-map/__tests__/storage.test.ts`
  - [x] Mock `DoltClient` via constructor-injected stub: `{ query: vi.fn() }` configured with `mockResolvedValueOnce` row fixtures
  - [x] Test `upsertFileSymbols`: verify DELETE query runs first with correct file_path param; verify INSERT runs with all symbol rows; verify DELETE still runs on empty symbols array
  - [x] Test `getSymbols()` with no filter: verify SELECT has no WHERE clause, rows mapped to ParsedSymbol correctly
  - [x] Test `getSymbols({ filePaths: ['foo.ts'] })`: verify WHERE clause contains file_path IN (?)
  - [x] Test `getSymbols({ kinds: ['function', 'class'] })`: verify WHERE clause contains symbol_kind IN (?)
  - [x] Test `getFileHash`: verify correct SELECT query; returns null when empty result set
  - [x] Test `DoltRepoMapMetaRepository.updateMeta`: verify INSERT ... ON DUPLICATE KEY UPDATE query with correct params
  - [x] Test `DoltRepoMapMetaRepository.getMeta`: returns mapped `RepoMapMeta` on row present; returns `null` on empty result

- [x] Task 7: Unit tests for RepoMapStorage (AC: #4, #5, #6, #7)
  - [x] Add tests to `src/modules/repo-map/__tests__/storage.test.ts`
  - [x] Inject stub `ISymbolRepository`, `IRepoMapMetaRepository`, `IGitClient`, and mock `fs.readFile` via `vi.mock('node:fs/promises')`
  - [x] Test `isFileStale`: returns `false` when computed hash matches stored; returns `true` when hash differs; returns `true` when `getFileHash` returns `null`
  - [x] Test `isStale`: returns `false` when stored SHA matches current HEAD; returns `true` when different; returns `true` when `getMeta()` returns `null`
  - [x] Test `incrementalUpdate`: when meta is null, delegates to `fullBootstrap`; when changed files include a `.ts` file, parser is called for it; unsupported extensions are skipped; parse errors are caught and logged without abort; `metaRepo.updateMeta` called once at end
  - [x] Test `fullBootstrap`: `listTrackedFiles` result filtered to supported extensions only; parser called for each valid file; parse errors logged and skipped; `metaRepo.updateMeta` called with correct file count and current HEAD SHA

- [x] Task 8: Export new types and classes from index.ts and verify build (AC: #1–#7)
  - [x] Update `src/modules/repo-map/index.ts` to also export: `DoltSymbolRepository`, `DoltRepoMapMetaRepository`, `RepoMapStorage`, `GitClient` (classes) and `ISymbolRepository`, `IRepoMapMetaRepository`, `IGitClient`, `SymbolFilter`, `RepoMapMeta` (types/interfaces)
  - [x] Run `npm run build` and confirm zero TypeScript errors
  - [x] Run `npm run test:fast` and confirm all new tests pass with no regressions

## Dev Notes

### Architecture Constraints
- **Module location**: `src/modules/repo-map/` — new files `storage.ts` and `git-client.ts` are co-located alongside existing `GrammarLoader.ts`, `SymbolParser.ts`, `generator.ts` from story 28-1
- **DoltClient dependency**: import `DoltClient` from `../../modules/state/dolt-client.js` — this is an existing class, NOT an interface; constructor-inject it into repository classes for testability (tests inject a mock object matching the `query()` method shape)
- **No new tables outside schema.sql**: all DDL goes in `src/modules/state/schema.sql` as append-only, version-numbered statements (version 5)
- **Parameterized queries only**: all SQL uses `?` placeholders via `DoltClient.query(sql, params)`; no string interpolation of user-supplied values; multi-row VALUES clause shape is derived from `symbols.length` (a number, not user input — this is safe)
- **IN clause handling**: Dolt/MySQL2 accepts `?` placeholder for an array value in `IN (?)`; pass the array directly as the param and mysql2 expands it; for CLI fallback mode, check whether DoltClient `_queryCli` handles arrays — if not, join array manually before passing
- **File hash**: use `import { createHash } from 'node:crypto'` and `import { readFile } from 'node:fs/promises'`; compute `createHash('sha256').update(content).digest('hex')`
- **git subprocess**: use `execFile` from `node:child_process` wrapped in a Promise (same pattern as DoltClient `runExecFile`); always pass `{ cwd: projectRoot }` to run git commands in the project root
- **Constructor injection for ILogger**: never call `createLogger()` inside repository or storage classes — accept `ILogger` as a constructor parameter; callers use `createLogger('repo-map:storage')` at composition root
- **Error codes**: add to `src/errors/index.ts` using `export const ERR_X = 'ERR_X' as const`; use `AppError` directly: `new AppError('ERR_REPO_MAP_GIT_FAILED', 2, message)`
- **No CLI command in this story**: `substrate repo-map` CLI is story 28-3's concern
- **Import order**: Node built-ins (`node:crypto`, `node:fs/promises`, `node:child_process`, `node:path`) first, then third-party, then internal — blank line between groups

### File Paths
```
src/modules/state/schema.sql               ← append repo_map_symbols + repo_map_meta DDL (version 5)
src/errors/index.ts                        ← add ERR_REPO_MAP_STORAGE_WRITE, ERR_REPO_MAP_STORAGE_READ, ERR_REPO_MAP_GIT_FAILED
src/modules/repo-map/interfaces.ts         ← append SymbolFilter, RepoMapMeta, ISymbolRepository, IRepoMapMetaRepository, IGitClient
src/modules/repo-map/storage.ts            ← DoltSymbolRepository, DoltRepoMapMetaRepository, RepoMapStorage, computeFileHash helper
src/modules/repo-map/git-client.ts         ← GitClient implementing IGitClient, runGit helper
src/modules/repo-map/index.ts              ← extend exports
src/modules/repo-map/__tests__/
  storage.test.ts                          ← unit tests for DoltSymbolRepository, DoltRepoMapMetaRepository, RepoMapStorage
  git-client.test.ts                       ← unit tests for GitClient
```

### SQL Schema Extension (append to schema.sql)
```sql
-- ---------------------------------------------------------------------------
-- repo_map_symbols (story 28-2 / Epic 28)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repo_map_symbols (
  id          BIGINT AUTO_INCREMENT NOT NULL,
  file_path   VARCHAR(1000)         NOT NULL,
  symbol_name VARCHAR(500)          NOT NULL,
  symbol_kind VARCHAR(20)           NOT NULL,
  signature   TEXT,
  line_number INT                   NOT NULL DEFAULT 0,
  exported    TINYINT(1)            NOT NULL DEFAULT 0,
  file_hash   VARCHAR(64)           NOT NULL,
  PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_file ON repo_map_symbols (file_path);
CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_kind ON repo_map_symbols (symbol_kind);

-- ---------------------------------------------------------------------------
-- repo_map_meta (story 28-2 / Epic 28)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS repo_map_meta (
  id          INT      NOT NULL DEFAULT 1,
  commit_sha  VARCHAR(64),
  updated_at  DATETIME,
  file_count  INT      NOT NULL DEFAULT 0,
  PRIMARY KEY (id)
);

INSERT IGNORE INTO _schema_version (version, description) VALUES (5, 'Add repo_map_symbols and repo_map_meta tables (Epic 28-2)');
```

### Upsert Pattern for DoltSymbolRepository
```typescript
// Delete all existing symbols for this file first (atomic replace per file)
await this._client.query('DELETE FROM repo_map_symbols WHERE file_path = ?', [filePath])

// Batch insert — build multi-row VALUES clause
if (symbols.length === 0) return

const placeholders = symbols.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ')
const params: unknown[] = []
for (const sym of symbols) {
  params.push(filePath, sym.name, sym.kind, sym.signature ?? '', sym.lineNumber, sym.exported ? 1 : 0, fileHash)
}
await this._client.query(
  `INSERT INTO repo_map_symbols (file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash) VALUES ${placeholders}`,
  params
)
```

### Singleton Upsert for DoltRepoMapMetaRepository
```typescript
await this._client.query(
  `INSERT INTO repo_map_meta (id, commit_sha, updated_at, file_count)
   VALUES (1, ?, ?, ?)
   ON DUPLICATE KEY UPDATE
     commit_sha = VALUES(commit_sha),
     updated_at = VALUES(updated_at),
     file_count = VALUES(file_count)`,
  [meta.commitSha, meta.updatedAt, meta.fileCount]
)
```

### GitClient runGit Helper
```typescript
import { execFile as execFileCb } from 'node:child_process'

function runGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb('git', args, { cwd }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
```

### Supported Extensions Constant
```typescript
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py'])
```
Use `import { extname } from 'node:path'` to extract the extension before filtering.

### ILogger Interface Usage
Use the existing `ILogger` / `createLogger` pattern. Check `src/modules/state/dolt-store.ts` for the correct relative import path to `../../utils/logger.js`. Pass `createLogger('repo-map:storage')` and `createLogger('repo-map:git')` at the composition root and in tests.

### AppError Constructor Signature
The existing `AppError` constructor signature is: `constructor(code: string, exitCode: number, message: string)`. Confirm before use by reading `src/errors/app-error.ts`. Use exit code `2` for internal errors (storage failures, git failures).

### Testing Requirements
- **Mock `DoltClient.query()`**: inject `{ query: vi.fn() }` as the client; configure return values via `mockResolvedValueOnce(rows)`
- **Mock `IGitClient`**: inject plain object with `vi.fn()` properties for `getCurrentSha`, `getChangedFiles`, `listTrackedFiles`
- **Mock `ISymbolParser`**: inject `{ parseFile: vi.fn() }` returning pre-built `ParsedSymbol[]`
- **Mock `node:fs/promises`**: use `vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))` for `isFileStale` and `computeFileHash` tests
- **Mock `node:child_process`**: use `vi.spyOn` on `execFile` in `git-client.test.ts` to avoid real git calls
- **Never use `jest.*`**: this codebase uses Vitest — all mocking via `vi.mock`, `vi.fn()`, `vi.spyOn`
- Coverage target: ≥80% on all new files; run `npm run test:fast` to validate — no regressions allowed
- **fs.watch avoidance**: do NOT use `fs.watch` or `fs.watchFile` anywhere in this story — see project memory for the fs.watch regression pattern

## Interface Contracts

- **Import**: `ParsedSymbol` @ `src/modules/repo-map/interfaces.ts` (from story 28-1)
- **Import**: `SymbolKind` @ `src/modules/repo-map/interfaces.ts` (from story 28-1)
- **Import**: `ISymbolParser` @ `src/modules/repo-map/interfaces.ts` (from story 28-1)
- **Export**: `ISymbolRepository` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-3 RepoMapModule)
- **Export**: `IRepoMapMetaRepository` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-3)
- **Export**: `IGitClient` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-3 and CLI story)
- **Export**: `RepoMapStorage` @ `src/modules/repo-map/storage.ts` (consumed by story 28-3)
- **Export**: `SymbolFilter` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-3)
- **Export**: `RepoMapMeta` @ `src/modules/repo-map/interfaces.ts` (consumed by story 28-3)

## Dev Agent Record

### Agent Model Used
claude-opus-4-20250514

### Completion Notes List
- Fixed blocker: changed repo_map_symbols.id from VARCHAR(36) NOT NULL to BIGINT AUTO_INCREMENT NOT NULL in schema.sql
- Updated dolt-init.test.ts to allow AUTO_INCREMENT in repo_map_symbols table (required by story spec)
- All 8 tasks verified complete, build passes, 208 test files / 5158 tests pass with zero regressions

### File List
- src/modules/state/schema.sql (modified - fixed id column type to BIGINT AUTO_INCREMENT)
- src/modules/state/__tests__/dolt-init.test.ts (modified - updated AUTO_INCREMENT test for repo_map_symbols)
- src/modules/repo-map/interfaces.ts (implemented - SymbolFilter, RepoMapMeta, ISymbolRepository, IRepoMapMetaRepository, IGitClient)
- src/modules/repo-map/storage.ts (implemented - DoltSymbolRepository, DoltRepoMapMetaRepository, RepoMapStorage, computeFileHash)
- src/modules/repo-map/git-client.ts (implemented - GitClient, runGit helper)
- src/modules/repo-map/index.ts (implemented - barrel exports)
- src/modules/repo-map/__tests__/storage.test.ts (implemented - 626 lines, full coverage)
- src/modules/repo-map/__tests__/git-client.test.ts (implemented - 203 lines, full coverage)
- src/errors/index.ts (implemented - ERR_REPO_MAP_STORAGE_WRITE, ERR_REPO_MAP_STORAGE_READ, ERR_REPO_MAP_GIT_FAILED)

## Change Log
- 2026-03-10: Rework pass — fixed blocker (id column type VARCHAR→BIGINT AUTO_INCREMENT), updated schema validation test
