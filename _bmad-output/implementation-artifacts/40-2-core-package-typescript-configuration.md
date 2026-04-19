# Story 40-2: Core Package TypeScript Configuration

## Story

As a substrate developer,
I want `packages/core` configured with TypeScript composite mode and dependent packages referencing it correctly,
so that `tsc --build packages/core` succeeds independently and the full root `tsc --build` enforces correct dependency order (core → sdlc, factory).

## Acceptance Criteria

### AC1: Core tsconfig.json with composite mode
**Given** `packages/core/tsconfig.json` extends `../../tsconfig.base.json`
**When** the file is inspected
**Then** it contains `"composite": true`, `"outDir": "dist"`, `"rootDir": "src"`, and an `"include": ["src/**/*.ts"]` entry, with no `"references"` (core has no upstream package dependencies)

### AC2: Core builds independently
**Given** `packages/core/tsconfig.json` is in place and `packages/core/src/index.ts` exists as an empty barrel
**When** `tsc --build packages/core` is run
**Then** the command exits with code 0 and no TypeScript errors

### AC3: Core emits declaration artifacts
**Given** `tsc --build packages/core` succeeds
**When** the `packages/core/dist/` directory is inspected
**Then** `packages/core/dist/index.js`, `packages/core/dist/index.d.ts`, and `packages/core/dist/index.d.ts.map` are all present

### AC4: SDLC package tsconfig references core
**Given** `packages/sdlc/tsconfig.json` exists with `"composite": true` and `"references": [{ "path": "../core" }]`
**When** `tsc --build packages/sdlc` is run
**Then** core is built as a prerequisite before sdlc, with the command exiting code 0

### AC5: Factory package tsconfig references core
**Given** `packages/factory/tsconfig.json` exists with `"composite": true` and `"references": [{ "path": "../core" }]`
**When** `tsc --build packages/factory` is run
**Then** core is built as a prerequisite before factory, with the command exiting code 0

### AC6: Root build enforces dependency order
**Given** root `tsconfig.json` has `"references"` to all three packages (established in 40-1)
**When** `tsc --build` is run from the repository root
**Then** the build succeeds with core completing before sdlc and factory, and zero TypeScript errors across all packages

### AC7: Existing test suite is unaffected
**Given** the new TypeScript package configurations are in place
**When** `npm run test:fast` is run from the repository root
**Then** all existing tests pass (no regressions from 40-1 baseline of 5,944 tests)

## Tasks / Subtasks

- [ ] Task 1: Audit 40-1 baseline artifacts (AC: #1, #2) — read-only verification step
  - [ ] Read `packages/core/package.json` to confirm `@substrate-ai/core` name, `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`, and `"type": "module"` are present
  - [ ] Read root `tsconfig.json` to confirm `references` includes `packages/core`, `packages/sdlc`, `packages/factory`
  - [ ] Read `tsconfig.base.json` to understand shared compiler options before creating per-package configs

- [ ] Task 2: Create `packages/core/tsconfig.json` (AC: #1, #2, #3)
  - [ ] Create file extending `../../tsconfig.base.json` with `composite: true`, `outDir: "dist"`, `rootDir: "src"`, `declarationMap: true`, `include: ["src/**/*.ts"]`
  - [ ] Do NOT add `references` — core has no upstream package dependencies in this monorepo
  - [ ] Confirm the file does not override any `strict`-family options (those are inherited from `tsconfig.base.json`)

- [ ] Task 3: Create `packages/core/src/index.ts` as empty barrel (AC: #2, #3)
  - [ ] Create file with a single comment: `// @substrate-ai/core public API — exports added per story (40-3+)`
  - [ ] No actual exports at this stage — barrel fills as interface extraction stories proceed
  - [ ] Ensure `packages/core/src/` directory exists (create if not already done in 40-1)

- [ ] Task 4: Create `packages/sdlc/tsconfig.json` (AC: #4)
  - [ ] Create file extending `../../tsconfig.base.json` with `composite: true`, `outDir: "dist"`, `rootDir: "src"`, `declarationMap: true`, `include: ["src/**/*.ts"]`
  - [ ] Add `"references": [{ "path": "../core" }]` so TypeScript enforces build order
  - [ ] Ensure `packages/sdlc/src/` directory exists with a stub `index.ts` (empty barrel, same pattern as core)

- [ ] Task 5: Create `packages/factory/tsconfig.json` (AC: #5)
  - [ ] Create file extending `../../tsconfig.base.json` with `composite: true`, `outDir: "dist"`, `rootDir: "src"`, `declarationMap: true`, `include: ["src/**/*.ts"]`
  - [ ] Add `"references": [{ "path": "../core" }]` so TypeScript enforces build order
  - [ ] Ensure `packages/factory/src/` directory exists with a stub `index.ts` (empty barrel, same pattern as core)

- [ ] Task 6: Verify independent and root build success (AC: #2, #3, #4, #5, #6)
  - [ ] Run `tsc --build packages/core` and confirm exit code 0 and dist artifacts emitted
  - [ ] Run `tsc --build packages/sdlc` and confirm core was built first (check timestamps or `--verbose` output)
  - [ ] Run `tsc --build packages/factory` similarly
  - [ ] Run `tsc --build` from repository root and confirm all three packages build without error

- [ ] Task 7: Verify existing tests are unaffected (AC: #7)
  - [ ] Run `npm run test:fast` and confirm all tests pass
  - [ ] If vitest config needs updating for new `packages/` paths, apply minimal change to `vitest.config.ts` (e.g., ensure `packages/*/src` is not excluded and that `packages/*/dist` is excluded from test coverage)

## Dev Notes

### Architecture Constraints

- **Composite mode is mandatory** for every package-level `tsconfig.json` — this enables TypeScript project references and incremental builds. Without `composite: true`, `tsc --build` cannot resolve cross-package dependencies.
- **Build direction is one-way**: sdlc → core, factory → core. sdlc and factory must never reference each other. core must have no references.
- **Shared base config**: All per-package tsconfigs must extend `../../tsconfig.base.json`. Do NOT duplicate compiler options like `strict`, `target`, `module`, or `moduleResolution` — inherit from base only.
- **`packages/core/src/index.ts` must exist** before `tsc --build packages/core` can succeed — TypeScript composite mode requires at least one source file matching the `include` pattern.
- **Do not modify `src/` directory** (the existing monolithic source tree) in this story. This story is strictly additive — new files in `packages/` only.
- **`declarationMap: true`** should be in the per-package config (or in `tsconfig.base.json`) to enable source-map-aware type-checking for consumers.

### TypeScript Configuration Reference

Expected `packages/core/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "declarationMap": true
  },
  "include": ["src/**/*.ts"]
}
```

Expected `packages/sdlc/tsconfig.json` and `packages/factory/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "composite": true,
    "declarationMap": true
  },
  "references": [
    { "path": "../core" }
  ],
  "include": ["src/**/*.ts"]
}
```

### File Paths (new files this story)
- `packages/core/tsconfig.json`
- `packages/core/src/index.ts`
- `packages/sdlc/tsconfig.json`
- `packages/sdlc/src/index.ts`
- `packages/factory/tsconfig.json`
- `packages/factory/src/index.ts`

### Testing Requirements
- No new tests required for this story — it is a configuration-only story
- The critical quality gate is: `tsc --build` exits 0 from root and `npm run test:fast` passes
- If `tsc --build` fails, diagnose using `tsc --build --verbose` to identify which package is failing
- If the vitest config needs updating (e.g., to exclude `packages/*/dist`), keep changes minimal and do not touch test files themselves

### Build Command Reference
- `npm run build` uses `tsdown` (not `tsc --build`) for the production CLI build — this is separate from TypeScript project reference validation
- TypeScript project reference builds (`tsc --build`) are used for type-checking and declaration generation
- Both must work after this story: `npm run build` (existing) and `tsc --build` (new)

### Dependency: 40-1
This story depends on 40-1 having already:
- Created `packages/core/`, `packages/sdlc/`, `packages/factory/` directories with their `package.json` files
- Updated root `package.json` with `"workspaces": ["packages/core", "packages/sdlc", "packages/factory"]`
- Created root `tsconfig.json` with project references to all three packages
- Created `tsconfig.base.json` with shared compiler options
- Verified `npm test` passes (5,944 tests baseline)

If any of the above are missing, resolve them as part of this story before proceeding (they may have been deferred to 40-2 if 40-1 was partial).

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
