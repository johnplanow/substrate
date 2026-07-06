# H6 Final Gate — unattended 10-story batch (2026-07-06)

**Verdict: PASS.** Zero hand-lands, zero parent-tree leaks, zero false-completes.

## Setup

- Substrate v0.20.151 (repo dist), python-uv fixture extended to 10 stories (1-1..1-10, all mutating `src/greeter/__init__.py` — deliberately same-surface to exercise sequential conflict-group batching and repeated merges into a moving main).
- Config: `finalization.merge_strategy: three-way` (per H3.3 — required for multi-story merge sequences), `dispatch.permission_profile: scoped` (per the H4.3 decision, to accumulate batch-scale evidence).
- Invocation: `substrate run --events --stories 1-1..1-10 --non-interactive --halt-on none --output-format json`. Fully unattended — no operator interaction between launch and completion.
- Workspace: `/tmp/h6-gate-run1`; run `5e7d45f8`; wall clock **34 minutes**; report `h6-report.json`.

## Outcomes

| Metric | Result |
|---|---|
| Verified + merged | 9/10 (1-1, 1-3..1-10) |
| Failed (truthfully, durable branch) | 1/10 (1-2, `ac-missing-evidence`) |
| Escalated | 0 |
| Parent working tree after run | **clean** (`git status --porcelain` empty) |
| `uv run pytest` on main after all merges | **green** |
| Hand-lands (story neither merged nor on a durable branch) | **0** |
| Parent-tree leaks (findings #15/#17/#20 class) | **0** |
| False-completes (findings #13 class) | **0** — every merged story's feat commit contains implementation + tests |

## The one non-merge, examined

Story 1-2's branch carries a complete, correct implementation (`shout()` + test, commit `ac73b1f`). Verification failed it with `ac-missing-evidence` because the fixture's AC3 reads "NOTE (harness contract, not an AC for the agent): stub-agent scenarios drive this story into verification failures…" — a live agent has nothing to evidence for it. **This is the AC-evidence gate firing correctly on an un-evidenceable AC**, with exactly the designed failure posture: no merge, work durable on the branch, reason named in the manifest. In the income-sources era this shape produced hand-lands or destroyed work; here recovery is one `git merge substrate/story-1-2` after a human judgment call.

Kept as-is in the fixture: it now doubles as a live adversarial case proving the gate fires outside the stub matrix.

## Contrast with the 2026-07-04 income-sources run (the program's origin)

That 19-finding run produced: uncommitted worktrees requiring manual lands (most stories), two destroyed implementations (#17/#19), parent-tree leaks (#15/#20), architectural contamination self-merged to main (#16/#18), a false-complete (#13), and non-deterministic finalization (#14). This batch — 2.5× the story count, same stack, fully unattended — produced none of those classes.

## Minor observations filed (not gate-blocking)

1. **Exit code 2 for a verification-failed story.** The documented contract is `0` all-succeeded, `1` some escalated, `2` run-level failure. A `verification-failed` story (status `failed`, not `escalated`) drove exit 2, which overstates severity — an operator script keying on "2 = run died" would misread a healthy run with one truthful verification failure. Candidate: classify per-story verification failures under exit 1.
2. **`scoped` permission profile at batch scale (H4.3 flip evidence):** ~50 real dispatches across create-story/test-plan/dev-story/code-review/test-expansion task types, zero permission-related failures or stalls, wall-clock indistinguishable from the skip profile's per-story baseline. Combined with the 2-arm experiment, the evidence now supports flipping the default to `scoped` in a future minor version (kept `skip` this program; flip is a one-line config-schema default + doc change).
3. Sequential conflict-group batching (all 10 stories same-surface) worked as designed: three-way merges landed 9 stories onto a main that advanced 9 times, no conflicts, no `ff-only` blocks (strategy was `three-way`).

## Program capstone

With H6 passed, the Substrate Hardening Program is complete: 27 ledger rows resolved (H5.4 stretch deferred), 12 versions shipped (v0.20.139, 141–151), two tag recoveries with zero bad npm publishes, a 12-cell fixture matrix enforcing the failure taxonomy on every PR, and a nightly live smoke with its first PASS recorded. The keep-and-harden bet from the 2026-07-05 audit is validated: every fix was config/wiring; the architecture held.
