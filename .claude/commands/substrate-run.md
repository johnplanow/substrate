# Substrate Run

Start a pipeline run and monitor it to completion.

## When to Use

Invoke this command when you need to execute substrate pipeline stories — either a specific set or all pending stories — and want to track progress, handle escalations, and summarize results to the user.

## Starting a Pipeline Run

### Run specific stories
```bash
npx substrate run --events --stories 7-1,7-2,7-3
```

### Run all pending stories
```bash
npx substrate run --events
```

### Run in background (recommended for long runs)
```bash
npx substrate run --events --stories 7-1,7-2 &
RUN_PID=$!
```

The `--events` flag emits structured NDJSON events to stdout for easy parsing.

## Monitoring a Running Pipeline

### Poll status (recommended approach)

Poll every 30-60 seconds rather than blocking on stdout:
```bash
npx substrate status --output-format json
```

The status response includes:
- `run_id` — current run identifier
- `verdict` — pipeline health: `HEALTHY`, `STALLED`, `NO_PIPELINE_RUNNING`, `UNKNOWN`
- `stories` — per-story status with phase and review cycle counts

### Interpreting status verdicts

| Verdict | Meaning | Action |
|---------|---------|--------|
| `HEALTHY` | Pipeline progressing normally | Continue polling |
| `STALLED` | No activity for >5 minutes | Check for escalations, consider supervisor |
| `NO_PIPELINE_RUNNING` | Run completed or not started | Collect final results |
| `UNKNOWN` | Status indeterminate | Poll again in 30s |

## Optional: Attach the Supervisor

For long-running pipelines, attach the supervisor for automatic stall recovery:
```bash
# Start the run
npx substrate run --events --stories 7-1,7-2,7-3 &

# Start the supervisor (in parallel)
npx substrate supervisor --output-format json --poll-interval 30 &
SUPERVISOR_PID=$!
```

See `/substrate-supervisor` for full supervisor usage.

## Interpreting Results

### Checking final status after run completes
```bash
npx substrate status --output-format json
```

Key fields in the response:
- `stories.details.<story_key>.phase` — final phase for each story (`COMPLETE`, `ESCALATED`, `FAILED`)
- `stories.completed` — count of successfully completed stories
- `stories.escalated` — count of escalated stories needing attention

### Handling escalated stories

If `stories.escalated > 0`:
1. Check which stories are escalated: look for `phase: "ESCALATED"` in `stories.details`
2. Read the story file: `_bmad-output/stories/<story_key>.md` or the original story spec
3. Check for error context in `_bmad-output/` directory
4. Propose a fix to the user
5. Ask for confirmation before re-running: `npx substrate run --events --stories <escalated_key>`

### Summarizing to the user

After the pipeline completes, provide a concise summary:
- X stories succeeded
- Y stories failed/escalated (list them with error context)
- Total cost and token usage (from `substrate metrics --output-format json`)

## Example Workflow

```bash
# 1. Start the run
npx substrate run --events --stories 10-1,10-2,10-3 &

# 2. Poll every 60 seconds
while true; do
  STATUS=$(npx substrate status --output-format json)
  VERDICT=$(echo "$STATUS" | jq -r '.verdict')
  if [ "$VERDICT" = "NO_PIPELINE_RUNNING" ]; then
    echo "Run complete"
    break
  fi
  echo "Status: $VERDICT"
  sleep 60
done

# 3. Get final results
npx substrate status --output-format json | jq '{completed: .stories.completed, escalated: .stories.escalated}'

# 4. Get cost/token summary
npx substrate metrics --output-format json | jq '.[0] | {cost: .total_cost_usd, tokens: (.total_input_tokens + .total_output_tokens)}'
```

## Related Commands
- `/substrate-supervisor` — Automatic stall recovery and self-improvement
- `/substrate-metrics` — View pipeline performance metrics
