# Registry Provenance Program — LEDGER

Single source of truth for program state. Read first every session; update with every ship (ledger edits commit with the code).

**Design brief:** `_planning/2026-07-09-registry-provenance-design-brief.md`
**Work breakdown:** `_planning/registry-provenance/execution-plan.md`
**Parent program (machinery this extends):** `_planning/acceptance-gate/` (DONE, v0.21.2–v0.21.12)
**Baseline:** HEAD `c8cd644`, v0.21.12, suite 583 files / 11,436 tests, matrix 23/23, eval 100%.

## Story board

| Row | Story | Ship | Status | Version | Evidence / notes |
|---|---|---|---|---|---|
| RP0.1 | Provenance block on registry schema (additive; compat-pinned) | 1 | done | v0.21.13 | `RegistryProvenanceSchema` in `registry.ts` (+types, index export). 6 new tests in `registry.test.ts` incl. the COMPAT PIN ("a pre-provenance registry still parses, provenance undefined"), sha256 format rejection, reasonless-exclusion rejection ("unauditable"), missing-field pathing |
| RP0.2 | `validate` provenance surfacing + `provenance-absent` advisory | 1 | done | v0.21.13 | Live bundled-dist evidence (node dist/cli.mjs): provenance-bearing fixture → `provenance: OK — derived from docs/prd.md (sha256 21cbcb7aa812…), ratified by operator …, 1 excluded`; retrofit reference registry → `provenance: ABSENT (advisory)` line; JSON → `data.provenance.status: present`. Suite 583/11,442, matrix 23/23, eval 100%, circular+typecheck green |
| RP1.1 | `substrate acceptance derive` (agent workflow + prompt + candidate; gate ignores candidates) | 2 | done | v0.21.14 | `candidate.ts` (schema: candidate:true marker mandatory, empty end_states legal = needs-elaboration, zero journeys rejected); `runAcceptanceDerive` + `acceptance-derive.md` prompt (data-not-instructions; no exclude capability at derive time) + manifest reg + 200k token ceiling; CLI `derive --prd` (containment check, --force refusal). Tests: 6 candidate-schema + **GATE-IGNORES pin (candidate alone → both loaders absent)** + 10 workflow tests (PRD-IS-DATA prompt pin, retry-once, empty-success rejected, refused surfaces). **LIVE real-agent derive on fixture PRD: 2 journeys (1 critical w/ document-cited rationale), 4 artifact-grounded end-states, cli+file surfaces inferred; live --force refusal; live validate-with-candidate-only → NO REGISTRY.** Suite 585/11,461, matrix 23/23, eval 100% |
| RP1.2 | `substrate acceptance ratify` (human-only; provenance written; candidate deleted; version bump) | 3 | todo | | |
| RP1.3 | Diff-view re-derivation (`diffRegistries` + delta output) | 3 | todo | | |
| RP2.1 | Staleness detection (`registry-stale` / `registry-source-missing`; path containment; matrix cell) | 4 | todo | | |
| RP3.1 | Deterministic completeness pre-pass (set arithmetic, no agent) | 5 | todo | | |
| RP3.2 | Completeness checker agent + `validate --against-prd` (span-cited, advisory) | 5 | todo | | |
| RP3.3 | Corpus precision: 0-noise floor + planted-omission counterexample + regression harness | 5 | todo | | |
| RP4.1 | Structured `user_journeys` emission (ux-step-3 schema upgrade, prose fallback) | 6 | todo | | |
| RP4.2 | Solutioning-close derive hook (candidate only — NEVER auto-ratify) + pre-pass wiring | 6 | todo | | |
| RP5.1 | Red-team (10-item evasion catalog minimum, separate lineage) | 7 | todo | | |
| RP5.2 | Adversarial e2e evader agent + injection matrix cells | 7 | todo | | |
| RP5.3 | Operator-run `/code-review ultra` on the arc; findings triaged | — | todo | | Operator action — ASK, never launch or fabricate |
| RP6 | FINAL GATE: 5-leg counterexample-first DoD (derive retro-fit unhinted 5/5, planted omission, planted staleness, 0-noise floor, live pipeline run) | — | todo | | |

## Cardinal rules (program-level; violations = story not done)
1. **NEVER AUTO-RATIFY** — no code path writes `journeys.yaml` from a candidate without explicit operator action.
2. **PRD is untrusted input** — data-not-instructions posture in derive/checker prompts; injection cells mandatory.
3. **All new escalations advisory** for the entire program (`provenance-absent`, `registry-stale`, `journey-undispositioned`, `candidate-unratified`).
4. **Evidence rule** — derive/ratify/checker/staleness stories need a matrix cell or live corpus run, not just unit tests.
5. **Retro-fit integrity** — iterating derive/checker prompts to hit targets is legal; editing the PRD/registry corpus to dodge findings is training-on-the-test and is not.

## Dependency notes
- Ship order 1→7 default. RP4 may land any time after Ship 3 (RP1); RP6 needs RP4.2's live run.
- RP5.1/RP5.2 run after Ship 6; RP5.3 after RP5 remediation lands. None skippable; all gate RP6.
- `[dogfood-eligible]`: none until Ship 3 verified; then single-story dispatch only, `--max-review-cycles 3`.

## Blockers
(none)

## Next session start here
Ship 2 (v0.21.14) landed — RP1.1 done (derive + candidate + gate-ignores pin). Start at RP1.2 + RP1.3 (Ship 3): `substrate acceptance ratify` (human-only promotion; provenance written with source hash computed at ratify time; candidate deleted; version bump on replace; `--exclude <id> --reason`; critical-needs-epic enforced at ratify) + `diffRegistries` delta view in `provenance.ts` for re-derivation.

## Decisions log
- 2026-07-09: Program created. Operator-ratified sequencing RP → GC.1 → A5.4 (recorded in acceptance-gate LEDGER). `acceptance.mode` default stays advisory (operator, 2026-07-09). Executor = Claude session direct implementation, same rationale as the gate program.

## Session log
- 2026-07-09 (session 1, cont.): Ship 2 (v0.21.14) — RP1.1. Derive workflow + prompt + candidate schema + CLI. Live real-agent derivation on a fixture PRD produced a high-quality candidate (document-cited criticality rationale, grounded end-states, correct surface inference). Prompt-edit empirical validation satisfied by the live dispatch itself (real agent, new prompt, schema-forced output honored).
- 2026-07-09 (session 1): Ship 1 (v0.21.13) — RP0.1 + RP0.2. Provenance block schema (additive/optional; compat-pinned so pre-provenance registries stay valid), reasonless exclusions rejected at schema level, `validate` echoes provenance when present and emits the `provenance-absent` advisory when not (human + JSON). Live dist smoke on both paths. All gates green.
