## Dev Workflow — Testing Local CLI Changes

**IMPORTANT:** The `substrate` command is a globally installed published version — it does NOT run your local changes.

To test local CLI changes:
1. Build first: `npm run build`
2. Run via: `npm run substrate:dev -- <args>`

Example: `npm run substrate:dev -- run --events --stories 10-1`

**Never run bare `substrate` to test local changes.** It will silently use the published version, not your code.

## Testing

- **During development iteration:** `npm run test:fast` — unit tests only, excludes e2e/integration, no coverage (~50s)
- **For targeted validation:** `npm run test:changed` — only tests affected by your changed files (fastest)
- **Full validation / pre-merge:** `npm test` — full suite with coverage (~140s)
- Prefer `test:fast` or `test:changed` during iteration to avoid slow feedback loops and memory pressure

### Test Execution Rules (CRITICAL)

- **NEVER run tests concurrently** — only one vitest instance at a time. Before running, verify: `pgrep -f vitest` returns nothing.
- **ALWAYS use `timeout: 300000`** (5 min) — test suite takes ~50s but startup adds overhead. Default 2-min timeout will kill it.
- **NEVER pipe test output** through `tail`, `head`, `grep`, or any command — pipes discard the vitest summary line and make results unverifiable.
- **NEVER run tests in background** — always foreground with timeout. Background runs lose output.
- **Confirm results by checking for "Test Files" in output** — exit code 0 alone is insufficient (a pipe exit code ≠ test exit code).

<!-- dev-workflow:start -->
## Dev Workflow

**Build:** `npm run build`
**Test:** `npm test`

### Testing Notes
- Run targeted tests during development to avoid slow feedback loops
- Run the full suite before merging
<!-- dev-workflow:end -->

<!-- substrate:start -->
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
| `substrate eval --report json` | Evaluate LLM output quality with LLM-as-judge (standard tier) |
| `substrate eval --depth deep` | Deep eval with golden examples, cross-phase coherence, and rubrics |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate run --help-agent` | Full agent instruction reference (487 lines) |
| `substrate diff <story>` | Show row-level state changes for a story (requires Dolt) |
| `substrate history` | View Dolt commit log for pipeline state changes (requires Dolt) |

### State Backend

Substrate uses Dolt for versioned pipeline state by default. Run `substrate init` to set it up automatically if Dolt is on PATH. Features that require Dolt: `substrate diff`, `substrate history`, OTEL observability persistence, and context engineering repo-map storage.
<!-- substrate:end -->
