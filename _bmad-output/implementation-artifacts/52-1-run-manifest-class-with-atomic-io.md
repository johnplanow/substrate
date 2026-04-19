# Story 52-1: RunManifest Class with Atomic I/O

## Story

As a substrate developer,
I want a `RunManifest` class that provides typed read/write operations with atomic file replacement,
so that run state survives process crashes without corruption.

## Acceptance Criteria

### AC1: RunManifest Schema and File Location
**Given** a pipeline run is started with a given run ID
**When** the `RunManifest` is created
**Then** it is stored at `.substrate/runs/{run-id}.json` with a validated Zod schema containing: `run_id`, `cli_flags`, `story_scope`, `supervisor_pid`, `supervisor_session_id`, `per_story_state`, `recovery_history`, `cost_accumulation`, `pending_proposals`, `generation`, `created_at`, `updated_at`

### AC2: Atomic Write with Crash Safety
**Given** an existing `RunManifest` at `.substrate/runs/{run-id}.json`
**When** `manifest.write(data)` is called
**Then** the class serializes to JSON, validates the output is parseable, writes to `.substrate/runs/{run-id}.json.tmp`, calls `fsync` on the file descriptor, backs up the current file to `.substrate/runs/{run-id}.json.bak`, and renames `.tmp` to the final path — all before the Promise resolves

### AC3: Read with Multi-Tier Fallback
**Given** the primary manifest file at `.substrate/runs/{run-id}.json` fails to parse (corrupt or missing)
**When** `RunManifest.read(runId)` is called
**Then** the class falls back in order: `.bak` file → `.tmp` file → minimal state reconstructed from Dolt (degraded-but-functional mode); if all sources fail, `read` throws a `ManifestReadError` with details of each attempted source

### AC4: Monotonic Generation Counter
**Given** a `RunManifest` with a `generation` field initialized to `0`
**When** `manifest.write(data)` is called successfully
**Then** `generation` is incremented by 1 on every write; on read, if the `generation` in the backup file is higher than the primary, the backup is preferred (newer write survived a mid-rename crash)

### AC5: I/O Latency Under 50ms
**Given** a `RunManifest` with `per_story_state` containing 30 story entries
**When** `manifest.write(data)` is called
**Then** the atomic write completes in under 50ms on a local filesystem (measured in unit test with a fixed-size payload fixture)

### AC6: Zod Schema Validation on Read
**Given** a manifest file on disk whose content has been manually corrupted (schema-invalid JSON object)
**When** `RunManifest.read(runId)` is called
**Then** schema validation (Zod `safeParse`) rejects the object as corrupt and the read-fallback chain is triggered, not an unhandled exception

### AC7: Runs Directory Auto-Creation
**Given** the `.substrate/runs/` directory does not yet exist
**When** `RunManifest.write(data)` is called for the first time
**Then** the directory is created recursively (`mkdir -p` equivalent) before the write proceeds, without throwing

## Tasks / Subtasks

- [ ] Task 1: Define RunManifest schema types and Zod validation (AC: #1, #4, #6)
  - [ ] Create `packages/sdlc/src/run-model/types.ts` exporting `RunManifestData` interface with all fields: `run_id: string`, `cli_flags: Record<string, unknown>`, `story_scope: string[]`, `supervisor_pid: number | null`, `supervisor_session_id: string | null`, `per_story_state: Record<string, unknown>`, `recovery_history: RecoveryEntry[]`, `cost_accumulation: CostAccumulation`, `pending_proposals: Proposal[]`, `generation: number`, `created_at: string`, `updated_at: string`
  - [ ] Create `packages/sdlc/src/run-model/schemas.ts` with `RunManifestSchema` (Zod) mirroring the interface; export `ManifestReadError` class extending `Error` with `attempted_sources: string[]` field
  - [ ] Export `RecoveryEntry`, `CostAccumulation`, and `Proposal` sub-schemas from `schemas.ts` with appropriate Zod definitions

- [ ] Task 2: Implement atomic write with fsync and backup (AC: #2, #5, #7)
  - [ ] Create `packages/sdlc/src/run-model/run-manifest.ts` with class `RunManifest`
  - [ ] Constructor accepts `runId: string`, `baseDir: string` (defaults to `join(process.cwd(), '.substrate', 'runs')`)
  - [ ] Implement `write(data: Omit<RunManifestData, 'generation' | 'updated_at'>): Promise<void>` that: (1) auto-increments `generation`, (2) sets `updated_at = new Date().toISOString()`, (3) serializes to JSON, (4) validates parse round-trip, (5) `mkdir -p` on `baseDir`, (6) writes to `.tmp` path via `fs.open` + `fs.write` + `fs.fsync` + `fs.close`, (7) if primary exists, copies to `.bak`, (8) renames `.tmp` to primary path
  - [ ] Implement a static `RunManifest.create(runId, baseDir?)` factory that creates a new manifest with `generation: 0` and writes it; returns a `RunManifest` instance

- [ ] Task 3: Implement multi-tier read fallback (AC: #3, #4, #6)
  - [ ] Implement `RunManifest.read(runId: string, baseDir?: string): Promise<RunManifestData>` static method
  - [ ] Attempt sources in order: primary path, `.bak`, `.tmp`, Dolt reconstruction (via injected `IDoltAdapter | null`)
  - [ ] For Dolt degraded reconstruction: query `pipeline_runs` for `run_id`, build minimal `RunManifestData` with empty `per_story_state`, `recovery_history`, etc. — log a `warn`-level message indicating degraded mode
  - [ ] If all sources fail, throw `ManifestReadError` with `attempted_sources` listing each path tried
  - [ ] Apply generation-counter tiebreak: if `.bak` has `generation > primary.generation`, prefer `.bak`

- [ ] Task 4: Wire module exports and index (AC: #1)
  - [ ] Create `packages/sdlc/src/run-model/index.ts` re-exporting `RunManifest`, `RunManifestData`, `RunManifestSchema`, `ManifestReadError`, and sub-types
  - [ ] Add `run-model` to `packages/sdlc/src/index.ts` exports
  - [ ] Ensure no circular imports: `run-model` must not import from `verification` or `orchestrator`

- [ ] Task 5: Unit tests — write path (AC: #2, #5, #7)
  - [ ] Create `packages/sdlc/src/run-model/__tests__/run-manifest-write.test.ts`
  - [ ] Use `tmp` or `os.tmpdir()` for isolated filesystem in tests; clean up in `afterEach`
  - [ ] Test: `write()` creates `.substrate/runs/` dir if missing (AC7)
  - [ ] Test: `write()` produces valid JSON at primary path and increments `generation` (AC2, AC4)
  - [ ] Test: `write()` leaves `.bak` copy of previous file (AC2)
  - [ ] Test: latency test — write manifest with 30 stub story entries completes in <50ms (AC5); use `performance.now()`
  - [ ] Test: `write()` with corrupt serialize round-trip (mock `JSON.parse` to throw) should not leave `.tmp` orphaned

- [ ] Task 6: Unit tests — read path and fallback (AC: #3, #4, #6)
  - [ ] Create `packages/sdlc/src/run-model/__tests__/run-manifest-read.test.ts`
  - [ ] Test: `read()` returns data when primary is valid
  - [ ] Test: `read()` falls back to `.bak` when primary is missing (AC3)
  - [ ] Test: `read()` falls back to `.bak` when primary fails Zod validation (AC6)
  - [ ] Test: `read()` falls back to `.tmp` when both primary and `.bak` are invalid (AC3)
  - [ ] Test: `read()` falls back to Dolt degraded mode (mock `IDoltAdapter`) when all file sources fail (AC3)
  - [ ] Test: `read()` prefers `.bak` over primary when `.bak` has higher `generation` (AC4)
  - [ ] Test: `read()` throws `ManifestReadError` listing all attempted sources when everything fails (AC3)

## Dev Notes

### Architecture Constraints
- **File location**: `.substrate/runs/{run-id}.json` — the `baseDir` resolves to `join(cwd, '.substrate', 'runs')` by default; the `runs/` subdirectory is new (distinct from the existing graph-engine run dirs in `.substrate/runs/{uuid}/` which store `checkpoint.json` etc.)
- **Atomic write sequence**: write-to-`.tmp` → `fsync` fd → copy current to `.bak` → `rename .tmp → primary`. Use Node.js `fs/promises`: `open`, `write`, `fsync`, `close`, `copyFile`, `rename`. Do NOT use `writeFile` directly — it does not fsync.
- **No SQLite, no new DB tables**: run manifest is exclusively file-backed JSON. Dolt degraded reconstruction reads from existing `pipeline_runs` table only — it never writes during a `read()` call.
- **Package placement**: all files in `packages/sdlc/src/run-model/`. Import from `@substrate-ai/sdlc` internally; no new peer dependencies.
- **Zod pattern**: use `z.union([z.string(), z.literal('...')])` for any extensible enum fields (follow v0.19.6 `ReadinessFindingCategory` pattern). Story scope (`story_scope`) is `z.array(z.string())`.
- **`fsync` on Node.js**: use `fs.promises.open` → get `FileHandle` → `fileHandle.datasync()` or `fileHandle.sync()` → `fileHandle.close()`. The `datasync()` method flushes data without metadata (faster); use it for the `.tmp` write.
- **Backward compatibility**: existing `.substrate/current-run-id` file is NOT touched by this story. Source demotion (Story 52-5) migrates the old file. This story only creates the new `RunManifest` abstraction.
- **`per_story_state` schema**: story 52-4 defines the per-story state schema in detail. For this story, `per_story_state` is typed as `Record<string, unknown>` / `z.record(z.unknown())` — the extensible union type is added in 52-4.

### Testing Requirements
- Use `vitest` with `vi.mock` for filesystem mocking where needed; prefer real filesystem I/O with `os.tmpdir()` temp dirs for integration-style unit tests
- Latency test (AC5) must use `performance.now()` and assert `<50` — mark it with `// latency-sensitive` comment so CI reviewers know it is intentional
- Do NOT mock `fs/promises` for the happy-path write test — use a real temp dir so the fsync/rename sequence is exercised
- The Dolt degraded fallback test should mock `IDoltAdapter` injected via constructor parameter (not global import mock)
- Run with `npm run test:fast` to validate; the new test files must be discovered automatically (no manual vitest config changes needed)

### File Paths to Create
- `packages/sdlc/src/run-model/types.ts`
- `packages/sdlc/src/run-model/schemas.ts`
- `packages/sdlc/src/run-model/run-manifest.ts`
- `packages/sdlc/src/run-model/index.ts`
- `packages/sdlc/src/run-model/__tests__/run-manifest-write.test.ts`
- `packages/sdlc/src/run-model/__tests__/run-manifest-read.test.ts`
- Update: `packages/sdlc/src/index.ts` (add run-model exports)

## Interface Contracts

- **Export**: `RunManifest` @ `packages/sdlc/src/run-model/run-manifest.ts` (consumed by stories 52-2, 52-3, 52-4, 52-5, 52-6, 52-7, 52-8 and all of Epic 53-54)
- **Export**: `RunManifestData` @ `packages/sdlc/src/run-model/types.ts` (shared type used across Epic 52 stories)
- **Export**: `RunManifestSchema` @ `packages/sdlc/src/run-model/schemas.ts` (consumed by 52-3, 52-4)
- **Export**: `ManifestReadError` @ `packages/sdlc/src/run-model/schemas.ts` (consumed by 52-6 status/health/resume integration)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
