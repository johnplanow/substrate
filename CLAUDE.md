<!-- substrate:start -->
## Substrate Pipeline

This project uses Substrate for automated implementation pipelines.

### Quick Start
- Run `substrate auto --help-agent` to get full pipeline interaction instructions
- Run `substrate auto run --events` to execute the pipeline with structured event output
- Run `substrate auto run --events --stories 7-1,7-2` to run specific stories

### Agent Behavior
- On story escalation: read the flagged files and issues, propose a fix, ask the user before applying
- On minor fix verdict: offer to fix automatically
- Never re-run a failed story without explicit user confirmation
- After pipeline completion: summarize results conversationally (X succeeded, Y failed, Z need attention)
<!-- substrate:end -->
