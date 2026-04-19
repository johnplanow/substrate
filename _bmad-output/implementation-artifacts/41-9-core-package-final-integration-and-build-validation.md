# Story 41.9: Core Package Final Integration and Build Validation

## Story

As a substrate-core package consumer,
I want `@substrate-ai/core` to expose a complete barrel API covering all migrated modules (supervisor, budget, cost-tracker, monitor, git, version-manager, plus the modules from 41-1 through 41-6b), with zero circular dependencies, validated package metadata, and a build-passing test suite,
so that downstream packages (`@substrate-ai/sdlc`, `@substrate-ai/factory`) and the monolith shims can safely depend on `@substrate-ai/core` as the single authoritative source of implementation and the Epic 41 success criteria are confirmed satisfied.

## Acceptance Criteria

### AC1: packages/core/src/index.ts exposes complete barrel exports for all migrated modules
**Given** stories 41-7 and 41-8 have added `supervisor/`, `budget/`, `cost-tracker/`, `monitor/`, `git/`, and `version-manager/` subdirectories under `packages/core/src/`
**When** `packages/core/src/index.ts` is updated and `tsc -b packages/core/` is run
**Then** `packages/core/src/index.ts` contains `export * from './supervisor/index.js'`, `export * from './budget/index.js'`, `export * from './cost-tracker/index.js'`, `export * from './monitor/index.js'`, `export * from './git/index.js'`, and `export * from './version-manager/index.js'`; any name conflicts are resolved with explicit selective re-exports; `tsc -b packages/core/` exits 0 with no errors

### AC2: Zero circular dependencies detected in packages/core/src/
**Given** all module implementations from stories 41-1 through 41-8 are present in `packages/core/src/`
**When** `npx madge --circular --extensions ts packages/core/src/index.ts` is executed
**Then** the command prints "No circular dependency found!" (exit code 0); if cycles are detected they are eliminated by moving the shared type to `packages/core/src/types.ts` or extracting a thin interface file before re-running

### AC3: packages/core/package.json metadata is complete and correct
**Given** `packages/core/package.json` currently exports only the root `.` entry point and lists `js-yaml` and `zod` as dependencies
**When** the package metadata is audited and updated
**Then** `packages/core/package.json` lists all runtime `dependencies` that core implementations actually import at runtime (e.g., `semver` if used by `VersionManager`, `@dolt/dolt-js` if used by `DoltDatabaseAdapter`); optional native dependencies (e.g., `better-sqlite3`) are in `optionalDependencies`; `"peerDependencies"` is present listing `typescript` if needed; running `npm pack --dry-run --prefix packages/core` completes without error and lists expected files in `dist/`

### AC4: packages/sdlc and packages/factory import only from @substrate-ai/core, never from src/
**Given** `packages/sdlc/` and `packages/factory/` both declare `"@substrate-ai/core": "*"` in their `package.json` dependencies
**When** all TypeScript files under `packages/sdlc/src/` and `packages/factory/src/` are audited for import sources
**Then** no file in either package contains an import path that resolves to the monolith's `src/` directory (i.e., no `../../src/`, no relative traversal to a monolith path); all cross-package symbols are imported from `'@substrate-ai/core'` or from within the package itself; `tsc -b packages/sdlc/ packages/factory/` exits 0

### AC5: Full monolith build completes cleanly under 5 seconds
**Given** all re-export shims from stories 41-1 through 41-8 are in place across `src/core/`, `src/adapters/`, `src/modules/`
**When** `time npm run build` is executed from the repository root
**Then** the build exits 0 with no TypeScript errors; wall-clock time reported by `time` is ≤ 5 seconds; no shim file emits an unresolved import error against `@substrate-ai/core`

### AC6: npm run test:fast passes with zero failures after barrel and package changes
**Given** `packages/core/src/index.ts` has been updated and any package.json changes have been applied
**When** `npm run test:fast` is run (unit tests only, no e2e, ~50s)
**Then** the output contains a "Test Files" summary line; the number of failed test files is 0; no new import resolution errors appear in test output that were not present before this story

### AC7: npm test (full suite) passes with zero failures
**Given** build is clean and test:fast confirms zero unit-test regressions
**When** `npm test` is run (full suite with coverage)
**Then** the output contains a "Test Files" summary line confirming all tests pass (target: 5,944 tests); exit code is 0; coverage does not regress below pre-epic baseline

## Tasks / Subtasks

- [ ] Task 1: Audit missing barrel exports and update packages/core/src/index.ts (AC: #1)
  - [ ] Check which subdirectories exist under `packages/core/src/` that are not yet referenced in `packages/core/src/index.ts` — expected: `supervisor/`, `budget/`, `cost-tracker/`, `monitor/`, `git/`, `version-manager/`
  - [ ] For each missing module directory that exists, add `export * from './<module>/index.js'` to `packages/core/src/index.ts`; add a brief comment line before each group naming the exported symbols (same style as existing entries)
  - [ ] Identify any symbol name conflicts introduced by the new wildcard exports (TypeScript will report TS2308 on ambiguous re-exports); resolve conflicts by replacing the wildcard with explicit named `export type { ... }` or `export { ... }` entries for the conflicting symbols
  - [ ] Run `tsc -b packages/core/` and confirm exit code 0

- [ ] Task 2: Run circular dependency audit and fix detected cycles (AC: #2)
  - [ ] Install `madge` if not already available: `npx madge --version` — if missing, run `npm install --save-dev madge` at repo root
  - [ ] Run `npx madge --circular --extensions ts packages/core/src/index.ts`; capture output
  - [ ] For each reported cycle, identify the offending import: if it is a shared type imported bidirectionally, extract the type declaration to `packages/core/src/types.ts` (or the nearest appropriate `types.ts`); if it is an implementation dependency, introduce an interface at the point of the cycle and import the interface instead
  - [ ] Re-run `npx madge --circular --extensions ts packages/core/src/index.ts` until output reads "No circular dependency found!" (exit code 0)
  - [ ] Run `tsc -b packages/core/` after each cycle-breaking change to confirm no type errors are introduced

- [ ] Task 3: Validate and update packages/core/package.json (AC: #3)
  - [ ] Scan all `packages/core/src/**/*.ts` files for third-party imports (non-relative, non-`node:` prefixed); collect the unique package names
  - [ ] Compare collected packages against `packages/core/package.json` `dependencies` and `optionalDependencies`; add any missing runtime dependencies; mark as `optionalDependencies` any package that is only required when a particular backend is active (e.g., a Dolt client library)
  - [ ] Confirm `"type": "module"` is present, `"exports"` map has `"."` pointing to `./dist/index.js` and `./dist/index.d.ts`, and `"files": ["dist"]` is set
  - [ ] Run `npm pack --dry-run --prefix packages/core` (or `cd packages/core && npm pack --dry-run`) and confirm it lists files under `dist/` without errors

- [ ] Task 4: Audit and fix packages/sdlc and packages/factory import compliance (AC: #4)
  - [ ] Run `grep -r "from '\.\./\.\./src" packages/sdlc/src packages/factory/src 2>/dev/null` and `grep -r "from '.*\/src\/" packages/sdlc/src packages/factory/src 2>/dev/null` to detect any relative escapes into the monolith
  - [ ] For each offending import found, replace it with the equivalent import from `'@substrate-ai/core'`; if the symbol is not yet exported from core, add it to the appropriate module barrel and re-run `tsc -b packages/core/`
  - [ ] Run `tsc -b packages/sdlc/ packages/factory/` and confirm exit code 0; fix any remaining type errors

- [ ] Task 5: Validate full monolith build time (AC: #5)
  - [ ] Run `npm run build` once to warm any caches, then run `time npm run build` and record wall-clock time
  - [ ] If build time exceeds 5 seconds, run `tsc --extendedDiagnostics` to identify bottlenecks (slow files or project references); apply targeted fixes (e.g., ensure `packages/core/tsconfig.json` uses `composite: true` and `incremental: true` so the monolith build references pre-built core rather than re-compiling it)
  - [ ] Confirm `npm run build` exits 0 with no errors after any changes

- [ ] Task 6: Run test:fast and confirm zero failures (AC: #6)
  - [ ] Verify no vitest instance is running: `pgrep -f vitest` must return nothing
  - [ ] Run `npm run test:fast` (no pipes, no background) with a 300-second timeout
  - [ ] Confirm the output contains a "Test Files" summary line; confirm failed test count is 0
  - [ ] If any test fails due to import resolution errors (e.g., `@substrate-ai/core` export missing), fix the barrel export and re-run; if a test fails for an unrelated reason already present before this story, document it in Dev Agent Record without unblocking the story

- [ ] Task 7: Run full test suite and confirm epic success criteria (AC: #7)
  - [ ] Verify no vitest instance is running: `pgrep -f vitest` must return nothing
  - [ ] Run `npm test` with a 300-second timeout
  - [ ] Confirm the output contains a "Test Files" summary line; confirm exit code is 0 and failed test count is 0
  - [ ] Record the final passing test count in the Dev Agent Record Completion Notes as confirmation that Epic 41's 5,944-test target is met

## Dev Notes

### Architecture Constraints
- All intra-package imports in `packages/core/src/` **must** use `.js` extensions (e.g., `'./supervisor/index.js'`, `'../types.js'`)
- No file in `packages/core/src/` may import from `src/` (monolith paths are forbidden)
- When resolving barrel export conflicts (TS2308), prefer explicit named re-exports over removing the wildcard entirely — this preserves discoverability for downstream consumers
- `ILogger` is defined in `packages/core/src/dispatch/types.ts` and is the canonical logger interface for all core modules — do not introduce a second `ILogger` type
- `IBaseService` is defined in `packages/core/src/types.ts` — all service interfaces in core must extend this, not `BaseService` from the monolith

### Barrel Export Conflict Resolution Pattern
If two modules export the same name (e.g., both `telemetry` and `routing` export `ITelemetryPersistence`), resolve with:
```typescript
// packages/core/src/index.ts
// ... wildcard exports for non-conflicting modules ...
export type { ITelemetryPersistence } from './telemetry/index.js'  // canonical export takes precedence
export * from './telemetry/index.js'   // picks up all other telemetry exports
// routing wildcard excluded for the conflicting symbol only, if needed:
export type { IRoutingTelemetryPersistence } from './routing/index.js'
export * from './routing/index.js'
```
The existing `index.ts` already uses this pattern for `ITelemetryPersistence` — follow the same approach for any new conflicts.

### Circular Dependency Resolution Pattern
Cycles in `packages/core/src/` are typically caused by:
1. **A module importing a sibling's concrete class** when only the interface is needed → move the interface to `../types.ts`
2. **Two modules importing each other's types** → extract shared types to a new `shared-types.ts` in the common ancestor directory
3. **An index re-exporting a file that in turn imports from the index** → re-export from the concrete file path, not the index barrel

### Build Performance Notes
The target is ≤ 5 seconds for `npm run build`. To ensure incremental builds, verify:
- `packages/core/tsconfig.json` has `"composite": true` and `"incremental": true`
- The root `tsconfig.json` (or `tsconfig.build.json`) uses `"references": [{ "path": "packages/core" }]` so the monolith build uses pre-compiled core declarations
- `packages/core` is built first via `tsc -b packages/core/` before the monolith tsc run

### SDLC/Factory Import Audit Commands
```bash
# Detect any escape paths out of packages/ into src/
grep -rn "from '\.\." packages/sdlc/src packages/factory/src | grep -v "node_modules"
grep -rn "require(" packages/sdlc/src packages/factory/src | grep -v "node_modules"

# Verify @substrate-ai/core resolves (should print dist/index.d.ts path)
node -e "require.resolve('@substrate-ai/core')"
```

### Testing Requirements
- **Never run tests concurrently** — verify `pgrep -f vitest` returns nothing before running
- **Always use `timeout: 300000`** (5 min) when running tests via Bash tool
- **Never pipe test output** — must see raw vitest output including "Test Files" summary line
- Run `tsc -b packages/core/` after every structural change before proceeding to the next task
- `npm run test:fast` is sufficient for iteration validation; `npm test` is the final gate

### Build Verification Cycle
For each change in this story, follow this micro-loop:
1. Make the change (barrel update, package.json edit, cycle fix)
2. Run `tsc -b packages/core/` — must exit 0
3. Run `npm run build` — must exit 0
4. Run `npm run test:fast` — must show "Test Files" summary with 0 failures

### File Layout Summary
```
packages/core/src/index.ts              UPDATED — add supervisor, budget, cost-tracker,
                                                   monitor, git, version-manager exports
packages/core/package.json              UPDATED — verify/add runtime dependencies,
                                                   optionalDependencies
packages/core/src/types.ts              POSSIBLY UPDATED — if cycle-breaking requires
                                                            extracting shared interfaces

packages/sdlc/src/**/*.ts               AUDITED — no monolith src/ imports permitted
packages/factory/src/**/*.ts            AUDITED — no monolith src/ imports permitted
```

## Interface Contracts

- **Import**: `BudgetTracker`, `BudgetTrackerImpl`, `createBudgetTracker` @ `packages/core/src/budget/index.ts` (from story 41-7)
- **Import**: `CostTracker`, `CostTrackerSubscriber`, token rate constants @ `packages/core/src/cost-tracker/index.ts` (from story 41-7)
- **Import**: `MonitorAgent`, `TaskTypeClassifier`, `RecommendationEngine`, `ReportGenerator` @ `packages/core/src/monitor/index.ts` (from story 41-7)
- **Import**: supervisor analysis functions, `Experimenter` @ `packages/core/src/supervisor/index.ts` (from story 41-7; excludes `analyzeReviewCycles` which stays in monolith)
- **Import**: `spawnGit`, `GitWorktreeManager`, `GitWorktreeManagerImpl`, `GitManager` @ `packages/core/src/git/index.ts` (from story 41-8)
- **Import**: `VersionManager`, `VersionManagerImpl`, `UpdateChecker`, `VersionCache` @ `packages/core/src/version-manager/index.ts` (from story 41-8)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
