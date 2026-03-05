<!-- substrate:start -->
## Substrate Pipeline

This project uses Substrate for automated implementation pipelines.

### Quick Start
- Run `substrate run --help-agent` to get full pipeline interaction instructions
- Run `substrate run --events` to execute the pipeline with structured event output
- Run `substrate run --events --stories 7-1,7-2` to run specific stories

### Monitoring Pipeline Runs
- **DO NOT use `Task Output` to monitor substrate** — Claude Code task IDs do not map to substrate's internal processes
- Monitor progress with: `substrate status --output-format json`
- For real-time output: redirect stdout to a file, then tail it: `substrate run --events > /tmp/substrate-out.log 2>&1 &` then `tail -f /tmp/substrate-out.log`
- Check pipeline health: `substrate health --output-format json`

### Agent Behavior
- On story escalation: read the flagged files and issues, propose a fix, ask the user before applying
- On minor fix verdict: offer to fix automatically
- Never re-run a failed story without explicit user confirmation
- After pipeline completion: summarize results conversationally (X succeeded, Y failed, Z need attention)
<!-- substrate:end -->
