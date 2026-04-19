# Story 41.8: Adapters and Git Modules Migration

## Story

As a substrate-core package consumer,
I want `AdapterRegistry`, all CLI adapters (`ClaudeCodeAdapter`, `CodexCLIAdapter`, `GeminiCLIAdapter`), `spawnGit`, `GitWorktreeManager`, `GitWorktreeManagerImpl`, `GitManager`, `VersionManager`, `VersionManagerImpl`, and supporting git/version utilities available from `@substrate-ai/core`,
so that downstream packages can discover and invoke CLI agents, manage git worktrees, and check for version updates without importing from the monolith's `src/adapters/` or `src/modules/`.

## Acceptance Criteria

### AC1: AdapterRegistry and CLI adapters migrated to packages/core/src/adapters/
**Given** `src/adapters/` contains `adapter-registry.ts`, `claude-adapter.ts`, `codex-adapter.ts`, `gemini-adapter.ts`, and `schemas.ts` (plus `types.ts` and `worker-adapter.ts` already in core)
**When** story 41-8 is complete
**Then** `packages/core/src/adapters/` contains all five new files with `.js` extensions on all intra-package imports; all imports of `AgentId`/`BillingMode` resolve to `../types.js`; `createLogger` usage is replaced with `logger?: ILogger` injection from `../dispatch/types.js`; no imports from `src/`

### AC2: Git utilities migrated to packages/core/src/git/git-utils.ts
**Given** `src/modules/git-worktree/git-utils.ts` contains `spawnGit` and related helpers, importing `createLogger` from `../../utils/logger.js`
**When** `packages/core/src/git/git-utils.ts` is created
**Then** `spawnGit`, `GitSpawnResult`, `SpawnOptions`, and all other exported utilities are present; `createLogger` is replaced with an optional `logger?: ILogger` parameter or removed in favour of `console`; all imports use `node:` built-in prefixes and `.js` extensions; `tsc -b packages/core/` exits 0

### AC3: GitWorktreeManager interface and GitWorktreeManagerImpl migrated to packages/core/src/git/
**Given** `src/modules/git-worktree/git-worktree-manager.ts` extends `BaseService` and `src/modules/git-worktree/git-worktree-manager-impl.ts` imports `TypedEventBus` and `createLogger`
**When** `packages/core/src/git/git-worktree-manager.ts` and `packages/core/src/git/git-worktree-manager-impl.ts` are created
**Then** `GitWorktreeManager` extends `IBaseService` (not the monolith's `BaseService`); `TypedEventBus` is imported from `../events/index.js`; `createLogger` is replaced with `logger?: ILogger` from `../dispatch/types.js`; `WorktreeInfo`, `ConflictReport`, `MergeResult`, and `GitWorktreeManagerOptions` are all exported; `tsc -b packages/core/` exits 0

### AC4: GitManager migrated to packages/core/src/git/
**Given** `src/modules/git/git-manager.ts` contains `GitManager` interface extending `BaseService` and importing `TypedEventBus`
**When** `packages/core/src/git/git-manager.ts` is created
**Then** `GitManager` extends `IBaseService`; `TypedEventBus` is imported from `../events/index.js`; all types exported from the interface file are present; `tsc -b packages/core/` exits 0

### AC5: VersionManager and related modules migrated to packages/core/src/version-manager/
**Given** `src/modules/version-manager/` contains `version-manager.ts`, `version-manager-impl.ts`, `update-checker.ts`, and `version-cache.ts`; `version-manager-impl.ts` imports `MigrationResult` and `defaultConfigMigrator` from `../config/config-migrator.js`
**When** `packages/core/src/version-manager/` is populated
**Then** `VersionManager`, `VersionManagerImpl`, `createVersionManager`, `VersionCheckResult`, `UpgradePreview`, `UpdateChecker`, `UpdateCheckError`, `VersionCache` are all exported from `packages/core/src/version-manager/index.ts`; `MigrationResult` and `defaultConfigMigrator` are imported from `../config/index.js` (core-relative); no imports from `src/`; `tsc -b packages/core/` exits 0

### AC6: packages/core barrel exports all new symbols and tsc builds clean
**Given** new implementations are added across `packages/core/src/{adapters,git,version-manager}/`
**When** `packages/core/src/index.ts` and each module's `index.ts` are updated
**Then** `AdapterRegistry`, `ClaudeCodeAdapter`, `CodexCLIAdapter`, `GeminiCLIAdapter`, `spawnGit`, `GitWorktreeManager`, `GitWorktreeManagerImpl`, `GitManager`, `VersionManager`, `VersionManagerImpl`, `UpdateChecker`, `VersionCache` are all importable from `@substrate-ai/core`; running `tsc -b packages/core/` exits with code 0 and no errors

### AC7: Re-export shims installed at all original src/ paths and all existing tests pass
**Given** monolith callers import from `src/adapters/`, `src/modules/git-worktree/`, `src/modules/git/`, and `src/modules/version-manager/`
**When** implementation files in those directories are replaced with thin re-export shims pointing to `@substrate-ai/core`
**Then** each original `index.ts` and individual file re-exports all previously visible symbols from `@substrate-ai/core`; running `npm run build` exits 0; running `npm run test:fast` exits 0 and the output contains a "Test Files" summary line with no failures

## Tasks / Subtasks

- [ ] Task 1: Migrate AdapterRegistry and CLI adapters to `packages/core/src/adapters/` (AC: #1)
  - [ ] Copy `src/adapters/schemas.ts` to `packages/core/src/adapters/schemas.ts`; update all imports to `.js` extensions; import Zod types via `../` paths only; run `tsc -b packages/core/` after each file
  - [ ] Copy `src/adapters/adapter-registry.ts` to `packages/core/src/adapters/adapter-registry.ts`; replace `import type { AgentId } from '../core/types.js'` with `../types.js`; update `./worker-adapter.js`, `./types.js` references to keep the same relative paths (already in core); replace `createLogger` calls with `logger?: ILogger` from `../dispatch/types.js`; run `tsc -b packages/core/`
  - [ ] Copy `src/adapters/claude-adapter.ts`, `codex-adapter.ts`, `gemini-adapter.ts` to `packages/core/src/adapters/`; in each file replace `import type { AgentId, BillingMode } from '../core/types.js'` with `../types.js`; replace `createLogger` with `ILogger` injection; update all intra-adapter imports to `.js` extensions; run `tsc -b packages/core/` after each file
  - [ ] Update `packages/core/src/adapters/index.ts` to add `export * from './adapter-registry.js'`, `export * from './claude-adapter.js'`, `export * from './codex-adapter.js'`, `export * from './gemini-adapter.js'`, `export * from './schemas.js'`; run `tsc -b packages/core/`

- [ ] Task 2: Migrate git utilities to `packages/core/src/git/git-utils.ts` (AC: #2)
  - [ ] Create `packages/core/src/git/` directory; copy `src/modules/git-worktree/git-utils.ts` to `packages/core/src/git/git-utils.ts`
  - [ ] Replace `import { createLogger } from '../../utils/logger.js'` — either remove logger usage entirely (use `console.error` for unexpected errors) or replace with optional `logger?: ILogger` parameter; update `import { spawn } from 'node:child_process'` to verify `node:` prefix is present; update `import { readdir, access } from 'node:fs/promises'` and `import * as path from 'node:path'` similarly
  - [ ] Run `tsc -b packages/core/` and fix any type errors before proceeding

- [ ] Task 3: Migrate GitWorktreeManager and GitWorktreeManagerImpl (AC: #3)
  - [ ] Copy `src/modules/git-worktree/git-worktree-manager.ts` to `packages/core/src/git/git-worktree-manager.ts`; replace `import type { BaseService } from '../../core/di.js'` with `import type { IBaseService } from '../types.js'`; update `GitWorktreeManager extends BaseService` to `GitWorktreeManager extends IBaseService`; run `tsc -b packages/core/`
  - [ ] Copy `src/modules/git-worktree/git-worktree-manager-impl.ts` to `packages/core/src/git/git-worktree-manager-impl.ts`; replace `import type { TypedEventBus } from '../../core/event-bus.js'` with `../events/index.js`; replace `import { createLogger } from '../../utils/logger.js'` with `ILogger` injection from `../dispatch/types.js`; update `import type { GitWorktreeManager, ... }` to `./git-worktree-manager.js`; update `import * as gitUtils from './git-utils.js'` to `./git-utils.js`; run `tsc -b packages/core/`
  - [ ] Create `packages/core/src/git/index.ts` barrel exporting all symbols from `./git-utils.js`, `./git-worktree-manager.js`, `./git-worktree-manager-impl.js`, and `./git-manager.js`; run `tsc -b packages/core/`

- [ ] Task 4: Migrate GitManager to `packages/core/src/git/` (AC: #4)
  - [ ] Copy `src/modules/git/git-manager.ts` to `packages/core/src/git/git-manager.ts`; replace `import type { BaseService } from '../../core/di.js'` with `import type { IBaseService } from '../types.js'`; replace `import type { TypedEventBus } from '../../core/event-bus.js'` with `../events/index.js`; replace `createLogger` with `ILogger` injection; update all imports to `.js` extensions; add exports to `packages/core/src/git/index.ts`; run `tsc -b packages/core/`

- [ ] Task 5: Migrate VersionManager to `packages/core/src/version-manager/` (AC: #5)
  - [ ] Copy `src/modules/version-manager/version-cache.ts` to `packages/core/src/version-manager/version-cache.ts`; check for monolith imports and update to core-relative paths or Node built-ins; run `tsc -b packages/core/`
  - [ ] Copy `src/modules/version-manager/update-checker.ts` to `packages/core/src/version-manager/update-checker.ts`; all imports are Node built-ins (`https`, `http`) and `semver` (external); update to `node:` prefixed imports where appropriate; run `tsc -b packages/core/`
  - [ ] Copy `src/modules/version-manager/version-manager.ts` (interface) to core; update `import type { MigrationResult } from '../config/config-migrator.js'` to `../config/index.js`; run `tsc -b packages/core/`
  - [ ] Copy `src/modules/version-manager/version-manager-impl.ts` to core; update `import type { MigrationResult } from '../config/config-migrator.js'` and `import { defaultConfigMigrator } from '../config/config-migrator.js'` both to `../config/index.js`; update `SUPPORTED_CONFIG_FORMAT_VERSIONS`, `SUPPORTED_TASK_GRAPH_VERSIONS` imports from `../config/config-schema.js` to the equivalent core path; replace `createLogger` with `ILogger` injection; update all local imports (`./version-manager.js`, `./update-checker.js`, `./version-cache.js`) to `.js` extensions
  - [ ] Create `packages/core/src/version-manager/index.ts` exporting all symbols; run `tsc -b packages/core/`

- [ ] Task 6: Update packages/core barrel exports (AC: #6)
  - [ ] Update `packages/core/src/index.ts` to add `export * from './git/index.js'` and `export * from './version-manager/index.js'`; the adapters export is already present (`export * from './adapters/index.js'`) and will pick up the new symbols automatically via the adapters barrel
  - [ ] Run `tsc -b packages/core/` and confirm exit code 0 with no errors; spot-check that `AdapterRegistry`, `spawnGit`, `GitWorktreeManagerImpl`, `VersionManagerImpl` are exported from compiled `packages/core/dist/index.js`

- [ ] Task 7: Install re-export shims at all original src/ paths (AC: #7, partial)
  - [ ] Replace implementation files in `src/adapters/` (`adapter-registry.ts`, `claude-adapter.ts`, `codex-adapter.ts`, `gemini-adapter.ts`, `schemas.ts`) with thin re-export shims: `export { ... } from '@substrate-ai/core'`; leave `types.ts` and `worker-adapter.ts` as shims too (already thin)
  - [ ] Replace implementation files in `src/modules/git-worktree/` (`git-utils.ts`, `git-worktree-manager.ts`, `git-worktree-manager-impl.ts`) and update `index.ts` to re-export from `@substrate-ai/core`
  - [ ] Replace `src/modules/git/git-manager.ts` and update `src/modules/git/index.ts` to re-export `GitManager` and related types from `@substrate-ai/core`
  - [ ] Replace implementation files in `src/modules/version-manager/` (`version-manager.ts`, `version-manager-impl.ts`, `update-checker.ts`, `version-cache.ts`) and update `index.ts` to re-export from `@substrate-ai/core`

- [ ] Task 8: Build verification and full test suite (AC: #7)
  - [ ] Verify no vitest processes running (`pgrep -f vitest` returns nothing)
  - [ ] Run `npm run build` and confirm exit code 0
  - [ ] Run `npm run test:fast` with a 300-second timeout; confirm output contains "Test Files" summary line with zero failures

## Dev Notes

### Architecture Constraints
- All intra-package imports in `packages/core/src/` **must** use `.js` extensions (e.g., `./git-utils.js`, `../events/index.js`)
- No file in `packages/core/src/` may import from `src/` (monolith paths are forbidden)
- Replace all `createLogger()` / `pino` usage with `logger?: ILogger` injection; import `ILogger` from `../dispatch/types.js`; default to `console` in implementations
- `BaseService` from `src/core/di.ts` is a monolith type — use `IBaseService` from `packages/core/src/types.ts` (defined by story 41-7); `GitWorktreeManager` and `GitManager` must extend `IBaseService`, not `BaseService`
- Error classes in core must extend plain `Error`, not `AppError` from the monolith
- The adapters barrel (`packages/core/src/adapters/index.ts`) already exports `types.ts` and `worker-adapter.ts` — only add new re-exports, do not remove existing ones

### Key Import Path Mappings (monolith → core-relative)
| Monolith import | Core-relative import |
|---|---|
| `'../core/types.js'` (AgentId, etc.) | `'../types.js'` |
| `'../../core/types.js'` (AgentId, etc.) | `'../types.js'` |
| `'../../core/event-bus.js'` | `'../events/index.js'` |
| `'../../utils/logger.js'` (createLogger) | remove; use `ILogger` from `'../dispatch/types.js'` |
| `'../../core/di.js'` (BaseService) | use `IBaseService` from `'../types.js'` |
| `'../config/config-migrator.js'` (MigrationResult, defaultConfigMigrator) | `'../config/index.js'` |
| `'../config/config-schema.js'` (SUPPORTED_*_VERSIONS) | `'../config/index.js'` or `'../config/config-schema.js'` (core-relative) |
| `'../../utils/logger.js'` | remove; use `ILogger` injection |
| `'./git-utils.js'` (within git-worktree-manager-impl) | `'./git-utils.js'` (same relative, already correct) |

### Adapter Dependency Note
`adapter-registry.ts` instantiates `ClaudeCodeAdapter`, `CodexCLIAdapter`, and `GeminiCLIAdapter` directly. When all three adapters are in core, the registry import paths change from `'./claude-adapter.js'` to `'./claude-adapter.js'` (same relative path — no change needed as they're all in `packages/core/src/adapters/`).

### VersionManager Config Dependency
`version-manager-impl.ts` imports `SUPPORTED_CONFIG_FORMAT_VERSIONS` and `SUPPORTED_TASK_GRAPH_VERSIONS` from `../config/config-schema.js`. Verify these constants are exported from `packages/core/src/config/` (config module was migrated in story 41-5). If the constants are exported from `packages/core/src/config/index.ts`, use `'../config/index.js'`; if from a named submodule, use the direct submodule path.

### Experimenter SpawnFn Integration
Story 41-7 defined `SpawnFn` as a caller-injectable abstraction in `packages/core/src/supervisor/experimenter.ts`. Story 41-8 provides the concrete `spawnGit` function at `packages/core/src/git/git-utils.ts`. After this story, callers that construct an `Experimenter` can pass `spawnGit` as the `spawnGit` field of `ExperimenterDeps` — no changes to Experimenter needed.

### Testing Requirements
- **Never run tests concurrently** — verify `pgrep -f vitest` returns nothing before running
- **Always use `timeout: 300000`** (5 min) when running tests
- **Never pipe test output** — must see raw vitest output including "Test Files" summary line
- Prefer `npm run test:fast` during iteration (unit tests only, ~50s)
- Run `tsc -b packages/core/` after completing each individual file migration before moving to the next — do not batch multiple files without intermediate type-checks

### Build Verification Cycle
For each migration task, follow this micro-loop:
1. Copy implementation file(s) to `packages/core/src/<module>/`
2. Update all imports: monolith paths → core-relative, `createLogger` → `ILogger`, `BaseService` → `IBaseService`
3. Add `.js` extensions to all intra-package import specifiers
4. Run `tsc -b packages/core/` — must exit 0 before proceeding
5. Create the re-export shim in `src/`
6. Run `npm run test:fast` after completing a full module (all files + shims)

### File Layout Summary
```
packages/core/src/
├── adapters/
│   ├── types.ts              (already present)
│   ├── worker-adapter.ts     (already present)
│   ├── schemas.ts            (NEW — migrated)
│   ├── adapter-registry.ts   (NEW — migrated)
│   ├── claude-adapter.ts     (NEW — migrated)
│   ├── codex-adapter.ts      (NEW — migrated)
│   ├── gemini-adapter.ts     (NEW — migrated)
│   └── index.ts              (UPDATED — add new barrel exports)
├── git/
│   ├── git-utils.ts          (NEW — migrated from git-worktree)
│   ├── git-worktree-manager.ts     (NEW — IBaseService instead of BaseService)
│   ├── git-worktree-manager-impl.ts (NEW — ILogger, IBaseService, TypedEventBus)
│   ├── git-manager.ts        (NEW — migrated from src/modules/git/)
│   └── index.ts              (NEW — barrel)
└── version-manager/
    ├── version-manager.ts    (NEW — interface)
    ├── version-manager-impl.ts (NEW — ILogger, config from core)
    ├── update-checker.ts     (NEW — node: built-ins only)
    ├── version-cache.ts      (NEW — minimal deps)
    └── index.ts              (NEW — barrel)

src/adapters/
├── types.ts                  → shim → @substrate-ai/core
├── worker-adapter.ts         → shim → @substrate-ai/core
├── schemas.ts                → shim → @substrate-ai/core
├── adapter-registry.ts       → shim → @substrate-ai/core
├── claude-adapter.ts         → shim → @substrate-ai/core
├── codex-adapter.ts          → shim → @substrate-ai/core
└── gemini-adapter.ts         → shim → @substrate-ai/core

src/modules/git-worktree/
├── git-utils.ts              → shim → @substrate-ai/core
├── git-worktree-manager.ts   → shim → @substrate-ai/core
├── git-worktree-manager-impl.ts → shim → @substrate-ai/core
└── index.ts                  → shim → @substrate-ai/core

src/modules/git/
├── git-manager.ts            → shim → @substrate-ai/core
└── index.ts                  → shim → @substrate-ai/core

src/modules/version-manager/
├── version-manager.ts        → shim → @substrate-ai/core
├── version-manager-impl.ts   → shim → @substrate-ai/core
├── update-checker.ts         → shim → @substrate-ai/core
├── version-cache.ts          → shim → @substrate-ai/core
└── index.ts                  → shim → @substrate-ai/core
```

## Interface Contracts

- **Export**: `spawnGit`, `GitSpawnResult`, `SpawnOptions` @ `packages/core/src/git/git-utils.ts` (concrete implementation of `SpawnFn` used by story 41-7's Experimenter via caller injection)
- **Export**: `GitWorktreeManager`, `GitWorktreeManagerImpl`, `GitWorktreeManagerOptions`, `WorktreeInfo`, `ConflictReport`, `MergeResult` @ `packages/core/src/git/index.ts`
- **Export**: `GitManager` @ `packages/core/src/git/git-manager.ts`
- **Export**: `VersionManager`, `VersionManagerImpl`, `VersionCheckResult`, `UpgradePreview`, `UpdateChecker`, `UpdateCheckError`, `VersionCache` @ `packages/core/src/version-manager/index.ts`
- **Import**: `TypedEventBus` @ `packages/core/src/events/index.ts` (from story 41-1)
- **Import**: `IBaseService` @ `packages/core/src/types.ts` (from story 41-7)
- **Import**: `ILogger` @ `packages/core/src/dispatch/types.ts` (from story 41-2)
- **Import**: `ConfigMigrator`, `defaultConfigMigrator`, `MigrationResult` @ `packages/core/src/config/index.ts` (from story 41-5)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
