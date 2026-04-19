# Story 24-8: Auto-Detect Package Manager for Build Verification

Status: review

## Story

As a pipeline operator running substrate on projects that use pnpm or yarn,
I want the build verification gate to auto-detect the package manager from the project's lockfile,
so that `npm run build` isn't used when the project uses pnpm (causing build verification to fail with "Missing script").

Addresses: Cross-project Epic 4 run where the build verification gate ran `npm run build` on a pnpm monorepo that only had `build:all` in its root `package.json`. The user had to manually add a `build` alias.

## Acceptance Criteria

### AC1: Lockfile Detection
**Given** a project root directory
**When** the build verification gate resolves the default verify command
**Then** it checks for lockfiles in order: `pnpm-lock.yaml` → `pnpm run build`, `yarn.lock` → `yarn run build`, `bun.lockb` → `bun run build`, `package-lock.json` → `npm run build`, none found → `npm run build`

### AC2: Pack Manifest Override Still Takes Precedence
**Given** a pack manifest with `verifyCommand: "make build"`
**When** the build verification gate runs
**Then** the manifest value is used regardless of lockfile detection (existing behavior preserved)

### AC3: verifyCommand: false Still Skips
**Given** a pack manifest with `verifyCommand: false`
**When** the build verification gate runs
**Then** verification is skipped (existing behavior preserved)

### AC4: Detection Logged
**Given** lockfile auto-detection selects `pnpm run build`
**When** the build verification runs
**Then** the detected package manager and resolved command are logged at `info` level with `{ packageManager, lockfile, resolvedCommand }`

### AC5: No Lockfile Falls Back to npm
**Given** a project with no lockfile at all
**When** the build verification gate resolves the command
**Then** it falls back to `npm run build` (current default behavior preserved)

## Tasks / Subtasks

- [x] Task 1: Implement `detectPackageManager()` (AC: #1, #5)
  - [x] In `src/modules/agent-dispatch/dispatcher-impl.ts` (near `runBuildVerification`)
  - [x] Check `existsSync` for lockfiles in priority order at `projectRoot`
  - [x] Return `{ packageManager: 'pnpm' | 'yarn' | 'bun' | 'npm', lockfile: string | null, command: string }`
  - [x] Fall back to `npm` when no lockfile found

- [x] Task 2: Integrate into `runBuildVerification` (AC: #1, #2, #3, #4)
  - [x] Replace `DEFAULT_VERIFY_COMMAND` usage: when `verifyCommand` is `undefined`, call `detectPackageManager(projectRoot)` instead of using the hardcoded constant
  - [x] When `verifyCommand` is explicitly set (string or false), use it as-is (existing behavior)
  - [x] Log the detection result

- [x] Task 3: Unit tests (AC: #1-#5)
  - [x] Test: project with `pnpm-lock.yaml` → resolves to `pnpm run build`
  - [x] Test: project with `yarn.lock` → resolves to `yarn run build`
  - [x] Test: project with `bun.lockb` → resolves to `bun run build`
  - [x] Test: project with `package-lock.json` → resolves to `npm run build`
  - [x] Test: project with no lockfile → resolves to `npm run build`
  - [x] Test: project with both `pnpm-lock.yaml` and `package-lock.json` → pnpm wins (priority order)
  - [x] Test: explicit `verifyCommand` overrides detection
  - [x] Test: `verifyCommand: false` still skips

## Dev Notes

### Key Files
- `src/modules/agent-dispatch/dispatcher-impl.ts` — `runBuildVerification`, `DEFAULT_VERIFY_COMMAND`
- `src/modules/agent-dispatch/__tests__/build-verification.test.ts` — existing test file

### Design Decisions
- Detection is based on lockfile presence, not `package.json` `packageManager` field — lockfiles are more reliable and always present in real projects
- Priority order matches ecosystem adoption: pnpm is checked first because monorepos (most common substrate target) increasingly use pnpm
- `DEFAULT_VERIFY_COMMAND` constant is kept for backward-compat reference but no longer the sole default

## Change Log
- 2026-03-06: Story created from cross-project pipeline findings (code-review-agent build verification failure)
