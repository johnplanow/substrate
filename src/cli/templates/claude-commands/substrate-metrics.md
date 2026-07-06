---
description: Show substrate run metrics and the latest completion report
---

Report on substrate pipeline outcomes for this project:

1. `substrate report --run latest` — per-story outcomes, cost, escalation diagnostics, halt notifications. Add `--verify-ac` for the AC-to-test traceability matrix.
2. `substrate metrics --output-format json` — historical run metrics.

Summarize conversationally: how many stories verified/recovered/escalated/failed, total cost, and anything the operator must act on (escalations, halts, unmerged deliverable branches listed under "Finalization").

$ARGUMENTS
