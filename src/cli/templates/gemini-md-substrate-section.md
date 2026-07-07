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

### Autonomy Modes

Three-step gradient. Choose by how much operator attention the run gets:

| Mode | Invocation | Halts on |
|---|---|---|
| Attended | `substrate run --halt-on all` | Every decision |
| Supervised (default) | `substrate run` | Critical + fatal (cost-ceiling, build-fail, scope-violation) |
| Autonomous | `substrate run --halt-on none --non-interactive --events --output-format json` | Only fatal |

Exit codes from autonomous runs: 0 = succeeded or auto-recovered, 1 = some escalated (run completed), 2 = run-level failure.

The Recovery Engine runs a 3-tier auto-fix ladder before any halt — Tier A retries with extra context, Tier B drafts a re-scope proposal, Tier C halts for an operator prompt. Re-scope proposals collect on the run manifest as `pending_proposals[]`. When a halt is required, an operator notification is written to `.substrate/notifications/<run-id>-<timestamp>.json` and surfaced by `substrate report`.

### After Pipeline Completes

1. Summarize results: X succeeded, Y failed, Z escalated
2. Run the post-run report: `substrate report --run latest` (per-story outcomes + escalation diagnostics + halt notifications). Add `--verify-ac` for AC-to-Test traceability.
3. If pipeline reported failed but tree looks coherent: `substrate reconcile-from-disk --dry-run` (Path A reconciliation). If gates green, run without `--dry-run` to mark stories complete.
4. Check historical metrics: `substrate metrics --output-format json`

### Handling Escalations

- On story escalation: read the flagged files and issues, propose a fix, ask the user before applying
- On minor fix verdict (NEEDS_MINOR_FIXES): offer to fix automatically
- On build verification failure: read the build output, diagnose the error, propose a fix
- On reported failure with coherent working tree: run `substrate reconcile-from-disk --dry-run` first; treat its output as source of truth before re-dispatching
- Never re-run a failed story without explicit user confirmation

### Per-Story Worktree Behavior

Each dispatched story runs in an isolated git worktree on its own branch (`substrate/story-<key>`). By default the worktree lives OUTSIDE the repo at `~/.substrate/worktrees/<projectname>-<hash8>/<key>/`; set `worktree.base: in-repo` in `.substrate/config.yaml` to restore the legacy `.substrate-worktrees/<key>/` location. Substrate auto-commits the story's work to the branch (`feat(story-N-M): ...`) at dev-story completion — commit-first, before review — so the branch is always the durable copy; failure paths add `wip(story-<key>)` checkpoints. After verification failure, the worktree and branch are preserved for `substrate reconcile-from-disk` inspection. Use `--no-worktree` if your project doesn't support worktrees (submodules, bare repos).

### Finalization — how verified work integrates

`finalization.mode` in `.substrate/config.yaml` (or `--finalization <mode>` per run):

- **`merge`** (default): local merge into the branch the run started from. The merge is **fast-forward-only by default** — if the base branch moved during the run, the story escalates `ff-only-merge-not-possible` instead of synthesizing a merge commit. Set `finalization.merge_strategy: three-way` to allow merge commits — **required for concurrent multi-story runs** (later stories cannot fast-forward past earlier merges). A dirty parent tree whose changes intersect the story's diff escalates `parent-tree-dirtied-by-run` naming the files.
- **`branch`**: verified work stays on `substrate/story-<key>` — nothing self-merges; the branch is the deliverable. The safe brownfield mode.
- **`pr`**: branch + `git push` + `gh pr create` (one PR per story). Degrades to `branch` with a warning when push/gh fail — never blocks the story.

Lifecycle events on the NDJSON stream: `story:committed` -> (`story:merged`) -> `story:finalized {mode, branch, sha, pr_url?}`. `substrate report` lists unmerged deliverable branches under "Finalization". Optional `finalization.epic_gate_command` runs before the LAST story of an epic integrates (non-zero exit -> `epic-gate-failed`, branch preserved).

### Key Commands

| Command | Purpose |
|---|---|
| `substrate run --events` | Run pipeline with NDJSON event stream |
| `substrate run --halt-on <severity>` | Halt policy: `all` / `critical` (default) / `none` |
| `substrate run --non-interactive` | Suppress stdin prompts |
| `substrate run --no-worktree` | Disable per-story git worktrees (use for submodules or bare repos) |
| `substrate run --finalization <mode>` | Integration mode: `merge` (default) / `branch` (never self-merge) / `pr` |
| `substrate report [--run <id\|latest>]` | Per-run completion report |
| `substrate report --verify-ac` | Append AC-to-Test traceability matrix |
| `substrate reconcile-from-disk [--dry-run] [--yes]` | Path A reconciliation when tree is coherent |
| `substrate status --output-format json` | Poll current pipeline state |
| `substrate health --output-format json` | Check process health |
| `substrate metrics --output-format json` | View historical run metrics |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate run --help-agent` | Full agent instruction reference |

### Operator Files (`.substrate/`)

- `.substrate/runs/<run-id>.json` — per-run manifest (one file per run; not an aggregate)
- `.substrate/current-run-id` — plain text file with the latest run ID
- `.substrate/notifications/<run-id>-<timestamp>.json` — operator halt notifications (deleted by `substrate report` after read)

### Recommended `.gitignore` entries

Substrate writes per-project state under `.substrate/` in a few flavors: per-process scratch (`.pid`, `current-run-id`, `latest-heartbeat-per-story-state.json` — regenerated each run); per-run artifacts (`runs/<run-id>.json`, `notifications/`); local telemetry (`kv-metrics.json` — per-run phase token breakdown, accumulates into a local corpus used by `substrate metrics` and optional auto-tuner); the Dolt repository (`state/`); and the operator config (`config.yaml`, the only file intended for cross-machine sharing).

Defensible default: ignore everything under `.substrate/` except the operator config. Local telemetry stays per-developer; operators see their own corpus locally regardless of git.

```gitignore
# Substrate state — track only the operator config
.substrate/*
!.substrate/config.yaml
```
<!-- substrate:end -->
