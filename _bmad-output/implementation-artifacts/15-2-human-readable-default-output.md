# Story 15.2: Human-Readable Default Output

Status: draft
Blocked-by: 15-1

## Story

As a developer running `substrate auto run` in a terminal,
I want clean, compact progress output instead of raw JSON log lines,
so that I can understand pipeline status at a glance without parsing structured logs.

## Context

Currently the default output is pino JSON warn/info logs — unreadable for humans. This story replaces the default terminal experience with a compact, updating progress display inspired by `npm install` or `docker build` output. The event protocol from Story 15-1 is consumed internally to drive this display.

## Acceptance Criteria

### AC1: Compact Progress Lines
**Given** the user runs `substrate auto run` (no `--events` flag)
**When** stories progress through phases
**Then** each story shows a single updating line: `[phase] story-key... status`
**And** completed stories show a final summary: `story-key SHIP_IT (1 review cycle)`

### AC2: Pipeline Summary
**Given** the pipeline completes
**When** all stories have reached terminal states
**Then** a summary block is printed showing succeeded/failed/escalated counts
**And** failed or escalated stories are listed with one-line reasons

### AC3: Warning Display
**Given** a non-fatal warning occurs (e.g., token ceiling truncation)
**When** the warning is emitted
**Then** it is displayed as a compact yellow-tinted line (if TTY supports color)
**And** it does not interrupt the progress display flow

### AC4: Non-TTY Fallback
**Given** stdout is not a TTY (piped to file, CI environment)
**When** the pipeline runs
**Then** output is plain text without ANSI escape codes or cursor manipulation
**And** each progress update is a new line (no in-place updates)

### AC5: Pino Logs Suppressed by Default
**Given** the user runs `substrate auto run` without `--verbose`
**When** the pipeline executes
**Then** raw pino JSON logs are not displayed on stderr
**And** `--verbose` flag restores full pino log output for debugging

## Dev Notes

### Architecture

- New file: `src/modules/implementation-orchestrator/progress-renderer.ts`
  - Consumes `PipelineEvent` objects (same type as --events output)
  - TTY detection: `process.stdout.isTTY`
  - TTY mode: uses ANSI cursor control for in-place line updates
  - Non-TTY mode: appends new lines
- Modified: `src/cli/commands/auto.ts`
  - Default behavior (no --events): instantiate progress renderer instead of event emitter
  - `--verbose`: keep pino stderr output; otherwise suppress with pino level override
- Color support: use `chalk` or existing color dependency. Respect `NO_COLOR` env var.

### Display Format

```
substrate auto run — 6 stories, concurrency 3

[create] 7-1 creating story...
[dev]    7-2 implementing...
[review] 7-3 SHIP_IT (1 cycle)
[fix]    7-4 fixing minor issues...
[done]   7-5 SHIP_IT (2 cycles)
[wait]   1-9 queued

Pipeline complete: 5 succeeded, 0 failed, 1 escalated
  escalated: 1-9 — review cycle limit (missing null check in parser.ts:42)
```

## Tasks

- [ ] Create `progress-renderer.ts` consuming `PipelineEvent` types
- [ ] Implement TTY mode with ANSI cursor control for in-place updates
- [ ] Implement non-TTY fallback with plain text line output
- [ ] Add pipeline summary block on completion
- [ ] Wire default auto run to use progress renderer
- [ ] Add `--verbose` flag to preserve pino stderr output
- [ ] Suppress pino stderr output by default (set level to 'silent' unless --verbose)
- [ ] Respect `NO_COLOR` environment variable
- [ ] Write unit tests for progress renderer (TTY and non-TTY modes)
- [ ] Write integration test: pipeline with default output, assert no JSON in stdout
