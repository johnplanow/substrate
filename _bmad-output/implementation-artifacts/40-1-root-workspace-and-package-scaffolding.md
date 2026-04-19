# Story 40-1: Root Workspace and Package Scaffolding

## Story

As a substrate developer,
I want the repository structured as an npm workspaces monorepo with three package scaffolds (`core`, `sdlc`, `factory`) and a root `tsconfig.json` with project references,
so that subsequent epic-40 stories can define interfaces in isolated packages without touching any existing `src/` code or breaking the current test suite.

## Acceptance Criteria

### AC1: npm Workspaces Registered
**Given** the repository root `package.json` lists `packages/core`, `packages/sdlc`, and `packages/factory` as workspaces
**When** `npm ls --workspaces` is run
**Then** it resolves and lists `@substrate-ai/core`, `@substrate-ai/sdlc`, and `@substrate-ai/factory` as workspace packages with no errors

### AC2: Package Manifest Fields
**Given** `packages/core/package.json`, `packages/sdlc/package.json`, and `packages/factory/package.json` exist
**When** each file is inspected
**Then** each contains `name`, `version`, `main` (`./dist/index.js`), and `types` (`./dist/index.d.ts`) fields, and the names are `@substrate-ai/core`, `@substrate-ai/sdlc`, and `@substrate-ai/factory` respectively

### AC3: TypeScript Project References Build
**Given** the root `tsconfig.json` includes a `references` array pointing to all three package directories
**When** `tsc --build` is run from the repository root
**Then** it exits with code 0 and zero type errors (the packages compile as empty composite projects)

### AC4: Shared Base TypeScript Config
**Given** a `tsconfig.base.json` at the repository root defines shared compiler options (`strict`, `target`, `module`, `moduleResolution`, `declaration`, `declarationMap`, `sourceMap`, `esModuleInterop`, `skipLibCheck`)
**When** each package's `tsconfig.json` extends `../../tsconfig.base.json`
**Then** all three packages share identical baseline compiler settings and each compiles cleanly with `composite: true`

### AC5: Existing Test Suite Unaffected
**Given** the monorepo workspace configuration and new package directories are in place
**When** `npm run test:fast` is run from the repository root
**Then** all existing tests pass (same count as pre-story baseline) with no import errors or missing-module failures

## Tasks / Subtasks

- [x] Task 1: Add workspaces to root `package.json` (AC: #1)
  - [ ] Add `"workspaces": ["packages/core", "packages/sdlc", "packages/factory"]` to root `package.json`
  - [ ] Do NOT alter existing `scripts`, `dependencies`, `devDependencies`, or any other fields
  - [ ] Run `npm install` to update `package-lock.json` with workspace symlinks

- [x] Task 2: Create `tsconfig.base.json` (AC: #4)
  - [ ] Create `tsconfig.base.json` at repo root with compiler options extracted from the current `tsconfig.json`:
    - `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"` (packages use Node-native resolution, not bundler)
    - `strict: true`, `exactOptionalPropertyTypes: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`
    - `declaration: true`, `declarationMap: true`, `sourceMap: true`
    - `esModuleInterop: true`, `allowSyntheticDefaultImports: true`, `forceConsistentCasingInFileNames: true`, `skipLibCheck: true`
    - `resolveJsonModule: true`
  - [ ] Do NOT include `outDir`, `rootDir`, `composite`, `paths`, or `baseUrl` — those are per-package

- [x] Task 3: Scaffold `packages/core/` (AC: #2, #3, #4)
  - [ ] Create `packages/core/package.json`:
    ```json
    {
      "name": "@substrate-ai/core",
      "version": "0.1.0",
      "type": "module",
      "main": "./dist/index.js",
      "types": "./dist/index.d.ts",
      "exports": {
        ".": { "import": "./dist/index.js", "types": "./dist/index.d.ts" }
      },
      "files": ["dist"]
    }
    ```
  - [ ] Create `packages/core/tsconfig.json`:
    ```json
    {
      "extends": "../../tsconfig.base.json",
      "compilerOptions": { "outDir": "dist", "rootDir": "src", "composite": true },
      "include": ["src/**/*.ts"]
    }
    ```
  - [ ] Create `packages/core/src/index.ts` as an empty barrel export file (single comment line: `// @substrate-ai/core — public API (populated in stories 40-3 through 40-8)`)

- [x] Task 4: Scaffold `packages/sdlc/` (AC: #2, #3, #4)
  - [ ] Create `packages/sdlc/package.json` with `name: "@substrate-ai/sdlc"` following the same structure as core
  - [ ] Create `packages/sdlc/tsconfig.json` extending `../../tsconfig.base.json`; add `"references": [{ "path": "../core" }]` since sdlc will depend on core
  - [ ] Create `packages/sdlc/src/index.ts` with a single comment line

- [x] Task 5: Scaffold `packages/factory/` (AC: #2, #3, #4)
  - [ ] Create `packages/factory/package.json` with `name: "@substrate-ai/factory"` following the same structure as core
  - [ ] Create `packages/factory/tsconfig.json` extending `../../tsconfig.base.json`; add `"references": [{ "path": "../core" }]` since factory will depend on core
  - [ ] Create `packages/factory/src/index.ts` with a single comment line

- [x] Task 6: Add project references to root `tsconfig.json` (AC: #3)
  - [ ] Add a `references` array to the **existing** root `tsconfig.json` (keep all current `compilerOptions` and `include` fields intact so `tsc --noEmit` and `tsconfig.typecheck.json` continue to work):
    ```json
    "references": [
      { "path": "packages/core" },
      { "path": "packages/sdlc" },
      { "path": "packages/factory" }
    ]
    ```
  - [ ] Verify that `tsc --noEmit` (typecheck) still exits 0 after this change
  - [ ] Run `tsc --build` and confirm exit code 0 with zero errors

- [x] Task 7: Verify vitest config and run tests (AC: #5)
  - [ ] Confirm `vitest.config.ts` `include` patterns (`test/**/*.test.ts`, `src/**/*.test.ts`) do not accidentally glob into the new `packages/` directories (they don't — patterns are relative to root and scoped to `test/` and `src/`)
  - [ ] Run `npm run test:fast` and confirm all tests pass; if test count has changed, investigate before proceeding

## Dev Notes

### Architecture Constraints
- **No code moves in this story** — `src/` is untouched. The three packages contain only an empty `src/index.ts` barrel. All real interface extraction happens in stories 40-2 through 40-8.
- **Package module format**: use `"type": "module"` in each workspace package.json so they align with the ESM root. Use `module: "NodeNext"` / `moduleResolution: "NodeNext"` in `tsconfig.base.json` so TypeScript resolves packages via Node12+ semantics.
- **`composite: true` is required** in each package's `tsconfig.json` for TypeScript project references (`tsc --build`) to work.
- **Root tsconfig.json strategy**: the root `tsconfig.json` currently drives `tsc --noEmit` and `tsconfig.typecheck.json` extends it. Append `references` to the existing root config rather than replacing it. This is safe: `tsc --noEmit` ignores `references`, and `tsc --build` uses them.
- **`tsdown` is unaffected**: the existing `npm run build` uses `tsdown`, which reads `tsconfig.json` for type info but does not use `tsc --build` project references. No changes to the tsdown build pipeline.

### File Paths
```
package.json                          ← MODIFY (add workspaces)
tsconfig.json                         ← MODIFY (add references array)
tsconfig.base.json                    ← NEW
packages/
  core/
    package.json                      ← NEW
    tsconfig.json                     ← NEW
    src/
      index.ts                        ← NEW (empty barrel)
  sdlc/
    package.json                      ← NEW
    tsconfig.json                     ← NEW (references ../core)
    src/
      index.ts                        ← NEW (empty barrel)
  factory/
    package.json                      ← NEW
    tsconfig.json                     ← NEW (references ../core)
    src/
      index.ts                        ← NEW (empty barrel)
```

### TypeScript Version Note
The project uses TypeScript `^5.9.0`. Project references with `composite: true` are fully supported. The `NodeNext` module resolution in `tsconfig.base.json` requires `.js` extensions in relative imports within package source files (even when authoring `.ts`). Since the packages start empty this is a non-issue for 40-1, but document this convention for 40-3+.

### Testing Requirements
- No new test files needed for this story — it is pure scaffolding
- The gate is `npm run test:fast` passing with the same test count as before
- Additionally run `npm ls --workspaces` and `tsc --build` manually to satisfy AC1 and AC3

### Dependency Graph (packages only)
```
@substrate-ai/factory ──► @substrate-ai/core
@substrate-ai/sdlc    ──► @substrate-ai/core
@substrate-ai/core    (no package deps)
```

## Dev Agent Record

### Agent Model Used
Claude Opus 4.6

### Completion Notes List
- All 6 review findings from previous implementation addressed
- Explicit workspace array used (not glob)
- Build script unchanged (tsdown only)
- No out-of-scope dependencies (no zod, no dpdm)
- Root tsconfig.json include preserved for typecheck
- Package index.ts files contain single comment line only
- Baseline: 251 test files, 5944 tests — same after changes

### File List
- package.json (modified: added workspaces array)
- package-lock.json (modified: workspace symlinks)
- tsconfig.json (modified: added references array)
- tsconfig.base.json (new: shared compiler options)
- .gitignore (modified: added *.tsbuildinfo)
- packages/core/package.json (new)
- packages/core/tsconfig.json (new)
- packages/core/src/index.ts (new: empty barrel)
- packages/sdlc/package.json (new)
- packages/sdlc/tsconfig.json (new)
- packages/sdlc/src/index.ts (new: empty barrel)
- packages/factory/package.json (new)
- packages/factory/tsconfig.json (new)
- packages/factory/src/index.ts (new: empty barrel)

## Change Log
