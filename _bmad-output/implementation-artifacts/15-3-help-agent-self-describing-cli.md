# Story 15.3: --help-agent Self-Describing CLI

Status: draft
Blocked-by: 15-1

## Story

As an AI agent (Claude Code, Codex, or future providers),
I want to run `substrate auto --help-agent` and receive a structured prompt fragment describing the event protocol, available commands, and interaction patterns,
so that I can operate the pipeline correctly without relying on training data or static documentation.

## Context

Substrate is a new CLI — it's not in any LLM's training data. AI agents need to learn how to interact with it at runtime. `--help-agent` outputs a machine-optimized instruction block (not human help text) that an agent can ingest as a system prompt fragment. This is generated from the same TypeScript type definitions as the event emitter, ensuring documentation never drifts from implementation.

This is "Layer 2" of the agent integration strategy — the CLI teaching the agent how to use it.

## Acceptance Criteria

### AC1: --help-agent Flag
**Given** the user or agent runs `substrate auto --help-agent`
**When** the command executes
**Then** a markdown-formatted prompt fragment is written to stdout
**And** the process exits with code 0
**And** no pipeline is executed

### AC2: Event Schema Documentation
**Given** the help-agent output is generated
**Then** it contains a complete listing of all `PipelineEvent` types
**And** each event type includes: event name, field descriptions, and when it is emitted
**And** the listing is derived from the TypeScript type definitions (not hand-written)

### AC3: Command Reference
**Given** the help-agent output is generated
**Then** it contains all `substrate auto` subcommands and flags
**And** each command includes: syntax, description, and example usage
**And** `--events`, `--stories`, `--verbose` flags are documented

### AC4: Interaction Patterns
**Given** the help-agent output is generated
**Then** it contains a decision flowchart for handling each event type:
- `story:done` with `result: success` -> report to user
- `story:escalation` -> read flagged files, propose fix, ask user
- `story:phase` with `verdict: NEEDS_MINOR_FIXES` -> offer to fix
- `story:warn` -> inform user but don't treat as error
- `pipeline:complete` -> summarize results

### AC5: Token Budget
**Given** the help-agent output is generated
**Then** the total output is under 2000 tokens (measured by tiktoken cl100k_base or equivalent)
**And** this constraint is validated by a test

### AC6: Version Stamp
**Given** the help-agent output is generated
**Then** it includes the substrate version number
**And** agents can detect version mismatches between cached instructions and installed CLI

## Dev Notes

### Architecture

- New file: `src/cli/commands/help-agent.ts`
  - Generates markdown from event type definitions + command metadata
  - Template approach: static markdown skeleton with generated sections injected
  - Event schema section: iterate over event type names and fields from `event-types.ts`
- Alternative: build-time generation into a static `.md` file in dist, served by the command
  - Pro: no runtime reflection needed
  - Con: another build step
  - Recommendation: runtime generation is simpler and the output is small (<2000 tokens)

### Output Format

```markdown
# Substrate Auto Pipeline — Agent Instructions
Version: 0.2.0

## Commands
- `substrate auto run --events` — Run pipeline, emit NDJSON events to stdout
- `substrate auto run --events --stories 7-1,7-2` — Run specific stories
- `substrate auto run` — Run pipeline with human-readable output (default)

## Event Protocol
Events are newline-delimited JSON on stdout when `--events` is passed.

### pipeline:start
Emitted once at pipeline start.
Fields: run_id (string), stories (string[]), concurrency (number)

### story:phase
Emitted when a story enters or exits a phase.
Fields: key (string), phase (create-story|dev-story|code-review|fix), status (in_progress|complete|failed), verdict? (string), file? (string)
[...]

## Interaction Patterns
- On `story:escalation`: Read the issues array. Each issue has severity, file (path:line), and desc. Offer to fix or explain to the user.
- On `story:warn`: Inform the user but do not treat as an error. Common warns include token ceiling truncation.
- On `pipeline:complete`: Summarize results. Report succeeded count, list any failed or escalated stories with reasons.
```

### Generation Strategy

The event type names and fields can be extracted from the TypeScript discriminated union at build time using a simple code generator, or at runtime using a metadata object that mirrors the type definitions. Runtime metadata object is recommended — it's a small Record<string, FieldDescription[]> that lives alongside the types.

## Tasks

- [ ] Create metadata object mirroring `PipelineEvent` type definitions in `event-types.ts`
- [ ] Create `help-agent.ts` command handler
- [ ] Generate event schema section from metadata
- [ ] Write command reference section
- [ ] Write interaction patterns section
- [ ] Add version stamp from package.json
- [ ] Register `--help-agent` flag on auto command
- [ ] Write test: output contains all event type names from metadata
- [ ] Write test: output is valid markdown
- [ ] Write test: output is under 2000 tokens
- [ ] Write test: version stamp matches package.json version
