---
description: Run the substrate implementation pipeline (guided)
---

Run the substrate pipeline for this project.

**Before dispatching, confirm scope with the user if they did not name stories.** Without `--stories`, substrate auto-discovers ALL pending stories and may dispatch 30+ at once.

Steps:

1. If the user named stories (e.g. "1-1,1-2"), run:
   `substrate run --events --stories <keys>`
   Otherwise ask which stories to run, or confirm a full auto-discovery run is intended.
2. Pipeline runs take 5–40 minutes. Use a background invocation or a timeout of at least 10 minutes — the default 2-minute tool timeout WILL kill the pipeline. NEVER pipe substrate output through `head`/`tail`/`grep` (EPIPE stalls).
3. Poll `substrate status --output-format json` every 60–90s while it runs; `substrate health --output-format json` if it goes quiet for 15+ minutes.
4. When it completes, summarize per-story outcomes and run `substrate report --run latest`.

Autonomy: default halts on critical+fatal. For fully autonomous runs use:
`substrate run --halt-on none --non-interactive --events --output-format json`

$ARGUMENTS
