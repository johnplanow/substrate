# Story 37-0: Per-Story Epic Shard Extraction

## Story

As a pipeline operator running substrate against projects with large epics,
I want epic shards stored individually per story rather than per epic,
so that all stories in an epic are accessible without truncation risk, regardless of how large the epic document grows.

## Acceptance Criteria

### AC1: Per-Story Decision Keys
**Given** an epics file with story subsections (e.g., `### Story 37-1: Title`)
**When** `seedEpicShards()` runs
**Then** one `epic-shard` decision is stored per story, keyed by storyKey (e.g., `"37-1"`), containing only that story's section content

### AC2: Story Section Boundary Extraction
**Given** a shard seeded for story `"37-1"`
**When** the content is inspected
**Then** it spans from the story heading (inclusive) to the next story heading or the next epic heading (exclusive) — not the full epic section

### AC3: Per-Epic Fallback for Unstructured Epics
**Given** an epic section with no recognisable story subsections
**When** `seedEpicShards()` runs
**Then** the full epic content is stored as a single shard keyed by epicId (e.g., `"37"`) — preserving backward-compatible behavior for epics that lack per-story breakdowns

### AC4: Direct storyKey Lookup in create-story
**Given** per-story shards are present in the decision store
**When** `getEpicShard()` is called with a `storyKey` (e.g., `"37-1"`)
**Then** the shard is fetched by storyKey directly with no `extractStorySection()` post-processing required

### AC5: Hash-Based Re-seed Covers Per-Story Decisions
**Given** an epics file has changed since last seeding
**When** `seedEpicShards()` runs
**Then** all existing `epic-shard` decisions (both per-story and per-epic keyed rows) are deleted before re-seeding and the updated hash is stored

### AC6: Backward-Compatible Retrieval Fallback
**Given** a project has only old per-epic shard decisions (pre-37-0 schema, key = epicId)
**When** `getEpicShard(storyKey)` is called and no per-story shard is found
**Then** the system falls back to per-epic lookup plus `extractStorySection()` so the project continues working until its shards are re-seeded

### AC7: Large-Epic Truncation Eliminated
**Given** an epic whose total content exceeds 12,000 characters
**When** per-story shards are seeded
**Then** each individual story section is stored complete and without truncation (individual story sections are typically well under the 12K limit)

## Tasks / Subtasks

- [x] Task 1: Add `parseStorySubsections()` helper in `seed-methodology-context.ts` (AC: #1, #2, #3)
  - [x] Accept `epicId: string` and `epicContent: string`; return `Array<{ key: string; content: string }>`
  - [x] Find story headings using patterns: `#{2,6}\s+Story\s+(\d+-\d+)`, `\*\*Story\s+(\d+-\d+)\*\*`, `^(\d+-\d+):`
  - [x] Split `epicContent` at story boundaries; each entry spans heading-to-next-heading or end-of-string
  - [x] If no story headings found, return `[{ key: epicId, content: epicContent }]` (AC3 per-epic fallback)

- [x] Task 2: Update `seedEpicShards()` to store per-story shards (AC: #1, #5)
  - [x] After `parseEpicShards()`, call `parseStorySubsections()` for each epic entry
  - [x] Insert one `epic-shard` decision per `{ key, content }` result (storyKey-keyed or epicId-keyed fallback)
  - [x] Verify the existing delete-by-category path (`category = 'epic-shard'`) already covers all rows — add assertion/comment confirming it handles both old and new key formats
  - [x] Update the "skip if exists" check so it still works correctly after the key format change

- [x] Task 3: Update `getEpicShard()` in `create-story.ts` for direct storyKey lookup (AC: #4, #6)
  - [x] First attempt: query decision store with `category='epic-shard', key=storyKey`
  - [x] If found, return content directly — no `extractStorySection()` call needed
  - [x] If not found, fall back to per-epic lookup (key = epicId extracted from storyKey) plus `extractStorySection()` (AC6 backward compat)
  - [x] Add a comment marking the fallback path as a migration shim for pre-37-0 projects

- [x] Task 4: Audit and update `dev-story.ts` for same lookup pattern (AC: #4, #6)
  - [x] Inspect `src/modules/compiled-workflows/dev-story.ts` for any `getEpicShard()` call
  - [x] If present, apply the same direct-lookup plus fallback pattern from Task 3
  - [x] If absent, document that no changes are needed — NO `getEpicShard()` call found in dev-story.ts; it reads the story file directly from disk, not from the decision store. No changes needed.

- [x] Task 5: Unit tests for `parseStorySubsections()` (AC: #1, #2, #3, #7)
  - [x] Test: epic with h3 story headings → returns per-story shards with correct storyKey and boundary content
  - [x] Test: epic with h4 story headings → same assertion
  - [x] Test: epic with no story headings → returns single per-epic fallback entry keyed by epicId
  - [x] Test: epic whose total content >12K chars with story subsections → each per-story shard is < 12K

- [x] Task 6: Integration tests for seed-and-retrieve round trip (AC: #4, #5, #6)
  - [x] Test: seed epics with story subsections → `getEpicShard(storyKey)` returns correct per-story content without extraction
  - [x] Test: modify epics file → re-seed → all prior per-story shards deleted and replaced
  - [x] Test: backward compat — seed only per-epic shard (key=epicId) → `getEpicShard(storyKey)` falls back and returns extracted story content

- [x] Task 7: Remove or deprecate `extractStorySection()` if no longer called from the primary path (AC: #4)
  - [x] After Tasks 3–4, audit all call sites of `extractStorySection()` in `create-story.ts` and `dev-story.ts`
  - [x] If only used in the backward-compat fallback, add a `// @deprecated` comment; do not delete yet (needed for AC6)
  - [x] If called nowhere else, remove the function and its unit tests to reduce dead code — `extractStorySection()` is only used in the AC6 backward-compat fallback path; `@deprecated` JSDoc added

## Dev Notes

### Architecture Constraints
- **Modular Monolith (ADR-001)**: Keep all shard seeding logic in `seed-methodology-context.ts`. The `parseStorySubsections()` helper is a co-located function — do not create a separate file.
- **SQLite WAL (ADR-003)**: Use `DatabaseWrapper` for all DB access. No raw `better-sqlite3` calls.
- **Import style**: `.js` extension on all local imports (ESM).
- **Test framework**: vitest (not jest). No `describe.only` or `test.only` left in committed code.

### Key Files
- `src/modules/implementation-orchestrator/seed-methodology-context.ts` — seed logic: `seedEpicShards()`, `parseEpicShards()`, `MAX_EPIC_SHARD_CHARS` (line ~29)
- `src/modules/compiled-workflows/create-story.ts` — retrieval: `getEpicShard()` (line ~295), `extractStorySection()` (line ~252), `readEpicShardFromFile()` (line ~388)
- `src/modules/compiled-workflows/dev-story.ts` — check for any `getEpicShard()` usage
- `src/modules/implementation-orchestrator/__tests__/seed-methodology-context.test.ts` — primary unit test file

### Decision Store Schema Change

**Pre-37-0 (current):**
```
category='epic-shard',  key='3'    → full epic section (≤12K chars)
category='epic-shard',  key='37'   → full epic section (≤12K chars)
category='epic-shard-hash', key='epics-file' → SHA-256
```

**Post-37-0 (new):**
```
category='epic-shard',  key='37-0' → story 37-0 section only
category='epic-shard',  key='37-1' → story 37-1 section only
category='epic-shard',  key='37-2' → story 37-2 section only
category='epic-shard',  key='3'    → full epic 3 (fallback — no story subsections)
category='epic-shard-hash', key='epics-file' → SHA-256 (unchanged)
```

Both row types share `category='epic-shard'`, so the existing delete-by-category re-seed path requires no SQL change.

### Story Heading Patterns to Match at Seed Time
```
/#{2,6}\s+Story\s+(\d+-\d+)/i        — e.g., ### Story 37-1: Title
/\*\*Story\s+(\d+-\d+)\*\*/i          — e.g., **Story 37-1**
/^(\d+-\d+):\s/m                       — e.g., 37-1: Title (bare key)
```
Capture group 1 in each pattern is the storyKey (e.g., `"37-1"`).

### Retrieval Logic in `getEpicShard()`
```
1. Look up: category='epic-shard', key=storyKey          → hit → return content
2. (fallback) Look up: category='epic-shard', key=epicId  → hit → extractStorySection() → return
3. (disk fallback) readEpicShardFromFile() + extractStorySection()
```
The fallback chain (steps 2–3) is unchanged from post-23-1 behaviour and provides AC6 backward compatibility.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest)
- Run `npm run test:fast` during iteration; confirm results by checking for "Test Files" in output
- Do not run tests concurrently — verify `pgrep -f vitest` returns nothing before starting

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-6

### Completion Notes List
- Task 4: `dev-story.ts` has no `getEpicShard()` call — it reads story files directly from disk; no changes needed
- Task 7: `extractStorySection()` is only used in AC6 backward-compat fallback path; `@deprecated` JSDoc added
- All 7 tasks complete; 5797 tests pass (npm run test:fast)
- Also updated `src/modules/export/__tests__/integration.test.ts` T12b/T12c/T12e to reflect new per-story shard schema

### File List
- `src/modules/implementation-orchestrator/seed-methodology-context.ts`
- `src/modules/compiled-workflows/create-story.ts`
- `src/modules/implementation-orchestrator/__tests__/seed-methodology-context.test.ts`
- `src/modules/compiled-workflows/__tests__/create-story.test.ts`
- `src/modules/export/__tests__/integration.test.ts`

## Change Log
