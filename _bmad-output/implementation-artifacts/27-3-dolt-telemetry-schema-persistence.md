# Story 27-3: Dolt Telemetry Schema + Persistence

Status: ready-for-dev

## Story

As a substrate pipeline operator,
I want normalized telemetry events persisted in Dolt,
so that OTLP data from agent executions survives pipeline runs, supports historical querying across sprints, and replaces the in-memory circular-buffer approach used by prior OTEL tooling.

## Acceptance Criteria

### AC1: Telemetry Tables Added to Dolt Schema
**Given** the Dolt schema file at `src/modules/state/schema.sql`
**When** the DDL is applied via `dolt sql -f schema.sql`
**Then** three new tables exist — `telemetry_spans`, `telemetry_logs`, and `telemetry_metrics` — each using `CREATE TABLE IF NOT EXISTS`, composite or single natural-key primary keys, Dolt-safe column types (VARCHAR, BIGINT, DECIMAL, DATETIME, TEXT, JSON), and no AUTO_INCREMENT; a `_schema_version` row with `version = 2` is also inserted (idempotent via INSERT IGNORE)

### AC2: Batch Persistence with One Dolt Commit per Flush
**Given** a `TelemetryRepository` constructed with a `DoltClient` instance
**When** `saveBatch(batch: TelemetryBatch)` is called with a mix of normalized spans, logs, and metrics
**Then** all items are bulk-inserted using prepared parameterized statements (no per-row commits), a single `dolt add -A && dolt commit` is issued after all inserts succeed, and the method resolves without error; if DoltClient is unavailable or the commit fails, an `AppError` with code `ERR_TELEMETRY_PERSIST_FAILED` and exit code 2 is thrown

### AC3: Indexes on Key Query Dimensions
**Given** the telemetry tables have been created
**When** the schema DDL is inspected
**Then** indexes exist on: `(story_key, start_time)` for `telemetry_spans`, `(trace_id)` for `telemetry_spans`, `(model)` for `telemetry_spans`, `(source)` for `telemetry_spans`, `(story_key, timestamp)` for `telemetry_logs`, `(session_id)` for `telemetry_logs`, and `(story_key, timestamp)` for `telemetry_metrics`

### AC4: Query Helpers Return Correct Filtered Data
**Given** telemetry rows persisted via `saveBatch()`
**When** the following query helpers are called
**Then** each returns the expected subset:
- `getSpansForStory(storyKey: string)` → all `NormalizedSpan` rows where `story_key = storyKey`, ordered by `start_time ASC`
- `getLogsBySession(sessionId: string)` → all `NormalizedLog` rows where `session_id = sessionId`, ordered by `timestamp ASC`
- `getTokensByModel(dateRange: { from: string; to: string })` → aggregated `{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }[]` rows grouped by model, filtered by `start_time BETWEEN from AND to`, from `telemetry_spans`

### AC5: Retention Policy — Prune Removes Rows Older Than Max Age
**Given** a configured `maxAgeDays` (default 30) and telemetry rows with varying timestamps
**When** `prune(maxAgeDays?: number)` is called on `TelemetryRepository`
**Then** all rows older than `maxAgeDays` days are deleted from all three telemetry tables, a Dolt commit is issued with message `"telemetry: prune rows older than <N> days"`, and the method returns `{ spans: number; logs: number; metrics: number }` indicating deleted row counts per table

### AC6: `substrate telemetry prune` CLI Command
**Given** a project with Dolt initialized and telemetry tables populated
**When** `substrate telemetry prune` is run (with optional `--days <n>` flag)
**Then** the command calls `TelemetryRepository.prune(days)`, prints a summary (`Pruned <n> spans, <n> logs, <n> metrics`) in text mode or a JSON object `{ spans, logs, metrics }` in `--output-format json` mode, and exits with code 0; if no telemetry tables exist, exits with code 1 and a human-readable message

## Tasks / Subtasks

- [ ] Task 1: Extend `src/modules/state/schema.sql` with telemetry tables, indexes, and v2 schema seed (AC: #1, #3)
  - [ ] Add `telemetry_spans` table: `span_id VARCHAR(64) NOT NULL PRIMARY KEY`, `trace_id VARCHAR(64) NOT NULL`, `parent_span_id VARCHAR(64)`, `name VARCHAR(500) NOT NULL`, `source VARCHAR(50) NOT NULL`, `model VARCHAR(100)`, `provider VARCHAR(100)`, `operation_name VARCHAR(200)`, `story_key VARCHAR(100)`, `input_tokens BIGINT NOT NULL DEFAULT 0`, `output_tokens BIGINT NOT NULL DEFAULT 0`, `cache_read_tokens BIGINT NOT NULL DEFAULT 0`, `cache_creation_tokens BIGINT NOT NULL DEFAULT 0`, `cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0`, `duration_ms BIGINT NOT NULL DEFAULT 0`, `start_time DATETIME NOT NULL`, `end_time DATETIME`, `attributes_json JSON`, `events_json JSON`
  - [ ] Add `telemetry_logs` table: `log_id VARCHAR(64) NOT NULL PRIMARY KEY`, `trace_id VARCHAR(64)`, `span_id VARCHAR(64)`, `timestamp DATETIME NOT NULL`, `severity VARCHAR(20)`, `body TEXT`, `event_name VARCHAR(200)`, `session_id VARCHAR(200)`, `tool_name VARCHAR(200)`, `input_tokens BIGINT NOT NULL DEFAULT 0`, `output_tokens BIGINT NOT NULL DEFAULT 0`, `cache_read_tokens BIGINT NOT NULL DEFAULT 0`, `cost_usd DECIMAL(12,6) NOT NULL DEFAULT 0`, `model VARCHAR(100)`, `story_key VARCHAR(100)`
  - [ ] Add `telemetry_metrics` table: `metric_id VARCHAR(64) NOT NULL PRIMARY KEY`, `name VARCHAR(200) NOT NULL`, `value DECIMAL(20,6)`, `type VARCHAR(50)`, `unit VARCHAR(50)`, `timestamp DATETIME NOT NULL`, `story_key VARCHAR(100)`, `source VARCHAR(50)`, `model VARCHAR(100)`, `attributes_json JSON`
  - [ ] Add CREATE INDEX statements (after table definitions): `idx_spans_story_ts ON telemetry_spans (story_key, start_time)`, `idx_spans_trace ON telemetry_spans (trace_id)`, `idx_spans_model ON telemetry_spans (model)`, `idx_spans_source ON telemetry_spans (source)`, `idx_logs_story_ts ON telemetry_logs (story_key, timestamp)`, `idx_logs_session ON telemetry_logs (session_id)`, `idx_metrics_story_ts ON telemetry_metrics (story_key, timestamp)`
  - [ ] Add `INSERT IGNORE INTO _schema_version (version, description) VALUES (2, 'Add telemetry tables (Epic 27-3)');` at end of DDL

- [ ] Task 2: Add telemetry persistence types to `src/modules/telemetry/types.ts` (AC: #2, #5)
  - [ ] Add `NormalizedMetric` interface: `{ metricId: string; name: string; value: number; type: string; unit?: string; timestamp: number; storyKey?: string; source?: string; model?: string; attributes?: Record<string, unknown> }`
  - [ ] Add `TelemetryBatch` interface: `{ spans: NormalizedSpan[]; logs: NormalizedLog[]; metrics: NormalizedMetric[]; committedAt: number }`
  - [ ] Add `TelemetryPersistenceConfig` interface: `{ maxAgeDays?: number }` (default 30)
  - [ ] Add `PruneResult` interface: `{ spans: number; logs: number; metrics: number }`
  - [ ] Add `TokensByModelRow` interface: `{ model: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; costUsd: number }`
  - [ ] Export all new types from `src/modules/telemetry/index.ts`

- [ ] Task 3: Implement `TelemetryRepository` class in `src/modules/telemetry/persistence.ts` with constructor and `saveBatch()` (AC: #2)
  - [ ] Constructor: `new TelemetryRepository(client: DoltClient, config?: TelemetryPersistenceConfig)` — store client + config, create per-module logger `createLogger('telemetry:persistence')`
  - [ ] Implement `saveBatch(batch: TelemetryBatch): Promise<void>`:
    - [ ] Build bulk `INSERT IGNORE INTO telemetry_spans` for all spans (use `DoltClient.execute()` with parameterized values; batch into single multi-row INSERT or sequential row inserts)
    - [ ] Build bulk `INSERT IGNORE INTO telemetry_logs` for all logs
    - [ ] Build bulk `INSERT IGNORE INTO telemetry_metrics` for all metrics
    - [ ] Convert `NormalizedSpan.startTime` (epoch ms) and similar numeric timestamps to `DATETIME` strings via `new Date(ts).toISOString().replace('T', ' ').replace('Z', '')`
    - [ ] Serialize `attributes` and `events` fields to JSON strings for storage in JSON columns
    - [ ] Issue `dolt add -A` then `dolt commit -m "telemetry: persist batch of ${spans.length} spans, ${logs.length} logs, ${metrics.length} metrics"` via DoltClient
    - [ ] Wrap in try/catch; on failure throw `AppError('ERR_TELEMETRY_PERSIST_FAILED', 2, originalError.message)`

- [ ] Task 4: Implement query helpers on `TelemetryRepository` (AC: #4)
  - [ ] `getSpansForStory(storyKey: string): Promise<NormalizedSpan[]>` — SELECT all columns from `telemetry_spans WHERE story_key = ?` ORDER BY `start_time ASC`; map rows back to `NormalizedSpan` (parse JSON columns with `JSON.parse`, convert DATETIME strings back to epoch ms)
  - [ ] `getLogsBySession(sessionId: string): Promise<NormalizedLog[]>` — SELECT all columns from `telemetry_logs WHERE session_id = ?` ORDER BY `timestamp ASC`
  - [ ] `getTokensByModel(dateRange: { from: string; to: string }): Promise<TokensByModelRow[]>` — SELECT `model, SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cost_usd) FROM telemetry_spans WHERE start_time BETWEEN ? AND ? GROUP BY model`; return typed rows with camelCase field names

- [ ] Task 5: Implement `prune()` method on `TelemetryRepository` (AC: #5)
  - [ ] `prune(maxAgeDays?: number): Promise<PruneResult>` — compute cutoff as `new Date(Date.now() - (maxAgeDays ?? this.config.maxAgeDays ?? 30) * 86400_000)`
  - [ ] Execute `DELETE FROM telemetry_spans WHERE start_time < ?` and capture affected-row count (use `DoltClient.execute()` return value or subsequent COUNT query)
  - [ ] Execute `DELETE FROM telemetry_logs WHERE timestamp < ?` and capture count
  - [ ] Execute `DELETE FROM telemetry_metrics WHERE timestamp < ?` and capture count
  - [ ] Issue `dolt add -A && dolt commit -m "telemetry: prune rows older than <N> days"` only if any rows were deleted (skip commit if all counts are 0)
  - [ ] Return `{ spans, logs, metrics }` counts

- [ ] Task 6: Add `substrate telemetry prune` CLI command (AC: #6)
  - [ ] Create `src/cli/commands/telemetry.ts` with `export function register(program: Command): void`
  - [ ] Register a `telemetry` commander sub-command with a `prune` sub-subcommand: `program.command('telemetry').command('prune').option('--days <n>', 'max age in days', '30').option('--output-format <fmt>', 'output format: text|json', 'text')`
  - [ ] In the prune action handler: instantiate `DoltClient` and `TelemetryRepository`, call `prune(parseInt(days, 10))`, output result per `--output-format` flag
  - [ ] On text output: print `Pruned ${result.spans} spans, ${result.logs} logs, ${result.metrics} metrics`
  - [ ] On JSON output: `process.stdout.write(JSON.stringify(result) + '\n')`
  - [ ] On error (e.g. table does not exist, Dolt unavailable): catch `AppError`, write error to stderr, `process.exit(1)`
  - [ ] Register in `src/cli/index.ts`: import `{ register as registerTelemetryCommand } from './commands/telemetry.js'` and call `registerTelemetryCommand(program)` in the `registerAll` function

- [ ] Task 7: Unit tests for `TelemetryRepository` in `src/modules/telemetry/__tests__/persistence.test.ts` (AC: #2, #4, #5)
  - [ ] Mock `DoltClient` as a stub implementing `execute(sql, params)` and `run(cmd, args)` — use `vi.fn()` stubs injected via constructor
  - [ ] Test `saveBatch()`: spans rows inserted, logs rows inserted, metrics rows inserted, Dolt commit issued with correct message, method resolves
  - [ ] Test `saveBatch()` error path: DoltClient throws → `AppError` with `ERR_TELEMETRY_PERSIST_FAILED` re-thrown
  - [ ] Test `getSpansForStory()`: mock `execute` returns row array → mapped to `NormalizedSpan[]` with correct field names
  - [ ] Test `getLogsBySession()`: mock returns rows → mapped to `NormalizedLog[]`
  - [ ] Test `getTokensByModel()`: mock returns aggregate rows → `TokensByModelRow[]` with correct numeric types
  - [ ] Test `prune()` with deletions: mock returns affected counts → correct `PruneResult`, Dolt commit issued
  - [ ] Test `prune()` with zero deletions: commit NOT issued (no-op)
  - [ ] Test schema content: read `schema.sql` with real `fs.readFile`, assert all three telemetry table names present, assert `version = 2` seed present, assert no AUTO_INCREMENT, assert INDEX statements present

## Dev Notes

### Architecture Constraints
- **DoltClient dependency**: `TelemetryRepository` takes a `DoltClient` instance via constructor injection. Do not import `DoltStateStore` directly — telemetry persistence is a parallel concern, not a StateStore extension.
- **ESM imports**: All imports must use `.js` extension suffix (e.g., `import { DoltClient } from '../state/dolt-client.js'`).
- **Import order**: Node built-ins first, then third-party, then internal (relative) — blank line between groups.
- **Logging**: Use `createLogger('telemetry:persistence')` — never `console.log`. Import from `../../utils/logger.js`.
- **Error codes**: Add `ERR_TELEMETRY_PERSIST_FAILED` to the existing error codes catalogue in `src/errors/` following the exact same pattern as `ERR_TELEMETRY_PORT_CONFLICT` from story 27-1.
- **SQL safety**: All query parameters must use parameterized binding via `DoltClient.execute(sql, params[])`. Dynamic identifiers are NOT used here (all table/column names are compile-time constants).
- **Dolt merge safety**: Primary keys for telemetry tables use natural business keys (`span_id`, `log_id`, `metric_id`) — UUIDs or hash-based identifiers generated by the normalizer. No AUTO_INCREMENT.
- **Datetime format**: Dolt MySQL wire protocol expects `'YYYY-MM-DD HH:MM:SS'` format for DATETIME columns. Convert epoch ms timestamps using: `new Date(ts).toISOString().replace('T', ' ').slice(0, 19)`.
- **JSON columns**: Serialize `attributes` and `events` objects to JSON strings with `JSON.stringify(value ?? null)`. Deserialize on read with `JSON.parse(row.attributes_json ?? 'null')`.
- **CLI command file**: `src/cli/commands/telemetry.ts` — uses Commander.js nested subcommand pattern (`program.command('telemetry')` → `.command('prune')`). Must follow the `register(program: Command)` export pattern used by all other command files.
- **No mysql2 direct imports**: Use `DoltClient` abstraction — it handles mysql2 internally (from story 26-3). Import `DoltClient` type from `../../modules/state/dolt-client.js`.

### File Paths
```
src/modules/state/schema.sql              ← MODIFY: add 3 telemetry tables + indexes + v2 seed
src/modules/telemetry/
  types.ts                                ← MODIFY: add NormalizedMetric, TelemetryBatch, PruneResult, etc.
  persistence.ts                          ← NEW: TelemetryRepository class
  index.ts                                ← MODIFY: export new public types
  __tests__/
    persistence.test.ts                   ← NEW: unit tests
src/cli/commands/telemetry.ts             ← NEW: telemetry prune CLI command
src/cli/index.ts                          ← MODIFY: register telemetry command
src/errors/                               ← MODIFY: add ERR_TELEMETRY_PERSIST_FAILED
```

### DoltClient Usage Pattern
Look at `src/modules/state/dolt-store.ts` for the exact `DoltClient` API pattern. The relevant methods are:
```typescript
// Execute a parameterized SQL query, returns array of row objects
client.execute<T>(sql: string, params?: unknown[]): Promise<T[]>

// Run a dolt CLI command (e.g. ['add', '-A'], ['commit', '-m', 'msg'])
client.run(args: string[]): Promise<void>
```

### Bulk INSERT Pattern
For batch inserts, build a single multi-row INSERT statement to minimize round-trips:
```typescript
// Example for spans (simplified):
const placeholders = spans.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ')
const sql = `INSERT IGNORE INTO telemetry_spans (span_id, trace_id, ...) VALUES ${placeholders}`
const params = spans.flatMap(s => [s.spanId, s.traceId, ...])
await client.execute(sql, params)
```
If the batch is empty for a given type, skip the INSERT entirely.

### Schema Extension Pattern
Follow the exact pattern established in `schema.sql` for existing tables:
```sql
-- ---------------------------------------------------------------------------
-- telemetry_spans
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS telemetry_spans (
  span_id           VARCHAR(64)    NOT NULL,
  ...
  PRIMARY KEY (span_id)
);

CREATE INDEX IF NOT EXISTS idx_spans_story_ts ON telemetry_spans (story_key, start_time);
```
Note: Dolt supports `CREATE INDEX IF NOT EXISTS` — use it to keep idempotency.

### Testing Requirements
- **Test framework**: vitest — `import { describe, it, expect, vi, beforeEach } from 'vitest'`; NO jest APIs
- **Mock strategy**: `vi.fn()` injected stubs for `DoltClient` — do NOT import real DoltClient or mysql2 in unit tests
- **Schema test**: use real `fs.readFile` to read `src/modules/state/schema.sql` and assert expected content — do NOT mock this
- **Coverage**: achieve ≥80% line coverage on `persistence.ts`
- **No real Dolt binary**: unit tests must work without Dolt installed; integration tests (if added) should use `port: 0` or be tagged with a skip guard

## Interface Contracts

- **Import**: `NormalizedSpan` @ `src/modules/telemetry/types.ts` (from story 27-2 normalization engine)
- **Import**: `NormalizedLog` @ `src/modules/telemetry/types.ts` (from story 27-2 normalization engine)
- **Import**: `BatchFlushEvent` @ `src/modules/telemetry/types.ts` (from story 27-1 ingestion server)
- **Import**: `DoltClient` @ `src/modules/state/dolt-client.ts` (from Epic 26)
- **Export**: `NormalizedMetric` @ `src/modules/telemetry/types.ts` (consumed by story 27-4 turn analysis, 27-5 categorizer)
- **Export**: `TelemetryBatch` @ `src/modules/telemetry/types.ts` (consumed by story 27-4 and 27-5)
- **Export**: `TelemetryRepository` @ `src/modules/telemetry/persistence.ts` (consumed by story 27-4, 27-5, 27-6, 27-9)
- **Export**: `PruneResult` @ `src/modules/telemetry/types.ts` (consumed by story 27-8 CLI)
- **Export**: `TokensByModelRow` @ `src/modules/telemetry/types.ts` (consumed by story 27-8 CLI)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
