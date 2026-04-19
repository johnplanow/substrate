# Story 24-7: Configurable Token Ceiling Per Workflow

Status: review

## Story

As a pipeline operator running substrate on large monorepo projects,
I want to configure token ceilings per workflow type in `.substrate/config.yaml`,
so that the create-story prompt isn't truncated to 3,000 tokens when my codebase context requires 15,000+.

Addresses: Cross-project Epic 4 run where the create-story prompt was 17,468 tokens but hit the 3,000-token ceiling, truncating `arch_constraints`. The dev agent lost architecture context.

## Acceptance Criteria

### AC1: Config Schema Accepts Token Ceilings
**Given** `.substrate/config.yaml`
**When** the config is parsed
**Then** an optional `token_ceilings` map is accepted with keys matching workflow types: `create-story`, `dev-story`, `code-review`, `test-plan`, `test-expansion`

### AC2: Workflow Reads Config Ceiling
**Given** a `token_ceilings.create-story: 15000` entry in config
**When** the create-story workflow assembles its prompt
**Then** it uses 15,000 as the token ceiling instead of the hardcoded 3,000

### AC3: All Workflows Support Override
**Given** token ceiling overrides for `dev-story`, `code-review`, `test-plan`, `test-expansion`
**When** each workflow assembles its prompt
**Then** each uses the configured ceiling, falling back to the existing hardcoded default when not configured

### AC4: Fallback to Hardcoded Defaults
**Given** no `token_ceilings` section in config (or the key is absent for a specific workflow)
**When** a workflow assembles its prompt
**Then** the existing hardcoded ceiling applies: create-story=3000, dev-story=24000, code-review=100000, test-plan=8000, test-expansion=20000

### AC5: Validation Rejects Invalid Values
**Given** a `token_ceilings.create-story: -500` or `token_ceilings.create-story: "abc"` in config
**When** the config is parsed
**Then** a Zod validation error is raised with a descriptive message

### AC6: Token Ceiling Logged
**Given** a workflow uses a configured (non-default) ceiling
**When** the prompt is assembled
**Then** the effective ceiling is logged at `info` level with `{ workflow, ceiling, source: 'config' | 'default' }`

## Tasks / Subtasks

- [x] Task 1: Add `token_ceilings` to config schema (AC: #1, #5)
  - [x] In the config schema file, add optional `token_ceilings` object with keys for each workflow type
  - [x] Each value: `z.number().int().positive().optional()`
  - [x] Add type export for `TokenCeilings`

- [x] Task 2: Thread token ceiling through workflow deps (AC: #2, #3, #4)
  - [x] Add `getTokenCeiling(workflowType: string): number` helper that reads from parsed config, falls back to hardcoded default
  - [x] In `WorkflowDeps` or equivalent, make the resolved ceiling available to each workflow

- [x] Task 3: Update each workflow to use config ceiling (AC: #2, #3, #4, #6)
  - [x] `create-story.ts`: replace `const TOKEN_CEILING = 3000` with resolved value
  - [x] `dev-story.ts`: replace `const TOKEN_CEILING = 24_000` with resolved value
  - [x] `code-review.ts`: replace `const TOKEN_CEILING = 100000` with resolved value
  - [x] `test-plan.ts`: replace `const TOKEN_CEILING = 8_000` with resolved value
  - [x] `test-expansion.ts`: replace `const TOKEN_CEILING = 20_000` with resolved value
  - [x] Log the effective ceiling and source in each workflow

- [x] Task 4: Unit tests (AC: #1-#6)
  - [x] Test: config with `token_ceilings.create-story: 15000` resolves to 15000
  - [x] Test: config without `token_ceilings` resolves to hardcoded defaults
  - [x] Test: config with partial ceilings (only `create-story`) uses config for that, defaults for others
  - [x] Test: invalid values rejected by schema validation
  - [x] Test: workflow log message includes ceiling and source (verified via getTokenCeiling return values)

## Dev Notes

### Key Files
- Config schema: `src/modules/methodology-pack/schemas.ts` or `src/core/config-schema.ts` (check which owns `.substrate/config.yaml` parsing)
- `src/modules/compiled-workflows/create-story.ts` — `TOKEN_CEILING = 3000`
- `src/modules/compiled-workflows/dev-story.ts` — `TOKEN_CEILING = 24_000`
- `src/modules/compiled-workflows/code-review.ts` — `TOKEN_CEILING = 100000`
- `src/modules/compiled-workflows/test-plan.ts` — `TOKEN_CEILING = 8_000`
- `src/modules/compiled-workflows/test-expansion.ts` — `TOKEN_CEILING = 20_000`

### Design Decisions
- Per-workflow granularity (not a single global ceiling) because the workflows have very different token needs
- Config keys match the workflow names used in prompts and events for consistency
- The hardcoded constants remain as defaults — no behavioral change for existing users

## Change Log
- 2026-03-06: Story created from cross-project pipeline findings (code-review-agent create-story truncation)
