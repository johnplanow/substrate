# Story 40.5: Persistence Interface Extraction

## Story

As a substrate-core package consumer,
I want `DatabaseAdapter`, `SyncAdapter`, `DatabaseAdapterConfig`, `isSyncAdapter`, and `InitSchemaFn` defined in `packages/core/src/persistence/`,
so that other packages can depend on a stable, type-safe persistence contract without importing from the monolith `src/persistence/adapter.ts`.

## Acceptance Criteria

### AC1: Core Persistence Types File Created with All Required Exports
**Given** the `packages/core/src/persistence/` directory is created
**When** `packages/core/src/persistence/types.ts` is imported
**Then** it exports `DatabaseAdapter`, `SyncAdapter`, `DatabaseAdapterConfig`, `isSyncAdapter`, and `InitSchemaFn`

### AC2: DatabaseAdapter Interface Contains All Required Methods with Identical Signatures
**Given** the existing `src/persistence/adapter.ts`
**When** the core `DatabaseAdapter` interface is compared method-by-method
**Then** it contains `query<T>(sql: string, params?: unknown[]): Promise<T[]>`, `exec(sql: string): Promise<void>`, `transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>`, `close(): Promise<void>`, and `queryReadyStories(): Promise<string[]>` with matching TypeScript signatures

### AC3: SyncAdapter Interface Matches Existing Monolith Definition
**Given** the core `SyncAdapter` interface
**When** compared to the existing `src/persistence/adapter.ts`
**Then** it contains `querySync<T = unknown>(sql: string, params?: unknown[]): T[]` and `execSync(sql: string): void` with matching signatures

### AC4: isSyncAdapter Type Guard Exported and Correct
**Given** `packages/core/src/persistence/types.ts`
**When** `isSyncAdapter(adapter)` is called with a `DatabaseAdapter` value
**Then** it returns `adapter is DatabaseAdapter & SyncAdapter` and the implementation checks for the presence of a `querySync` method on the adapter

### AC5: InitSchemaFn Type Alias Exported
**Given** `packages/core/src/persistence/types.ts`
**When** the `InitSchemaFn` export is inspected
**Then** it is declared as `type InitSchemaFn = (adapter: DatabaseAdapter) => Promise<void>` — a function type alias describing the `initSchema` contract without any implementation

### AC6: Barrel Exports from `persistence/index.ts` and Core Root
**Given** all persistence type files are created
**When** `packages/core/src/persistence/index.ts` and `packages/core/src/index.ts` are updated
**Then** all persistence symbols (`DatabaseAdapter`, `SyncAdapter`, `DatabaseAdapterConfig`, `isSyncAdapter`, `InitSchemaFn`) are importable from `@substrate-ai/core`

### AC7: TypeScript Compilation Succeeds with Zero Errors
**Given** all files are created with correct ESM `.js` extension imports
**When** `npm run build` is run inside `packages/core/`
**Then** TypeScript compiles with zero errors and composite build artifacts are emitted to `packages/core/dist/persistence/`

## Tasks / Subtasks

- [x] Task 1: Create `packages/core/src/persistence/types.ts` with all interface definitions (AC: #1, #2, #3)
  - [x] Read `src/persistence/adapter.ts` to copy all interface definitions verbatim
  - [x] Define `DatabaseAdapter` interface with all five methods: `query<T>()`, `exec()`, `transaction<T>()`, `close()`, and `queryReadyStories()`; preserve all JSDoc comments from the monolith source
  - [x] Define `SyncAdapter` interface with `querySync<T = unknown>()` and `execSync()` methods; preserve JSDoc comments
  - [x] Define `DatabaseAdapterConfig` interface with `backend: 'dolt' | 'memory' | 'auto'` and optional `basePath?: string` fields
  - [x] Add file-level JSDoc comment summarizing the module's purpose (interface definitions only, no implementations)

- [x] Task 2: Add `isSyncAdapter` type guard and `InitSchemaFn` type alias (AC: #4, #5)
  - [x] Copy `isSyncAdapter(adapter: DatabaseAdapter): adapter is DatabaseAdapter & SyncAdapter` function verbatim from `src/persistence/adapter.ts`; this is a pure type guard with no external dependencies
  - [x] Define `export type InitSchemaFn = (adapter: DatabaseAdapter) => Promise<void>` type alias representing the `initSchema` contract signature from `src/persistence/schema.ts`
  - [x] Ensure no runtime imports are needed — `isSyncAdapter` depends only on types defined in the same file

- [x] Task 3: Create `packages/core/src/persistence/index.ts` barrel export (AC: #6)
  - [x] Create `packages/core/src/persistence/index.ts` re-exporting all symbols from `./types.js`
  - [x] Confirm all five exported symbols are included: `DatabaseAdapter`, `SyncAdapter`, `DatabaseAdapterConfig`, `isSyncAdapter`, `InitSchemaFn`

- [x] Task 4: Update `packages/core/src/index.ts` to include persistence exports (AC: #6)
  - [x] Add `export * from './persistence/index.js'` to `packages/core/src/index.ts`
  - [x] Verify no naming conflicts with the existing `events` and `dispatch` barrel exports already present

- [x] Task 5: Verify TypeScript compilation succeeds (AC: #7)
  - [x] Run `npx tsc -b packages/core --force` and confirm exit code 0
  - [x] Confirm `packages/core/dist/persistence/` directory is populated with `.js` and `.d.ts` files
  - [x] If compilation errors exist (e.g., bad import paths, missing types), fix before marking done

## Dev Notes

### Architecture Constraints
- **INTERFACE DEFINITION ONLY** — do NOT modify `src/persistence/adapter.ts`, `src/persistence/schema.ts`, or any existing monolith source files. This story defines new interfaces in `packages/core/`; implementations are migrated in Epic 41.
- **ESM imports** — all intra-package imports must use `.js` extensions (e.g., `import { ... } from './types.js'`). TypeScript resolves `.js` imports to `.ts` at compile time with `moduleResolution: "NodeNext"`.
- **No circular dependencies** — `packages/core/src/persistence/` must not import from `packages/core/src/events/`, `packages/core/src/dispatch/`, or any other core sub-module. It is fully self-contained.
- **No external dependencies** — unlike `dispatch/types.ts` (which needs `zod`), the persistence types have no external package dependencies. Do not add any to `packages/core/package.json`.
- **Copy verbatim** — copy interface shapes exactly from `src/persistence/adapter.ts` rather than summarizing or paraphrasing. The goal is a standalone, self-contained interface package whose signatures are structurally identical to the monolith originals.
- **InitSchemaFn is a type alias, not a function** — `initSchema` in `src/persistence/schema.ts` is a concrete implementation; only its function-type signature belongs in the core interface package. Export it as `type InitSchemaFn = ...` so Epic 41 can declare its implementation against this type.
- **isSyncAdapter is a concrete function** — unlike other items in this story, `isSyncAdapter` is a small runtime type guard that belongs in the core package (following the same pattern as `DispatcherShuttingDownError` in story 40-4). It has no external runtime dependencies and is essential for consumers doing adapter capability detection.

### Key Files to Read Before Starting
- `src/persistence/adapter.ts` — full source of all persistence interfaces to copy verbatim
- `src/persistence/schema.ts` — `initSchema` function to extract type signature from (lines 27–28)
- `packages/core/tsconfig.json` — verify `composite: true`, `outDir: "dist"`, `rootDir: "src"` from story 40-2
- `packages/core/src/index.ts` — barrel to update with persistence re-export (must not conflict with events/dispatch exports)

### Target File Structure
```
packages/core/src/persistence/
├── types.ts     # DatabaseAdapter, SyncAdapter, DatabaseAdapterConfig, isSyncAdapter, InitSchemaFn
└── index.ts     # Barrel export: export * from './types.js'
```

### Interface Shapes to Copy
```typescript
// packages/core/src/persistence/types.ts

export interface SyncAdapter {
  querySync<T = unknown>(sql: string, params?: unknown[]): T[]
  execSync(sql: string): void
}

export interface DatabaseAdapter {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<T[]>
  exec(sql: string): Promise<void>
  transaction<T>(fn: (adapter: DatabaseAdapter) => Promise<T>): Promise<T>
  close(): Promise<void>
  queryReadyStories(): Promise<string[]>
}

export interface DatabaseAdapterConfig {
  backend: 'dolt' | 'memory' | 'auto'
  basePath?: string
}

export function isSyncAdapter(adapter: DatabaseAdapter): adapter is DatabaseAdapter & SyncAdapter {
  return typeof (adapter as DatabaseAdapter & SyncAdapter).querySync === 'function'
}

export type InitSchemaFn = (adapter: DatabaseAdapter) => Promise<void>
```

### Testing Requirements
- This story produces only TypeScript type definitions and one tiny type-guard function — no complex runtime behavior is added or changed
- There are no unit tests to write for pure interface/type declarations
- Verification is done by TypeScript compilation: `npm run build` in `packages/core/` must exit 0
- Do NOT run the full monorepo test suite (`npm test`) — only the core package build needs to pass for this story
- AC2 and AC3 (adapter interfaces satisfy monolith shapes) are verified structurally — TypeScript will enforce this when Epic 41 adds the re-export shim

## Interface Contracts

- **Export**: `DatabaseAdapter` @ `packages/core/src/persistence/types.ts` (consumed by stories 40-8, 40-13, and persistence migration stories in Epic 41)
- **Export**: `SyncAdapter` @ `packages/core/src/persistence/types.ts` (consumed by monitor-database consumers in later epics)
- **Export**: `InitSchemaFn` @ `packages/core/src/persistence/types.ts` (consumed by story 40-13 schema versioning and Epic 41 migration)
- **Export**: `DatabaseAdapterConfig` @ `packages/core/src/persistence/types.ts` (consumed by Epic 41's `createDatabaseAdapter` factory migration)

## Dev Agent Record

### Agent Model Used

### Completion Notes List
- All interfaces copied verbatim from `src/persistence/adapter.ts` with full JSDoc preservation
- `isSyncAdapter` type guard is a runtime function with no external dependencies
- `InitSchemaFn` is a type alias only (no implementation)
- ESM `.js` extension imports used throughout
- No circular dependencies — persistence module is fully self-contained
- TypeScript compilation succeeds with zero errors via `npx tsc -b packages/core --force`

### File List
- `packages/core/src/persistence/types.ts` (new)
- `packages/core/src/persistence/index.ts` (new)
- `packages/core/src/index.ts` (modified — added persistence re-export)

## Change Log

- 2026-03-22: Story created for Epic 40 (Core Extraction Phase 1)
