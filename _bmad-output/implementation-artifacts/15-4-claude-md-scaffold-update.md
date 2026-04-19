# Story 15.4: CLAUDE.md Scaffold Update

Status: draft
Blocked-by: 15-1

## Story

As a developer running `substrate auto init` in a project,
I want the generated CLAUDE.md to include substrate pipeline instructions,
so that Claude Code automatically knows how to run and interact with my pipeline without manual configuration.

## Context

`substrate auto init` already scaffolds a CLAUDE.md file. This story extends that scaffold with a substrate pipeline section that teaches Claude Code the basics (Layer 1). Claude Code reads CLAUDE.md on session start and follows its instructions. Combined with `--help-agent` (Story 15-3, Layer 2), this gives Claude full pipeline operating knowledge.

The scaffold should also include extension points for other AI agents (AGENTS.md for Codex, etc.) without implementing them — Claude is the first priority.

## Acceptance Criteria

### AC1: Substrate Section in CLAUDE.md
**Given** the user runs `substrate auto init`
**When** CLAUDE.md is generated or updated
**Then** it includes a `## Substrate Pipeline` section
**And** the section documents available commands: `substrate auto run --events`, `substrate auto run --stories`
**And** the section instructs Claude to run `substrate auto --help-agent` for full protocol details on first use

### AC2: Behavioral Instructions
**Given** the substrate section is present in CLAUDE.md
**Then** it includes behavioral directives:
- On `story:escalation`: read flagged files, propose fix, ask user before applying
- On `NEEDS_MINOR_FIXES`: offer to fix automatically
- Never re-run a failed story without user confirmation
- Summarize pipeline results conversationally

### AC3: Idempotent Updates
**Given** CLAUDE.md already exists with a substrate section
**When** `substrate auto init` runs again
**Then** the substrate section is updated to the latest version
**And** other sections of CLAUDE.md are preserved unchanged
**And** user-added content outside the substrate section is not modified

### AC4: Section Markers
**Given** the substrate section is written to CLAUDE.md
**Then** it is wrapped in marker comments: `<!-- substrate:start -->` and `<!-- substrate:end -->`
**And** these markers are used for idempotent section replacement on re-init

### AC5: No CLAUDE.md Without Init
**Given** the user has not run `substrate auto init`
**When** `substrate auto run` executes
**Then** no CLAUDE.md is created or modified
**And** the pipeline runs normally without agent scaffold

## Dev Notes

### Architecture

- Modified: `src/cli/commands/auto.ts` (init subcommand)
  - Existing CLAUDE.md scaffold logic extended with substrate pipeline section
  - Section replacement logic using marker comments
- New template: `src/cli/templates/claude-md-substrate-section.md`
  - Static markdown template for the substrate section
  - Injected between marker comments

### CLAUDE.md Section Content

```markdown
<!-- substrate:start -->
## Substrate Pipeline

This project uses Substrate for automated implementation pipelines.

### Quick Start
- Run `substrate auto --help-agent` to get full pipeline interaction instructions
- Run `substrate auto run --events` to execute the pipeline with structured event output
- Run `substrate auto run --events --stories 7-1,7-2` to run specific stories

### Agent Behavior
- On story escalation: read the flagged files and issues, propose a fix, ask the user before applying
- On minor fix verdict: offer to fix automatically
- Never re-run a failed story without explicit user confirmation
- After pipeline completion: summarize results conversationally (X succeeded, Y failed, Z need attention)
<!-- substrate:end -->
```

### Idempotent Update Logic

```typescript
const START_MARKER = '<!-- substrate:start -->';
const END_MARKER = '<!-- substrate:end -->';

if (content.includes(START_MARKER)) {
  // Replace existing section
  content = content.replace(
    new RegExp(`${START_MARKER}[\\s\\S]*?${END_MARKER}`),
    newSection
  );
} else {
  // Append section
  content += '\n\n' + newSection;
}
```

## Tasks

- [ ] Create `claude-md-substrate-section.md` template
- [ ] Add substrate section injection to CLAUDE.md scaffold in auto init
- [ ] Implement idempotent section replacement using marker comments
- [ ] Preserve existing CLAUDE.md content outside markers
- [ ] Write test: fresh init includes substrate section
- [ ] Write test: re-init updates substrate section, preserves other content
- [ ] Write test: no CLAUDE.md modification without init
- [ ] Write test: marker comments present and well-formed
