<!-- substrate:start -->
<!-- substrate:version={{SUBSTRATE_VERSION}} -->
## Substrate Pipeline

This project uses Substrate for automated implementation pipelines. **When the user asks you to implement, build, or run the pipeline — go straight to running substrate. Do NOT explore the codebase, read source files, or plan the implementation yourself.** Substrate orchestrates sub-agents that handle all of that.

### Running the Pipeline

**Just run it.** Substrate auto-detects which pipeline phase to start from (analysis → planning → solutioning → implementation) and auto-discovers pending stories. You do not need to determine the phase or find story keys manually.

```
substrate run --events
```

To target specific stories (if the user names them):
```
substrate run --events --stories 1-1,1-2,1-3
```

If substrate needs input it can't auto-detect (e.g., a project concept for analysis), it will exit with a clear error message telling you what to provide.

**Scope warning:** Without `--stories`, substrate auto-discovers ALL pending stories across ALL epics and may dispatch 30+ stories at once. For controlled runs, always specify story keys explicitly with `--stories`.

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

For long-running pipelines, attach the **supervisor** for automatic stall detection, kill-and-restart recovery, and post-run analysis. The supervisor monitors an active run — it does not start one. Start it alongside `substrate run`:
```
substrate supervisor --output-format json
```

**CRITICAL: Only attach a supervisor to runs you started in the same session.** Attaching a supervisor to another session's run risks killing healthy dispatches and restarting with incorrect scope. The supervisor inherits story keys from the health snapshot on restart, but cross-session interference can cause unexpected behavior.

**Interpreting silence:** No output for 5 minutes = normal (agent is working). No output for 15+ minutes = likely stalled. Use `substrate health` to confirm, then consider killing and resuming.

### After Pipeline Completes

1. **Summarize results** conversationally: X succeeded, Y failed, Z escalated
2. **Check metrics**: `substrate metrics --output-format json`
3. **Read analysis** (if supervisor was attached): `substrate metrics --analysis <run_id> --output-format json`

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
| `substrate supervisor --output-format json` | Monitor active run with auto-recovery and post-run analysis |
| `substrate status --output-format json` | Poll current pipeline state |
| `substrate health --output-format json` | Check process health and stall detection |
| `substrate metrics --output-format json` | View historical run metrics |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate run --help-agent` | Full agent instruction reference (487 lines) |
| `substrate diff <story>` | Show row-level state changes for a story (requires Dolt) |
| `substrate history` | View Dolt commit log for pipeline state changes (requires Dolt) |

### State Backend

Substrate uses Dolt for versioned pipeline state by default. Run `substrate init` to set it up automatically if Dolt is on PATH. Features that require Dolt: `substrate diff`, `substrate history`, OTEL observability persistence, and context engineering repo-map storage.
<!-- substrate:end -->
