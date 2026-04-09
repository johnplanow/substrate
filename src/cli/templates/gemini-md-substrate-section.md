<!-- substrate:start -->
<!-- substrate:version={{SUBSTRATE_VERSION}} -->
## Substrate Pipeline

This project uses Substrate for automated implementation pipelines. When asked to implement, build, or run the pipeline, go straight to running substrate. Do not explore the codebase, read source files, or plan the implementation yourself. Substrate orchestrates sub-agents that handle all of that.

### Running the Pipeline

Substrate auto-detects which pipeline phase to start from (analysis, planning, solutioning, implementation) and auto-discovers pending stories.

```
substrate run --events
```

To target specific stories:
```
substrate run --events --stories 1-1,1-2,1-3
```

If substrate needs input it can't auto-detect (e.g., a project concept for analysis), it will exit with a clear error message telling you what to provide.

Scope warning: Without `--stories`, substrate auto-discovers ALL pending stories across ALL epics and may dispatch 30+ stories at once. For controlled runs, always specify story keys explicitly with `--stories`.

Execution rules:
- Pipeline runs take 5-40 minutes. Use long timeouts.
- Never pipe substrate output to head, tail, grep, or any command that may close the pipe early.
- For full event protocol and command reference: `substrate run --help-agent`

### Monitoring

Poll status periodically (every 60-90s):
```
substrate status --output-format json
```

Check process health:
```
substrate health --output-format json
```

### After Pipeline Completes

1. Summarize results: X succeeded, Y failed, Z escalated
2. Check metrics: `substrate metrics --output-format json`

### Handling Escalations

- On story escalation: read the flagged files and issues, propose a fix, ask the user before applying
- On minor fix verdict (NEEDS_MINOR_FIXES): offer to fix automatically
- On build verification failure: read the build output, diagnose the error, propose a fix
- Never re-run a failed story without explicit user confirmation

### Key Commands

| Command | Purpose |
|---|---|
| `substrate run --events` | Run pipeline with NDJSON event stream |
| `substrate status --output-format json` | Poll current pipeline state |
| `substrate health --output-format json` | Check process health |
| `substrate metrics --output-format json` | View historical run metrics |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate run --help-agent` | Full agent instruction reference |
<!-- substrate:end -->
