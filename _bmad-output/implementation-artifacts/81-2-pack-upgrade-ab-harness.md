# Story 81-2: Pack-upgrade A/B harness

## Story

As a substrate eval-framework operator,
I want a harness (`scripts/eval-pack-upgrade/harness.mjs`) that takes a corpus pair (parent SHA + story-file input), spawns two isolated worktrees at the parent SHA, dispatches the same story under both `--pack-current` and `--pack-candidate`, and captures the full dispatch envelope from each,
so that Epic 81's grader (81-3) and CLI (81-4) have side-by-side dispatch results to compare on four signal axes.

This story builds the A/B dispatch primitive that pairs two runs at the same git state with only the methodology pack varying. It is intentionally narrow: it does NOT grade the envelopes (that's 81-3), and does NOT format the report (that's 81-4). It outputs raw envelope pairs.

## Acceptance Criteria

1. **CLI entry**: `node scripts/eval-pack-upgrade/harness.mjs --pack-current PATH --pack-candidate PATH --corpus PATH [--budget-per-case-usd N] [--output PATH]`
   - `--pack-current` and `--pack-candidate`: absolute paths to two pack directories (each containing `manifest.yaml` + `prompts/` + `constraints/` + `templates/`). Both must be loadable by `createPackLoader` — invalid pack → fatal exit (usage error).
   - `--corpus`: defaults to `_bmad-output/eval-results/corpus/outcomes-corpus.yaml` (the Epic 77 35-pair regression corpus).
   - `--budget-per-case-usd`: default `2.00` (two USD per dispatch; total per pair = 2× this since each pair runs twice).
   - `--output`: defaults to `_bmad-output/eval-results/pack-upgrade-harness-<ISO-date>.json`.

2. **Reuses reconstruction harness primitives — does NOT fork.** The pack-upgrade harness imports and reuses, by name and shape, the following from `scripts/eval-reconstruction/harness.mjs`:
   - the `git worktree --detach` checkout-at-parent-SHA primitive (whatever it's called: `checkoutParent` per AC1 of 77-8)
   - the bare-phase dispatch wrapper (`dispatcher.dispatch()` without orchestrator lifecycle)
   - the per-case budget cap helper (`enforceBudget` / `estimateCostUsd`)
   - the always-cleanup-via-finally pattern
   If a primitive needs slight generalization to be reusable (e.g., accept a pack-override parameter), refactor it in the reconstruction harness file FIRST in a backward-compatible way (additive parameter with default = current behavior), THEN import it here. Do NOT copy-paste.

3. **Per-pair execution model.** For each corpus pair (a corpus entry maps a `parent_sha` + `story_file_input_path` + `run_id`):
   - Spawn TWO isolated worktrees at the same parent SHA (one for each pack)
   - Dispatch the same story file via `dispatcher.dispatch()` under pack-current in worktree A
   - Dispatch the same story file via `dispatcher.dispatch()` under pack-candidate in worktree B
   - Capture the dispatch envelope from each (see AC4)
   - Tear down both worktrees in `finally` regardless of dispatch outcome
   - Pack selection is achieved by passing the pack path as an option to `createPackLoader` at dispatch time — do NOT mutate `packs/bmad/` in-place

4. **Envelope shape (per dispatch, both packs):**
   ```
   {
     pack: 'current' | 'candidate',
     pack_path: <absolute path>,
     dispatch_outcome: 'completed' | 'escalated' | 'failed' | 'budget-exceeded' | 'error',
     diff: <unified-diff string or array of file changes>,
     total_turns: number | null,
     total_tokens: { input: number, output: number } | null,
     verdict: <PerStoryState.verdict value> | null,
     recovery_history: <RecoveryEntry[]> | [],
     escalation_reason: string | null,
     duration_seconds: number,
     cost_usd: number,
     error_detail: string | null
   }
   ```
   The shape is contracted with Story 81-3 (grader); any change here requires a coordinated update there.

5. **Per-case budget cap.** Each dispatch (A or B) has a budget ceiling (default $2.00). When the running cost estimate exceeds the cap MID-DISPATCH, the dispatch is aborted (`dispatch_outcome: 'budget-exceeded'`) and the partial envelope is recorded — never silently overspends. The per-PAIR budget is therefore 2× the per-case cap.

6. **Failure-tolerant per case.** A dispatch error (corpus triple invalid, worktree checkout fails, dispatcher throws, pack invalid) on one PAIR is recorded as `dispatch_outcome: 'error'` with the error detail and the run continues to the next pair. ONLY a fatal usage error (invalid CLI args, unloadable pack, missing corpus file) aborts the run.

7. **Output: per-pair envelope pairs.** Output file is a JSON array; each element is:
   ```
   {
     case_id: <from corpus>,
     parent_sha: <from corpus>,
     story_key: <from corpus>,
     story_file_input_path: <from corpus>,
     current: <envelope from AC4>,
     candidate: <envelope from AC4>,
     pair_outcome: 'both-completed' | 'one-completed' | 'neither-completed' | 'pair-skipped'
   }
   ```
   `pair_outcome` is a convenience field summarizing the per-side `dispatch_outcome` values for downstream consumption.

8. **Injectable I/O (testability).** The harness's top-level orchestration function (`runPackUpgradeHarness({ corpus, packCurrent, packCandidate, deps })`) takes `deps = { checkoutParent, dispatch, readStoryFile, captureEnvelope, cleanup, costFn }` — every external interaction is a dep. Default deps wire to the real reconstruction-harness primitives; tests pass synthetic deps. This matches the 77-8 testability pattern.

9. **Pure helpers extracted + unit-tested.** Pure logic (corpus parsing, pair-outcome classification, envelope normalization, budget enforcement) lives in `scripts/eval-pack-upgrade/lib.mjs` as exported functions. Unit tests in `scripts/eval-pack-upgrade/__tests__/harness.test.ts` (or `lib.test.ts`) cover:
   - empty corpus → exit 0 with empty output
   - synthetic two-pair corpus → two pair envelopes in output
   - dispatch-throws on side A only → `pair_outcome: 'one-completed'`, error_detail captured
   - dispatch budget exceeded → `dispatch_outcome: 'budget-exceeded'` captured
   - cleanup runs even on dispatch throw (deps.cleanup invocation count)
   - pack-current === pack-candidate → both envelopes present, identical (smoke; harness doesn't refuse this)
   - invalid pack path → fatal usage error

10. **No live model calls in tests.** Tests use synthetic `dispatch` deps that return canned envelopes. Live-call testing is the operator's job at integration time (via `81-4`'s CLI). This story's tests must run in `npm run test:fast` (< 1s).

11. **Pollution guard inherited from corpus model (mirrors 77-1 AC8).** The harness operates ONLY on entries in the explicitly-passed corpus. It never enumerates `.substrate/runs/` or `_bmad-output/eval-results/corpus/` for additional cases.

12. **No behavior change to substrate's dispatch path.** Importing the reconstruction harness primitives must NOT introduce new substrate orchestrator changes. If a primitive needs generalization, the generalization is additive (e.g., a new optional parameter with current-behavior default). The full eval-outcomes gate (`node scripts/eval-outcomes.mjs --threshold 0.95`) and the existing reconstruction harness tests must remain GREEN.

## Tasks / Subtasks

- [ ] **Task 1 — Survey reconstruction harness for reusable primitives** (AC2)
  - [ ] Read `scripts/eval-reconstruction/harness.mjs` end-to-end, identifying the exported pure helpers + injectable I/O functions
  - [ ] Determine which primitives can be imported as-is vs need additive generalization (e.g., accepting a pack-override parameter)
  - [ ] For each primitive needing generalization: implement the additive change in `scripts/eval-reconstruction/harness.mjs` (or its `lib.mjs` equivalent), preserving the current behavior as the default, and add/update unit tests there
  - [ ] Verify the existing reconstruction harness tests still pass (`npm run test:fast -- scripts/eval-reconstruction`)

- [ ] **Task 2 — Create `scripts/eval-pack-upgrade/lib.mjs`** (AC9)
  - [ ] Export `parseOutcomesCorpusForPackUpgrade(yamlContent)` — extracts pair triples (case_id, parent_sha, story_key, story_file_input_path) from the Epic 77 outcomes-corpus format
  - [ ] Export `classifyPairOutcome(envelopeA, envelopeB)` — pure: returns `'both-completed' | 'one-completed' | 'neither-completed' | 'pair-skipped'`
  - [ ] Export `normalizeDispatchEnvelope(rawDispatchResult, packIdentifier)` — pure: shapes a raw dispatcher result into the AC4 envelope
  - [ ] Export `buildPackOverride(packPath)` — pure: constructs the pack-loader config object the dispatch wrapper accepts (so the dispatch call site stays declarative)
  - [ ] Co-located unit tests for each pure helper

- [ ] **Task 3 — Create `scripts/eval-pack-upgrade/harness.mjs`** (AC1, AC3, AC4, AC5, AC6, AC7, AC8)
  - [ ] CLI flag parsing matching AC1's surface
  - [ ] Top-level orchestrator `runPackUpgradeHarness({ corpus, packCurrent, packCandidate, deps })` that:
    - parses the corpus via lib.mjs helpers
    - for each pair, invokes `dispatchOnePackForCase(case, pack, deps)` twice in sequence (NOT in parallel — keep it simple; A/B does not require parallelism)
    - assembles pair envelopes via lib.mjs `classifyPairOutcome`
    - writes the JSON output array to the configured path
  - [ ] Default `deps` wires to the real reconstruction-harness primitives (Task 1 imports) and the real `dispatcher.dispatch()`
  - [ ] Always-cleanup-via-finally for each worktree, regardless of dispatch outcome
  - [ ] Exit codes: 0 on completion (even with per-pair errors), 1 on fatal usage error (bad CLI args, missing corpus, unloadable pack), 2 on internal harness exception (defensive)

- [ ] **Task 4 — Unit tests** (AC9, AC10)
  - [ ] Create `scripts/eval-pack-upgrade/__tests__/harness.test.ts`
  - [ ] Cover every AC9 scenario with synthetic deps + canned envelopes
  - [ ] No live `dispatcher.dispatch()`, no real `git worktree`, no real filesystem worktree creation
  - [ ] All tests run in `npm run test:fast`

- [ ] **Task 5 — Smoke-test against an empty corpus** (AC11)
  - [ ] Invoke the real CLI against a one-pair fixture corpus pointing at the SAME pack for both `--pack-current` and `--pack-candidate` (so the dispatch is real but the result is the deterministic "same pack, same dispatch" case)
  - [ ] OR invoke against a zero-pair fixture corpus and confirm clean exit 0 with empty output array
  - [ ] Document the smoke command in the Dev Agent Record completion notes

- [ ] **Task 6 — Regression validation** (AC12)
  - [ ] `npm run build`
  - [ ] `npm run test:fast` (gates: new tests + existing reconstruction tests pass)
  - [ ] `node scripts/eval-outcomes.mjs --threshold 0.95` (gates: 77-1 regression GREEN)
  - [ ] Confirm `scripts/eval-reconstruction/harness.mjs` unit tests still pass (the additive generalization is backward-compatible)

## Dev Notes

### Reusing the reconstruction harness — critical mechanics

The reconstruction harness's I/O model is:
```javascript
runHarness({
  corpus,
  deps: { checkoutParent, readStoryFile, dispatch, captureArtifacts, cleanup, costFn }
})
```

For the pack-upgrade harness, the `dispatch` dep needs to accept a **pack override**. The pack content is loaded by `createPackLoader` (`src/modules/methodology-pack/pack-loader.ts`) — its `load(packPath)` method is already path-parameterized, so technically no upstream change is needed; what's needed is for the dispatch wrapper to pass the override path through.

If the reconstruction harness's `dispatch` dep currently loads the pack from a hard-coded default, generalize it (additively) to accept an optional `packPath` argument. Document the additive change in the reconstruction harness file with a comment citing Story 81-2.

### Pack-override implementation contract

The pack used by `dispatcher.dispatch()` is determined at dispatch construction time. The pack-upgrade harness should NEVER mutate the on-disk `packs/bmad/` directory — that's a shared resource and concurrent A/B runs would race. Instead:
- Pass the pack path through the dispatch options
- `createPackLoader().load(packPath)` is called inside the dispatch wrapper with the resolved path
- The resolved pack is held in memory for the duration of the dispatch, then discarded

If the dispatcher's current API doesn't expose a way to override the pack at dispatch time, this is a known gap that 81-2 must close — either by adding an option to the dispatcher's dispatch method, or by injecting the pack via a context object. Surface the design decision in the Dev Agent Record completion notes and pick the additive option that imposes the smallest change on the existing dispatcher contract.

### Corpus reuse decision

Story 81-2 reuses the Epic 77 outcomes-corpus (`_bmad-output/eval-results/corpus/outcomes-corpus.yaml`) rather than building a parallel corpus. Rationale:
- Same 35-pair regression corpus → consistent signal source across regression-tier and pack-upgrade evaluations
- Avoids corpus drift between Epic 77 and Epic 81
- The outcomes-corpus already carries `parent_sha` (via `commit_sha` per F-commitsha) and `story_file_input_path` (per obs_027 capture)

If the outcomes-corpus turns out to lack one of those fields on enough entries to be operationally useful, that's a corpus-pollution issue, not a story scope issue — surface it via the corpus-error mechanism (mirroring 77-1 AC8) and pass through. DO NOT add corpus growth or curation work to this story.

### Canonical Import Paths

| Helper | Import path |
|---|---|
| Reconstruction harness primitives | `scripts/eval-reconstruction/harness.mjs` (or its `lib.mjs` if it has one) |
| `createPackLoader` | `src/modules/methodology-pack/pack-loader.ts` |
| `dispatcher.dispatch()` | Wherever the reconstruction harness imports it from (preserve the exact same import) |
| `parseOutcomesCorpus` (Epic 77 corpus reader) | `scripts/eval-outcomes/lib.mjs` |
| YAML parser | `js-yaml` (already a dep) |

### Reference Files (do NOT modify unless additively generalizing per Task 1)

| File | Purpose |
|---|---|
| `scripts/eval-reconstruction/harness.mjs` | Primary source of reusable primitives (Task 1) |
| `scripts/eval-reconstruction/grader.mjs` | Reference for the deterministic-signal scoring pattern (used by 81-3) |
| `scripts/eval-outcomes.mjs` + `scripts/eval-outcomes/lib.mjs` | CLI style + corpus reader pattern |
| `_bmad-output/eval-results/corpus/outcomes-corpus.yaml` | Corpus file (read-only for this story) |
| `src/modules/methodology-pack/pack-loader.ts` | Pack loader (path-parameterized; reused as-is) |

### Testing Requirements

- Framework: **vitest**
- No live `dispatcher.dispatch()`, no real `git worktree`, no real filesystem mutations in unit tests
- Synthetic deps return canned envelopes for each AC9 scenario
- All tests run in `npm run test:fast` (< 1s contribution)
- Existing reconstruction harness tests must continue passing (`npm run test:fast -- scripts/eval-reconstruction`)
- Full eval-outcomes gate must remain GREEN

### Key Files

| File | Purpose |
|---|---|
| `scripts/eval-pack-upgrade/harness.mjs` | CLI entry + orchestrator (Task 3) |
| `scripts/eval-pack-upgrade/lib.mjs` | Pure helpers (Task 2) |
| `scripts/eval-pack-upgrade/__tests__/harness.test.ts` | Unit tests (Task 4) |
| `scripts/eval-pack-upgrade/__tests__/lib.test.ts` | Lib unit tests (Task 2) |
| `_bmad-output/eval-results/pack-upgrade-harness-*.json` | Output sink |
| `scripts/eval-reconstruction/harness.mjs` | Imported primitives (additively generalized if needed) |

## Interface Contracts

- **Envelope shape** (AC4) is contracted with Story 81-3 (grader). Coordinate any change.
- **Pair-outcome JSON shape** (AC7) is contracted with Story 81-4 (CLI). Coordinate any change.
- **Corpus reader** reuses Epic 77's `parseOutcomesCorpus` from `scripts/eval-outcomes/lib.mjs`. Format additions must be additive (don't break Epic 77 consumers).
- **Reconstruction harness primitives** are reused by import; any additive generalization is the responsibility of this story.

## Runtime Probes

Not applicable — this story's primary surface is a CLI script with extensive unit tests. Integration smoke (Task 5) exercises the real CLI against a fixture corpus.

## Dev Agent Record

### Agent Model Used
<to be filled in by dispatched agent>

### Completion Notes List
<to be filled in by dispatched agent>

### File List
<to be filled in by dispatched agent>

## Change Log
