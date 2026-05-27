# Fleet Data Architecture — Consolidation Design

**Status:** DRAFT for review · **Date:** 2026-05-27 · **Author:** substrate session (bmad-party-mode panel: Architect/Analyst/PM/Master)
**Scope:** cross-repo — `substrate` (factory), `agent-mesh` (data plane), `strata` (operator plane)
**Goal:** one clean data architecture that addresses every need currently met by the run-telemetry, OTEL, eval/census, and cross-project-observation features — eliminating accidental duplication and schema drift, without collapsing the (correct) plane separation.

---

## 1. Why this review

Over time we accreted several data-gathering/passing mechanisms — agent-mesh telemetry push, substrate's own run manifests + Dolt, the OTEL pipeline, the eval/census corpora, and the (manual) cross-project observations log. They overlap. This doc maps them holistically, separates *intentional derivation* from *accidental duplication*, and proposes a single coherent target architecture with a phased plan.

**Verdict up front:** the three-plane model is sound and should be preserved. The problems are at the **seams** — duplicated/ drifting *schemas*, fragmented *vocabularies*, multiple physical copies of the same datum, and one major designed-but-unbuilt primitive (CPO). The fix is a canonical contract layer + clear ownership/derivation + finishing CPO + killing within-substrate physical dupes. **Not** one big database.

---

## 2. Current architecture — the three planes (real, documented)

| Plane | Repo | Role | Authoritative stores |
|---|---|---|---|
| **Factory** | `substrate` | code-gen pipeline: create-story → dev-story → review → merge | `.substrate/state/` Dolt (~30 tables) + run manifests (`.substrate/runs/*.json`, the *live* truth) |
| **Data** | `agent-mesh` | A2A transport, agent registry/heartbeat, telemetry store (**derived**), *planned* CPO observation store | file-backed JSON store (`FileTaskStore`); **no Dolt today** |
| **Operator** | `strata` | portfolio intelligence, canonical memory, vision oversight, briefings | Obsidian vault (narrative truth) + Dolt (structured truth) + mesh reads (derived) |

**Canonical-tier rule** (already written in strata's `agent-mesh-integration-proposal-2026-04-19.md`): **vault = narrative truth · Dolt = structured truth · mesh = derived/rebuildable.** Data fan-out across planes is *intended* when the downstream copy is derived and rebuildable. This principle is correct; we should make it explicit and enforce it.

**Live status:** substrate→mesh telemetry push is live (`mesh-reporter.ts` → `receive-run-report` skill); strata↔mesh is live (`strata-jarvis@workstation` registered, queries `query-reports`); strata is a real substrate **build target** (`strata/.substrate/` runs, worktrees, injected `AGENTS.md`). CPO is **design-only**.

---

## 3. Data surface inventory (substrate-centric, where the data originates)

| # | Surface | Storage | Producer | Consumers | Holds |
|---|---|---|---|---|---|
| 1 | **Run manifest** | `.substrate/runs/<id>.json` (atomic file, multi-tier read) | `RunManifest` (`packages/sdlc/src/run-model/`) | orchestrator (resume/recover), `report`, `reconcile-from-disk`, mesh-reporter fallback, census | live run + `per_story_state` (status, phase, cost_usd, verification_result, escalation_reason/detail, commit_sha, story_file[_input_path/_sha256], recovery_history, …) |
| 2 | **Dolt state** (~30 tables) | `.substrate/state/` | orchestrator, telemetry pipeline, cost tracker, monitor | report, metrics, census, mesh-reporter | work-graph (`wg_stories`…), metrics (`run_metrics`,`story_metrics`,`task_metrics`,`performance_aggregates`), cost (`cost_entries`,`session_cost_summary`), `decisions` (multipurpose KV inc. escalation-diagnosis), telemetry (`turn_analysis`,`efficiency_scores`), repo-map, sessions, pipeline_runs (Dolt mirror of #1) |
| 3 | **OTEL pipeline** | → Dolt telemetry tables (#2) | `IngestionServer` (OTLP 4318) → `TelemetryPipeline` | efficiency scoring, recommendations | per-turn spans → turn_analysis/efficiency_scores |
| 4 | **mesh RunReport** | agent-mesh file store (+ substrate `.substrate/outbox/`) | `mesh-reporter.ts` (post-run) | agent-mesh `query-reports`, strata briefings | **denormalized rollup built by joining #1+#2** (run_metrics+story_metrics+efficiency+decisions+manifest verification) |
| 5 | **Eval/census corpora** | `_bmad-output/eval-results/corpus/*.yaml` | `build-outcomes-corpus.mjs`, `build-reconstruction-corpus.mjs` | eval graders, `/ship` gate | outcomes (from Dolt `story_metrics.result`); reconstruction (git log × manifest `commit_sha`/`story_file_input_path`) |
| 6 | **Notifications** | `.substrate/notifications/*.json` (ephemeral) | `emitEscalation`/halt | `substrate report` (reads + **deletes**) | halt/escalation prompts (now partly superseded by `per_story_state.escalation_detail`, obs_032) |
| 7 | **Misc** | `kv-metrics.json`, `monitor.db` (SQLite), supervisor reports | routing accumulator, MonitorDatabase, supervisor | `metrics` CLI, auto-tuner | token/cost fast-path + **SQLite duplicate of Dolt monitor tables** |

**Strata-side** adds: FleetProject registry (`substrate_manifest_path`), `source_signals` in briefings (from local manifest read *and* mesh query — two paths for the same datum, justified as graceful degradation), strata's own LLM telemetry (`llm-telemetry.jsonl` — *different* activity, nominal overlap), and the `_observations-pending-cpo.md` staging file.

---

## 4. Overlap analysis — intentional vs accidental

### Intentional (keep — it's the derived-tier model working)
- **mesh RunReport is a derived read-model** of substrate's authoritative Dolt+manifest. The degraded-read (`buildRunReportFromManifest`) and Dolt-fallback paths prove the team already treats these as one truth with derived copies. *Keep* — but single-source the schema (below).
- **strata reading substrate via both local-manifest and mesh-query** — graceful degradation (mesh-offline → local). *Keep.*

### Accidental — the debt to fix
1. **Schema drift, substrate↔mesh.** substrate re-declares the `RunReport` TS interface inline in `mesh-reporter.ts` instead of importing `RunReportSchema` from `@jplanow/agent-mesh`; **already drifted** (`verification_ran`). → single canonical contract.
2. **Result-class vocabulary fragmentation.** Per-story verdict encoded ≥4 ways (`story_metrics.result`, `per_story_state.status`, `RunReport.stories[].result`, `execution_log.new_status`); substrate carries **two translation maps** (`RESULT_MAP`/`MANIFEST_RESULT_MAP`). → one canonical enum, stored once.
3. **Physical store duplication in substrate:** `monitor.db` (SQLite) re-declares the Dolt monitor tables' DDL; `kv-metrics.json` duplicates token/cost telemetry already in Dolt. → collapse or document-and-justify.
4. **Two outbox implementations:** substrate `.substrate/outbox` vs agent-mesh `OutboxTransport`. → reuse the data-plane transport.
5. **Cost semantics tangle:** cost in 5+ stores with *different meanings* (`cost_entries` per-call; manifest `cost_accumulation` retry-only; `run_metrics`/`story_metrics` rollups; mesh; `turn_analysis`; `kv-metrics`). → declare ground truth + documented derived views (do **not** blindly unify the numbers).

### The missing primitive
6. **CPO (cross-project observations) is designed-but-unbuilt.** Locked design (agent-mesh `cross-project-observations-design.md`, Epic 6, `Observation` schema §5.1) — but **no skill, no store, no Dolt** exist. The `_observations-pending-cpo.md` files (+ a human relaying them) are the manual stand-in. This is the single biggest "need not yet met," and it is actively costly (this very session hand-edited that markdown repeatedly).

---

## 5. Target architecture — the clean solution

**Principles (the north star):**
1. **Planes stay separate.** Factory/Data/Operator each own their stores. No merge into one DB.
2. **One canonical contract for cross-plane data.** Schemas + vocabularies (RunReport/StoryReport, the result-class enum, Observation) are single-sourced and imported, never re-declared.
3. **One producer per datum; everything else is a *named, documented* derived view.** A reader must be able to tell truth from derived copy.
4. **Build the missing data-plane primitive (CPO)** so observations flow through the mesh, not through markdown + humans.
5. **Reuse the data-plane's transport/client** — don't re-implement store-and-forward.

**The four consolidations:**

**C1 — Canonical contract package** *(highest leverage, lowest risk)*
Extract the cross-plane wire contracts into one Zod package that all three repos import: `RunReport`/`StoryReport`, **one** result-class enum, and (with C2) the `Observation` schema. substrate stops re-declaring `RunReport` and deletes `RESULT_MAP`/`MANIFEST_RESULT_MAP` by persisting the canonical result once on `per_story_state`. *Open decision D1: where the package lives (recommend: agent-mesh owns it as the data plane, exported as `@jplanow/agent-mesh/contracts`).*

**C2 — Build CPO** *(the big capability)*
Implement the locked design in agent-mesh: `Observation` schema + store + skills (`observation.submit`/`list`/`update-status`/`add-comment`/`link`). Migrate the `_observations-pending-cpo.md` files onto it; wire substrate (file observations) and strata (consume/aggregate) to the skills. Ends the human-as-message-bus. *Open decision D2: CPO storage backend — file-backed v1 (consistent with current mesh telemetry) vs stand up Dolt in agent-mesh now (the design assumes a Dolt that doesn't exist).*

**C3 — Document within-substrate dupes + cost derivation** *(D3: preserve, don't collapse)*
`monitor.db` is **preserved** (D3) — investigate and *write down* why the separate SQLite store exists (likely the SyncAdapter synchronous-access path) so it's a known, documented duplicate rather than a mystery; defer any collapse to a future informed decision. Decide `kv-metrics.json` (fold into Dolt telemetry, or keep as a documented fast-path). Declare `cost_entries` the per-call ground truth and document every other cost number as a named derived view with its semantics (retry-only, rollup, etc.). *No blind number-unification, no blind store-collapse.*

**C4 — Unify transport**
substrate's hand-rolled `.substrate/outbox` adopts agent-mesh's `OutboxTransport`/client SDK; one store-and-forward implementation.

**Explicitly NOT doing:** merging the planes' stores; a single physical cost ledger rewrite; moving substrate's factory data into the mesh. The mesh stays a *derived* store.

---

## 6. Phased plan

- **Phase 0 — C1 (contract package).** Extract shared schemas + canonical result enum; substrate imports them; delete the two translation maps; persist canonical result on `per_story_state`. Drift-proofs the contracts we keep evolving. *Low risk, immediate.*
- **Phase 1 — C2 (CPO).** Observation schema into the contract package; agent-mesh skills + store; migrate the markdown obs files; wire substrate + strata. *The capability that ends current toil.* (Depends on Phase 0 for the shared Observation schema + D2 decision.)
- **Phase 2 — C3 + C4 (document + transport).** Document `monitor.db`'s rationale (preserve, per D3); decide/fold `kv-metrics`; document cost derivation; unify the outbox onto agent-mesh's `OutboxTransport`. *Debt cleanup, rides along.*
- **Phase 3 — (optional, deferred).** Formalize the derived-tier rebuild guarantee (mesh rebuildable from substrate Dolt + git); revisit cost only if reporting is actually wrong.

---

## 7. Decisions (resolved 2026-05-27 by operator) + risks

- **D1 — Contract package home → RESOLVED: agent-mesh owns it** (`@jplanow/agent-mesh/contracts`). The data plane is the wire-contract authority; substrate already depends on the package, so the coupling exists. substrate + strata import it; none re-declare.
- **D2 — CPO storage → RESOLVED: file-backed v1**, schema designed for a clean Dolt migration. Ships fast, consistent with today's mesh telemetry store; promote to Dolt-in-agent-mesh later if dedup/similarity/lifecycle queries demand it.
- **D3 — `monitor.db` → RESOLVED: PRESERVE.** Operator call: the rationale for the separate SQLite store was not reliably tracked, so we do **not** collapse it into Dolt (don't break what we don't understand). C3's monitor.db action changes from "collapse" to **"investigate + write down *why* it exists"** (likely the SyncAdapter synchronous-access path for the routing auto-tuner) so a future collapse is an informed decision, not a guess. It stays a known, documented duplicate for now.
- **D4 — Result-enum canonicalization → RESOLVED: proceed, forward-only.** Picking one enum touches `story_metrics`, the manifest, and the mesh schema simultaneously — do it as an additive/forward-only migration mirroring how `commit_sha`/`escalation_detail` were added (persist the canonical result alongside, retire the translation maps once readers migrate).

**Risks (unchanged):**
- **Version coupling.** A shared contract package couples release cadences across three repos; mitigate with additive/forward-only schema evolution (the discipline already used for `per_story_state` fields).
- **CPO migration.** The markdown obs files are load-bearing (drive substrate priorities); migration must preserve `dedup_key`, `status_history`, and attribution verbatim (design §10.2 requires this).
- **Risk — version coupling.** A shared contract package couples release cadences across three repos; mitigate with additive/forward-only schema evolution (the discipline already used for `per_story_state` fields).
- **Risk — CPO migration.** The markdown obs files are load-bearing (drive substrate priorities); migration must preserve `dedup_key`, `status_history`, and attribution verbatim (the design §10.2 already requires this).

---

## 8. Appendix — key paths
- substrate: `packages/sdlc/src/run-model/` (manifest schema), `packages/core/src/persistence/*schema*.ts` (Dolt), `src/modules/telemetry/mesh-reporter.ts` (RunReport + outbox), `packages/core/src/telemetry/` (OTEL), `scripts/build-{outcomes,reconstruction}-corpus.mjs` (census).
- agent-mesh: `src/schemas/run-report.ts` (`RunReportSchema`), `src/skills/builtin/{receive-run-report,query-reports}.ts`, `_bmad-output/planning-artifacts/cross-project-observations-design.md` (CPO, Epic 6).
- strata: `_bmad-output/planning-artifacts/agent-mesh-integration-proposal-2026-04-19.md` (three-plane + canonical tiers), `packages/core/src/briefing/mesh-signal-collector.ts`, `packages/core/src/discover/output-streams.ts`, `_observations-pending-cpo.md`.
