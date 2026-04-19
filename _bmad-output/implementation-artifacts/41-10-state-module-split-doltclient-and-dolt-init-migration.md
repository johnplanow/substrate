# Story 41.10: State Module Split — DoltClient and Dolt Init Migration to Core

## Story

As a substrate-core package consumer,
I want the general-purpose `DoltClient`, `dolt-init` module, and `DoltQueryError` moved from `src/modules/state/` to `packages/core/src/persistence/`,
so that downstream packages can import low-level Dolt operations from `@substrate-ai/core` without coupling to SDLC-specific `StateStore` types.

## Acceptance Criteria

### AC1: DoltClient is available via @substrate-ai/core with ILogger injection
**Given** `packages/core/src/persistence/dolt-client.ts` contains `DoltClient` and `DoltClientOptions` with an optional `logger?: ILogger` field
**When** `new DoltClient({ repoPath: '/path/to/repo' })` is instantiated and imported from `@substrate-ai/core`
**Then** the client constructs without error; when `logger` is omitted the client silently operates using an internal no-op logger; `client.query('SELECT 1')` returns results when a Dolt socket or CLI is available

### AC2: dolt-init module is available via @substrate-ai/core with caller-supplied schemaPath
**Given** `packages/core/src/persistence/dolt-init.ts` contains `initializeDolt`, `checkDoltInstalled`, `runDoltCommand`, `DoltNotInstalled`, and `DoltInitError`
**When** these symbols are imported from `@substrate-ai/core`
**Then** `initializeDolt({ projectRoot: '...', schemaPath: '...' })` initializes a Dolt repo using the caller-supplied DDL; `schemaPath` is a required field (no default) because schema DDL is caller-owned; `checkDoltInstalled()` throws `DoltNotInstalled` when the `dolt` binary is absent

### AC3: DoltQueryError is exported from core and instanceof check resolves correctly
**Given** `DoltQueryError` is extracted into `packages/core/src/persistence/dolt-errors.ts` and re-exported from `@substrate-ai/core`
**When** `DoltClient` throws a query failure
**Then** the caught error passes `err instanceof DoltQueryError` when `DoltQueryError` is imported from `@substrate-ai/core`; the local definition in `src/modules/state/errors.ts` is replaced with a re-export from `@substrate-ai/core`

### AC4: SDLC state modules remain in monolith and import DoltClient from @substrate-ai/core
**Given** `src/modules/state/dolt-store.ts`, `file-store.ts`, and `work-graph-repository.ts` remain structurally unchanged in the monolith
**When** those files import `DoltClient` or `DoltQueryError`
**Then** each import resolves to `@substrate-ai/core` (either directly or via the shim at `src/modules/state/dolt-client.ts`); no file in `packages/core/src/` imports from a monolith `src/` path

### AC5: Re-export shim at original dolt-client path resolves correctly
**Given** `src/modules/state/dolt-client.ts` is replaced with a re-export shim pointing to `@substrate-ai/core`
**When** existing monolith code imports `DoltClient` from `src/modules/state/dolt-client.js`
**Then** the import resolves to `packages/core/src/persistence/dolt-client.ts` at compile time and runtime; `tsc` reports no unresolved imports

### AC6: packages/core/src/persistence/index.ts exports all migrated symbols
**Given** `dolt-client.ts`, `dolt-init.ts`, and `dolt-errors.ts` are present in `packages/core/src/persistence/`
**When** `packages/core/src/persistence/index.ts` is updated and `tsc -b packages/core/` is run
**Then** `DoltClient`, `DoltClientOptions`, `initializeDolt`, `checkDoltInstalled`, `runDoltCommand`, `DoltInitConfig`, `DoltNotInstalled`, `DoltInitError`, and `DoltQueryError` are all accessible via `import { ... } from '@substrate-ai/core'`; `tsc -b packages/core/` exits 0 with no errors

### AC7: All existing state-management tests pass without modification
**Given** all re-export shims are in place and `npm run build` exits 0
**When** `npm run test:fast` is run
**Then** the output contains a "Test Files" summary line; the number of failed test files is 0; all test files under `src/modules/state/__tests__/` pass; no new import resolution errors appear that were not present before this story

## Tasks / Subtasks

- [ ] Task 1: Audit src/modules/state/ and define the core vs SDLC split boundary (AC: #1, #4)
  - [ ] Read `src/modules/state/errors.ts` and identify which error classes are used by `DoltClient` (`DoltQueryError`) vs SDLC-specific (`StateStoreError`, `DoltNotInitializedError`, `DoltMergeConflictError`)
  - [ ] Confirm `src/modules/state/types.ts` contains only SDLC types (`StoryRecord`, `StoryPhase`, `StateStore`, etc.) and stays in the monolith
  - [ ] Confirm `src/modules/state/schema.sql` is SDLC-specific DDL and stays in the monolith; note that callers of `initializeDolt()` must be updated to pass `schemaPath` explicitly after the migration
  - [ ] Check whether `work-graph-repository.ts` and `file-store.ts` import `DoltClient` directly (type annotation) or only receive it via constructor injection — determine which files need import-path updates

- [ ] Task 2: Create packages/core/src/persistence/dolt-errors.ts (AC: #3)
  - [ ] Create `packages/core/src/persistence/dolt-errors.ts` containing only `DoltQueryError` (a general-purpose Dolt query failure class, extracted from `src/modules/state/errors.ts`)
  - [ ] `DoltQueryError` should have fields `sql: string` and `detail: string` matching the existing implementation
  - [ ] Use `.js` extensions for any future internal imports within the file
  - [ ] Run `tsc -b packages/core/` and confirm exit 0

- [ ] Task 3: Migrate DoltClient to packages/core/src/persistence/dolt-client.ts (AC: #1, #3)
  - [ ] Create `packages/core/src/persistence/dolt-client.ts` — copy implementation from `src/modules/state/dolt-client.ts`
  - [ ] Replace `import { createLogger } from '../../utils/logger.js'` with `import type { ILogger } from '../dispatch/types.js'`; add `logger?: ILogger` to `DoltClientOptions`; define a module-level `noopLogger: ILogger` (all methods are no-ops) and use `options.logger ?? noopLogger` in the constructor
  - [ ] Replace `import { DoltQueryError } from './errors.js'` with `import { DoltQueryError } from './dolt-errors.js'`
  - [ ] Remove the module-level `const log = createLogger(...)` line; replace all `log.debug(...)` / `log.info(...)` / `log.warn(...)` / `log.error(...)` calls with `this._log.debug(...)` etc.
  - [ ] Ensure all intra-package imports use `.js` extensions
  - [ ] Run `tsc -b packages/core/` and confirm exit 0

- [ ] Task 4: Migrate dolt-init to packages/core/src/persistence/dolt-init.ts (AC: #2)
  - [ ] Create `packages/core/src/persistence/dolt-init.ts` — copy implementation from `src/modules/state/dolt-init.ts`
  - [ ] Make `schemaPath` a **required** field in `DoltInitConfig` (remove the `??` default that references `new URL('./schema.sql', import.meta.url)`) — schema DDL is caller-supplied; add a JSDoc note that callers must provide their own DDL path
  - [ ] Remove the `import { fileURLToPath } from 'node:url'` line (no longer needed once the default is removed)
  - [ ] Verify that `DoltNotInstalled` and `DoltInitError` are defined within this file (they already are in `dolt-init.ts`) and not imported from elsewhere
  - [ ] Ensure all intra-package imports use `.js` extensions (no relative escapes into `src/`)
  - [ ] Run `tsc -b packages/core/` and confirm exit 0

- [ ] Task 5: Update packages/core/src/persistence/index.ts barrel exports (AC: #6)
  - [ ] Add to `packages/core/src/persistence/index.ts` (after existing exports):
    - `export { DoltClient } from './dolt-client.js'`
    - `export type { DoltClientOptions } from './dolt-client.js'`
    - `export { initializeDolt, checkDoltInstalled, runDoltCommand } from './dolt-init.js'`
    - `export type { DoltInitConfig } from './dolt-init.js'`
    - `export { DoltNotInstalled, DoltInitError } from './dolt-init.js'`
    - `export { DoltQueryError } from './dolt-errors.js'`
  - [ ] Confirm `packages/core/src/index.ts` already includes `export * from './persistence/index.js'` (added in story 41-3); if missing, add it
  - [ ] Run `tsc -b packages/core/` and fix any name conflicts in the barrel (use explicit named re-exports if wildcard causes TS2308)

- [ ] Task 6: Create shim at src/modules/state/dolt-client.ts and update SDLC error imports (AC: #4, #5)
  - [ ] Replace the body of `src/modules/state/dolt-client.ts` with a thin re-export shim:
    ```typescript
    // Re-export shim — implementation moved to @substrate-ai/core (story 41-10)
    export { DoltClient } from '@substrate-ai/core'
    export type { DoltClientOptions } from '@substrate-ai/core'
    ```
  - [ ] Update `src/modules/state/errors.ts`: remove the local `DoltQueryError` class definition; add `export { DoltQueryError } from '@substrate-ai/core'` so existing importers of `./errors.js` still resolve it
  - [ ] Create a re-export shim at `src/modules/state/dolt-init.ts` (or update the existing file) that re-exports from `@substrate-ai/core`; update any monolith callers of `initializeDolt()` to pass `schemaPath: new URL('./schema.sql', import.meta.url)` explicitly now that the default has been removed
  - [ ] Run `npm run build` and confirm exit 0

- [ ] Task 7: Run tests and validate (AC: #7)
  - [ ] Verify `pgrep -f vitest` returns nothing before proceeding
  - [ ] Run `npm run test:fast` with timeout: 300000 (no pipes, foreground only)
  - [ ] Confirm the output contains a "Test Files" summary line; confirm failed test count is 0
  - [ ] If any test fails due to import resolution (e.g., missing core export), fix the barrel or shim and re-run; document any pre-existing failures in Dev Agent Record without blocking the story

## Dev Notes

### Architecture Constraints
- All intra-package imports in `packages/core/src/` **must** use `.js` extensions (e.g., `'./dolt-errors.js'`, `'../dispatch/types.js'`)
- No file in `packages/core/src/` may import from `src/` (monolith paths are forbidden); any monolith-sourced utilities must be replaced with duck-typed interfaces
- `ILogger` interface is defined at `packages/core/src/dispatch/types.ts` — use this for optional logger injection; do not introduce a second `ILogger` type
- `mysql2` may need to be in `packages/core/package.json` as an `optionalDependency` since `DoltClient` imports `mysql2/promise` dynamically; verify it is listed before running tests

### DoltClient Logger Injection Pattern
```typescript
// packages/core/src/persistence/dolt-client.ts
import type { ILogger } from '../dispatch/types.js'
import { DoltQueryError } from './dolt-errors.js'

const noopLogger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

export interface DoltClientOptions {
  repoPath: string
  socketPath?: string
  logger?: ILogger
}

export class DoltClient {
  readonly repoPath: string
  readonly socketPath: string
  private readonly _log: ILogger
  // ... rest of fields

  constructor(options: DoltClientOptions) {
    this.repoPath = options.repoPath
    this.socketPath = options.socketPath ?? `${options.repoPath}/.dolt/dolt.sock`
    this._log = options.logger ?? noopLogger
  }
  // replace all log.debug(...) with this._log.debug(...) etc.
}
```

### schemaPath Required in Core dolt-init
The existing `dolt-init.ts` defaults `schemaPath` to the bundled `schema.sql`. In core, this default cannot exist (the schema is SDLC-specific DDL). Make `schemaPath` required:
```typescript
export interface DoltInitConfig {
  /** Absolute path to the project root. */
  projectRoot: string
  /** Path where the Dolt repository will be created. Defaults to <projectRoot>/.substrate/state/. */
  statePath?: string
  /**
   * Path to the schema DDL file to apply. Required — core does not bundle a schema;
   * callers must supply their own (e.g., SDLC passes the path to its schema.sql).
   */
  schemaPath: string
}
```
Update all callers of `initializeDolt()` in the monolith to pass `schemaPath` explicitly using `fileURLToPath(new URL('./schema.sql', import.meta.url))`.

### Re-Export Shim Pattern
```typescript
// src/modules/state/dolt-client.ts (becomes shim)
export { DoltClient } from '@substrate-ai/core'
export type { DoltClientOptions } from '@substrate-ai/core'

// src/modules/state/dolt-init.ts (becomes shim)
export { initializeDolt, checkDoltInstalled, runDoltCommand, DoltNotInstalled, DoltInitError } from '@substrate-ai/core'
export type { DoltInitConfig } from '@substrate-ai/core'
```

### SDLC Error Boundary
`src/modules/state/errors.ts` must be updated to:
1. Remove the local `DoltQueryError` class definition
2. Add `export { DoltQueryError } from '@substrate-ai/core'` so existing importers of `'./errors.js'` continue to resolve it
3. Keep `StateStoreError`, `DoltNotInitializedError`, `DoltMergeConflictError`, and `DoltMergeConflict` alias locally — these are SDLC-specific

### mysql2 Dependency Check
Before running tests, confirm `mysql2` appears in `packages/core/package.json`. If missing, add it under `optionalDependencies` (the client falls back to CLI when the socket is unavailable, so it is truly optional):
```json
"optionalDependencies": {
  "mysql2": "*"
}
```

### Build and Test Micro-Loop
After each file change, follow:
1. `tsc -b packages/core/` — must exit 0
2. `npm run build` — must exit 0
3. `npm run test:fast` (final gate only) — must show "Test Files" with 0 failures

### File Layout Summary
```
packages/core/src/persistence/dolt-errors.ts     NEW  — DoltQueryError
packages/core/src/persistence/dolt-client.ts     NEW  — DoltClient (with ILogger injection)
packages/core/src/persistence/dolt-init.ts       NEW  — initializeDolt, checkDoltInstalled,
                                                          runDoltCommand, DoltNotInstalled,
                                                          DoltInitError (schemaPath required)
packages/core/src/persistence/index.ts           UPDATED — add new exports
packages/core/src/index.ts                        VERIFY — persistence/index.js re-export present

src/modules/state/dolt-client.ts                 MODIFIED — becomes re-export shim
src/modules/state/dolt-init.ts                   MODIFIED — becomes re-export shim
src/modules/state/errors.ts                      MODIFIED — remove DoltQueryError,
                                                              re-export from @substrate-ai/core
src/modules/state/dolt-store.ts                  POSSIBLY MODIFIED — if it imports DoltClient
                                                              directly rather than via types
```

## Interface Contracts

- **Export**: `DoltClient`, `DoltClientOptions` @ `packages/core/src/persistence/dolt-client.ts`
- **Export**: `initializeDolt`, `checkDoltInstalled`, `runDoltCommand`, `DoltInitConfig`, `DoltNotInstalled`, `DoltInitError` @ `packages/core/src/persistence/dolt-init.ts`
- **Export**: `DoltQueryError` @ `packages/core/src/persistence/dolt-errors.ts`
- **Import**: `ILogger` @ `packages/core/src/dispatch/types.ts` (from story 41-2)
- **Import**: Persistence barrel @ `packages/core/src/persistence/index.ts` (from story 41-3)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
