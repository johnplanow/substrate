# Story 17.6: Supervisor Agent Ergonomics

Status: review
Blocked-by: 17-5

## Story

As an AI agent operating inside a Claude Code session,
I want a slash command and streamlined invocation pattern for the supervisor,
so that I can start, monitor, and act on supervisor output without constructing CLI commands from scratch.

## Context

Story 17-5 closes the documentation and type-safety gaps. This story addresses the ergonomics gap: even with perfect docs, an agent still has to manually construct `substrate auto supervisor --experiment --output-format json --poll-interval 30`, run it in the background, parse raw stdout, and manage the lifecycle.

The substrate repo has 64 BMAD slash commands in `.claude/commands/` but zero for substrate pipeline operations. A `/substrate-supervisor` command could encapsulate the standard workflow pattern and provide the agent with a clear invocation path.

Additionally, the experimenter (17-4) creates git branches with `git checkout -b` in the current working tree. If an agent is in a Claude session on `main`, branch switches during experiments will affect file reads and could cause confusion. Worktree isolation would prevent this.

## Acceptance Criteria

### AC1: Supervisor Slash Command
**Given** an agent is in a Claude Code session in the substrate repo
**When** it invokes `/substrate-supervisor`
**Then** the command provides clear instructions for:
  - Starting `substrate auto supervisor` with recommended defaults
  - Attaching `--experiment` for self-improvement mode
  - Parsing the JSON event stream
  - Responding to key events (referencing help-agent patterns from 17-5)
**And** the command file exists at `.claude/commands/substrate-supervisor.md`

### AC2: Pipeline Run + Monitor Command
**Given** an agent wants to run stories and monitor them
**When** it invokes `/substrate-run`
**Then** the command provides instructions for the combined workflow:
  - Start `substrate auto run --events --stories <stories>`
  - Optionally attach supervisor: `substrate auto supervisor --output-format json`
  - Poll with `substrate auto status --output-format json`
  - Interpret results and summarize to user
**And** the command file exists at `.claude/commands/substrate-run.md`

### AC3: Metrics & Analysis Command
**Given** an agent wants to review pipeline performance
**When** it invokes `/substrate-metrics`
**Then** the command provides instructions for:
  - Viewing recent runs: `substrate auto metrics --output-format json`
  - Comparing runs: `substrate auto metrics --compare <a>,<b> --output-format json`
  - Reading analysis: `substrate auto metrics --analysis <run-id> --output-format json`
  - Tagging baselines: `substrate auto metrics --tag-baseline <run-id>`
**And** the command file exists at `.claude/commands/substrate-metrics.md`

### AC4: Experimenter Worktree Isolation
**Given** the supervisor runs with `--experiment`
**When** the experimenter creates a branch for an experiment
**Then** it uses `git worktree add` instead of `git checkout -b` to create an isolated working copy
**And** the experiment runs in the worktree directory
**And** the worktree is cleaned up after the experiment completes (regardless of verdict)
**And** the agent's current working tree on `main` is never affected

### AC5: Existing Tests Pass
**Given** all changes are implemented
**When** the full test suite runs
**Then** all existing tests pass and coverage thresholds are maintained

## Dev Notes

### Slash Command Format

Claude Code slash commands are markdown files in `.claude/commands/`. They're loaded as prompt fragments when invoked. Example pattern from existing BMAD commands:

```markdown
# Substrate Supervisor

Start and monitor the pipeline supervisor for automatic stall recovery and self-improvement.

## Usage

[Instructions for the agent on how to invoke and respond...]
```

### Worktree Isolation (AC4)

Current experimenter code in `src/modules/supervisor/experimenter.ts` uses:
```ts
git checkout -b supervisor/experiment/<run-id>-<desc>
```

Replace with:
```ts
git worktree add .claude/worktrees/experiment-<run-id> -b supervisor/experiment/<run-id>-<desc>
```

Run the single-story experiment with `cwd` set to the worktree path. After comparison and verdict:
```ts
git worktree remove .claude/worktrees/experiment-<run-id>
```

If verdict is REGRESSED, also delete the branch. If IMPROVED/MIXED, the branch persists for the PR.

### Files to Create/Modify

- `.claude/commands/substrate-supervisor.md` (new — AC1)
- `.claude/commands/substrate-run.md` (new — AC2)
- `.claude/commands/substrate-metrics.md` (new — AC3)
- `src/modules/supervisor/experimenter.ts` (modify — AC4)
- `src/modules/supervisor/__tests__/experimenter.test.ts` (modify — AC4)

## Tasks

- [x] Create `.claude/commands/substrate-supervisor.md` slash command (AC1)
- [x] Create `.claude/commands/substrate-run.md` slash command (AC2)
- [x] Create `.claude/commands/substrate-metrics.md` slash command (AC3)
- [x] Refactor experimenter to use `git worktree add` instead of `git checkout -b` (AC4)
- [x] Update experimenter cleanup to use `git worktree remove` (AC4)
- [x] Update experimenter tests for worktree-based isolation (AC4)
- [x] Verify full test suite passes (AC5)
