# Substrate Hardening Program — Execution Plan

**Program docs** (read in this order in a fresh session):
1. Strategy & rationale: `_planning/2026-07-05-substrate-bleeding-edge-plan.md` (the WHY and the phase design)
2. Source audit (anchors for every fix): `_planning/2026-07-05-substrate-remediation-audit.md`
3. Ground truth (the failures being fixed): `_planning/2026-07-04-income-sources-field-feedback.md`
4. This file: the work breakdown (the WHAT, story by story)
5. `_planning/substrate-hardening/LEDGER.md`: current state (the WHERE-ARE-WE — always read AND update)
6. `_planning/substrate-hardening/GOAL-PROMPT.md`: the session driver

**Line-number caveat:** all `file:line` anchors were verified at HEAD `d095d14` (2026-07-05). They drift as ships land. Treat them as starting points; re-locate by symbol name (function names are stable) before editing.

---

## Execution model

- **Executor:** the Claude Code session implements stories directly (quick-dev style) — NOT via substrate dispatch. Rationale: the pipeline's own finalization/verification is what's being fixed; substrate-on-substrate before H0/H1 land risks the exact destructive failures this program eliminates. **Exception:** from H3 onward, stories marked `[dogfood-eligible]` MAY be dispatched via `substrate run --stories` as live validation — one story at a time, `--max-review-cycles 3`, and only after H0 is shipped and verified.
- **Ship discipline:** every ship follows the repo's `/ship` skill (`.claude/commands/ship.md`) — build, `test:fast` during iteration, full `npm test` pre-push, eval gate 100%, e2e smoke against bundled dist for CLI-surface changes (Step 4.6), version bump, tag push → CI publish. One vitest at a time; never pipe test output; `timeout: 300000`.
- **One ship per story-batch** as grouped below. Small ships > big ships. A session may complete multiple ships.
- **Evidence rule:** a story is DONE only with empirical evidence named in the ledger (test names, fixture-run output, manifest fields observed). "Code merged" is not done. This is the consumer-stack-empiricism discipline — the entire failure class this program fixes shipped because nothing exercised the pipeline on a non-Node project.
- **Ledger updates ship with the code:** every ship's commit includes the LEDGER.md status change. The ledger is the cross-session state machine; if it's stale, the next session does redundant or conflicting work.

## Dependency graph (phase level)

```
H0 (stop bleeding) ──→ H1 (verification) ──→ H3 (finalization modes)
        │                    │                        │
        └──→ H2 (fixture matrix; start after H0.1, lands parallel to H1)
                             │                        │
                             └──────→ H4 (isolation) ─┴─→ H5 (polish) ─→ H6 (final gate)
```
H2 is deliberately early: every later story cites fixture-matrix evidence in its ACs.

---

## EPIC H0 — Stop the bleeding (no run can destroy or strand work)

### H0.1 Commit-first discipline + failure checkpoints + revision bracket — SHIP A
Anchors: `orchestrator-impl.ts:3249` (insert point, after zero-diff gate), `:4012-4033` (VERIFICATION_FAILED), `:4629-4635` (existing commit call), `git-helpers.ts:55` (`commitDevStoryOutput`), `packages/sdlc/src/run-model/per-story-state.ts:139`.
- AC1: Immediately after a dev-story dispatch returns with changes, substrate commits the worktree to the story branch as `feat(story-<key>): <title>` (same helper, relocated call). The later merge-phase commit call becomes a no-op check (already-committed short-circuit exists).
- AC2: Every escalation and VERIFICATION_FAILED exit on the dev path first commits any dirty worktree state as `wip(story-<key>): <reason> snapshot`. Distinct `wip(` prefix so reconcile/merge tooling distinguishes checkpoints from deliverables.
- AC3: `baseline_sha` and `commit_sha` both persisted to `per_story_state` on every terminal path (full baseline..final bracket, including failures).
- AC4: Orchestrator-integration tests (mocked dispatcher): kill/fail injected at review, verification, and escalation points → branch ref differs from base and contains the work, in every case.
- AC5: `reconcile-from-disk` recognizes `wip(story-` commits as recoverable work (extend the `feat(story-` grep, `reconcile-from-disk.ts:209-227`).
- Evidence: named tests green + one real single-story run (any fixture or substrate itself) showing `commit_sha` + `baseline_sha` in the manifest.

### H0.2 Finalization unified across verdict paths — SHIP A
Anchors: `orchestrator-impl.ts:4475` (SHIP_IT branch), `:4615-4852` (block to extract), `:4988-4989` + `:5223-5224` (auto-approve early returns).
- AC1: Commit/merge/finalize logic extracted to a single `finalizeStory()` helper.
- AC2: Both auto-approve sites (cycle-limit and minor-fix-timeout) call it — an auto-approved story gets the identical commit+integration as first-class SHIP_IT.
- AC3: Orchestrator-integration test: 2× NEEDS_MINOR_FIXES → auto-approve → assert `finalizeStory` ran, branch advanced, merge enqueued (the finding-#1 regression test).
- AC4: `substrate report`'s `recovered` outcome rows show a commit SHA.

### H0.3 Worktree removal dirty-guard — SHIP B
Anchors: `git-utils.ts:402-414` (`--force` unconditional), `git-worktree-manager-impl.ts:200-240`, `src/cli/commands/worktrees.ts:265-300`.
- AC1: `cleanupWorktree` checks for uncommitted changes + unpushed/unmerged commits ahead of the merge target before removal; dirty → refuse with named reason (or auto-checkpoint via H0.1's `wip(` path when invoked from the orchestrator).
- AC2: `substrate worktrees cleanup` requires `--force` for dirty worktrees and prints exactly what would be lost.
- AC3: Unit tests for clean/dirty/committed-unmerged matrices.

### H0.4 Dispatch forensics + auth classification + halt — SHIP B
Anchors: `packages/core/src/dispatch/dispatcher-impl.ts:758-771` (timeout stderr pattern to generalize), `:922-949` (result fold), `orchestrator-impl.ts:1941-1975` (Codex hint pattern + no-file site), `claude-adapter.ts:365-393` (planning cmd missing unsetEnvKeys), `src/modules/decision-router/index.ts:40`.
- AC1: `stderrTail` + exit code persisted on EVERY failed dispatch result (not just spawnsync-timeout).
- AC2: `detectClaudeAuthFailure(output)` recognizing at minimum: "Invalid API key", "auth source takes precedence", "Please run /login", OAuth token expiry/refresh signatures, credit-balance errors.
- AC3: Auth-classified failure → escalation kind `auth-failure` with remediation text (naming `ANTHROPIC_API_KEY` scrub, `env -u` workaround) → routed CRITICAL through the Decision Router → run halts (every subsequent dispatch would fail identically).
- AC4: `buildPlanningCommand` gets the same `unsetEnvKeys` as `buildCommand`.
- AC5: Unit tests per signature; integration test: injected auth-failure output → run halts after first story, escalation names the cause.

---

## EPIC H1 — Verification you can bet the merge on

### H1.1 One project model + uv + profile-in-worktrees — SHIP C
Anchors: `src/modules/project-profile/detect.ts:40-99` (canonical), `agent-dispatch/dispatcher-impl.ts:133-195`, `build-check.ts:67-97`, `seed-methodology-context.ts:553-619`, `substrate-gitignore.ts:24-25`, `contract-verifier.ts:37-60`, `package-snapshot.ts:118-122`, `install-command.ts:42-54`.
- AC1: `uv.lock` (and `[tool.uv]` in pyproject) detected → `buildTool: uv`, `testCommand: uv run pytest`, `installCommand: uv add <package>`, probe interpreter `uv run python`.
- AC2: All four detector sites resolve through the project-profile module (profile first, marker fallback via ONE shared function). BuildCheck's inline copy deleted; `packages/sdlc` gets the shared logic via `@substrate-ai/core` (respect the no-monolith-import constraint noted at `build-check.ts:63-66`).
- AC3: Profile reaches worktrees: gitignore writer emits `!.substrate/project-profile.yaml` AND repairs existing consumer gitignores (same repair pattern as v0.20.131's `computeSubstrateGitignore`); fallback copy-into-worktree at `createWorktree` when untracked.
- AC4: `shouldRunTscCheck` returns false for non-TS profiles; `package-snapshot` install command derives from profile.
- AC5: Fixture evidence (needs H2.1; if H2.1 not yet landed, a temp uv scratch project): profile in worktree, `detectPackageManager` and BuildCheck both resolve `uv run pytest`/skip-correctly.

### H1.2 Real-suite gate + kill the Node prompt fallback — SHIP C
Anchors: new check beside `build-check.ts`; registration `verification-pipeline.ts:197-212`; `dev-story.ts:305`; `packs/bmad/manifest.yaml`; `verification-integration.ts:33-95`.
- AC1: New Tier-A `TestSuiteCheck`: runs profile `testCommand` in the worktree (60s→configurable timeout, process-group kill per FR-V11), fail on non-zero with failing-test tail in findings; warn-skip only when profile has no `testCommand` AND no marker default exists.
- AC2: `verify_command` prompt var: pack `verifyCommand` → profile `buildCommand` → *omit the step*. The literal `'npx turbo build'` fallback is deleted. `DEFAULT_VERIFY_COMMAND` (`agent-dispatch/dispatcher-impl.ts:102`) likewise derives from profile.
- AC3: `context.buildCommand` populated from profile/pack in `assembleVerificationContext` (the dead plumbing goes live).
- AC4: Regression tests: uv fixture with a deliberately failing test → TestSuiteCheck FAIL → story VERIFICATION_FAILED (the finding-#11 regression); passing fixture → PASS with command recorded in findings.

### H1.3 Probe env fidelity — SHIP D
Anchors: `probes/executor.ts:199-224`, `runtime-probe-check.ts:337-358`, `packs/bmad/prompts/probe-author.md`.
- AC1: Probe execution env derives from profile: `uv run`-prefix (or venv activation) wrapping for Python profiles; PATH/VIRTUAL_ENV shaping documented.
- AC2: Probe-author prompt receives the project's canonical interpreter invocation so probes are authored runnable as-written.
- AC3: Test: probe `python -c "import structlog"` on a uv fixture with structlog only in the venv → passes (the finding-#6 regression).

### H1.4 Net-new-implementation gate — SHIP D
Anchors: `orchestrator-impl.ts:3239-3339`, `checkGitDiffFiles` (`agent-dispatch/dispatcher-impl.ts:462-505`).
- AC1: After dev-story, ground-truth diff classified: story-artifact-only (.md under implementation-artifacts) vs source/test/config changes.
- AC2: Non-trivial story (has code-bearing ACs/tasks) with artifact-only diff → escalation `no-implementation` (distinct from zero-diff), never COMPLETE.
- AC3: Finding-#13 regression test: spec-file-only branch + self-reported "tests pass" → escalated.

### H1.5 Contamination gate + commit denylist — SHIP E
Anchors: new check; `git-helpers.ts:65-77` (+ `getGitChangedFiles` `:325-339`).
- AC1: New Tier-A check fails on: (a) new source files whose language ∉ profile language(s); (b) `node_modules/`, `dist/` (non-Node profiles), `.venv/`, `__pycache__/` paths in the diff; (c) new top-level source roots absent at baseline. Config allowlist for legit polyglot.
- AC2: Commit-side denylist in `commitDevStoryOutput` (belt-and-braces; warn-log each exclusion).
- AC3: Finding-#16/#18 regressions: scaffolded package.json+dist on the uv fixture → verification FAIL naming the contamination; node_modules never staged.

### H1.6 Self-report demotion + Gherkin ACs + BuildCheck ordering — SHIP E
Anchors: `acceptance-criteria-evidence-check.ts:24-25,117-154,206-219,255-270`, `source-ac-fidelity-check.ts:184`, `build-check.ts:85-94`.
- AC1: With TestSuiteCheck present, self-reported `tests:` becomes advisory (mismatch vs ground truth → its own finding).
- AC2: Empty-`files_modified` benefit-of-doubt removed from fidelity check.
- AC3: Given/When/Then blocks parsed as ACs (numbered per scenario); `ac-context-missing` upgraded from silent-warn to prominent finding.
- AC4: BuildCheck marker order fixed (non-Node before package.json) + missing-script exemption (parity with gate B) — defense in depth under H1.1's consolidation.

### H1.7 Reward-hack tripwire — SHIP E
- AC1: Deterministic check: diff modifies/deletes pre-existing test files the story didn't create → warn finding `test-mutation` listing files (fail-mode configurable).
- AC2: Unit tests: legitimate new tests (no flag), edited existing test (flag), deleted test (flag).

---

## EPIC H2 — Validation matrix (starts right after H0.1; runs parallel to H1)

### H2.1 Fixture consumer repos — SHIP F
- AC1: `fixtures/consumer-python-uv/` (pyproject+uv.lock+.venv-bootstrap script, tiny package, 3 pytest tests incl. one meaningfully failable), `fixtures/consumer-node-ts/`, `fixtures/consumer-go/`. Each: epics.md + sprint-status.yaml with 2 stories (one clean, one designed to trip verification).
- AC2: Bootstrap script per fixture (`fixtures/<name>/bootstrap.sh`) creating the env in CI.

### H2.2 Stub-agent pipeline e2e in CI — SHIP F
- AC1: Stub adapter (registered like claude/codex/gemini) returning scripted outputs by scenario: success-with-files, no-file, auth-error-signature, contamination (writes package.json+node_modules marker on the Python fixture), zero-implementation.
- AC2: CI job runs `substrate run --stories …` against each fixture×scenario asserting: correct verify/test command chosen per fixture env; commit-first fired (branch advanced even on failures — `wip(` commits); finalization per configured mode; escalation kinds correct (`auth-failure`, `no-implementation`, contamination).
- AC3: <5 min wall-clock; runs on every PR; failures name fixture+scenario.
- AC4: Regression wiring: the H0/H1 story ACs' fixture-evidence assertions live here permanently.

### H2.3 Nightly live smoke — SHIP G
- AC1: Nightly workflow: Python fixture, 1 clean story, real claude dispatch, cost-capped; asserts SHIP_IT→commit→finalize end-to-end; failure notifies via existing notification path.
- AC2: Documented skip/secret strategy for CI auth (subscription CLI auth won't exist in GH runners — likely runs on the workstation via cron/systemd instead of GH Actions; decide and document).

### H2.4 Eval-corpus regression cases — SHIP G
- AC1: Field findings #1,6,7,10,11,12,13,15,16,17,18 encoded as named eval cases in the existing eval harness; gate remains 100%.

---

## EPIC H3 — Deterministic, gated finalization

### H3.1 `finalization.mode: merge|branch|pr` — SHIP H  `[dogfood-eligible after]`
Anchors: `merge-to-main.ts:91`, `orchestrator-impl.ts:4800-4810`, `config-schema.ts:128-160` (strict — extend), `types.ts`.
- AC1: Config key + `--finalization <mode>` CLI flag. `merge` = today's Path A. `branch` = commit, leave `substrate/story-*`, mark COMPLETE with `finalization: branch` in manifest, keep worktree removal (branch is the deliverable). `pr` = branch + `git push` + `gh pr create` (PR body: story title, AC table, verification findings summary); PR-create failure degrades to `branch` with a warning, never blocks.
- AC2: Default: `merge` (backward compat). `substrate init` asks; recommends `branch`/`pr` for repos with existing history (brownfield heuristic).
- AC3: Fixture e2e (H2.2): all three modes exercised on the Python fixture.

### H3.2 Lifecycle events + report — SHIP H
- AC1: `story:committed {sha}`, `story:merged {sha}`, `story:finalized {mode, branch, pr_url?}` emitted at the choke points.
- AC2: `substrate report` per-story row shows finalization state (merged@sha / branch-pending / PR#) — operators never infer from worktree presence (finding #14 ask).

### H3.3 Merge preconditions — SHIP I
Anchors: `merge-to-main.ts:157-218`, `orchestrator-impl.ts:5794-5805`.
- AC1: Pre-merge: parent working tree must be clean of files intersecting the story's diff → dirty → escalate `parent-tree-dirtied-by-run` naming files (the finding-#15 truthful escalation), do NOT merge.
- AC2: 3-way fallback behind config (`merge_strategy: ff-only|three-way`), default ff-only.
- AC3: Start-branch capture failure = fatal at run start (was: silent per-run merge disable).

### H3.4 Epic gate hook — SHIP I  `[dogfood-eligible]`
- AC1: Optional `finalization.epic_gate_command`: must exit 0 before the last story of an epic finalizes in merge/pr mode; non-zero → halt with output in escalation.
- AC2: Fixture test with passing/failing gate commands.

---

## EPIC H4 — Isolation that can't leak

### H4.1 Git-state scoping at spawn — SHIP J
Anchors: `packages/core/src/dispatch/dispatcher-impl.ts:585,626-648`.
- AC1: Child env scrubbed of `PWD`,`OLDPWD`,`INIT_CWD`,`GIT_DIR`,`GIT_WORK_TREE`,`GIT_INDEX_FILE`,`GIT_COMMON_DIR`; `GIT_CEILING_DIRECTORIES` set to the worktree's parent dir.
- AC2: `workingDirectory` required for coding-task dispatches — the `process.cwd()` fallback removed (fail loud); planning tasks may keep an explicit cwd.
- AC3: Test: spawned child (stub) printing `env` shows scrubbed vars; `git rev-parse --show-toplevel` from inside the worktree still resolves the worktree.

### H4.2 External worktree base — SHIP J
Anchors: `git-utils.ts:248` (hardcode bug), `git-worktree-manager-impl.ts:47,422-424`.
- AC1: `baseDirectory` honored end-to-end (fix the createWorktree hardcode) — the latent create-here/clean-there bug dies regardless of default.
- AC2: New default base: outside the parent tree (`<projectRoot>/../.substrate-worktrees-<projectname>/` or `~/.substrate/worktrees/<hash>/`) behind config `worktree.base: external|in-repo`; `in-repo` retained for compat. Migration note for tooling that assumed the old path.
- AC3: Fixture e2e green under external base (artifacts dir, probes cwd, build gate, merge all path-agnostic — they already flow through `effectiveProjectRoot`).

### H4.3 Permission-scoped dispatch experiment — SHIP K (experiment, then decision)
Anchors: `claude-adapter.ts:194-244`.
- AC1: Behind `dispatch.permission_profile: skip|scoped`: `scoped` generates a per-worktree settings file (Edit/Write allowed only under the worktree; Bash allowed; parent-path deny) and drops `--dangerously-skip-permissions` for `--permission-mode acceptEdits` + `--settings <file>`.
- AC2: Measured comparison on fixture matrix + ≥1 real story: dispatch success rate, permission-stall timeouts, wall-clock. Results recorded in ledger.
- AC3: Decision recorded: flip default or keep `skip` (with rationale). No default flip without AC2 evidence.

### H4.4 Container-ready seam — SHIP K
- AC1: `SpawnCommand.executionMode?: 'spawn' | 'container'` typed (mirrors the direct-API adapter design); doc `docs/` note mapping GitWorktreeManager+dispatcher seams to a future bind-mount container backend; lint/review rule: no new direct-fs worktree access outside the enumerated sites.

---

## EPIC H5 — Operator experience + long tail

### H5.1 Finding #7 root cause — SHIP L
- AC1: With H0.4 forensics, reproduce the multi-story fast-fail; confirm/refute the OAuth-refresh-race hypothesis (H1) vs NODE_OPTIONS heap cap (H2 — scope the 512MB cap to non-CLI children as a cheap test).
- AC2: Fix per diagnosis (serialize first dispatch per run / auth-refresh mutex / cap scoping); multi-story fixture run green ×3 consecutive.

### H5.2 Field residue — SHIP L
- AC1: `substrate init` creates `.claude/commands/` substrate skills reliably, incl. when `.claude/` exists/gitignored (#2).
- AC2: telemetry `efficiency_scores` INSERT warn eliminated or downgraded w/ cause (#3).
- AC3: report header cost aggregation correct under subscription routing (#4).
- AC4: init droppings (AGENTS.md/GEMINI.md/packs) documented in gitignore guidance or relocated (#5).
- AC5: probe summary line separates real-run vs twin-deferred counts (#9).

### H5.3 Docs-match-behavior gate — SHIP M
- AC1: Consumer CLAUDE.md template's finalization/worktree/autonomy sections regenerated or checked against the code paths they describe; ship checklist item: changes to finalizeStory/merge-to-main/verification registration require the template diff in the same PR.

### H5.4 (stretch) Architecture-conformance check
- Design doc first; deterministic subset (new top-level roots vs declared architecture doc). May slip past H6.

---

## H6 — FINAL GATE (program acceptance)

Re-run a real multi-story batch (income-sources remaining stories, or a comparable ≥10-story project) fully unattended:
`substrate run --halt-on none --non-interactive --events --finalization branch` (or `pr`).
- **Pass criteria:** zero operator hand-lands; zero parent-tree leaks; zero false-completes (every COMPLETE story has real, tested, in-env-verified implementation on its branch); every story's end state explicit in `substrate report`; any failures escalated with correctly-classified kinds and recoverable branches.
- Write the outcome as a dated field-feedback file (the 2026-07-04 pattern) regardless of result. If pass → program complete; write closure memory. If fail → new findings become ledger items; iterate.

---

## Session protocol (what the goal prompt enforces)

1. **Orient:** read LEDGER.md; `git status` + `git log --oneline -3`; confirm clean main (stash/hand-off if not); `pgrep -f vitest` empty.
2. **Pick:** first story in ledger order whose status ≠ done and whose dependencies are done. In-progress story from a prior session resumes first (read its ledger notes).
3. **Mark in-progress** in ledger (with session date) before coding.
4. **Implement:** re-locate anchors by symbol (lines drift); tests with the code; `npm run test:changed` → `test:fast` while iterating.
5. **Ship** when a ship-batch boundary is reached: `/ship` skill end-to-end (full `npm test`, build, eval gate, dist smoke when CLI surface changed, version bump, tag).
6. **Record:** ledger row → done, with version, evidence (test names / fixture output / manifest fields), deviations. Ledger change ships in the same commit.
7. **Loop** until the session's effort budget is spent or a genuine blocker; on blocker: write it in the ledger's Blockers section with everything the next session needs, then continue with the next unblocked story.
8. **Never:** mark done without evidence; run bare `substrate` to test local changes (`npm run substrate:dev` for that); dispatch substrate-on-substrate before H0 ships; batch two unrelated epics into one ship.
