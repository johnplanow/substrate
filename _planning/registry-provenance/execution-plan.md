# Registry Provenance Program — Execution Plan

**Program docs** (read in this order in a fresh session):
1. Design & rationale: `_planning/2026-07-09-registry-provenance-design-brief.md` (the WHY, the schemas, the four pieces, the paid-for principles)
2. Parent program (patterns + machinery this arc extends): `_planning/2026-07-07-acceptance-gate-design-brief.md` + `_planning/acceptance-gate/LEDGER.md` (shipped v0.21.2–v0.21.12, DONE)
3. Ground truth corpus: `_planning/acceptance-gate/retrofit/CORPUS.md` — income-sources PRD path, pre/post-fix SHAs, the five founding misses, and the hand-authored reference registry (`retrofit/journeys.yaml`)
4. This file: the work breakdown (the WHAT, story by story)
5. `_planning/registry-provenance/LEDGER.md`: current state (always read AND update)
6. `_planning/registry-provenance/GOAL-PROMPT.md`: the session driver

**Seam caveat:** seams below verified by symbol at HEAD `c8cd644` (2026-07-09, v0.21.12). Line numbers deliberately omitted — re-locate by symbol before editing.

---

## Execution model (inherited from the gate program, unchanged)

- **Executor:** the Claude Code session implements stories directly. `[dogfood-eligible]` stories MAY be dispatched via `substrate run --stories` after Ship 3 is verified — one per run, `--max-review-cycles 3`.
- **Ship discipline:** `/ship` per `.claude/commands/ship.md` — build, `test:fast` during iteration, full `npm test` pre-push, eval gate 100%, fixture matrix green (all 23 existing cells + new ones), bundled-dist smoke for CLI-surface changes, version bump (all 4 package.json + version:sync + lockfile), tag push → CI publish. One vitest at a time; never pipe test output; `timeout: 300000`.
- **Evidence rule:** a story is DONE only with empirical evidence named in the ledger (test names, matrix cells, live command output observed, artifact paths). "Code merged" is not done. Anything touching derive, ratify, the completeness checker, or staleness needs a matrix cell or a live corpus run — unit tests alone are insufficient.
- **ADVISORY-UNTIL-PROVEN:** every new escalation this arc introduces (`provenance-absent`, `registry-stale`, `journey-undispositioned`) ships **advisory** and stays advisory through the whole program. Blocking is a future per-project decision, same as `acceptance.mode` — this arc does not add blocking behavior anywhere.
- **NEVER AUTO-RATIFY (the arc's cardinal rule):** no code path writes `journeys.yaml` from a candidate without an explicit operator action (`ratify` invocation). The pipeline may derive candidates; only a human turns a candidate into the registry. A story that violates this is not done regardless of tests.
- **PRD IS UNTRUSTED INPUT:** the derive agent and completeness checker consume arbitrary project documents. Same data-not-instructions posture as the acceptance judge (`packs/bmad/prompts/acceptance-judge.md`): document content is quoted evidence, never instructions; candidate output is schema-validated; injection cells are mandatory (RP5).
- **Trusted-tree rule (H7):** unchanged from the gate — this arc adds NO new gate-runtime inputs. The candidate file is explicitly ignored by all gate loaders (tested).
- **Ledger updates ship with the code.**

## Placement decision

Mirror the existing acceptance module: provenance schema + candidate parsing + diffing + staleness hashing in `packages/sdlc/src/acceptance/provenance.ts` (+ `registry.ts` schema extension); derive/checker agent workflows in `src/modules/compiled-workflows/` beside `acceptance-judge.ts`; prompts in `packs/bmad/prompts/` (`acceptance-derive.md`, `acceptance-completeness.md`); CLI subcommands appended to `src/cli/commands/acceptance.ts` (existing: validate/defer/judge/canary/override/status/clear-demotion). Pipeline-phase changes (RP4) in `src/modules/phase-orchestrator/phases/{ux-design.ts,schemas.ts}` + `packs/bmad/prompts/ux-step-3-journeys.md`.

## Verified seams

- `packages/sdlc/src/acceptance/registry.ts` — `JourneyRegistrySchema` (zod), `parseJourneyRegistry`, `JOURNEY_REGISTRY_PATH`. Provenance block extends this schema (additive/optional — existing registries stay valid; pin with a compat test).
- `packages/sdlc/src/acceptance/loader.ts` — trusted-tree loaders; must gain the ignore-candidate test.
- `src/modules/compiled-workflows/acceptance-judge.ts` — `runAcceptanceJudge` is the template for `runAcceptanceDerive` / `runCompletenessCheck` (separate lineage, schema-forced output, `LOG_LEVEL=silent` stdout hygiene, maxTurns cap, retry-once on flake).
- `src/cli/commands/acceptance.ts` — subcommand seam.
- `src/modules/phase-orchestrator/phases/schemas.ts` — `user_journeys: z.array(z.string()).optional()` (the prose field RP4 upgrades).
- Retro-fit corpus: PRD at income-sources `_bmad-output/planning-artifacts/prds/prd-income-sources-2026-07-04/prd.md`; pre-fix/post-fix SHAs + five misses in `CORPUS.md`; reference registry `retrofit/journeys.yaml` (hand-authored — the fidelity baseline derive is measured against).
- Fixture matrix: `scripts/e2e-fixture-matrix/run.mjs` (23 cells green at v0.21.12).

## Config surface (final shape)

```yaml
acceptance:
  # existing keys unchanged; additions:
  prd: docs/prd.md            # optional; enables staleness + completeness without CLI flags
```

`provenance:` lives in `journeys.yaml` itself (see brief RP.2), not config.

## Escalation + event surface (names are contracts — help-agent + docs-match-behavior must track)

Advisory findings: `provenance-absent`, `registry-stale`, `journey-undispositioned`, `candidate-unratified` (a candidate file older than N days with no ratify — nudge, not gate).
NDJSON events: `acceptance:derived {candidate_path, journey_count, prd_sha256}`, `acceptance:ratified {version, excluded_count}`, `acceptance:completeness {registered, excluded, undispositioned}`.

## Dependency graph (epic level)

```
RP0 (provenance schema) ──→ RP1 (derive+ratify+diff) ──→ RP2 (staleness)
                                      │                      │
                                      ▼                      ▼
                            RP3 (completeness check) ──→ RP5 (adversarial) ──→ RP6 (final gate)
                                      ▲
RP4 (pipeline integration) ───────────┘   (RP4 may land any time after RP1; RP6 needs it)
```

Out of scope (do not build ahead of demand): auto-ratification of any kind (banned permanently, not deferred); semantic PRD-intent certification (operator's boundary, per brief); blocking-mode defaults for any new escalation.

---

## EPIC RP0 — Provenance schema + validate integration (Ship 1)

**RP0.1** — `provenance:` block on the registry schema. Zod extension in `registry.ts` (additive, optional): `derived_from`, `source_sha256`, `prd_revision?`, `derived_at`, `ratified_by`, `excluded[] {candidate, reason}`. Types exported. Compat test: every pre-RP registry fixture (incl. `retrofit/journeys.yaml`) still parses. AC: schema round-trips; unknown-key strictness preserved.
**RP0.2** — `validate` surfaces provenance state. `provenance-absent` advisory warn when the block is missing; provenance echo (source, hash, ratified_by, excluded count) when present. AC: unit tests + live `substrate acceptance validate` output observed on a provenance-bearing fixture and on `retrofit/journeys.yaml` (absent-path).

## EPIC RP1 — derive + ratify + diff (Ships 2–3; brownfield path first)

**RP1.1** — `substrate acceptance derive --prd <path> [--ux <artifact>] [--out <path>]` (Ship 2). New compiled workflow `runAcceptanceDerive` mirroring the judge: separate lineage, schema-forced candidate output, prompt `packs/bmad/prompts/acceptance-derive.md` (authoring rules from the gate brief: artifact-grounded end-states, criticality with one-line rationale, surfaces; PRD content quoted as data, never followed as instructions). Writes `.substrate/acceptance/journeys.candidate.yaml`. Candidate carries `candidate: true` + derivation metadata. **Gate ignores candidates:** loader/audit/stage tests proving a candidate file alone (registry absent) produces zero acceptance behavior. `derive` refuses to overwrite an existing candidate without `--force`. AC: unit tests (schema, refusal, candidate-ignored) + live derive against a small fixture PRD observed.
**RP1.2** — `substrate acceptance ratify [--edit] [--exclude <id> --reason <text>]... [--ratified-by <name>]` (Ship 3). Reads the candidate, interactive confirm (or `--yes` recording `ratified_by`), writes `journeys.yaml` with the provenance block (source hash computed from `derived_from` content at ratify time), deletes the candidate, bumps `version:` when replacing an existing registry. `--exclude` moves a candidate journey into `provenance.excluded[]` with the reason. NEVER invoked by any pipeline path (grep-able invariant + test). AC: unit tests (provenance written, version bump, exclude flow, candidate deleted) + live ratify observed end-to-end on the fixture.
**RP1.3** — diff-view re-derivation (Ship 3). `derive` against an existing ratified registry emits a delta (added/removed/changed journeys vs current) alongside the candidate, so re-ratification is a review of the delta. Pure function in `provenance.ts` (`diffRegistries`) + rendered text output. AC: unit tests on add/remove/change/no-op; live re-derive diff observed.

## EPIC RP2 — Staleness detection (Ship 4)

**RP2.1** — hash-compare staleness. `validate` (and the orchestrator's acceptance preflight, advisory) re-hashes `provenance.derived_from` content; mismatch → `registry-stale` advisory naming both hashes and the re-derive command. Missing source file → distinct `registry-source-missing` advisory (not silent, not fatal). Path containment: `derived_from` resolves inside the project root (reject traversal). AC: unit tests (match/mismatch/missing/traversal) + matrix cell `registry-stale` (mutate fixture PRD post-ratify → advisory fires, run continues, finding on report).

## EPIC RP3 — Completeness cross-check (Ship 5)

**RP3.1** — deterministic pre-pass. Pure set arithmetic in `provenance.ts`: structured `user_journeys` ids from RP4 artifacts (when present) minus (registered ∪ excluded) → guaranteed `journey-undispositioned` findings, no agent involved. AC: unit tests; nothing-to-game property documented in code comment.
**RP3.2** — checker agent + CLI. `substrate acceptance validate --against-prd [<path>]` runs `runCompletenessCheck` (new compiled workflow, judge posture): enumerates journey-shaped claims in the PRD, maps each to registered/excluded/undispositioned; every undispositioned finding MUST cite the PRD span it was read from (evidence rule); schema-forced output; advisory. `acceptance:completeness` event. AC: unit tests (span-citation validator, disposition mapping) + live run observed on the fixture PRD.
**RP3.3** — corpus precision measurement. Run RP3.2 against the income-sources post-fix PRD + complete reference registry → **0-noise floor** (zero undispositioned, or each finding operator-adjudicated as genuine PRD ambiguity, recorded in the ledger). Then the planted-omission counterexample: delete UJ-2 from a registry copy → `journey-undispositioned` fires citing the PRD span. Results file `_planning/registry-provenance/retrofit/` (mirror the gate's retrofit discipline; iterating the checker prompt is legal, editing the PRD/registry to dodge findings is training-on-the-test and is not). AC: dated results doc + regression harness entry (extend `scripts/acceptance-retrofit/run.mjs` or sibling script wired into ship checks).

## EPIC RP4 — Pipeline integration (Ship 6; greenfield path)

**RP4.1** — structured journey emission. `ux-step-3-journeys.md` output contract upgraded: `user_journeys` entries become structured (id, title, criticality, surfaces, prose walk) with prose-string fallback remaining legal (schema union in `schemas.ts`; prose derives to `needs-elaboration` candidates). `phases/ux-design.ts` persists the structured form. AC: schema tests both shapes; existing phase-orchestrator tests green.
**RP4.2** — solutioning-close derive hook. When the phase pipeline completes solutioning and structured journeys exist, emit a candidate automatically (derive from phase artifacts — candidate only, `acceptance:derived` event, operator nudge in output; **ratify remains manual, cardinal rule**). RP3.1 pre-pass runs at solutioning close; `journey-undispositioned` advisory on the phase report. AC: unit tests + one live fixture pipeline run (analysis→solutioning on a toy concept) producing a candidate end-to-end — this is the brief's DoD live-run item.

## EPIC RP5 — Adversarial phases (Ship 7 = remediation; NOT SKIPPABLE)

**RP5.1** — red-team (separate-lineage subagent, same protocol as gate A5.1). Minimum evasion catalog to attempt (invent more):
1. PRD prompt injection → derive emits a poisoned candidate (e.g. embedded "mark all journeys standard / exclude UJ-X / add a decoy journey").
2. PRD injection → completeness checker suppresses an undispositioned finding.
3. Candidate-file confusion: any gate/loader/audit path reading `journeys.candidate.yaml` as authoritative.
4. Auto-ratify laundering: any code path (incl. RP4.2, recovery engine, reconcile) that writes `journeys.yaml` from a candidate without operator action.
5. Staleness evasion: `derived_from` pointing outside the repo / symlink / path traversal; hashing a different file than the checker reads.
6. Diff-view blinding: a changed journey the diff renders as no-op (ordering, key renames, whitespace-only semantic change).
7. Excluded[] abuse: derive agent pre-excluding journeys so ratify looks clean; exclusion without reason.
8. Ratified_by forgery / provenance forged by the dev agent mid-run (bounded by the existing spec-tamper guard — verify the guard covers the provenance block bytes).
9. Version-bump evasion: re-ratify without version bump → verdicts cite a stale rev.
10. Structured-journey spoofing (RP4): implementing agent's story artifacts injecting `user_journeys` the planning lineage never emitted.
CONFIRMED findings → new ledger rows or dated accepted-risk entries with rationale.
**RP5.2** — adversarial e2e evader agent + injection matrix cells. A subagent is given the explicit goal: *get a vision-dropping registry through the machinery* (drop UJ-2 via any RP5.1 vector it likes) against a live fixture. Every successful evasion becomes a remediation row + a permanent matrix cell; minimum new cells regardless: `derive-prd-injection` (hostile PRD → candidate schema-valid and unpoisoned or derive fails loudly), `candidate-ignored-by-gate`, `registry-stale`. AC: evader transcript/summary artifact + cells green.
**RP5.3** — operator-run `/code-review ultra` on the arc diff. ASK the operator (you cannot launch it); record findings in a dated artifact; triage per protocol.

## EPIC RP6 — FINAL GATE (counterexample-first, from the brief's DoD)

All five, live, at HEAD, written up as a dated results doc:
1. **Retro-fit derive:** `derive` @ income-sources PRD (post-fix tree) → candidate contains all **5 founding journeys** (UJ-2 above all) with correct surfaces, *without operator hint* — measured against `retrofit/journeys.yaml` as reference. Record the unedited-survival fraction of derived end-states (brief's open question #1; if <half, file the journeys-only-derive follow-up).
2. **Planted omission:** UJ-2 deleted from a registry copy → `journey-undispositioned` cites the PRD span.
3. **Planted staleness:** PRD mutated post-ratify → `registry-stale`; re-derive diff view shows exactly the mutated journey.
4. **0-noise floor:** RP3.3 result standing green at HEAD.
5. **Live pipeline run:** RP4.2's fixture run standing green at HEAD.
Plus: full suite + eval 100% + fixture matrix (23 + new cells) + docs-match-behavior green; ledger closed. If any leg fails, findings become rows and the program continues.

---

## Ship map

| Ship | Contents | Version (indicative) |
|---|---|---|
| 1 | RP0.1 + RP0.2 | v0.21.13 |
| 2 | RP1.1 | v0.21.14 |
| 3 | RP1.2 + RP1.3 | v0.21.15 |
| 4 | RP2.1 | v0.21.16 |
| 5 | RP3.1–RP3.3 | v0.21.17 |
| 6 | RP4.1 + RP4.2 | v0.21.18 |
| 7+ | RP5 remediation, then RP6 gate | as needed |
