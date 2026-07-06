---
description: Attach the substrate supervisor to an active pipeline run
---

Attach the substrate supervisor to the pipeline run that is active in this project:

`substrate supervisor --output-format json`

Notes:
- The supervisor monitors an active run (stall detection, kill-and-restart recovery, post-run analysis) — it does NOT start one. Start the run first (see /substrate-run).
- Only attach to runs started in this session; attaching to another session's run risks killing healthy dispatches.
- Long-running: use a background invocation or a generous timeout.
- After the run, read the analysis with `substrate metrics --analysis <run_id> --output-format json`.

$ARGUMENTS
