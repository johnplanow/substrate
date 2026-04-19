# Story 23-1: Epic Shard Overhaul

Status: ready

## Story

As a pipeline operator running substrate against any project,
I want epic shards to be seeded correctly regardless of heading format, re-seeded when the source file changes, and scoped to the target story,
so that create-story and dev-story agents receive accurate epic context instead of stale or truncated content.

Addresses findings 1 (stale shard seeding), 2 (4000-char truncation), 3 (h2-only heading regex) from `docs/findings-cross-project-epic4-2026-03-05.md`.

## Acceptance Criteria

### AC1: Content-Hash Re-Seed
**Given** an epics file that has been modified since the last time shards were seeded
**When** `seedEpicShards()` runs
**Then** existing epic-shard decisions are deleted and re-seeded from the updated file, using a SHA-256 hash of the file content stored as a decision entry (category: `epic-shard-hash`) for comparison

### AC2: Unchanged File Skips Re-Seed
**Given** an epics file whose content hash matches the stored `epic-shard-hash` decision
**When** `seedEpicShards()` runs
**Then** seeding is skipped entirely (existing behavior for unchanged files preserved)

### AC3: Per-Story Extraction
**Given** a `storyKey` is available when assembling the create-story or dev-story prompt
**When** the epic shard is retrieved from the decision store
**Then** only the section matching the target story key (e.g., `Story 23-1:` or `23-1`) is extracted from the shard content, falling back to the full shard only if no matching section is found

### AC4: Relaxed Heading Regex
**Given** an epics file using any heading depth from `##` to `####` for epic headings (e.g., `## Epic 4`, `### Epic 4`, `#### Epic 4`)
**When** `parseEpicShards()` runs
**Then** all heading depths are matched correctly and the correct number of shards is produced

### AC5: File-Based Fallback Uses Same Regex
**Given** the file-based fallback path in `readEpicShardFromFile()`
**When** it parses the epics file
**Then** it uses the same relaxed heading regex (`#{2,4}`) as `parseEpicShards()`

### AC6: Backward Compatibility
**Given** an existing project with valid epic-shard decisions and no `epic-shard-hash` decision
**When** `seedEpicShards()` runs for the first time after this change
**Then** the hash is computed and stored, and shards are re-seeded (safe first-time migration)

### AC7: Truncation Limit Raised
**Given** the per-story extraction (AC3) reduces the content size for most cases
**When** a story section is not found and the full shard is used as fallback
**Then** `MAX_EPIC_SHARD_CHARS` is raised to 12000 to accommodate larger epics without mid-sentence truncation

## Tasks / Subtasks

- [ ] Task 1: Add content-hash comparison to `seedEpicShards()` (AC: #1, #2, #6)
  - [ ] Compute SHA-256 hash of the epics file content
  - [ ] Store hash as decision entry: `category='epic-shard-hash', key='epics-file', value=<hash>`
  - [ ] On subsequent runs: compare stored hash to current file hash; skip if equal
  - [ ] If hash differs or no hash exists: delete existing `epic-shard` decisions and re-seed, then update hash
  - [ ] Write unit tests for hash comparison logic (match → skip, mismatch → re-seed, missing → seed + store)

- [ ] Task 2: Relax heading regex in `parseEpicShards()` and `readEpicShardFromFile()` (AC: #4, #5)
  - [ ] Change `epicPattern` from `/^## (?:Epic\s+)?(\d+)[.:\s]/gm` to `/^#{2,4}\s+(?:Epic\s+)?(\d+)[.:\s]/gm`
  - [ ] Apply same change to `readEpicShardFromFile()` regex at line ~327-330
  - [ ] Write unit tests with h2, h3, h4 heading inputs

- [ ] Task 3: Implement per-story extraction utility (AC: #3)
  - [ ] Add `extractStorySection(shardContent: string, storyKey: string): string | null`
  - [ ] Match patterns like `Story 23-1:`, `### Story 23-1`, `23-1:`, `**23-1**`
  - [ ] Return the matched section (from heading to next story heading or end of content)
  - [ ] Return `null` if no match found (caller falls back to full shard)
  - [ ] Write unit tests for match/no-match/edge cases

- [ ] Task 4: Integrate per-story extraction into prompt assembly (AC: #3)
  - [ ] In `runCreateStory`: after retrieving epic shard, call `extractStorySection(shard, storyKey)`
  - [ ] In `runDevStory`: same integration if epic shard is used
  - [ ] Use extracted section if non-null, else fall back to full shard (with raised limit)

- [ ] Task 5: Raise `MAX_EPIC_SHARD_CHARS` fallback limit (AC: #7)
  - [ ] Change `MAX_EPIC_SHARD_CHARS` from `4_000` to `12_000`
  - [ ] This is the fallback for when per-story extraction returns null

- [ ] Task 6: Integration test (AC: #1–#7)
  - [ ] Test full flow: seed with h3 headings → verify shard count → modify file → re-seed → verify updated content
  - [ ] Test per-story extraction returns correct section for a known story key

## Dev Notes

### Architecture Constraints
- **File**: `src/modules/implementation-orchestrator/seed-methodology-context.ts`
- **Modular Monolith (ADR-001)**: Keep all shard logic in this file; the per-story extraction utility can be a co-located function.
- **SQLite WAL (ADR-003)**: Use `DatabaseWrapper` for all DB access.
- **Import style**: `.js` extension on all local imports (ESM).
- **Test framework**: vitest (not jest).

### Key Functions
- `seedEpicShards()` — line ~165-170, the "skip if exists" check needs hash comparison
- `parseEpicShards()` — line ~299-302, the regex that needs relaxing
- `readEpicShardFromFile()` — line ~327-330, the file-based fallback regex
- `MAX_EPIC_SHARD_CHARS` — line ~28, raise from 4000 to 12000

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
