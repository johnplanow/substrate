# Story 41.12: Core Package Alignment, Documentation, and Smoke Validation

## Story

As a Substrate developer,
I want to align the @substrate-ai/core package version, write its public documentation, update the project changelog, and run smoke validation confirming zero runtime import errors,
so that Epic 41's extraction is formally certified production-ready and the package is ready for downstream consumption.

## Acceptance Criteria

### AC1: Core Package Version Aligned to v0.9.0
**Given** `packages/core/package.json` currently declares version `0.1.0`
**When** the dev agent updates the version field
**Then** `packages/core/package.json` version is `0.9.0`, matching the root package version and reflecting the completed Core Extraction Phase 1 milestone

### AC2: Core Package README Written
**Given** `packages/core/` has no README.md
**When** the dev agent creates `packages/core/README.md`
**Then** the file documents: (a) package purpose and scope, (b) the full list of exported top-level module groups (adapters, config, dispatch, events, git, persistence, routing, telemetry, supervisor, budget, cost-tracker, monitor, version-manager), (c) at least three TypeScript import examples showing idiomatic usage of the package

### AC3: CHANGELOG Updated with v0.9.0 Entry
**Given** `CHANGELOG.md` currently only has a `[0.5.0]` entry from 2026-03-14
**When** the dev agent prepends a new entry
**Then** `CHANGELOG.md` contains a `## [0.9.0] — 2026-03-22` section that describes the `@substrate-ai/core` extraction milestone (Epic 41, stories 41-1 through 41-12), lists key exported module groups, and notes the backward-compatibility shim strategy

### AC4: npm Pack Dry-Run Succeeds
**Given** the core package is built (`dist/` exists under `packages/core/`)
**When** `npm pack --dry-run` is run inside `packages/core/`
**Then** the command exits 0 and the output lists `dist/index.js`, `dist/index.d.ts`, `package.json`, and `README.md` — confirming the tarball is properly formed with all required artifacts

### AC5: CLI Smoke Test Passes with Zero Import Errors
**Given** the substrate CLI is built and the core extraction is complete
**When** `substrate status --output-format json`, `substrate health --output-format json`, and `substrate metrics --output-format json` are each executed
**Then** all three commands exit without `MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`, or `Cannot find module` errors in stdout/stderr, confirming all `@substrate-ai/core` shims resolve correctly at runtime

### AC6: Validation Report Written
**Given** all validation steps are complete
**When** the dev agent writes the validation report
**Then** `_bmad-output/implementation-artifacts/41-12-validation-report.md` exists and contains: (a) a summary table with version alignment, build status, smoke test results, and test pass counts, (b) a list of all 12 Epic 41 stories and their completion status, and (c) an explicit Epic 41 completion certification statement

### AC7: Final Test Suite Passes
**Given** all changes (version bump, README, CHANGELOG) are applied
**When** `npm run test:fast` and `npm test` are executed sequentially
**Then** both pass with zero test failures, confirming no regressions were introduced by the documentation and versioning changes

## Tasks / Subtasks

- [ ] Task 1: Align core package version to v0.9.0 (AC1)
  - [ ] Open `packages/core/package.json` and update `"version"` from `"0.1.0"` to `"0.9.0"`
  - [ ] Verify `packages/core/package.json` `"name"` is `"@substrate-ai/core"` (do not change)

- [ ] Task 2: Write `packages/core/README.md` (AC2)
  - [ ] Create file with: H1 package name, one-paragraph purpose statement, "## Exported Modules" section listing all major namespaces, "## Usage" section with three import examples (event bus, adapter registry, persistence)
  - [ ] Keep README concise (≤ 60 lines); this is a developer-facing API reference, not a tutorial

- [ ] Task 3: Update `CHANGELOG.md` with v0.9.0 entry (AC3)
  - [ ] Prepend a new `## [0.9.0] — 2026-03-22` section above the existing `## [0.5.0]` entry
  - [ ] Entry must describe: the `@substrate-ai/core` package extraction, backward-compatibility shim strategy (`src/` modules re-export from core), and reference stories 41-1 through 41-12
  - [ ] Follow the existing changelog prose style (imperative, no bullet points for the intro paragraph)

- [ ] Task 4: Build and verify after version changes (AC1, AC4)
  - [ ] Run `tsc -b packages/core/` — confirm exit 0 (core package compiles cleanly)
  - [ ] Run `npm run build` — confirm exit 0 (full monolith + core project references build)

- [ ] Task 5: npm pack dry-run validation (AC4)
  - [ ] `cd packages/core && npm pack --dry-run 2>&1` — confirm exit 0
  - [ ] Verify output includes `dist/index.js`, `dist/index.d.ts`, `package.json`, and `README.md`

- [ ] Task 6: CLI smoke test (AC5)
  - [ ] Run `substrate status --output-format json` — capture stdout/stderr, check for import errors
  - [ ] Run `substrate health --output-format json` — capture stdout/stderr, check for import errors
  - [ ] Run `substrate metrics --output-format json` — capture stdout/stderr, check for import errors
  - [ ] Any of: `MODULE_NOT_FOUND`, `ERR_MODULE_NOT_FOUND`, `Cannot find module` → stop and investigate before proceeding

- [ ] Task 7: Write validation report (AC6)
  - [ ] Create `_bmad-output/implementation-artifacts/41-12-validation-report.md`
  - [ ] Include: summary table (version, build, smoke test status, test counts), Epic 41 story completion list, and certification statement

- [ ] Task 8: Final test suite validation (AC7)
  - [ ] Run `npm run test:fast` with `timeout: 300000` — confirm "Test Files" line shows 0 failures; record test count
  - [ ] Run `npm test` with `timeout: 300000` — confirm full suite passes; record final counts
  - [ ] Append test results to the validation report created in Task 7

## Dev Notes

### Architecture Constraints
- This story contains **no code extraction or module migration** — scope is strictly versioning, documentation, and validation
- Do not modify any `src/` shim files or `packages/core/src/` implementation files
- All intra-package imports in `packages/core/src/` use `.js` extensions (TypeScript NodeNext `moduleResolution`) — this is already correct; do not alter import paths
- The re-export shim pattern (`src/` files re-exporting from `@substrate-ai/core`) must remain intact

### Version Alignment
- Root `package.json`: already at `"0.9.0"` — do not change
- `packages/core/package.json`: update from `"0.1.0"` → `"0.9.0"`
- Do **not** change the `"name"` field (`@substrate-ai/core`) or any `"dependencies"` entries

### npm Pack Expectations
The `packages/core/dist/` directory is the build output from `tsc -b packages/core/`. Run the build step (Task 4) before the pack step (Task 5). The `files` field in `packages/core/package.json` determines what is included in the tarball — confirm it includes `"dist"` and `"src"` (or just `"dist"` if source maps are embedded).

### CLI Smoke Test — Using Global substrate Command
Per project memory, use the **global `substrate` command** for runs (not `npm run substrate:dev`). This confirms the published/installed version works with the extraction — which is the actual production scenario being validated.

If `substrate status` / `substrate health` / `substrate metrics` are not applicable in the current project directory (no initialized Dolt), they may return non-zero exit codes for expected reasons (e.g., no pipeline running). What matters is the **absence of import errors** — check stderr specifically for `MODULE_NOT_FOUND` or `Cannot find module`. A "no pipeline running" message with exit 1 is acceptable; an import error is not.

### Testing Requirements
- **NEVER run tests concurrently** — verify `pgrep -f vitest` returns nothing before starting any vitest run
- **ALWAYS use `timeout: 300000`** (5 min) for all `npm test` or `npm run test:fast` invocations
- **NEVER pipe test output** — check for "Test Files" in raw output to confirm results
- **NEVER run tests in background** — always foreground with timeout
- Build micro-loop: `tsc -b packages/core/` → `npm run build` → `npm run test:fast`

### CHANGELOG Entry Format
Follow the existing prose style in `CHANGELOG.md`. The v0.9.0 entry should be a **Breaking/Feature** entry. Model it after the v0.5.0 SQLite removal entry in structure (brief prose intro, affected parties, key changes). Example opening:

```markdown
## [0.9.0] — 2026-03-22

### Feature: @substrate-ai/core package extraction (Epic 41)

The `@substrate-ai/core` npm workspace package now contains all general-purpose agent
infrastructure modules previously embedded in the Substrate monolith. Downstream packages
(SDLC, factory) can import from `@substrate-ai/core` without coupling to SDLC-specific types.
```

### Validation Report Format
```markdown
# Epic 41 Validation Report — @substrate-ai/core Extraction Complete

## Summary

| Check | Status |
|---|---|
| packages/core version | 0.9.0 ✅ |
| npm run build | exit 0 ✅ |
| npm pack --dry-run | exit 0 ✅ |
| substrate status (no import errors) | ✅ |
| substrate health (no import errors) | ✅ |
| substrate metrics (no import errors) | ✅ |
| npm run test:fast | N tests, 0 failures ✅ |
| npm test (full suite) | N tests, 0 failures ✅ |

## Epic 41 Story Completion

| Story | Title | Status |
|---|---|---|
| 41-1 | EventBus Implementation Migration | ✅ |
| 41-2 | Dispatcher Implementation Migration | ✅ |
| 41-3 | Persistence Layer Migration | ✅ |
| 41-4 | Routing Engine Migration | ✅ |
| 41-5 | Config System Migration | ✅ |
| 41-6a | Telemetry Pipeline Infrastructure Migration | ✅ |
| 41-6b | Telemetry Scoring Module Implementations | ✅ |
| 41-7 | Supervisor, Budget, Cost-Tracker, Monitor Migration | ✅ |
| 41-8 | Adapters and Git Modules Migration | ✅ |
| 41-9 | Core Package Final Integration and Build Validation | ✅ |
| 41-10 | State Module Split — DoltClient and Dolt Init Migration | ✅ |
| 41-11 | Circular Dependency Audit and Shim Verification | ✅ |
| 41-12 | Core Package Alignment, Documentation, and Smoke Validation | ✅ |

## Certification

Epic 41 (Core Extraction Phase 1, v0.9.0) is complete.
`@substrate-ai/core` v0.9.0 is production-ready.
All 13 stories shipped. Zero circular dependencies. All shims verified. Full test suite passes.
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
