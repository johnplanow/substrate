# Substrate

Multi-agent orchestration daemon for AI coding agents. Substrate coordinates multiple CLI-based AI agents (Claude Code, Codex, Gemini CLI) to work on complex software tasks in parallel using git worktrees.

## Prerequisites

- **Node.js** 22.0.0 or later
- **git** 2.20 or later
- At least one supported AI CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)
  - [Codex CLI](https://github.com/openai/codex) (`codex`)
  - Gemini CLI (`gemini`)

## Installation

```bash
npm install -g substrate-ai
```

Verify the installation:

```bash
substrate --version
```

## Quick Start

1. **Initialize your project** (creates `.substrate/` config directory):

```bash
substrate init
```

2. **Create a task graph** (`tasks.yaml`):

```yaml
version: "1"
session:
  name: "my-first-run"
tasks:
  write-tests:
    name: "Write unit tests"
    description: "Add unit tests for the utils module"
    prompt: |
      Look at the src/utils/ directory.
      Write comprehensive unit tests for all exported functions.
      Save tests next to the source files following existing conventions.
    type: testing
    agent: claude-code
  update-docs:
    name: "Update README"
    description: "Ensure README matches current project state"
    prompt: |
      Read the README.md and verify it accurately describes
      the project structure and setup. Fix any inaccuracies.
    type: docs
    agent: claude-code
    depends_on:
      - write-tests
```

3. **Run it**:

```bash
substrate start --graph tasks.yaml
```

Substrate will execute tasks respecting the dependency graph, spawning each agent in its own git worktree for isolation.

## Supported Agents

| Agent ID | CLI Tool | Notes |
|----------|----------|-------|
| `claude-code` | Claude Code | Requires active Claude subscription or API key |
| `codex` | Codex CLI | Requires OpenAI API key |
| `gemini` | Gemini CLI | Requires Google API key |

## Commands

| Command | Description |
|---------|-------------|
| `substrate start --graph <file>` | Execute a task graph |
| `substrate plan --graph <file>` | Preview execution plan without running |
| `substrate monitor status` | View task metrics and agent performance |
| `substrate monitor report` | Generate a detailed performance report |
| `substrate cost-report` | View cost and token usage summary |
| `substrate init` | Initialize project configuration |
| `substrate --help` | Show all available commands |

## Configuration

Substrate reads configuration from `.substrate/config.yaml` in your project root. Run `substrate init` to generate a default config.

## Development

```bash
# Clone and install
git clone https://github.com/jplanow/ai-dev-toolkit-new.git
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

## Architecture

Substrate follows a **modular monolith** pattern running as a single Node.js process with clearly separated internal modules. The orchestrator itself never calls LLMs directly — all intelligent work is delegated to CLI agents running as child processes in isolated git worktrees.

## License

MIT
