# Epic 79: Fleet Data Architecture Consolidation

Implements the design in `docs/2026-05-27-fleet-data-architecture-consolidation.md`
(decision-locked 2026-05-27: D1 agent-mesh owns the contract package · D2 CPO
file-backed v1 · D3 preserve+document `monitor.db` · D4 forward-only result-enum).

**Goal:** one clean data architecture across the three planes — eliminate accidental
schema drift, vocabulary fragmentation, and physical duplication; build the missing
cross-project-observations (CPO) primitive — *without* collapsing the plane separation.

**Cross-repo note.** This is a 3-repo effort. Each story is tagged `[repo]` =
`substrate` / `agent-mesh` / `strata`. substrate-tagged stories are dispatchable
through substrate itself (dogfood). agent-mesh / strata stories are coordinated here
but execute in those repos (mirror the story into the target repo's pipeline, or
hand-build). All schema changes are **additive / forward-only** — the discipline used
for `commit_sha` / `escalation_detail` — so no plane is left half-migrated.

## Story Map

**Phase 0 — C1: canonical contract package** (foundation; unblocks everything)
- 79-1 [agent-mesh]: Extract `@jplanow/agent-mesh/contracts` — RunReport/StoryReport + canonical `StoryResult` enum (P1, Medium)
- 79-2 [substrate]: Import the contract package in mesh-reporter; delete the inline RunReport re-declaration (P1, Small) — *dep: 79-1*
- 79-3 [substrate]: Persist canonical `result` on `per_story_state`; retire `RESULT_MAP`/`MANIFEST_RESULT_MAP` (P1, Medium) — *dep: 79-1, 79-2*
- 79-4 [strata]: Import the contract package; align result vocabulary in mesh-signal/source-signal (P2, Small) — *dep: 79-1*

**Phase 1 — C2: build CPO** (the capability; ends the markdown-as-message-bus)
- 79-5 [agent-mesh]: Add `ObservationSchema` to the contracts package (P1, Small) — *dep: 79-1*
- 79-6 [agent-mesh]: CPO store (file-backed, Dolt-migration-ready) + 5 skills (P1, Large) — *dep: 79-5*
- 79-7 [agent-mesh]: Migrate `_observations-pending-cpo.md` entries into CPO, verbatim (P1, Medium) — *dep: 79-6*
- 79-8 [substrate]: Submit substrate-targeted observations via CPO (producer side) (P2, Medium) — *dep: 79-6*
- 79-9 [strata]: Consume observations via CPO — briefing + Jarvis observe skills (P2, Medium) — *dep: 79-6*

**Phase 2 — C3 + C4: document dupes + unify transport** (debt cleanup)
- 79-10 [substrate]: Investigate + document `monitor.db` rationale; preserve (D3) (P3, Small)
- 79-11 [substrate]: Decide `kv-metrics.json`; document cost derivation (cost_entries = ground truth) (P3, Medium)
- 79-12 [substrate]: Adopt agent-mesh `OutboxTransport`/client; retire the hand-rolled `.substrate/outbox` (P3, Medium) — *dep: 79-1*

**Phase 3 — deferred (out of scope here):** formalize the derived-tier rebuild guarantee
(mesh rebuildable from substrate Dolt + git); cost-ledger rework *only* if reporting is
shown wrong. Recorded so they aren't lost; not stories in this epic.

---

## Story 79-1: Extract `@jplanow/agent-mesh/contracts` [agent-mesh]

**Priority**: must · **Dispatch eligibility**: dispatchable (agent-mesh repo).

**Description**: Today substrate re-declares the `RunReport` TS interface inline in
`src/modules/telemetry/mesh-reporter.ts` instead of importing agent-mesh's
`RunReportSchema` — and the two have already drifted (`verification_ran` exists
substrate-side, not in the mesh schema). Establish agent-mesh as the single owner of the
cross-plane wire contracts (D1): expose a `contracts` entry point that re-exports the
existing `RunReportSchema`/`StoryReportSchema` plus a NEW canonical `StoryResult` enum —
the one vocabulary for a per-story verdict (`SHIP_IT | LGTM_WITH_NOTES | NEEDS_MINOR_FIXES
| NEEDS_MAJOR_FIXES | ESCALATED | FAILED`).

**Acceptance Criteria:**
1. New package export `@jplanow/agent-mesh/contracts` (subpath export in package.json) re-exporting `RunReportSchema`, `StoryReportSchema`, and a new `StoryResult` Zod enum + inferred type. No behavior change to the running mesh server.
2. `StoryReportSchema.result` references the canonical `StoryResult` enum (single source of truth for the verdict vocabulary).
3. Absorb the known drift: `StoryReportSchema` gains the optional `verification_ran` field substrate already sends (additive; pre-existing reports still validate).
4. Package builds + existing agent-mesh tests green; the contract is importable from an external package (smoke: a tiny consumer imports `StoryResult`).

---

## Story 79-2: substrate imports the contract package [substrate]

**Priority**: must · **Dispatch eligibility**: dispatchable. **Depends on**: 79-1.

**Description**: In `src/modules/telemetry/mesh-reporter.ts`, delete the inline
`RunReport`/`StoryReport` interface re-declaration and import the types from
`@jplanow/agent-mesh/contracts`. `buildRunReport()`/`buildRunReportFromManifest()` build
against the imported types so the wire contract is single-sourced and cannot drift.

**Acceptance Criteria:**
1. mesh-reporter.ts imports `RunReport`/`StoryReport` (+ `StoryResult`) from `@jplanow/agent-mesh/contracts`; the inline interface declarations are removed.
2. The pushed RunReport shape is byte-compatible with before (no field renamed/dropped); `verification_ran` continues to be sent and now type-checks against the schema (79-1 AC3).
3. `npm run typecheck:gate` + build + full suite green; the mesh-reporter tests assert the report validates against the imported schema.

---

## Story 79-3: Canonical `result` on `per_story_state`; retire translation maps [substrate]

**Priority**: must · **Dispatch eligibility**: dispatchable. **Depends on**: 79-1, 79-2.

**Description**: The per-story verdict is encoded ≥4 ways and substrate carries two
translation maps (`RESULT_MAP`/`MANIFEST_RESULT_MAP`) to reconcile `story_metrics.result`
↔ `per_story_state.status` ↔ mesh `RunReport.result`. Add a forward-only canonical
`result: StoryResult` field to `PerStoryStateSchema`, populate it where the verdict is
known (code-review outcome / escalation), and have the mesh-reporter + outcomes-census
read the canonical field directly. Keep the translation maps ONLY as a fallback for
pre-migration manifests; mark them deprecated.

**Acceptance Criteria:**
1. `PerStoryStateSchema` gains optional `result: StoryResult` (additive, forward-only; absent on pre-migration manifests). Schema round-trip test.
2. The orchestrator persists `result` at verdict time (review SHIP_IT/LGTM/NEEDS_*, or ESCALATED/FAILED) via `patchStoryState`, alongside the existing `status`.
3. mesh-reporter prefers `per_story_state.result` when present; falls back to `MANIFEST_RESULT_MAP` only when absent. Same for the outcomes-corpus census (`story_metrics.result` stays the Dolt source; reconcile to the canonical enum).
4. Translation maps annotated `@deprecated — fallback for pre-79-3 manifests`. Full suite green; no change to externally observed report values for already-canonical runs.

---

## Story 79-4: strata imports the contract package [strata]

**Priority**: should · **Dispatch eligibility**: dispatchable (strata repo). **Depends on**: 79-1.

**Description**: strata's `mesh-signal-collector.ts` / `source-signal.ts` handle substrate
run-report results with their own local notion of the verdict. Import
`@jplanow/agent-mesh/contracts` so strata's result handling uses the canonical
`StoryResult` enum — one vocabulary across all three planes.

**Acceptance Criteria:**
1. strata depends on `@jplanow/agent-mesh` and imports `StoryResult` (+ RunReport types) for source-signal/result handling.
2. Any local result-string literals/maps in strata's mesh-signal path are replaced by the canonical enum. strata build + tests green.

---

## Story 79-5: `ObservationSchema` into the contracts package [agent-mesh]

**Priority**: must · **Dispatch eligibility**: dispatchable. **Depends on**: 79-1.

**Description**: Add the locked CPO `Observation` schema (design §5.1) to
`@jplanow/agent-mesh/contracts`: identity (`id` ULID, `dedup_key` `{project}:{category}:{slug}`),
routing (`observer_agent_id`, `target_project`, `target_agent_id?`), temporal, content
(`category`, `severity`, `title`, `body`, `repro_steps?`, `expected_vs_observed?`,
`suggested_fix?`), evidence (`artifacts[]`), lifecycle (`status`, append-only
`status_history[]` incl. `resolution_commit_sha?`), `comments[]`, `duplicates_of?`,
`related_ids?`, revise grace fields.

**Acceptance Criteria:**
1. `ObservationSchema` (Zod) + inferred type exported from `@jplanow/agent-mesh/contracts`, matching design §5.1 field-for-field.
2. `dedup_key` validated against the `{project}:{category}:{slug}` pattern; `status`/`category`/`severity` are enums; `status_history`/`comments` are append-only arrays.
3. Schema round-trip test against a real existing entry from `_observations-pending-cpo.md` (e.g. obs_032) — proves migration fidelity (79-7).

---

## Story 79-6: CPO store + skills [agent-mesh]

**Priority**: must · **Dispatch eligibility**: dispatchable. **Depends on**: 79-5. **Size**: Large — consider decomposition (store; submit+dedup; list/update/comment/link).

**Description**: Implement the CPO primitive (design §6): an `IObservationStore`
(file-backed v1 per D2, interface shaped for a clean Dolt migration — mirror the existing
`FileTaskStore`/`ITelemetryStore` split) and the five A2A skills: `observation.submit`
(grace-window revise + strict `dedup_key` dedup + advisory similarity), `observation.list`
(filter by target_project/status/category/since), `observation.update-status`,
`observation.add-comment`, `observation.link`. `observer_agent_id` is server-stamped
(unforgeable).

**Acceptance Criteria:**
1. `IObservationStore` + a file-backed impl (atomic write, in-memory cache hydrate), interface designed so a Dolt impl is a drop-in later (no query logic baked into the file impl's callers).
2. Five skills registered in `src/skills/builtin/index.ts`, each Zod-validated against `ObservationSchema`-derived request/response schemas.
3. `observation.submit`: enforces `dedup_key` uniqueness (returns the existing record on collision), stamps `observer_agent_id` server-side, supports the revise grace-window. `observation.update-status` appends to `status_history` (never mutates in place).
4. Unit/integration tests for submit-dedup, status-history append-only, list filters, and the grace-window revise. agent-mesh suite green.

---

## Story 79-7: Migrate `_observations-pending-cpo.md` into CPO [agent-mesh]

**Priority**: must · **Dispatch eligibility**: dispatchable. **Depends on**: 79-6.

**Description**: One-time migration importing the existing markdown observation entries
(currently 32, in strata's `_observations-pending-cpo.md`, plus any consumer-repo
equivalents) into the CPO store via `observation.submit`/`update-status`, preserving
`dedup_key`, full `status_history`, attribution, and resolution detail **verbatim**
(design §10.2). Idempotent (re-runnable; dedup_key prevents duplicates).

**Acceptance Criteria:**
1. A migration script parses the markdown entries (id, dedup_key, kind→category, severity, status, status_history rows, body) and submits them to CPO.
2. `dedup_key`, `status_history` (all rows, timestamps, notes), and attribution are preserved verbatim; resolved obs land with their resolution history intact.
3. Idempotent: a second run makes no changes (dedup_key collisions are no-ops). Spot-check obs_001 (oldest), obs_019 (the version-skew canon), and obs_032 (newest) round-trip faithfully.
4. The markdown file is retained read-only as an archive until cutover is confirmed (don't delete in this story).

---

## Story 79-8: substrate submits observations via CPO [substrate]

**Priority**: should · **Dispatch eligibility**: dispatchable. **Depends on**: 79-6.

**Description**: Where substrate currently expects observations to be hand-written into
`_observations-pending-cpo.md`, add a path to submit them via the CPO `observation.submit`
skill (using the agent-mesh client), outbox-buffered like RunReports. Keep the markdown
flow as a documented fallback until strata-side consumption (79-9) is confirmed.

**Acceptance Criteria:**
1. A substrate helper submits a substrate-targeted observation (category/severity/title/body/dedup_key/artifacts) via CPO, outbox-buffered on mesh-offline.
2. Best-effort + non-fatal (mirrors mesh-reporter): a submit failure never blocks the pipeline; queues to outbox.
3. Documented in CLAUDE.md "Cross-Project Observation Lifecycle" as the new primary path; markdown noted as deprecated-fallback. Tests for the submit + outbox path.

---

## Story 79-9: strata consumes observations via CPO [strata]

**Priority**: should · **Dispatch eligibility**: dispatchable (strata repo). **Depends on**: 79-6.

**Description**: Wire strata's operator plane to CPO (design §11): morning-briefing
aggregation of open observations by target_project/severity, and Jarvis
`observe`/`observations`/`observation <id>` skills, replacing reads of the markdown file.

**Acceptance Criteria:**
1. strata queries `observation.list` (by target_project/status) and surfaces open substrate-targeted observations in the morning briefing.
2. Jarvis `observe` (submit) + `observations`/`observation <id>` (list/detail) skills wired to CPO.
3. strata no longer needs to read `_observations-pending-cpo.md` for the briefing; mesh-offline degrades gracefully. strata tests green.

---

## Story 79-10: Document `monitor.db` rationale (preserve) [substrate]

**Priority**: could · **Dispatch eligibility**: dispatchable.

**Description**: D3 — preserve the separate SQLite `monitor.db` (it re-declares the Dolt
monitor tables' DDL) rather than collapse it, because the original rationale wasn't
reliably tracked. Investigate WHY it exists (likely the synchronous `SyncAdapter` access
path the routing auto-tuner needs, vs Dolt's async API), confirm it, and write that
rationale down so it's a known documented duplicate — turning a mystery into an informed
keep, and de-risking any future collapse.

**Acceptance Criteria:**
1. The reason `monitor.db` exists separately from the Dolt monitor tables is determined (trace the readers: `MonitorDatabaseImpl`, the auto-tuner, synchronous-access requirement) and documented in a code comment at the `MonitorDatabaseImpl` definition + a note in the design doc.
2. No code change to the store itself (preserve). The doc states the condition under which a future collapse would be safe.

---

## Story 79-11: Decide `kv-metrics.json`; document cost derivation [substrate]

**Priority**: could · **Dispatch eligibility**: dispatchable.

**Description**: Declare `cost_entries` (Dolt, per-LLM-call) the cost ground truth and
document every other cost number as a *named derived view* with its semantics
(`per_story_state.cost_usd`, manifest `cost_accumulation` = retry-only, `run_metrics`/
`story_metrics` rollups, mesh `RunReport`, `turn_analysis`, `kv-metrics.json`). Decide
`kv-metrics.json`'s fate: fold into Dolt telemetry, or keep as an explicitly-documented
fast-path. **No blind number-unification** — the numbers legitimately differ.

**Acceptance Criteria:**
1. A "cost data model" note (in the design doc or a `docs/` cost note) names each cost surface, its semantics, and which is ground truth vs derived.
2. A decision recorded for `kv-metrics.json` (fold vs keep-as-fast-path) with rationale; if folded, a forward-only migration; if kept, a doc comment marking it a documented derived fast-path.
3. No change to any cost *value* without an explicit, documented reason.

---

## Story 79-12: Unify transport onto agent-mesh `OutboxTransport` [substrate]

**Priority**: could · **Dispatch eligibility**: dispatchable. **Depends on**: 79-1 (shared client/contract).

**Description**: substrate has a hand-rolled `.substrate/outbox` store-and-forward in
mesh-reporter.ts that duplicates agent-mesh's `OutboxTransport`. Adopt the agent-mesh
client/`OutboxTransport` so there's one store-and-forward implementation; substrate's
RunReport push (and 79-8's observation submit) ride on it.

**Acceptance Criteria:**
1. substrate uses agent-mesh's client/`OutboxTransport` for mesh pushes; the bespoke `.substrate/outbox` drain logic is removed (or thinly delegates).
2. Offline behavior preserved (queue → drain on next success); existing outbox tests pass against the unified path; no lost-report regressions.

---

## Out of scope (this epic)
- Merging the planes' stores / moving substrate factory data into the mesh (the mesh stays a *derived* store).
- A single physical cost-ledger rewrite (Phase 3, only if cost reporting is shown wrong).
- The formal derived-tier rebuild guarantee (Phase 3).
- Promoting CPO to Dolt (D2 deferred; file-backed v1 ships first, schema is migration-ready).
