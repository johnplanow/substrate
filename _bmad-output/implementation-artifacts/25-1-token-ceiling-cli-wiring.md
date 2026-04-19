# Story 25-1: Token Ceiling CLI Wiring

Status: shipped

## Story

As a pipeline operator,
I want `token_ceilings` config overrides from `.substrate/config.yaml` to actually propagate through the `run` command to the orchestrator,
so that I can tune token budgets per-workflow without modifying source code.

Completes the last-mile wiring gap left by Story 24-7 (Configurable Token Ceiling Per Workflow).

## Acceptance Criteria

### AC1: Config Loading in run Command
**Given** a project with `.substrate/config.yaml` containing `token_ceilings` overrides
**When** `substrate run` is executed
**Then** the config system loads and extracts `token_ceilings` from the parsed config

### AC2: Both Orchestrator Sites Wired
**Given** token_ceilings have been loaded from config
**When** the implementation orchestrator is created (either legacy implementation-only path or full-pipeline path)
**Then** `tokenCeilings` is passed to the orchestrator deps

### AC3: Graceful Fallback
**Given** no `.substrate/config.yaml` exists or config loading fails
**When** `substrate run` is executed
**Then** the orchestrator uses hardcoded defaults from `TOKEN_CEILING_DEFAULTS` with no error

### AC4: Existing Integration Tests Pass
**Given** the epic-24-integration.test.ts suite covers token ceiling propagation
**When** tests are run after the change
**Then** all existing integration and unit tests pass (no regressions)

## Dev Notes

### Architecture Constraints
- `run.ts` had zero config system usage before this change
- `createConfigSystem({ projectConfigDir: dbDir })` loads from the `.substrate/` directory
- Non-fatal: wrapped in try/catch, logs debug message on failure
- `FullPipelineOptions` interface extended with optional `tokenCeilings` field

### Implementation Record
- **Agent**: Claude Opus 4.6 (manual, party-mode session)
- **Files modified**: `src/cli/commands/run.ts` (4 edits, ~10 lines added)
- **Imports added**: `createConfigSystem` from config-system-impl, `TokenCeilings` type from config-schema
- **Build**: PASS
- **Tests**: All passing (epic-24-integration: 12/12, token-ceiling: 17/17, config-schema: 54/54)

## Change Log
- 2026-03-07: Created and shipped in party-mode session. Corrected stale memory entries claiming dev-story ceiling was 3K (actual: 24K since commit 78a5988).
