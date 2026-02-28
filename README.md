<p align="center">
  <img src="https://raw.githubusercontent.com/johnplanow/substrate/main/assets/substrate-header.png" alt="Substrate — Autonomous Software Development Pipeline" />
</p>

# Substrate

Substrate is an autonomous software development pipeline. Describe your project in plain language and Substrate handles the rest — coordinating multiple AI coding agents (Claude Code, Codex, Gemini CLI) working in parallel across isolated branches to take your idea from concept through implementation and code review.

Unlike API-based orchestrators, Substrate routes work through the CLI tools you already have installed, maximizing your existing AI subscriptions before falling back to pay-per-token billing. Runs are persistent and resumable — no lost work, no re-execution waste, full cost visibility across every provider.

## Prerequisites

- **Node.js** 22.0.0 or later
- **git** 2.20 or later
- At least one supported AI CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - Gemini CLI (`gemini`)

## Installation

Install as a project dependency:

```bash
npm install substrate-ai
```

Or install globally:

```bash
npm install -g substrate-ai
```

Verify the installation:

```bash
npx substrate --version   # project install
substrate --version        # global install
```

> Examples below use `[npx] substrate` — include `npx` for project installs, omit for global.

## Quick Start

### Using Substrate from Claude Code

The primary way to use Substrate is from inside a Claude Code session. Substrate teaches Claude how to operate the pipeline automatically — no manual configuration needed.

1. **Install and initialize** in your project:

```bash
npm install substrate-ai
[npx] substrate auto init
```

This scaffolds CLAUDE.md with a `## Substrate Pipeline` section containing behavioral directives. Claude Code reads this on session start.

2. **Start a Claude Code session.** Claude sees the substrate instructions automatically and knows to run `substrate auto run --help-agent` on first use to learn the full event protocol, commands, and interaction patterns.

3. **Tell Claude what to build.** Claude drives the pipeline conversationally — running stories, parsing structured events, handling escalations, offering to fix review issues, and summarizing results. You stay in control: Claude always asks before re-running failed stories or applying fixes.

```bash
# What Claude runs under the hood:
substrate auto run --events --stories 7-1,7-2   # Structured NDJSON for Claude to parse
substrate auto run                               # Human-readable progress (default)
substrate auto run --help-agent                  # Full protocol reference (<2000 tokens)
```

### Pick Up an Existing BMAD Project

Already have a project with BMAD artifacts (from vanilla BMAD, the Beads-based ai-toolkit, or any other tool)? Substrate can pick up the remaining implementation work from inside a Claude Code session.

**What Substrate needs from your project:**

| File | Required? | Purpose |
|------|-----------|---------|
| `_bmad-output/planning-artifacts/epics.md` | Yes | Parsed into per-epic context shards |
| `_bmad-output/planning-artifacts/architecture.md` | Yes | Tech stack and constraints for agents |
| `_bmad-output/implementation-artifacts/*.md` | Optional | Existing story files — Substrate skips create-story for any it finds |
| `package.json` | Optional | Test framework detection |

**Setup (one-time):**

```bash
npm install substrate-ai
[npx] substrate auto init
```

**Then start a Claude Code session and tell it what to do:**

> "Run the substrate pipeline to implement the remaining stories."

Claude reads the CLAUDE.md scaffold, discovers the substrate commands, and drives the pipeline — implementing stories, handling code review cycles, and summarizing results. You stay in the loop for escalations and failed stories.

Substrate reads one directory — `_bmad-output/` — and doesn't care which tool created it. It does not read `sprint-status.yaml` or `.beads/` — you decide what's left by choosing which story keys to pass.

### Autonomous Pipeline (standalone)

Substrate also runs standalone without an AI agent driving it:

```bash
[npx] substrate brainstorm                         # Explore your idea
[npx] substrate auto init                          # Set up methodology pack
[npx] substrate auto run                           # Full pipeline: analysis → implement
[npx] substrate auto run --from solutioning        # Skip to a specific phase
[npx] substrate auto resume                        # Pick up where you left off
[npx] substrate auto status                        # Check pipeline progress
```

The pipeline walks through the full software development lifecycle: analysis, planning, solutioning, and implementation — dispatching agents to build, test, and code-review each story.

## Supported Worker Agents

Substrate dispatches work to CLI-based AI agents running as child processes. It never calls LLMs directly — all implementation, code review, and story generation is delegated to these worker agents.

| Agent ID | CLI Tool | Billing |
|----------|----------|---------|
| `claude-code` | [Claude Code](https://docs.anthropic.com/en/docs/claude-code) | Subscription (Max) or API key |
| `codex` | [Codex CLI](https://github.com/openai/codex) | Subscription (ChatGPT Plus/Pro) or API key |
| `gemini` | Gemini CLI | Subscription or API key |

All three agents are fully supported as worker targets. Substrate auto-discovers available agents and routes work based on adapter health checks and configuration.

> **Note on agent scaffolding:** Separately from worker dispatch, Substrate can also scaffold instruction files that teach an AI agent how to *drive* the pipeline as a front-end. Today, `substrate auto init` generates a CLAUDE.md scaffold for Claude Code (see [AI Agent Integration](#ai-agent-integration)). Equivalent scaffolds for Codex (`AGENTS.md`) and Gemini (`GEMINI.md`) are planned.

## Pipeline Observability

Substrate provides multiple output modes for monitoring pipeline execution.

### Human-Readable Progress (default)

`substrate auto run` displays compact, updating progress lines with color:

```
substrate auto run — 6 stories, concurrency 3

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
[npx] substrate auto run --events
[npx] substrate auto run --events --stories 7-1,7-2
```

Seven event types form a discriminated union on the `type` field:

| Event | Description |
|-------|-------------|
| `pipeline:start` | Pipeline begins — includes `run_id`, `stories[]`, `concurrency` |
| `pipeline:complete` | Pipeline ends — includes `succeeded[]`, `failed[]`, `escalated[]` |
| `story:phase` | Story transitions between phases (`create-story`, `dev-story`, `code-review`, `fix`) |
| `story:done` | Story reaches terminal success state with `review_cycles` count |
| `story:escalation` | Story escalated after exhausting review cycles — includes issue list with severities |
| `story:warn` | Non-fatal warning (e.g., token ceiling truncation) |
| `story:log` | Informational progress message |

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

Substrate is designed to be operated by AI agents, not just humans. Two mechanisms teach agents how to interact with the pipeline at runtime:

### Self-Describing CLI (`--help-agent`)

```bash
[npx] substrate auto run --help-agent
```

Outputs a machine-optimized markdown prompt fragment (<2000 tokens) that an AI agent can ingest as a system prompt. Generated from the same TypeScript type definitions as the event emitter, so documentation never drifts from implementation. Includes:

- All available commands and flags with examples
- Complete event protocol schema
- Decision flowchart for handling each event type
- Version stamp for detecting stale cached instructions

### CLAUDE.md Scaffold

`substrate auto init` injects a `## Substrate Pipeline` section into your project's CLAUDE.md with behavioral directives for Claude Code:

- Instructions to run `--help-agent` on first use
- Event-driven interaction patterns (escalation handling, fix offers, confirmation requirements)
- Section is wrapped in `<!-- substrate:start/end -->` markers for idempotent updates
- Re-running `init` updates the substrate section while preserving all other CLAUDE.md content

## Commands

### Pipeline

| Command | Description |
|---------|-------------|
| `substrate brainstorm` | Interactive multi-persona ideation session |
| `substrate auto init` | Initialize methodology pack for autonomous pipeline |
| `substrate auto run` | Run the full pipeline (analysis → implement) |
| `substrate auto run --events` | Emit NDJSON event stream on stdout |
| `substrate auto run --verbose` | Show full pino log output on stderr |
| `substrate auto run --help-agent` | Print agent instruction prompt fragment and exit |
| `substrate auto run --from <phase>` | Start from a specific phase |
| `substrate auto resume` | Resume an interrupted pipeline run |
| `substrate auto status` | Show pipeline run status |

### Monitoring

| Command | Description |
|---------|-------------|
| `substrate monitor status` | View task metrics and agent performance |
| `substrate monitor report` | Generate a detailed performance report |
| `substrate cost-report` | View cost and token usage summary |

### Setup

| Command | Description |
|---------|-------------|
| `substrate init` | Initialize project configuration |
| `substrate --help` | Show all available commands |

## Configuration

Substrate reads configuration from `.substrate/config.yaml` in your project root. Run `[npx] substrate init` to generate a default config.

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

## Manual Task Graphs

For fine-grained control, you can define exactly what agents should do in a YAML task graph:

```yaml
version: "1"
session:
  name: "my-tasks"
tasks:
  write-tests:
    name: "Write unit tests"
    prompt: |
      Look at the src/utils/ directory.
      Write comprehensive unit tests for all exported functions.
    type: testing
    agent: claude-code
  update-docs:
    name: "Update README"
    prompt: |
      Read the README.md and verify it accurately describes
      the project. Fix any inaccuracies.
    type: docs
    agent: codex
    depends_on:
      - write-tests
```

```bash
[npx] substrate start --graph tasks.yaml              # Execute the graph
[npx] substrate plan --graph tasks.yaml               # Preview without running
```

Tasks without dependencies run in parallel. Each agent gets its own isolated git worktree.

## License

MIT
