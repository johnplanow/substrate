<p align="center">
  <img src="https://raw.githubusercontent.com/johnplanow/substrate/main/assets/substrate-header.png" alt="Substrate — Autonomous Software Development Pipeline" />
</p>

# Substrate

Substrate is an autonomous software development pipeline, operated by your AI coding assistant. Install it, initialize your project, and tell Claude what to build — Substrate handles the rest.

Most multi-agent coding tools help you run AI sessions in parallel but leave planning, quality control, and learning up to you. Substrate is different: it packages structured planning methodology, multi-agent parallel execution, automated code review cycles, and self-improvement into a single pipeline. Describe your project concept, and Substrate takes it from research through implementation and review — coordinating multiple AI coding agents across isolated worktree branches while a supervisor watches for stalls, auto-recovers, and experiments with improvements to close the loop.

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

Here's what that looks like in practice:

```
You: "Implement stories 7-1 through 7-5"

Claude Code: runs `substrate run --events --stories 7-1,7-2,7-3,7-4,7-5`

Substrate:   dispatches 5 stories across 3 agents in parallel worktrees
             → story 7-1: dev complete, code review: SHIP_IT ✓
             → story 7-2: dev complete, code review: NEEDS_MINOR_FIXES → auto-fix → SHIP_IT ✓
             → story 7-3: escalated (interface conflict) → Claude asks you what to do
             → story 7-4: dev complete, code review: SHIP_IT ✓
             → story 7-5: dev complete, code review: SHIP_IT ✓

Claude Code: "4 succeeded, 1 escalated — here's the interface conflict in 7-3..."
```

## Prerequisites

- **Node.js** 22.0.0 or later
- **git** 2.20 or later
- At least one supported AI CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - Gemini CLI (`gemini`)

## Quick Start

### Install and Initialize

```bash
npm install -g substrate-ai
cd your-project
substrate init
```

This does three things:
1. **Generates `.substrate/config.yaml`** — provider routing, concurrency, budgets
2. **Injects a `## Substrate Pipeline` section into CLAUDE.md** — behavioral directives that teach your AI assistant how to operate the pipeline
3. **Creates `.claude/commands/` slash commands** — `/substrate-run`, `/substrate-supervisor`, `/substrate-metrics`

### Run From Your AI Assistant

Start a Claude Code session in your project. Claude automatically reads the substrate instructions from CLAUDE.md and knows how to operate the pipeline. From there:

- **"Run the substrate pipeline"** — Claude runs the full lifecycle from analysis through implementation
- **"Run substrate for stories 7-1, 7-2, 7-3"** — Claude implements specific stories
- **"/substrate-run"** — invoke the slash command directly for a guided pipeline run

Claude parses structured events, handles escalations, offers to fix review issues, and summarizes results. You stay in control — Claude always asks before re-running failed stories or applying fixes.

### Monitor and Self-Improve

While the pipeline runs (or after it finishes):

> "Run the substrate supervisor"

The supervisor watches the pipeline, kills stalls, and auto-restarts. When the run completes, it analyzes what happened — bottlenecks, token waste, slow stories — then optionally runs A/B experiments on prompts and config in isolated worktrees. Improvements get auto-PRed; regressions get discarded.

This is the full loop: **run → watch → analyze → experiment → improve.**

### Run From the CLI Directly

You can also run substrate directly from the terminal:

```bash
# Full pipeline with NDJSON event stream
substrate run --events

# Specific stories
substrate run --events --stories 7-1,7-2,7-3

# Human-readable progress output (default)
substrate run
```

## The Pipeline

When you tell Substrate to build something, it runs through up to six phases — auto-detecting which phase to start from based on what artifacts already exist:

### Full Lifecycle (from concept)

1. **Research** — technology stack research, keyword extraction (optional)
2. **Analysis** — processes concept into structured product brief with problem statement, target users, core features
3. **Planning** — breaks product brief into epics and stories
4. **Solutioning** — technical architecture design with constraints, tech stack, design decisions
5. **Implementation** — parallel story execution (see below)
6. **Contract Verification** — post-sprint validation of cross-story interfaces

### Per-Story Implementation

Each story flows through a quality-gated loop:

```
create-story → dev-story → build-verify → code-review
                                              ↓
                              SHIP_IT → done ✓
                              NEEDS_MINOR_FIXES → auto-fix → code-review
                              NEEDS_MAJOR_REWORK → rework → code-review
                              max cycles exceeded → escalated ⚠
```

Stories run in parallel across your available agents, each in its own git worktree. Build verification catches compilation errors before code review. Zero-diff detection catches phantom completions. Interface change warnings flag potential cross-module impacts.

### Already Have Planning Artifacts?

If your project already has BMAD artifacts (from any tool), Substrate skips straight to implementation:

| File | Required? | Purpose |
|------|-----------|---------|
| `_bmad-output/planning-artifacts/epics.md` | Yes | Parsed into per-epic context shards |
| `_bmad-output/planning-artifacts/architecture.md` | Yes | Tech stack and constraints for agents |
| `_bmad-output/implementation-artifacts/*.md` | Optional | Existing story files — Substrate skips creation for any it finds |

## AI Agent Integration

Substrate is designed to be operated by AI agents, not just humans. Three mechanisms teach agents how to interact with the pipeline at runtime:

### CLAUDE.md Scaffold

`substrate init` injects a `## Substrate Pipeline` section into your project's CLAUDE.md with:

- Instructions to run `--help-agent` on first use
- Event-driven interaction patterns (escalation handling, fix offers, confirmation requirements)
- Supervisor workflow guidance
- Version stamp for detecting stale instructions after upgrades

The section is wrapped in `<!-- substrate:start/end -->` markers for idempotent updates. Re-running `init` updates the substrate section while preserving all other CLAUDE.md content.

### Self-Describing CLI (`--help-agent`)

```bash
substrate run --help-agent
```

Outputs a machine-optimized prompt fragment (<2000 tokens) that an AI agent can ingest as a system prompt. Generated from the same TypeScript type definitions as the event emitter, so documentation never drifts from implementation. Includes:

- All available commands and flags with examples
- Capabilities manifest — installed version, available engines, configured providers, active features
- Complete event protocol schema
- Decision flowchart for handling each event type

### Slash Commands

`substrate init` generates `.claude/commands/` slash commands:

- `/substrate-run` — Start or resume a pipeline run with structured events
- `/substrate-supervisor` — Launch the supervisor monitor with stall detection and auto-restart
- `/substrate-metrics` — Query run history, compare runs, and read analysis reports

### NDJSON Event Protocol

With `--events`, Substrate emits newline-delimited JSON events on stdout for programmatic consumption:

```bash
substrate run --events
```

Event types form a discriminated union on the `type` field:

| Event | Description |
|-------|-------------|
| `pipeline:start` | Pipeline begins — includes `run_id`, `stories[]`, `concurrency` |
| `pipeline:complete` | Pipeline ends — includes `succeeded[]`, `failed[]`, `escalated[]` |
| `story:phase` | Story transitions between phases (`create-story`, `dev-story`, `code-review`, `fix`) |
| `story:done` | Story reaches terminal state with `review_cycles` count |
| `story:escalation` | Story escalated — includes issue list with severities |
| `story:metrics` | Per-story wall-clock time, token counts, phase breakdown |
| `story:warn` | Non-fatal warning (e.g., token ceiling truncation) |
| `pipeline:heartbeat` | Periodic heartbeat with active/completed/queued dispatch counts |
| `supervisor:*` | Supervisor lifecycle — `poll`, `kill`, `restart`, `abort`, `summary` |
| `supervisor:experiment:*` | Experiment loop — `start`, `recommendations`, `complete`, `error` |

All events carry a `ts` (ISO-8601 timestamp) field. Full TypeScript types are exported:

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

Substrate dispatches work to CLI-based AI agents running as child processes. It never calls LLMs directly — all implementation, code review, and story generation is delegated to worker agents.

| Agent ID | CLI Tool | Billing |
|----------|----------|---------|
| `claude-code` | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Subscription (Max) or API key |
| `codex` | [Codex CLI](https://github.com/openai/codex) | Subscription (ChatGPT Plus/Pro) or API key |
| `gemini` | Gemini CLI | Subscription or API key |

Substrate auto-discovers available agents at startup and routes work based on adapter health checks and your routing configuration. Unlike API-based orchestrators, Substrate routes work through the CLI tools you already have installed, maximizing your existing AI subscriptions before falling back to pay-per-token billing.

## Observability and Self-Improvement

### Pipeline Monitoring

```bash
# Human-readable progress (default)
substrate run
# Shows compact, updating progress lines:
#   [dev]    7-2 implementing...
#   [review] 7-3 SHIP_IT (1 cycle)
#   [done]   7-5 SHIP_IT (2 cycles)

# Real-time health check
substrate health --output-format json

# Poll status
substrate status --output-format json
```

- **TTY mode**: ANSI cursor control for in-place line updates
- **Non-TTY mode**: plain text, one line per update (CI-friendly)
- Respects `NO_COLOR` environment variable

### Supervisor

The supervisor is a long-running monitor that watches pipeline health:

```bash
substrate supervisor --output-format json
```

- Detects stalled agents (configurable threshold)
- Kills stuck process trees and auto-restarts via `resume`
- Emits structured events for each action taken

### Self-Improvement Loop

```bash
substrate supervisor --experiment --output-format json
```

After the pipeline completes, the supervisor:
1. **Analyzes** the run — identifies bottlenecks, token waste, slow stories
2. **Generates recommendations** — prompt tweaks, config changes, routing adjustments
3. **Runs A/B experiments** — applies each recommendation in an isolated worktree, re-runs affected stories, compares metrics
4. **Verdicts**: IMPROVED changes are kept, REGRESSED changes are discarded

### Metrics and Cost Tracking

```bash
# Historical run metrics
substrate metrics --output-format json

# Compare two runs side-by-side
substrate metrics --compare <run-a>,<run-b>

# Read analysis report
substrate metrics --analysis <run-id> --output-format json

# Cost breakdown
substrate cost --output-format json
```

## Software Factory (Advanced)

Beyond the linear SDLC pipeline, Substrate includes a graph-based execution engine and autonomous quality system:

### Graph Engine

```bash
substrate run --engine graph --events
```

The graph engine reads pipeline topology from DOT files (Graphviz format), enabling:
- Conditional edges (retry loops, branching on review verdict)
- Parallel fan-out/fan-in with configurable join policies
- LLM-evaluated edge conditions
- Subgraph composition with depth guards
- Custom pipeline templates

### Scenario-Based Validation

Instead of (or alongside) code review, define external test scenarios that the agent can't game:

```bash
substrate factory scenarios list
substrate factory scenarios run
```

- **Scenario Store**: SHA-256 manifests for integrity verification
- **Satisfaction Scoring**: weighted composite of scenario pass rate, performance, complexity
- **Convergence Loops**: iterate until satisfaction threshold met, with plateau detection and budget controls

### Quality Modes

Configure how stories are validated via `.substrate/config.yaml`:

| Mode | Description |
|------|-------------|
| `code-review` | Traditional — code review verdict drives the gate (default) |
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

## Using as a Library

Substrate ships as a family of npm packages. Most users just want the CLI (`substrate-ai`); the scoped packages are for downstream projects that want to embed substrate pieces directly.

| Package | Use when you want... |
|---------|----------------------|
| `substrate-ai` | The full CLI — installed globally |
| `@substrate-ai/core` | Transport-agnostic primitives — event bus, adapters, cost tracker, telemetry, config schema |
| `@substrate-ai/sdlc` | SDLC orchestration — phase handlers, graph orchestrator, verification pipeline, learning loop |
| `@substrate-ai/factory` | Graph engine, scenario runner, convergence loop, digital twin helpers, LLM client |

All four packages release in lockstep on every `v*` tag push — pick a version and mix any combination:

```bash
npm install @substrate-ai/core @substrate-ai/factory
```

```typescript
import { createEventBus } from '@substrate-ai/core'
import { parseGraph, createGraphExecutor } from '@substrate-ai/factory'
import { createSdlcEventBridge } from '@substrate-ai/sdlc'

// Compose these primitives in your own orchestrator.
```

TypeScript declaration files are bundled in each package. Published tarballs carry an npm provenance attestation you can verify with `npm audit signatures`.

## Configuration

Substrate reads configuration from `.substrate/config.yaml` in your project root. Run `substrate init` to generate defaults.

### Key Configuration

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
|------|---------|
| `.substrate/config.yaml` | Provider routing, concurrency, budgets, quality mode |
| `.substrate/project-profile.yaml` | Auto-detected build system, language, test framework |
| `.substrate/routing-policy.yaml` | Task-to-provider routing rules |
| `CLAUDE.md` | Agent scaffold with substrate instructions |
| `.claude/commands/` | Slash commands for Claude Code |

### Versioned State Backend (Optional)

Substrate supports [Dolt](https://www.dolthub.com/) for versioned pipeline state:

```bash
substrate init --dolt
```

This enables:
- `substrate diff <story>` — row-level state changes per story
- `substrate history` — commit log of pipeline state mutations
- OTEL observability persistence
- Context engineering repo-map storage

Without Dolt, everything works using plain SQLite.

## CLI Command Reference

These commands are invoked by AI agents during pipeline operation. You typically don't run them directly — you tell your agent what to do and it selects the right command.

### Pipeline

| Command | Description |
|---------|-------------|
| `substrate run` | Run the full pipeline (analysis → implement) |
| `substrate run --events` | Emit NDJSON event stream on stdout |
| `substrate run --stories <keys>` | Run specific stories (e.g., `7-1,7-2`) |
| `substrate run --from <phase>` | Start from a specific phase |
| `substrate run --engine graph` | Use the graph execution engine |
| `substrate run --help-agent` | Print agent instruction prompt fragment and exit |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate status` | Show pipeline run status |
| `substrate amend` | Run an amendment pipeline against a completed run |
| `substrate brainstorm` | Interactive multi-persona ideation session |

### Observability

| Command | Description |
|---------|-------------|
| `substrate health` | Check pipeline health, stall detection, and process status |
| `substrate supervisor` | Long-running monitor with kill-and-restart recovery |
| `substrate supervisor --experiment` | Self-improvement: post-run analysis + A/B experiments |
| `substrate metrics` | Historical pipeline run metrics |
| `substrate metrics --compare <a,b>` | Side-by-side comparison of two runs |
| `substrate metrics --analysis <run-id>` | Read the analysis report for a specific run |
| `substrate monitor status` | View agent performance metrics |
| `substrate cost` | View cost and token usage summary |

### Export and Sharing

| Command | Description |
|---------|-------------|
| `substrate export` | Export planning artifacts as markdown |
| `substrate export --run-id <id>` | Export artifacts from a specific pipeline run |
| `substrate export --output-format json` | Emit JSON result for agent consumption |

### Worktree Management

| Command | Description |
|---------|-------------|
| `substrate merge` | Detect conflicts and merge worktree branches into target |
| `substrate worktrees` | List active git worktrees and their tasks |

### Setup

| Command | Description |
|---------|-------------|
| `substrate init` | Initialize config, CLAUDE.md scaffold, and slash commands |
| `substrate adapters` | List and check available AI agent adapters |
| `substrate config` | Show, set, export, or import configuration |
| `substrate upgrade` | Check for updates and upgrade to the latest version |

## Development

```bash
git clone https://github.com/johnplanow/substrate.git
cd substrate
npm install
npm run build
npm run test:fast   # ~50s unit suite for iteration
npm test            # full suite with coverage — run before merging
```

The repo is an npm workspaces monorepo — see [Using as a Library](#using-as-a-library) for the four packages it publishes. Release mechanics live in `scripts/sync-workspace-versions.mjs` and `.github/workflows/publish.yml`: every `v*` tag push syncs the workspace package versions to the root, dry-runs all four tarballs, and publishes via npm OIDC trusted publishing.

## License

MIT
