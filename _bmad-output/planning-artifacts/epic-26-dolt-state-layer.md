# Epic 26: Dolt State Layer

**Status: IN PROGRESS — Sprints 1-3 COMPLETE, Sprint 4 PLANNED**

## Vision

Replace substrate's scattered file-based state management (JSON status files, in-memory orchestrator state, YAML configs, flat-file metrics) with Dolt — a version-controlled, SQL-queryable database that provides git semantics on structured data. Every pipeline state mutation becomes a commit on a Merkle DAG. Story execution forks branches. Rollback is checkout. Cross-story state is a SQL query.

Source: Integrated Synthesis report (March 2026 Multi-Agent Research Council), cross-project pipeline findings (v0.2.29, v0.2.31), Epic 25 contract verification limitations, "Beads" SQLite task tracker pattern from Stripe/Gas Town research.

## Scope

### In Scope

- StateStore abstraction: clean interface (`getStoryState`, `setStoryState`, `queryContracts`, `recordMetric`, `branchForStory`, `mergeStory`, `diffStory`) with pluggable backends
- Dolt backend implementation: uses `mysql2` for SQL queries, `dolt` CLI for branch/merge/diff operations
- File-based fallback backend: wraps existing behavior behind the same interface (zero regression path)
- Migration of pipeline state: story status, AC verification results, dispatch ordering, conflict detection state
- Migration of pipeline metrics: token counts, cost, wall-clock time, review cycles, stall rate (currently flat files)
- Migration of contract verification: contract declarations, dependency graph, verification results (currently in-memory + decision store)
- Branch-per-story execution model: each story dispatched on a Dolt branch, merged to main on completion, rolled back on failure
- Status endpoint migration: `substrate status` reads from Dolt instead of JSON files
- Schema definition: SQL DDL for all state tables (stories, contracts, metrics, dispatch_log, build_results, review_verdicts)
- Dolt initialization: `substrate init` creates a Dolt repo in the project's `.substrate/` directory
- Auto-detection: `createStateStore` automatically uses Dolt when binary is present, falls back to file
- CLI degraded-mode hints: `diff`/`history` commands inform user when Dolt is not installed
- SQLite → Dolt migration: one-shot migration tool for existing metrics/contracts data

### Out of Scope

- OTEL telemetry storage (Epic 27)
- Repo-map / tree-sitter integration (Epic 28)
- Model routing (Epic 28)
- TUI enhancements (frozen)
- Dolt server mode (start with CLI-based queries; server mode is a future optimization)
- Remote Dolt collaboration (push/pull to DoltHub — future)
- Making Dolt the hard default / removing SQLite dependency (Epic 29)

## Story Map

```
Sprint 1 — Foundation (P0): ✅ COMPLETE
  Story 26-1: StateStore Interface + File-Based Backend (P0, M) ✅
  Story 26-2: Dolt Schema Design + Initialization (P0, M) ✅
  Story 26-3: Dolt Backend — Core CRUD Operations (P0, L) ✅

Sprint 2 — Pipeline State Migration (P0): ✅ COMPLETE
  Story 26-4: Orchestrator State Migration (P0, L) ✅
  Story 26-5: Pipeline Metrics Migration (P0, M) ✅
  Story 26-6: Contract Verification Migration (P1, M) ✅

Sprint 3 — Branch Model + CLI Integration (P0/P1): ✅ COMPLETE
  Story 26-7: Branch-Per-Story Execution Model (P0, L) ✅
  Story 26-8: Status + Health CLI Migration (P1, M) ✅
  Story 26-9: Dolt Diff + History Commands (P2, S) ✅

Sprint 4 — UX Completion + Migration (P0/P1): PLANNED
  Story 26-10: Auto-Detection in createStateStore (P0, S)
  Story 26-11: substrate init Dolt Bootstrapping (P0, S)
  Story 26-12: CLI Degraded-Mode Hints (P1, S)
  Story 26-13: SQLite → Dolt Migration Command (P1, M)
```

## Story Details

### Story 26-1: StateStore Interface + File-Based Backend (P0, M)

**Problem:** Pipeline state is accessed directly through scattered file reads, in-memory objects, and JSON serialization across 8+ modules. There's no abstraction — every module knows the storage format. This makes any state layer change a full rewrite.

**Acceptance Criteria:**
- AC1: `StateStore` interface defined in `src/modules/state/types.ts` with methods: `getStoryState(storyKey)`, `setStoryState(storyKey, state)`, `queryStories(filter)`, `recordMetric(metric)`, `queryMetrics(filter)`, `getContracts(storyKey)`, `setContracts(storyKey, contracts)`, `branchForStory(storyKey)`, `mergeStory(storyKey)`, `rollbackStory(storyKey)`, `diffStory(storyKey)`, `initialize()`, `close()`
- AC2: `FileStateStore` implementation wraps existing file-based behavior behind the interface — reads/writes the same JSON/YAML files the current code uses
- AC3: `createStateStore(config)` factory function selects backend based on config (`backend: 'file' | 'dolt'`, default `'file'`)
- AC4: All existing tests pass with FileStateStore (zero behavioral change)
- AC5: Interface includes TypeScript generics for type-safe state queries: `queryStories<T extends StoryFilter>(filter: T): Promise<StoryState[]>`

**Files:** new `src/modules/state/types.ts`, new `src/modules/state/file-store.ts`, new `src/modules/state/index.ts`

### Story 26-2: Dolt Schema Design + Initialization (P0, M)

**Problem:** Before the Dolt backend can store anything, we need a well-designed relational schema that covers all pipeline state, and an initialization flow that creates the Dolt repo and tables.

**Acceptance Criteria:**
- AC1: SQL DDL schema defined in `src/modules/state/schema.sql` covering tables: `stories` (key, status, sprint, ac_results, timestamps), `contracts` (story_key, name, direction, schema_path, transport), `metrics` (story_key, task_type, tokens_in, tokens_out, cache_read, cost_usd, wall_clock_ms, review_cycles), `dispatch_log` (story_key, dispatched_at, branch, worker_id, result), `build_results` (story_key, command, exit_code, stdout_hash, timestamp), `review_verdicts` (story_key, verdict, issues_count, notes, timestamp)
- AC2: `substrate init --dolt` creates a Dolt repo at `.substrate/state/`, runs the DDL, and creates an initial commit
- AC3: Schema supports Dolt's merge semantics: primary keys on all tables, no auto-increment (use story_key composites), conflict-safe column types
- AC4: Schema version tracked in a `_schema_version` table for future migrations
- AC5: Init is idempotent — running twice doesn't error or lose data

**Files:** new `src/modules/state/schema.sql`, new `src/modules/state/dolt-init.ts`, modification to `src/cli/commands/init.ts`

### Story 26-3: Dolt Backend — Core CRUD Operations (P0, L)

**Problem:** The StateStore interface needs a Dolt implementation that handles CRUD operations via SQL queries using the `mysql2` driver and Dolt CLI.

**Acceptance Criteria:**
- AC1: `DoltStateStore` implements the full `StateStore` interface
- AC2: SQL queries use `mysql2` via `dolt sql-server` running on a local unix socket (not TCP — avoids port conflicts)
- AC3: Fallback: if `dolt sql-server` is not running, queries execute via `dolt sql -q "..."` CLI (slower but no server dependency)
- AC4: All CRUD operations are covered: insert, update, select with filters, delete (for rollback)
- AC5: Contract test suite (shared with FileStateStore) passes against DoltStateStore
- AC6: Dolt commit after each write batch (not per-row — batched for performance)
- AC7: Error handling: DoltStateStore throws typed errors (`DoltNotInitialized`, `DoltQueryError`, `DoltMergeConflict`) that callers can catch

**Files:** new `src/modules/state/dolt-store.ts`, new `src/modules/state/dolt-client.ts`, shared contract tests

### Story 26-4: Orchestrator State Migration (P0, L)

**Problem:** The implementation orchestrator (`src/modules/implementation-orchestrator/`) manages story lifecycle state in memory and writes JSON status files. This is the highest-value migration target — it's the core pipeline state.

**Acceptance Criteria:**
- AC1: `OrchestratorImpl` accepts a `StateStore` via dependency injection (constructor parameter)
- AC2: All story state transitions (PENDING → DISPATCHED → IN_PROGRESS → REVIEW → COMPLETE/FAILED/ESCALATED) write through StateStore
- AC3: Status queries (`getStoryStatus`, `getPipelineStatus`) read from StateStore instead of in-memory maps
- AC4: Decision store entries (prior findings, review results) migrate to StateStore
- AC5: Existing JSON status file writes removed when Dolt backend is active (kept for file backend)
- AC6: All orchestrator tests pass against both backends

**Files:** `src/modules/implementation-orchestrator/orchestrator-impl.ts`, related test files

### Story 26-5: Pipeline Metrics Migration (P0, M)

**Problem:** Pipeline metrics (Epic 24-4) write to flat files. Metrics are not queryable across runs — you can't answer "what was the average token cost per story across the last 3 sprints?" without parsing multiple files.

**Acceptance Criteria:**
- AC1: `PipelineMetrics` module writes through StateStore.recordMetric() instead of file writes
- AC2: Metrics include: story_key, task_type, model, tokens_in, tokens_out, cache_read_tokens, cost_usd, wall_clock_ms, review_cycles, stall_count, result
- AC3: `substrate metrics` CLI command queries Dolt for historical metrics with filters (by sprint, by story, by task_type, by date range)
- AC4: Aggregation queries work: `AVG(cost_usd) GROUP BY task_type`, `SUM(tokens_in) WHERE sprint = 'sprint-3'`
- AC5: Backward compatible: file backend still writes flat files as before

**Files:** `src/modules/pipeline-metrics/`, `src/cli/commands/metrics.ts`

### Story 26-6: Contract Verification Migration (P1, M)

**Problem:** Contract declarations (Epic 25-4) and verification results (Epic 25-6) are stored in the decision store (in-memory + JSON). Moving to Dolt enables SQL queries like "which stories have unverified contracts?" and "what contracts changed between sprints?"

**Acceptance Criteria:**
- AC1: Contract declarations (exports/imports) write to the `contracts` table via StateStore
- AC2: Contract dependency graph is built from SQL query instead of in-memory traversal
- AC3: Contract verification results stored with timestamp, enabling historical comparison
- AC4: `substrate contracts` CLI command shows contract status (query from Dolt)
- AC5: Dolt diff shows contract changes between story branches and main

**Files:** `src/modules/implementation-orchestrator/contract-verifier.ts`, `src/modules/compiled-workflows/create-story.ts`

### Story 26-7: Branch-Per-Story Execution Model (P0, L)

**Problem:** Parallel story execution currently shares a single state space. Cross-contamination between stories (v0.2.23 finding) can corrupt state. Dolt branches provide isolated state per story with structured merge on completion.

**Acceptance Criteria:**
- AC1: Before dispatching a story, orchestrator calls `stateStore.branchForStory(storyKey)` which creates a Dolt branch `story/{storyKey}`
- AC2: All state writes during story execution target the story branch
- AC3: On story COMPLETE, `stateStore.mergeStory(storyKey)` merges the story branch into main with a Dolt commit message
- AC4: On story FAILED/ESCALATED, `stateStore.rollbackStory(storyKey)` drops the branch (state is not merged)
- AC5: Merge conflicts (two stories writing the same row) are detected and surfaced as `DoltMergeConflict` errors with cell-level detail
- AC6: `stateStore.diffStory(storyKey)` returns a structured diff of all state changes on that branch vs. main
- AC7: Parallel story execution uses separate branches — verified by integration test running 3 stories concurrently

**Files:** `src/modules/state/dolt-store.ts` (branch/merge methods), `src/modules/implementation-orchestrator/orchestrator-impl.ts`

### Story 26-8: Status + Health CLI Migration (P1, M)

**Problem:** `substrate status` and `substrate health` read from JSON files and in-memory state. With Dolt, they should query the database for a single source of truth.

**Acceptance Criteria:**
- AC1: `substrate status` queries StateStore for story states, rendering the same output format
- AC2: `substrate status --output-format json` returns structured JSON from Dolt queries
- AC3: `substrate health` includes Dolt connectivity check (is the repo initialized? is it responsive?)
- AC4: New flag: `substrate status --history` shows status changes over time (Dolt commit log)
- AC5: Backward compatible: when file backend is active, behavior is unchanged

**Files:** `src/cli/commands/status.ts`, `src/cli/commands/health.ts`

### Story 26-9: Dolt Diff + History Commands (P2, S)

**Problem:** Pipeline state changes are invisible — you can't see what changed during a story execution or compare state across sprints. Dolt's diff and log capabilities make this trivial.

**Acceptance Criteria:**
- AC1: `substrate diff <storyKey>` shows all state changes made during that story's execution (Dolt diff between branch point and merge commit)
- AC2: `substrate history` shows pipeline state commits with timestamps and story keys (Dolt log)
- AC3: `substrate diff --sprint <sprint>` shows aggregate state changes across an entire sprint
- AC4: Output formats: human-readable (default) and `--output-format json`

**Files:** new `src/cli/commands/diff.ts`, new `src/cli/commands/history.ts`, `src/cli/index.ts`

### Story 26-10: Auto-Detection in createStateStore (P0, S)

**Status: PLANNED**

**Problem:** Users must explicitly set `backend: 'dolt'` in config to use the Dolt backend. If someone has Dolt installed, they clearly want substrate to use it. The factory should detect the Dolt binary and a valid repo, and use Dolt automatically — falling back to file when Dolt isn't available.

**Acceptance Criteria:**
- AC1: `createStateStore()` with no config (or `backend: 'auto'`) calls `checkDoltInstalled()`. If Dolt is on PATH and a repo exists at the expected state directory, returns `DoltStateStore`; otherwise returns `FileStateStore`
- AC2: `StateStoreConfig.backend` type updated to `'file' | 'dolt' | 'auto'`, default remains `'file'` for backward compatibility (Epic 29 flips this to `'auto'`)
- AC3: Explicit `backend: 'file'` or `backend: 'dolt'` still works as before — auto-detection only applies to `'auto'`
- AC4: Auto-detection logged at debug level: "Dolt detected, using DoltStateStore" or "Dolt not found, using FileStateStore"
- AC5: Unit tests cover: Dolt present → DoltStateStore, Dolt absent → FileStateStore, explicit overrides honored

**Files:** `src/modules/state/index.ts`, `src/modules/state/types.ts`, `src/modules/state/__tests__/index.test.ts`

### Story 26-11: substrate init Dolt Bootstrapping (P0, S)

**Status: PLANNED**

**Problem:** When a user installs Dolt and runs `substrate init`, the init process should automatically create a Dolt repo in the state directory. Currently `substrate init --dolt` is required. If the binary is present, bootstrapping should be automatic.

**Acceptance Criteria:**
- AC1: `substrate init` detects Dolt on PATH. If present, automatically runs `dolt init` in the project's `.substrate/state/` directory, runs DDL migrations, and creates an initial commit
- AC2: If Dolt is not on PATH, init skips Dolt setup silently (no error, no warning — file backend will be used)
- AC3: If `.substrate/state/` already contains a Dolt repo, init is idempotent — runs schema migrations if needed, does not re-init
- AC4: Init output includes a line when Dolt is bootstrapped: "Dolt state store initialized at .substrate/state/"
- AC5: `substrate init --no-dolt` flag allows explicitly skipping Dolt bootstrapping even when the binary is present

**Depends on:** Story 26-10 (auto-detection in factory), Story 26-2 (schema + init logic)

**Files:** `src/cli/commands/init.ts`, `src/modules/state/dolt-init.ts`

### Story 26-12: CLI Degraded-Mode Hints (P1, S)

**Status: PLANNED**

**Problem:** When running on the file backend, `substrate diff` and `substrate history` return empty results. Users (and agents) don't know they're missing functionality. A hint should inform them that Dolt enables these features.

**Acceptance Criteria:**
- AC1: `substrate diff <storyKey>` on file backend prints: "Tip: Install Dolt for versioned state diffs. See substrate docs." and returns the empty result
- AC2: `substrate history` on file backend prints the same hint style
- AC3: Hints go to stderr (not stdout) so they don't pollute JSON output when `--output-format json` is used
- AC4: Hints are suppressed when `--quiet` flag is set
- AC5: Agent-facing: the CLAUDE.md commands table updated to include `substrate diff` and `substrate history`

**Files:** `src/cli/commands/diff.ts`, `src/cli/commands/history.ts`, `CLAUDE.md`

### Story 26-13: SQLite → Dolt Migration Command (P1, M)

**Status: PLANNED**

**Problem:** Users who have been running on the file backend have metrics and contract verification data in SQLite. When they install Dolt and the auto-detection activates, their historical data is stranded in SQLite. A one-shot migration tool should carry it forward.

**Acceptance Criteria:**
- AC1: `substrate migrate` reads all records from the SQLite database (metrics, contracts, contract_verifications) and writes them into the Dolt tables
- AC2: Migration is idempotent — running twice doesn't duplicate data (uses primary key upsert semantics)
- AC3: Migration creates a Dolt commit: "Migrate historical data from SQLite"
- AC4: If no SQLite database exists, exits cleanly with "No SQLite data found — nothing to migrate"
- AC5: If Dolt is not initialized, exits with error: "Dolt not initialized. Run 'substrate init' first"
- AC6: Progress output: "Migrating N metrics, M contracts, K verifications... done."
- AC7: `--dry-run` flag shows what would be migrated without writing

**Depends on:** Story 26-10 (Dolt must be initialized), Story 26-3 (DoltStateStore CRUD)

**Files:** new `src/cli/commands/migrate.ts`, `src/cli/index.ts`

## Dependency Analysis

- Sprint 1 (26-1, 26-2, 26-3): 26-1 defines the interface; 26-2 and 26-3 depend on it but can partially overlap (schema design is independent of interface). **COMPLETE.**
- Sprint 2 (26-4, 26-5, 26-6): All depend on 26-3 (DoltStateStore). Can run in parallel against each other — they touch different modules. **COMPLETE.**
- Sprint 3 (26-7, 26-8, 26-9): 26-7 depends on 26-4 (orchestrator uses StateStore). 26-8 depends on 26-4. 26-9 is independent (new commands). **COMPLETE.**
- Sprint 4 (26-10, 26-11, 26-12, 26-13): 26-10 first (factory auto-detection). 26-11 depends on 26-10. 26-12 and 26-13 are independent of each other but both depend on 26-10.

## Sprint Plan

**Sprint 1:** Stories 26-1, 26-2, 26-3 — StateStore interface, schema, Dolt backend ✅
**Sprint 2:** Stories 26-4, 26-5, 26-6 — Migrate orchestrator, metrics, contracts to StateStore ✅
**Sprint 3:** Stories 26-7, 26-8, 26-9 — Branch model, CLI migration, diff/history ✅
**Sprint 4:** Stories 26-10, 26-11, 26-12, 26-13 — Auto-detection, init bootstrapping, CLI hints, SQLite migration

## Hardening (Sprint 3, post-pipeline)

The following hardening was applied after Sprint 3 pipeline completion:

- **SQL injection prevention**: `assertValidStoryKey()` validation added to `branchForStory`, `mergeStory`, `rollbackStory`, `diffStory` — pattern `/^[0-9]+-[0-9]+$/`
- **Merged-story diff fallback**: `diffStory` now finds merge commits via `dolt log --grep` when branch is gone, diffs `<hash>~1` vs `<hash>`
- **Dead code removal**: Unused `HistoryOptions` type removed from exports
- **Integration tests**: 14-test real Dolt binary integration suite (gated by `DOLT_INTEGRATION_TEST=1`), 10-test e2e cross-module integration suite covering branch lifecycle, diff/history wiring, and merge conflict event propagation

## Success Metrics

- All pipeline state queryable via SQL (stories, contracts, metrics, dispatch log, build results, review verdicts)
- Branch-per-story execution prevents cross-story state contamination (zero cross-contamination incidents)
- `substrate status` and `substrate metrics` return data from Dolt with sub-second query times
- Full test suite passes against both file and Dolt backends (zero regression)
- Dolt diff shows meaningful state changes per story (validated in integration test)
- Pipeline history queryable: "what was the average cost per story in sprint 3?" answerable via `substrate metrics --sprint 3`
- Dolt repo size remains manageable: < 50MB after 100 story executions
- Auto-detection seamlessly activates Dolt when binary is present (zero manual config)
- SQLite data migrated to Dolt without loss (idempotent migration command)
