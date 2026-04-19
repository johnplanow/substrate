# Story 14.2: Auto-Discover Pending Stories from epics.md

Status: review

## Story

As a developer using Substrate on an existing BMAD project,
I want `substrate auto run` (without `--stories`) to automatically discover pending stories from `epics.md`,
so that I don't have to manually figure out and pass story keys when the information is already in my project artifacts.

## Context

When picking up an existing BMAD project, `substrate auto init` creates the database and scaffolds the pack, but the `requirements` table remains empty because the project never ran through substrate's analysis→planning→solutioning pipeline. Running `substrate auto run` without `--stories` queries only the `requirements` table, finds nothing, and prints "No pending stories found in decision store" — even though `_bmad-output/planning-artifacts/epics.md` contains every story key and `_bmad-output/implementation-artifacts/` shows which ones are already done.

The README promises: "Substrate can pick up the remaining implementation work." This story delivers on that promise by making auto-discovery the fallback when `requirements` is empty.

## Acceptance Criteria

### AC1: Story Key Extraction from epics.md
**Given** `_bmad-output/planning-artifacts/epics.md` exists in the project
**When** the parser processes the file content
**Then** it extracts all story keys matching the pattern `N-M` (e.g., `7-2`, `1-1`, `10-3`)
**And** extraction supports these formats found in real epics.md files:
- Explicit key lines: `**Story key:** \`7-2-human-turn-loop\`` → extracts `7-2`
- Story headings: `### Story 7.2: Human Turn Loop` → extracts `7-2`
- File path references: `_bmad-output/implementation-artifacts/7-2-human-turn-loop.md` → extracts `7-2`
**And** keys are deduplicated (each unique `N-M` appears once)
**And** keys are sorted numerically (epic number, then story number)

### AC2: Existing Story File Detection
**Given** `_bmad-output/implementation-artifacts/` contains story files
**When** the discovery function scans for existing files
**Then** it globs for `*.md` files and extracts `N-M` prefixes from filenames matching `N-M-*.md`
**And** the set of existing story keys represents completed/in-progress work

### AC3: Pending Story Computation
**Given** story keys extracted from epics.md and existing file keys
**When** pending stories are computed
**Then** pending = (all keys from epics.md) minus (keys with existing story files)
**And** the result is the set of stories that still need create-story + dev-story + code-review

### AC4: Fallback Integration in auto.ts
**Given** the user runs `substrate auto run` without `--stories`
**And** the `requirements` table is empty (no stories from full-pipeline run)
**When** auto-discovery triggers
**Then** `discoverPendingStoryKeys(projectRoot)` is called as a fallback
**And** discovered keys are used as the `storyKeys` array for the pipeline
**And** a log message is printed: `Discovered N pending stories from epics.md: key1, key2, ...`

### AC5: --stories Flag Always Takes Precedence
**Given** the user provides `--stories 7-2,7-3`
**When** `substrate auto run` executes
**Then** the explicit story keys are used regardless of what epics.md or the requirements table contain
**And** the fallback discovery is never invoked

### AC6: Graceful Degradation
**Given** `_bmad-output/planning-artifacts/epics.md` does not exist
**And** the `requirements` table is empty
**When** auto-discovery triggers
**Then** it returns an empty array without error
**And** the existing "No pending stories found" message is displayed

### AC7: Full-Pipeline Projects Unchanged
**Given** a project that ran through analysis→planning→solutioning
**And** the `requirements` table has active story entries
**When** `substrate auto run` executes without `--stories`
**Then** stories are discovered from the `requirements` table as before
**And** the epics.md fallback is never invoked

## Dev Notes

### Architecture

This follows ADR-001 (Modular Monolith): discovery logic lives in a new module file, CLI wiring stays thin.

### New File: `src/modules/implementation-orchestrator/story-discovery.ts`

Two exported functions:

```typescript
/**
 * Extract all story keys (N-M format) from epics.md content.
 * Supports: **Story key:** lines, ### Story N.M: headings, file path refs.
 */
export function parseStoryKeysFromEpics(content: string): string[]

/**
 * Discover pending story keys by diffing epics.md against existing story files.
 * Returns empty array if epics.md not found (graceful degradation).
 */
export function discoverPendingStoryKeys(projectRoot: string): string[]
```

- `parseStoryKeysFromEpics`: Regex-based extraction targeting 3 patterns, dedup via Set, numeric sort
- `discoverPendingStoryKeys`: Reads epics.md from known paths (`_bmad-output/planning-artifacts/epics.md`), globs implementation-artifacts for existing `N-M-*.md` files, returns the difference
- Co-locate with `seed-methodology-context.ts` (same module, similar concerns — both read `_bmad-output/`)
- Reuse `findArtifact()` helper pattern from seed module for path resolution

### Modified File: `src/cli/commands/auto.ts` (~15 lines)

Insert fallback block at line ~692 (after `requirements` query, before completed-run filter):

```typescript
// Fallback: discover from epics.md if requirements table is empty
if (storyKeys.length === 0) {
  storyKeys = discoverPendingStoryKeys(projectRoot)
  if (storyKeys.length > 0) {
    process.stdout.write(
      `Discovered ${storyKeys.length} pending stories from epics.md: ${storyKeys.join(', ')}\n`
    )
  }
}
```

Add import at top and re-export from `implementation-orchestrator/index.ts`.

### Modified File: `src/modules/implementation-orchestrator/index.ts`

Add export for new functions.

### Story Key Regex Strategy

From real epics.md files, three extraction patterns (applied per-epic section):

1. **Explicit key line** (most reliable): `/\*\*Story key:\*\*\s*`(\d+-\d+)/g`
2. **Story heading**: `/^###\s+Story\s+(\d+)\.(\d+)/gm` → join with `-`
3. **File path reference**: `/_bmad-output\/implementation-artifacts\/(\d+-\d+)-/g`

Dedup all results into a `Set<string>`, then sort by epic number (primary) and story number (secondary).

### Test File: `src/modules/implementation-orchestrator/__tests__/story-discovery.test.ts`

Test scenarios:
- Parse explicit `**Story key:**` lines
- Parse `### Story N.M:` headings
- Parse file path references
- Deduplicate keys appearing in multiple formats
- Numeric sort: `1-1, 1-2, 2-1, 10-1` (not lexicographic)
- Empty content returns empty array
- Content with no story patterns returns empty array
- `discoverPendingStoryKeys` with existing story files returns only pending keys
- `discoverPendingStoryKeys` with no epics.md returns empty array
- `discoverPendingStoryKeys` with all story files present returns empty array

### Test File: `src/cli/commands/__tests__/auto.test.ts`

Add one test case:
- AC4: fallback discovery invoked when requirements table empty + epics.md exists

## Tasks

- [x] Create `src/modules/implementation-orchestrator/story-discovery.ts` with `parseStoryKeysFromEpics()` and `discoverPendingStoryKeys()`
- [x] Export new functions from `src/modules/implementation-orchestrator/index.ts`
- [x] Add fallback discovery block in `src/cli/commands/auto.ts` after requirements query
- [x] Create `src/modules/implementation-orchestrator/__tests__/story-discovery.test.ts` with unit tests
- [x] Add integration test case in `src/cli/commands/__tests__/auto.test.ts`
- [x] Verify existing tests still pass (no regressions)

## Dev Agent Record

### Implementation Plan

Implemented story-discovery module as a standalone TypeScript file co-located with seed-methodology-context.ts. Used three regex patterns matching real epics.md formats. Key design decisions:
- `discoverPendingStoryKeys` uses `readdirSync` (synchronous, consistent with rest of module)
- Fallback path order: planning-artifacts/epics.md → _bmad-output/epics.md
- Numeric sort uses `split('-').map(Number)` for correct ordering (10 > 9, not "10" < "9" lexicographically)

### Completion Notes

- Created `src/modules/implementation-orchestrator/story-discovery.ts` with two public functions
- Exported both functions from `src/modules/implementation-orchestrator/index.ts`
- Modified `src/cli/commands/auto.ts`: added `discoverPendingStoryKeys` to import and added fallback block after requirements query
- Created 22 unit tests in `story-discovery.test.ts` covering all AC scenarios
- Added 2 integration tests in `auto.test.ts` (AC4 fallback + AC5 --stories precedence)
- Full test suite: 4054 tests, all passing, zero regressions

## File List

- src/modules/implementation-orchestrator/story-discovery.ts (new)
- src/modules/implementation-orchestrator/index.ts (modified)
- src/cli/commands/auto.ts (modified)
- src/modules/implementation-orchestrator/__tests__/story-discovery.test.ts (new)
- src/cli/commands/__tests__/auto.test.ts (modified)

## Change Log

- 2026-02-27: Implemented auto-discovery fallback for pending stories from epics.md (Story 14.2)
