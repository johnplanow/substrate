# Epic 81 — First Calibration & Architectural Finding

**Date**: 2026-05-31
**Status**: HALTED — capability defect surfaced; substrate-side architectural
work required before Phase 4.2 (deliberate regression) can run meaningfully.

## Stories shipped this session

| Story | Status | Commit / Run |
|---|---|---|
| 81-1 PerStoryStateSchema additions + capture sites | ✅ merged to main | run `2b691ce1`, commit `0bb03fe` |
| 81-2 Pack-upgrade A/B harness | ✅ merged to main | run `1c493f9c`, commit on `substrate/story-81-2` branch |
| 81-3 Four-axis pure grader | ✅ merged to main | run `1c493f9c`, commit `dbf4a69` |
| 81-4 CLI + report formatter | ✅ merged to main | run `4bac24b9`, commit `42c1e05` |
| 81-5 GitHub Actions workflow | ⏸ not started | OPERATOR-BUILT, gated on the finding below |

All four substrate-dispatchable stories merged with verified-pass on every
code-level gate (build, AC evidence, tests). Ship gate stayed GREEN throughout
(eval-outcomes 35/35 at every merge; tests 10007/10008 after final merge).

## Phase 4.1 result: Vacuous GREEN

```
node scripts/eval-pack-upgrade.mjs \
  --pack-current packs/bmad --pack-candidate packs/bmad \
  --corpus _bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml \
  --format plain
```

Output:
```
pairs: 4 total, 0 completed both, 4 ungradable
Overall verdict: GREEN
```

JSON detail (per `axes.<axis>.per_pair`):

```json
{
  "pair_outcomes": {
    "both-completed": 0,
    "one-completed": 0,
    "both-incomplete": 4
  },
  "axes_verdict": {
    "code_quality":  {"verdict": "GREEN", "ungradable_count": 4},
    "cost":          {"verdict": "GREEN", "ungradable_count": 4},
    "verdict":       {"verdict": "GREEN", "ungradable_count": 4},
    "recovery":      {"verdict": "GREEN", "ungradable_count": 4}
  }
}
```

Every per-pair entry has `gradable: false`. The reasons are NOT "missing data"
— they're systemic:

- `code_quality.per_pair`: all 4 entries `{"gradable": false, "reason": "not-both-completed"}`
- `cost.per_pair`: `"missing-telemetry"` (because no dispatch ever ran)
- `verdict.per_pair`: `"missing-verdict"` (same)
- `recovery.per_pair`: `"empty-both"` (same)

## Architectural finding (the cause)

`scripts/eval-pack-upgrade/harness.mjs:469-482` defines `deps.dispatch` as a
**throwing stub** placeholder:

```javascript
dispatch: async () => {
  throw new Error(
    'Production dispatch wiring is not implemented yet (deferred — Story 81-2). ' +
      'Wire a real dispatcher with pack override into deps.dispatch. ' +
      'See the comment in main() for instructions.',
  )
}
```

The dev agent who built Story 81-2 explicitly deferred the production wiring,
documented at `scripts/eval-pack-upgrade/harness.mjs:453-468`:

> "PRODUCTION DISPATCH WIRING IS DEFERRED (Story 81-2): identical pattern to
> the reconstruction harness (Story 77-8). Building the actual dispatch dep
> requires wiring createDispatcher from @substrate-ai/core with a pack-path
> override (createPackLoader().load(packPath) injected into the dispatcher's
> methodology-pack slot). This is deferred until the corpus has entries with
> parent_sha + story_file_input_path populated."

When `dispatch` throws, the harness's per-pair error handling catches it and
records `dispatch_outcome: 'error'` for both sides. The pair becomes
`both-incomplete`. The grader sees 0 gradable pairs and reports GREEN by
absence of regressions to detect.

**Story 77-8's reconstruction harness has the same stub** (verified at
`scripts/eval-reconstruction/harness.mjs:435-444`). Both eval harnesses in
substrate are framework-only today — they can execute the corpus loop,
contract envelopes, and exercise pure scoring logic, but they cannot actually
invoke an LLM under either pack.

## Why this is a HALT condition

The goal's HALT criteria include "architectural ambiguity unresolvable from
story docs" and "capability defect in 4.2 (false negative)." This finding is
both:

1. **Architectural ambiguity** — implementing the production dispatcher
   wiring requires either using an existing substrate public API or designing
   a new one. The story doc says "wire createDispatcher with pack override
   into the methodology-pack slot" but that override mechanism may not exist
   as a public API on substrate's dispatcher today.
2. **Capability defect** — Phase 4.2 deliberate-regression would also return
   vacuous GREEN because the same stubbed dispatch fails on both sides. The
   framework cannot detect regressions because it cannot dispatch.

Autonomous implementation of the production dispatcher wiring would mean
designing new substrate public API without operator review. The 2026-05-31
pack-abstraction audit explicitly identified verdict→model routing and
dispatcher coupling as architecturally sensitive layers; the right call is
to surface this rather than auto-fix it.

## Corpus built (and committed)

`_bmad-output/eval-results/corpus/pack-upgrade-fixture-corpus.yaml` — 4-pair
fixture corpus built from substrate-self post-v0.20.118 dispatches:

| id | story_key | commit_sha | parent_sha | story_file_input_path |
|---|---|---|---|---|
| 80-1-deda587e | 80-1 | deda587 | e8c508d | inputs/af578363.../80-1.md |
| 81-1-0bb03fee | 81-1 | 0bb03fe | f7dd7f0 | _bmad-output/.../81-1-*.md |
| 81-3-dbf4a69e | 81-3 | dbf4a69 | cc6dfc3 | _bmad-output/.../81-3-*.md |
| 81-4-42c1e057 | 81-4 | 42c1e05 | 907048b | _bmad-output/.../81-4-*.md |

(81-2 was skipped in the build — its worktree-branch commit was harder to
recover than the others; can be backfilled in a followup pass.)

The dry-run gate of this corpus exits 0 — all 4 pairs are `ready`. The
corpus is structurally usable; only the dispatch wiring is the blocker.

## What would unblock Phase 4 end-to-end

A new story (let's call it **Story 81-6: Wire production dispatcher into
eval harnesses**) needs to:

1. Audit substrate's `@substrate-ai/core` exports for `createDispatcher` (or
   equivalent) — confirm signature, identify whether it accepts a pack-loader
   override as a constructor parameter
2. If no pack-override exists today: add an additive constructor option
   `methodologyPack?: MethodologyPack` (forward-only) to the dispatcher; when
   provided, overrides the default-loaded pack
3. Implement `deps.dispatch` in BOTH `scripts/eval-reconstruction/harness.mjs`
   and `scripts/eval-pack-upgrade/harness.mjs`:
   ```javascript
   dispatch: async (request, packPath) => {
     const pack = await createPackLoader().load(packPath)
     const dispatcher = createDispatcher({ pack, agentAdapter: <...> })
     return await dispatcher.dispatch(request)
   }
   ```
4. Wire auth — the dispatcher needs a Claude/Codex/Gemini agent adapter
   with valid credentials. For local invocations use the operator's OAuth
   session; for CI use API key from env (`ANTHROPIC_API_KEY` per Story 81-5).
5. Add an integration test that runs ONE pair through the harness against a
   real model with a tiny budget cap (e.g., 5 turns, $0.50) to confirm the
   end-to-end flow works.

Estimated scope: **~300-500 LOC + tests**, depending on whether the
pack-override mechanism needs to be added to core. The story unblocks both
Epic 77's reconstruction tier AND Epic 81's pack-upgrade tier — one ship,
two unlocks.

## What CAN still ship without 81-6

- **Story 81-5 (CI workflow yaml + PR-comment poster)** is technically
  authorable today, but it would post vacuous GREEN comments on every pack
  PR until 81-6 ships — actively misleading. Recommendation: defer 81-5
  until 81-6 lands.
- **The fixture corpus itself** is committed and durable — when 81-6 ships,
  Phase 4.1 + 4.2 can re-run against this corpus immediately.

## Calibration data we have (despite the gap)

- Build: GREEN at every merge
- Tests: 10007/10008 passing (1 pre-existing skip)
- eval-outcomes regression gate: 100% GREEN (35/35) at every merge
- Pack-upgrade CLI smoke (dry-run): exits cleanly against the fixture corpus
  (4 ready, 0 corpus-errors)
- Pack-upgrade CLI smoke (full): vacuous GREEN — confirms the framework
  doesn't crash, but cannot confirm it detects regressions until 81-6 ships

## Disposition

- Stories 81-1..81-4: COMPLETE (merged + reconciled in substrate state).
- Stories 81-5: PARK pending 81-6.
- Story 81-6 (production dispatcher wiring): FILE as new story; the substrate
  side of Epic 81 cannot prove its capability until this lands.
- Phase 4.2 deliberate-regression test: DEFER until 81-6 lands.
- Phase 4.3 calibration doc: THIS DOCUMENT.

The framework (schemas, helpers, libs, CLI, reports) is sound and reusable.
The capability gap is in dispatch wiring, not in the four-axis grading or
report shapes. Once dispatcher is wired (Story 81-6), the Phase 4 + Phase 5
validation arc can resume from this calibration baseline.
