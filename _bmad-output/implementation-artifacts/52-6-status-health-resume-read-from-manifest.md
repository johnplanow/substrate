# Story 52-6: Status/Health/Resume Read from Manifest

## Story

As a substrate operator,
I want `substrate status`, `substrate health`, and `substrate resume` to read from the run manifest,
so that all CLI commands report consistent state without Dolt as the single source of truth for operational data.

## Acceptance Criteria

### AC1: status Command Reads Per-Story State from Manifest
**Given** an active run with a manifest at `.substrate/runs/{run-id}.json`
**When** `substrate status` is invoked
**Then** the command reads per-story state (status, phase, started_at, completed_at, cost_usd) from `manifest.per_story_state` instead of inferring from Dolt `wg_stories`
**And** token metrics (input_tokens, output_tokens, cost_usd totals) continue to be read from Dolt as an analytics projection

### AC2: health Command Reads Supervisor Ownership from Manifest
**Given** an active run with a manifest containing `supervisor_pid` and `supervisor_session_id`
**When** `substrate health` is invoked
**Then** the command reads supervisor ownership from the manifest fields rather than inferring from process inspection alone
**And** per-story progress counts (complete, in-progress, failed, escalated) are derived from `manifest.per_story_state`

### AC3: resume Command Reads Story Scope from Manifest
**Given** an active run with a manifest containing `cli_flags.stories` and `story_scope`
**When** `substrate resume` is invoked without an explicit `--stories` flag
**Then** the story scope is read from `manifest.cli_flags.stories` (if set) or `manifest.story_scope` rather than falling back to unscoped discovery from Dolt

### AC4: All Three Commands Fall Back Gracefully When No Manifest Exists
**Given** a pre-Phase-D run where `.substrate/runs/{run-id}.json` does not exist
**When** any of `substrate status`, `substrate health`, or `substrate resume` is invoked
**Then** each command falls back to its existing Dolt-based behavior without error
**And** a `debug`-level log entry is emitted: `"run manifest not found — falling back to Dolt"`

### AC5: Consistent Story Counts Across Commands
**Given** an active run where the manifest has per-story state entries for N stories
**When** `substrate status` and `substrate health` are each invoked for the same run
**Then** both commands report the same story counts for each status category (complete, in-progress, failed, escalated)
**And** neither command reports a story count that contradicts the manifest's `per_story_state` record

### AC6: Manifest Run ID Resolution via current-run-id File
**Given** the user invokes a command without an explicit `--run-id` flag
**When** the command resolves the active run
**Then** it reads `.substrate/current-run-id` to obtain the run ID, then loads `manifest = new RunManifest(runsDir, runId)` (same resolution order as story 52-1)
**And** if `.substrate/current-run-id` is absent, falls back to `getLatestRun(adapter)` from Dolt (existing behavior)

### AC7: Unit Tests for Manifest-Read Paths in Each Command
**Given** a mock `RunManifest` with populated `per_story_state`, `supervisor_pid`, `supervisor_session_id`, and `cli_flags`
**When** unit tests exercise the manifest-read paths for each command
**Then** status output reflects manifest story counts, health output reflects manifest supervisor ownership, and resume scope reflects manifest story scope
**And** each command's fallback path (no manifest) is also tested and invokes the pre-existing Dolt query

## Tasks / Subtasks

- [ ] Task 1: Create manifest-read helper for commands (AC: #4, #6)
  - [ ] Create `src/cli/commands/manifest-read.ts` with:
    - `resolveRunManifest(projectRoot: string, runId?: string): Promise<{ manifest: RunManifest | null, runId: string | null }>` — reads `.substrate/current-run-id`, loads `RunManifest`; returns `{ manifest: null, runId }` if file missing
    - `readCurrentRunId(runsDir: string): Promise<string | null>` — reads `.substrate/current-run-id` (or returns `null`)
    - Import `RunManifest` from `@substrate-ai/sdlc`; use `.substrate/runs/` as the `runsDir`
  - [ ] Add `debug`-level log via `createLogger('manifest-read')` when manifest is absent (AC4)

- [ ] Task 2: Update status command to read per-story state from manifest (AC: #1, #4, #5, #6)
  - [ ] In `src/cli/commands/status.ts`, import `resolveRunManifest` from `./manifest-read.js`
  - [ ] After resolving `runId`, call `resolveRunManifest(projectRoot, runId)` to load the manifest
  - [ ] If manifest is available, derive per-story status counts directly from `Object.values(manifest.data.per_story_state)` instead of querying `wg_stories` — map manifest `status` strings to the existing `WorkGraphSummary` shape
  - [ ] If manifest is null (no manifest), fall back to existing Dolt query (AC4)
  - [ ] Token metrics (input/output totals, cost) continue reading from Dolt regardless (AC1)

- [ ] Task 3: Update health command to read supervisor and per-story data from manifest (AC: #2, #4, #5)
  - [ ] In `src/cli/commands/health.ts`, import `resolveRunManifest` from `./manifest-read.js`
  - [ ] In `getAutoHealthData()`, after resolving `runId`, call `resolveRunManifest(projectRoot, runId)`
  - [ ] If manifest available:
    - Read `supervisor_pid` / `supervisor_session_id` from manifest to populate `supervisorOwnership` fields in health output
    - Derive per-story progress counts (complete/in-progress/failed/escalated) from `manifest.per_story_state` values, replacing the existing Dolt-based story-state query
  - [ ] If manifest is null, fall back to existing Dolt/process-inspection behavior (AC4)

- [ ] Task 4: Update resume command to read story scope from manifest (AC: #3, #4, #6)
  - [ ] In `src/cli/commands/resume.ts`, import `resolveRunManifest` from `./manifest-read.js`
  - [ ] After resolving `runId`, call `resolveRunManifest(projectRoot, runId)` to load the manifest
  - [ ] If manifest available and `options.stories` was not explicitly passed by the user:
    - Use `manifest.data.cli_flags.stories ?? manifest.data.story_scope ?? []` as the story scope for the resumed run
    - Emit a `debug`-level log: `"resume scope loaded from manifest: [...]"`
  - [ ] If manifest is null or `options.stories` was explicitly passed, keep existing behavior (AC4)

- [ ] Task 5: Unit tests for manifest-read helper (AC: #4, #6)
  - [ ] Create `src/cli/commands/__tests__/manifest-read.test.ts`
  - [ ] Use real `os.tmpdir()` temp directory; clean up in `afterEach`
  - [ ] Test: `resolveRunManifest` returns manifest when `.substrate/current-run-id` and manifest file exist
  - [ ] Test: `resolveRunManifest` returns `{ manifest: null }` and logs `debug` when `current-run-id` file is absent
  - [ ] Test: `resolveRunManifest` returns `{ manifest: null }` when manifest JSON file is missing even if `current-run-id` exists

- [ ] Task 6: Unit tests for status manifest-read path (AC: #1, #4, #5)
  - [ ] Create `src/cli/commands/__tests__/status-manifest.test.ts`
  - [ ] Mock `RunManifest` via `vi.mock('@substrate-ai/sdlc')` — stub `.data.per_story_state` with 3 stories (1 complete, 1 dispatched, 1 escalated)
  - [ ] Test: status output includes correct per-story counts derived from manifest (AC1, AC5)
  - [ ] Test: when manifest is null, status falls back to existing Dolt query call (AC4)

- [ ] Task 7: Unit tests for health and resume manifest-read paths (AC: #2, #3, #4)
  - [ ] Create `src/cli/commands/__tests__/health-manifest.test.ts`
    - Mock `RunManifest` with `supervisor_pid: 12345`, `supervisor_session_id: 'sess-abc'`, `per_story_state: { '1-1': { status: 'complete', ... } }`
    - Test: health output includes supervisor PID from manifest (AC2)
    - Test: per-story counts in health output match manifest (AC2, AC5)
    - Test: when manifest is null, health falls back to existing process inspection (AC4)
  - [ ] Create `src/cli/commands/__tests__/resume-manifest.test.ts`
    - Mock `RunManifest` with `cli_flags: { stories: ['2-1', '2-2'] }`, `story_scope: ['2-1', '2-2', '2-3']`
    - Test: resume uses `cli_flags.stories` when user did not pass `--stories` flag (AC3)
    - Test: resume uses user-provided `--stories` override even when manifest exists (AC3)
    - Test: when manifest is null, resume falls back to Dolt-based unscoped discovery (AC4)

## Dev Notes

### Architecture Constraints
- **Package for RunManifest**: Import `RunManifest` from `@substrate-ai/sdlc` (provided by story 52-1). The `runsDir` is `path.join(dbRoot, '.substrate', 'runs')`. The manifest file path resolves as `{runsDir}/{run-id}.json`.
- **current-run-id file**: Located at `.substrate/current-run-id` (relative to `dbRoot`). This plain-text file contains just the run ID string. Read with `fs/promises readFile`, trim whitespace.
- **Non-fatal manifest reads**: All `RunManifest` construction and `.data` access must be wrapped in try/catch. A manifest that exists but fails to parse should be treated as "no manifest" (log `warn`, fall back). Never throw from manifest-read path.
- **Manifest data access**: After story 52-1, `RunManifest` exposes `.data` as the parsed `RunManifestData` object. Access pattern: `const { data } = await manifest.read()` or `manifest.data` if the class stores it post-construction — check the 52-1 implementation to confirm the exact API.
- **No new manifest writes in this story**: Story 52-6 is read-only. Writes to the manifest (patchStoryState, patchSupervisor, etc.) happen in stories 52-2 through 52-5. Do not add write calls here.
- **WorkGraphSummary shape**: In `status.ts`, the per-story counts are emitted as part of `WorkGraphSummary` (fields: `ready`, `blocked`, `inProgress`, `complete`, `escalated`, `failed`). Map manifest status strings as: `'complete'` → `complete`, `'escalated'` → `escalated`, `'failed'` → `failed`, `'verification-failed'` → `failed`, `'dispatched' | 'in-review'` → `inProgress`, `'pending'` → `ready`. Unknown strings → `inProgress` (safe default).
- **Supervisor ownership in health output**: The `PipelineHealthOutput` type currently contains a `processInfo` field of type `ProcessInfo`. Add supervisor manifest fields as an optional extension rather than replacing existing process detection. The supervisor_pid from the manifest can be used to cross-reference the process tree result.
- **Resume stories resolution order**: `options.stories` (CLI flag, explicit) → `manifest.cli_flags.stories` → `manifest.story_scope` → `resolveStoryKeys(adapter, runId)` (existing Dolt-based unscoped). Only skip the first source if `options.stories` is undefined/empty.
- **Test isolation**: Use `vi.mock('@substrate-ai/sdlc', () => ({ RunManifest: vi.fn() }))` for command-level tests. Do NOT use real file I/O in command unit tests; reserve real I/O for `manifest-read.test.ts`.
- **ESM imports**: All new imports use `.js` extension (e.g., `from './manifest-read.js'`). The codebase is ESM throughout.

### Key File Paths
| File | Change |
|---|---|
| `src/cli/commands/manifest-read.ts` | **NEW** — shared manifest-resolution helper for CLI commands |
| `src/cli/commands/status.ts` | **EXTEND** — read per-story state from manifest when available |
| `src/cli/commands/health.ts` | **EXTEND** — read supervisor ownership and story counts from manifest |
| `src/cli/commands/resume.ts` | **EXTEND** — read story scope from manifest when no explicit `--stories` flag |
| `src/cli/commands/__tests__/manifest-read.test.ts` | **NEW** — unit tests for manifest resolution helper |
| `src/cli/commands/__tests__/status-manifest.test.ts` | **NEW** — unit tests for status manifest-read path |
| `src/cli/commands/__tests__/health-manifest.test.ts` | **NEW** — unit tests for health manifest-read path |
| `src/cli/commands/__tests__/resume-manifest.test.ts` | **NEW** — unit tests for resume manifest-read path |

### Testing Requirements
- **Framework**: Vitest. Import from `vitest`, never from `jest`.
- **Mock pattern**: Use `vi.mock('@substrate-ai/sdlc', () => ({ RunManifest: vi.fn().mockImplementation(() => ({ data: <stubData> })) }))` for command-level tests.
- **Real I/O in manifest-read tests**: `manifest-read.test.ts` should use `os.tmpdir()` with real file writes to test the actual file-resolution logic.
- **Targeted run**: `npm run test:fast` (unit tests only, ~50s). Confirm `pgrep -f vitest` returns nothing before running.
- **Build check**: Run `npm run build` after implementation to catch type errors. Any new fields added to `PipelineHealthOutput` or `WorkGraphSummary` must not break existing downstream type consumers.

### Manifest-Read Helper Reference
```typescript
// src/cli/commands/manifest-read.ts
import { join } from 'path'
import { readFile } from 'fs/promises'
import { RunManifest } from '@substrate-ai/sdlc'
import { createLogger } from '../../utils/logger.js'

const logger = createLogger('manifest-read')

export async function readCurrentRunId(dbRoot: string): Promise<string | null> {
  try {
    const content = await readFile(join(dbRoot, '.substrate', 'current-run-id'), 'utf8')
    return content.trim() || null
  } catch {
    return null
  }
}

export async function resolveRunManifest(
  dbRoot: string,
  runId?: string,
): Promise<{ manifest: RunManifest | null; runId: string | null }> {
  const resolvedRunId = runId ?? await readCurrentRunId(dbRoot)
  if (!resolvedRunId) {
    logger.debug('run manifest not found — falling back to Dolt (no current-run-id)')
    return { manifest: null, runId: null }
  }
  const runsDir = join(dbRoot, '.substrate', 'runs')
  try {
    const manifest = new RunManifest(runsDir, resolvedRunId)
    await manifest.read()  // validates file exists and parses correctly
    return { manifest, runId: resolvedRunId }
  } catch {
    logger.debug({ runId: resolvedRunId }, 'run manifest not found — falling back to Dolt')
    return { manifest: null, runId: resolvedRunId }
  }
}
```

### Manifest Status → WorkGraphSummary Mapping Reference
```typescript
function manifestStatusToWorkGraphBucket(status: string): keyof WorkGraphCounts {
  switch (status) {
    case 'complete':              return 'complete'
    case 'escalated':             return 'escalated'
    case 'failed':
    case 'verification-failed':   return 'failed'
    case 'dispatched':
    case 'in-review':
    case 'recovered':             return 'inProgress'
    case 'gated':
    case 'pending':               return 'ready'
    default:                      return 'inProgress'
  }
}
```

## Interface Contracts

- **Import**: `RunManifest`, `RunManifestData` @ `packages/sdlc/src/run-model/run-manifest.ts` (from story 52-1)
- **Import**: `PerStoryState` @ `packages/sdlc/src/run-model/per-story-state.ts` (from story 52-4)
- **Import**: `cli_flags` fields @ `packages/sdlc/src/run-model/types.ts` (from story 52-3)
- **Export**: `resolveRunManifest`, `readCurrentRunId` @ `src/cli/commands/manifest-read.ts` (consumed by status, health, resume commands in this story; may be reused by other CLI commands in Epic 53–54)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-06 | Initial story created for Epic 52 Phase D |
