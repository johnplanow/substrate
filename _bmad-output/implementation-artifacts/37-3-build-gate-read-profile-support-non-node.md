# Story 37-3: Build Gate — Read Profile, Support Non-Node

## Story

As a developer running Substrate on a polyglot or Turborepo project,
I want the build verification gate to read `build_command` from `.substrate/project-profile.yaml` and auto-detect Turborepo,
so that the correct build command is executed (or skipped gracefully) regardless of the project's language stack.

## Acceptance Criteria

### AC1: Profile `build_command` Overrides All Auto-Detection
**Given** a `.substrate/project-profile.yaml` file exists at the project root with a `project.buildCommand` field set (e.g., `"turbo build"`)
**When** `detectPackageManager(projectRoot)` is called
**Then** the returned `command` equals `project.buildCommand` from the profile, and no lockfile or `turbo.json` checks are performed for the command

### AC2: Turborepo Auto-Detection (Without Profile)
**Given** no `.substrate/project-profile.yaml` file exists at the project root, but `turbo.json` is present
**When** `detectPackageManager(projectRoot)` is called
**Then** the returned `command` is `"turbo build"` and `packageManager` is `"none"`

### AC3: Node.js Lockfile Detection Unchanged (Backward Compatibility)
**Given** no profile and no `turbo.json`, but a `pnpm-lock.yaml` is present at the project root
**When** `detectPackageManager(projectRoot)` is called
**Then** the returned `command` is `"pnpm run build"` and `packageManager` is `"pnpm"` — identical to pre-37-3 behavior

### AC4: Non-Node Projects Skip Without Profile
**Given** no profile and no `turbo.json`, but `go.mod` is present at the project root
**When** `runBuildVerification({ projectRoot })` is called
**Then** the result has `status: 'skipped'` and `execSync` is never called

### AC5: Missing Profile Falls Through Gracefully
**Given** no `.substrate/project-profile.yaml` exists at the project root
**When** `detectPackageManager(projectRoot)` is called
**Then** detection proceeds normally through Turborepo and lockfile tiers without throwing any error

### AC6: Profile with Arbitrary Build Command Runs Correctly
**Given** `.substrate/project-profile.yaml` with `project.buildCommand: "go build ./..."` at the project root
**When** `runBuildVerification({ projectRoot })` is called (with `verifyCommand` not specified in options)
**Then** `execSync` is called with `"go build ./..."` as the command and the result is `'passed'` when exit code is 0

### AC7: Malformed Profile or Missing `buildCommand` Field Falls Through
**Given** a `.substrate/project-profile.yaml` that is malformed YAML or contains no `project.buildCommand` field
**When** `detectPackageManager(projectRoot)` is called
**Then** detection falls through to the Turborepo/lockfile tier without throwing — no error propagates to the caller

## Tasks / Subtasks

- [ ] Task 1: Add synchronous imports to `dispatcher-impl.ts` (AC: #1, #2, #6, #7)
  - [ ] Add `readFileSync` to the existing `import { existsSync } from 'node:fs'` line → `import { existsSync, readFileSync } from 'node:fs'`
  - [ ] Add `import yaml from 'js-yaml'` immediately after the `node:*` imports block (before the internal imports)
  - [ ] Verify `js-yaml` is already a project dependency (`package.json` should list it — used by `src/cli/commands/init.ts`)

- [ ] Task 2: Implement profile `build_command` read at top of `detectPackageManager()` (AC: #1, #5, #6, #7)
  - [ ] Inside `detectPackageManager(projectRoot)`, before any existing lockfile checks, add a profile-check block:
    ```typescript
    // Priority 0: read build_command from .substrate/project-profile.yaml (Story 37-3)
    const profilePath = join(projectRoot, '.substrate', 'project-profile.yaml')
    if (existsSync(profilePath)) {
      try {
        const raw = readFileSync(profilePath, 'utf-8')
        const parsed = yaml.load(raw) as Record<string, unknown> | null
        const buildCommand = (parsed as { project?: { buildCommand?: string } })?.project?.buildCommand
        if (typeof buildCommand === 'string' && buildCommand.length > 0) {
          return { packageManager: 'none', lockfile: 'project-profile.yaml', command: buildCommand }
        }
      } catch {
        // malformed YAML — fall through to auto-detection
      }
    }
    ```
  - [ ] Ensure the try-catch swallows all parse errors and allows fall-through

- [ ] Task 3: Add Turborepo auto-detection tier to `detectPackageManager()` (AC: #2, #3)
  - [ ] After the profile check block (Priority 0) and before the existing non-Node markers block, insert Turborepo detection:
    ```typescript
    // Priority 1: Turborepo monorepo — detect turbo.json before Node.js lockfiles (Story 37-3)
    if (existsSync(join(projectRoot, 'turbo.json'))) {
      return { packageManager: 'none', lockfile: 'turbo.json', command: 'turbo build' }
    }
    ```
  - [ ] Confirm existing `nonNodeMarkers` array and Node.js lockfile detection remain unchanged below this new block

- [ ] Task 4: Update the `detectPackageManager` JSDoc comment (AC: #1, #2)
  - [ ] Update the existing comment block above `detectPackageManager` to reflect the new priority order:
    - Priority 0: `.substrate/project-profile.yaml` `build_command` field
    - Priority 1: `turbo.json` → `turbo build`
    - Priority 2: Node.js lockfiles → `<pm> run build`
    - Priority 3: Non-Node markers (`pyproject.toml`, `Cargo.toml`, `go.mod`) → skip
    - Priority 4: Nothing found → skip

- [ ] Task 5: Write unit tests for profile override (AC: #1, #5, #6, #7)
  - [ ] In `src/modules/agent-dispatch/__tests__/build-verification.test.ts`, in the `detectPackageManager` suite, add a new `describe('profile override (Story 37-3)')` block
  - [ ] **AC1 test**: mock `existsSync` to return `true` for `project-profile.yaml`; mock `readFileSync` to return a valid YAML string with `project:\n  buildCommand: 'turbo build'\n`; assert `result.command === 'turbo build'` and `result.lockfile === 'project-profile.yaml'`
  - [ ] **AC6 test**: mock profile returning `buildCommand: 'go build ./...'`; feed through `runBuildVerification`; assert `execSync` called with `'go build ./...'`
  - [ ] **AC5 test**: mock `existsSync` to return `false` for all paths; assert `command === ''` (fallback skip — no profile, no lockfiles)
  - [ ] **AC7 test (malformed YAML)**: mock `readFileSync` to return `':::invalid yaml:::'`; assert `result` falls through to existing skip behavior without throwing
  - [ ] **AC7 test (missing buildCommand)**: mock `readFileSync` to return `'project:\n  type: single\n'` (no `buildCommand`); assert fall-through to lockfile detection
  - [ ] Mock `readFileSync` from `node:fs` alongside the existing `existsSync` mock:
    ```typescript
    import { existsSync, readFileSync } from 'node:fs'
    const mockReadFileSync = vi.mocked(readFileSync)
    ```
    and add `readFileSync: vi.fn()` to the `vi.mock('node:fs', ...)` factory

- [ ] Task 6: Write unit tests for Turborepo auto-detection (AC: #2, #3, #4)
  - [ ] In the same `describe('profile override (Story 37-3)')` block (or a sibling block named `describe('turborepo detection')`):
  - [ ] **AC2 test**: mock `existsSync` to return `false` for profile path and `true` for `turbo.json`; assert `result.command === 'turbo build'`
  - [ ] **AC3 test**: mock `existsSync` returning `false` for profile and `turbo.json`, `true` for `pnpm-lock.yaml`; assert existing behavior (`command === 'pnpm run build'`) is unchanged
  - [ ] **AC4 test**: mock `existsSync` returning `false` for profile and `turbo.json`, `true` for `go.mod`; call `runBuildVerification({ projectRoot })`; assert `status === 'skipped'`
  - [ ] **Priority test**: mock `existsSync` returning `true` for both profile and `turbo.json`; mock profile with `buildCommand: 'custom build'`; assert profile wins (`command === 'custom build'`)

- [ ] Task 7: Build and validate (AC: all)
  - [ ] Run `npm run build` — must exit 0 (zero TypeScript errors)
  - [ ] Run `npm run test:fast` — do NOT pipe output; confirm raw output contains "Test Files" summary and all tests pass
  - [ ] Confirm `detectPackageManager` test count increases by at least 6 new cases

## Dev Notes

### Architecture Constraints

- **File to modify**: `src/modules/agent-dispatch/dispatcher-impl.ts`
  - Strictly additive changes inside `detectPackageManager()` — no change to function signature, no change to `runBuildVerification()` signature or callers
  - `detectPackageManager` must remain **synchronous** — use `readFileSync` (sync), NOT `loadProjectProfile()` from Story 37-1 (which is async)
  - Do not import from `src/modules/project-profile/` — this would create a circular dependency risk and couples the dispatcher to the profile module at compile time. Use a lightweight inline parse instead.

- **Test file to modify**: `src/modules/agent-dispatch/__tests__/build-verification.test.ts`
  - Extend the existing `vi.mock('node:fs', ...)` factory to include `readFileSync: vi.fn()` alongside `existsSync: vi.fn()`
  - Import `readFileSync` from `node:fs` (after the mock declaration) and wrap with `vi.mocked(readFileSync)`
  - Use `beforeEach` to `mockReset()` both `mockExistsSync` and `mockReadFileSync` before each test

- **ESM import style**: all local imports use `.js` extension. External packages (`js-yaml`) use bare specifier.

- **`js-yaml` import**: `import yaml from 'js-yaml'` — same import style used in `src/cli/commands/init.ts`. Do NOT use `import * as yaml from 'js-yaml'`.

- **Profile path**: `.substrate/project-profile.yaml` relative to project root — construct with `join(projectRoot, '.substrate', 'project-profile.yaml')`. The `.substrate` directory is always the config home.

- **Profile YAML shape**: the `project-profile.yaml` file written by Story 37-2's `writeProjectProfile()` uses `js-yaml.dump()` which serializes TypeScript camelCase keys as camelCase in YAML (no snake_case conversion). So the field name in YAML is `buildCommand` (camelCase), not `build_command`.

- **`DEFAULT_VERIFY_COMMAND` constant**: this is exported as `'npm run build'` and referenced in the existing test. Do NOT change it — it's the explicit override value used when callers pass `verifyCommand` directly. The auto-detection path (used when `verifyCommand === undefined`) is what we're enhancing.

- **Turborepo detection placement**: insert between the profile check block and the existing `nonNodeMarkers` array iteration. The `nonNodeMarkers` array already includes `go.mod`, `Cargo.toml`, etc., so non-Node projects continue to skip correctly as before.

### Key Files

| File | Action | Purpose |
|---|---|---|
| `src/modules/agent-dispatch/dispatcher-impl.ts` | **Modify** | Add profile check + Turborepo detection inside `detectPackageManager()` |
| `src/modules/agent-dispatch/__tests__/build-verification.test.ts` | **Modify** | Add tests for profile override and Turborepo detection |

### Priority Order in `detectPackageManager()` After This Story

```
0. .substrate/project-profile.yaml → project.buildCommand  (most explicit, wins)
1. turbo.json                       → 'turbo build'
2. pnpm-lock.yaml                   → 'pnpm run build'
3. yarn.lock                        → 'yarn run build'
4. bun.lockb                        → 'bun run build'
5. package-lock.json                → 'npm run build'
6. pyproject.toml / poetry.lock / setup.py → '' (skip)
7. Cargo.toml                       → '' (skip)
8. go.mod                           → '' (skip)
9. (nothing found)                  → '' (skip)
```

### Testing Requirements

- **Test framework**: Vitest — use `describe`, `it`, `expect`, `vi`, `beforeEach`. Do NOT use Jest APIs.
- **Run**: `npm run test:fast` during iteration — targets unit tests only (~90s), no e2e. Never pipe output.
- **Coverage**: `80%` minimum enforced by vitest config.
- **Mock pattern for `readFileSync`**:
  ```typescript
  vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
  }))
  import { existsSync, readFileSync } from 'node:fs'
  const mockExistsSync = vi.mocked(existsSync)
  const mockReadFileSync = vi.mocked(readFileSync)
  ```
  In each test that exercises profile reading, call `mockReadFileSync.mockReturnValue('<yaml string>')` to control what the profile contains.

### Dependency on Story 37-1

Story 37-1 defines `ProjectProfile` and `loadProjectProfile()` but **this story does NOT import from it**. We intentionally use a synchronous inline YAML read to avoid:
1. Making `detectPackageManager` async (which would cascade to `runBuildVerification` and all callers)
2. Creating a compile-time dependency between `agent-dispatch` and `project-profile` modules

The profile YAML format is stable enough that a lightweight inline parse is safe.

## Interface Contracts

- **Import**: `ProjectProfile.project.buildCommand` field shape @ `src/modules/project-profile/index.ts` (from story 37-1) — consumed indirectly via YAML parse, not a TypeScript import

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
