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
- 61-2: trivial-output check is checkpoint-recovery aware (P0, Small)
- 61-3: findEpicFileForStory for verification context (P0, Small)
- 61-4: acceptance-criteria-evidence recognizes bullet-format ACs (P0, Small)

**Dependency chain**: 61-1 unblocked the dogfooding dispatch (shipped
v0.20.29); 61-2/61-3/61-4 are the three verification-side gaps
surfaced by the 60-12 redispatch under v0.20.29 (run 4700c6e8,
2026-04-27). All four are independent fixes but share the meta-pattern:
substrate's verification stack encodes assumptions about
consolidated-file conventions, file-existence checks, and AC-numbering
shapes that don't hold for substrate's own per-epic planning files.

## Phase 2 — verification-side gaps (60-12 redispatch findings)

The 60-12 dogfooding redispatch (post-61-1) **succeeded at the
implementation level** — dev produced 7 files of correct code, 17
tests passing, build clean, all 9 ACs claimed met. But substrate's
verification verdict was VERIFICATION_FAILED. Three distinct gaps in
the verification stack each contributed:

| Gap | Surfaced by | Severity | Story |
|---|---|---|---|
| `trivial-output` looks at last dispatch's tokens, not aggregate | Dev hit checkpoint recovery; final dispatch returned 0 tokens (recovery bookkeeping) → fail | High — blocks any checkpoint-recovered story | 61-2 |
| `findEpicsFile` (verification path) doesn't see per-epic files | sourceEpicContent: undefined → SourceAcFidelityCheck silently skipped with warn | Medium — fidelity check effectively disabled for self-dispatch | 61-3 |
| `acceptance-criteria-evidence` doesn't recognize bullet-format ACs | Story file's `**Acceptance Criteria**:` + bullet list → "no numbered acceptance criteria found" warn | Low — calibration; not a blocker but visible | 61-4 |

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

## Story 61-2: trivial-output check is checkpoint-recovery aware

**Priority**: must

**Description**: When `devStoryResult` signals success
(`result === 'success'`) AND non-empty `files_modified`, downgrade
the trivial-output finding from `error` to `warn` instead of failing
the whole verification. This handles the checkpoint-recovery case
(Story 39-5/39-6) where earlier dispatches produced the work and the
final recovery dispatch is bookkeeping with low/zero token output.
The warn finding still surfaces the low-token signal so operators
can see it; it just doesn't gate.

Surfaced live by 60-12 redispatch run 4700c6e8 (2026-04-27): dev
produced 7 files of correct code across 4 dispatches, the 4th
(recovery) returned 0 tokens, and the verdict was
VERIFICATION_FAILED despite the implementation being demonstrably
correct (17 tests pass, build clean, all 9 ACs met).

**Acceptance Criteria**:
- `TrivialOutputCheck` reads `context.devStoryResult` (already
  available via VerificationContext)
- When count < threshold AND `devStoryResult.result === 'success'`
  AND `Array.isArray(files_modified) && files_modified.length > 0`,
  emit a warn-severity `trivial-output` finding (not error) and
  return status `'warn'`
- The warn message includes the file count and explicitly names
  "checkpoint-recovered" so operators can recognize the case
- All other paths preserved exactly: undefined token count → warn
  (existing AC5); count < threshold + no devStoryResult → fail
  (existing AC1); count < threshold + result='failed' → fail; count
  < threshold + success but empty/missing files_modified → fail
  (don't paper over agents claiming success without producing
  files); count ≥ threshold → pass regardless
- 6 new unit tests covering: success+files → warn, undefined
  devStoryResult → fail, failed result → fail, success + empty
  files_modified → fail, success + missing files_modified → fail,
  above threshold + success → pass

**Key File Paths**:
- `packages/sdlc/src/verification/checks/trivial-output-check.ts` (modify)
- `packages/sdlc/src/__tests__/verification/trivial-output-check.test.ts` (extend)

## Story 61-3: findEpicFileForStory for verification context

**Priority**: must

**Description**: Add a sibling to `findEpicsFile` that takes a
`storyKey` and falls back to per-epic files when no consolidated
`epics.md` exists. Mirrors 61-1's approach for the orchestrator's
verification-context-assembly path (which the file fallback in
`readEpicShardFromFile` doesn't reach because it's a separate code
path). Update both `assembleVerificationContext` call sites in
`orchestrator-impl.ts` (initial verification + retry verification)
to use the new function.

**Acceptance Criteria**:
- New exported function `findEpicFileForStory(projectRoot: string,
  storyKey: string): string | undefined` in `story-discovery.ts`
- Lookup order: (1) consolidated `findEpicsFile(projectRoot)` first;
  (2) if undefined, derive epicNum from storyKey's first numeric
  segment; (3) glob
  `_bmad-output/planning-artifacts/epic-<epicNum>-*.md` with
  deterministic alphabetical sort; (4) return first match or
  undefined
- StoryKey shapes supported: hyphen (`60-12`), dot (`1.10c`),
  alpha-suffix (`1-11a`); all use first numeric segment for epicNum
- No false-match on lookalike prefixes: storyKey `7-1` MUST NOT
  match `epic-70-*.md` or `epic-75-*.md` (regex anchored on
  `epic-${epicNum}-`)
- `orchestrator-impl.ts` two `assembleVerificationContext` call
  sites updated to use the new function with storyKey passed through
- 7 new unit tests covering: consolidated wins; per-epic fallback;
  three storyKey shapes (hyphen/dot/numeric); planning-artifacts dir
  exists but no epic-N-*.md match; alphabetical sort determinism;
  lookalike-prefix discrimination
- The auto-discovery path callers (`findEpicsFile` at lines 396,
  1537 in orchestrator-impl.ts) remain unchanged — they're
  project-level scans not per-story lookups, and the existing
  `findEpicFiles` (plural) helper already handles per-epic files for
  those paths

**Key File Paths**:
- `src/modules/implementation-orchestrator/story-discovery.ts` (modify — new exported function)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (modify — 2 call sites + import)
- `src/modules/implementation-orchestrator/__tests__/story-discovery.test.ts` (extend)

## Story 61-4: acceptance-criteria-evidence recognizes bullet-format ACs

**Priority**: must

**Description**: Extend `AcceptanceCriteriaEvidenceCheck`'s
`extractAcceptanceCriteriaIds` to recognize bullet-format ACs in the
`**Acceptance Criteria**:` paragraph form (substrate's own per-epic
planning convention) in addition to the existing `## Acceptance
Criteria` heading + numbered/AC1-style form. Each bullet under the
section becomes an implicit AC numbered by position. Numbered or
explicit-ref ACs always win when present; bullet-position inference
fires only as a fallback when neither was found.

**Acceptance Criteria**:
- `extractAcceptanceSection` recognizes both forms:
  `## Acceptance Criteria` (heading) and `**Acceptance Criteria**:`
  (bold paragraph)
- Section boundaries respect the form they started in: heading-mode
  ends at next `##` or `### Story`; bold-mode additionally ends at
  next `**SomethingElse**:` bold-paragraph marker (the natural
  sibling boundary in per-epic-file format)
- `extractAcceptanceCriteriaIds` falls back to bullet-position
  inference: when no explicit AC refs and no numbered criteria found
  in the section, count `- ...` bullets in order as AC1, AC2,
  AC3, ...
- Mixed mode preserves explicit signal: when both numbered and
  bullets present, numbered/explicit-ref ACs are returned and
  bullet inference does NOT fire (so a third bullet that happens to
  follow AC1+AC2 doesn't become a phantom AC3)
- Bullets outside the AC section are NOT counted as ACs (e.g.
  bullets in `**Description**:` or `**Key File Paths**:` paragraphs
  are isolated by the boundary detection)
- Checkbox-style numbered items (`- [ ] 1. Foo`) covered by existing
  `NUMBERED_CRITERION` regex; bullet inference doesn't double-count
- 7 new unit tests covering: bold-paragraph form recognition; pure
  bullet inference (3+ bullets); explicit-ref preference; numbered
  preference; cross-story boundary detection (multi-story per-epic
  file); section-bullets-only (Description bullets ignored);
  checkbox no double-count

**Key File Paths**:
- `packages/sdlc/src/verification/checks/acceptance-criteria-evidence-check.ts` (modify)
- `packages/sdlc/src/__tests__/verification/acceptance-criteria-evidence-check.test.ts` (extend)

## Empirical validation

Once 61-1 ships, re-dispatch substrate Story 60-12 (which previously
escalated immediately) to verify the fix:

```
node /home/jplanow/code/jplanow/substrate/dist/cli/index.js run \
  --events --stories 60-12 --max-review-cycles 3
```

Expected outcome (Phase 1, post-61-1): create-story phase completes
successfully, story artifact written, dispatch progresses through
test-plan / dev-story / code-review / verification.

Expected outcome (Phase 2, post-61-2/61-3/61-4): all five Tier A
checks pass cleanly: trivial-output (warn-or-pass — no false fail
from checkpoint recovery), source-ac-fidelity (sourceEpicContent
populated from per-epic file), ac-evidence (bullet ACs recognized),
build, runtime-probes. Code-review verdict SHIP_IT or
LGTM_WITH_NOTES. The implementation files already exist in the
working tree from the v0.20.29 round; substrate should reach the
same conclusion this time.
