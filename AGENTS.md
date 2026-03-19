# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Dev Workflow — Testing Local CLI Changes

**IMPORTANT:** The `substrate` command is a globally installed published version — it does NOT run your local changes.

To test local CLI changes:
1. Build first: `npm run build`
2. Run via: `npm run substrate:dev -- <args>`

Example: `npm run substrate:dev -- auto run --events --stories 10-1`

**Never run bare `substrate` to test local changes.** It will silently use the published version, not your code.

<!-- codex-memory:start -->
## Persistent Agent Memory

This repo carries forward the durable subset of prior Claude project memory in [`docs/agent-memory.md`](docs/agent-memory.md).

- Treat `AGENTS.md` as the Codex authority for workflow and session rules
- Use `docs/agent-memory.md` for project-specific operational guidance and validation lessons
- If a historical note conflicts with the current repo state, current code and docs win
<!-- codex-memory:end -->

## Pipeline Workflow

For normal pipeline runs in this repo, use the globally installed `substrate` CLI. Reserve `npm run substrate:dev` for explicitly testing local CLI changes after a build.

- When the user asks you to implement, build, or run the pipeline, start with `substrate run --events`
- If the user names specific stories, run `substrate run --events --stories <keys>`
- Without `--stories`, substrate may auto-discover and dispatch many pending stories across epics
- For long-running runs, monitor with `substrate status --output-format json` and `substrate health --output-format json`
- Only attach `substrate supervisor --output-format json` to runs you started in the same session
- Never pipe substrate output through `head`, `tail`, or `grep`

## Testing Rules

- Prefer `npm run test:changed` or `npm run test:fast` during iteration; use `npm test` for full validation
- Never run Vitest concurrently; check `pgrep -f vitest` first
- Use a 5-minute timeout for test runs
- Never pipe test output through `head`, `tail`, or `grep`
- Confirm success from the Vitest summary, not just exit code

## Durable User Preferences

- Fix substrate bugs in the substrate repo first; do not work around substrate defects in target projects
- Never suggest ending or wrapping up a session; move directly to the next action
- Shared `node_modules` can poison concurrent story runs; if cross-story contamination appears, reduce batch size or isolate work
- Favor permissive parsing for story keys and similar identifiers; historical bugs came from overly restrictive regexes
- Add explicit timeout caps and null guards around orchestration paths; both have been recurring failure modes

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
