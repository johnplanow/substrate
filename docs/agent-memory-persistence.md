# Persisting Agent Memory

Use the scaffold script in this repo to make durable agent guidance available to future Codex sessions in other repositories.

## What It Creates

For a target repo, the scaffold does three things:

1. Inserts or updates a managed `Persistent Agent Memory` block in `AGENTS.md`
2. Creates `docs/agent-memory.md` from a reusable template if the file does not already exist
3. Creates a small global pointer in `~/.codex/memories/<name>.md`

The scaffold is intentionally conservative. It inventories likely Claude/Codex sources and creates the durable files, but it does not blindly copy old memory into the repo. You or an agent still need to distill the guidance.

## Usage

Run from this repo:

```bash
npm run agent-memory:bootstrap -- --repo /absolute/path/to/other-repo
```

Useful options:

```bash
npm run agent-memory:bootstrap -- --repo /path/to/repo --dry-run
npm run agent-memory:bootstrap -- --repo /path/to/repo --memory-name custom-name
npm run agent-memory:bootstrap -- --repo /path/to/repo --claude-project /Users/you/.claude/projects/<slug>
npm run agent-memory:bootstrap -- --repo /path/to/repo --force-docs
```

## Recommended Workflow

1. Run the scaffold with `--dry-run` first
2. Run it for real
3. Open the generated `docs/agent-memory.md`
4. Distill the discovered source material into durable guidance
5. Keep only rules that still match the current repo state
6. Leave the global pointer in `~/.codex/memories/` small and stable

## Recommended Codex Prompt

After scaffolding a repo, use a prompt like this:

```text
Find CLAUDE.md, ~/.claude project memory, and any durable repo instructions. Distill the durable guidance into docs/agent-memory.md and tighten AGENTS.md so future Codex sessions always find the right workflow. Do not copy stale or contradicted memory forward; current code and docs win.
```

## Selection Rules

Good candidates to persist:

- CLI usage rules that are easy to get wrong
- Test execution rules
- Pipeline or workflow invocation rules
- Stable user preferences
- Recurring validation failures and anti-patterns

Do not persist blindly:

- Raw run logs
- One-off TODO lists
- Version-specific notes likely to drift
- Historical guidance contradicted by current code or docs
