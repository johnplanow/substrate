# H6 Conclusive Final Gate — v0.21.1 (2026-07-06)

**Verdict: PASS (exit 0, unambiguous).** `gatePass: true` — exit 0 AND every check green AND zero escalations.

## Why a second gate run

The first H6 gate (v0.20.151) and the post-remediation batch (v0.21.1) both met the literal DONE criteria (zero hand-lands / parent-tree leaks / false-completes) but returned exit 1, because both included the fixture's Story 1.2 — a **deliberate verification-trip story authored for the stub matrix** (its AC3 is an un-evidenceable harness note). A real agent structurally cannot evidence it, so it truthfully escalates `ac-missing-evidence`, forcing a non-exit-0 run. A truthful escalation is the opposite of a false-complete, so the criteria were met — but exit 1 muddied the certification. This run removes the ambiguity by certifying on 10 stories a real agent can actually complete.

## Setup
- Substrate **v0.21.1** (repo dist, includes the disclosure-gate path-reconciliation hotfix).
- Fixture extended with Story 1.11 (`greet_all`) → 10 clean-capable stories: 1-1, 1-3..1-11 (1-2 excluded).
- Config: `finalization.merge_strategy: three-way`, `dispatch.permission_profile: scoped`. Invocation: `--non-interactive --halt-on none --output-format json`. Fully unattended.

## Result (33 min)

| Metric | Result |
|---|---|
| Exit code | **0** |
| `succeeded` | **10/10** (1-1, 1-3..1-11) |
| `escalated` / `failed` | **[] / []** |
| Parent working tree after run | **clean** |
| `uv run pytest` on main after 10 three-way merges | **green** |
| Hand-lands | **0** |
| `undisclosed-files-in-merge` false escalations | **0** — the v0.20.153 regression (absolute vs relative disclosed paths) is confirmed closed at real-agent scale: 10 real agents, all reporting absolute `files_modified`, all reconciled and merged |

Raw report: `_planning/2026-07-06-h6-conclusive-gate-report.json`.

## Program status

H6 satisfied conclusively. The Substrate Hardening Program + H7 trust-boundary remediation + the independent-review fixes are complete and certified against a real-agent multi-story batch on the shipped build. Remaining known items (all documented, none blocking): the exit-code-overstatement follow-up (H6 obs #1 — a truthful escalation returns exit 1; correct per the documented contract, but operators keying on exit codes should read `escalated`), the container backend (deliberately deferred, docs honest), and two default-adjacent live gaps (real `gh pr create`, auth-halt paths — stub/unit-only).
