<p align="center">
  <img src="https://raw.githubusercontent.com/johnplanow/substrate/main/assets/substrate-header.png" alt="Substrate — Autonomous Software Development Pipeline" />
</p>

# Substrate

Most multi-agent coding tools help you run AI sessions in parallel — but leave planning, quality control, and learning up to you. Substrate is different: it packages structured planning methodology, multi-agent parallel execution, automated code review cycles, and self-improvement into a single pipeline. Describe your project concept, and Substrate takes it from analysis through implementation and review — coordinating multiple AI coding agents (Claude Code, Codex, Gemini CLI) across isolated worktree branches while a supervisor watches for stalls, auto-recovers, and after each run experiments with improvements to close the loop automatically.

Unlike API-based orchestrators, Substrate routes work through the CLI tools you already have installed, maximizing your existing AI subscriptions before falling back to pay-per-token billing. Runs are persistent and resumable with full cost visibility across every provider.

## Prerequisites

- **Node.js** 22.0.0 or later
- **git** 2.20 or later
- At least one supported AI CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - Gemini CLI (`gemini`)

## Quick Start

### Install

Install globally and initialize in your project:

```bash
npm install -g substrate-ai
substrate init
```

Or as a project dependency:

```bash
npm install substrate-ai
npx substrate init
```

This scaffolds CLAUDE.md with behavioral directives and generates `.claude/commands/` slash commands. Claude Code reads these on session start and knows how to operate the pipeline automatically.

### Use Substrate From Claude

Start a Claude Code session in your project. Claude automatically sees the substrate instructions and slash commands. From there:

- **"Run the substrate pipeline"** — Claude runs the full lifecycle from analysis through implementation
- **"Run substrate for stories 7-1, 7-2, 7-3"** — Claude implements specific stories
- **"/substrate-run"** — invoke the slash command directly for a guided pipeline run
- **"/substrate-supervisor"** — launch the supervisor to monitor, recover stalls, and run experiments

Claude parses structured events, handles escalations, offers to fix review issues, and summarizes results. You stay in control — Claude always asks before re-running failed stories or applying fixes.

### Monitor and Self-Improve

While the pipeline runs (or after it finishes), tell Claude in the same or a separate session:

> "Run the substrate supervisor with experiments"

The supervisor watches the pipeline, kills stalls, and auto-restarts. When the run completes, it analyzes what happened — bottlenecks, token waste, slow stories — then runs A/B experiments on prompts and config in isolated worktrees. Improvements get auto-PRed; regressions get discarded.

Later, ask Claude to compare runs:

> "Compare the last two substrate runs"

This is the full loop: run → watch → analyze → experiment → improve.

### Pick Up an Existing BMAD Project

Already have a project with BMAD artifacts (from vanilla BMAD, the Beads-based ai-toolkit, or any other tool)? Substrate can pick up the remaining implementation work from inside a Claude Code session.

**What Substrate needs from your project:**

| File | Required? | Purpose |
|------|-----------|---------|
| `_bmad-output/planning-artifacts/epics.md` | Yes | Parsed into per-epic context shards |
| `_bmad-output/planning-artifacts/architecture.md` | Yes | Tech stack and constraints for agents |
| `_bmad-output/implementation-artifacts/*.md` | Optional | Existing story files — Substrate skips create-story for any it finds |
| `package.json` | Optional | Test framework detection |

After the same install + init from [Quick Start](#quick-start), start a Claude Code session and tell it what to do:

> "Run the substrate pipeline to implement the remaining stories."

Claude reads the CLAUDE.md scaffold, discovers the substrate commands, and drives the pipeline — implementing stories, handling code review cycles, and summarizing results. You stay in the loop for escalations and failed stories.

Substrate reads one directory — `_bmad-output/` — and doesn't care which tool created it. It does not read `sprint-status.yaml` or `.beads/` — you decide what's left by choosing which story keys to pass.

## Supported Worker Agents

Substrate dispatches work to CLI-based AI agents running as child processes. It never calls LLMs directly — all implementation, code review, and story generation is delegated to these worker agents.

| Agent ID | CLI Tool | Billing |
|----------|----------|---------|
| `claude-code` | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Subscription (Max) or API key |
| `codex` | [Codex CLI](https://github.com/openai/codex) | Subscription (ChatGPT Plus/Pro) or API key |
| `gemini` | Gemini CLI | Subscription or API key |

All three agents are fully supported as worker targets. Substrate auto-discovers available agents and routes work based on adapter health checks and configuration.

## Pipeline Observability

Substrate provides multiple output modes for monitoring pipeline execution.

### Human-Readable Progress (default)

`substrate run` displays compact, updating progress lines with color:

```
substrate run — 6 stories, concurrency 3

[create] 7-1 creating story...
[dev]    7-2 implementing...
[review] 7-3 SHIP_IT (1 cycle)
[fix]    7-4 fixing minor issues...
[done]   7-5 SHIP_IT (2 cycles)
[wait]   1-9 queued

Pipeline complete: 5 succeeded, 0 failed, 1 escalated
```

- **TTY mode**: ANSI cursor control for in-place line updates
- **Non-TTY mode**: plain text, one line per update (CI-friendly)
- Respects `NO_COLOR` environment variable
- Pino JSON logs suppressed by default — use `--verbose` to restore them

### NDJSON Event Protocol (`--events`)

For programmatic consumption, `--events` emits newline-delimited JSON events on stdout:

```bash
substrate run --events
substrate run --events --stories 7-1,7-2
```

Event types form a discriminated union on the `type` field:

| Event | Description |
|-------|-------------|
| `pipeline:start` | Pipeline begins — includes `run_id`, `stories[]`, `concurrency` |
| `pipeline:complete` | Pipeline ends — includes `succeeded[]`, `failed[]`, `escalated[]` |
| `story:phase` | Story transitions between phases (`create-story`, `dev-story`, `code-review`, `fix`) |
| `story:done` | Story reaches terminal success state with `review_cycles` count |
| `story:escalation` | Story escalated after exhausting review cycles — includes issue list with severities |
| `story:warn` | Non-fatal warning (e.g., token ceiling truncation) |
| `story:log` | Informational progress message |
| `supervisor:*` | Supervisor lifecycle events — `kill`, `restart`, `abort`, `summary` |
| `supervisor:analysis:*` | Post-run analysis events — `complete`, `error` |
| `supervisor:experiment:*` | Experiment loop events — `start`, `skip`, `recommendations`, `complete`, `error` |

All events carry a `ts` (ISO-8601 timestamp) field. The full TypeScript types are exported from the package:

```typescript
import type { PipelineEvent, StoryEscalationEvent } from 'substrate-ai'

const event: PipelineEvent = JSON.parse(line)
if (event.type === 'story:escalation') {
  for (const issue of event.issues) {
    console.log(`[${issue.severity}] ${issue.file}: ${issue.desc}`)
  }
}
```

## AI Agent Integration

Substrate is designed to be operated by AI agents, not just humans. Three mechanisms teach agents how to interact with the pipeline at runtime:

### Self-Describing CLI (`--help-agent`)

```bash
substrate run --help-agent
```

Outputs a machine-optimized markdown prompt fragment (<2000 tokens) that an AI agent can ingest as a system prompt. Generated from the same TypeScript type definitions as the event emitter, so documentation never drifts from implementation. Includes:

- All available commands and flags with examples
- Complete event protocol schema
- Decision flowchart for handling each event type
- Version stamp for detecting stale cached instructions

### CLAUDE.md Scaffold

`substrate init` injects a `## Substrate Pipeline` section into your project's CLAUDE.md with behavioral directives for Claude Code:

- Instructions to run `--help-agent` on first use
- Event-driven interaction patterns (escalation handling, fix offers, confirmation requirements)
- Supervisor workflow guidance (when to use `run` vs `supervisor` vs `supervisor --experiment`)
- Section is wrapped in `<!-- substrate:start/end -->` markers for idempotent updates
- Re-running `init` updates the substrate section while preserving all other CLAUDE.md content

### Slash Commands

`substrate init` also generates `.claude/commands/` slash commands that Claude Code can invoke directly:

- `/substrate-run` — Start or resume a pipeline run with structured events
- `/substrate-supervisor` — Launch the supervisor monitor with stall detection and auto-restart
- `/substrate-metrics` — Query run history, compare runs, and read analysis reports

These commands encode the recommended invocation patterns so Claude uses the right flags without needing to memorize them.

## Commands

These commands are invoked by AI agents (Claude Code, Codex, Gemini CLI) during pipeline operation. You typically don't run them directly — you tell your agent what to do and it selects the right command.

### Pipeline

| Command | Description |
|---------|-------------|
| `substrate brainstorm` | Interactive multi-persona ideation session |
| `substrate init` | Initialize config, methodology pack, CLAUDE.md scaffold, and slash commands |
| `substrate run` | Run the full pipeline (analysis → implement) |
| `substrate run --events` | Emit NDJSON event stream on stdout |
| `substrate run --stories <keys>` | Run specific stories (e.g., `7-1,7-2`) |
| `substrate run --from <phase>` | Start from a specific phase |
| `substrate run --help-agent` | Print agent instruction prompt fragment and exit |
| `substrate resume` | Resume an interrupted pipeline run |
| `substrate status` | Show pipeline run status |
| `substrate amend` | Run an amendment pipeline against a completed run |

### Observability

| Command | Description |
|---------|-------------|
| `substrate health` | Check pipeline health, stall detection, and process status |
| `substrate supervisor` | Long-running monitor that kills stalled runs and auto-restarts |
| `substrate supervisor --experiment` | Self-improvement loop: post-run analysis + A/B experiments |
| `substrate metrics` | Historical pipeline run metrics |
| `substrate metrics --compare <a,b>` | Side-by-side comparison of two runs |
| `substrate metrics --analysis <run-id>` | Read the analysis report for a specific run |
| `substrate monitor status` | View agent performance metrics |
| `substrate monitor report` | Generate a detailed performance report |
| `substrate monitor recommendations` | Display routing recommendations from performance data |
| `substrate cost` | View cost and token usage summary |

### Export & Sharing

| Command | Description |
|---------|-------------|
| `substrate export` | Export planning artifacts (product brief, PRD, architecture, epics) as markdown |
| `substrate export --run-id <id>` | Export artifacts from a specific pipeline run |
| `substrate export --output-dir <dir>` | Write to a custom directory (default: `_bmad-output/planning-artifacts/`) |
| `substrate export --output-format json` | Emit JSON result to stdout for agent consumption |

### Worktree Management

| Command | Description |
|---------|-------------|
| `substrate merge` | Detect conflicts and merge task worktree branches into the target branch |
| `substrate worktrees` | List all active git worktrees and their associated tasks |

### Setup

| Command | Description |
|---------|-------------|
| `substrate adapters` | List and check available AI agent adapters |
| `substrate config` | Show, set, export, or import configuration |
| `substrate upgrade` | Check for updates and upgrade to the latest version |
| `substrate --help` | Show all available commands |

## Configuration

Substrate reads configuration from `.substrate/config.yaml` in your project root. Run `substrate init` to generate a default config.

## Development

```bash
# Clone and install
git clone https://github.com/johnplanow/substrate.git
cd substrate
npm install

# Build
npm run build

# Run tests
npm test

# Development mode (watch)
npm run dev

# Type check
npm run typecheck

# Lint
npm run lint
```

## License

MIT
