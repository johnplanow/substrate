# Agent Memory

> Last verified: 2026-05-03 (v0.20.46). Content distilled from prior Claude/Codex sessions; cross-checked against current repo state.

This file is the durable, repo-local subset of prior agent project memory that should remain available to Codex and other agents without depending on `~/.claude` state.

## Precedence

- [`AGENTS.md`](../AGENTS.md) is the cross-agent instruction surface in this repo (workflow, testing rules, durable preferences)
- [`CLAUDE.md`](../CLAUDE.md) is the Claude-Code-specific runtime context (substrate pipeline directives, cross-project observation lifecycle norms)
- This file captures project-specific operational guidance that has stayed useful across sessions
- If any historical memory conflicts with current code, tests, or docs, the current repo state wins

## Canonical CLI Usage

- Use the global `substrate` CLI for normal pipeline runs in this repo
- Use `npm run substrate:dev -- <args>` only when explicitly testing local CLI changes
- Before testing local CLI changes, run `npm run build`
- Do not use bare `substrate` to verify unbuilt local code changes

## Pipeline Discipline

- When the user asks to run or implement through the pipeline, default to `substrate run --events`
- If the user specifies stories, pass them explicitly with `--stories`
- Monitor long-running runs with:
  - `substrate status --output-format json`
  - `substrate health --output-format json`
  - `substrate supervisor --output-format json` for runs started in the same session
- Do not pipe substrate output through commands that can close the pipe early
- No output for several minutes can be normal; confirm with `substrate health` before treating it as stalled

## Testing Discipline

- Prefer `npm run test:changed` or `npm run test:fast` during iteration
- Use `npm test` for full validation and pre-merge confidence
- Never run multiple Vitest processes at once
- Use a 5-minute timeout for test commands
- Do not pipe test output through `head`, `tail`, or `grep`
- Verify the Vitest summary output rather than trusting exit code alone

## Durable User Preferences

- Fix substrate bugs in substrate first. Do not patch around substrate defects in target projects.
- Never suggest wrapping up, ending, or pausing a session on the agent's initiative.
- If a run fails, pivot to the next corrective action instead of proposing to stop.

## Validation Lessons That Still Matter

- Shared-worktree concurrency can contaminate later stories through `node_modules`, generated files, or lockfile changes. If runs start interfering with each other, reduce batch size or isolate work.
- Story-key and identifier parsing should not assume purely numeric formats. Historical failures came from restrictive regexes.
- Add timeout caps to long-running orchestration loops. Several historical failures came from waits with no upper bound.
- Add null guards around DB and orchestration reads. Raw query results and optional process metadata have been recurring failure points.
- Be careful with platform-specific assumptions on macOS, especially around memory pressure and developer tooling behavior.

## Historical Notes To Treat Carefully

- Older Claude memory outside the repo contains useful transcripts, but some items are stale or contradictory
- In particular, persistence/storage guidance has changed multiple times across the project's history; verify against the current codebase before acting
- This repo-local file exists so future agents do not need to scrape `~/.claude/projects/...` to recover the high-signal guidance
