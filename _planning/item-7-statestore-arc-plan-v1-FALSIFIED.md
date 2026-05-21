# Item 7 Arc: StateStore-as-per-process-scratch — Architectural Excision

> **Planning artifact** — produced via bmad-party-mode panel 2026-05-20 after the schema-unification arc (v0.20.92 → v0.20.104) sealed the persistence-DDL layer. This arc completes the persistence-layer architectural debt by eliminating the misleading-by-design `StateStore` interface and `FileStateStore` class.
>
> Panel: Winston (Architect), Bob (Scrum Master), Quinn (QA), John (PM), Amelia (Dev).
>
> Target arc: 7 ships, ~−800 to −1200 LOC, comparable cadence to the schema-arc but explicitly paced (panel recommends NOT compressing into a single sitting given orchestrator-impl.ts edit load).

---

## 1. The defect class

`FileStateStore` is misleadingly named — in-memory only despite the "File" prefix. The single optional `basePath` parameter only persists contract-verifications to `{basePath}/contract-verifications.json`, and that file has zero readers across the entire codebase (verified empirically). Everything else stays in `Map<string, ...>` private fields and dies at process exit.

Meanwhile, the canonical durable state for every operator surface (`substrate status`, `substrate report`, `substrate health`, `substrate metrics`, `substrate history`, `substrate epic-status`) lives in two correctly-designed layers:

- **Run manifest** at `.substrate/runs/<run-id>.json` (per-run, persisted, queried by ID)
- **initSchema-managed Dolt tables** (`pipeline_runs`, `story_metrics`, `wg_stories`, `decisions`, etc. — 29 base tables + 3 views post-arc)

`StateStore` is a third layer between these two: ephemeral scratch with no consumers. Removing it makes the architecture honest about which writes are durable and which are within-run.

## 2. Empirical baseline (must be verified Ship 1)

Pre-arc claims that must be confirmed before any code changes:

| Claim | Verification method |
|---|---|
| Every operator command reads manifest + Dolt, NOT FileStateStore | Grep all `src/cli/commands/*.ts` for FileStateStore / createStateStore imports |
| `{basePath}/contract-verifications.json` has zero readers | Grep entire codebase for `contract-verifications.json` |
| `substrate resume` reads from run manifest, not FileStateStore | Read `src/cli/commands/run.ts` resume path |
| No external package imports FileStateStore or createStateStore | Check `packages/core` re-export surface + scan strata + ynab + agent-mesh consumer code |
| Routing-recommendations path (`substrate metrics` non-primary surface) doesn't depend on FileStateStore writes | Trace `substrate metrics --output-format json` through to source |
| Multi-story batch state-isolation works with shared in-memory map | Confirm by reading orchestrator concurrent-dispatch code |

If any claim fails, Ship 1 scope expands to address before the rest of the arc proceeds.

## 3. Decomposition — six methods, five honest homes

| StateStore method | Current behavior | Honest home post-arc |
|---|---|---|
| `setStoryState` | In-memory Map write | Private orchestrator field (`Map<string, StoryRecord>`) |
| `queryStories` | In-memory Map read | Same private field |
| `recordMetric` | In-memory Map keyed by metric tuple | Direct call to `writeStoryMetrics()` (already exists, writes to `story_metrics` table) |
| `setContracts` | In-memory Map (per-story contract list) | Private orchestrator field — within-run only, no cross-process consumer |
| `queryContracts` | In-memory Map read | Same private field; contract-verifier consumes via private accessor |
| `setContractVerification` | Optional JSON file write to basePath — **NO READERS** | Excised entirely; verification outcomes already feed run-manifest's pipeline_runs row |

The two pure deletions (`setContractVerification` + the basePath JSON file) follow the operator-command excision policy from Ship 1: "delete > document broken > stub."

## 4. Ship sequence

Seven ships, paced. Schema-arc landed 7 ships in one day; this arc is explicitly NOT compressed — panel consensus is that orchestrator-impl.ts edit load + per-ship integration validation needs at least 1-2 days of focused work.

### Ship 1 — Audit + orchestrator-integration drift gate

**Concerns addressed:** Establishes baseline. No production code change.

**Files touched:** Adds `test/integration/orchestrator-statestore-baseline.test.ts` (new — mocked-dispatcher integration test exercising the full orchestrator and asserting on every persistent surface).

**Gates required:**
- Static gate (new): grep-based assertion that the 6 StateStore-only method names have call-site counts matching baseline. Future ships reduce these to 0 one by one.
- Runtime gate (new): full orchestrator mock-dispatch run that asserts on story_metrics writes, run-manifest pipeline_runs update, wg_stories writes — all the canonical surfaces.

**Dependencies:** None (foundation ship).

**Reversibility:** Trivial — pure test addition.

**LOC delta:** +200 to +400 (test file + drift-gate logic), 0 production lines changed.

**Empirical audit deliverables** (artifacts produced during Ship 1, attached to commit):
- Audit memo: every consumer of every StateStore method enumerated with file:line citations
- contract-verifications.json reader-grep result (expected: zero)
- substrate resume code-walk confirming manifest-only reads
- External-package import check (strata + ynab + agent-mesh consumer scan)

If audit surfaces any unexpected consumer, Ship 1 STOPS and panel reconvenes.

### Ship 2 — Move story-state to private orchestrator field

**Concerns addressed:** `setStoryState`, `queryStories`. Local to orchestrator-impl.ts.

**Files touched:**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — replace `stateStore.setStoryState(k, r)` / `stateStore.queryStories(f)` with internal `Map<string, StoryRecord>` operations. ~10 sites.
- `src/modules/state/types.ts` — remove `setStoryState` + `queryStories` from `StateStore` interface
- `src/modules/state/file-store.ts` — remove the two no-op stub implementations
- `src/modules/implementation-orchestrator/__tests__/orchestrator-state-store.test.ts` — update assertions to verify private-field shape instead of mock-spy on stateStore methods
- `src/modules/state/__tests__/file-store.test.ts` — remove tests for the 2 deleted methods

**Gates required:**
- Ship 1's runtime gate must remain green
- Ship 1's static gate's `setStoryState`/`queryStories` counters → 0
- `orchestrator-state-store.test.ts` mocked-dispatch must complete unchanged

**Dependencies:** Ship 1.

**Reversibility:** Medium. The interface narrowing is the irreversible step; the Map operations are local refactor.

**LOC delta:** −150 to −250.

### Ship 3 — Direct story_metrics writes

**Concerns addressed:** `recordMetric` — consolidate to canonical `writeStoryMetrics()` path.

**Files touched:**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — replace `stateStore.recordMetric(m)` with direct `writeStoryMetrics(adapter, m)` from `@substrate-ai/core`. ~2 sites.
- `src/modules/state/types.ts` — remove `recordMetric` from StateStore interface
- `src/modules/state/file-store.ts` — remove the in-memory metric Map + stub
- `src/modules/state/__tests__/file-store.test.ts` — remove related tests
- `src/modules/implementation-orchestrator/__tests__/*.test.ts` — update mocks that declared `recordMetric: vi.fn()...`

**Gates required:** Ship 1's gates remain green; `recordMetric` counter → 0.

**Dependencies:** Ship 2 (incremental orchestrator refactor).

**Reversibility:** Medium-high — the consolidation is the load-bearing change; revertable if writeStoryMetrics surface has unexpected behavior.

**LOC delta:** −100 to −150.

**Risk flag:** writeStoryMetrics may have different transaction semantics than the in-memory record. Audit before flipping.

### Ship 4 — Move contracts to private orchestrator state

**Concerns addressed:** `setContracts`, `queryContracts`.

**Files touched:**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — private `Map<string, ContractRecord[]>` field, accessed via private getters/setters. Contract-verifier consumes via the private accessor (parameter passed, not stored interface).
- `src/modules/state/types.ts` — remove `setContracts`, `queryContracts`, `ContractRecord` from StateStore interface (keep ContractRecord type in types.ts; it's still useful)
- `src/modules/state/file-store.ts` — remove related Map + stubs
- Multiple test files (orchestrator-state-store.test.ts, file-store.test.ts, contract-related tests) — update mocks

**Gates required:** Ship 1's runtime gate remains green (contract-verifier must still receive contracts correctly); static counters for both methods → 0.

**Dependencies:** Ships 2-3.

**Reversibility:** Medium.

**LOC delta:** −150 to −250.

### Ship 5 — Excise contract-verification persistence

**Concerns addressed:** `setContractVerification` + the basePath JSON file. Pure deletion ship.

**Files touched:**
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — delete the call site (~1 site)
- `src/modules/state/types.ts` — remove `setContractVerification` + `ContractVerificationRecord` type (or keep type if used elsewhere)
- `src/modules/state/file-store.ts` — remove method + the conditional JSON write to `{basePath}/contract-verifications.json`
- `src/modules/state/__tests__/file-store.test.ts` — remove related tests

**Gates required:** Ship 1's runtime gate remains green; verification outcomes still appear in run manifest correctly.

**Dependencies:** Ships 2-4.

**Reversibility:** High — pure excision; no migration logic to unwind.

**LOC delta:** −80 to −120.

**Same pattern as Ship 1's operator-command excision** (substrate diff/contracts) and Ship 8's legacy-state-table cleanup. Zero consumers verified in Ship 1 audit.

### Ship 6 — Delete StateStore interface + FileStateStore + createStateStore

**Concerns addressed:** Final surface excision.

**Files touched:**
- `src/modules/state/types.ts` — delete `StateStore` interface entirely (DoltOperatorReader unchanged)
- `src/modules/state/file-store.ts` — DELETED
- `src/modules/state/__tests__/file-store.test.ts` — DELETED
- `src/modules/state/index.ts` — remove `FileStateStore`, `createStateStore`, related type re-exports. Keep DoltOperatorReader exports.
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — change `stateStore?: StateStore` dep param to remove; orchestrator no longer needs a state store
- `packages/core/src/persistence/index.ts` — verify no transitive re-exports of FileStateStore
- All test files mocking createStateStore / FileStateStore — update

**Gates required:**
- Ship 1's runtime gate remains green
- New static gate: grep for `FileStateStore`, `createStateStore`, `StateStore` (the interface type) in production code — all should return zero. Test imports of these symbols should fail-to-resolve as additional safety net.

**Dependencies:** Ships 2-5.

**Reversibility:** Low — the deletion ship. Revert requires rebuilding the interface.

**LOC delta:** −200 to −300.

**BREAKING CHANGE:** `@substrate-ai/core` removes `FileStateStore`, `createStateStore`, `StateStore` type from public exports. CHANGELOG must call this out.

### Ship 7 — Operator-facing docs + CHANGELOG + memory updates

**Concerns addressed:** Documentation, breaking-change communication, memory persistence of the arc lessons.

**Files touched:**
- `CHANGELOG.md` — consolidated arc entry with BREAKING section
- `src/cli/templates/{claude,agents,gemini}-md-substrate-section.md` — remove any references to StateStore concept; orchestrator-internal state is now explicitly "internal" in docs
- `CLAUDE.md` (project root) — update mention of the persistence layer if relevant
- `~/.claude/projects/-home-jplanow-code-jplanow-substrate/memory/MEMORY.md` — version line update
- New memory file: `project_statestore_arc_2026_05.md` with the arc retrospective + durable lessons

**Gates required:** Build + test green. No production behavior change.

**Dependencies:** Ships 1-6.

**Reversibility:** Trivial — pure docs.

**LOC delta:** +100 to +200 (docs additions).

## 5. Final architecture surface

```
src/modules/state/
  ├── types.ts        # DoltOperatorReader + StoryRecord types only; NO StateStore
  ├── dolt-store.ts   # unchanged (DoltStateStore implements DoltOperatorReader)
  ├── errors.ts       # unchanged
  └── index.ts        # exports: DoltOperatorReader, createDoltOperatorReader,
                      #          DoltStateStore, DoltClient, types only
                      # REMOVED: StateStore, FileStateStore, createStateStore

packages/core public surface
  → DoltOperatorReader, createDoltOperatorReader, initSchema, initXxxSchema (×7)
  → No StateStore concept at all

src/modules/implementation-orchestrator/orchestrator-impl.ts
  → private storyStates: Map<string, StoryRecord>
  → private contractsByStory: Map<string, ContractRecord[]>
  → Direct writeStoryMetrics(adapter, m) calls for cost/timing
  → No stateStore? prop on OrchestratorDeps
  → All cross-process operator reads happen via manifest + DoltOperatorReader
```

## 6. Boundary risks (panel-identified, deferred to Ship 1 audit)

1. **External package consumers.** If strata / ynab / agent-mesh / other projects import `FileStateStore` or `createStateStore` from `@substrate-ai/core`, Ship 6 breaks them. Ship 1 must scan consumer repos.

2. **Routing-recommendations path in `substrate metrics`.** Amelia flagged this might still read FileStateStore. Ship 1 must trace + resolve before the arc starts.

3. **`{basePath}/contract-verifications.json` operator usage.** If any operator workflow scrapes this file out-of-band, Ship 5 silently breaks them. Audit: any documentation, scripts, or wiki references mentioning this path.

4. **Multi-story concurrent dispatch state isolation.** Current model: shared in-memory Map keyed by story_key. Post-arc model: same shared Map but as a private orchestrator field. State isolation between sibling stories is preserved because keys remain distinct. Verify under concurrent dispatch.

5. **substrate resume across the arc boundary.** A run started on v0.20.104 (with FileStateStore) should still resume on the post-arc version. Likely safe since resume reads only the manifest, but Ship 1 should add a regression test.

6. **OrchestratorDeps surface change in Ship 6.** Any caller constructing an orchestrator with `{ stateStore: ... }` breaks. Ship 6 must surface a clear migration path or, ideally, the parameter has zero external callers (because orchestrator is internal). Audit.

## 7. Deferred decisions (explicitly out of scope)

1. **Whether to add a "run-scoped scratch" abstraction post-arc.** Some future use case might want a typed bag of per-run scratch that gets cleaned up at exit. Out of scope — wait for empirical need.

2. **Whether to split orchestrator-impl.ts into smaller files.** The file is 4000+ lines. Cleanup is desirable but its own arc, not this one. This arc only edits where necessary.

3. **Whether to add a "per-run artifact directory" for transient data.** If contracts grow large or need cross-process inspection, a `.substrate/runs/<run-id>/contracts.json` per-run artifact could be added. Out of scope — only do this if Ship 1 audit surfaces a legitimate operator need.

4. **Versioning the run manifest schema.** Manifests are JSON; backward-compat is loose. If this arc changes any manifest field shape, a versioning concern arises. This arc should NOT change manifest shape — confirm in Ship 1.

5. **The bigger `RunManifest` vs Dolt-tables architectural question.** Some data lives in both. The arc doesn't address that overlap.

## 8. Drift gate strategy

Two complementary gates, mirroring the schema-arc's runtime + static pattern:

**Runtime gate** (`test/integration/orchestrator-statestore-baseline.test.ts`, new in Ship 1):
- Mocked dispatcher exercises full orchestrator (5-10 stories, 2-3 phase outcomes including SHIP_IT + escalation)
- Asserts on every persistent surface: run-manifest pipeline_runs row updated, story_metrics rows written, wg_stories status updated, contract-verifications no longer written (after Ship 5)
- Runs in ~5-10s, no real Dolt needed (in-memory adapter)
- Must remain green at every ship boundary

**Static gate** (`test/modules/state/statestore-call-site-counts.test.ts`, new in Ship 1):
- Grep-based file-content assertion that the 6 StateStore-only methods have call-site counts equal to the per-ship baseline
- Ship N's expected counts: 0 for all methods deleted by Ships 2-5; final assertion: zero references to `StateStore`, `FileStateStore`, `createStateStore` anywhere in production code post-Ship-6

## 9. Cadence and pacing

- Panel recommends **NOT compressing into a single sitting.** Orchestrator-impl.ts edits accumulate cognitive load.
- Suggested cadence: Ship 1 + 2 day-1, Ships 3-4 day-2, Ships 5-6 day-3, Ship 7 same day as 6.
- Each ship: full local pipeline (build / check:circular / typecheck:gate / npm test) before commit. Tag + publish + CI green before next ship starts.
- Final ship validation: dispatch one real story against ynab (Tier 2 smoke equivalent) before declaring the arc sealed. Same pattern as the schema-arc post-arc cleanup verification.

## 10. Success criteria

The arc is "done" when ALL of these hold:

- [ ] `grep -rn "StateStore\|FileStateStore\|createStateStore" src/ packages/ --include='*.ts'` returns zero production-code matches
- [ ] `packages/core` exports do not include `FileStateStore`, `createStateStore`, `StateStore` type
- [ ] `orchestrator-impl.ts` does not declare a `stateStore?` prop on its deps
- [ ] Ship 1's runtime gate still green
- [ ] Full `npm test` still green
- [ ] Tier 2 smoke against ynab (one real story dispatch) succeeds end-to-end
- [ ] CHANGELOG entry for the arc landed with BREAKING section
- [ ] MEMORY.md updated with version line + arc retrospective
- [ ] All operator surfaces (status, report, health, metrics, history, epic-status, resume) verified working post-arc against ynab

---

## Appendix A — Panel disagreements (resolved)

- **Bob vs Winston on ship count.** Bob initially pushed for 5 ships max; Winston argued each concern needs its own ship for reversibility. Resolved at 7 with explicit cadence pacing (NOT a one-day arc).
- **Quinn vs Amelia on static gate granularity.** Quinn wanted per-method call-site counters; Amelia argued one comprehensive "FileStateStore is gone" final-ship assertion suffices. Resolved by having BOTH — the per-method counters catch incremental regression; the final gate catches the orphan-import case.
- **John vs everyone on the `basePath` JSON file.** John initially wanted to preserve it "in case someone uses it"; resolved by empirical-emptiness verification — zero readers means the schema-arc excision policy applies cleanly.

## Appendix B — Open questions for Ship 1 audit

These MUST be resolved during Ship 1's audit before any Ship 2+ work begins:

1. Does `substrate metrics --output-format json` (routing-recommendations primary path) read FileStateStore? If yes — what data, and what's its honest home?
2. Are there any external consumers (strata, ynab, agent-mesh) importing FileStateStore / createStateStore?
3. Does the `{basePath}/contract-verifications.json` file have ANY reader (CLI command, script, documentation reference)?
4. What's the OrchestratorDeps surface? Specifically, do any non-substrate callers construct an orchestrator with a custom stateStore?
5. Does `substrate resume` exercise any StateStore method during resume-bootstrap?
6. Do concurrent-dispatch tests assert on cross-story state isolation in ways that depend on the shared FileStateStore being shared (as opposed to per-orchestrator-instance)?
