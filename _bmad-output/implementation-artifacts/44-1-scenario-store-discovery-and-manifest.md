# Story 44-1: Scenario Store — Discovery and Manifest

## Story

As a factory graph executor,
I want a `ScenarioStore` that discovers scenario files in `.substrate/scenarios/` and computes a SHA-256 checksum manifest,
so that subsequent pipeline stages can verify scenario integrity before execution and detect any tampering between iterations.

## Acceptance Criteria

### AC1: Scenario File Discovery by Glob Pattern
**Given** a directory `.substrate/scenarios/` containing files `scenario-login.sh`, `scenario-checkout.py`, `scenario-auth.js`, `scenario-deploy.ts`, and `helper.sh`
**When** `ScenarioStore.discover()` is called
**Then** it returns a `ScenarioManifest` listing exactly the four `scenario-*` files (`.sh`, `.py`, `.js`, `.ts`) and excludes `helper.sh` — the glob pattern is `scenario-*.{sh,py,js,ts}`

### AC2: Empty Directory Returns Empty Manifest
**Given** `.substrate/scenarios/` exists but contains no files matching `scenario-*.{sh,py,js,ts}`
**When** `ScenarioStore.discover()` is called
**Then** it returns a `ScenarioManifest` with an empty `scenarios` array and `checksum` map, without throwing

### AC3: Missing Scenarios Directory Returns Empty Manifest
**Given** `.substrate/scenarios/` does not exist in the project root
**When** `ScenarioStore.discover()` is called
**Then** it returns an empty `ScenarioManifest` without throwing (directory absence is not an error)

### AC4: SHA-256 Checksum Computed Per File
**Given** a discovered scenario file `scenario-login.sh` with known content
**When** `ScenarioStore.discover()` is called
**Then** the returned manifest includes a `checksums` map where `'scenario-login.sh'` maps to the hex-encoded SHA-256 digest of the file's content — verified by computing the expected hash independently in the test

### AC5: Integrity Verification Passes for Unmodified Files
**Given** a `ScenarioManifest` produced by `ScenarioStore.discover()` and the scenario files are unmodified
**When** `ScenarioStore.verify(manifest)` is called
**Then** it returns `{ valid: true, tampered: [] }` and emits no error

### AC6: Integrity Verification Detects Modified Files
**Given** a `ScenarioManifest` produced by `ScenarioStore.discover()` and then `scenario-login.sh` is modified on disk
**When** `ScenarioStore.verify(manifest)` is called
**Then** it returns `{ valid: false, tampered: ['scenario-login.sh'] }` listing the modified file name

### AC7: ScenarioManifest Exported from Factory Package
**Given** the story is implemented
**When** a consumer imports from `@substrate-ai/factory`
**Then** `ScenarioManifest`, `ScenarioEntry`, and `ScenarioStoreVerifyResult` types are all exported from the package's public API

## Tasks / Subtasks

- [ ] Task 1: Define types in `packages/factory/src/scenarios/types.ts` (AC: #1, #4, #5, #6, #7)
  - [ ] Define `ScenarioEntry` interface: `{ name: string; path: string; checksum: string }`
  - [ ] Define `ScenarioManifest` interface: `{ scenarios: ScenarioEntry[]; capturedAt: number }` — `capturedAt` is `Date.now()` ms timestamp at discovery time
  - [ ] Define `ScenarioStoreVerifyResult` interface: `{ valid: boolean; tampered: string[] }` — `tampered` is the list of file names whose checksum no longer matches
  - [ ] Export all three types from `types.ts`

- [ ] Task 2: Implement `ScenarioStore` in `packages/factory/src/scenarios/store.ts` (AC: #1, #2, #3, #4)
  - [ ] Define `ScenarioStore` class (or factory function) with `discover(projectRoot?: string): Promise<ScenarioManifest>` method
  - [ ] `projectRoot` defaults to `process.cwd()` when omitted
  - [ ] Build the scenarios directory path as `path.join(projectRoot, '.substrate', 'scenarios')`
  - [ ] Use `fs.stat` to check directory existence; return empty manifest if it does not exist (do not throw)
  - [ ] Use Node.js `glob` (`import { glob } from 'glob'`) or `fs.readdir` + manual filter to match `scenario-*.{sh,py,js,ts}` — return full absolute paths sorted alphabetically
  - [ ] Compute SHA-256 hash per file: read file content as `Buffer`, use `crypto.createHash('sha256').update(content).digest('hex')`
  - [ ] Build and return `ScenarioManifest` with `scenarios` array (one `ScenarioEntry` per file) and `capturedAt: Date.now()`

- [ ] Task 3: Implement `ScenarioStore.verify()` in `packages/factory/src/scenarios/store.ts` (AC: #5, #6)
  - [ ] Add `verify(manifest: ScenarioManifest, projectRoot?: string): Promise<ScenarioStoreVerifyResult>` method
  - [ ] For each `ScenarioEntry` in `manifest.scenarios`, read current file content and recompute SHA-256
  - [ ] Collect file names where current checksum differs from manifest checksum into `tampered` array
  - [ ] Return `{ valid: tampered.length === 0, tampered }`
  - [ ] If a scenario file listed in the manifest no longer exists on disk, treat it as tampered (include in `tampered` array)

- [ ] Task 4: Barrel export from `packages/factory/src/scenarios/index.ts` (AC: #7)
  - [ ] Create `packages/factory/src/scenarios/index.ts` that re-exports `ScenarioStore` from `./store.js` and all types from `./types.js`

- [ ] Task 5: Add public re-exports to `packages/factory/src/index.ts` (AC: #7)
  - [ ] Add `export * from './scenarios/index.js'` to `packages/factory/src/index.ts`
  - [ ] Verify no export name conflicts with existing exports (especially `ScenarioResult` and `ScenarioRunResult` in `events.ts` — `ScenarioManifest` and `ScenarioEntry` are new names, no conflict expected)

- [ ] Task 6: Write unit tests in `packages/factory/src/scenarios/__tests__/store.test.ts` (AC: #1–#6)
  - [ ] Use `tmp` directory created by `fs.mkdtemp` per test; clean up in `afterEach`
  - [ ] Test AC1: 4 matching files + 1 non-matching file → manifest contains exactly the 4 matching entries, sorted alphabetically by name
  - [ ] Test AC2: empty scenarios dir → manifest with empty `scenarios` array, no throw
  - [ ] Test AC3: missing `.substrate/scenarios/` directory → empty manifest, no throw
  - [ ] Test AC4: known-content file → checksum in manifest equals independently computed SHA-256 hex digest
  - [ ] Test AC5: `verify()` on unmodified files → `{ valid: true, tampered: [] }`
  - [ ] Test AC6: modify file after `discover()` → `verify()` returns `{ valid: false, tampered: ['<filename>'] }`
  - [ ] Test: file deleted after `discover()` → appears in `tampered` array
  - [ ] Test: `projectRoot` parameter respected — store targets the given directory, not `process.cwd()`

- [ ] Task 7: Build and validate (AC: #7)
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors
  - [ ] Run `npm run test:fast` — all tests pass, no regressions
  - [ ] Confirm `ScenarioManifest`, `ScenarioEntry`, `ScenarioStoreVerifyResult`, and `ScenarioStore` are all importable from `@substrate-ai/factory`

## Dev Notes

### Architecture Constraints

- **File locations (new files only):**
  - `packages/factory/src/scenarios/types.ts` — `ScenarioEntry`, `ScenarioManifest`, `ScenarioStoreVerifyResult` interfaces
  - `packages/factory/src/scenarios/store.ts` — `ScenarioStore` class
  - `packages/factory/src/scenarios/index.ts` — barrel re-export
  - `packages/factory/src/scenarios/__tests__/store.test.ts` — unit tests
  - `packages/factory/src/index.ts` — **modified** to add scenario re-export

- **Import style:** All relative imports within the factory package use `.js` extensions (ESM), e.g., `import { ScenarioEntry } from './types.js'`. Cross-package imports use the package name: `import type { CoreEvents } from '@substrate-ai/core'`.

- **No cross-package imports:** `packages/factory/src/scenarios/` must NOT import from `@substrate-ai/sdlc`. It may import from `@substrate-ai/core` (shared types) if needed, but for this story no core imports are expected — only Node.js builtins (`fs`, `path`, `crypto`) and the `glob` package.

- **Glob library:** The monorepo already has `glob` as a dependency (used by parser/validator code). Use `import { glob } from 'glob'` (v10+). The pattern `scenario-*.{sh,py,js,ts}` is a brace-expansion glob compatible with `glob` v10.

- **Sorting:** Returned `scenarios` array must be sorted alphabetically by `name` (filename without directory), not by full path. This ensures deterministic ordering for tests and manifest comparisons.

- **`capturedAt` field:** This is a Unix timestamp in milliseconds (`Date.now()`). It enables callers to know when the manifest was last snapshotted and is used in future stories to detect stale manifests.

- **`ScenarioEntry.path`:** Must be the absolute path to the file. This allows `verify()` to re-read the file without needing to reconstruct the path from the project root.

- **Name collision check:** `events.ts` already exports `ScenarioResult` and `ScenarioRunResult`. The new types (`ScenarioManifest`, `ScenarioEntry`, `ScenarioStoreVerifyResult`) have distinct names — no collision. `ScenarioStore` is a class, not a type, so no conflict with the existing type exports.

### Testing Requirements

- **Test framework:** Vitest (already configured in factory package)
- **Temp directories:** Use `import { mkdtempSync, rmSync } from 'fs'` with `os.tmpdir()` to create isolated temp dirs per test. Clean up in `afterEach` with `rmSync(tmpDir, { recursive: true, force: true })`.
- **SHA-256 verification in tests:** In the AC4 test, compute the expected hash independently: `crypto.createHash('sha256').update(fileContent).digest('hex')` and compare to `manifest.scenarios[0].checksum`.
- **Run during development:** `npm run test:fast` (unit-only, ~50s, no coverage)
- **Confirm pass:** Look for the "Test Files" summary line in output — exit code alone is insufficient.
- **Never pipe output** through `head`, `tail`, or `grep` — this discards the Vitest summary.
- **Target:** ≥ 8 tests in `store.test.ts`, all passing. No regressions in existing 7498 tests.

### Glob Pattern Details

The discovery pattern `scenario-*.{sh,py,js,ts}` matches:
- `scenario-login.sh` ✓
- `scenario-checkout.py` ✓
- `scenario-auth.js` ✓
- `scenario-deploy.ts` ✓
- `helper.sh` ✗ (no `scenario-` prefix)
- `scenario-login.txt` ✗ (extension not in list)
- `scenario-login` ✗ (no extension)

Use `glob(pattern, { cwd: scenariosDir, absolute: true })` to get absolute paths directly.

### Dependency Notes

- This story has no dependencies on other Epic 44 stories — it is the foundation.
- Stories 44-2 (Runner) and 44-3 (Isolation) both depend on this story.
- Story 44-4 (Integrity verification during pipeline runs) extends the `verify()` method implemented here.

## Interface Contracts

- **Export**: `ScenarioManifest` @ `packages/factory/src/scenarios/types.ts` (consumed by stories 44-2, 44-3, 44-4)
- **Export**: `ScenarioEntry` @ `packages/factory/src/scenarios/types.ts` (consumed by stories 44-2, 44-4)
- **Export**: `ScenarioStoreVerifyResult` @ `packages/factory/src/scenarios/types.ts` (consumed by story 44-4)
- **Export**: `ScenarioStore` @ `packages/factory/src/scenarios/store.ts` (consumed by stories 44-2, 44-4, 44-8, 44-9)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log

- 2026-03-22: Story created for Epic 44, Phase B — Scenario Store + Runner
