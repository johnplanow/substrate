# Agent Instructions

This file is the agent-facing operating manual for the substrate repo. The user-facing project doc is [`README.md`](README.md); the Claude-Code-specific runtime context lives in [`CLAUDE.md`](CLAUDE.md). This file captures durable rules, workflows, and lessons that apply across any AI assistant operating in this repo (Claude, Codex, Gemini, etc.).

## Dev Workflow — Testing Local CLI Changes

**CRITICAL:** The `substrate` command is a globally installed published version — it does NOT run your local changes.

To test local CLI changes:

1. Build first: `npm run build`
2. Run via: `npm run substrate:dev -- <args>`

Example: `npm run substrate:dev -- run --events --stories 999-1`

**Never run bare `substrate` to test local changes.** It will silently use the published version, not your code. Several investigation cycles in 2026-05 (obs_2026-05-02_019) traced false-alarm reopens to this exact confusion — the user (or agent) believing dispatch ran under a newly-shipped version when the global binary was still on the previous one.

When triaging a substrate-targeted observation reopen, **verify version attribution FIRST** via `substrate --version` or the npm install log at `~/.npm/_logs/<timestamp>-debug-0.log`. See [`CLAUDE.md`](CLAUDE.md) "Cross-Project Observation Lifecycle" for the full reopen-evidence protocol.

## Pipeline Workflow

For pipeline runs in this repo, use the globally installed `substrate` CLI. Reserve `npm run substrate:dev` for explicitly testing local CLI changes after a build.

- When the user asks you to implement, build, or run the pipeline, start with `substrate run --events`
- If the user names specific stories, run `substrate run --events --stories <keys>`
- For factory / interface-extraction / migration work, use `--max-review-cycles 3` (default 2 causes ~28% false escalation rate on those story classes)
- Without `--stories`, substrate auto-discovers and dispatches all pending stories — risky at scale, prefer explicit story lists
- For long-running runs, monitor with `substrate status --output-format json` and `substrate health --output-format json`
- Only attach `substrate supervisor --output-format json` to runs you started in the same session — cross-session interference can kill healthy dispatches
- **NEVER pipe substrate output** through `head`, `tail`, `grep`, or any command that may close the pipe early (causes EPIPE stalls)
- **NEVER use `Task Output`** to monitor substrate — Claude Code task IDs do not map to substrate's internal processes

Pipeline runs take 5–40 minutes. Use `run_in_background: true` or `timeout: 600000` (10 min) when invoking via Bash. Default 2-minute timeout WILL kill the pipeline.

For full agent-facing event protocol and command reference: `substrate run --help-agent`.

## Substrate-on-Substrate Dispatch

This repo's own development is dispatched through substrate. Pattern:

```bash
# Author or update the epic doc:
#   _bmad-output/planning-artifacts/epic-NN-<topic>.md

# Ingest into the work graph:
substrate ingest-epic _bmad-output/planning-artifacts/epic-NN-<topic>.md

# Dispatch the planned stories:
substrate run --events --stories NN-1,NN-2 --max-review-cycles 3
```

The smoke fixture for prompt-edit ships lives at `_bmad-output/planning-artifacts/epic-999-prompt-smoke-state-integrating.md` and is run via [`/.claude/commands/ship.md`](.claude/commands/ship.md) Step 4.5 when staged changes touch `packs/bmad/prompts/*.md`.

## Testing Rules

- Prefer `npm run test:changed` or `npm run test:fast` during iteration; use `npm test` for full validation before merging
- **NEVER run Vitest concurrently** — only one vitest instance at a time. Verify `pgrep -f vitest` returns nothing before starting.
- **ALWAYS use `timeout: 300000`** (5 min) — test suite takes ~50s but startup adds overhead; default 2-minute timeout will kill it
- **NEVER pipe test output** through `tail`/`head`/`grep` — pipes discard the vitest summary line and make results unverifiable
- **NEVER run tests in background** — always foreground with timeout
- Confirm success from the Vitest summary line ("Test Files X passed"), not just exit code

## /ship Workflow

The repo defines a project-level `/ship` slash command at [`.claude/commands/ship.md`](.claude/commands/ship.md). It runs:

1. `npm run build`
2. `npm run check:circular`
3. `npm run typecheck:gate`
4. `npm run test:fast` (no vitest concurrency, 5-min timeout, no pipes)
5. **Conditional**: empirical prompt-edit smoke if staged changes touch `packs/bmad/prompts/*.md` — dispatches the fixture epic via `npm run substrate:dev` and asserts the rendered story has the structural property the prompt change targets
6. Commit (specific files, not `git add -A`)
7. Version bump + `version:sync` + lockfile regen + tag + push (triggers npm publish via OIDC)
8. Verify CI run

**Never skip the empirical smoke step** for prompt-edit ships. obs_2026-05-02_019 captured the cost of doing so: a phantom regression cycle on obs_017's reopen episode where prompt-text-only assertions passed but the consumer-side dispatch (run on a stale binary, then again on the actual published version with classification gaps) produced false-alarm reopens.

## Durable User Preferences

These have been confirmed through corrected approaches across multiple sessions:

- **Fix substrate bugs in the substrate repo first**; do not work around substrate defects in target projects
- **Never suggest ending or wrapping up a session**; the user decides when to stop
- **Shared `node_modules` can poison concurrent story runs**; if cross-story contamination appears, reduce batch size or isolate work
- **Favor permissive parsing for story keys and similar identifiers** — historical bugs came from overly restrictive regexes (alpha-suffix stripping, separator-convention mismatches, etc.)
- **Add explicit timeout caps and null guards around orchestration paths** — both have been recurring failure modes
- **Don't bury defect attribution in unverified assumptions** — when claiming "dispatched under vX.Y.Z", show the receipt (`substrate --version`, npm log, run record)

## Cross-Project Observation Lifecycle

Substrate-targeted observations from consumer projects (e.g., strata) live at `~/code/jplanow/strata/_observations-pending-cpo.md` until the cross-project-observation bridge ships. Reopens drive substrate-side priorities and ship cadence; attribution must be verifiable.

Full triage protocol in [`CLAUDE.md`](CLAUDE.md) "Cross-Project Observation Lifecycle". Summary:

1. Verify version attribution FIRST (cheapest check, highest information yield)
2. Then prompt content
3. Then runtime behavior
4. If reopen evidence is absent, accept in good faith but flag for version-skew investigation as the first triage step

## Persistent Agent Memory

This repo carries forward the durable subset of prior agent project memory in [`docs/agent-memory.md`](docs/agent-memory.md).

- Treat `AGENTS.md` (this file) as the cross-agent authority for workflow and session rules
- Use [`CLAUDE.md`](CLAUDE.md) as the Claude-Code-specific runtime context (substrate pipeline directives, cross-project observation lifecycle norms)
- Use `docs/agent-memory.md` for durable project-specific operational guidance
- If a historical note conflicts with current repo state, current code and docs win

## Closing a Session

The user decides when a session is "done" — not the agent. When the user signals closure, ensure:

1. **Quality gates passed** if code changed (build, circular, typecheck, tests, smoke)
2. **Changes committed** with descriptive messages following the repo's commit convention (feat / chore / docs / fix; co-authored-by trailer)
3. **Pushed to origin** — work is not durable until `git push` succeeds
4. **CI verified** — for version-bumped commits, confirm CI + Publish workflows succeed
5. **Memory updated** — if the session shipped versions or filed observations, update `MEMORY.md` so future sessions see the state

If push fails, resolve and retry until it succeeds. Never leave work stranded locally.
