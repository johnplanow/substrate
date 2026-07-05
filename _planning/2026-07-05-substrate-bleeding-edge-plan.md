# Substrate bleeding-edge plan — keep, harden, and lead (2026-07-05)

Companion to `_planning/2026-07-05-substrate-remediation-audit.md` (the audit: what's broken, where, and why every fix is CONFIG/WIRING). This document is the *plan*: the decision is keep-and-harden, so what does substrate have to become — and in what order — to be the best tool in existence for what we actually do with it?

**What we actually do with it** (the design target, from the field): an operator drives multi-story autonomous runs via a Claude Code session against real consumer projects — currently Python/uv (income-sources), historically TS (strata, substrate itself) — using externally-authored BMAD corpora, subscription-routed Claude agents, with the operator asleep for most of the run. The product is *trustworthy unattended story completion*: when substrate says a story is done, it is done, committed, and integrated the way the config says it should be.

---

## 1. North star: own all four pillars at once

The 2026-07-05 landscape research's core finding: **no tool is simultaneously strong on verification, isolation, and finalization** — each leader owns one. Copilot coding agent owns finalization (branch-scoped, can't self-merge, CI+human gated). OpenHands/SWE-agent own verification (real suite, real toolchain, in-sandbox). container-use owns isolation (container + branch per agent). Nobody owns multi-story orchestration *plus* any of them — that's substrate's open lane.

Bleeding edge therefore = **the strongest published pattern on each axis, wired into the multi-story orchestrator substrate already has**:

| Pillar | Reference standard | Substrate today | Substrate target |
|---|---|---|---|
| Verification | OpenHands: real tests, real toolchain, ground truth | 8 deterministic checks, none of which run the project's tests; trusts agent self-report | Real-suite gate in the project's real env + net-new-implementation gate + contamination gate; LLM review layered *on top of* ground truth, never instead of it |
| Isolation | container-use: container + branch per agent | cwd-only scoping, nested worktrees, inherited env, skip-permissions | Phase 1: git-state-scoped worktrees (leak class dead); Phase 2: opt-in container-per-story behind the existing `GitWorktreeManager` seam |
| Finalization | Copilot: agent structurally cannot self-merge | Commit+merge on 1 of 4 verdict paths; no config; local 3-way merge to whatever branch the run started on | Deterministic `finalization.mode: merge\|branch\|pr`; commit-always discipline; explicit lifecycle events; self-merge an *opt-in* for greenfield, not the default |
| Orchestration | (substrate's own lane) | Multi-story dispatch, recovery engine, supervisor, events — genuinely ahead of the OSS cohort | Keep; protect with the validation matrix in §4 so the lead is durable |

Everything below is sequenced to get there in ~6 working weeks of focused effort, front-loaded so the destructive failure modes die in week 1.

---

## 2. Phase 0 — stop the bleeding (days 1–3)

Goal: **no run can destroy work or report success on stranded work.** These are the audit's P0-1/P0-2 plus the forensic gap that made #7/#10 cost two nights.

| Item | What ships | Anchors | Effort |
|---|---|---|---|
| 0.1 Commit-first | `commitDevStoryOutput` fires immediately after dev-story returns (before review/verify); `wip(story-…): <reason> snapshot` checkpoint commit on every escalation/VERIFICATION_FAILED path; `baselineHeadSha` + `commit_sha` persisted to `per_story_state` (full revision bracket — the BMAD dev-auto primitive) | `orchestrator-impl.ts:3249` (insert), `:4012-4033`, `:4629-4635` (relocate), `per-story-state.ts:139` | 1d |
| 0.2 Finalization unification | Extract the `:4615-4852` commit/merge block into `finalizeStory()`; call it from Path A *and* both auto-approve sites (`:4988`, `:5223`). Auto-approved ⇒ same commit+integration as SHIP_IT | `orchestrator-impl.ts:4475,4615-4852,4988,5223` | 1d |
| 0.3 Dirty-guard on removal | `cleanupWorktree` refuses (or auto-checkpoints) when the worktree has uncommitted changes; `--force` only via explicit operator flag | `git-utils.ts:402-414`, `git-worktree-manager-impl.ts:200-240` | 0.5d |
| 0.4 Dispatch forensics | Persist `stderrTail` + exit code on *every* failed dispatch (not just spawnsync-timeout); auth-signature classifier `detectClaudeAuthFailure` (mirror `detectCodexSandboxBlock`) routed as **critical → halt run** through the Decision Router; `unsetEnvKeys` added to `buildPlanningCommand` | `packages/core/src/dispatch/dispatcher-impl.ts:758-771,922-949`; `orchestrator-impl.ts:1941-1975`; `claude-adapter.ts:365-393` | 1d |

**Exit criteria:** (a) kill -9 the orchestrator at any point mid-run → every dispatched story's work is recoverable from its branch ref alone; (b) a stale `ANTHROPIC_API_KEY` in the operator shell halts the run at the *first* failed dispatch with an `auth-failure` escalation naming the fix; (c) re-running the #17 scenario (verification-failed story) leaves a `wip(…)` commit on the branch.

## 3. Phase 1 — verification you can bet the merge on (days 4–10)

Goal: **"complete" is backed by ground truth executed in the project's real environment.** This is the field's #1 failure and the industry's best-documented one (42% false-pass in the June-2026 hidden-test study). Order matters: 1.1 unblocks everything else.

| Item | What ships | Anchors | Effort |
|---|---|---|---|
| 1.1 One project model | Consolidate the **four divergent detectors** (profile `detect.ts`, gate-B `detectPackageManager`, BuildCheck `detectBuildCommand`, `detectTestPatterns`) onto the project-profile module as single source of truth; add `uv` (uv.lock → `uv run pytest` / `uv run python` / `uv add`); profile ships into worktrees (gitignore negation `!.substrate/project-profile.yaml` or copy at `createWorktree`) | `detect.ts:40-99`; `agent-dispatch/dispatcher-impl.ts:133-195`; `build-check.ts:67-97`; `seed-methodology-context.ts:553-619`; `substrate-gitignore.ts:24-25` | 1.5d |
| 1.2 Real-suite gate | New Tier-A `TestSuiteCheck`: run profile `testCommand` in the worktree, fail on red, findings carry the failing-test tail. Registered before `SourceAcFidelityCheck`. `verify_command` prompt var and `context.buildCommand` both derive from the same profile — the `npx turbo build` fallback dies (`verifyCommand: false` interim in `packs/bmad/manifest.yaml`) | new check beside `build-check.ts`; `dev-story.ts:305`; `verification-integration.ts:69-95`; registration `verification-pipeline.ts:197-212` | 1.5d |
| 1.3 Probe env fidelity | Probe executor wraps commands per profile (venv activation / `uv run` prefix) or shapes `PATH`/`VIRTUAL_ENV`; probe-author prompt told the project's interpreter invocation so probes are *authored* correctly too | `probes/executor.ts:204-224`; `packs/bmad/prompts/probe-author.md` | 0.5d |
| 1.4 Net-new-implementation gate | Non-trivial story whose ground-truth diff (already at `orchestrator-impl.ts:3247`) contains no non-markdown source/test change → fail verification, escalate `no-implementation` | `orchestrator-impl.ts:3239-3339` | 1d |
| 1.5 Contamination gate | New Tier-A check: fail on (a) new source files in a language outside the profile, (b) denylisted paths (`node_modules/`, `dist/`, `.venv/`, `__pycache__/`) in the diff, (c) new top-level source roots not present at baseline. Plus the commit-side denylist as belt-and-braces | new check; `git-helpers.ts:65-77,325-339` | 1d |
| 1.6 Self-report demotion | AC-evidence check: self-reported `tests: pass` downgraded to advisory once 1.2 exists (ground truth supersedes); kill the empty-`files_modified` benefit-of-doubt (`source-ac-fidelity-check.ts:184`); Gherkin G/W/T parser so BMAD-style ACs get real coverage; BuildCheck ordering fix (pyproject before package.json) + missing-script exemption for defense in depth | `acceptance-criteria-evidence-check.ts:24-25,117-154,255-270`; `build-check.ts:85-94` | 1d |
| 1.7 Reward-hack tripwire | Cheap, high-signal: flag (warn → operator-visible) any story whose diff *modifies or deletes existing test files* it didn't create — the measured agent exploit pattern (test-editing to go green). Deterministic diff inspection, no LLM | new check or fold into 1.5 | 0.5d |

**Exit criteria:** (a) story 1-4's scenario (failing pytest in worktree) → VERIFICATION_FAILED, never ALL-PASS; (b) story 2-3's scenario (spec-only branch) → `no-implementation` escalation; (c) story 4-2's scenario (parallel `src/` package + own DB) → contamination fail before any merge; (d) on a clean uv fixture, all six-plus-new checks run green with `uv run pytest` visibly in the manifest evidence.

## 4. Phase 2 — the validation matrix (days 8–14, overlaps Phase 1)

Goal: **make it structurally impossible to ship a consumer-stack regression again.** The entire #6–#18 class existed because substrate's 10,795-test suite never runs the *pipeline* against a *non-Node* consumer. This is the same lesson as the v0.20.131→137 CLI-version arc, one level up: *empirical testing against the operator's real stack, not just any stack* — extended from CLI versions to project types.

| Item | What ships | Effort |
|---|---|---|
| 2.1 Fixture consumer matrix | Three minimal fixture repos in-tree (`fixtures/consumer-python-uv/`, `consumer-node-ts/`, `consumer-go/`), each with a real (tiny) test suite, one epic, two stories — one implementable, one designed to fail verification | 1d |
| 2.2 Pipeline e2e harness | CI job: full `substrate run` against each fixture with a **stub agent adapter** (deterministic scripted outputs — success, no-file, auth-error-signature, contamination, zero-impl) asserting: correct verify command executed *in the fixture's env*, commit-first fired, finalization mode honored, escalations classified correctly. Fast (<2 min), runs on every PR | 2d |
| 2.3 Nightly live smoke | The Python fixture run nightly with a *real* claude dispatch (1 story, capped cost), asserting end-to-end SHIP_IT→commit→finalize; failures page via the existing notification path. This is the standing version of "force a path-end-to-end test before declaring the path-end fixed" | 1d |
| 2.4 Eval corpus regression | Encode findings #1, #6, #7, #11, #12, #13, #15, #16, #17, #18 as named cases in the existing eval harness (`_bmad-output/eval-results/` machinery) so the 100%-eval gate actually covers the field-failure class | 1d |

**Exit criteria:** a PR that reintroduces `npm run build` on the Python fixture, or skips commit on an auto-approve path, goes red in CI — no human vigilance required.

## 5. Phase 3 — deterministic, gated finalization (days 12–17)

Goal: **adopt the Copilot contract, adapted for an unattended operator.** The agent side can never self-merge unless the operator explicitly configured that; every outcome is an explicit event, never inferred from worktree presence.

| Item | What ships | Anchors | Effort |
|---|---|---|---|
| 3.1 `finalization.mode` | Config key + CLI flag: `merge` (today's behavior — greenfield), `branch` (commit + leave `substrate/story-*`; branch is the deliverable), `pr` (push + `gh pr create`, one PR per story, description carries AC-to-evidence table + verification transcript). **Default flips to `branch` for brownfield** (repo has >N commits or a configured default branch protection), stays `merge` for greenfield init | `merge-to-main.ts:91`; `orchestrator-impl.ts:4800-4810`; `config-schema.ts:128-160` | 2d |
| 3.2 Lifecycle events | `story:committed {sha}`, `story:merged {sha}`, `story:finalized {mode, branch, pr_url?}` emitted at the choke points; `substrate report` renders finalization state per story — operators stop inferring from worktree presence (#14's ask) | `merge-to-main.ts`, `report.ts:301` | 0.5d |
| 3.3 Merge preconditions | Before any merge: parent tree must be clean (detect the #15 leak *before* it corrupts an integration — surface `parent-tree-dirtied-by-run`, not `merge-conflict`); ff-only preferred, 3-way only behind config; start-branch capture failure becomes a **fatal** at run start, not a silent per-run merge disable | `merge-to-main.ts:157-218`; `orchestrator-impl.ts:5794-5805` | 1d |
| 3.4 Epic gate hook | Optional configured command (or agent dispatch) that must pass before `merge`/`pr`-mode finalization of the *last* story in an epic — the operator's hand-built adversarial epic gate, productized. Deterministic-first: command exit code, then optional LLM review | new; rides Decision Router | 1d |

**Exit criteria:** on the income-sources config (`mode: pr` or `branch`), a full batch run ends with zero merges to main, one branch/PR per story, every story's state explicit in `substrate report` — and a `merge`-mode greenfield run behaves exactly like today's Path A for every verdict path.

## 6. Phase 4 — isolation that can't leak (days 15–22)

Goal: **kill the leak class in-place now; buy the container option cheaply for later.** Sequenced after finalization because commit-first + branch-mode already removed the data-loss sting; this phase removes the corruption vector itself.

| Item | What ships | Anchors | Effort |
|---|---|---|---|
| 4.1 Git-state scoping | At the single spawn seam: scrub `PWD`/`OLDPWD`/`INIT_CWD`/`GIT_*` from the child env; set `GIT_CEILING_DIRECTORIES` to the worktree's parent; remove the `process.cwd()` fallback (`workingDirectory` becomes required for coding dispatches — fail loud, not leak) | `packages/core/src/dispatch/dispatcher-impl.ts:585,626-648` | 1d |
| 4.2 External worktree base | Move worktrees outside the parent tree (`~/.substrate/worktrees/<project-hash>/<key>` or sibling dir): `../..` no longer resolves to the parent repo, ancestor CLAUDE.md discovery can't climb into it. Fix the `git-utils.ts:248` baseDirectory hardcode as part of this. Config-compatible fallback to in-repo base for tooling that assumes it | `git-utils.ts:248`; `git-worktree-manager-impl.ts:47,422-424` | 1d |
| 4.3 Permission-scoped dispatch experiment | Measured experiment (fixture matrix + one real story): replace `--dangerously-skip-permissions` with a generated per-worktree `settings.json` (allowlist: Edit/Write scoped to the worktree, Bash allowed, deny parent paths) + `--permission-mode acceptEdits`. If dispatch quality holds (eval corpus green, no permission-stall timeouts), flip the default; keep skip-permissions as config escape hatch. This is the *only* true confinement available without containers | `claude-adapter.ts:194-244` | 2d |
| 4.4 Container-ready seam audit | No container build yet — just guarantee the swap stays bounded: document/enforce that all worktree consumption goes through `GitWorktreeManager` + `effectiveProjectRoot`, and add `SpawnCommand.executionMode: 'spawn' \| 'container'` typed stub (mirrors the direct-API adapter design already filed). Container-per-story (bind-mount model, container-use-style) becomes a ~1wk future project, not a rewrite | `git-worktree-manager.ts:80-149`; `packages/core/src/adapters/types.ts` | 0.5d |

**Exit criteria:** the #55708-class repro (agent runs `git switch`/absolute-path write toward the parent) either fails inside the child (4.3) or lands in the scoped repo, never the parent (4.1/4.2); parent-tree cleanliness precondition (3.3) never trips across the fixture-matrix nightly for two weeks.

## 7. Phase 5 — operator experience + the long tail (days 20–28)

The findings that don't threaten integrity but burn trust and operator minutes — plus the #7 root-cause chase, now cheap because Phase 0.4 gave us the forensics.

- **5.1 #7 root cause**: with stderrTail persisted, re-run the multi-story repro; if the OAuth-refresh-race hypothesis (H1) confirms, serialize the first dispatch per run (or take a lock around CLI auth refresh); if H2 (the injected 512MB `NODE_OPTIONS` heap cap OOMing the CLI), scope that cap to non-CLI children. (0.5–1d once data lands)
- **5.2 Field-feedback residue**: `substrate init` creating `.claude/commands/` reliably (#2); telemetry `efficiency_scores` INSERT warns (#3); report header cost aggregation with subscription routing (#4); init droppings documented or relocated under `.substrate/` (#5); twin-probe summary line honesty (#9). (1.5d total)
- **5.3 Docs-match-behavior gate**: the consumer CLAUDE.md template and README claims regenerate from the same source of truth as the code where feasible (finalization contract, autonomy modes, worktree behavior) — the #1 field finding was partly a *contract* violation. Add a docs check to the ship checklist: any change to `finalizeStory`/`merge-to-main`/verification registration requires the CLAUDE.md template diff in the same PR. (1d)
- **5.4 Architecture-conformance check (stretch)**: when a consumer declares an architecture doc, verify new stories' structure against it (package roots, persistence layers) — the deeper #16 ask and the field's 1-1 residue (package layout, requires-python pin). Design-first; deterministic subset only. (2d, can slip)

## 8. Standing disciplines (process, not code)

These extend the empirical disciplines already in memory (CLI-version matching, path-end-to-end testing) to the new surface this incident exposed:

1. **Consumer-stack empiricism**: any change to detection, prompts' toolchain instructions, verification checks, or the commit/merge path must show a fixture-matrix run (Phase 2 makes this a CI gate, but the discipline is: *the author looks at the Python fixture output*, not just the green check).
2. **Contract changes ship with their docs** (5.3) — CLAUDE.md template + README in the same PR.
3. **Field-feedback loop stays hot**: every operator run of a consumer project ends with a dated findings file (as 2026-07-04 did); HIGH findings become eval-corpus cases within one ship cycle. The 19-findings file is the most valuable artifact this project has produced — institutionalize it.
4. **Bleeding-edge watch, quarterly**: re-check the three reference implementations (Copilot finalization contract changes, OpenHands' orchestration drift into our niche, container-use/Sculptor maturity) and Claude Code native primitives (worktree isolation semantics, hooks, Agent SDK) — adopt native primitives where they retire substrate code (candidate: hooks-as-verification-gates inside the dispatched session, complementing our post-hoc checks).
5. **No new detection logic outside the project-profile module** (1.1's consolidation is only durable if enforced) — lint rule or review checklist item.

## 9. What we're deliberately NOT doing (and when to revisit)

- **Container-per-story now** — commit-first + scoping + external worktree base removes the observed failure class at ~1/10th the cost. Revisit when: multi-tenant/hostile-input use, or 4.3's experiment fails (skip-permissions must stay), or parallel runs start trampling shared runtime state (ports/DBs).
- **Rebuild on Claude-Code-native primitives (Dynamic Workflows/Agent SDK)** — the audit found the architecture sound and the seams good; a rebuild trades a known, instrumented codebase for bus-factor optics. Revisit when: Anthropic ships git-state-scoped worktree isolation natively, or a native scheduler, or maintenance economics change. Adopt native primitives *incrementally* (§8.4) instead.
- **Digital-twin (`sandbox: twin`) probes** — stays Phase-3-roadmap as designed; real-suite gate (1.2) covers the need that twin probes were inflating counts for.
- **Direct-API Codex adapter** — already filed separately; unrelated to this hardening arc.

## 10. Sequencing summary

```
Week 1:  Phase 0 (0.1→0.4)                       ← destructive class dies
Week 2:  Phase 1 (1.1→1.4) + Phase 2 start (2.1) ← verification trust
Week 3:  Phase 1 finish (1.5→1.7) + Phase 2 (2.2→2.4)
Week 4:  Phase 3 (finalization modes + events + preconditions)
Week 5:  Phase 4 (isolation scoping + permission experiment)
Week 6:  Phase 5 (operator polish, #7 root cause, docs gate) + buffer
Gate:    re-run income-sources remaining stories (or a comparable 10-story
         batch) fully unattended in `branch` mode → target: zero hand-lands,
         zero leaks, zero false-completes, every story's state explicit.
```

That final gate is the whole point: the 2026-07-04 run needed operator rescue on ~8 of 19 findings' worth of incidents. The plan is done when the same class of run needs none.

## Recommended defaults (decisions embedded in this plan)

- `finalization.mode` default: **`branch` for brownfield, `merge` for greenfield-init projects** — never-self-merge as the safe default, self-merge as informed opt-in.
- Permission-scoped dispatch (4.3): **flip the default only on eval-corpus + fixture evidence**, keep `--dangerously-skip-permissions` as escape hatch.
- Worktree base: **external by default** after 4.2, in-repo retained behind config for compatibility.
