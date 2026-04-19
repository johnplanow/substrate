# Story 29-1: Make 'auto' the Default Backend

Status: complete

## Story

As a substrate user who has Dolt installed (common after Epics 27-28),
I want `createStateStore()` to use Dolt automatically without any config change,
so that I get the full versioned state backend by default once Dolt is proven infrastructure.

## Acceptance Criteria

### AC1: Default factory argument uses 'auto' backend
**Given** a caller invokes `createStateStore()` with no arguments
**When** the Dolt binary is on PATH and a Dolt repo exists at `<basePath>/.substrate/state/.dolt/`
**Then** a `DoltStateStore` instance is returned (auto-detection ran and succeeded)

### AC2: Default factory argument falls back to FileStateStore when Dolt absent
**Given** a caller invokes `createStateStore()` with no arguments
**When** the Dolt binary is not on PATH or no Dolt repo exists at the canonical state path
**Then** a `FileStateStore` instance is returned (auto-detection ran and fell back)

### AC3: StateStoreConfig type documentation updated to reflect new default
**Given** a developer reads the `StateStoreConfig.backend` JSDoc in `types.ts`
**When** they look at the `backend` field description
**Then** it states that the default is `'auto'` (not `'file'`), and the comment referencing "Epic 29" is removed since that event has now happened

### AC4: Explicit `backend: 'file'` override is still honored
**Given** a caller invokes `createStateStore({ backend: 'file' })`
**When** Dolt binary is present and the Dolt repo exists
**Then** a `FileStateStore` is returned and `spawnSync` is never called (no auto-detection runs)

### AC5: CLAUDE.md template updated with Dolt-aware commands and feature notes
**Given** the `src/cli/templates/claude-md-substrate-section.md` template
**When** a developer reads the Key Commands Reference table
**Then** it includes `substrate diff <story>` and `substrate history` entries; and there is a note that OTEL observability and context engineering features require Dolt (`substrate init` auto-detects and initializes it)

### AC6: `substrate init` human-readable output always shows Dolt status
**Given** `substrate init` runs in human output mode
**When** Dolt was successfully initialized during init
**Then** the output shows a prominent `✓ Dolt state store initialized` line
**And** when Dolt was absent or skipped, the output shows a `ℹ Dolt not detected` hint with install instructions pointing users to docs

### AC7: All existing tests pass with the updated default
**Given** the test suite in `src/modules/state/__tests__/index.test.ts`
**When** `npm run test:fast` runs
**Then** all tests pass — CI environments (where Dolt is absent) still get FileStateStore via auto-detection, same as before

## Tasks / Subtasks

- [x] Task 1: Change `createStateStore` factory default from `'file'` to `'auto'` (AC: #1, #2, #4)
  - [x] In `src/modules/state/index.ts`, change line `const backend = config.backend ?? 'file'` to `const backend = config.backend ?? 'auto'`
  - [x] Verify the existing `if (backend === 'auto')` branch handles this correctly (it already does)
  - [x] Verify the explicit `'file'` branch still short-circuits auto-detection (it already does)

- [x] Task 2: Update `StateStoreConfig.backend` JSDoc in `types.ts` (AC: #3)
  - [x] In `src/modules/state/types.ts`, update the `backend` field comment: change `Defaults to 'file'` to `Defaults to 'auto'`
  - [x] Remove the forward-looking comment `"The default will be changed to 'auto' in Epic 29 once Dolt is proven under production load."` — replace with a factual description of the current behavior
  - [x] Update the `'file'` description to remove reference to "default"

- [x] Task 3: Update factory tests to cover new default behavior (AC: #1, #2, #4, #7)
  - [x] In `src/modules/state/__tests__/index.test.ts`, update the test `'returns a FileStateStore when called with no arguments'` — add an assertion that `mockSpawnSync` was called (proving auto-detection ran and found Dolt absent), update description to `'returns FileStateStore when called with no arguments and Dolt is absent (auto-detection)'`
  - [x] Add a new test: `'returns DoltStateStore when called with no arguments and Dolt is detected (auto-detection)'` — uses `mockDoltBinaryPresent()` and `mockExistsSync.mockReturnValue(true)`, asserts `DoltStateStore` instance and that `mockSpawnSync` was called
  - [x] Verify the existing `'(d) returns FileStateStore for explicit "file" regardless of dolt availability'` test still passes (it already guards `spawnSync` not called for explicit backends)

- [x] Task 4: Update the CLAUDE.md template with Dolt-aware commands and feature note (AC: #5)
  - [x] In `src/cli/templates/claude-md-substrate-section.md`, add to the Key Commands Reference table:
    - `substrate diff <story>` → `Show row-level state changes for a story (requires Dolt)`
    - `substrate history` → `View Dolt commit log for pipeline state changes (requires Dolt)`
  - [x] Add a "State Backend" note below the Key Commands table (or in a new `### State Backend` subsection): `Substrate uses Dolt for versioned pipeline state by default. Run \`substrate init\` to set it up automatically if Dolt is on PATH. Features that require Dolt: \`substrate diff\`, \`substrate history\`, OTEL observability persistence, and context engineering repo-map storage.`

- [x] Task 5: Update `substrate init` human-readable output to always show Dolt status (AC: #6)
  - [x] In `src/cli/commands/init.ts`, in the `runInitAction` success output block (around line 832), update the Dolt status display:
    - Keep existing `✓ Dolt state store initialized at .substrate/state/` line when `doltInitialized = true`
    - Add an `else` branch: when `doltInitialized = false` and `doltMode !== 'skip'`, print `ℹ  Dolt not detected — install Dolt for versioned state, \`substrate diff\`, and observability persistence. See: https://docs.dolthub.com/introduction/installation`
    - When `doltMode === 'skip'`, print nothing (user explicitly opted out)
  - [x] Update the `__tests__/init.test.ts` or relevant init test file to cover the new `ℹ Dolt not detected` output branch

- [x] Task 6: Run tests and build to confirm no regressions (AC: #7)
  - [x] Run `npm run build` — must exit 0
  - [x] Run `npm run test:fast` — confirm "Test Files" line shows all passing, check for "Test Files" in output

## Dev Notes

### Architecture Constraints

- **File locations (must match exactly)**:
  - Factory: `src/modules/state/index.ts` — single line change at `const backend = config.backend ?? 'file'`
  - Types: `src/modules/state/types.ts` — JSDoc-only changes, no runtime logic changes
  - Factory tests: `src/modules/state/__tests__/index.test.ts` — add one test, update one test description
  - Template: `src/cli/templates/claude-md-substrate-section.md` — add rows to Key Commands table and a State Backend note
  - Init command: `src/cli/commands/init.ts` — update the success output block only (around line 832-835)

- **Import style**: All imports use `.js` extensions (ESM). No new imports are needed for any of these changes.

- **Test framework**: Vitest — use `vi.mock`, `vi.fn()`, `vi.hoisted`, `expect().toBeInstanceOf()`. Do NOT use jest APIs.

- **Test mock pattern** (already established in index.test.ts):
  ```typescript
  // Binary present
  mockSpawnSync.mockReturnValue({ status: 0, error: undefined })
  // Binary absent
  const err = Object.assign(new Error('spawnSync dolt ENOENT'), { code: 'ENOENT' })
  mockSpawnSync.mockReturnValue({ status: null, error: err })
  ```

- **CI safety**: The existing `beforeEach` in the outer `describe('createStateStore')` block already calls `mockDoltBinaryAbsent()`. After changing the default to `'auto'`, the no-args call will run auto-detection and find Dolt absent — returning FileStateStore as before. Tests remain green in CI without Dolt installed.

- **Init output pattern**: The `doltInitialized` boolean is already in scope at the success output block. The `doltMode` variable is also in scope. Use these to drive the conditional output. The new `ℹ` line should only appear when `doltMode !== 'skip'` and `doltInitialized === false`.

- **Template file is plain Markdown**: `src/cli/templates/claude-md-substrate-section.md` is a pure Markdown file, no TypeScript compilation. Edit it directly. The file is read at runtime by `scaffoldClaudeMd()` in `init.ts`.

### Testing Requirements

- **Unit tests**: Update `src/modules/state/__tests__/index.test.ts` (add 1 test, update 1 test description + assertion). No new test files needed.
- **Init tests**: If `src/cli/commands/__tests__/init.test.ts` exists, add a test case for the new Dolt-absent output line. If no init test file exists or it's too complex to add to quickly, document in completion notes but proceed — the init change is low-risk.
- **Coverage**: Must stay above 80% threshold — the changes are primarily in tested code paths. No new untested branches that would significantly lower coverage.
- **Test run**: Use `npm run test:fast` (unit only, no coverage). Never pipe output. Check for "Test Files" in the output to confirm suite completed.

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 6 tasks completed successfully
- Build passed (exit 0)
- 5290 tests pass across 218 test files (no regressions)
- Added 2 new tests in index.test.ts (1 for Dolt present default, 1 updated for Dolt absent default with spawnSync assertion)
- Added 2 new tests in init.test.ts (Dolt not detected hint output, skip mode suppresses hint)

### File List
- /home/jplanow/code/jplanow/substrate/src/modules/state/index.ts
- /home/jplanow/code/jplanow/substrate/src/modules/state/types.ts
- /home/jplanow/code/jplanow/substrate/src/modules/state/__tests__/index.test.ts
- /home/jplanow/code/jplanow/substrate/src/cli/templates/claude-md-substrate-section.md
- /home/jplanow/code/jplanow/substrate/src/cli/commands/init.ts
- /home/jplanow/code/jplanow/substrate/src/cli/commands/__tests__/init.test.ts

## Change Log
