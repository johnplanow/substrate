# Substrate Supervisor

Start and monitor the pipeline supervisor for automatic stall recovery and self-improvement.

## When to Use

Invoke this command when you need to run the substrate pipeline supervisor — a background watchdog that monitors running pipeline jobs, recovers from stalls, and (optionally) experiments with prompt modifications to improve pipeline efficiency.

## Starting the Supervisor

### Basic monitoring mode
```bash
npx substrate auto supervisor --output-format json --poll-interval 30
```

Run this in the background so you can continue interacting with the user:
```bash
npx substrate auto supervisor --output-format json --poll-interval 30 &
SUPERVISOR_PID=$!
```

### Self-improvement mode (with experiments)
```bash
npx substrate auto supervisor --experiment --output-format json --poll-interval 30 &
SUPERVISOR_PID=$!
```

Use `--max-experiments <N>` to limit experiment count per cycle (default: 2).

### Recommended defaults
- `--poll-interval 30` — poll every 30 seconds (balances responsiveness vs. API calls)
- `--stall-threshold 300` — declare stall after 5 minutes of no progress
- `--max-restarts 3` — auto-restart stalled pipelines up to 3 times
- `--output-format json` — structured NDJSON event stream for agent parsing

## Parsing the JSON Event Stream

The supervisor emits NDJSON events to stdout. Each line is a JSON object with a `type` field.

### Key event types to handle

| Event type | When emitted | Action |
|-----------|--------------|--------|
| `supervisor:poll` | Every poll cycle | Log health verdict, check for issues |
| `supervisor:stall:detected` | Stall found | Notify user, prepare for restart |
| `supervisor:stall:recovering` | Auto-restart initiated | Log recovery attempt |
| `supervisor:stall:recovered` | Pipeline resumed | Confirm recovery to user |
| `supervisor:stall:max-restarts` | Max restarts hit | Escalate to user — manual intervention needed |
| `supervisor:experiment:start` | Experiment cycle begins | Log that self-improvement is running |
| `supervisor:experiment:recommendations` | Analysis found improvements | Log recommendation count |
| `supervisor:experiment:result` | Single experiment done | Report verdict (IMPROVED/MIXED/REGRESSED) |
| `supervisor:experiment:skip` | No recommendations found | Normal — nothing to improve |
| `supervisor:done` | Supervisor exiting | Log exit reason |

### Example: reading events in a loop

```bash
npx substrate auto supervisor --output-format json --poll-interval 30 | while IFS= read -r line; do
  type=$(echo "$line" | jq -r '.type // empty')
  case "$type" in
    supervisor:stall:max-restarts)
      echo "ALERT: Pipeline stalled and max restarts reached — needs manual intervention"
      ;;
    supervisor:experiment:result)
      verdict=$(echo "$line" | jq -r '.verdict')
      echo "Experiment verdict: $verdict"
      ;;
    supervisor:done)
      break
      ;;
  esac
done
```

## Responding to Key Events

> **Help-agent patterns**: The full agent interaction guide for the substrate pipeline is documented in `docs/help-agent.md` (introduced in Story 17-5). The patterns below are the most commonly needed excerpts — refer to that document for complete escalation decision trees and response templates.

### On `supervisor:stall:max-restarts`
The pipeline has stalled and automatic recovery is exhausted. You should:
1. Run `substrate auto status --output-format json` to see which stories are stuck
2. Check escalated stories: read `_bmad-output/stories/` for the affected story file
3. Propose a fix to the user and ask for confirmation before applying

This is the **story escalation** pattern from the help-agent guide: read the flagged files and issues, propose a fix, ask the user before applying.

### On `supervisor:experiment:result` with verdict `IMPROVED`
The experiment improved pipeline performance. A PR has been created automatically. Inform the user of the PR URL from the event payload.

### On `supervisor:experiment:result` with verdict `MIXED`
Improvement in the target metric but regression in another. A PR was created for human review. Inform the user.

### On `supervisor:experiment:result` with verdict `REGRESSED`
The experiment made things worse. The branch was automatically deleted. No action needed.

See `docs/help-agent.md` §"Experiment Results" for the full verdict response matrix, including how to summarize experiment outcomes to the user.

## Checking Supervisor Status

While the supervisor runs in the background, poll its status:
```bash
npx substrate auto status --output-format json
```

## Stopping the Supervisor

```bash
kill $SUPERVISOR_PID
```

## Related Commands
- `/substrate-run` — Start a pipeline run and monitor it
- `/substrate-metrics` — View pipeline performance metrics and analysis
