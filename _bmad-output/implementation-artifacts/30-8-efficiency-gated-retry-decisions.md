# Story 30-8: Efficiency-Gated Retry Decisions

## Story

As a pipeline operator retrying escalated stories,
I want the retry command to check each story's prior efficiency profile before dispatching,
so that stories that failed due to context management issues receive an adjusted context ceiling and operators are warned when a retry is likely to encounter the same inefficiency.

## Acceptance Criteria

### AC1: `--force` flag added to `retry-escalated` command
**Given** the `retry-escalated` CLI command definition
**When** the command is registered via `registerRetryEscalatedCommand`
**Then** it accepts a `--force` boolean flag that, when set, bypasses all efficiency-gate checks (warning suppression and ceiling injection) and proceeds directly to retry

### AC2: TelemetryAdvisor wired into retry-escalated action
**Given** a database containing efficiency scores from a prior pipeline run
**When** `runRetryEscalatedAction` executes (not dry-run, not `--force`)
**Then** a `TelemetryAdvisor` is created via `createTelemetryAdvisor({ db: adapter })` and its `getEfficiencyProfile(storyKey)` is called for each story in the `retryable` list before the orchestrator is invoked

### AC3: Warning emitted when prior compositeScore < 50
**Given** story `5-4` has a stored efficiency score with `compositeScore: 35`
**When** `runRetryEscalatedAction` prepares to retry story `5-4` without `--force`
**Then** stdout receives: `[WARN] 5-4: Previous run had low efficiency (score: 35). Retry may encounter the same issues.\n` — the retry proceeds (advisory, not blocking)

### AC4: Context ceiling injected when contextManagementSubScore < 50
**Given** story `5-4` has a stored efficiency score with `contextManagementSubScore: 30`
**When** `runRetryEscalatedAction` prepares to retry story `5-4` without `--force`
**Then** `OrchestratorConfig.perStoryContextCeilings['5-4']` is set to `80000` (80% of `100_000` default), stdout receives `[INFO] 5-4: Context ceiling set to 80000 tokens due to prior context spike pattern.\n`, and this ceiling is passed to `createImplementationOrchestrator`

### AC5: `AdapterOptions` extended and ClaudeCodeAdapter propagates `maxContextTokens`
**Given** `AdapterOptions` in `src/adapters/types.ts`
**When** the interface is read
**Then** it has an optional `maxContextTokens?: number` field; and when `ClaudeCodeAdapter.buildCommand()` is called with `options.maxContextTokens` set, it appends `'--max-context-tokens', String(options.maxContextTokens)` to the Claude CLI args

### AC6: Orchestrator propagates per-story context ceiling into dispatch options
**Given** `OrchestratorConfig.perStoryContextCeilings` contains `{ '5-4': 80000 }`
**When** the orchestrator builds `AdapterOptions` for story `5-4`'s dispatch
**Then** `adapterOptions.maxContextTokens` is set to `80000`; stories not in `perStoryContextCeilings` receive no `maxContextTokens` field (backward compatible)

### AC7: `--force` bypasses warning and ceiling injection
**Given** story `5-4` has `compositeScore: 10` and `contextManagementSubScore: 5`
**When** `runRetryEscalatedAction` is called with `force: true`
**Then** no `[WARN]` or `[INFO]` lines are written to stdout for the efficiency gate, and `perStoryContextCeilings` remains empty

### AC8: Graceful pass-through when no efficiency data exists
**Given** story `5-4` has no efficiency score row in the database
**When** `TelemetryAdvisor.getEfficiencyProfile('5-4')` returns `null`
**Then** no warning and no ceiling are applied — the story is retried with default dispatch options, and no error is thrown

## Tasks / Subtasks

- [ ] Task 1: Add `--force` flag to `retry-escalated` options and CLI definition (AC: #1, #7)
  - [ ] In `src/cli/commands/retry-escalated.ts`, add `force: boolean` to `RetryEscalatedOptions`
  - [ ] Add `.option('--force', 'Bypass efficiency-gate checks (warning and context ceiling)', false)` to the Commander command definition (after `--dry-run`)
  - [ ] Destructure `force` in `runRetryEscalatedAction` and pass from Commander action handler through to the options object

- [ ] Task 2: Extend `AdapterOptions` with `maxContextTokens` (AC: #5)
  - [ ] In `src/adapters/types.ts`, add field to `AdapterOptions`:
    ```typescript
    /** Optional context token ceiling (Story 30-8). Passed as --max-context-tokens to Claude CLI. */
    maxContextTokens?: number
    ```
  - [ ] In `src/adapters/claude-adapter.ts`, in `buildCommand()`, after the `maxTurns` block add:
    ```typescript
    if (options.maxContextTokens !== undefined) {
      args.push('--max-context-tokens', String(options.maxContextTokens))
    }
    ```
  - [ ] `npm run build` — confirm no TypeScript errors

- [ ] Task 3: Extend `OrchestratorConfig` with `perStoryContextCeilings` (AC: #6)
  - [ ] In `src/modules/implementation-orchestrator/types.ts`, add to `OrchestratorConfig`:
    ```typescript
    /**
     * Per-story context token ceilings for efficiency-gated retries (Story 30-8).
     * Keys are storyKeys; values are maxContextTokens to pass in AdapterOptions.
     */
    perStoryContextCeilings?: Record<string, number>
    ```
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`, locate the `AdapterOptions` construction for each story dispatch (search for existing `maxTurns` spread pattern near dispatch call sites)
  - [ ] Add ceiling propagation alongside the `maxTurns` pattern:
    ```typescript
    ...(config.perStoryContextCeilings?.[storyKey] !== undefined
      ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
      : {}),
    ```

- [ ] Task 4: Wire `TelemetryAdvisor` and efficiency gate into `runRetryEscalatedAction` (AC: #2, #3, #4, #7, #8)
  - [ ] Add imports to `src/cli/commands/retry-escalated.ts`:
    ```typescript
    import { createTelemetryAdvisor } from '../../modules/telemetry/telemetry-advisor.js'
    ```
  - [ ] After `initSchema(adapter)` and before the `dryRun` branch, add the efficiency-gate block (guard with `if (!dryRun && !force)`):
    ```typescript
    const advisor = createTelemetryAdvisor({ db: adapter })
    const perStoryContextCeilings: Record<string, number> = {}
    const CONTEXT_SPIKE_THRESHOLD = 100_000
    const contextCeiling = Math.round(CONTEXT_SPIKE_THRESHOLD * 0.8)

    for (const storyKey of retryable) {
      try {
        const profile = await advisor.getEfficiencyProfile(storyKey)
        if (profile === null) continue
        if (profile.compositeScore < 50) {
          process.stdout.write(
            `[WARN] ${storyKey}: Previous run had low efficiency (score: ${profile.compositeScore}). Retry may encounter the same issues.\n`,
          )
        }
        if (profile.contextManagementSubScore < 50) {
          perStoryContextCeilings[storyKey] = contextCeiling
          process.stdout.write(
            `[INFO] ${storyKey}: Context ceiling set to ${contextCeiling} tokens due to prior context spike pattern.\n`,
          )
        }
      } catch (err) {
        logger.warn({ err, storyKey }, 'Failed to read efficiency profile — skipping gate')
      }
    }
    ```
  - [ ] Pass `perStoryContextCeilings` into `createImplementationOrchestrator` config:
    ```typescript
    config: {
      maxConcurrency: concurrency,
      maxReviewCycles: 2,
      pipelineRunId: pipelineRun.id,
      ...(Object.keys(perStoryContextCeilings).length > 0 ? { perStoryContextCeilings } : {}),
    },
    ```

- [ ] Task 5: Unit tests for efficiency gate logic (AC: #3, #4, #7, #8)
  - [ ] Create `src/cli/commands/__tests__/retry-escalated-efficiency-gate.test.ts`
  - [ ] Mock `createTelemetryAdvisor` via `vi.mock('../../modules/telemetry/telemetry-advisor.js', ...)` returning a spy with configurable `getEfficiencyProfile`
  - [ ] Mock `createImplementationOrchestrator` to capture the `config` passed to it
  - [ ] Test: `compositeScore: 35` emits `[WARN]` line on stdout
  - [ ] Test: `contextManagementSubScore: 30` emits `[INFO]` line and passes `perStoryContextCeilings: { '5-4': 80000 }` to orchestrator config
  - [ ] Test: `force: true` with `compositeScore: 10` → no `[WARN]` or `[INFO]` lines, no perStoryContextCeilings set
  - [ ] Test: `getEfficiencyProfile` returns `null` → no warning, no ceiling, no error thrown
  - [ ] Test: `getEfficiencyProfile` throws → caught by try/catch, retry proceeds normally (fallthrough)

- [ ] Task 6: Unit tests for `ClaudeCodeAdapter` maxContextTokens → CLI args (AC: #5)
  - [ ] In `src/adapters/__tests__/claude-adapter.test.ts`, add to existing `buildCommand` describe block:
    - Test: `maxContextTokens: 80000` → args include `['--max-context-tokens', '80000']`
    - Test: no `maxContextTokens` → args do NOT include `'--max-context-tokens'`

- [ ] Task 7: Run full tests and confirm no regressions (AC: all)
  - [ ] `npm run build` — no TypeScript errors
  - [ ] `npm run test:fast` — confirm "Test Files" summary shows all passing with no new failures

## Dev Notes

### Architecture Constraints

- **File locations** (must match exactly):
  - `src/adapters/types.ts` — `maxContextTokens` field added to `AdapterOptions`
  - `src/adapters/claude-adapter.ts` — `--max-context-tokens` flag in `buildCommand()`
  - `src/modules/implementation-orchestrator/types.ts` — `perStoryContextCeilings` field on `OrchestratorConfig`
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — ceiling propagated into dispatch `AdapterOptions` at every story dispatch call site
  - `src/cli/commands/retry-escalated.ts` — `--force` flag, TelemetryAdvisor wiring, efficiency-gate block
  - `src/cli/commands/__tests__/retry-escalated-efficiency-gate.test.ts` — new test file
  - `src/adapters/__tests__/claude-adapter.test.ts` — extend existing tests

- **Import style**: ESM `.js` extensions. No new external dependencies.
- **Test framework**: Vitest — use `vi.fn()`, `vi.mock`, `describe`/`it`/`expect`. Never jest APIs.
- **Dependency on Story 30-6**: `createTelemetryAdvisor` must exist at `src/modules/telemetry/telemetry-advisor.ts` before this story can be implemented. The function signature expected here is:
  ```typescript
  createTelemetryAdvisor(deps: { db: DatabaseAdapter }): {
    getEfficiencyProfile(storyKey: string): Promise<EfficiencyScore | null>
  }
  ```
  If 30-6 is not yet implemented, stub the import in tests with `vi.mock`.

### TelemetryAdvisor usage pattern

This story only calls one method on TelemetryAdvisor:
```typescript
const profile = await advisor.getEfficiencyProfile(storyKey)
// profile is EfficiencyScore | null
if (profile !== null) {
  if (profile.compositeScore < 50) { /* warn */ }
  if (profile.contextManagementSubScore < 50) { /* inject ceiling */ }
}
```

### Context ceiling calculation

The spike threshold is `100_000` (the standard Claude Code context window floor, matching `AdapterCapabilities.maxContextTokens` in tests). The ceiling = `Math.round(100_000 * 0.8)` = `80_000`.

This constant is defined inline in `runRetryEscalatedAction`. Do not add it to shared config — it is a local retry heuristic.

### Gate semantics: advisory not blocking

The gate is **never** a hard blocker. The correct behavior for every code path:
- `compositeScore < 50` → warn, then **proceed**
- `contextManagementSubScore < 50` → inform + inject ceiling, then **proceed**
- `--force` → skip both checks, **proceed**
- `null` profile (no data) → **proceed silently**
- `getEfficiencyProfile` throws → log warn at debug level, **proceed**

### Finding dispatch call sites in orchestrator

Search `orchestrator-impl.ts` for the pattern that assembles `AdapterOptions` for story dispatches. There are typically multiple dispatch call sites (create-story, dev-story, code-review). The `maxTurns` field is already spread conditionally — follow the same pattern:

```typescript
const dispatchOpts: AdapterOptions = {
  worktreePath: ...,
  model: ...,
  ...(maxTurns !== undefined ? { maxTurns } : {}),
  // Story 30-8: inject context ceiling for efficiency-gated retries
  ...(config.perStoryContextCeilings?.[storyKey] !== undefined
    ? { maxContextTokens: config.perStoryContextCeilings[storyKey] }
    : {}),
}
```

Apply this at all dispatch call sites where `AdapterOptions` is constructed (not just one phase).

### Dry-run interaction

The efficiency gate must run in the **live path only** — not in dry-run mode. The `dryRun` check already exits early at line ~92. The gate block should be placed between `initSchema` and the dry-run check, but wrapped in `if (!dryRun && !force)` to avoid unnecessary DB queries.

### Testing Requirements

- **Test framework**: Vitest — test files must use `.test.ts` extension
- **Coverage**: 80% threshold enforced. Branches to cover: `compositeScore < 50`, `compositeScore >= 50`, `contextManagementSubScore < 50`, `contextManagementSubScore >= 50`, `force: true`, `null` profile, thrown exception
- **Run tests**: `npm run test:fast` — never pipe output; confirm by checking for "Test Files" in output
- **Targeted run during dev**: `npm run test:changed`

### Scope Boundaries

- **In scope**: `--force` flag, TelemetryAdvisor wiring in retry-escalated, warning/ceiling gate logic, `maxContextTokens` in `AdapterOptions` + `ClaudeCodeAdapter`, `perStoryContextCeilings` in `OrchestratorConfig` + orchestrator dispatch, new tests
- **Out of scope**: modifying `TelemetryAdvisor` itself (story 30-6), changing retry scheduling or escalation-query logic, modifying `telemetry-pipeline.ts`, `recommender.ts`, `persistence.ts`, or CLI metrics commands

## Interface Contracts

- **Import**: `createTelemetryAdvisor` @ `src/modules/telemetry/telemetry-advisor.ts` (from story 30-6) — provides `getEfficiencyProfile(storyKey): Promise<EfficiencyScore | null>`
- **Import**: `EfficiencyScore` @ `src/modules/telemetry/types.ts` — `compositeScore` (< 50 triggers warning) and `contextManagementSubScore` (< 50 triggers ceiling injection)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
