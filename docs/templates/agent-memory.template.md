# Agent Memory

This file is the durable, repo-local subset of prior agent memory that should remain available to Codex and other agents without depending on user-home state.

Status: scaffolded on `{{DATE}}`.

## Source Material

Distill durable guidance from these sources, then remove or rewrite any item that is stale, contradictory, or no longer matches the repo:

{{SOURCE_LIST}}

## Precedence

- `AGENTS.md` is the primary instruction surface for Codex in this repo
- This file captures project-specific guidance that has stayed useful across sessions
- If any historical memory conflicts with the current codebase, tests, or docs, the current repo state wins

## Canonical CLI Usage

- TODO: Add the one or two command patterns future agents must not get wrong
- TODO: Call out any dev-vs-published CLI distinction if one exists

## Pipeline Or Workflow Discipline

- TODO: Add the normal implementation/run path for this repo
- TODO: Add monitoring/recovery commands if the repo has a long-running pipeline

## Testing Discipline

- TODO: Add the preferred fast validation command
- TODO: Add the full validation command
- TODO: Add any timeout, serialization, or output-handling rules that future agents must obey

## Durable User Preferences

- TODO: Add only preferences that have stayed consistent across multiple sessions
- TODO: Include preferences that override common agent defaults

## Validation Lessons That Still Matter

- TODO: Add recurring failure modes that future agents should watch for
- TODO: Prefer lessons that generalize across runs, not one-off incidents

## Historical Notes To Treat Carefully

- Older Claude memory outside the repo can contain useful transcripts, but some items may be stale or contradictory
- Verify any architecture or persistence guidance against the current codebase before acting
