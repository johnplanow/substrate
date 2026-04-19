# Story 23-4: Conflict Detector Generalization

Status: review

## Story

As a pipeline operator running substrate against any project,
I want the conflict detector to default to maximum parallelism for unknown projects instead of serializing all stories in the same epic,
so that cross-project runs achieve the configured concurrency level.

Addresses finding 9 (stories execute serially despite concurrency setting) from `docs/findings-cross-project-epic4-2026-03-05.md`.

Root cause: `detectConflictGroups()` in `conflict-detector.ts` has a hardcoded `STORY_PREFIX_TO_MODULE` map built for substrate's own epics. Story keys like `4-1` through `4-6` all match `'4-': 'core'`, landing in one conflict group and serializing.

## Acceptance Criteria

### AC1: Unknown Projects Default to Per-Story Isolation
**Given** story keys that do not match any entry in the project-specific conflict map
**When** `detectConflictGroups()` runs
**Then** each story is placed in its own conflict group (maximum parallelism)

### AC2: Pack-Configured Conflict Groups
**Given** a pack configuration containing a `conflictGroups` map (e.g., `{ "4-": "core", "5-": "api" }`)
**When** `detectConflictGroups()` runs with that configuration
**Then** the map is used for grouping (stories with the same module are serialized within their group)

### AC3: Substrate's Built-In Map Moves to Pack Config
**Given** the existing `STORY_PREFIX_TO_MODULE` hardcoded map
**When** this change is applied
**Then** the built-in map is removed from `conflict-detector.ts` and moved to the BMAD pack's configuration (or substrate's own project config), so it only applies when running substrate against itself

### AC4: Backward Compatibility for Substrate Self-Runs
**Given** substrate running its own pipeline (BMAD pack active)
**When** `detectConflictGroups()` runs
**Then** the same conflict grouping behavior as before is preserved (stories 10-1/10-2 still grouped, etc.)

### AC5: Concurrency Observed in Cross-Project Runs
**Given** a cross-project run with 6 independent stories and `maxConcurrency: 3`
**When** the orchestrator runs
**Then** `maxConcurrentActual` is > 1 (stories actually run in parallel)

## Tasks / Subtasks

- [x] Task 1: Remove hardcoded `STORY_PREFIX_TO_MODULE` from `conflict-detector.ts` (AC: #1, #3)
  - [x] Delete the const `STORY_PREFIX_TO_MODULE` map
  - [x] Change `detectConflictGroups()` default behavior: when no `moduleMap` config is provided, treat each story key as its own group
  - [x] Update `resolveModulePrefix()` to return `storyKey` (isolated) when effectiveMap is empty

- [x] Task 2: Add conflict group config to pack interface (AC: #2, #3)
  - [x] Add optional `conflictGroups?: Record<string, string>` to pack config type
  - [x] Thread pack config into the orchestrator → `detectConflictGroups()` call
  - [x] Pass `config.conflictGroups` as the `moduleMap` parameter

- [x] Task 3: Move substrate's map to BMAD pack config (AC: #4)
  - [x] Add the existing prefix-to-module map to BMAD pack's config file
  - [x] Verify substrate self-runs still produce correct conflict groups

- [x] Task 4: Update tests (AC: #1–#5)
  - [x] Update `conflict-detector.test.ts`: default (no map) → each story isolated
  - [x] Add test: explicit moduleMap groups stories correctly
  - [x] Add test: mixed known/unknown prefixes
  - [x] Add orchestrator test verifying `maxConcurrentActual > 1` with isolated stories

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/modules/implementation-orchestrator/conflict-detector.ts` — remove hardcoded map, accept external config
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — thread pack config to detector
  - Pack config type (likely in `src/modules/pack-manager/` or `src/types/`)
  - BMAD pack config file (in `packs/bmad/`)
- **Test framework**: vitest (not jest).

### Key Context
- The current `STORY_PREFIX_TO_MODULE` map covers epics 1-11 of substrate itself. Any cross-project story key starting with `1-` through `5-` will be falsely grouped into `'core'`.
- The `runWithConcurrency()` function at line ~1304 works correctly — the bottleneck is that `detectConflictGroups()` produces a single group.
- The Epic 4 run took 2h25m serial. With concurrency 3 and 6 independent stories, it should be ~50min.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify.

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Removed hardcoded STORY_PREFIX_TO_MODULE from conflict-detector.ts; default now isolates each story
- Added conflictGroups to PackManifest (types.ts) and PackManifestSchema (schemas.ts)
- Threaded pack.manifest.conflictGroups into detectConflictGroups() call in orchestrator-impl.ts
- Moved substrate's module map to packs/bmad/manifest.yaml under conflictGroups
- Updated conflict-detector.test.ts with new behavior tests, substrate-backward-compat tests
- Fixed orchestrator.test.ts and epic-10-integration.test.ts to use pack.conflictGroups for serialization tests
- Added AC5 tests: maxConcurrentActual > 1 for cross-project runs with no conflictGroups
- Full test suite: 4636 tests passing (180 test files)

### File List
- src/modules/implementation-orchestrator/conflict-detector.ts
- src/modules/implementation-orchestrator/orchestrator-impl.ts
- src/modules/methodology-pack/types.ts
- src/modules/methodology-pack/schemas.ts
- packs/bmad/manifest.yaml
- src/modules/implementation-orchestrator/__tests__/conflict-detector.test.ts
- src/modules/implementation-orchestrator/__tests__/orchestrator.test.ts
- src/__tests__/e2e/epic-10-integration.test.ts
- _bmad-output/implementation-artifacts/23-4-conflict-detector-generalization.md

## Change Log
