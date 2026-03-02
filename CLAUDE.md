## Dev Workflow — Testing Local CLI Changes

**IMPORTANT:** The `substrate` command is a globally installed published version — it does NOT run your local changes.

To test local CLI changes:
1. Build first: `npm run build`
2. Run via: `npm run substrate:dev -- <args>`

Example: `npm run substrate:dev -- run --events --stories 10-1`

**Never run bare `substrate` to test local changes.** It will silently use the published version, not your code.

<!-- substrate:start -->
## Substrate Pipeline

This project uses Substrate for automated implementation pipelines.

### Quick Start
- Run `substrate run --help-agent` to get full pipeline interaction instructions
- Run `substrate run --events` to execute the pipeline with structured event output
- Run `substrate run --events --stories 7-1,7-2` to run specific stories

### Agent Behavior
- On story escalation: read the flagged files and issues, propose a fix, ask the user before applying
- On minor fix verdict: offer to fix automatically
- Never re-run a failed story without explicit user confirmation
- After pipeline completion: summarize results conversationally (X succeeded, Y failed, Z need attention)

### Supervisor Workflow

The supervisor is a long-running monitor that watches the pipeline, kills stalls, auto-restarts, and optionally runs optimization experiments. Always use `--output-format json` for agent consumption.

**When to use `supervisor` vs `run`:**
- Use `run --events` for a standard pipeline run with structured event output.
- Use `supervisor` when you want automatic stall detection, restart, and post-run analysis.
- Use `supervisor --experiment` for the full self-improvement loop (analysis + A/B experiments).

**Recommended invocation pattern:**
```
# Start pipeline
substrate run --events --stories X,Y

# Monitor with supervisor (in a separate session/process)
substrate supervisor --output-format json

# Full self-improvement loop (supervisor + experiments after analysis)
substrate supervisor --experiment --output-format json

# Read analysis report for a specific run
substrate metrics --analysis <run-id> --output-format json
```

**Key flags:**
- `--output-format json` — Emit NDJSON events; required for agent consumption
- `--experiment` — Run optimization experiments from analysis recommendations after pipeline completes
- `--max-experiments <n>` — Cap the number of experiments per cycle (default: 2)
- `--stall-threshold <seconds>` — Seconds of silence before declaring a stall (default: 600)
- `--max-restarts <n>` — Maximum restart attempts before aborting (default: 3)
<!-- substrate:end -->
