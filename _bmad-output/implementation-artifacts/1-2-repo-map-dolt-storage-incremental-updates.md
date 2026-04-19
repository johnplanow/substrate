# Story 1-2: Repo-Map Dolt Storage and Incremental Updates

Status: ready-for-dev

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
**Given** a `ParsedSymbol[]` array (from story 1-1's SymbolParser) and a computed SHA256 hash of the file's content
**When** `ISymbolRepository.upsertFileSymbols(filePath, symbols, fileHash)` is called
**Then** all existing rows for that `file_path` are deleted first, then the new symbols are inserted in a single batch; each row stores `file_hash`; the operation is not a partial write (delete then insert executes sequentially for that file path)

### AC3: Filtered Symbol Query
**Given** symbols exist in `repo_map_symbols` across multiple files and symbol kinds
**When** `ISymbolRepository.getSymbols(filter?)` is called with an optional `SymbolFilter` specifying `filePaths?: string[]` and/or `kinds?: SymbolKind[]`
**Then** it returns `ParsedSymbol[]` matching all provided filter criteria using only parameterized WHERE clauses; when no filter is provided all rows are returned; import-kind symbols are included in results

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

- [ ] Task 1: Extend schema.sql with repo-map tables (AC: #1)
  - [ ] Append `repo_map_symbols` DDL (CREATE TABLE IF NOT EXISTS) to `src/modules/state/schema.sql` with columns: `id BIGINT AUTO_INCREMENT PRIMARY KEY`, `file_path VARCHAR(1000) NOT NULL`, `symbol_name VARCHAR(500) NOT NULL`, `symbol_kind VARCHAR(20) NOT NULL`, `signature TEXT`, `line_number INT NOT NULL DEFAULT 0`, `exported TINYINT(1) NOT NULL DEFAULT 0`, `file_hash VARCHAR(64) NOT NULL`
  - [ ] Append `repo_map_meta` DDL with columns: `id INT NOT NULL DEFAULT 1 PRIMARY KEY`, `commit_sha VARCHAR(64)`, `updated_at DATETIME`, `file_count INT NOT NULL DEFAULT 0`
  - [ ] Add `CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_file ON repo_map_symbols (file_path)` and `CREATE INDEX IF NOT EXISTS idx_repo_map_symbols_kind ON repo_map_symbols (symbol_kind)`
  - [ ] Add `INSERT IGNORE INTO _schema_version (version, description) VALUES (5, 'Add repo_map_symbols and repo_map_meta tables (Epic 28-2)')`

- [ ] Task 2: Add new interfaces and types to interfaces.ts (AC: #2, #3, #4, #5, #6, #7)
  - [ ] Append `SymbolFilter` interface: `{ filePaths?: string[]; kinds?: SymbolKind[] }`
  - [ ] Append `RepoMapMeta` interface: `{ commitSha: string; updatedAt: Date; fileCount: number }`
  - [ ] Append `ISymbolRepository` interface: `upsertFileSymbols(filePath: string, symbols: ParsedSymbol[], fileHash: string): Promise<void>`, `getSymbols(filter?: SymbolFilter): Promise<ParsedSymbol[]>`, `getFileHash(filePath: string): Promise<string | null>`
  - [ ] Append `IRepoMapMetaRepository` interface: `updateMeta(meta: RepoMapMeta): Promise<void>`, `getMeta(): Promise<RepoMapMeta | null>`
  - [ ] Append `IGitClient` interface: `getCurrentSha(projectRoot: string): Promise<string>`, `getChangedFiles(projectRoot: string, fromSha: string): Promise<string[]>`, `listTrackedFiles(projectRoot: string): Promise<string[]>`
  - [ ] Add `ERR_REPO_MAP_STORAGE_WRITE`, `ERR_REPO_MAP_STORAGE_READ`, `ERR_REPO_MAP_GIT_FAILED` to `src/errors/index.ts` following the `ERR_REPO_MAP_PARSE_FAILED` pattern

- [ ] Task 3: Implement DoltSymbolRepository and DoltRepoMapMetaRepository in storage.ts (AC: #2, #3)
  - [ ] Create `src/modules/repo-map/storage.ts`; define a local helper `computeFileHash(filePath: string): Promise<string>` using `crypto.createHash('sha256')` and `fs.readFile`
  - [ ] Implement `DoltSymbolRepository` (implements `ISymbolRepository`); constructor accepts `client: DoltClient` and `logger: ILogger`; create child logger with `{ component: 'repo-map:storage' }`
  - [ ] `upsertFileSymbols`: run `DELETE FROM repo_map_symbols WHERE file_path = ?` then batch INSERT via `INSERT INTO repo_map_symbols (file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash) VALUES ...` with one parameterized row per symbol; no-op if symbols array is empty (but still execute the DELETE)
  - [ ] `getSymbols(filter?)`: build `SELECT ... FROM repo_map_symbols` with optional `WHERE file_path IN (?)` and/or `AND symbol_kind IN (?)` using parameterized arrays; map rows to `ParsedSymbol` objects
  - [ ] `getFileHash(filePath)`: `SELECT file_hash FROM repo_map_symbols WHERE file_path = ? LIMIT 1`; return `null` if no rows
  - [ ] Implement `DoltRepoMapMetaRepository` (implements `IRepoMapMetaRepository`); constructor accepts `client: DoltClient`
  - [ ] `updateMeta`: `INSERT INTO repo_map_meta (id, commit_sha, updated_at, file_count) VALUES (1, ?, ?, ?) ON DUPLICATE KEY UPDATE commit_sha = VALUES(commit_sha), updated_at = VALUES(updated_at), file_count = VALUES(file_count)`
  - [ ] `getMeta`: `SELECT * FROM repo_map_meta WHERE id = 1`; return `null` if no rows; map row to `RepoMapMeta`

- [ ] Task 4: Implement GitClient in git-client.ts (AC: #5, #6, #7)
  - [ ] Create `src/modules/repo-map/git-client.ts`; define a local `runGit(args: string[], cwd: string): Promise<string>` helper using `execFile` from `node:child_process` (matching the DoltClient `runExecFile` pattern)
  - [ ] Implement `GitClient` (implements `IGitClient`); constructor accepts `logger: ILogger`
  - [ ] `getCurrentSha(projectRoot)`: run `git rev-parse HEAD` in `projectRoot`, return trimmed stdout; throw `AppError(ERR_REPO_MAP_GIT_FAILED, 2, ...)` on non-zero exit
  - [ ] `getChangedFiles(projectRoot, fromSha)`: run `git diff --name-only <fromSha>..HEAD`; return trimmed lines split by newline, filter out empty strings
  - [ ] `listTrackedFiles(projectRoot)`: run `git ls-files`; return trimmed lines split by newline, filter out empty strings

- [ ] Task 5: Implement RepoMapStorage orchestration class (AC: #4, #5, #6, #7)
  - [ ] Add `RepoMapStorage` class to `src/modules/repo-map/storage.ts`; constructor accepts `symbolRepo: ISymbolRepository`, `metaRepo: IRepoMapMetaRepository`, `gitClient: IGitClient`, `logger: ILogger`
  - [ ] `isFileStale(filePath)`: compute current file SHA256 hash, compare to `symbolRepo.getFileHash(filePath)`; return `true` if hash differs or stored hash is null
  - [ ] `isStale(projectRoot)`: call `metaRepo.getMeta()` and `gitClient.getCurrentSha(projectRoot)`; return `true` if meta is null or `meta.commitSha !== currentSha`
  - [ ] `incrementalUpdate(projectRoot, parser)`: get stored SHA from `metaRepo.getMeta()`; if meta is null, call `fullBootstrap` and return; call `gitClient.getChangedFiles(projectRoot, meta.commitSha)`, filter to supported extensions via `SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.py'])`; for each changed file: if file still exists on disk, parse + upsert; if deleted, call `symbolRepo.upsertFileSymbols(filePath, [], currentHash)`; on parse error, log warn and continue; after all files processed, call `metaRepo.updateMeta` with current SHA
  - [ ] `fullBootstrap(projectRoot, parser)`: call `gitClient.listTrackedFiles(projectRoot)`, filter to supported extensions; for each file parse + upsert (log warn on error, continue); call `metaRepo.updateMeta` with current SHA and parsed file count

- [ ] Task 6: Unit tests for DoltSymbolRepository and DoltRepoMapMetaRepository (AC: #2, #3)
  - [ ] Create `src/modules/repo-map/__tests__/storage.test.ts`
  - [ ] Mock `DoltClient` via constructor-injected stub: mock `query()` to return pre-set row fixtures or capture call args
  - [ ] Test `upsertFileSymbols`: verify DELETE query is called first with correct file_path param; verify INSERT is called with all symbol rows; verify no-op on empty symbols array still executes DELETE
  - [ ] Test `getSymbols()` with no filter: verify SELECT has no WHERE clause, rows mapped to ParsedSymbol correctly
  - [ ] Test `getSymbols({ filePaths: ['foo.ts'] })`: verify WHERE clause contains file_path IN (?)
  - [ ] Test `getSymbols({ kinds: ['function', 'class'] })`: verify WHERE clause contains symbol_kind IN (?)
  - [ ] Test `getFileHash`: verify correct SELECT query; returns null when empty result
  - [ ] Test `DoltRepoMapMetaRepository.updateMeta`: verify INSERT ... ON DUPLICATE KEY UPDATE query with correct params
  - [ ] Test `DoltRepoMapMetaRepository.getMeta`: returns `RepoMapMeta` on row present; returns `null` on empty result

- [ ] Task 7: Unit tests for RepoMapStorage (AC: #4, #5, #6, #7)
  - [ ] Add tests to `src/modules/repo-map/__tests__/storage.test.ts`
  - [ ] Inject stub `ISymbolRepository`, `IRepoMapMetaRepository`, `IGitClient`, and mock `fs.readFile` via `vi.mock('node:fs/promises')`
  - [ ] Test `isFileStale`: returns `false` when computed hash matches stored; returns `true` when hash differs; returns `true` when `getFileHash` returns `null`
  - [ ] Test `isStale`: returns `false` when stored SHA matches current HEAD; returns `true` when different; returns `true` when `getMeta()` returns `null`
  - [ ] Test `incrementalUpdate`: when meta is null, delegates to `fullBootstrap`; when changed files include a `.ts` file, parser is called for it; unsupported extensions are skipped; parse errors are caught and logged without abort; `metaRepo.updateMeta` called once at end
  - [ ] Test `fullBootstrap`: `listTrackedFiles` result filtered to supported extensions only; parser called for each valid file; parse errors logged and skipped; `metaRepo.updateMeta` called with correct file count and current HEAD SHA

- [ ] Task 8: Export new types and classes from index.ts (AC: #1–#7)
  - [ ] Update `src/modules/repo-map/index.ts` to also export: `DoltSymbolRepository`, `DoltRepoMapMetaRepository`, `RepoMapStorage`, `GitClient` (classes) and `ISymbolRepository`, `IRepoMapMetaRepository`, `IGitClient`, `SymbolFilter`, `RepoMapMeta` (types)
  - [ ] Run `npm run build` and confirm zero TypeScript errors
  - [ ] Run `npm run test:fast` and confirm all new tests pass with no regressions

## Dev Notes

### Architecture Constraints
- **Module location**: `src/modules/repo-map/` — new files are `storage.ts` and `git-client.ts`, co-located alongside existing `GrammarLoader.ts`, `SymbolParser.ts`, `generator.ts`
- **DoltClient dependency**: import `DoltClient` from `../../modules/state/dolt-client.js` — this is an existing class, NOT an interface. Constructor-inject it into `DoltSymbolRepository` and `DoltRepoMapMetaRepository` for testability (tests inject a mock object matching the `query()` method shape)
- **No new tables outside schema.sql**: all DDL goes in `src/modules/state/schema.sql` as append-only, version-numbered statements following the existing pattern (version 5, `INSERT IGNORE INTO _schema_version`)
- **Parameterized queries only**: all SQL in `DoltSymbolRepository` uses `?` placeholders via `DoltClient.query(sql, params)`; no string interpolation of user-supplied values
- **IN clause handling**: Dolt/MySQL2 accepts `?` placeholder for an array value in `IN (?)` — pass the array as the param and mysql2 expands it; for CLI fallback mode this needs manual expansion in `DoltClient._queryCli` (check if existing CLI mode handles arrays; if not, join array manually before passing to avoid a breaking change in DoltClient)
- **File hash**: use `import { createHash } from 'node:crypto'` and `import { readFile } from 'node:fs/promises'`; compute `createHash('sha256').update(content).digest('hex')`
- **git subprocess**: use `execFile` from `node:child_process` wrapped in a Promise (same pattern as DoltClient's `runExecFile`); always pass `{ cwd: projectRoot }` to run git commands in the project root
- **Constructor injection for ILogger**: never call `createLogger()` inside `DoltSymbolRepository`, `DoltRepoMapMetaRepository`, or `RepoMapStorage` — accept `ILogger` as a constructor parameter; callers use `createLogger('repo-map:storage')` at composition root
- **Error codes**: add to `src/errors/index.ts` using `export const ERR_X = 'ERR_X' as const`; use `AppError` directly with numeric exit code (2 for internal errors)
- **No CLI command in this story**: `substrate repo-map --generate/--update` CLI is deferred to story 1-9
- **Import order**: Node built-ins first (`node:crypto`, `node:fs/promises`, `node:child_process`, `node:path`), then third-party, then internal — blank line between groups

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
-- repo_map_symbols (story 1-2 / Epic 28-2)
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
-- repo_map_meta (story 1-2 / Epic 28-2)
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
  params.push(filePath, sym.name, sym.kind, sym.signature, sym.lineNumber, sym.exported ? 1 : 0, fileHash)
}
await this._client.query(
  `INSERT INTO repo_map_symbols (file_path, symbol_name, symbol_kind, signature, line_number, exported, file_hash) VALUES ${placeholders}`,
  params
)
```
Note: Multi-row INSERT uses string interpolation for the `VALUES` clause shape (number of `?` groups), but all actual data flows through parameterized `?` placeholders — this is safe because the shape is derived from `symbols.length` (a number, not user input).

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
Use the existing `ILogger` / `createLogger` pattern. Import from `../../utils/logger.js` following the same relative path as `src/modules/state/dolt-store.ts`. Pass `createLogger('repo-map:storage')` and `createLogger('repo-map:git')` at the composition root / in tests.

### Testing Requirements
- **Mock `DoltClient.query()`**: inject a plain object `{ query: vi.fn() }` as the client; configure mock return values via `mockResolvedValueOnce(rows)`
- **Mock `IGitClient`**: inject a plain object with `vi.fn()` properties for `getCurrentSha`, `getChangedFiles`, `listTrackedFiles`
- **Mock `ISymbolParser`**: inject a plain object with `parseFile: vi.fn()` returning pre-built `ParsedSymbol[]`
- **Mock `node:fs/promises`**: use `vi.mock('node:fs/promises', () => ({ readFile: vi.fn() }))` for `isFileStale` and `computeFileHash` tests
- **Mock `node:child_process`**: use `vi.spyOn` on `execFile` in `git-client.test.ts` to avoid real git calls
- Coverage target: ≥80% on all new files; run `npm run test:fast` to validate — no regressions allowed

## Interface Contracts

- **Import**: `ParsedSymbol` @ `src/modules/repo-map/interfaces.ts` (from story 1-1)
- **Import**: `SymbolKind` @ `src/modules/repo-map/interfaces.ts` (from story 1-1)
- **Import**: `ISymbolParser` @ `src/modules/repo-map/interfaces.ts` (from story 1-1)
- **Export**: `ISymbolRepository` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-3 query interface)
- **Export**: `IRepoMapMetaRepository` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-3)
- **Export**: `IGitClient` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-3 and story 1-9 CLI)
- **Export**: `RepoMapStorage` @ `src/modules/repo-map/storage.ts` (consumed by story 1-3 and story 1-9 CLI)
- **Export**: `SymbolFilter` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-3)
- **Export**: `RepoMapMeta` @ `src/modules/repo-map/interfaces.ts` (consumed by story 1-3)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
