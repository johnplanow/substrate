# Story 37-4: Contract Verifier — Skip tsc for Non-TypeScript

## Story

As a developer using substrate on a polyglot or Go/Rust/Java/Python project,
I want the contract verifier to skip TypeScript type-checking when the project profile indicates a non-TypeScript stack,
so that non-TypeScript projects never fail contract verification due to a missing or irrelevant tsc binary.

## Acceptance Criteria

### AC1: Non-TypeScript buildCommand — tsc Skipped
**Given** a `.substrate/project-profile.yaml` exists with `project.buildCommand: 'go build ./...'` and an empty `packages` array (typical auto-detected single Go project)
**When** `verifyContracts(declarations, projectRoot)` is called, even if `tsconfig.json` and `node_modules/.bin/tsc` both exist
**Then** `execSync` is never called (tsc is not invoked) and no tsc-derived mismatches are added

### AC2: TypeScript buildCommand — tsc Runs Normally
**Given** a `.substrate/project-profile.yaml` exists with `project.buildCommand: 'npm run build'` and an empty `packages` array
**When** `verifyContracts(declarations, projectRoot)` is called with `tsconfig.json` and `node_modules/.bin/tsc` present
**Then** `execSync` is called with the tsc command — behavior identical to pre-37-4

### AC3: Monorepo with Mixed Packages — tsc Runs (TypeScript Present)
**Given** a `.substrate/project-profile.yaml` with `project.type: 'monorepo'` and `packages` containing one entry with `language: 'typescript'` and one with `language: 'go'`
**When** `verifyContracts(declarations, projectRoot)` is called with `tsconfig.json` and `node_modules/.bin/tsc` present
**Then** `execSync` IS called — any TypeScript package in the monorepo keeps the tsc check enabled

### AC4: All-Non-TypeScript Monorepo — tsc Skipped
**Given** a `.substrate/project-profile.yaml` with `project.type: 'monorepo'` and all entries in `packages` having non-TypeScript languages (e.g., `go`, `rust`)
**When** `verifyContracts(declarations, projectRoot)` is called, even if `tsconfig.json` and `node_modules/.bin/tsc` both exist
**Then** `execSync` is NOT called

### AC5: No Profile — Existing Behavior Preserved
**Given** no `.substrate/project-profile.yaml` exists at the project root
**When** `verifyContracts(declarations, projectRoot)` is called with `tsconfig.json` and `node_modules/.bin/tsc` present
**Then** `execSync` IS called — backward-compatible, unchanged from pre-37-4

### AC6: Malformed Profile — Graceful Fall-Through
**Given** a `.substrate/project-profile.yaml` that contains malformed YAML (or valid YAML that does not parse to an expected shape)
**When** `verifyContracts(declarations, projectRoot)` is called
**Then** no error is thrown; the tsc check proceeds based on the existing `tsconfig.json`/tsc-binary file-presence guard (conservative: allow tsc)

### AC7: File-Existence Check Unaffected by Language Guard
**Given** a `.substrate/project-profile.yaml` indicating a non-TypeScript project (tsc will be skipped) AND an exported contract file is missing from disk
**When** `verifyContracts(declarations, projectRoot)` is called
**Then** a `ContractMismatch` with `mismatchDescription` containing `'Exported file not found'` is returned — the file-existence check (AC2 from Story 25-6) still runs regardless of the language guard

## Tasks / Subtasks

- [x] Task 1: Add synchronous profile-read imports to `contract-verifier.ts` (AC: #1, #2, #3, #4, #5, #6)
  - [x] Change `import { existsSync } from 'node:fs'` → `import { existsSync, readFileSync } from 'node:fs'`
  - [x] Add `import yaml from 'js-yaml'` immediately after the `node:*` imports block, before internal imports — same style used in `src/cli/commands/init.ts`
  - [x] Confirm `js-yaml` is a project dependency (`package.json`) — it is, established in Story 37-3 audit; no `npm install` needed

- [x] Task 2: Implement `shouldRunTscCheck()` private helper (AC: #1, #2, #3, #4, #5, #6)
  - [ ] Add the following private function immediately above `verifyContracts` in `contract-verifier.ts`:
    ```typescript
    /**
     * Reads .substrate/project-profile.yaml (Story 37-1) and determines whether
     * TypeScript type-checking is appropriate for this project.
     *
     * Detection order:
     *   1. No profile → true (preserve pre-37-4 behavior)
     *   2. `packages` array non-empty → true iff any package is typescript/javascript
     *   3. `packages` empty/absent → infer from `buildCommand` — true for npm/pnpm/yarn/bun/turbo/tsc
     *   4. Parse error → true (conservative, allow tsc)
     *
     * Uses synchronous I/O to avoid making verifyContracts async (Story 37-3 pattern).
     * Does NOT import from src/modules/project-profile/ to avoid circular-dependency risk.
     */
    function shouldRunTscCheck(projectRoot: string): boolean {
      const profilePath = join(projectRoot, '.substrate', 'project-profile.yaml')
      if (!existsSync(profilePath)) return true

      try {
        const raw = readFileSync(profilePath, 'utf-8')
        const parsed = yaml.load(raw) as Record<string, unknown> | null
        if (!parsed) return true

        const project = (parsed as { project?: Record<string, unknown> })?.project
        if (!project) return true

        // Tier 1: explicit packages list — any TypeScript/JavaScript package → keep tsc
        const packages = project['packages'] as Array<{ language?: string }> | undefined
        if (Array.isArray(packages) && packages.length > 0) {
          return packages.some(
            (p) => p.language === 'typescript' || p.language === 'javascript',
          )
        }

        // Tier 2: no packages array — infer from buildCommand
        const buildCommand = project['buildCommand'] as string | undefined
        if (typeof buildCommand === 'string' && buildCommand.length > 0) {
          const tsIndicators = ['npm', 'pnpm', 'yarn', 'bun', 'tsc', 'turbo']
          return tsIndicators.some((ind) => buildCommand.includes(ind))
        }

        return true // unknown shape → conservative
      } catch {
        return true // parse failure → conservative
      }
    }
    ```

- [x] Task 3: Guard the tsc block with `shouldRunTscCheck()` (AC: #1, #2, #3, #4, #5, #6, #7)
  - [x] In `verifyContracts()`, locate the existing tsc-check section that begins with:
    ```typescript
    const tsconfigPath = join(projectRoot, 'tsconfig.json')
    const tscBinPath = join(projectRoot, 'node_modules', '.bin', 'tsc')

    if (existsSync(tsconfigPath) && existsSync(tscBinPath)) {
    ```
  - [x] Wrap the entire block — from the `const tsconfigPath` declaration through the closing `}` — in a `shouldRunTscCheck(projectRoot)` guard:
    ```typescript
    if (shouldRunTscCheck(projectRoot)) {
      const tsconfigPath = join(projectRoot, 'tsconfig.json')
      const tscBinPath = join(projectRoot, 'node_modules', '.bin', 'tsc')

      if (existsSync(tsconfigPath) && existsSync(tscBinPath)) {
        // ... existing tsc invocation and mismatch logic unchanged ...
      }
    }
    ```
  - [x] Do NOT modify any logic inside the inner tsc block — only add the outer guard
  - [x] The file-existence check block (Check 1, AC2 from Story 25-6) must remain BEFORE this guard and UNCHANGED

- [x] Task 4: Update `contract-verifier.test.ts` — extend mock and add new test suite (AC: #1–#7)
  - [x] Update the existing `vi.mock('node:fs', ...)` factory to include `readFileSync`:
    ```typescript
    vi.mock('node:fs', () => ({
      existsSync: vi.fn().mockReturnValue(false),
      readFileSync: vi.fn(),
    }))
    ```
  - [x] Add `readFileSync` to the import after the mock block:
    ```typescript
    import { existsSync, readFileSync } from 'node:fs'
    ```
  - [x] Add `const mockReadFileSync = vi.mocked(readFileSync)` below `const mockExistsSync = vi.mocked(existsSync)`
  - [x] In each existing `beforeEach`, add `mockReadFileSync.mockReset()` (or `vi.clearAllMocks()` — confirm existing suites use `vi.clearAllMocks()` and keep consistent)
  - [x] Add a new `describe` block: `'verifyContracts: AC (Story 37-4) non-TypeScript profile skips tsc'`

  - [x] **AC1 test** — non-TypeScript buildCommand skips tsc:
    - Mock `existsSync` → `true` for profile path, tsconfig.json, tsc binary, AND the exported file (no file-existence mismatch)
    - Mock `readFileSync` → return YAML string: `"project:\n  type: single\n  buildCommand: 'go build ./...'\n  packages: []\n"`
    - Call `verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)`
    - Assert `mockExecSync` was NOT called
    - Assert result array is empty (no mismatches)

  - [x] **AC2 test** — TypeScript buildCommand keeps tsc:
    - Mock `existsSync` → `true` for all paths (profile, tsconfig, tsc binary, export file)
    - Mock `readFileSync` → return YAML with `buildCommand: 'npm run build'` and `packages: []`
    - Mock `mockExecSync` → succeeds (no throw)
    - Assert `mockExecSync` WAS called

  - [x] **AC3 test** — monorepo with mixed packages keeps tsc:
    - Mock `readFileSync` → return YAML with `packages: [{language: 'typescript'}, {language: 'go'}]`
    - Mock `existsSync` → all true
    - Mock `mockExecSync` → succeeds
    - Assert `mockExecSync` WAS called

  - [x] **AC4 test** — all-non-TypeScript monorepo skips tsc:
    - Mock `readFileSync` → return YAML with `packages: [{language: 'go'}, {language: 'rust'}]`
    - Mock `existsSync` → true for tsconfig and tsc binary and export file
    - Assert `mockExecSync` was NOT called

  - [x] **AC5 test** — no profile falls through to existing behavior:
    - Mock `existsSync` → `false` for profile path, `true` for tsconfig, tsc binary, export file
    - Mock `mockExecSync` → succeeds
    - Assert `mockExecSync` WAS called

  - [x] **AC6 test** — malformed YAML doesn't throw:
    - Mock `existsSync` → `true` for profile path
    - Mock `readFileSync` → return `':::invalid yaml:::'`
    - Assert calling `verifyContracts` does not throw

  - [x] **AC7 test** — non-TypeScript profile + missing file still reports mismatch:
    - Mock `existsSync` → `true` for profile path; `false` for everything else (file missing, no tsconfig)
    - Mock `readFileSync` → return Go profile YAML
    - Call `verifyContracts([makeExportDecl(), makeImportDecl()], PROJECT_ROOT)`
    - Assert result has at least one mismatch with `mismatchDescription` containing `'Exported file not found'`
    - Assert `mockExecSync` was NOT called (tsc still skipped)

- [x] Task 5: Build and validate (AC: all)
  - [x] Run `npm run build` — must exit 0 (zero TypeScript errors)
  - [x] Run `npm run test:fast` — do NOT pipe output; confirm raw output contains `Test Files` summary and all tests pass
  - [x] Confirm `contract-verifier.test.ts` test count increases by at least 7 new cases (23 total, up from 16)

## Dev Notes

### Architecture Constraints

- **File to modify**: `src/modules/implementation-orchestrator/contract-verifier.ts`
  - Strictly additive: add imports, add `shouldRunTscCheck()` private helper, wrap tsc block
  - **Do NOT** change the `verifyContracts` function signature
  - **Do NOT** change the file-existence check (Check 1) — it must run unconditionally for all projects
  - `shouldRunTscCheck` must be **synchronous** — use `readFileSync`, NOT `loadProjectProfile()` from Story 37-1 (which is async). Follow Story 37-3's pattern exactly.
  - **Do NOT** import from `src/modules/project-profile/` — to avoid circular-dependency risk. Use inline YAML parse.

- **Test file to modify**: `src/modules/implementation-orchestrator/__tests__/contract-verifier.test.ts`
  - Extend `vi.mock('node:fs', ...)` factory to include `readFileSync: vi.fn()`
  - Add `readFileSync` to the post-mock import line
  - Add `mockReadFileSync` constant alongside `mockExistsSync`
  - Add `mockReadFileSync.mockReset()` (or rely on `vi.clearAllMocks()` in existing `beforeEach`) to each suite that touches the mock

### Key Files

| File | Action | Purpose |
|---|---|---|
| `src/modules/implementation-orchestrator/contract-verifier.ts` | **Modify** | Add `shouldRunTscCheck()` helper; guard tsc block; add `readFileSync` + `js-yaml` imports |
| `src/modules/implementation-orchestrator/__tests__/contract-verifier.test.ts` | **Modify** | Extend `node:fs` mock; add 7 new test cases for Story 37-4 ACs |

### Import Style

All local imports use `.js` extension (ESM project). External packages use bare specifier:

```typescript
import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import yaml from 'js-yaml'
import type { ContractDeclaration } from './conflict-detector.js'
import type { ContractMismatch } from './types.js'
```

### Profile YAML Shape Expected

Story 37-1 defines the schema. The `project-profile.yaml` file written by `substrate init` uses `js-yaml.dump()` (camelCase keys, not snake_case). The contract verifier reads these fields:

| Field path | Type | Meaning |
|---|---|---|
| `project.packages` | `Array<{language: string}> \| []` | Per-package language entries |
| `project.buildCommand` | `string` | Fallback when packages array is empty |

For a **single Go project** auto-detected by Story 37-1:
```yaml
project:
  type: single
  buildCommand: "go build ./..."
  testCommand: "go test ./..."
  packages: []
```
→ packages is empty, `buildCommand` does not include any ts-indicator → `shouldRunTscCheck` returns `false`

For a **Turborepo monorepo** with Go + TypeScript packages:
```yaml
project:
  type: monorepo
  tool: turborepo
  buildCommand: "turbo build"
  testCommand: "turbo test"
  packages:
    - path: apps/web
      language: typescript
    - path: apps/lock-service
      language: go
```
→ packages has TypeScript → `shouldRunTscCheck` returns `true` (conservative)

### Detection Priority in `shouldRunTscCheck()`

```
1. No .substrate/project-profile.yaml   → true  (backward compat)
2. packages[] non-empty:
     any typescript/javascript entry     → true
     all non-TypeScript entries          → false
3. packages[] empty or absent:
     buildCommand contains npm/pnpm/     → true
       yarn/bun/tsc/turbo
     buildCommand is Go/Rust/Java/etc.   → false
4. Parse error / unexpected shape        → true  (conservative)
```

### `shouldRunTscCheck` — tsIndicator List

The `tsIndicators` array used to check `buildCommand` when `packages` is empty/absent:
```typescript
const tsIndicators = ['npm', 'pnpm', 'yarn', 'bun', 'tsc', 'turbo']
```

This covers:
- `npm run build`, `pnpm run build`, `yarn run build`, `bun run build`
- Direct `tsc` calls
- `turbo build` (Turborepo monorepos — conservative: keep tsc)

Non-TypeScript build commands (`go build ./...`, `cargo build`, `./gradlew build`, `mvn compile`, `poetry build`, `pip install -e .`) contain none of these indicators.

### Dependency on Story 37-1

Story 37-1 defines the `ProjectProfile` schema and `loadProjectProfile()`. This story does **NOT** import from `src/modules/project-profile/` — we use an inline parse for the same reasons as Story 37-3 (avoid async cascade, avoid circular dependency at compile time). The YAML shape we read is stable and documented in the epic.

### Testing Requirements

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`. Do NOT use Jest APIs.
- **Run**: `npm run test:fast` during iteration — targets unit tests only (~90s), no e2e. Never pipe output.
- **Coverage**: 80% minimum enforced by vitest config.
- **Profile path construction in tests**: use `PROJECT_ROOT` constant (`'/project'`) so expected paths are:
  - Profile: `/project/.substrate/project-profile.yaml`
  - tsconfig: `/project/tsconfig.json`
  - tsc binary: `/project/node_modules/.bin/tsc`
  - Export file: `/project/src/modules/judge/types.ts` (from existing `makeExportDecl()`)

### Existing Test Suite Compatibility

The existing test suites in `contract-verifier.test.ts` must continue to pass. The `vi.mock('node:fs', ...)` factory update (adding `readFileSync`) is backward-compatible — existing tests that don't set `mockReadFileSync` will get `undefined` from `readFileSync`, which will not affect `shouldRunTscCheck` since `existsSync` for the profile path returns `false` in those tests (the default mock returns `false`).

Confirm this by running `npm run test:fast` and checking the full `contract-verifier` suite still passes.

## Interface Contracts

- **Import**: `ProjectProfile.project.buildCommand` and `ProjectProfile.project.packages[].language` field shape @ `src/modules/project-profile/index.ts` (from story 37-1) — consumed indirectly via inline YAML parse, not a TypeScript import

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Implementation was already complete when story was picked up (prior pipeline run completed the code changes)
- Build exit 0: confirmed
- All 246 test files pass; contract-verifier.test.ts has 23 tests (7 new Story 37-4 tests confirmed)

### File List
- /home/jplanow/code/jplanow/substrate/src/modules/implementation-orchestrator/contract-verifier.ts
- /home/jplanow/code/jplanow/substrate/src/modules/implementation-orchestrator/__tests__/contract-verifier.test.ts

## Change Log
