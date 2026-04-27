# Epic 61: Substrate Self-Dispatch Infrastructure

## Vision

Close the dispatchability gap that prevents substrate from dispatching
its own stories from per-epic planning files. Substrate's dispatch
pipeline (`getEpicShard` → file fallback) currently only scans for the
consolidated `_bmad-output/planning-artifacts/epics.md` convention used
by external projects (strata, ynab, NextGen Ticketing). Substrate's
own `_bmad-output/planning-artifacts/` uses the per-epic-file
convention (`epic-NN-<name>.md`) — incompatible with the dispatch
pipeline. The substrate-on-substrate dogfooding attempt for Epic 60
Story 60-12 immediately escalated with `create-story-no-file` because
the create-story agent received empty `epic_shard` and
`story_definition` inputs.

This epic closes the gap with a single targeted fix to the file
fallback path.

## Root cause

In `src/modules/compiled-workflows/create-story.ts:859`,
`readEpicShardFromFile(projectRoot, epicId)` only checks two paths:

```typescript
const candidates = [
  join(projectRoot, '_bmad-output', 'planning-artifacts', 'epics.md'),
  join(projectRoot, '_bmad-output', 'epics.md'),
]
```

Both are the consolidated single-file convention. Substrate's own
planning artifacts use per-epic files like
`_bmad-output/planning-artifacts/epic-60-probe-quality.md`. Neither
candidate matches → returns empty string → create-story agent gets
no source AC → fail-loud per its 60-1 input-validation directive.

`getEpicShard`'s prior calls (decisions-store lookup) also return
empty when no solutioning phase has run for the epic — which is the
case when the operator hand-authors an epic doc and runs
`substrate ingest-epic` directly. The file fallback is the only path
that could rescue the dispatch, and it doesn't see per-epic files.

## Story Map

- 61-1: per-epic-file fallback in `readEpicShardFromFile` (P0, Small)

(Single-story epic. The fix is narrow and well-understood; not enough
scope to warrant a multi-story decomposition.)

## Story 61-1: per-epic-file fallback in `readEpicShardFromFile`

**Priority**: must

**Description**: Extend `readEpicShardFromFile` in
`src/modules/compiled-workflows/create-story.ts` to scan for per-epic
files (`epic-<epicNum>-*.md`) in
`_bmad-output/planning-artifacts/` when no consolidated `epics.md`
exists. Returns the entire per-epic-file content as the shard (the
existing `extractStorySection` consumer narrows to the per-story
section by matching `### Story <storyKey>:` headings — works the
same regardless of epic-heading level).

**Acceptance Criteria**:
- `readEpicShardFromFile(projectRoot, epicId)` adds a third fallback
  path AFTER the existing two consolidated-file checks: scan
  `_bmad-output/planning-artifacts/` for files matching the regex
  `^epic-<epicNum>-.*\.md$` (where `<epicNum>` is the numeric epic
  identifier with leading `epic-` prefix stripped). Sort matches
  alphabetically; return the content of the first match.
- The function returns the **entire file content** as the shard (not
  a substring). The existing downstream `extractStorySection` consumer
  in `getEpicShard` handles per-story narrowing.
- When BOTH a consolidated `epics.md` AND a per-epic file exist, the
  consolidated file wins (existing behavior preserved — backward-compat
  with strata, ynab, NextGen Ticketing dispatches).
- When neither a consolidated `epics.md` NOR a per-epic file exists,
  the function returns empty string (existing behavior preserved).
- When the per-epic-file scan finds zero matches but `_bmad-output/planning-artifacts/`
  contains other files (e.g. `prd-*.md`, `architecture.md`), return
  empty string. Only `epic-<epicNum>-*.md` matches count.
- 5 unit tests at
  `src/modules/compiled-workflows/__tests__/create-story.test.ts`
  (extending the existing test file, mirroring how Story 58-13 added
  file-fallback tests):
  1. Per-epic file found (epic-60-probe-quality.md exists, returns
     full content)
  2. Per-epic file with leading-zero epicNum (epic-07-foo.md found
     for epicId='7' AND epicId='07' — substrate is loose on padding)
  3. Multiple per-epic files for different epics (epic-60-x.md AND
     epic-61-y.md present, looking up epicId='60' returns epic-60's
     content only)
  4. Backward-compat: when both consolidated epics.md AND
     epic-60-*.md exist, consolidated wins
  5. Backward-compat: when no epic file of any kind exists, returns
     empty string (no regression vs pre-61-1)

**Key File Paths**:
- `src/modules/compiled-workflows/create-story.ts` (modify —
  `readEpicShardFromFile` extended with third fallback)
- `src/modules/compiled-workflows/__tests__/create-story.test.ts`
  (modify — 5 new tests)

**Out of scope**:
- `seedMethodologyContext` per-epic-file support: pre-loading
  decisions for per-epic files is desirable for autoseeding but not
  required for dispatch (file fallback is enough). Defer to a follow-up
  if dispatch latency becomes a concern.
- `parseEpicShards` level-1 heading support (for `# Epic NN:` top
  headings): not needed because the file fallback skips
  parseEpicShards entirely — `extractStorySection` is the only
  downstream consumer and it only cares about `### Story X:` headings.
- `ingest-epic` decisions-store population: nice-to-have but not
  required given the file fallback path now works.

## Out-of-scope follow-ups

- **`seedMethodologyContext` autoseed for per-epic files**: the seed
  function pre-populates decisions at orchestrator startup so
  create-story's first phase can lookup-and-return immediately
  rather than fall back to file IO. Without it, every dispatch pays
  one synchronous filesystem read. Negligible latency for substrate's
  current workload (single-digit dispatches per session); revisit if
  substrate self-development scales to many concurrent stories.
- **Escalation taxonomy refinement**: when create-story agent emits
  `result: failure / error: source-ac-content-missing`, substrate
  surfaces the escalation reason as `create-story-no-file` (a
  misnomer — the agent INTENTIONALLY produced no file because of the
  missing-AC condition). A clearer taxonomy
  (`create-story-input-validation-failure`) would help operator
  diagnosis. Not blocking; cosmetic.
- **`# Epic NN:` (level 1) heading support in `parseEpicShards`**:
  required only if `seedMethodologyContext` is extended to autoseed
  per-epic files. Defer with that work.

## Empirical validation

Once 61-1 ships, re-dispatch substrate Story 60-12 (which previously
escalated immediately) to verify the fix:

```
node /home/jplanow/code/jplanow/substrate/dist/cli/index.js run \
  --events --stories 60-12 --max-review-cycles 3
```

Expected outcome: create-story phase completes successfully, story
artifact written to `_bmad-output/implementation-artifacts/60-12-*.md`,
dispatch progresses to test-plan / dev-story / code-review /
verification per the standard pipeline.
