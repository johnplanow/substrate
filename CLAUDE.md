## Dev Workflow — Testing Local CLI Changes

**IMPORTANT:** The `substrate` command is a globally installed published version — it does NOT run your local changes.

To test local CLI changes:
1. Build first: `npm run build`
2. Run via: `npm run substrate:dev -- <args>`

Example: `npm run substrate:dev -- run --events --stories 10-1`

**Never run bare `substrate` to test local changes.** It will silently use the published version, not your code.

## Testing

- **During development iteration:** `npm run test:fast` — unit tests only, excludes e2e/integration, no coverage (~30s)
- **For targeted validation:** `npm run test:changed` — only tests affected by your changed files (fastest)
- **Full validation / pre-merge:** `npm test` — full suite with coverage (~140s)
- **NEVER run `npm test` concurrently** — only one vitest instance at a time
- Prefer `test:fast` or `test:changed` during iteration to avoid slow feedback loops and memory pressure

<!-- substrate:start -->
## Substrate Pipeline

This project uses Substrate for automated implementation pipelines. Substrate runs are long-running (5–40 minutes). Plan accordingly.

### Running the Pipeline

**Preferred — Supervisor mode** (handles stalls, auto-restarts, post-run analysis):
```
substrate supervisor --output-format json --stories 7-1,7-2
```

**Direct mode** (simpler, no auto-recovery):
```
substrate run --events --stories 7-1,7-2
```

**CRITICAL execution rules:**
- Pipeline runs take **5–40 minutes**. You MUST use `run_in_background: true` or `timeout: 600000` (10 min) when invoking via Bash tool. Default 2-minute timeout WILL kill the pipeline.
- **NEVER pipe substrate output** to `head`, `tail`, `grep`, or any command that may close the pipe early — this causes EPIPE stalls that hang the process.
- **DO NOT use `Task Output`** to monitor substrate — Claude Code task IDs do not map to substrate's internal processes.
- For full event protocol and command reference: `substrate run --help-agent`

### Monitoring (while pipeline is running)

Poll status periodically (every 60–90s):
```
substrate status --output-format json
```

Check process health if pipeline seems quiet:
```
substrate health --output-format json
```

**Interpreting silence:** No output for 5 minutes = normal (agent is working). No output for 15+ minutes = likely stalled. Use `substrate health` to confirm, then consider killing and resuming.

### After Pipeline Completes

1. **Summarize results** conversationally: X succeeded, Y failed, Z escalated
2. **Check metrics**: `substrate metrics --output-format json`
3. **Read analysis** (if supervisor mode): `substrate metrics --analysis <run_id> --output-format json`

### Handling Escalations and Failures

- **On story escalation**: read the flagged files and issues listed in the escalation event, propose a fix, ask the user before applying
- **On minor fix verdict** (`NEEDS_MINOR_FIXES`): offer to fix automatically
- **On build verification failure**: read the build output, diagnose the compiler error, propose a fix
- **On contract mismatch** (`pipeline:contract-mismatch`): cross-story interface conflict — read both stories' files, reconcile types manually
- **Never re-run a failed story** without explicit user confirmation

### Key Commands Reference

| Command | Purpose |
|---|---|
| `substrate run --events` | Run pipeline with NDJSON event stream |
| `substrate supervisor --output-format json` | Run with auto-recovery and analysis |
| `substrate status --output-format json` | Poll current pipeline state |
| `substrate health --output-format json` | Check process health and stall detection |
| `substrate metrics --output-format json` | View historical run metrics |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate run --help-agent` | Full agent instruction reference (487 lines) |
<!-- substrate:end -->
