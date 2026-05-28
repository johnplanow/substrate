# Changelog

> **Authoritative log going forward**: this file became unmaintained between v0.9.0 (March 2026) and v0.20.41 (April 2026). For the missing window, the version-stamped entries in `~/.claude/projects/-home-jplanow-code-jplanow-substrate/memory/MEMORY.md` and `git log --oneline` are the authoritative record. The headline arcs are backfilled below; per-version detail lives in the memory entries and commit messages.

## [0.20.131] — 2026-05-28 (fix: 8-bug dogfood batch from pv-core-harness — Codex enablement, run accounting, discovery, gitignore)

Eight independent fixes surfaced by one operator dogfood session against `pv-core-harness` on a Codex-only laptop, batched into one ship. The set is cross-cutting: dispatch routing, agent-write enablement, run-status accounting, post-failure recovery UX, init gitignore semantics, and epics discovery — all reachable from the same `substrate init` + `substrate run --stories 7-7` flow that produced the report.

- **Dispatch agent now derives from enabled providers when `--agent` is omitted.** `run.ts` previously fell through to a hard-coded `claude-code` default in ~10 sites, so a Codex-only project (config.yaml: codex enabled, claude/gemini disabled) silently tried to dispatch to a CLI it didn't have. New pure `resolveDefaultAgentId()` (config module, exported + unit-tested) picks the enabled provider (precedence claude > codex > gemini among enabled); zero enabled → clear actionable error. Explicit `--agent` still always wins. Plus `init`'s `routing-policy.yaml` writer now matches the user's selection via `deriveRoutingPolicy()` (drops disabled providers from every rule + the `default_provider`) instead of hard-cloning a claude-first default, and `buildProviderConfig` maps the prompt's `subscription_routing: disabled` answer to `enabled: false` so "disabled" actually disables.
- **Codex `exec` now runs in workspace-write mode with approval `never`** so the non-interactive agent can write files. The coding `buildCommand` previously passed no sandbox/approval flags, so `codex exec` defaulted to read-only + untrusted-approval; in exec there's no one to approve, and writes failed with `file change approval is not supported in exec mode` (→ a downstream `create-story-no-file` / `create-story-fraud-success`). Now: `codex exec --sandbox workspace-write --ask-for-approval never` (normal automation mode — *not* the `--dangerously-bypass-approvals-and-sandbox` flag some org policies forbid). Plus a new exported `detectCodexSandboxBlock()` recognizes the signature strings in dispatch output and surfaces an actionable explanation; the orchestrator appends it to `create-story-failed` and `create-story-fraud-success` escalations (the latter is Codex-aware) so the next operator sees the cause, not the symptom.
- **`substrate report` verdict honors `run_status`** instead of deriving purely from per-story counts. A failed run that never dispatched a story (e.g. blocked at worktree setup → `story_scope: []`) used to print "Verdict: ALL PASSED — 0 verified … of 0 total" because `0 || 0 ? NEEDS ATTENTION : ALL PASSED` is vacuously a pass. New `computeReportVerdict()` (exported + unit-tested) treats `run_status: failed` as NEEDS ATTENTION regardless of counts and reports `NO STORIES RUN` for a non-failed empty run; the human render also surfaces an explanatory line when a failed run had empty scope.
- **`--dry-run` finalizes its manifest** to `completed` before the early return, instead of leaving the `running` it set during setup. `substrate health` was then reading that orphan `running` manifest and (within its fresh-DB optimistic window) calling it HEALTHY — a dead run looking like a live one. The health heuristic itself is intentionally preserved (it's an AC3-tested tolerance for the brief race before an orchestrator writes its PID file); the spurious `running` is fixed at source.
- **Re-running a failed story now reclaims the stale worktree** when there's nothing to lose, instead of hard-erroring `Worktree at … is already registered`. Failed/escalated dispatches intentionally preserve the worktree for `reconcile-from-disk`, but for the common case (e.g. a Codex write-block that didn't write *or* commit anything) that block was pure friction. New exported `decideWorktreeReclaim()` predicate: safe iff no uncommitted changes in the worktree AND the branch has no commits beyond the base. Safe → `git worktree remove --force` + `git branch -D` + recreate. Unsafe (dirty or has commits) → preserve and surface the *reason* alongside the existing cleanup guidance, so forensic state is never silently discarded.
- **Init writes the git-effective `.substrate/*` + `!.substrate/config.yaml`** pattern (the same pattern the AGENTS.md/CLAUDE.md/GEMINI.md templates document), and *repairs* a pre-existing wholesale `.substrate/` dir-ignore — which would otherwise prevent the negation from re-including `config.yaml`. New pure `computeSubstrateGitignore()` (exported + unit-tested) handles all the cases: empty file, wholesale `.substrate/` → `.substrate/*`, degenerate negation-before-star ordering, legacy enumerated entries (left in place; harmless once the canonical pattern is appended). Single source of truth between init and the templates.
- **Story/epic discovery searches `docs/planning/` by default and accepts an `epics_path` config override.** Discovery (`findEpicsFile`, `findEpicFiles`, `findEpicFileForStory`) and create-story's `readEpicShardFromFile` were hard-coded to `_bmad-output/...`; projects whose canonical epics live elsewhere (e.g. `docs/planning/epics.md`, declared in AGENTS.md) resolved to empty scope. New `epic-paths.ts` (pure: `buildEpicsFileCandidates()` + `buildPlanningDirs()`; best-effort `resolveEpicsPathOverride()` reads `.substrate/config.yaml` directly) is the single source of truth — used by both discovery and create-story, so the override is honored without threading config through every call site. The default list now includes `docs/planning/`; the `epics_path` schema key is documented in `SubstrateConfigSchema` + partial.
- **`ingest-epic` error steers operators to the working path** when the doc is a richer per-story-headings format (e.g. BMAD-DTU style) rather than the BMAD Story-Map sprint format the parser was built for. The bare `No story map section found in document` left operators looking like ingest-epic was broken; the new message explains the required format AND, when the doc has `### Story N-M:` / `#### Story N.M:` headings, points to `substrate run --stories <key>` (which consumes those directly). The Story-Map requirement itself is unchanged — making the parser tolerate arbitrary epic formats is a separate, larger project.

Behavior changes worth flagging: `substrate run` with no `--agent` and zero enabled providers now errors (with guidance) instead of falling through to `claude-code`. A failed/empty-scope run now shows `NEEDS ATTENTION` in `substrate report` instead of `ALL PASSED`. Re-running a story whose worktree carries forensic state (uncommitted changes or commits beyond base) still errors — but the message names the specific reason. Full suite 546 files / 10771 tests passing; regression eval gate 100% (35/35).

## [0.20.130] — 2026-05-27 (fix: persist escalation forensics durably — obs_2026-05-27_032)

Escalations couldn't be root-caused post-hoc: the diagnostic output (build-failure text, review findings, the `issues[]`) was captured only in the ephemeral `.substrate/notifications/<run-id>.json` file — which `substrate report` **deletes after reading** — while `per_story_state` kept only the short `escalation_reason` string (and `verification_result` is `null` on the build-gate path). So once a report ran (the normal triage step), the only durable trace of *why* a story escalated was the verdict, not the evidence. Surfaced reviewing strata's Epic 5 Wave 2 dispatch: 5-4 (`dev-story-commit-failed`) and 5-6 (`build-verification-failed`) escalated un-diagnosably despite coherent, merged work — and it's the same gap that blocked diagnosing obs_028/029.

- **New `escalation_detail` field on `PerStoryStateSchema`** (optional, forward-only) — the durable escalation evidence, persisted in the **same central `emitEscalation` patch** as `escalation_reason`, so it covers *every* escalation path (build-failure, commit-failure, drift, retry-budget, …) and survives notification deletion + worktree teardown.
- Extracted+tested `summarizeEscalationIssues()` (orchestrator) renders the `issues[]` (strings or `{severity,file,description}` findings) into one capped (4000-char) detail string. 8 unit tests + a schema round-trip + extended the `emitEscalation`-wiring test to assert the detail is patched alongside the reason.
- Fix-directions #2 (populate `verification_result` on the build gate) and #3 (archive-not-delete notifications in `report`) deferred — the build output now lands in `escalation_detail` regardless, so the notification is no longer the only copy. Full suite 10722 passing; regression eval gate 100% (35/35). Filed: strata obs_2026-05-27_032.

## [0.20.129] — 2026-05-26 (test: obs_031 real-Dolt validation note — session-review hardening; supersedes the withdrawn 0.20.128)

A QA review of the session's work found the obs_031 (v0.20.125) "real-schema execution test" weaker than its changelog claimed: the **InMemory adapter does not validate column references** — it silently matches zero rows for the bad `... AND run_id=?` statement instead of throwing, so it would NOT have caught the column drift. The bug is Dolt-specific. **Validated the fix against REAL Dolt manually** (temp `dolt init` + the real `wg_stories` DDL): the shipped statement flips the row to `complete`; the pre-fix `run_id` statement errors with `column "run_id" could not be found in any table in scope` (the exact reported `DoltQueryError`).

- **0.20.128 was withdrawn** (tag exists, never published): it added an automated Dolt-gated test, but `DoltClient`'s node-spawn of `dolt` ENOENTs under the CI/test sandbox (PATH not inherited by the spawned child) — it failed CI on both ubuntu and macos, so Publish aborted (npm `latest` stayed 0.20.127). Lesson: a node-spawns-`dolt` integration test isn't viable in this sandbox; only a *direct-shell* `dolt` invocation resolves PATH.
- **0.20.129** keeps the deterministic CI guard that actually catches this regression — the **SQL-shape assertion** (`RECONCILE_WG_STORIES_UPDATE` must key on `story_key`, must not reference `run_id`), which would have caught the drift at author time — plus a documented real-Dolt validation note in the test file. Published-binary smoke (0.20.127) confirmed all session fixes are present in the bundled dist (fixed reconcile SQL, `python-env-not-provisioned`, obs_030 heading-level boundary). Test/docs-only; full suite 10713 passing, eval gate 100%.

## [0.20.127] — 2026-05-26 (fix: build-verification env-skips + zero-diff misroute diagnostic — obs_029 + obs_028)

Two fixes from the strata Epic 5 Wave 1 dogfood. Both close the loop on the four observations from that run.

- **obs_2026-05-26_029 — Python build-verification escalates on environment gaps.** A Python-package story (`packages/memory-mcp`) escalated `build-verification-failed` even though its code was correct (33 tests pass in a venv). Root cause (forensics on run `20457fd8`): the configured build (`pnpm run build`, which recurses into the Python package) failed on a Python *environment-provisioning* issue, and the wording didn't match substrate's narrow PEP-668 skip pattern, so it fell through to a story-escalating failure. `runBuildVerification` already skips on PEP 668; this **broadens the environmental-skip** to also recognize interpreter/pip-not-found (`python`/`python3`/`pip: command not found`, zsh's `command not found: python3`, `No module named pip`) and classify them `skipped` with reason `python-env-not-provisioned` — substrate's Node-centric build gate doesn't provision Python envs, so these are environmental, not correctness, signals. Guarded against masking real failures (a build error that merely *mentions* python still fails). +5 tests (incl. a backfilled PEP-668 skip test).
- **obs_2026-05-26_028 — dev-story cwd misroute surfaces as an opaque zero-diff.** When a dev-story's output lands in the MAIN checkout instead of its worktree, the worktree stays empty and the story escalates the generic `zero-diff-on-complete` — work that looks lost but is actually in the wrong tree (and invisible to reconcile-from-disk, which inspects the branch). New `detectWorkOutsideWorktree()` helper: on a zero-diff escalation in worktree mode, it probes the main checkout and, if it's dirty, **enriches the escalation** with the actionable cause (the misrouted files + where to find them) instead of the opaque verdict. Additive/best-effort — still escalates (the worktree genuinely has no changes); never blocks on the probe. +5 unit tests. *Version note:* this obs's original misroute was version-unverified (per the obs_019 protocol); the hard "assert cwd==worktree / fail-fast" direction was intentionally NOT taken (risk of false fail-fast on a possibly-already-resolved bug) — the non-destructive diagnostic surfaces it if it ever recurs.

Full suite 10713 passing; regression eval gate 100% (35/35). Filed: strata obs_2026-05-26_028, _029.

## [0.20.126] — 2026-05-26 (fix: create-story drift false-positive on last story in an epic — obs_2026-05-26_030)

The create-story source-AC drift detector persistently escalated strata story 5-7 (`create-story-source-ac-drift`) across 4 dispatch attempts, flagging `packages/memory-mcp` (another story's path) and `packages/vision-guardian` as "missing" — even though 5-7's render was correct. A hard blocker for multi-story epics with no operator escape. **Root cause (reproduced against the real stored shard):** `extractStorySection` ended a story's section only at the *next story heading*. 5-7 is the **last** story in the epic, so with no following story the section ran to EOF and absorbed the doc's trailing epic-level sections (`### Out of scope`, `## Dispatch Rules`) — whose paths then read as drift. (The obs's "ingest-epic doesn't refresh / sharding didn't help" symptom is explained by this: the stored per-story shard itself over-captured, and the gate used it as-is.)

- **`extractStorySection` end-boundary** now also stops at the next markdown heading whose level is **same-or-shallower** than the story heading (a sibling `### Out of scope` or parent `## …`). Deeper `####` subsections of the story are preserved (level > the story heading). Validated against the real strata 5-7 shard: narrows 6158 → 483 chars, false-positive paths drop to none.
- **Fidelity gate** (`orchestrator-impl.ts`): the per-story-shard path now applies the same `extractStorySection` narrowing the epic-shard fallback already used (idempotent on an already-narrowed shard; falls back to the raw value if the heading can't be located) — so even existing over-broad stored shards are scoped at drift-check time.
- 2 regression tests (last-story-bleed exclusion + `####`-subsection preservation). Full suite 10703 passing; regression eval gate 100% (35/35). The narrowing eliminates the false positive regardless of stale/over-broad stored shards; the obs's optional follow-ups (ingest-epic `--refresh`, an operator `--accept-drift` valve) are deferred as no longer load-bearing. Filed: strata obs_2026-05-26_030.

## [0.20.125] — 2026-05-26 (fix: reconcile-from-disk run_id SQL column — obs_2026-05-26_031)

`substrate reconcile-from-disk` — the documented Path-A recovery primitive — was **non-functional for every reconciliation**: its final Dolt write emitted `UPDATE wg_stories SET … WHERE story_key=? AND run_id=?`, but `wg_stories` has no `run_id` column, so the write threw `DoltQueryError` *after* the gates and discovery had done their expensive work, marking nothing complete. Operators were forced into manual `dolt sql`. Surfaced by the strata Epic 5 Wave 1 dogfood (obs_2026-05-26_031); combined with obs_028/030 it left the documented escalation→recovery loop with no working terminal step.

- **Fix:** key the reconcile UPDATE on `story_key` alone (the table's identity), matching the already-correct update at `story-discovery.ts`. Also sets `completed_at`. Extracted as `RECONCILE_WG_STORIES_UPDATE` (exported) so the test runs the exact statement.
- **Why it escaped CI:** the existing integration test *mocked* the adapter, capturing the SQL string but never executing it against a real schema. Two new guards (the obs's fix-direction #2): a SQL-shape regression assertion in the integration test (must key on `story_key`, must not reference `run_id`), and a real-schema execution test that runs `RECONCILE_WG_STORIES_UPDATE` against a `wg_stories` built by `initSchema` (InMemory adapter) — proving every referenced column exists, so a future column drift fails CI, not the operator. Full suite 10701 passing; regression eval gate 100% (35/35). Filed: strata obs_2026-05-26_031.

## [0.20.124] — 2026-05-26 (feat: persist the reconstruction phase-input — obs_2026-05-26_027)

Closes the gap dogfooding surfaced when the 77-6 census found the first real reconstruction pair anywhere (strata story 5-2): the pair was genuine but **un-reconstructable**, because the original phase input (the story file) wasn't recoverable — strata doesn't git-track story artifacts, and the run manifest recorded `commit_sha` but not the input. That undercut the cross-project corpus premise (consumer repos = the rich source), since most consumers won't commit their story files. Fix: substrate now persists the input durably itself. Forward-only, mirroring F-commitsha (v0.20.118).

- **Schema** (`per_story_state`): three new optional fields — `story_file` (original repo-relative path, provenance), `story_file_input_path` (location of a durable COPY, relative to `.substrate/runs/`), and `story_file_sha256` (for input-drift detection in grading).
- **Capture** (`orchestrator-impl.ts`, at the F-commitsha auto-commit site): extracted a tested `captureReconstructionInput()` helper that copies the story file the producing phase consumed to `.substrate/runs/inputs/<run-id>/<story-key>.md` and records the three fields — in the same single `patchStoryState` write as `commit_sha`, BEFORE the per-story worktree is torn down. Best-effort: a read/write failure logs and continues (commit_sha still recorded).
- **Census** (`build-reconstruction-corpus.mjs`): new `resolvePhaseInput()` prefers the manifest-captured sidecar (and carries its `input_path` + `sha256`) over recovering the file from git at the parent SHA; git recovery remains the fallback for pre-fix runs.
- **Harness** (`eval-reconstruction/harness.mjs`): reads the input from the manifest sidecar (absolute, live repo — survives worktree teardown) when present, else the checkout; `validateTriple` accepts a manifest `input_path` in lieu of a git `story_file`.
- **Forward-only:** existing pairs (incl. strata 5-2) stay un-reconstructable — re-running the census on strata confirms 5-2 is emitted with no input fields and no crash. The reconstructable corpus accrues from runs after this ships. +12 tests (schema round-trip, `captureReconstructionInput` real-fs sidecar write, census `resolvePhaseInput` manifest-preferred/git-fallback/none, harness `validateTriple`); full suite 10699 passing, regression eval gate 100% (35/35).

## [0.20.123] — 2026-05-26 (fix: remove latent broken-import landmine in the 77-8 harness CLI)

Found while answering "is the eval framework smoke-tested end-to-end?" — it is not, and verifying that surfaced a latent bug in the v0.20.122 harness. The harness CLI's production dispatch path did `await import('../../dist/index.js')` and pulled `createDispatcher`, but that symbol is **not** exported from the top-level `dist/index.js` (it lives in `@substrate-ai/core` / `src/modules/agent-dispatch/`). The path is unreachable today (the empty/forward-thin corpus early-returns before it), so every gate was green — but the day the corpus got its first real pair it would have thrown a cryptic `createDispatcher is not a function`. Classic unexercised-path landmine (the "CI green ≠ the deferred path works" hazard).

- Replaced the broken dynamic import + naive dispatcher construction with an **explicit, loud, documented deferred boundary**: when there are real reconstructable cases but no wired production dispatch, the CLI now exits `3` with a message naming exactly what must be wired (a real dispatcher via `createDispatcher` from `@substrate-ai/core` + faithful phase-prompt assembly) and why it's deferred (corpus forward-thin). No more hidden landmine; the deferral is honest and self-documenting.
- The harness ORCHESTRATION (`selectReconstructableCases` / `reconstructCase` / `runHarness`) and the 77-9 grader were and remain complete + unit-tested (47 tests) with injected I/O — unchanged. Repo-side dev tooling only: `scripts/` is not in the published npm tarball (`files` = dist + packs + README), so the published binary is byte-identical to v0.20.122 apart from the version string. Full suite 10687 passing; regression eval gate 100% (35/35).

## [0.20.122] — 2026-05-26 (feat: Epic 77 reconstruction harness + grader — 77-8, 77-9)

Builds the two-story reconstruction-eval tier (CodeBuff method) on top of the 77-6 census. Capability-tier — **scheduled, never an every-ship gate**. Both hand-built (not dispatched): census-class Medium stories timed out the dev-story window twice on 77-6, so deterministic `.mjs` + synthetic-fixture tests is the faster, cleaner path. Unit-tested against SYNTHETIC fixtures because the real corpus is forward-thin (0 clean pairs — F-commitsha only persists auto-commit SHAs going forward); the harness/grader activate as real pairs accumulate.

- **77-8 — single-phase reconstruction harness** (`scripts/eval-reconstruction/harness.mjs`, 25 tests). Given a corpus triple, checks out the corpus repo at the commit's PARENT SHA in an isolated `git worktree --detach` (AC1 — never mutates the corpus working tree), re-dispatches ONLY the producing phase via a single bare `dispatcher.dispatch()` (AC2 — no orchestrator lifecycle, no review loop), enforces a per-case budget cap → records `budget-exceeded` rather than silently overspending (AC3), captures the reconstructed artifact set and always tears the checkout down via `finally` (AC4), and is failure-tolerant per case — a thrown/timed-out dispatch becomes a recorded `dispatch-error`, never aborts the run (AC5). All I/O is injected, so the orchestration is unit-tested without a real repo or LLM.
- **77-9 — reconstruction grader, two-signal / ambiguous-only-LLM** (`scripts/eval-reconstruction/grader.mjs`, 22 tests). Deterministic signal ALWAYS (0.5·file-set Jaccard + 0.5·test-pass overlap; AC1); the LLM pairwise judge runs ONLY when the deterministic score lands in a configurable gray band (default 0.4–0.8 — clear pass/fail skip the judge to bound cost; AC2), with the judge injected for testing. Combines into a quality score, rolls up under the GREEN/YELLOW/RED rubric (reusing `computeRubric`), tagged `tier=1 capability`; ungradable cases are excluded from the denominator (YELLOW-by-absence, never a false GREEN/RED; AC3). `ReconstructionGraderCheck` implements `VerificationCheck` (tier 'B') with an explicit machine-checkable `everyShipGate = false` marker and is **NOT wired into the `/ship` gate** (AC4).
- Epic 77 story map: 77-1…77-6 + 77-8 + 77-9 complete; **77-7** (capability corpus + hill-climbing loop) remains a stub by design (depends on 77-1…77-5 being stable + a rich decision-replay corpus). Full suite 10687 passing (+47); regression eval gate 100% (35/35).

## [0.20.121] — 2026-05-26 (test: F-probe retry-path validation)

Closes the one validation gap left after the v0.20.115–120 dogfood arc. The F-probe shift-left runtime-probe gate (v0.20.119) is unexercised in production — story 78-1 happened to author a valid probe, so the *retry* wiring (rename-to-`.stale-probe-`, re-dispatch with correction guidance) never fired live. Since the malformed-probe case can't be forced through a real LLM dispatch, mocked-orchestrator integration tests are the validation surface.

- **3 orchestrator integration tests** (`orchestrator.test.ts`, "F-probe: pre-dev runtime-probe validity gate") drive the full create-story retry loop with a mocked `parseRuntimeProbes`: (1) invalid YAML on first author → create-story re-dispatched, artifact renamed to `.stale-probe-<ts>.md`, `priorDriftFeedback` carries the targeted YAML-correction guidance, story reaches COMPLETE on the clean re-author; (2) persistently-invalid YAML → 1 initial + `MAX_FIDELITY_RETRIES` re-authors, then *proceeds* to dev-story (the gate never escalates on its own — verification is the backstop); (3) valid YAML → no retry, no rename.
- The `@substrate-ai/sdlc` test mock now exports `parseRuntimeProbes` (default `{ kind: 'absent' }`, a no-op for existing tests). Test-only change; no runtime behavior change. Complements the parser-level reject already covered in `packages/sdlc` `parser.test.ts`. Suite: orchestrator file 115 → 118 tests; full suite 10640 passing.

## [0.20.120] — 2026-05-26 (fix: F-commitmsg title sanitization + report recovery-count)

Two fixes surfaced + validated during the end-to-end smoke run (trivial story 78-1, run 376a3930 — the session's first clean substrate-on-substrate SHIP→merge, which validated `commit_sha` in production).

- **F-commitmsg — sanitize the auto-commit story title.** create-story's structured `story_title` can absorb stray stdout; story 78-1 (domain: `substrate report`) bled the report banner (`═` rules + "Run:/Verdict:" text) into the title, producing a mangled multi-line `feat(story-78-1): …` commit subject (commit `c29f812`). New `sanitizeStoryTitle()` (orchestrator) is applied at the title-capture site: titles containing box-drawing/block glyphs (U+2500–U+259F) are rejected (→ `undefined` → `commitDevStoryOutput` falls back to its safe `implementation` default); otherwise the first non-empty line is taken, control chars stripped (char-code filtered), whitespace collapsed, length capped at 120. 7 unit tests incl. the 78-1 regression. This is a substrate-on-substrate-dogfooding hazard (story domain overlapping substrate's own stdout-emitting tooling), not a consumer-project bug.
- **`substrate report` recovery-attempts count** (story 78-1, shipped via the dispatch, commit `c29f812`): `review_cycles ?? recovery_history.length` returned 0 when `review_cycles` was 0 (`??` doesn't fall through on 0), so escalations with recovery activity but no review cycles showed "0 recovery attempt(s)". Now `Math.max(review_cycles ?? 0, recovery_history count)`.

Related dogfooding finding (filed, not a product bug): **F-worktree-leak** was downgraded to census-specific — the 78-1 dispatch confirmed a normal story's writes stay in the worktree (main's source tree was unchanged), so the earlier run2 leak was caused by the census's git-root-resolution domain.

## [0.20.119] — 2026-05-26 (fix: F-probe — shift-left runtime-probe YAML validation)

Third fix from the 77-6 dogfood run. The census story false-escalated on a `runtime-probes` YAML parse error: create-story authored a probe whose `command: |` block scalar embedded a multi-line `git commit -m "…\n\nCo-Authored-By: …"` with an unindented (column-0) trailer, which terminates the scalar and breaks the YAML. The probe was create-story raw text (no `_authoredBy`), so the probe-author phase's existing retry-on-invalid-YAML never validated it — the malformed block only surfaced at verification → escalation.

- **Shift-left probe-validity gate** in the create-story retry loop: after the source-AC fidelity gate, the orchestrator now validates the rendered `## Runtime Probes` block with the *same* `parseRuntimeProbes` the verification check uses. On `kind: 'invalid'` (with retry budget remaining), it renames the artifact to `.stale-probe-<ts>` and re-dispatches create-story with targeted guidance (indent every block-scalar line; no column-0 content; prefer single-line commands). A fixable YAML mistake now costs a cheap re-dispatch instead of a verification-failure escalation. Budget exhaustion proceeds to dev-story — the verification check remains the backstop, so terminal behavior is unchanged.
- Separate retry budget from the fidelity gate (`MAX_FIDELITY_RETRIES`); runs only when fidelity didn't already schedule a retry.
- Regression test pins the exact 77-6 failure (under-indented `Co-Authored-By:` trailer → `parseRuntimeProbes` rejects). The retry wiring will be prod-confirmed by the 77-6 redo.

This completes the three substrate fixes surfaced by the 77-6 run (F-ac2gap + F-commitsha in v0.20.118; F-probe here). Next: the 77-6 redo on the fixed binary (correct `per_story_state.commit_sha` correlation + valid probe).

## [0.20.118] — 2026-05-26 (fix: two provenance gaps found by the 77-6 fresh-run validation)

The first real post-77-4 dispatch (run `c2874c68`, the 77-6 census) doubled as 77-4's AC5 bootstrap validation. It confirmed `primary_model` (`claude-sonnet-4-6`) and `recovery_history` (incl. the new `tier-a-retry-with-context` entry) land correctly in substrate's own state — and surfaced two gaps, now fixed:

- **F-ac2gap — `escalation_reason` on the VERIFICATION_FAILED terminal path.** The 77-4 AC2 patch lived in `emitEscalation`, but a story that exhausts Tier A recovery and falls through to VERIFICATION_FAILED never calls it — so `escalation_reason` stayed undefined on exactly the path the 77-6 run took. Now the terminal finalizer patches `escalation_reason` with the recovery root-cause taxonomy value (`build-failure` / `ac-missing-evidence`). Regression guard added to the existing verification-failed wiring test.
- **F-commitsha — auto-commit SHA never persisted to the manifest.** Discovered while reconciling 77-6: its census needs to correlate `feat(story-N-M)` commits to manifests by SHA, but no manifest stored a commit SHA anywhere (0/50 sampled). Now the dev-story auto-commit site patches `per_story_state[key].commit_sha` (new optional schema field) at commit time. Unblocks the 77-6 reconstruction-corpus census and improves reconcile-from-disk HEAD-advance detection. Another decision-provenance gap in the 77-4 family.

Both validated: full suite 10611 green; the persist paths will be prod-confirmed by the 77-6 redo (same fresh-run pattern that validated 77-4). Schema-contract unit tests pin both fields.

Context: the 77-6 census itself failed verification on a *separate* runtime-probe YAML defect (a probe's `command:` block scalar embedded an under-indented `Co-Authored-By:` line) and also had a wrong manifest-schema assumption — both being addressed via a 77-6 redo + a forthcoming shift-left probe-validation fix (F-probe).

## [0.20.117] — 2026-05-25 (fix: ingest-epic idempotency in Dolt CLI mode + Story 77-6 design)

Bug found by dogfooding the Epic 77 work — re-ingesting an epic whose stories already exist died on `duplicate primary key`.

- **`ingest-epic` is now idempotent under the Dolt CLI adapter.** Root cause: `EpicIngester` used a read-then-write upsert (SELECT existing → branch INSERT/UPDATE), but the Dolt CLI-mode `transact()` *collects* statements and a mid-transaction SELECT always returns `[]` (documented in `dolt-client.ts`). So the existence check always missed → always-INSERT → duplicate-key on re-ingest. It only passed tests because `InMemoryDatabaseAdapter` runs transactions live (test-vs-prod gap). Fix: two unconditional statements — `INSERT IGNORE` (new rows at `status='planned'`; existing silently skipped, **status preserved**) + `UPDATE title` (never touches status). Both work in CLI batch mode and in-memory. `storiesUpserted` now counts all upserted stories (was insert-only; the new count makes the "Ingested N stories" CLI message accurate on re-ingest). New regression test pins the idempotency + status-preservation contract.
- **Story 77-6 (phase reconstruction) design resolved** (bmad-party-mode panel): decomposed into three two-part-key stories — 77-6 (cross-project corpus census), 77-8 (single-phase reconstruction harness), 77-9 (two-signal ambiguous-only grader). Bare phase re-dispatch; LLM judge only on gray-band cases; capability-tier, never every-ship. Census correction: the substrate-self reconstruction corpus is only ~4 clean pairs, so the corpus is cross-project by mandate.
- Note: substrate story keys are two-part (`epic-story`) by design — three-part `77-6-1` is unsupported by the epic-parser; the sub-stories were renumbered accordingly rather than adding hierarchical-key support.

## [0.20.116] — 2026-05-25 (Epic 77 Story 77-5: decision-replay grader, Tier 2b)

Extends the eval harness to assert harness *decisions* now that 77-4 persists them — the first tier with real harness-regression power on the provenance dimension.

- **Decision-class corpus assertions** (`expect.primary_model`, `expect.escalation_reason`, `expect.recovery_actions[]`) — partial assertion (a case asserts only the fields it declares). `escalation_reason: null` means "should NOT have escalated" (a recorded reason then fails — a re-introduced false escalation); `recovery_actions: []` asserts no recovery ran.
- **Grader reads the hardened provenance**: `primary_model` from `story_metrics`, `escalation_reason` from manifest `per_story_state`, `recovery_history` from the manifest. Wired into both the CLI gate (`scripts/eval-outcomes.mjs`) and the `OutcomeGraderCheck` VerificationCheck.
- **Missing-provenance is a corpus-error, not a silent pass** — a declared non-null decision field whose recorded value is absent flags pre-77-4 runs (empty provenance) rather than passing them.
- **Folded into the regression rubric**: a case fails if EITHER the outcome class (77-1) OR a declared decision assertion fails. Report gains a `decision_replay` block.
- The 5 obs_026 false-escalation cases gained `expect.escalation_reason: null` — informational on the immutable pre-77-4 run, activating as a gating dual assertion (wrong outcome AND wrong/absent reason) when re-recorded from a fresh post-fix run (Tier 1 / 77-6).
- 17 new grader unit tests (50 total in `lib.test.ts`). Live gate: regression GREEN 100% (35/35), 0 corpus-errors.

## [0.20.115] — 2026-05-25 (Epic 77 Story 77-4: decision-provenance hardening)

Populates the three decision-provenance fields the Phase 0 eval census found empty, so Tier 2b decision-replay (story 77-5) becomes feasible. Pure telemetry hardening — **no change to any pipeline decision** (routing, escalation, and recovery still behave identically; this story only *records* what already happens).

- **`primary_model` now written to `story_metrics`.** The dispatcher echoes the model it actually resolved (explicit `request.model` → routing resolver → adapter's declared `defaultModel`) on `DispatchResult.model`; the workflow wrappers (dev-story/create-story/code-review) surface it; the orchestrator threads the dev-story model through `endPhase` and `derivePrimaryModel()` writes it. Adapter defaults are now declared on `AdapterCapabilities.defaultModel` (claude → `claude-sonnet-4-6`, gemini → `gemini-2.0-flash`; codex's CLI default stays opaque → NULL, genuinely unknown). The epic's premise that `_storyAgents` already held the model was falsified — `recordDispatchAgent` was called without one, so model was never captured; this ship closes that upstream gap.
- **`escalation_reason` now persisted to the run manifest.** Added centrally in `emitEscalation` (the single funnel for all ~14 escalation paths) via `patchStoryState`, using the per-site verdict/taxonomy value (recovery-engine root cause where available). Read side already existed in `report.ts`; field added to `PerStoryStateSchema` (zod was silently stripping it).
- **`recovery_history` now appended on every recovery action**, not just the review-fix retry. Added `appendRecoveryEntry` to the recovery-engine Tier A retry, Tier B re-scope, Tier C halt, the run-level halt-entire-run safety valve, and the dev-story-timeout checkpoint retry.

Bootstrap-sensitive (substrate modifying its own telemetry writers): hand-built, not dispatched — a dispatched run would execute the OLD writers while implementing the new ones. Validate against a fresh post-merge run (AC5), not the implementing run.

## [0.20.106 – 0.20.108] — 2026-05-21/22 (Item 7 arc: StateStore excision)

The deferred architectural item from the schema-unification arc. Eliminates the misleading-by-design `StateStore` interface and `FileStateStore` class. v1 of the arc plan was authored on the assumption that the orchestrator depended on FileStateStore at runtime — Ship 1's pre-execution audit empirically falsified that premise (the orchestrator's `stateStore?` prop was undefined in 100% of production callers across `run.ts × 2`, `resume.ts`, and `retry-escalated.ts`; every write was a no-op via an `if (stateStore !== undefined)` guard). v2 of the plan reframed the smell as dead-code + a class doing two unrelated jobs, and shrank the arc from 7 ships to 3.

### BREAKING

- **`StateStore` interface removed from `@substrate-ai/core` public API (v0.20.107).** Production never wired this interface; the orchestrator's optional `stateStore?` dep was undefined in every production caller. Tests that mocked StateStore have been migrated or deleted.
- **`FileStateStore` class renamed to `FileKvStore` (v0.20.107).** The new name reflects what the class actually does — narrow per-project KV persistence for routing telemetry (`setMetric`/`getMetric` + flush to `.substrate/kv-metrics.json`). The pre-Item-7-arc class also carried story/metric/contract Maps that no production caller ever touched; those are gone.
- **`createStateStore` factory removed (v0.20.107).** Instantiate `FileKvStore` directly when you need a routing KV store, or call `createDoltOperatorReader` for the Dolt-backed read surface.
- **Types removed from `@substrate-ai/core/state` (v0.20.107):** `StateStore`, `StoryRecord`, `StoryFilter`, `MetricRecord`, `MetricFilter`, `ContractRecord`, `ContractFilter`, `ContractVerificationRecord`, `StateStoreConfig`. `StoryRecord` moved to `src/modules/validation/types.ts` (only consumer post-arc). The others had zero external consumers.
- **Orchestrator's `stateStore?: StateStore` prop removed from `OrchestratorDeps` (v0.20.106).** External callers constructing the orchestrator should drop the prop — it was never load-bearing.

### Preserved by the arc

- `DoltOperatorReader` interface (in `@substrate-ai/core/state`)
- `DoltStateStore` class (the Dolt-backed operator-read surface)
- `createDoltOperatorReader` factory
- `IStateStore` narrow KV contract in `@substrate-ai/core/routing/types` (the actual contract routing-tuner + routing-token-accumulator consume; `FileKvStore` satisfies it structurally)
- All operator CLI commands and their output formats
- Run manifest + all initSchema-managed Dolt tables
- `.substrate/kv-metrics.json` cross-process persistence path

### Empirical validation

- Ship 1 Tier 2 smoke (story 5-7 dispatched against ynab): orchestrator phase wiring intact through create-story → test-plan → dev-story → build-fix → contract-verification → escalation. story_metrics row written, wg_stories status updated, decision-store contract declaration written, run manifest updated, telemetry pipeline processed batches, all event emissions correct.
- Ship 2 Tier 2 smoke (story 4-4 dispatched against ynab): all four persistent surfaces verified — story_metrics + wg_stories + run manifest + **kv-metrics.json** (the critical Ship 2 preservation target — confirms `RoutingTokenAccumulator → FileKvStore.setMetric → .substrate/kv-metrics.json` cross-process write path is intact post-rename).

Net LOC delta across the arc: ~−1700 across 36 files. See `_planning/item-7-statestore-arc-plan.md` (v2) and `_planning/item-7-statestore-arc-plan-v1-FALSIFIED.md` (v1 forensic record) for the full plan + audit findings.

## [0.20.102] — 2026-05-20 (Operator-command excision: `substrate migrate`)

### BREAKING

- **`substrate migrate` command removed.** Dead-in-production since Epic 29 removed SQLite support: `readSqliteSnapshot()` was rewritten to always return an empty snapshot, so the command's reachable code always exited with "No SQLite data found — nothing to migrate". The unreachable code path wrote to the `metrics` table — which Ship 8 (v0.20.99) dropped — so the command was both dead-on-read AND broken-on-write. Per the operator-command excision policy from Ship 1: deleted rather than documented-broken or stubbed. If you need to migrate truly ancient (pre-Epic-29, ~Feb 2026) SQLite data, downgrade to a pre-v0.20.102 substrate version for the migration, then upgrade back — the Dolt database retains the migrated data across upgrades.

## [0.20.92 – 0.20.100] — 2026-05-20 (Schema-unification arc + post-arc cleanup)

### BREAKING

- **`substrate diff` and `substrate contracts` commands removed (v0.20.92).** Both commands had been producing empty output in every audited production project for an unknown duration — the underlying DoltStateStore CRUD they read from was excised because the orchestrator wires `FileStateStore` (in-memory), never DoltStateStore. Per "no shortcuts, no tech debt": deleted rather than documented-broken or stubbed.
- **`substrate metrics --aggregate`, `--sprint`, `--task-type`, `--since` flags removed (v0.20.92).** These flags fed the dead Dolt fallback for routing-recommendations. The command's primary path (FileStateStore routing recommendations) is unaffected. If you scripted against these flags, the `substrate metrics --output-format json` core surface still works.
- **`DoltMergeConflictError` / `DoltMergeConflict` errors removed (v0.20.100).** Surfaced only by the now-decommissioned DoltStateStore branch lifecycle (`branchForStory`/`mergeStory`/`rollbackStory`) — unreachable in production because the orchestrator uses FileStateStore. The Dolt branch-per-story scheme (Epic 26) was superseded by `substrate-worktrees` + git-branch dispatch (v0.20.79+, Epic 75). The `pipeline:state-conflict` event type is also removed.

### Architecture: schema-unification 7-ship arc (v0.20.92 → v0.20.98)

Designed in a bmad-party-mode panel after auditing the persistence layer and finding 7 DDL sources of truth (not 2 — as the v0.20.91 hot-fix had assumed) with 5 critical shape-conflicts between them. The arc closed the schema-divergence defect class structurally:

| Ship | Description | Version |
|---|---|---|
| 1 | Excise zombie DoltStateStore writes + interface segregation (`StateStore extends DoltOperatorReader`) | v0.20.92 |
| 2 | Layer-2 runtime regression gate (real-Dolt integration test, 12 → 14 tests, ~7s) | v0.20.93 |
| 3 | Port `schema.sql` tables → TS modules; delete `schema.sql` | v0.20.94 |
| 4 | Consolidate triple-defined telemetry tables into one DDL source | v0.20.95 |
| 5 | Extract 7 per-subsystem schema modules; composition root in `initSchema` | v0.20.96 |
| 6 | TS-export ownership contract (static drift gate, 5 tests, ~5ms) | v0.20.97 |
| 7 | Delete vestigial `_schema_version` table | v0.20.98 |

Net delta across the arc: ~−5800 LOC. After the arc, persistence has **1 composition root** in `packages/core/src/persistence/schema.ts` calling 7 per-subsystem `initXxxSchema` functions; two drift gates (runtime + static) prevent regression.

### Post-arc cleanup (v0.20.99 + v0.20.100)

- **v0.20.99 (Ship 8)** — Dropped the six remaining legacy state tables (`stories`, `contracts`, `metrics`, `dispatch_log`, `build_results`, `review_verdicts`) per the empirical-emptiness audit (zero rows in every audited project). Removed the residual v5→v6 `repo_map_symbols.dependencies` ALTER from DoltStateStore (column now in CREATE TABLE).
- **v0.20.100 (Ship 9)** — Decommissioned DoltStateStore branch lifecycle (~250 LOC removed). Migrated `substrate ingest-epic` + `substrate epic-status` from raw CREATE TABLE constants to `initWorkGraphSchema(adapter)`; deleted the `src/modules/work-graph/schema.ts` legacy shim. Documented `monitor.db`'s distinct `_schema_version` table.

### Migration notes

Existing repos (ynab, quant, agent-mesh, etc.) drop the seven legacy tables on next `substrate run` via `DROP TABLE IF EXISTS` in `initStateSchema`. No operator action required. Fresh repos never see the tables.

If you have scripts invoking the removed CLI surface, update them:
- `substrate diff` → no replacement; use `git diff` + the Dolt commit log (`substrate history`) instead.
- `substrate contracts` → no replacement; contracts are now ephemeral per-run state in `FileStateStore`.
- `substrate metrics --aggregate/--sprint/--task-type/--since` → use the primary `substrate metrics --output-format json` surface (FileStateStore routing-recommendations).

## [0.20.46] — 2026-05-03

### Feature: AnthropicAdapter.stream() — streaming parity for direct-LLM providers

`packages/factory/src/llm/providers/anthropic.ts` previously implemented `complete()` only; `stream()` threw `streaming not yet implemented`. v0.20.46 closes that TODO with a working SSE parser that maps Anthropic's Messages API streaming protocol (`message_start` / `content_block_start` / `content_block_delta` / `message_delta` / `message_stop`) to the package's `StreamEvent` shape (`text_delta`, `tool_call_delta`, `reasoning_delta`, `usage`, `message_stop`). All three direct-LLM providers (`anthropic`, `openai`, `gemini`) now implement streaming uniformly.

Empirically smoke-validated against the live Anthropic API (claude-haiku-4-5, 657ms round-trip, ~$0.0000 cost). +7 unit tests.

**Who is affected:** Callers of `factory-command` direct-backend with `provider: 'anthropic'` who invoke `.stream()` — previously crashed at runtime, now stream cleanly.

**Who is NOT affected:** Substrate's main dispatch path (CLI-based `claude-code` adapter handles streaming via NDJSON event protocol on its own subprocess; unchanged).

## [0.20.45] — 2026-05-03

### Feature: source-ac-fidelity dependency-context detection (closes obs_2026-05-02_020)

Source-ac-fidelity now detects path mentions inside dependency-context phrases (`via \`X\``, `via \`X\`'s outbox`, `imports from \`X\``, `consumes \`X\``, `built atop \`X\``, `\`X\`-shipped`, `using \`X\`'s`) and routes them to the new `source-ac-dependency-reference` info-severity finding category instead of the default `source-ac-drift` error path. Mirrors the obs_016 negation-context heuristic shape; new exported `detectDependencyContextLines(lines)` parallel to `detectNegationContextLines`.

This is the third false-positive class fix on source-ac-fidelity:

| Obs | Family | Version |
|---|---|---|
| obs_013 | alternative-options (`**(a)**`/`**(b)**`) | v0.20.24 |
| obs_016 | negation phrases (`(NOT replaced)`, `MUST NOT`) | v0.20.40 |
| obs_020 | dependency-context phrases (`via X`, `imports from X`) | v0.20.45 |

**Who is affected:** Stories whose ACs name peer-package directory paths under dependency-context phrases (common shape: "publish via \`packages/foo\`'s outbox") — previously hard-failed verification on under-delivery, now pass with info-severity reference finding.

## [0.20.42 / 0.20.43 / 0.20.44] — 2026-05-02 / 03

### Feature: obs_2026-05-01_017 three-phase fix-out — create-story probe-awareness for state-integrating ACs

obs_017 surfaced a substrate-side blind spot: TypeScript modules whose ACs require real fs / git / Dolt / network integration shipped SHIP_IT through every verification gate because the create-story prompt told the agent to omit `## Runtime Probes` for "TypeScript code + tests" without checking whether that code interacts with external state. Three layers shipped, each closing a separate facet:

- **v0.20.42 (Phase 1) — prompt-content layer**: `packs/bmad/prompts/create-story.md` replaces the artifact-shape omit clause with a behavioral-signal section enumerating 6 interaction categories (subprocess `execSync`/`spawn`, filesystem `fs.read*` against host paths, git operations, database, network `fetch`/`axios`, registry/config scans). Omit clause narrowed to purely-algorithmic modules only.

- **v0.20.43 (Phase 2) — frontmatter + gate layer (Epic 64)**: New `external_state_dependencies: [...]` story-frontmatter field (Zod-validated, open-enum strings). New `runtime-probe-missing-declared-probes` finding category in `runtime-probe-check.ts` — when frontmatter declares dependencies AND no probes section exists, escalates to `error` severity and hard-gates SHIP_IT. Mirrors obs_016's missing-Runtime-Probes escalation pattern.

- **v0.20.44 (Phase 4) — architectural-language layer**: After empirical smoke validation revealed that ACs phrased at architectural-abstraction level ("queries agent-mesh's skill via MeshClient", "publishes via outbox") didn't match the v0.20.42 code-API enumeration, Phase 4 added an "Architectural-level signals" paragraph parallel to the behavioral-signal one. Enumerates named-external-dependency types (service, package, agent, skill, mesh, registry, queue, outbox, store, daemon) + interaction verbs (queries, publishes, consumes, calls, writes-to, reads-from, subscribes, registers, delegates) + 6 phrase-pattern bullets.

Phase 3 (Epic 65, probe-author state-integrating dispatch) deferred behind eval-gate at Story 65-4 (≥75% catch rate target).

**Who is affected:** Story authors whose ACs describe state-integrating logic in TypeScript / JavaScript / Python — substrate now reliably prescribes runtime probes for these story classes regardless of which language the implementation ships in.

### Process: empirical prompt-edit smoke discipline (closes obs_2026-05-02_019)

Companion process fix: the `/ship` slash command (`.claude/commands/ship.md`) gained a conditional **Step 4.5** that triggers when staged changes touch `packs/bmad/prompts/*.md`. Dispatches a fixture epic via `npm run substrate:dev` and asserts the rendered story has the structural property the prompt change targets. Halts ship on assertion failure. CLAUDE.md gained a "Cross-Project Observation Lifecycle" section encoding reopen-evidence requirements (verify `substrate --version` before claiming "dispatched under vX.Y.Z").

## [0.20.31–0.20.41] — 2026-04-27 to 2026-04-29

### Feature: probe-author phase (Epic 60 — Phase 2, eval-validated)

Substrate gained a `probe-author` phase that derives `## Runtime Probes` sections from event-driven AC text via a separate dispatch (independent from create-story). Telemetry events: `probe-author:dispatched`, `probe-author:output-parsed`, `probe-author:appended-to-artifact`, `probe-author:skipped`, `probe-author:authored-probe-failed`. Probe-author probes carry an `_authoredBy: 'probe-author'` discriminator on `RuntimeProbe` / `StoredVerificationFinding` for KPI attribution.

A/B validation harness in v0.20.39 produced GREEN, 4/4 = 100% catch rate on the v1 defect corpus. v0.20.41 (Story 60-16) flipped `runtime-probe-missing-production-trigger` from warn → error severity, making missing-trigger detection a hard gate for event-driven ACs. New CLI surface: `substrate probe-author dispatch`, `substrate annotate`, `substrate metrics --probe-author-summary`.

**Who is affected:** Stories whose ACs describe event-driven mechanisms (git hooks, systemd timers, signal handlers, webhooks) — substrate now auto-derives production-trigger-invoking probes when create-story doesn't author them, and hard-fails verification when probes don't invoke a known production trigger.

### Feature: Epic 62 — code-review YAML output recovery (v0.20.33)

Code-review YAML parser auto-recovers from `bad indentation` errors by rewriting `<field>: <value-with-colon>` lines as block scalars (allowlist: description, message, error, notes, comment, finding, command, details, rationale, reason). New `orchestrator:code-review-output-malformed` event. Schema-validation failures don't burn retry budget.

### Feature: Epic 63 — runtime-probe error-shape auto-detection (v0.20.34)

Runtime-probe executor scans probe stdout for canonical error-envelope JSON shapes (`"isError": true`, `"status": "error"`) regardless of whether the author declared an assertion. New `runtime-probe-error-response` finding category. Closes obs_012.

### Feature: Sprint 21 — source-ac-fidelity negation-context detection (v0.20.40, obs_016)

Negation phrase detector marks paths inside paragraphs containing `(NOT replaced)`, `MUST NOT`, `documented (NOT`, `does NOT replace`, `deferred to`, `is gitignored` — routes path mentions to info-severity `source-ac-negation-reference` instead of error-severity `source-ac-drift`. Also: missing-Runtime-Probes escalates to error severity for event-driven ACs.

### Feature: Sprint 17 — verification + COMPLETE dedup (v0.20.35)

Three duplicated ~80-line verification + COMPLETE blocks collapsed into single `runVerificationAndComplete` helper. Net -86 lines.

## [0.20.0–0.20.30] — 2026-04-09 to 2026-04-26

### Library packaging arc

This window (~30 patch releases) shipped the npm packaging story, OIDC trusted publishing, dolt work-graph integration, story-scoped under-delivery detection, alpha-suffix story-key parsing, separator-tolerant story-section extraction, alternative-option detection, operational-path heuristic, manifest write serialization, retry-escalated terminal-run filtering, structured verification findings, and runtime verification gates. Per-version detail in MEMORY.md (versions v0.20.0 through v0.20.30) and `git log --oneline v0.20.0..v0.20.30`.

Headline arcs in this window:

- **Epic 41 (v0.20.0–v0.20.5)** — `@substrate-ai/core` package extraction, OIDC trusted publishing setup
- **Epic 55 (v0.20.5–v0.20.10)** — structured verification findings (severity + category instead of free-text)
- **Epic 56 (v0.20.7–v0.20.10)** — runtime verification gates (initial probe-awareness, probe execution against twin sandbox)
- **Epic 57 (v0.20.9)** — manifest write serialization (closes lost-update race in `RunManifest.patchStoryState`)
- **Epic 58 (v0.20.13–v0.20.20)** — source-ac-fidelity check + AC-preservation directive (`MUST` / `MUST NOT` / `SHALL` / path verbatim transfer)
- **Epic 31 (long-running)** — Dolt work-graph (`wg_stories`, `story_dependencies`, `ready_stories` view, cycle detection)
- **Story 60-7 (v0.20.28)** — operational-path heuristic (`.git/hooks/`, `/usr/local/bin/`, `~/...` paths emit info, not error)
- **Story 60-5 (v0.20.24)** — alternative-option group detection (`**(a)**` / `**(b)**` AC structures)

## [0.9.0] — 2026-03-22

### Feature: @substrate-ai/core package extraction (Epic 41)

The `@substrate-ai/core` npm workspace package now contains all general-purpose agent
infrastructure modules previously embedded in the Substrate monolith. Downstream packages
(SDLC, factory) can import from `@substrate-ai/core` without coupling to SDLC-specific types.

Stories 41-1 through 41-12 migrated the following module groups into `packages/core/src/`:
adapters, config, dispatch, events, git, persistence, routing, telemetry, supervisor, budget,
cost-tracker, monitor, and version-manager.

**Backward-compatibility shim strategy:** Every `src/` module in the monolith that was migrated
retains a thin re-export shim (e.g., `src/events/index.ts` re-exports from `@substrate-ai/core`)
so that existing internal import paths continue to resolve without modification. No call sites
outside `packages/core/` were changed.

**Who is affected:**
- Downstream packages that previously imported from `substrate-ai` internals and now want
  transport-agnostic types: import from `@substrate-ai/core` directly.
- CI and integration test environments: no change required — the shim layer is transparent.

**Who is NOT affected:**
- Existing CLI users — the `substrate` command behavior is unchanged.
- Projects importing from `substrate-ai` top-level exports — all public API surface is intact.

## [0.5.0] — 2026-03-14

### Breaking: Full SQLite removal — better-sqlite3 removed (Epic 29)

`better-sqlite3` and `@types/better-sqlite3` have been completely removed from the project. The `SqliteDatabaseAdapter`, `LegacySqliteAdapter`, all 11 SQLite migration files, and the WASM mock infrastructure have been deleted. The `backend: 'sqlite'` config option no longer exists.

**Who is affected:**
- Developers who called `createDatabaseAdapter({ backend: 'sqlite', ... })` — this backend has been removed entirely. Use `'auto'` or `'dolt'` instead.
- Users of `substrate monitor` and `substrate metrics` who relied on reading historical `.db` SQLite files — these commands now use Dolt (when available) or in-memory storage
- Any code importing from `src/persistence/sqlite-adapter.ts` or `src/persistence/migrations/` — these files are deleted

**Who is NOT affected:**
- CI environments using `InMemoryDatabaseAdapter` (no change)
- Environments with Dolt installed and initialized (primary supported backend)
- Fresh installations — `npm install substrate-ai` now completes without any C++ native addon compilation

**Remediation (if you have historical SQLite data):**
Run `substrate migrate` (from Epic 26-13) **before** upgrading to this version to move data to Dolt. After upgrade, run with `--dolt` or ensure Dolt is available on PATH.

### Breaking: FileStateStore no longer persists metrics to SQLite (Epic 29)

`FileStateStore` has been updated to be a pure in-memory TypeScript implementation with no `better-sqlite3` dependency. The `db?` option on `FileStateStoreOptions` has been removed — the constructor now only accepts `basePath?: string`.

**Who is affected:** Users who ran substrate pipeline runs before Epic 29 (v0.4.x) and have historical metrics stored in `.substrate/*.db` SQLite files.

**Remediation:** If you want to retain historical SQLite metric data, run `substrate migrate` (from Epic 26-13) **before** upgrading to v0.4.x to move data to Dolt. After upgrade, all new metrics are stored in Dolt when Dolt is available on your PATH, or are ephemeral in-memory when `FileStateStore` is used (CI environments).
