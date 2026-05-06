<p align="center">
  <img src="https://raw.githubusercontent.com/johnplanow/substrate/main/assets/substrate-header.png" alt="Substrate — Autonomous Software Development Pipeline" />
</p>

# Substrate

Substrate is an autonomous software development pipeline, operated by your AI coding assistant. Install it, initialize your project, and tell Claude (or Codex, or Gemini) what to build — Substrate handles the rest.

Most multi-agent coding tools help you run AI sessions in parallel but leave planning, quality control, and learning up to you. Substrate is different: it packages **structured planning methodology**, **multi-agent parallel execution**, **a six-stage verification pipeline**, **automated review-and-fix cycles**, and **a self-improvement loop** into a single pipeline. Describe your project concept, and Substrate takes it from research through implementation and review — coordinating multiple AI coding agents across isolated worktree branches while a supervisor watches for stalls, auto-recovers, and experiments with improvements to close the loop.

## How It Works

Substrate operates through a three-layer interaction model:

```
┌─────────────────────────────────────────────────────────────────┐
│  You                                                            │
│  "Implement stories 7-1 through 7-5"                            │
│                          ↓                                      │
│  Your AI Assistant (Claude Code / Codex / Gemini)               │
│  Invokes substrate CLI, parses structured events, reacts        │
│                          ↓                                      │
│  Substrate                                                      │
│  Dispatches work to worker agents in parallel worktrees         │
│  Manages quality gates, review cycles, stall recovery           │
└─────────────────────────────────────────────────────────────────┘
```

**You talk to your AI assistant. Your assistant talks to Substrate. Substrate orchestrates everything.**

In practice:

```
You: "Implement stories 7-1 through 7-5"

Claude Code: runs `substrate run --events --stories 7-1,7-2,7-3,7-4,7-5`

Substrate:   dispatches 5 stories across 3 agents in parallel worktrees
             → story 7-1: dev complete, 6 verification checks ✓ → SHIP_IT
             → story 7-2: code review NEEDS_MINOR_FIXES → auto-fix → SHIP_IT
             → story 7-3: source-ac-fidelity flagged a missing path → escalated
             → story 7-4: runtime probe failed → escalated for diagnosis
             → story 7-5: SHIP_IT first cycle ✓

Claude Code: "3 succeeded, 2 escalated — here's the runtime-probe failure on 7-4..."
```

Substrate is also **self-developing**: substrate's own development is dispatched through substrate. The fixes shipped in v0.20.42 → v0.20.46 (probe-awareness, frontmatter declarations, dependency-context detection, AnthropicAdapter streaming) were authored by substrate dispatching against its own codebase. This is intentional dogfooding — see the `substrate-on-substrate` examples below.

## Prerequisites

- **Node.js** 22.0.0 or later
- **git** 2.20 or later
- At least one supported AI CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - Gemini CLI (`gemini`)
- **Optional but recommended**: [Dolt](https://www.dolthub.com/) for versioned pipeline state

## Quick Start

### Install and Initialize

```bash
npm install -g substrate-ai
cd your-project
substrate init
```

This does three things:

1. **Generates `.substrate/config.yaml`** — provider routing, concurrency, budgets, quality mode
2. **Injects a `## Substrate Pipeline` section into CLAUDE.md** — behavioral directives that teach your AI assistant how to operate the pipeline
3. **Creates `.claude/commands/` slash commands** — `/substrate-run`, `/substrate-supervisor`, `/substrate-metrics`, `/substrate-factory-loop`

If Dolt is on PATH, `substrate init` automatically sets up versioned state. Without Dolt, substrate falls back to plain SQLite.

### Run From Your AI Assistant

Start a session in your AI tool of choice. The assistant reads the substrate instructions from `CLAUDE.md` and knows how to operate the pipeline:

- **"Run the substrate pipeline"** — full lifecycle from analysis through implementation
- **"Run substrate for stories 7-1, 7-2, 7-3"** — implement specific stories
- **"/substrate-run"** — invoke the slash command directly for a guided run

Your assistant parses NDJSON events, handles escalations, offers to fix review issues, and summarizes results. You stay in control — your assistant always asks before re-running failed stories or applying fixes.

### Run From the CLI Directly

```bash
# Full pipeline with NDJSON event stream
substrate run --events

# Specific stories with stricter review limits
substrate run --events --stories 7-1,7-2,7-3 --max-review-cycles 3

# Resume an interrupted run
substrate resume

# Cancel a running pipeline
substrate cancel
```

### Autonomy Modes

Substrate exposes a three-step autonomy gradient. Pick the mode that matches how much operator attention the run gets.

| Mode | Invocation | Halts on |
|---|---|---|
| Attended | `substrate run --halt-on all` | Every decision (info, warning, critical, fatal) |
| Supervised *(default)* | `substrate run` | Critical + fatal (cost-ceiling, build-fail, scope-violation) |
| Autonomous | `substrate run --halt-on none --non-interactive --events --output-format json` | Only fatal — scope violations always halt regardless |

Exit codes from autonomous runs: `0` = all stories succeeded or auto-recovered; `1` = some stories escalated (run completed); `2` = run-level failure (cost ceiling, fatal halt, orchestrator died). Combine with the canonical post-run review flow:

```bash
# Canonical CI / overnight pattern:
substrate run --halt-on none --non-interactive --events --output-format json

# Then review the result:
substrate report --run latest                  # per-story outcomes + escalation diagnostics
substrate report --run latest --verify-ac      # adds AC-to-Test traceability matrix
substrate reconcile-from-disk --dry-run        # if pipeline reported failed but tree is coherent
```

Behind the scenes, the **Recovery Engine** runs a 3-tier auto-fix ladder before any halt — Tier A retries with extra context (build-fail, missing test coverage, AC missing evidence), Tier B drafts a re-scope proposal, Tier C halts for an operator prompt. Re-scope proposals collect on the run manifest as `pending_proposals[]` for next-morning review; back-pressure pauses dispatching at `>= 2` proposals (work-graph-aware) or `>= 5` (safety valve). When a halt is required, the Recovery Engine writes an operator notification to `.substrate/notifications/<run-id>-<timestamp>.json`; `substrate report` reads and clears those.

## The Pipeline

When you tell Substrate to build something, it runs through up to **six phases** — auto-detecting which phase to start from based on what artifacts already exist.

### Full Lifecycle (from concept)

| Phase | Purpose |
|---|---|
| **Research** *(optional)* | Technology stack research, keyword extraction |
| **Analysis** | Concept → structured product brief (problem, users, features) |
| **Planning** | Brief → epics and stories |
| **Solutioning** | Architecture: tech stack, design decisions, constraints |
| **Implementation** | Parallel story execution (see below) |
| **Contract Verification** | Post-sprint cross-story interface validation |

### Per-Story Implementation

Each story flows through a sequence of phases with a quality-gated review loop:

```
create-story → test-plan → dev-story → build-fix → code-review
                                                       ↓
                                       SHIP_IT → verification → done ✓
                                       NEEDS_MINOR_FIXES → fix → code-review
                                       NEEDS_MAJOR_REWORK → rework → code-review
                                       max cycles exceeded → escalated ⚠
```

Stories run in parallel across your available agents, each in its own git worktree. After dev-story completes, an optional `probe-author` phase dispatches for event-driven and state-integrating ACs (see [Verification Pipeline](#verification-pipeline)) to derive runtime probes from AC text. Build-fix runs the project's build to catch compilation errors before code review.

### Verification Pipeline

Six gates run after code review. Each can pass, warn, or fail; failures block SHIP_IT.

| Gate | What it catches |
|---|---|
| **phantom-review** | Code review that returned no real verdict (review output malformed/empty) |
| **trivial-output** | Output token count below threshold — likely no real work done |
| **acceptance-criteria-evidence** | Each AC has demonstrable evidence in dev-story signals (files modified, tests added) |
| **build** | Project build succeeds against the dev's worktree |
| **runtime-probes** | Each declared `## Runtime Probes` section probe runs successfully against real or sandboxed state. Includes auto-detection for error-shape envelopes (`{"isError": true}`, `{"status": "error"}`) and production-trigger requirements for event-driven ACs. Frontmatter `external_state_dependencies` declarations hard-gate when probes section is missing. |
| **source-ac-fidelity** | AC text in source epic appears verbatim in story artifact (paths, MUST clauses, hard contracts). Includes 4 context-aware heuristics: negation (paths the AC says NOT to deliver), dependency-context (peer packages the implementation imports), operational-path (system install destinations like `.git/hooks/`), and alternative-option groups. |

### Already Have Planning Artifacts?

Substrate skips to whichever phase is needed:

| File | Purpose |
|---|---|
| `_bmad-output/planning-artifacts/epics.md` *(or per-epic `epic-N-*.md`)* | Parsed into per-epic context shards |
| `_bmad-output/planning-artifacts/architecture.md` | Tech stack and constraints for agents |
| `_bmad-output/implementation-artifacts/<key>-*.md` | Existing story files — substrate skips re-creation |

Drop these in any project and run `substrate run --events --stories <keys>` to dispatch implementation.

## AI Agent Integration

Substrate is designed to be operated by AI agents, not just humans. Three mechanisms teach agents how to interact with the pipeline at runtime.

### CLAUDE.md Scaffold

`substrate init` injects a `## Substrate Pipeline` section into your project's `CLAUDE.md` with:

- Instructions to run `--help-agent` on first use
- Event-driven interaction patterns (escalation handling, fix offers, confirmation requirements)
- Supervisor workflow guidance
- Cross-project observation lifecycle norms (reopen-evidence requirements)
- Version stamp for detecting stale instructions after upgrades

The section is wrapped in `<!-- substrate:start/end -->` markers for idempotent updates. Re-running `init` updates the substrate section while preserving everything else.

### Self-Describing CLI (`--help-agent`)

```bash
substrate run --help-agent
```

Outputs a machine-optimized prompt fragment (<2000 tokens) that an AI agent can ingest as a system prompt. Generated from the same TypeScript type definitions as the event emitter, so documentation never drifts from implementation. Includes:

- All commands and flags with examples
- Capabilities manifest — installed version, available engines, configured providers, active features
- Complete event protocol schema
- Decision flowchart for handling each event type

### Slash Commands

`substrate init` generates `.claude/commands/` slash commands:

- `/substrate-run` — start or resume a pipeline run with structured events
- `/substrate-supervisor` — launch the supervisor with stall detection and auto-restart
- `/substrate-metrics` — query run history and analysis reports
- `/substrate-factory-loop` — run the convergence loop (see [Software Factory](#software-factory-advanced))

### NDJSON Event Protocol

With `--events`, Substrate emits newline-delimited JSON events on stdout for programmatic consumption:

| Event | When |
|---|---|
| `pipeline:start` | Pipeline begins (`run_id`, `stories[]`, `concurrency`) |
| `pipeline:complete` | Pipeline ends (`succeeded[]`, `failed[]`, `escalated[]`) |
| `pipeline:heartbeat` | Periodic heartbeat with active/completed/queued dispatch counts |
| `pipeline:contract-mismatch` | Cross-story interface conflict detected |
| `story:phase` | Story transitions phase (`create-story`, `test-plan`, `dev-story`, `build-fix`, `code-review`, `fix`) |
| `story:done` | Story reaches terminal state |
| `story:metrics` | Per-story wall-clock, tokens, phase breakdown |
| `story:escalation` | Story escalated with issue list |
| `story:warn` | Non-fatal warning (token ceiling, low output, etc.) |
| `verification:check-complete` | Single verification gate finished |
| `verification:story-complete` | All verification gates done for a story |
| `probe-author:*` | Probe-author phase events (`dispatched`, `output-parsed`, `appended-to-artifact`, `skipped`, `authored-probe-failed`) |
| `supervisor:*` | Supervisor lifecycle (`poll`, `kill`, `restart`, `abort`, `summary`) |
| `supervisor:experiment:*` | Self-improvement loop (`start`, `recommendations`, `complete`, `skip`, `error`) |

All events carry a `ts` (ISO-8601) field. Full TypeScript types are exported:

```typescript
import type { PipelineEvent, StoryEscalationEvent } from 'substrate-ai'

const event: PipelineEvent = JSON.parse(line)
if (event.type === 'story:escalation') {
  for (const issue of event.issues) {
    console.log(`[${issue.severity}] ${issue.file}: ${issue.desc}`)
  }
}
```

## Supported Worker Agents

Substrate dispatches work to CLI-based AI agents running as child processes. It never calls LLMs directly from the dispatch path — implementation, code review, and story generation are all delegated to worker agents.

| Agent ID | CLI Tool | Billing |
|---|---|---|
| `claude-code` | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Subscription (Max) or API key |
| `codex` | [Codex CLI](https://github.com/openai/codex) | Subscription (ChatGPT Plus/Pro) or API key |
| `gemini` | Gemini CLI | Subscription or API key |

`substrate adapters list` shows what's installed and healthy. `substrate adapters check` runs full headless-mode verification on each.

Substrate routes work through CLI tools you already have installed, maximizing your existing AI subscriptions before falling back to pay-per-token billing. Per-task routing is configurable in `.substrate/routing-policy.yaml` and tunable via `substrate routing`.

## Observability and Self-Improvement

### Live Pipeline Monitoring

```bash
# Human-readable progress (default)
substrate run

# Real-time health
substrate health --output-format json

# Poll status
substrate status --output-format json

# TUI dashboard
substrate run --tui
```

- **TTY mode**: ANSI cursor control for in-place line updates
- **Non-TTY mode**: plain text, one line per update (CI-friendly)
- Respects `NO_COLOR` environment variable

### Supervisor

Long-running monitor that watches pipeline health:

```bash
substrate supervisor --output-format json
```

- Detects stalled agents (configurable threshold)
- Kills stuck process trees and auto-restarts via `resume`
- Inherits story scope from health snapshots on restart
- Emits structured events for each action taken

### Self-Improvement Loop

```bash
substrate supervisor --experiment --output-format json
```

After the pipeline completes, the supervisor:

1. **Analyzes** the run — identifies bottlenecks, token waste, slow stories
2. **Generates recommendations** — prompt tweaks, config changes, routing adjustments
3. **Runs A/B experiments** — applies each recommendation in an isolated worktree, re-runs affected stories, compares metrics
4. **Verdicts**: IMPROVED changes are kept and auto-PRed; REGRESSED changes are discarded

### Post-Run Review

Two commands turn a finished run into actionable operator output:

```bash
# Structured per-run completion report
substrate report --run latest                    # per-story outcomes + escalation diagnostics
substrate report --run latest --verify-ac        # appends AC-to-Test traceability matrix
substrate report --run latest --output-format json

# Path A reconciliation — when pipeline reports failed but tree is coherent
substrate reconcile-from-disk --dry-run          # report without mutating Dolt
substrate reconcile-from-disk --yes              # mark stories complete without prompting
```

`substrate report` resolves the active run via the canonical chain — explicit `--run-id` → `.substrate/current-run-id` → Dolt fallback — and surfaces story outcomes (verified / recovered / escalated / failed), cost vs ceiling, escalation diagnostics, and any operator halt notifications written to `.substrate/notifications/`. `--verify-ac` runs heuristic word-overlap matching between AC text and test names to expose ACs without test coverage.

`substrate reconcile-from-disk` is the Path A primitive. When a pipeline reports failure but `git status` + the project gates show the implementation is on disk and passing (a class of false-failures the cross-story-race auto-recovery in Epic 70 addresses but doesn't fully eliminate), this command detects working-tree changes since the run started, runs the gates, and prompts to mark stories complete in Dolt.

### Metrics, Cost, and Diff

```bash
# Historical run metrics
substrate metrics --output-format json

# Compare two runs side-by-side
substrate metrics --compare <run-a>,<run-b>

# Read analysis report from a supervisor run
substrate metrics --analysis <run-id> --output-format json

# Cost breakdown
substrate cost --output-format json

# Probe-author KPI summary (catch rate, cost, dispatches)
substrate metrics --probe-author-summary
```

With Dolt as the state backend:

```bash
# Row-level diff of state changes for a story
substrate diff <story-key>

# Commit log of pipeline state mutations
substrate history
```

### Operator Annotations

Tag verification findings as confirmed defects, false positives, or probe bugs to drive probe-author KPI feedback:

```bash
substrate annotate --story 7-3 --finding-category runtime-probe-fail --confirmed-defect --note "..."
substrate annotate --story 7-4 --finding-category source-ac-drift --false-positive
```

## Software Factory (Advanced)

Beyond the linear SDLC pipeline, Substrate includes a graph-based execution engine and autonomous quality system.

### Graph Engine

```bash
substrate run --engine graph --events
```

Reads pipeline topology from DOT files (Graphviz format), enabling:

- Conditional edges (retry loops, branching on review verdict)
- Parallel fan-out/fan-in with configurable join policies
- LLM-evaluated edge conditions
- Subgraph composition with depth guards
- Custom pipeline templates

### Scenario-Based Validation

External test scenarios that the agent can't game:

```bash
substrate factory scenarios list
substrate factory scenarios run
```

- **Scenario Store**: SHA-256 manifests for integrity verification
- **Satisfaction Scoring**: weighted composite of pass rate, performance, complexity
- **Convergence Loops**: iterate until satisfaction threshold met, with plateau detection and budget controls

### Quality Modes

Configure how stories are validated via `.substrate/config.yaml`:

| Mode | Description |
|---|---|
| `code-review` | Code review verdict drives the gate (default) |
| `dual-signal` | Both scenario satisfaction and code review required |
| `scenario-primary` | Satisfaction score is authoritative |
| `scenario-only` | Satisfaction only; code review skipped |

### Digital Twins

Docker Compose-managed services for external validation environments:

```bash
substrate factory twins up
substrate factory twins status
substrate factory twins down
```

## Substrate-on-Substrate (Self-Development)

Substrate's own development is dispatched through substrate. To dispatch a substrate fix from substrate's own working tree:

```bash
# Author or update the epic doc:
#   _bmad-output/planning-artifacts/epic-NN-<topic>.md

# Ingest into the work graph:
substrate ingest-epic _bmad-output/planning-artifacts/epic-64-state-integrating-ac-frontmatter-and-gate.md

# Dispatch the planned stories:
substrate run --events --stories 64-2,64-3 --max-review-cycles 3
```

For local CLI changes during dev, use `npm run substrate:dev -- <args>` instead of bare `substrate` (the global binary runs the published version, not your local code).

This is also how empirical smoke validation works for prompt-edit ships: a fixture epic at `_bmad-output/planning-artifacts/epic-999-prompt-smoke-state-integrating.md` is dispatched to verify prompt changes produce the structural property they target before publishing.

## Using as a Library

Substrate ships as a family of npm packages. Most users just want the CLI (`substrate-ai`); the scoped packages are for downstream projects that want to embed substrate pieces directly.

| Package | Use when you want... |
|---|---|
| `substrate-ai` | The full CLI — installed globally |
| `@substrate-ai/core` | Transport-agnostic primitives — event bus, adapters, cost tracker, telemetry, config schema |
| `@substrate-ai/sdlc` | SDLC orchestration — phase handlers, graph orchestrator, verification pipeline (all 6 gates), learning loop |
| `@substrate-ai/factory` | Graph engine, scenario runner, convergence loop, digital twin helpers, LLM client (with streaming for Anthropic / OpenAI / Gemini) |

All four packages release in lockstep on every `v*` tag push.

```bash
npm install @substrate-ai/core @substrate-ai/factory
```

```typescript
import { createEventBus } from '@substrate-ai/core'
import { parseGraph, createGraphExecutor } from '@substrate-ai/factory'
import { createSdlcEventBridge } from '@substrate-ai/sdlc'

// Compose these primitives in your own orchestrator.
```

TypeScript declarations bundled. Published tarballs carry an npm provenance attestation you can verify with `npm audit signatures`.

## Configuration

Substrate reads configuration from `.substrate/config.yaml` in your project root. Run `substrate init` to generate defaults.

```yaml
config_format_version: '1'

global:
  log_level: info
  max_concurrent_tasks: 4        # Parallel story limit
  budget_cap_usd: 0              # 0 = unlimited

providers:
  claude:
    enabled: true
    max_concurrent: 2
    rate_limit:
      tokens: 220000
      window_seconds: 18000

# Optional: per-workflow token limits
token_ceilings:
  dev-story: 200000
  code-review: 150000

# Optional: dispatch timeout overrides (ms)
dispatch_timeouts:
  dev-story: 1800000              # 30 min
```

### Configuration Files

| File | Purpose |
|---|---|
| `.substrate/config.yaml` | Provider routing, concurrency, budgets, quality mode |
| `.substrate/project-profile.yaml` | Auto-detected build system, language, test framework |
| `.substrate/routing-policy.yaml` | Task-to-provider routing rules |
| `CLAUDE.md` | Agent scaffold with substrate instructions |
| `.claude/commands/` | Slash commands for Claude Code |

### State Backend

Substrate persists pipeline state (work graph, decisions, telemetry, runs, repo-map) in either:

- **SQLite** (default) — zero setup, single-file durable state
- **Dolt** (recommended) — versioned state, branchable, enables `substrate diff` and `substrate history`

```bash
# With Dolt (auto-detected if `dolt` is on PATH)
substrate init
```

Without Dolt, all functionality works except for: `substrate diff`, `substrate history`, persistent OTEL observability tables, and context engineering repo-map storage.

## CLI Command Reference

These commands are typically invoked by your AI assistant during pipeline operation. You usually don't run them directly.

### Pipeline

| Command | Description |
|---|---|
| `substrate run` | Run the full pipeline (auto-detects starting phase) |
| `substrate run --events` | Emit NDJSON event stream on stdout |
| `substrate run --stories <keys>` | Run specific stories (e.g., `7-1,7-2`) |
| `substrate run --epic <n>` | Scope discovery to a single epic number |
| `substrate run --from <phase>` | Start from a specific phase |
| `substrate run --stop-after <phase>` | Stop pipeline after this phase |
| `substrate run --engine graph` | Use the graph execution engine |
| `substrate run --halt-on <severity>` | Decision Router halt policy (`all` / `critical` / `none`) — see [Autonomy Modes](#autonomy-modes) |
| `substrate run --non-interactive` | Suppress all stdin prompts and apply default actions; required for CI/CD |
| `substrate run --verify-ac` | On-demand AC-to-Test traceability matrix |
| `substrate run --cost-ceiling <usd>` | Halt run when cumulative cost crosses this threshold |
| `substrate run --max-review-cycles <n>` | Cycles per story (default 2; use 3 for migrations / interface extraction) |
| `substrate run --skip-verification` | Skip post-dispatch verification (use sparingly) |
| `substrate run --help-agent` | Print agent instruction prompt fragment |
| `substrate resume` | Resume an interrupted run |
| `substrate cancel` | Cancel a running pipeline |
| `substrate status` | Show pipeline run status |
| `substrate amend` | Run an amendment pipeline against a completed run |
| `substrate brainstorm` | Interactive multi-persona ideation session |

### Work Graph

| Command | Description |
|---|---|
| `substrate ingest-epic <path>` | Parse an epic doc and upsert story metadata into the work graph |
| `substrate epic-status <epic>` | Generated status view of an epic from the Dolt work graph |
| `substrate retry-escalated` | Retry escalated stories flagged retry-targeted by escalation diagnosis |

### Observability

| Command | Description |
|---|---|
| `substrate health` | Pipeline health, stall detection, process status |
| `substrate supervisor` | Long-running monitor with kill-and-restart |
| `substrate supervisor --experiment` | Self-improvement: analysis + A/B experiments |
| `substrate metrics` | Historical pipeline run metrics |
| `substrate metrics --compare <a,b>` | Side-by-side run comparison |
| `substrate metrics --analysis <run-id>` | Read analysis report for a specific run |
| `substrate metrics --probe-author-summary` | Probe-author KPI aggregate |
| `substrate diff [storyKey]` | Stat-based diff of state changes (Dolt only) |
| `substrate history` | Dolt commit log for state mutations |
| `substrate cost` | Cost / token usage summary |
| `substrate monitor` | Agent performance metrics |
| `substrate probes` | Inspect runtime-probe sections across story artifacts |

### Operator Workflow

| Command | Description |
|---|---|
| `substrate report [--run <id\|latest>]` | Per-run completion report — outcomes, cost, escalation diagnostics, halt notifications |
| `substrate report --verify-ac` | Append heuristic AC-to-Test traceability matrix to the report |
| `substrate reconcile-from-disk [--dry-run] [--yes]` | Path A reconciliation — gates green + tree coherent ⇒ mark stories complete in Dolt |
| `substrate annotate` | Tag verification finding as confirmed-defect / false-positive / probe-bug |
| `substrate probe-author dispatch` | Manually invoke probe-author phase against a single story file |
| `substrate contracts` | Show contract declarations and verification status |

### Setup

| Command | Description |
|---|---|
| `substrate init` | Initialize config, CLAUDE.md scaffold, slash commands, state backend |
| `substrate adapters list` | List known AI agent adapters with availability |
| `substrate adapters check` | Run health checks across all adapters |
| `substrate config` | Show, set, export, or import configuration |
| `substrate routing` | Show / tune routing configuration |
| `substrate repo-map` | Show / update / query the repo-map symbol index |
| `substrate upgrade` | Check for updates and upgrade |
| `substrate migrate` | Migrate historical SQLite data into Dolt |

### Worktree Management

| Command | Description |
|---|---|
| `substrate merge` | Detect conflicts and merge worktree branches into target |
| `substrate worktrees` | List active worktrees and associated tasks |

### Export

| Command | Description |
|---|---|
| `substrate export` | Export decision store contents as markdown |
| `substrate export --run-id <id>` | Export artifacts from a specific run |

### Software Factory

| Command | Description |
|---|---|
| `substrate factory scenarios list` | List defined scenarios |
| `substrate factory scenarios run` | Run scenarios in convergence loop |
| `substrate factory twins up` | Bring up Docker Compose digital twins |
| `substrate factory twins status` | Twin service status |
| `substrate factory twins down` | Tear down twins |

## Development

```bash
git clone https://github.com/johnplanow/substrate.git
cd substrate
npm install
npm run build
npm run test:fast   # ~50s unit suite for iteration
npm test            # full suite with coverage — run before merging
```

The repo is an npm workspaces monorepo — see [Using as a Library](#using-as-a-library) for the four packages it publishes. Release mechanics live in `scripts/sync-workspace-versions.mjs` and `.github/workflows/publish.yml`: every `v*` tag push syncs workspace package versions to the root, dry-runs all four tarballs, and publishes via npm OIDC trusted publishing.

To test local CLI changes without overriding the global binary:

```bash
npm run build
npm run substrate:dev -- run --events --stories 999-1
```

The project's [`.claude/commands/ship.md`](.claude/commands/ship.md) defines a `/ship` workflow that runs build / circular-deps / typecheck / tests / (conditional empirical prompt-edit smoke for `packs/bmad/prompts/*.md` changes) before commit and push.

## License

MIT
