# Story 52-3: CLI Flag Persistence

## Story

As a substrate operator,
I want all CLI flags (--stories, --halt-on, --cost-ceiling, --agent, --skip-verification) persisted in the run manifest at run start,
so that the supervisor can read the original scope on restart.

## Acceptance Criteria

### AC1: All flags written to manifest at run start
**Given** `substrate run --events --stories 51-1,51-2 --halt-on critical --cost-ceiling 5.00 --agent codex --skip-verification`
**When** the run starts and a run ID is assigned
**Then** `run_manifest.cli_flags` at `.substrate/runs/{run-id}.json` contains `stories: ['51-1', '51-2']`, `halt_on: 'critical'`, `cost_ceiling: 5.00`, `agent: 'codex'`, `skip_verification: true`, `events: true`

### AC2: New CLI flags --halt-on and --cost-ceiling accepted by run command
**Given** `substrate run --halt-on critical --cost-ceiling 5.00`
**When** the run command parses its flags
**Then** `--halt-on` accepts `all | critical | none` (rejects other values with exit code 1 and a clear error message)
**And** `--cost-ceiling` accepts a positive number (USD); rejects non-positive values with exit code 1

### AC3: Default values for omitted flags
**Given** `substrate run --events --stories 52-3` with no `--halt-on` or `--cost-ceiling`
**When** flags are written to the manifest
**Then** `cli_flags.halt_on` defaults to `'none'`
**And** `cli_flags.cost_ceiling` is omitted from the manifest (undefined is not serialised)

### AC4: `substrate resume` reads story scope from manifest
**Given** a manifest at `.substrate/runs/{run-id}.json` with `cli_flags.stories: ['51-1', '51-2']`
**When** `substrate resume` is invoked without a `--stories` argument
**Then** it reads `cli_flags.stories` from the manifest and passes them to `resolveStoryKeys`
**And** the resumed run is scoped to exactly `['51-1', '51-2']`

### AC5: Supervisor restart passes stories from manifest (TS-1)
**Given** a run manifest with `cli_flags.stories: ['51-1', '51-2']`
**When** the supervisor kills a stalled pipeline and calls `runResumeAction`
**Then** it reads `cli_flags.stories` from the manifest and passes them as `options.stories`
**And** scope is preserved 100% — no stories from other epics are discovered or dispatched

### AC6: Graceful fallback when manifest is absent
**Given** a pre-Phase-D run with no manifest file at `.substrate/runs/{run-id}.json`
**When** `substrate resume` or the supervisor restart reads the manifest
**Then** they fall back to unscoped story discovery (existing behavior)
**And** no error is thrown; a debug-level log entry is emitted

### AC7: CliFlags Zod schema exported from run-manifest module
**Given** the `CliFlags` type exported from `packages/sdlc/src/run-manifest/cli-flags.ts`
**When** a manifest is deserialised
**Then** `CliFlags` validation catches unknown `halt_on` values and missing required fields
**And** the schema is re-exported from `packages/sdlc/src/run-manifest/index.ts`

## Tasks / Subtasks

- [ ] Task 1: Define CliFlags Zod schema and extend RunManifest with patchCLIFlags (AC1, AC7)
  - [ ] Create `packages/sdlc/src/run-manifest/cli-flags.ts` with `CliFlags` interface and Zod schema (`z.object({ stories: z.array(z.string()).optional(), halt_on: z.enum(['all', 'critical', 'none']).optional(), cost_ceiling: z.number().positive().optional(), agent: z.string().optional(), skip_verification: z.boolean().optional(), events: z.boolean().optional() })`)
  - [ ] Add `patchCLIFlags(flags: CliFlags): Promise<void>` method to the `RunManifest` class (`packages/sdlc/src/run-manifest/run-manifest.ts`, created in 52-1) — reads current manifest, merges `cli_flags`, writes atomically
  - [ ] Export `CliFlags`, `CliFlagsSchema` from `packages/sdlc/src/run-manifest/index.ts`

- [ ] Task 2: Add --halt-on and --cost-ceiling flags to run command and extend RunOptions (AC2, AC3)
  - [ ] Add `haltOn?: 'all' | 'critical' | 'none'` and `costCeiling?: number` to the `RunOptions` interface in `src/cli/commands/run.ts`
  - [ ] Register `.option('--halt-on <severity>', 'Halt on escalation severity: all | critical | none', 'none')` and `.option('--cost-ceiling <amount>', 'Maximum cost ceiling in USD (positive number)', parseFloat)` in `registerRunCommand`
  - [ ] Validate `--halt-on` value against `['all', 'critical', 'none']` inside `runRunAction`; emit error and return 1 if invalid
  - [ ] Validate `--cost-ceiling` is > 0 if provided; emit error and return 1 if invalid

- [ ] Task 3: Persist CLI flags to manifest after run ID is assigned (AC1, AC3)
  - [ ] In `runRunAction` (`src/cli/commands/run.ts`), after `createPipelineRun()` returns a `run_id`, construct a `CliFlags` object from the resolved options (`stories: parsedStoryKeys.length > 0 ? parsedStoryKeys : undefined`, `halt_on: haltOn ?? 'none'`, `cost_ceiling: costCeiling`, `agent: agentId`, `skip_verification: skipVerification`, `events: eventsFlag`)
  - [ ] Call `await RunManifest.open(runId, runsDir).patchCLIFlags(cliFlags)` where `runsDir = join(dbDir, 'runs')`
  - [ ] Wrap in try/catch; log warning on failure (non-fatal — manifest write failure must not abort the pipeline)
  - [ ] Import `RunManifest` and `CliFlags` from `@substrate-ai/sdlc` (re-exported via package index)

- [ ] Task 4: Update resume command to read story scope from manifest (AC4, AC6)
  - [ ] In `runResumeAction` (`src/cli/commands/resume.ts`), after resolving `latestRun`, when `options.stories` is undefined or empty, attempt to load manifest: `RunManifest.open(runId, runsDir).read()`
  - [ ] If manifest has `cli_flags.stories`, assign to `resolvedStoryKeys` before calling `resolveStoryKeys`
  - [ ] If manifest read fails or `cli_flags.stories` is empty, log at debug level and fall back to unscoped discovery (existing behavior)
  - [ ] Import `RunManifest` from `@substrate-ai/sdlc`

- [ ] Task 5: Update supervisor restart to pass stories from manifest (AC5, AC6)
  - [ ] In `src/cli/commands/supervisor.ts`, in `handleStallRecovery` (or equivalent restart path), before calling `deps.resumePipeline(opts)`, read manifest for the active run ID
  - [ ] If `cli_flags.stories` present, merge into `ResumeOptions.stories`
  - [ ] If manifest absent or read fails, log debug warning and proceed with unscoped resume (existing behavior, no regression)
  - [ ] Import `RunManifest` from `@substrate-ai/sdlc`

- [ ] Task 6: Unit tests for CLI flag writing (AC1, AC2, AC3)
  - [ ] Create `src/cli/commands/__tests__/cli-flag-persistence.test.ts`
  - [ ] Mock `RunManifest.open().patchCLIFlags` with `vi.mock('@substrate-ai/sdlc', ...)`
  - [ ] Test: `runRunAction` calls `patchCLIFlags` with correct `stories`, `halt_on`, `agent`, `events` when all flags provided
  - [ ] Test: `runRunAction` with no `--halt-on` writes `halt_on: 'none'`; `cost_ceiling` absent when not provided
  - [ ] Test: `--halt-on invalid` returns exit code 1 with message containing `'all | critical | none'`
  - [ ] Test: `--cost-ceiling -1` returns exit code 1 with message containing `'positive'`
  - [ ] Test: manifest write failure (patchCLIFlags throws) does NOT abort the pipeline (run continues, returns success)

- [ ] Task 7: Unit tests for scope preservation on resume and supervisor restart (AC4, AC5, AC6 — TS-1)
  - [ ] Create `src/cli/commands/__tests__/supervisor-scope-preservation.test.ts`
  - [ ] Test (TS-1): supervisor restart reads `cli_flags.stories: ['51-1', '51-2']` from mock manifest and passes them to `runResumeAction`; assert `options.stories` equals `['51-1', '51-2']`
  - [ ] Test: supervisor restart with manifest absent falls back without error and calls `runResumeAction` without `stories`
  - [ ] Test: `runResumeAction` without `--stories` reads `cli_flags.stories` from manifest and calls `resolveStoryKeys` with them
  - [ ] Test: `runResumeAction` with `--stories 52-3` on CLI ignores manifest and uses CLI value (CLI takes precedence)

## Dev Notes

### Architecture Constraints
- This story depends on **Story 52-1** (RunManifest class with atomic I/O). The `RunManifest` class and its `patchCLIFlags()` method must exist before this story is implemented. Do not re-implement atomic I/O here — use the 52-1 API.
- Import path for `RunManifest`: `import { RunManifest } from '@substrate-ai/sdlc'` (re-exported from `packages/sdlc/src/index.ts`)
- `CliFlags` schema location: `packages/sdlc/src/run-manifest/cli-flags.ts` (new file in this story, part of the run-manifest module created in 52-1)
- Package placement: all new types live in `packages/sdlc/` per architecture Decision 1. The `src/cli/commands/` files are wiring only.
- Manifest directory: `join(dbDir, 'runs')` where `dbDir = join(dbRoot, '.substrate')`. This is consistent with the `.substrate/runs/{run-id}.json` path from 52-1.
- **Non-fatal writes**: manifest write failures must never abort the pipeline. Wrap all `patchCLIFlags` calls in try/catch with `logger.warn`.
- **CLI precedence**: if `--stories` is provided on the CLI at resume time, it takes precedence over the manifest value. Manifest is the fallback, not the override.
- Backward compatibility: pre-Phase-D runs have no manifest. All manifest reads must handle `ENOENT` gracefully.

### Testing Requirements
- Framework: **vitest** with `vi.mock` for module mocking
- Test files co-located under `src/cli/commands/__tests__/`
- Mock `RunManifest` from `@substrate-ai/sdlc` — do not perform real file I/O in unit tests
- TS-1 test must explicitly assert that `options.stories` passed to `runResumeAction` equals the manifest's `cli_flags.stories` array (not a superset, not a subset)
- Tests for `--halt-on` and `--cost-ceiling` validation must check both the exit code (1) and the error message content
- Use `vi.spyOn(process.stderr, 'write')` or capture output via `outputFormat: 'json'` for error assertion

### Key File Paths
| File | Change |
|---|---|
| `packages/sdlc/src/run-manifest/cli-flags.ts` | **NEW** — CliFlags interface and Zod schema |
| `packages/sdlc/src/run-manifest/run-manifest.ts` | **EXTEND** — add `patchCLIFlags()` method (file created in 52-1) |
| `packages/sdlc/src/run-manifest/index.ts` | **EXTEND** — re-export CliFlags, CliFlagsSchema |
| `packages/sdlc/src/index.ts` | **EXTEND** — re-export RunManifest if not already exported |
| `src/cli/commands/run.ts` | **EXTEND** — add --halt-on, --cost-ceiling; persist flags after run ID assigned |
| `src/cli/commands/resume.ts` | **EXTEND** — read cli_flags.stories from manifest when --stories not provided |
| `src/cli/commands/supervisor.ts` | **EXTEND** — pass cli_flags.stories to runResumeAction on restart |
| `src/cli/commands/__tests__/cli-flag-persistence.test.ts` | **NEW** — AC1–AC3 tests |
| `src/cli/commands/__tests__/supervisor-scope-preservation.test.ts` | **NEW** — AC4–AC6 / TS-1 tests |

### CliFlags Schema (Reference)
```typescript
// packages/sdlc/src/run-manifest/cli-flags.ts
import { z } from 'zod'

export const CliFlagsSchema = z.object({
  stories:           z.array(z.string()).optional(),
  halt_on:           z.enum(['all', 'critical', 'none']).optional(),
  cost_ceiling:      z.number().positive().optional(),
  agent:             z.string().optional(),
  skip_verification: z.boolean().optional(),
  events:            z.boolean().optional(),
})

export type CliFlags = z.infer<typeof CliFlagsSchema>
```

### patchCLIFlags Integration Point (Reference)
```typescript
// In runRunAction (src/cli/commands/run.ts), after createPipelineRun() resolves:
const runsDir = join(dbDir, 'runs')
const cliFlags: CliFlags = {
  ...(parsedStoryKeys.length > 0 ? { stories: parsedStoryKeys } : {}),
  halt_on: haltOn ?? 'none',
  ...(costCeiling !== undefined ? { cost_ceiling: costCeiling } : {}),
  ...(agentId !== undefined ? { agent: agentId } : {}),
  ...(skipVerification === true ? { skip_verification: true } : {}),
  ...(eventsFlag === true ? { events: true } : {}),
}
try {
  await RunManifest.open(run.run_id, runsDir).patchCLIFlags(cliFlags)
} catch (err) {
  logger.warn({ err }, 'Failed to persist CLI flags to run manifest — pipeline continues')
}
```

### Supervisor Restart Integration Point (Reference)
```typescript
// In handleStallRecovery / restart path (src/cli/commands/supervisor.ts):
let manifestStories: string[] | undefined
try {
  const runsDir = join(dbDir, 'runs')
  const manifest = await RunManifest.open(activeRunId, runsDir).read()
  manifestStories = manifest.cli_flags?.stories
} catch {
  logger.debug('Run manifest not found for scope preservation — proceeding with unscoped resume')
}
const resumeOpts: ResumeOptions = {
  ...existingOpts,
  ...(manifestStories && manifestStories.length > 0 ? { stories: manifestStories } : {}),
}
await deps.resumePipeline(resumeOpts)
```

## Interface Contracts

- **Import**: `RunManifest` @ `packages/sdlc/src/run-manifest/run-manifest.ts` (from story 52-1)
- **Export**: `CliFlags`, `CliFlagsSchema` @ `packages/sdlc/src/run-manifest/cli-flags.ts`

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
