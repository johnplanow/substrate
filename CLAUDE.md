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

### Autonomy Modes

Substrate has a three-step autonomy gradient. Choose mode by how much operator attention the run gets:

| Mode | Invocation | Halts on |
|---|---|---|
| Attended | `substrate run --halt-on all` | Every decision (info, warning, critical, fatal) |
| Supervised *(default)* | `substrate run` | Critical + fatal (cost-ceiling, build-fail, scope-violation) |
| Autonomous | `substrate run --halt-on none --non-interactive --events --output-format json` | Only fatal — scope violations always halt regardless |

Exit codes from autonomous runs: `0` = all stories succeeded or auto-recovered; `1` = some escalated (run completed); `2` = run-level failure (cost ceiling, fatal halt, orchestrator died).

The Recovery Engine runs a 3-tier auto-fix ladder before any halt — Tier A retries with extra context (build-fail, missing test coverage, AC missing evidence), Tier B drafts a re-scope proposal, Tier C halts for an operator prompt. Re-scope proposals collect on the run manifest as `pending_proposals[]` for next-morning review; back-pressure pauses dispatching at `>= 2` (work-graph-aware) or `>= 5` (safety valve). When a halt is required, an operator notification is written to `.substrate/notifications/<run-id>-<timestamp>.json` and surfaced by `substrate report`.

### After Pipeline Completes

1. **Summarize results** conversationally: X succeeded, Y failed, Z escalated
2. **Run the post-run report**: `substrate report --run latest` (per-story outcomes + escalation diagnostics + halt notifications). Add `--verify-ac` for AC-to-Test traceability.
3. **If pipeline reported failed but tree looks coherent**: `substrate reconcile-from-disk --dry-run` — Path A reconciliation. If gates green and the working tree shows the implementation is on disk, run without `--dry-run` (or with `--yes`) to mark stories complete in Dolt.
4. **Check historical metrics**: `substrate metrics --output-format json`
5. **Read analysis** (if supervisor was attached): `substrate metrics --analysis <run_id> --output-format json`

### Handling Escalations and Failures

- **On story escalation**: read the flagged files and issues listed in the escalation event, propose a fix, ask the user before applying
- **On minor fix verdict** (`NEEDS_MINOR_FIXES`): offer to fix automatically
- **On build verification failure**: read the build output, diagnose the compiler error, propose a fix
- **On contract mismatch** (`pipeline:contract-mismatch`): cross-story interface conflict — read both stories' files, reconcile types manually
- **On reported failure with coherent working tree**: run `substrate reconcile-from-disk --dry-run` first; treat the dry-run output as the source of truth before re-dispatching the story
- **Never re-run a failed story** without explicit user confirmation

### Key Commands Reference

| Command | Purpose |
|---|---|
| `substrate run --events` | Run pipeline with NDJSON event stream |
| `substrate run --halt-on <severity>` | Decision Router halt policy: `all` / `critical` (default) / `none` |
| `substrate run --non-interactive` | Suppress stdin prompts; combine with `--halt-on none` for fully autonomous |
| `substrate run --verify-ac` | On-demand AC-to-Test traceability matrix |
| `substrate report [--run <id\|latest>]` | Per-run completion report — outcomes, cost, escalation diagnostics, halt notifications |
| `substrate report --verify-ac` | Append AC-to-Test traceability matrix to the report |
| `substrate reconcile-from-disk [--dry-run] [--yes]` | Path A reconciliation when pipeline reports failed but tree is coherent |
| `substrate supervisor --output-format json` | Monitor active run with auto-recovery and post-run analysis |
| `substrate status --output-format json` | Poll current pipeline state |
| `substrate health --output-format json` | Check process health and stall detection |
| `substrate metrics --output-format json` | View historical run metrics |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate run --help-agent` | Full agent instruction reference |
| `substrate diff <story>` | Show row-level state changes for a story (requires Dolt) |
| `substrate history` | View Dolt commit log for pipeline state changes (requires Dolt) |

### Operator Files (`.substrate/`)

- `.substrate/runs/<run-id>.json` — per-run manifest (one file per run; NOT an aggregate `manifest.json` — that file does not exist)
- `.substrate/current-run-id` — plain text file with the latest run ID; consulted by canonical run-discovery
- `.substrate/notifications/<run-id>-<timestamp>.json` — operator halt notifications written by the Recovery Engine; deleted by `substrate report` after read

### State Backend

Substrate uses Dolt for versioned pipeline state by default. Run `substrate init` to set it up automatically if Dolt is on PATH. Features that require Dolt: `substrate diff`, `substrate history`, OTEL observability persistence, and context engineering repo-map storage.
<!-- substrate:end -->

## Cross-Project Observation Lifecycle

Substrate-targeted observations (kind `substrate-bug` or `substrate-process`) are tracked in `~/code/jplanow/strata/_observations-pending-cpo.md` (and other consumer projects' equivalents) until the CPO bridge ships. Reopens from those files are load-bearing — they drive substrate-side priorities and ship cadence — so attribution must be verifiable.

**When triaging a substrate-targeted observation reopen:** before treating the reopen as evidence of a regression, verify the version attribution. obs_2026-05-02_019 documents the canonical failure: a strata reopen claimed "dispatched under substrate v0.20.42" when the locally-installed binary was actually v0.20.41 — a 30-minute false-alarm investigation cycle resulted.

**Reopen-evidence requirements** (apply both when authoring a reopen entry on the consumer side AND when triaging one on the substrate side):

1. **Version attribution must be verifiable.** A reopen entry stating "dispatched under substrate vX.Y.Z" needs evidence the consumer's installed binary was actually vX.Y.Z at dispatch time. Acceptable evidence (any one):
   - Output of `substrate --version` from the consumer environment, captured BEFORE the dispatch.
   - npm install log entry (`~/.npm/_logs/<timestamp>-debug-0.log`) showing the install of vX.Y.Z preceding the dispatch timestamp.
   - Pipeline run record at `<consumer>/.substrate/runs/<run-id>.json` correlated with a dated install record.
2. **Triage the version-skew hypothesis FIRST** when investigating any reopen. Cheapest check, highest information yield. Confirm the consumer binary, then the prompt content, then the runtime behavior — in that order. Skipping straight to "the prompt content didn't take" is the failure mode obs_019 warns against.
3. **If reopen evidence is absent or unverifiable:** the reopen is accepted in good faith but flagged for version-skew investigation as the first triage step before any new substrate-side work is filed. Update the observation's status_history with the verified version evidence (or "version unverifiable") before progressing.

**Future direction (out of scope for this guidance, tracked in obs_019):** substrate's CLI may grow a pre-dispatch advisory when a published version newer than the running version exists by more than 1 patch hop. This would prevent the version-skew confusion class entirely. Currently user-driven update cadence is intentional, so this is a forward-looking item, not a current rule.
