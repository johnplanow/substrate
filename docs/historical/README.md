# Historical findings reports

Frozen artifacts from past pipeline runs. Each file is dated and scoped to a specific run / epic, kept here for forensic reference (debugging, retrospectives, "did we ever see this before?").

These are NOT operational documentation — for current substrate behavior, see the top-level [`README.md`](../../README.md), [`AGENTS.md`](../../AGENTS.md), and [`docs/pipeline-workflows.md`](../pipeline-workflows.md).

## Contents

| File | Source | Date |
|---|---|---|
| `findings-cross-project-epic4-2026-03-05.md` | ticketing-platform/code-review-agent Epic 4 run | 2026-03-05 |
| `findings-cross-project-cra-epic4-sprint2-2026-03-07.md` | ticketing-platform/code-review-agent Epic 4 stories 4-5 & 4-6 | 2026-03-07 |
| `findings-epic30-run-2026-03-14.md` | substrate self-hosting, Epic 30 (Telemetry-Driven Optimization) | 2026-03-14 |
| `workflow-gap-analysis.md` | BMAD workflow → substrate equivalent mapping + integration gaps as of v0.2.19 | 2026-03-06 |

If a findings report leads to substrate-side work, the resulting code change references the report in its commit message; the report itself stays here as the historical record of how the issue was discovered.

The `workflow-gap-analysis.md` was an early integration-readiness review of which BMAD methodology workflows substrate had implemented vs. the open gaps. Most of its identified gaps have since closed (probe-author / Epic 60, AC-evidence verification gate / Epic 56, retry-escalated / Story 60-15+v0.20.8, etc.). Epic 54 (Phase D autonomous operations) remains open as of v0.20.46 — for current Epic 54 status, see the Phase D epic doc at `_bmad-output/planning-artifacts/epics-and-stories-phase-d-autonomous-operations.md` and the work graph (`substrate epic-status 54`).
