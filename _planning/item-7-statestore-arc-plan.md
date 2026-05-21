# Item 7 Arc v2: StateStore Excision — Empirically Re-Grounded

> **Plan v2** — produced 2026-05-21 after v1 was falsified during its own Ship 1 audit.
> v1 archived at `item-7-statestore-arc-plan-v1-FALSIFIED.md`.
>
> Panel reconvened with Mary 📊 added for empirical interrogation; the rest of the original
> panel (Winston, Bob, Quinn, John, Amelia) revised their positions based on findings.
>
> Target arc: **3-4 ships**, ~−1500 to −2500 LOC, all dead-code excision + interface cleanup.
> Significantly simpler than v1 because the smell turned out to be dead code, not architectural confusion.

---

## 0. Why v1 was falsified

v1's core premise: "The orchestrator depends on FileStateStore for in-memory state; that's misleadingly named and architecturally muddled."

**Empirical reality (verified 2026-05-21):**

1. **The orchestrator does NOT depend on FileStateStore in production.** All three production construction sites (`run.ts:1793`, `run.ts:2652`, `resume.ts:574`) and `retry-escalated.ts:194` construct the orchestrator **without** a `stateStore` argument. `stateStore?: StateStore` is optional, and in production it is ALWAYS undefined.

2. **All 10+ orchestrator stateStore call sites are dead in production.** Every `stateStore.recordMetric(...)`, `stateStore.setStoryState(...)`, `stateStore.setContracts(...)`, `stateStore.setContractVerification(...)`, and `stateStore.queryStories({})` call is guarded by `if (stateStore !== undefined)` — which is always false in production.

3. **The "resume scenarios" cache restoration is dead code** (`orchestrator-impl.ts:5533`). The comment describes a feature that has been non-functional in production for an unknown duration. (Resume actually works via the run manifest, not StateStore.)

4. **FileStateStore IS used in production — but ONLY for routing telemetry.** A single instance is constructed at `run.ts:1248` and handed to `routingTokenAccumulator`. It uses ONLY the `setMetric`/`getMetric` subset (the narrow `IStateStore` contract from `packages/core/src/routing/types.ts:173`). The StateStore methods are never called on this instance in production.

5. **10+ tests pass `stateStore: store` to the orchestrator** and assert on stateStore calls. These tests have been validating code paths that don't run in production. This is its own quality issue, but it explains why the smell was invisible: the tests made it look alive.

So the actual smell is **dead code + a class doing two unrelated jobs**, not architectural confusion about persistence.

## 1. The actual smell (revised)

**Three stacked issues:**

### Issue A — Dead orchestrator state surface (~600 LOC of dead code)

In `orchestrator-impl.ts`, ~10 sites use the pattern:

```ts
if (stateStore !== undefined) {
  stateStore.setStoryState(key, record)
  // OR stateStore.recordMetric(...)
  // OR stateStore.setContracts(...)
  // OR stateStore.queryStories({})
  // OR stateStore.setContractVerification(...)
}
```

Production never enters these blocks. Removing them is pure dead-code excision. The `stateStore?: StateStore` prop on OrchestratorDeps becomes vestigial.

### Issue B — A class doing two unrelated jobs

`FileStateStore` implements `StateStore`. The class carries:

- **Orchestrator-state Maps** (`_stories`, `_metrics`, `_contracts`, `_contractVerifications`) — populated in tests, never in production.
- **A persistent KV store** (`_kvMetrics` + `_flushKvMetrics()`) — populated and READ in production by `routingTokenAccumulator` + `substrate metrics` CLI.

These are different concerns conflated by historical accretion. The KV store satisfies the narrow `IStateStore` interface; the orchestrator-state maps satisfy the broader `StateStore` interface (which extends `DoltOperatorReader`).

### Issue C — Tests covering non-existent production paths

`orchestrator-state-store.test.ts` + `contract-verification-integration.test.ts` + `per-story-state-wiring.test.ts` + `orchestrator-wg-stories-status.test.ts` + `recovery-history-wiring.test.ts` (5 test files, 10+ test cases) construct orchestrators with `stateStore: store` and verify state-bearing behavior. None of this runs in production.

Test quality concern: tests of dead code give false confidence. We should either delete them (when the test target is genuinely dead) or rewire them to test the actual production behavior (when the test target represents a real feature that should work).

## 2. Decomposed concerns, honest homes

| Concern | Today | Honest home |
|---|---|---|
| Orchestrator's per-story state (phase, lifecycle) | Sometimes stateStore Map, sometimes private `_stories` Map | Existing private `_stories` Map (already exists at orchestrator-impl.ts:5410). The stateStore-side is redundant + dead. |
| Cost/wall-clock/cycle metrics | `recordMetric` to dead Map + `writeStoryMetrics(db, ...)` to durable Dolt table | `writeStoryMetrics` already does the real work; delete recordMetric. |
| Parsed interface contracts | `setContracts`/`queryContracts` on dead Map (verifier reads them within same run via... actually wait, also dead since stateStore is undefined) | Need to verify how the verifier gets contracts when stateStore is undefined. Likely passed directly. |
| Contract verification results | `setContractVerification` to dead Map (basePath JSON file has zero readers anywhere) | Delete entirely. Outcomes feed run manifest's pipeline_runs row + `pipeline:contract-verification-summary` event. |
| Routing KV (phase_token_breakdown, tune_log) | FileStateStore.setMetric/getMetric → kv-metrics.json | UNCHANGED. This is the legitimate production use. |

## 3. Revised ship sequence — 3 ships

### Ship 1 — Excise dead orchestrator state surface

**Concerns addressed:** Issue A. Delete every `if (stateStore !== undefined)` block in orchestrator-impl.ts. Remove the `stateStore?: StateStore` prop from OrchestratorDeps. Delete the `_stateStoreCache` Map and the resume-state restoration code (the latter is dead per finding #3).

**Files touched:**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — ~10 stateStore call sites removed, prop removed, _stateStoreCache removed. ~−600 to −800 LOC.
- `src/modules/implementation-orchestrator/index.ts` — OrchestratorDeps re-export type update
- Test files that constructed orchestrator with `stateStore: store` — either delete the test (if covering pure dead-code paths) OR rewire to test private-field behavior. Decision per-test during audit.
  - `orchestrator-state-store.test.ts` — likely delete or skeleton
  - `contract-verification-integration.test.ts` — may need rewiring
  - `per-story-state-wiring.test.ts` — likely delete
  - `orchestrator-wg-stories-status.test.ts` — verify wg_stories writes still go to db (separate path)
  - `recovery-history-wiring.test.ts` — check

**Gates required:**
- npm test full suite green (some tests will be deleted; ensure no orphan asserts)
- Static gate: `grep -c "if (stateStore !== undefined)" src/modules/implementation-orchestrator/orchestrator-impl.ts` returns 0
- Tier 2 smoke: dispatch one real story against ynab, end-to-end success

**Dependencies:** None.

**Reversibility:** Low. This is the big deletion ship. Once landed, reverting requires rebuilding the dead branches.

**LOC delta:** −800 to −1200 (production code + test cleanup combined).

**Risk:** The verifier's contract path. If the verifier reads `stateStore.queryContracts()` in production via SOME route... currently that's `await stateStore.queryContracts()` at orchestrator-impl.ts:5613 — which IS production code (no `if (stateStore !== undefined)` guard at that site). **Must verify what happens at L5613 when stateStore is undefined.** If it crashes, the verifier IS dependent on stateStore in production, and the panel's analysis is INCOMPLETE.

### Ship 2 — Split FileStateStore into FileKvStore + delete StateStore interface

**Concerns addressed:** Issue B. After Ship 1, FileStateStore has no orchestrator-side callers. Narrow it to just the KV portion (rename to `FileKvStore` for honesty), with `IStateStore` as its only contract. Delete `StateStore` interface entirely.

**Files touched:**
- `src/modules/state/file-store.ts` — strip story/metric/contract Maps, keep only `_kvMetrics` + `setMetric`/`getMetric` + `_flushKvMetrics()` + lifecycle. Rename class to `FileKvStore`.
- `src/modules/state/types.ts` — delete `StateStore`, `StoryRecord` (or move to orchestrator), `StoryFilter`, `MetricRecord`, `MetricFilter`, `ContractRecord`, `ContractFilter`, `ContractVerificationRecord`. Keep `DoltOperatorReader`.
- `src/modules/state/index.ts` — update exports
- `src/cli/commands/routing.ts:35` — `new FileStateStore` → `new FileKvStore`
- `src/cli/commands/metrics.ts:458, 785` — `createStateStore`/`FileStateStore` → equivalent KV store
- `src/cli/commands/run.ts:1248` — `new FileStateStore` → `new FileKvStore`
- `packages/core/src/routing/types.ts:173` — `IStateStore` interface stays, but consider moving to a routing-specific module if no other module uses it
- Tests covering the now-removed methods (recordMetric, setStoryState, etc. tests in file-store.test.ts) — delete

**Gates required:**
- npm test full suite green
- Static gate: `grep -c "StateStore\|FileStateStore\|createStateStore" src/ packages/ --include='*.ts'` returns zero matches (after the renames + deletions)
- Tier 2 smoke: ynab dispatch still green; routing-tuner functionality still works (verify substrate metrics --json shows phase_token_breakdown)

**Dependencies:** Ship 1.

**Reversibility:** Low.

**LOC delta:** −500 to −800.

**BREAKING CHANGE:** `@substrate-ai/core` removes `StateStore`, `FileStateStore`, `createStateStore` from public exports. CHANGELOG must document.

### Ship 3 — CHANGELOG + memory + final docs

**Concerns addressed:** Documentation + memory persistence.

**Files touched:**
- `CHANGELOG.md` — consolidated arc entry with BREAKING section
- `MEMORY.md` (operator memory) — version line update + arc retrospective
- New memory file: `project_statestore_excision_arc_2026_05.md` with retrospective + durable lessons
- `CLAUDE.md` (project root) — mentions of StateStore concept updated
- `src/cli/templates/{claude,agents,gemini}-md-substrate-section.md` — updated if any references existed
- `_planning/item-7-statestore-arc-plan-v1-FALSIFIED.md` — leave as forensic record

**Gates required:** Build + test green.

**Dependencies:** Ships 1-2.

**Reversibility:** Trivial — docs only.

**LOC delta:** +100 to +200 (docs additions).

## 4. Pre-Ship-1 critical audits

**These MUST be completed before Ship 1 starts. Each one could expand or contract the arc.**

### Audit A — Is the verifier actually dependent on stateStore?

`orchestrator-impl.ts:5613` calls `await stateStore.queryContracts()` WITHOUT a `stateStore !== undefined` guard. If stateStore is undefined in production (which it is), this code should be crashing. Either:
- It's surrounded by a higher-level guard I missed → safe to assume dead
- It would crash if reached → there's an early-return making it unreachable
- It would crash but the verifier's surrounding try/catch swallows it → silent feature degradation in production

**Verify by reading orchestrator-impl.ts:5600-5650 carefully.** Determine the actual production behavior. If the verifier path is silently degraded, fixing it is OUT OF SCOPE for this arc (it would be a separate restore-broken-feature ship), but must be flagged.

### Audit B — Story 28-6 setMetric/getMetric usage

The `setMetric`/`getMetric` on FileStateStore IS live in production (via the kvStateStore instance at run.ts:1248). Ship 2's rename `FileStateStore → FileKvStore` MUST preserve this. Specifically:
- routingTokenAccumulator.setMetric calls still write to kv-metrics.json
- routing-tuner.getMetric calls still read it
- `substrate metrics` CLI still reads the JSON file for `phase_token_breakdown`

### Audit C — IStateStore home

`IStateStore` is currently in `packages/core/src/routing/types.ts`. It's used by routing-tuner + routing-token-accumulator in the same package. Should the post-arc structure move it elsewhere, or stay? Most likely stay — it's a routing-local interface.

### Audit D — wg_stories writes

`orchestrator-impl.ts` writes to wg_stories via WorkGraphRepository (separate from StateStore). Verify that path is unaffected by orchestrator stateStore removal.

### Audit E — Test deletion vs rewiring decisions

For each of the 5 test files identified in Issue C, decide: delete entirely (covers pure dead-code) or rewire (test the production-equivalent behavior). The decision is per-test, made during Ship 1.

## 5. Drift gates

**Static gate** — per-ship grep assertions:
- After Ship 1: `grep -c "if (stateStore !== undefined)" src/` returns 0
- After Ship 2: `grep -cE "StateStore|FileStateStore|createStateStore" src/ packages/ --include='*.ts'` returns 0 (or just IStateStore + DoltOperatorReader matches)

**Runtime gate** — Tier 2 smoke against ynab between Ships:
- Ship 1 complete: dispatch one story end-to-end against ynab. Verify story_metrics + run manifest + wg_stories all update correctly.
- Ship 2 complete: same, plus verify `substrate metrics --output-format json` still surfaces `phase_token_breakdown`.

**Pre-arc baseline** — empirical capture before any code changes:
- `git log --oneline -1` of v0.20.105
- ynab kv-metrics.json content snapshot
- `substrate metrics --output-format json` against ynab — capture the output for diff at end of arc

## 6. What changes vs what stays

**Removed by the arc:**
- `if (stateStore !== undefined) { ... }` blocks (~10 sites)
- `_stateStoreCache: Map<string, StoryRecord>` and its initialization code
- `stateStore?: StateStore` prop on OrchestratorDeps
- StateStore interface entirely
- FileStateStore (replaced by narrower FileKvStore)
- createStateStore factory
- StoryRecord, StoryFilter, MetricRecord, MetricFilter, ContractRecord, ContractFilter, ContractVerificationRecord types (orchestrator-state-flavored types)
- contract-verifications.json file write (the basePath path on setContractVerification — zero readers)
- 5+ test files covering pure dead-code paths (or rewired)

**Preserved by the arc:**
- DoltOperatorReader interface
- DoltStateStore class (unchanged)
- createDoltOperatorReader factory
- All operator CLI commands (status, report, health, metrics, history, epic-status, resume, retry-escalated)
- Run manifest + initSchema tables + ALL telemetry persistence (story_metrics, pipeline_runs, wg_stories, turn_analysis, etc.)
- kv-metrics.json + routing-tuner + auto-tuner code
- IStateStore (narrow KV interface) — preserved for routing-tuner contract

**Net result:**
- Orchestrator becomes simpler (no stateStore prop, no dead branches)
- File-backed storage becomes honest (FileKvStore is what it actually is)
- Tests become less misleading (no false coverage of dead code)
- Persistence story unchanged (all real durable state still goes to manifest + Dolt tables)

## 7. Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Audit A reveals verifier IS dependent on stateStore | Medium | Pre-Ship-1 audit answers this; if true, arc scope expands |
| Test rewiring takes longer than estimated | Medium | Decisions per-test; if a test deserves rewiring, do it carefully or delete + flag for future |
| Hidden production dependency on the removed types/exports | Low | External-package scan (Q2 in v1 audit) returned zero; if a consumer somewhere imports, CHANGELOG covers it |
| Routing-tuner code subtly depends on something we delete | Low | Ship 2 preserves the IStateStore subset; Tier 2 smoke confirms substrate metrics still works |
| wg_stories writes accidentally regress | Low | Separate code path (WorkGraphRepository); Ship 1 audit confirms unaffected |

## 8. Deferred decisions

- **Should `kv-metrics.json` move to a Dolt table?** Out of scope for this arc. The current file-based approach works; migrating to Dolt would be a separate "routing telemetry durability" arc.
- **Should the orchestrator state-restoration feature actually work?** The dead resume-restoration code at L5533 describes a feature that's been non-functional. Either (a) it's not needed (manifest covers it) or (b) it's a degraded feature operators haven't noticed. Out of scope; this arc deletes the dead code only.
- **Should the `_stories` Map in orchestrator-impl.ts move to a separate per-run state class?** This would be a further architectural cleanup (orchestrator file is 4000+ lines). Out of scope — this arc deletes dead code and leaves the live code alone.

## 9. Success criteria

The arc is "done" when ALL of these hold:

- [ ] Pre-Ship-1 audits (A through E) completed and documented
- [ ] `grep -rn "if (stateStore !== undefined)" src/` returns zero production-code matches
- [ ] `grep -rn "StateStore\|FileStateStore\|createStateStore" src/ packages/ --include='*.ts'` returns zero matches (excepting IStateStore + DoltOperatorReader)
- [ ] `orchestrator-impl.ts` does not declare a `stateStore?` prop on its deps
- [ ] Ship 1's static gate green (no orphan dead-code branches)
- [ ] Ship 2's static gate green (no orphan FileStateStore references)
- [ ] Full `npm test` green at every ship boundary
- [ ] Tier 2 smoke against ynab succeeds after Ships 1, 2
- [ ] CHANGELOG entry for the arc with BREAKING section landed
- [ ] MEMORY.md updated with arc retrospective
- [ ] All operator surfaces (status, report, health, metrics, history, epic-status, resume) verified working post-arc against ynab

---

## Appendix A — v1-to-v2 delta summary

| Aspect | v1 (FALSIFIED) | v2 (this plan) |
|---|---|---|
| Ship count | 7 | 3 |
| LOC delta estimate | −800 to −1200 | −1500 to −2500 (mostly dead-code removal) |
| Premise | Orchestrator depends on FileStateStore, which is misleadingly in-memory | Orchestrator's stateStore is undefined in production; all writes are dead-code branches |
| Risk | Each ship touches orchestrator-impl.ts, accumulated edit-load | Most risk in Ship 1's audit answers; if dependencies surface, plan revises |
| Reversibility | Per-ship | Ship 1 + 2 are largely irreversible after landing |
| Cadence | 1-2 days, paced | Same — Ship 1 + 2 day-1, Ship 3 same day or day-2 |

## Appendix B — Lessons for future architectural audits

1. **Demand empirical evidence for every "X depends on Y" claim.** v1's panel built on stated assumptions; v2 caught the errors only because Ship 1's first action was an empirical audit. Future planning sessions should start with "what's actually called in production?" before discussing concerns.

2. **Optional-typed dependencies hide dead code.** `stateStore?: StateStore` made it possible to leave the production code path with stateStore=undefined while keeping the API surface alive for tests. The `?` was load-bearing for hiding the smell. Future code reviews should flag optional deps with question: "what happens when this is undefined? do production callers pass it?"

3. **Tests that pass dependencies production omits are warning signs.** When prod code says `if (dep !== undefined) { complicated work }` and tests always pass `dep: realStore`, you have parallel realities — tests covering a feature that doesn't run in prod. Either fix prod or delete the tests.

4. **The first 30 minutes of Ship 1 (audit) saved 5+ ships of work that would have built on false premises.** Pre-implementation audits pay back even when the arc plan looks confident.
