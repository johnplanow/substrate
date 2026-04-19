# Story 26-10: Auto-Detection in createStateStore

Status: ready-for-dev

## Story

As a substrate developer,
I want `createStateStore()` to automatically detect whether Dolt is available and use it transparently,
so that users with Dolt installed get versioned state without any manual configuration.

## Acceptance Criteria

### AC1: `'auto'` backend value triggers auto-detection
**Given** `StateStoreConfig.backend` is `'auto'` (or config is omitted when the default is later changed to `'auto'` in Epic 29)
**When** `createStateStore({ backend: 'auto' })` is called
**Then** the factory synchronously checks whether the `dolt` binary is on PATH and a Dolt repo exists at the expected state directory; if both checks pass it returns a `DoltStateStore`, otherwise it returns a `FileStateStore`

### AC2: Backend type extended to include `'auto'`
**Given** the `StateStoreConfig` interface in `src/modules/state/types.ts`
**When** the type definition is updated
**Then** `StateStoreConfig.backend` accepts `'file' | 'dolt' | 'auto'` and the default documented in the JSDoc comment remains `'file'` (Epic 29 will flip it to `'auto'`)

### AC3: Explicit `'file'` and `'dolt'` overrides are honoured unchanged
**Given** a caller passes `{ backend: 'file' }` or `{ backend: 'dolt' }`
**When** `createStateStore` is called with either explicit value
**Then** the factory returns the corresponding store type without executing any auto-detection logic, preserving backward compatibility

### AC4: Auto-detection is logged at debug level
**Given** `createStateStore` is called with `backend: 'auto'`
**When** the detection decision is made
**Then** the factory emits exactly one `logger.debug` call with either `"Dolt detected, using DoltStateStore"` (including the resolved state path) or `"Dolt not found, using FileStateStore"` (including the reason: binary absent or repo not initialised)

### AC5: Dolt repo detection checks the canonical state path
**Given** `backend: 'auto'` and a `basePath` supplied in config (or `process.cwd()` as default)
**When** detecting whether a Dolt repo is present
**Then** the check looks for `<basePath>/.substrate/state/.dolt/` using a synchronous filesystem probe; absence of this directory is treated as "repo not initialised" and falls back to `FileStateStore`

### AC6: Factory signature remains synchronous
**Given** all existing callers that use `createStateStore()` synchronously
**When** the `'auto'` branch is added
**Then** `createStateStore` continues to return `StateStore` (not `Promise<StateStore>`); auto-detection uses synchronous probes (`spawnSync`, `existsSync`) so no callers need to be updated

### AC7: Unit tests cover all decision branches
**Given** mocked filesystem and child-process modules
**When** `createStateStore` is called with various configs
**Then** the tests verify: (a) `'auto'` + dolt present + repo exists → `DoltStateStore`, (b) `'auto'` + dolt binary absent → `FileStateStore`, (c) `'auto'` + binary present but repo absent → `FileStateStore`, (d) explicit `'file'` → `FileStateStore` regardless of dolt availability, (e) explicit `'dolt'` → `DoltStateStore` regardless of detection result

## Tasks / Subtasks

- [ ] Task 1: Extend `StateStoreConfig` backend type (AC: #2)
  - [ ] In `src/modules/state/types.ts`, change `backend?: 'file' | 'dolt'` to `backend?: 'file' | 'dolt' | 'auto'`
  - [ ] Update the JSDoc comment to document `'auto'` semantics and note that the default remains `'file'` until Epic 29

- [ ] Task 2: Implement synchronous Dolt detection helper (AC: #1, #5, #6)
  - [ ] Add internal function `detectDoltAvailableSync(basePath: string): { available: boolean; reason: string }` in `src/modules/state/index.ts`
  - [ ] Use `spawnSync('dolt', ['version'], { stdio: 'ignore' })` to probe the binary; treat `ENOENT` (or non-zero status) as absent
  - [ ] Use `existsSync(join(basePath, '.substrate', 'state', '.dolt'))` to verify the repo exists
  - [ ] Return `{ available: true, reason: 'dolt binary found and repo initialised' }` or false with an explanatory reason string
  - [ ] Import `spawnSync` from `node:child_process` and `existsSync` from `node:fs`

- [ ] Task 3: Update `createStateStore` factory to handle `'auto'` (AC: #1, #3, #4, #6)
  - [ ] In `src/modules/state/index.ts`, add `'auto'` branch after the existing `backend` resolution
  - [ ] When `backend === 'auto'`, call `detectDoltAvailableSync(repoPath)` and select the appropriate store class
  - [ ] Emit `logger.debug` with the detection outcome before constructing the store
  - [ ] Preserve existing `'file'` and `'dolt'` branches unchanged — no auto-detection for explicit values
  - [ ] Instantiate a module-level logger via `createLogger('state:factory')` (import from `../../utils/logger.js`)

- [ ] Task 4: Write unit tests for `createStateStore` auto-detection (AC: #7)
  - [ ] In `src/modules/state/__tests__/index.test.ts`, add a new `describe('createStateStore — auto backend')` block
  - [ ] Mock `node:child_process` via `vi.mock` to control `spawnSync` return value
  - [ ] Mock `node:fs` via `vi.mock` to control `existsSync` return value
  - [ ] Test cases:
    - Dolt binary present (spawnSync status 0) + `.dolt` dir exists → instance of `DoltStateStore`
    - Dolt binary absent (spawnSync throws ENOENT) + dir irrelevant → instance of `FileStateStore`
    - Dolt binary present + `.dolt` dir absent → instance of `FileStateStore`
    - Explicit `'file'` with dolt "available" → still `FileStateStore`
    - Explicit `'dolt'` → still `DoltStateStore` (no detection called)
  - [ ] Verify the logger mock receives a `debug` call containing the expected string for each auto-detection path

## Dev Notes

### Architecture Constraints
- **Synchronous factory**: `createStateStore` MUST remain synchronous (returns `StateStore`, not `Promise<StateStore>`). Use `spawnSync` from `node:child_process` and `existsSync` from `node:fs` — not their async counterparts — to avoid breaking callers.
- **Module imports**: Import order: Node built-ins (`node:child_process`, `node:fs`, `node:path`), then third-party, then internal (`./file-store.js`, `./dolt-store.js`, `./dolt-client.js`, `../../utils/logger.js`). Blank line between groups.
- **Logger**: Use `createLogger('state:factory')` instantiated once at module level (not inside the function). Import `createLogger` from `../../utils/logger.js`.
- **File naming**: `detectDoltAvailableSync` is an internal helper (not exported). Prefix with `function` keyword, not `const`/arrow.
- **Test framework**: Vitest only (`vi.mock`, `vi.fn`, `describe`, `it`, `expect`). No Jest APIs.
- **Test file**: Add tests to the existing `src/modules/state/__tests__/index.test.ts` — do not create a new file.

### Key File Locations
- `src/modules/state/types.ts` — update `StateStoreConfig.backend` union type only
- `src/modules/state/index.ts` — main changes: `detectDoltAvailableSync` helper + factory `'auto'` branch
- `src/modules/state/__tests__/index.test.ts` — add new `describe` block; preserve existing tests unchanged

### Dolt Repo Path Convention
The canonical Dolt state directory is `<basePath>/.substrate/state/`. The `.dolt/` marker subdirectory is created by `dolt init`. Use:
```typescript
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const stateDoltDir = join(basePath, '.substrate', 'state', '.dolt')
const repoExists = existsSync(stateDoltDir)
```

### spawnSync Error Handling
`spawnSync` returns a result object; it does NOT throw on ENOENT. Check `result.error?.code === 'ENOENT'` or `result.status !== 0` to detect an absent binary:
```typescript
import { spawnSync } from 'node:child_process'

const result = spawnSync('dolt', ['version'], { stdio: 'ignore' })
const binaryFound = result.error == null && result.status === 0
```

### Testing Requirements
- Unit tests must mock both `node:child_process` and `node:fs` at the vi.mock level
- Each test must isolate its mocks via `vi.resetAllMocks()` in `beforeEach` or explicit per-test mock setup
- Coverage threshold: 80% lines — the new branch adds ~25 lines; all branches must be exercised
- Run fast-tier validation after implementation: `npm run test:fast`

## Interface Contracts

- **Import**: `StateStoreConfig` @ `src/modules/state/types.ts` (updated in this story — consumed by `createStateStore` in `index.ts`)
- **Import**: `checkDoltInstalled` @ `src/modules/state/dolt-init.ts` — note: existing async variant is NOT used by this story; a new sync probe is added directly in `index.ts` using `spawnSync`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
