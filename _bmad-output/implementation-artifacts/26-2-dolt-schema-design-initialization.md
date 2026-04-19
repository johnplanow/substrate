# Story 26-2: Dolt Schema Design + Initialization

Status: complete

## Story

As a pipeline operator,
I want a well-designed Dolt relational schema and a reliable initialization flow,
so that the Dolt backend has a stable, versioned foundation before any CRUD operations begin.

## Acceptance Criteria

### AC1: SQL DDL Schema File
**Given** the state module at `src/modules/state/`
**When** the file `src/modules/state/schema.sql` is loaded
**Then** it defines seven tables — `stories`, `contracts`, `metrics`, `dispatch_log`, `build_results`, `review_verdicts`, and `_schema_version` — each using `CREATE TABLE IF NOT EXISTS`, composite primary keys (no `AUTO_INCREMENT`), and conflict-safe column types (VARCHAR, BIGINT, DECIMAL, DATETIME, TEXT, JSON)

### AC2: `substrate init --dolt` Command
**Given** the Dolt CLI is installed and accessible in PATH
**When** `substrate init --dolt` is run in a project directory
**Then** a Dolt repo is created at `.substrate/state/`, the DDL from `schema.sql` is applied, and an initial commit with message `"Initialize substrate state schema v1"` is created; the CLI prints `✓ Dolt state database initialized at .substrate/state/` on success

### AC3: Dolt Merge-Safe Schema Design
**Given** two story branches both write to the same tables concurrently
**When** Dolt merges those branches into main
**Then** all primary keys are composite business-key composites (e.g., `PRIMARY KEY (story_key, task_type, recorded_at)`), no `AUTO_INCREMENT` columns exist, and all column types are deterministic and merge-friendly

### AC4: Schema Versioning
**Given** `substrate init --dolt` has completed successfully
**When** `SELECT * FROM _schema_version` is executed against the Dolt repo
**Then** one row exists with `version = 1`, a populated `applied_at` timestamp, and `description = 'Initial substrate state schema'`

### AC5: Idempotent Initialization
**Given** `substrate init --dolt` has already been run successfully
**When** `substrate init --dolt` is run a second time
**Then** no error is thrown, no existing data is lost, `dolt init` is skipped (`.dolt/` directory already exists), `IF NOT EXISTS` guards prevent table re-creation, and the command exits with status 0

### AC6: Error Handling — Dolt Not Installed
**Given** the `dolt` binary is not found in PATH
**When** `substrate init --dolt` is run
**Then** a `DoltNotInstalled` error is thrown with a message containing `"Dolt CLI not found"` and a reference to `https://docs.dolthub.com/introduction/installation`; the CLI prints the error and exits with code 1

### AC7: Unit Tests and Schema Content Validation
**Given** tests in `src/modules/state/__tests__/dolt-init.test.ts`
**When** `npm run test:fast` is run
**Then** all tests pass: successful init flow (mocked `child_process`), idempotency (second call skips `dolt init`), `DoltNotInstalled` error on ENOENT, and schema file content validation (all 7 table names present, no `AUTO_INCREMENT`, each table has `PRIMARY KEY`)

## Tasks / Subtasks

- [ ] Task 1: Write `src/modules/state/schema.sql` — complete DDL for all seven tables (AC: #1, #3, #4)
  - [ ] Define `stories` table with `PRIMARY KEY (story_key)`, columns: `sprint VARCHAR(50)`, `status VARCHAR(30) DEFAULT 'PENDING'`, `phase VARCHAR(30) DEFAULT 'PENDING'`, `ac_results JSON`, `error_message TEXT`, `created_at DATETIME`, `updated_at DATETIME`, `completed_at DATETIME`
  - [ ] Define `contracts` table with `PRIMARY KEY (story_key, name, direction)`, columns: `schema_path VARCHAR(500)`, `transport VARCHAR(200)`, `recorded_at DATETIME`
  - [ ] Define `metrics` table with `PRIMARY KEY (story_key, task_type, recorded_at)`, columns: `model VARCHAR(100)`, `tokens_in BIGINT DEFAULT 0`, `tokens_out BIGINT DEFAULT 0`, `cache_read_tokens BIGINT DEFAULT 0`, `cost_usd DECIMAL(10,6) DEFAULT 0`, `wall_clock_ms BIGINT DEFAULT 0`, `review_cycles INT DEFAULT 0`, `stall_count INT DEFAULT 0`, `result VARCHAR(30)`
  - [ ] Define `dispatch_log` with `PRIMARY KEY (story_key, dispatched_at)`, columns: `branch VARCHAR(200)`, `worker_id VARCHAR(100)`, `result VARCHAR(30)`
  - [ ] Define `build_results` with `PRIMARY KEY (story_key, timestamp)`, columns: `command VARCHAR(500)`, `exit_code INT`, `stdout_hash VARCHAR(64)`
  - [ ] Define `review_verdicts` with `PRIMARY KEY (story_key, timestamp)`, columns: `verdict VARCHAR(30)`, `issues_count INT DEFAULT 0`, `notes TEXT`
  - [ ] Define `_schema_version` with `PRIMARY KEY (version)`, columns: `applied_at DATETIME DEFAULT CURRENT_TIMESTAMP`, `description VARCHAR(500)`
  - [ ] Add `INSERT IGNORE INTO _schema_version (version, description) VALUES (1, 'Initial substrate state schema')` at end of DDL

- [ ] Task 2: Implement `src/modules/state/dolt-init.ts` — DoltInitializer logic (AC: #2, #5, #6)
  - [ ] Define and export `DoltInitConfig` interface: `{ projectRoot: string; statePath?: string; schemaPath?: string }`
  - [ ] Define and export `DoltNotInstalled extends Error` and `DoltInitError extends Error` error classes
  - [ ] Implement `checkDoltInstalled(): Promise<void>` — spawns `dolt version`, catches ENOENT and throws `DoltNotInstalled` with install URL
  - [ ] Implement helper `runDoltCommand(args: string[], cwd: string): Promise<void>` — spawns `dolt` with given args, rejects with `DoltInitError` on non-zero exit
  - [ ] Implement `initializeDolt(config: DoltInitConfig): Promise<void>`:
    - [ ] Resolve `statePath` (default: `path.join(config.projectRoot, '.substrate', 'state')`) and `schemaPath` (default: `fileURLToPath(new URL('./schema.sql', import.meta.url))`)
    - [ ] Call `checkDoltInstalled()`
    - [ ] Create `statePath` directory with `fs.mkdir(statePath, { recursive: true })`
    - [ ] Check if `path.join(statePath, '.dolt')` exists; if not, call `runDoltCommand(['init'], statePath)`
    - [ ] Call `runDoltCommand(['sql', '-f', schemaPath], statePath)` to apply DDL (idempotent via `IF NOT EXISTS` / `INSERT IGNORE`)
    - [ ] Check if any commits exist via `runDoltCommand(['log', '--oneline'], statePath)`; if none, call `runDoltCommand(['add', '-A'], statePath)` then `runDoltCommand(['commit', '-m', 'Initialize substrate state schema v1'], statePath)`

- [ ] Task 3: Modify `src/cli/commands/init.ts` — add `--dolt` flag (AC: #2, #5, #6)
  - [ ] Import `initializeDolt` from `../../modules/state/dolt-init.js` and `DoltNotInstalled` from same
  - [ ] Add `.option('--dolt', 'Initialize Dolt state database in .substrate/state/')` to the commander command definition
  - [ ] When `--dolt` is set, call `initializeDolt({ projectRoot: process.cwd() })` inside a try/catch
  - [ ] On success: print `✓ Dolt state database initialized at .substrate/state/` and exit 0
  - [ ] On `DoltNotInstalled`: print the error message and `process.exit(1)`
  - [ ] On other errors: print `✗ Dolt initialization failed: <message>` and `process.exit(1)`

- [ ] Task 4: Update `src/modules/state/index.ts` exports (AC: #2)
  - [ ] Add export: `export { initializeDolt, DoltInitConfig, DoltNotInstalled, DoltInitError } from './dolt-init.js'`
  - [ ] (26-1 already exports `StateStore`, `FileStateStore`, `createStateStore` — do not duplicate)

- [ ] Task 5: Write unit tests `src/modules/state/__tests__/dolt-init.test.ts` (AC: #7)
  - [ ] Mock `node:child_process` with `vi.mock` — provide a factory returning a mock `spawn` that emits `close` with configurable exit codes
  - [ ] Mock `node:fs/promises` for `mkdir` and `access` calls
  - [ ] Test: `checkDoltInstalled()` resolves when mock exits 0; throws `DoltNotInstalled` when mock throws ENOENT
  - [ ] Test: `initializeDolt()` first-run — verifies `dolt init`, `dolt sql -f`, `dolt add -A`, `dolt commit` are all called in order
  - [ ] Test: `initializeDolt()` idempotency — when `.dolt/` exists (mock `access` resolves), `dolt init` is NOT called; `dolt sql -f` and commit check still run
  - [ ] Test: `initializeDolt()` propagates `DoltInitError` when any Dolt command exits non-zero

- [ ] Task 6: Write schema content validation test (AC: #1, #3, #4)
  - [ ] Add a describe block to the test file (or a separate `schema.test.ts`) that reads `schema.sql` with real `fs.readFile`
  - [ ] Assert all 7 table names are present: `stories`, `contracts`, `metrics`, `dispatch_log`, `build_results`, `review_verdicts`, `_schema_version`
  - [ ] Assert `AUTO_INCREMENT` does not appear anywhere in the DDL
  - [ ] Assert each table name is followed by a `PRIMARY KEY` clause within the same CREATE TABLE block
  - [ ] Assert `INSERT IGNORE INTO _schema_version` is present with version `1`

- [ ] Task 7: Verify `npm run test:fast` passes with zero regressions (AC: #7)
  - [ ] Run `npm run test:fast` and confirm all new tests pass
  - [ ] Confirm no pre-existing tests are broken by the `init.ts` modification (mock Dolt path in init tests)

## Dev Notes

### Architecture Constraints
- **ESM imports**: all imports must use `.js` extension suffix (e.g., `import { initializeDolt } from './dolt-init.js'`)
- **child_process**: use `node:child_process` `spawn` (not `exec`) — enables streaming stdout/stderr and proper exit code handling via `close` event
- **Schema path resolution**: use `fileURLToPath(new URL('./schema.sql', import.meta.url))` to locate `schema.sql` relative to `dolt-init.ts` at runtime — do NOT use `__dirname` (ESM)
- **No mysql2 in this story**: Story 26-3 adds mysql2 for CRUD operations. This story uses only Dolt CLI (`dolt init`, `dolt sql -f`, `dolt add`, `dolt commit`, `dolt log`)
- **Strict TypeScript**: no implicit `any`, all parameters and return types explicitly typed
- **26-1 prerequisite**: `src/modules/state/types.ts` and `src/modules/state/index.ts` already exist from story 26-1; do not overwrite them — only add exports

### File Paths
- `src/modules/state/schema.sql` — **new file**, SQL DDL for all tables
- `src/modules/state/dolt-init.ts` — **new file**, initialization logic and error classes
- `src/modules/state/index.ts` — **modify** (pre-existing from 26-1), add new exports
- `src/cli/commands/init.ts` — **modify** (pre-existing), add `--dolt` flag
- `src/modules/state/__tests__/dolt-init.test.ts` — **new test file**

### Dolt Merge-Safety Design Rules
- All primary keys must be composite natural keys — no `INT AUTO_INCREMENT` or `SERIAL`
- Use `DATETIME` columns (not `TIMESTAMP`) to avoid timezone-dependent merge conflicts in Dolt
- Use `JSON` for complex nested data (e.g., `ac_results`) — Dolt stores JSON as text and merges at row level
- Use `INSERT IGNORE` (not `INSERT OR IGNORE` — that is SQLite syntax; Dolt uses MySQL wire protocol)
- `VARCHAR` lengths should be generous: 500 for paths, 200 for names, 100 for IDs

### Dolt CLI Reference
```bash
# Check installation
dolt version

# Initialize a Dolt repo (run in target directory)
dolt init

# Apply DDL from file
dolt sql -f schema.sql

# Stage all and commit
dolt add -A
dolt commit -m "message"

# Check existing commit count (for idempotency)
dolt log --oneline
```

### Testing Requirements
- **Test framework**: vitest — import `describe`, `it`, `expect`, `vi`, `beforeEach` from `'vitest'`; do NOT use jest APIs
- **Mock strategy**: `vi.mock('node:child_process')` and `vi.mock('node:fs/promises')` — return mock `spawn` that emits `close` event with configurable `code` value
- **No real Dolt binary**: all Dolt CLI calls must be mocked in unit tests; schema content validation uses real `fs.readFile` only
- **Coverage**: achieve ≥80% on `dolt-init.ts` — the global threshold is enforced at 80%
- **init.ts test isolation**: if existing init tests exist, ensure they pass by checking they don't trigger the new `--dolt` path unintentionally

## Interface Contracts

- **Import**: `StateStore`, `StoryState`, `StoryFilter` @ `src/modules/state/types.ts` (from story 26-1)
- **Export**: `DoltInitConfig` @ `src/modules/state/dolt-init.ts` (consumed by story 26-3 for DoltStateStore constructor)
- **Export**: `DoltNotInstalled`, `DoltInitError` @ `src/modules/state/dolt-init.ts` (consumed by story 26-3 and 26-4)
- **Export**: `schema.sql` @ `src/modules/state/schema.sql` (consumed by story 26-3 — DoltStateStore uses same file for re-initialization)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
