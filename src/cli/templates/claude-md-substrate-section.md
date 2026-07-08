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

### Per-Story Worktree Behavior

Each dispatched story runs in an isolated git worktree on its own branch (`substrate/story-<key>`). By default the worktree lives OUTSIDE the repo at `~/.substrate/worktrees/<projectname>-<hash8>/<key>/`; set `worktree.base: in-repo` in `.substrate/config.yaml` to restore the legacy `.substrate-worktrees/<key>/` location. Substrate auto-commits the story's work to the branch (`feat(story-N-M): ...`) at dev-story completion — commit-first, before review — so the branch is always the durable copy; failure paths add `wip(story-<key>)` checkpoints. After verification failure, the worktree and branch are preserved for `substrate reconcile-from-disk` inspection. Use `--no-worktree` if your project doesn't support worktrees (submodules, bare repos).

### Finalization — how verified work integrates

`finalization.mode` in `.substrate/config.yaml` (or `--finalization <mode>` per run):

- **`merge`** (default): local merge into the branch the run started from. The merge is **fast-forward-only by default** — if the base branch moved during the run, the story escalates `ff-only-merge-not-possible` instead of synthesizing a merge commit. Set `finalization.merge_strategy: three-way` to allow merge commits — **required for concurrent multi-story runs** (later stories cannot fast-forward past earlier merges). A dirty parent tree whose changes intersect the story's diff escalates `parent-tree-dirtied-by-run` naming the files.
- **`branch`**: verified work stays on `substrate/story-<key>` — nothing self-merges; the branch is the deliverable. The safe brownfield mode.
- **`pr`**: branch + `git push` + `gh pr create` (one PR per story). Degrades to `branch` with a warning when push/gh fail — never blocks the story.

Lifecycle events on the NDJSON stream: `story:committed` → (`story:merged`) → `story:finalized {mode, branch, sha, pr_url?}`. `substrate report` lists unmerged deliverable branches under "Finalization". Optional `finalization.epic_gate_command` runs before the LAST story of an epic integrates (non-zero exit → `epic-gate-failed`, branch preserved).

### Acceptance Gate — journey coverage (optional)

If the project declares a journey registry at `.substrate/acceptance/journeys.yaml` (PRD user journeys with concrete end-states — COMMIT the file; substrate reads the committed copy, never an agent-writable worktree copy), the pipeline audits journey coverage at each epic close and at run end: every registered journey lands in exactly one state — `walked-pass`, `walked-fail`, `deferred`, `unclaimed` (NO story claims it — the never-wired-journey class), or `unwalked`. Results stream as `acceptance:coverage` events and land on the run manifest.

`acceptance.mode` in `.substrate/config.yaml`: `advisory` (default — warns, never blocks), `blocking`, or `off`. In blocking mode the verdict × tier policy applies: an unclaimed/unwalked journey escalates `journey-unclaimed`/`journey-unwalked` on the LAST story of the epic; a journey-critical acceptance FAIL escalates `acceptance-fail` before the story integrates (branch preserved); a story whose journey-critical verdicts ALL pass integrates via `acceptance.critical_pass_finalization` (`branch` default, or `pr`) instead of self-merging — the deliverable branch plus the verdict artifact await a human merge in the morning report. Standard-tier FAILs file a fix-story proposal and the run continues. Create-story tags stories with the journeys they deliver (`journeys:` frontmatter). To explicitly skip a journey: `substrate acceptance defer <id> --reason "<why>"` and commit the deferral file. Lint the registry with `substrate acceptance validate`; judge ad-hoc artifacts with `substrate acceptance judge`.

### Key Commands Reference

| Command | Purpose |
|---|---|
| `substrate run --events` | Run pipeline with NDJSON event stream |
| `substrate run --halt-on <severity>` | Decision Router halt policy: `all` / `critical` (default) / `none` |
| `substrate run --non-interactive` | Suppress stdin prompts; combine with `--halt-on none` for fully autonomous |
| `substrate run --verify-ac` | On-demand AC-to-Test traceability matrix |
| `substrate run --no-worktree` | Disable per-story git worktrees (use for submodules or bare repos) |
| `substrate run --finalization <mode>` | Integration mode: `merge` (default) / `branch` (never self-merge) / `pr` |
| `substrate report [--run <id\|latest>]` | Per-run completion report — outcomes, cost, escalation diagnostics, halt notifications |
| `substrate report --verify-ac` | Append AC-to-Test traceability matrix to the report |
| `substrate reconcile-from-disk [--dry-run] [--yes]` | Path A reconciliation when pipeline reports failed but tree is coherent |
| `substrate supervisor --output-format json` | Monitor active run with auto-recovery and post-run analysis |
| `substrate status --output-format json` | Poll current pipeline state |
| `substrate health --output-format json` | Check process health and stall detection |
| `substrate metrics --output-format json` | View historical run metrics |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate run --help-agent` | Full agent instruction reference |
| `substrate history` | View Dolt commit log for pipeline state changes (requires Dolt) |

### Operator Files (`.substrate/`)

- `.substrate/runs/<run-id>.json` — per-run manifest (one file per run; NOT an aggregate `manifest.json` — that file does not exist)
- `.substrate/current-run-id` — plain text file with the latest run ID; consulted by canonical run-discovery
- `.substrate/notifications/<run-id>-<timestamp>.json` — operator halt notifications written by the Recovery Engine; deleted by `substrate report` after read

### Recommended `.gitignore` entries

Substrate writes per-project state under `.substrate/` in a few flavors:
- **Per-process scratch** (`.pid`, `current-run-id`, `latest-heartbeat-per-story-state.json`) — regenerated each run.
- **Per-run artifacts** (`runs/<run-id>.json`, `notifications/<run-id>-*.json`) — accumulate across runs; substrate report consumes and cleans notifications.
- **Local telemetry** (`kv-metrics.json` — per-run phase token breakdown used by `substrate metrics --output-format json` and, when enabled, the routing auto-tuner) — accumulates across runs into a local corpus.
- **The Dolt repository** (`state/`) — versioned pipeline state, large + binary.
- **Operator config** (`config.yaml`) — the only file intended for cross-machine sharing.

The defensible default for most projects is to ignore everything under `.substrate/` except the operator config. Local telemetry stays on each developer's machine — operators see their own corpus locally via `substrate metrics`; cross-machine sharing of routing telemetry is a future feature, not currently supported.

Besides `.substrate/`, `substrate init` also scaffolds project-root artifacts that ARE intentional and worth tracking in git: `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` (pipeline instructions per agent CLI), `packs/<pack-name>/` (the methodology pack's prompts — the pipeline reads these at dispatch time), `.claude/commands/substrate-*.md` + `.claude/skills/`, and `.codex/` mirrors. Track them; they are inputs to every run, not state. If your team prefers not to commit the non-Claude agent files (`AGENTS.md`, `GEMINI.md`, `.codex/`), gitignore them explicitly — substrate regenerates them on `substrate init`.

```gitignore
# Substrate state — track only the operator config; everything else is
# per-process, per-run, or local-machine accumulation
.substrate/*
!.substrate/config.yaml
```

This is future-proof against new files substrate may introduce. If you want to enumerate explicitly instead:

```gitignore
.substrate/state/
.substrate/runs/
.substrate/notifications/
.substrate/kv-metrics.json
.substrate/current-run-id
.substrate/latest-heartbeat-per-story-state.json
.substrate/*.db
.substrate/*.pid
.substrate/routing-policy.yaml
```

**Tradeoff to consider:** if your team wants to share a routing auto-tune corpus across machines (e.g., to seed `config.auto_tune` decisions with combined data), you could remove `kv-metrics.json` from the ignore set — at the cost of one git-mutation per substrate run. Most teams don't need this; the file is operator-visible locally regardless of git.

### State Backend

Substrate uses Dolt for versioned pipeline state by default. Run `substrate init` to set it up automatically if Dolt is on PATH. Features that require Dolt: `substrate history`, OTEL observability persistence, and context engineering repo-map storage.
<!-- substrate:end -->
