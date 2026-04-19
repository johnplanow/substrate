# Story 51-5: Pipeline Integration into Implementation Orchestrator

## Story

As a substrate developer,
I want the verification pipeline to run automatically after each story dispatch in the implementation orchestrator,
so that verification is a standard part of every pipeline run without operator action.

## Acceptance Criteria

### AC1: Verification Runs After Successful Dispatch
**Given** the implementation orchestrator's `processStory()` method in `src/modules/implementation-orchestrator/orchestrator-impl.ts`
**When** a story dispatch returns with a successful (SHIP_IT) outcome
**Then** the Tier A verification pipeline executes before the story is marked `COMPLETE` and before the orchestrator moves to the next story

### AC2: VerificationContext Assembled From Dispatch Data
**Given** a completed story dispatch reaching the SHIP_IT verdict
**When** the verification pipeline is invoked
**Then** a `VerificationContext` is constructed with:
  - `storyKey`: the story's key (e.g., `"51-5"`)
  - `workingDir`: the resolved project root (`projectRoot ?? process.cwd()`)
  - `commitSha`: the current HEAD SHA from `git rev-parse HEAD` (falls back to `'unknown'` on error)
  - `timeout`: `60_000` ms (matches BuildCheck's hard timeout)
  - `reviewResult`: `ReviewSignals` extracted from the code review dispatch result
  - `outputTokenCount`: total output tokens from the story's dev dispatch (may be `undefined` when unavailable)

### AC3: Verification Failure Creates `VERIFICATION_FAILED` Phase
**Given** a completed story dispatch where the verification pipeline returns `summary.status === 'fail'`
**When** the verification result is processed
**Then** the story is set to the new terminal phase `'VERIFICATION_FAILED'` (not `'ESCALATED'`, not `'COMPLETE'`)
**And** the failure is counted as a failure in the run summary (not a success)
**And** `wg_stories` is updated with status `'escalated'` (mapped from `VERIFICATION_FAILED` in `wgStatusForPhase`)
**And** the orchestrator does **not** emit `orchestrator:story-complete` for this story

### AC4: Verification Results Stored In Memory
**Given** a completed verification run returning a `VerificationSummary`
**When** the results are processed (pass, warn, or fail)
**Then** the summary is stored in an in-memory `Map<string, VerificationSummary>` keyed by `storyKey`
**And** the in-memory store persists for the lifetime of the orchestrator instance (available to future consumers in Epic 52)

### AC5: Warn Status Does Not Block Completion
**Given** a completed story dispatch where the verification pipeline returns `summary.status === 'warn'`
**When** the verification result is processed
**Then** the story proceeds to `'COMPLETE'` state as normal (warn is non-blocking)
**And** existing story phase transitions (create → dev → review → complete) are unchanged for passing stories

### AC6: Skip Verification Flag
**Given** the `--skip-verification` CLI flag is passed at runtime (or `config.skipVerification === true`)
**When** `processStory()` reaches the verification step
**Then** the pipeline invocation is bypassed entirely without warning or error
**And** the story proceeds to `'COMPLETE'` state as normal

### AC7: Unit Tests Cover All Branches
**Given** the unit test file for orchestrator verification integration
**When** `npm run test:fast` executes
**Then** at least 8 `it(...)` cases pass covering: context assembly with correct fields, commitSha fallback on git error, VerificationStore set/get, pipeline invoked on SHIP_IT, VERIFICATION_FAILED set on fail result, warn status does not block COMPLETE, skip flag bypasses pipeline, in-memory summary stored — confirmed by "Test Files" summary line showing the new test file green with zero failures

## Tasks / Subtasks

- [ ] Task 1: Add `VERIFICATION_FAILED` phase and `skipVerification` config (AC: #3, #6)
  - [ ] Read `src/modules/implementation-orchestrator/types.ts` before editing: `grep -n "StoryPhase\|OrchestratorConfig\|skipPreflight" src/modules/implementation-orchestrator/types.ts`
  - [ ] Add `'VERIFICATION_FAILED'` to the `StoryPhase` union type (after `'ESCALATED'`)
  - [ ] Add `skipVerification?: boolean` to `OrchestratorConfig` with JSDoc: `"When true, skip the post-dispatch Tier A verification pipeline (Story 51-5). Escape hatch for debugging."`
  - [ ] In `orchestrator-impl.ts`, locate `wgStatusForPhase()` and add a case: `case 'VERIFICATION_FAILED': return 'escalated'`
  - [ ] Run `npm run build` — confirm zero TypeScript errors before proceeding

- [ ] Task 2: Wire `--skip-verification` CLI flag (AC: #6)
  - [ ] Read the options section of `src/cli/commands/run.ts` before editing: `grep -n "skip-preflight\|skipPreflight\|option\|opts\." src/cli/commands/run.ts | head -30`
  - [ ] Add `.option('--skip-verification', 'Skip the post-dispatch verification pipeline (Story 51-5)')` following the `--skip-preflight` pattern
  - [ ] Declare `skipVerification?: boolean` in the inline opts type annotation (same location as `skipPreflight?`)
  - [ ] Wire `skipVerification: opts.skipVerification` into the `OrchestratorConfig` construction at every call site where `skipPreflight` appears (search: `grep -n "skipPreflight: skipPreflight" src/cli/commands/run.ts`)
  - [ ] Run `npm run build` — confirm zero TypeScript errors

- [ ] Task 3: Create verification integration module (AC: #1, #2, #4)
  - [ ] Create `src/modules/implementation-orchestrator/verification-integration.ts`
  - [ ] Use `.js` extension on all relative imports (ESM)
  - [ ] Import types from the sdlc package (workspace dep): `import type { VerificationContext, VerificationSummary, ReviewSignals } from '@substrate-ai/sdlc'`
  - [ ] Import the factory: `import { createDefaultVerificationPipeline } from '@substrate-ai/sdlc'`
  - [ ] Import `execSync` from `'node:child_process'`
  - [ ] Implement `assembleVerificationContext(opts: { storyKey: string, workingDir: string, reviewResult?: ReviewSignals, outputTokenCount?: number }): VerificationContext`:
    - Resolve `commitSha` via `execSync('git rev-parse HEAD', { cwd: opts.workingDir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()`
    - Wrap in try/catch — on error, `commitSha = 'unknown'`
    - `timeout`: hardcode `60_000`
    - Return a fully-typed `VerificationContext` with all fields
  - [ ] Implement `VerificationStore` class:
    ```typescript
    export class VerificationStore {
      private readonly _map = new Map<string, VerificationSummary>()
      set(storyKey: string, summary: VerificationSummary): void { this._map.set(storyKey, summary) }
      get(storyKey: string): VerificationSummary | undefined { return this._map.get(storyKey) }
      getAll(): ReadonlyMap<string, VerificationSummary> { return this._map }
    }
    ```
  - [ ] Export `assembleVerificationContext` and `VerificationStore` from this file
  - [ ] Export `createDefaultVerificationPipeline` re-export is **not needed** — import it directly in `orchestrator-impl.ts`
  - [ ] Run `npm run build` to confirm the module compiles cleanly

- [ ] Task 4: Hook verification into `processStory()` (AC: #1, #2, #3, #4, #5)
  - [ ] Read the SHIP_IT verdict handling block in `orchestrator-impl.ts` before editing:
    ```bash
    grep -n "SHIP_IT\|orchestrator:story-complete\|phase.*COMPLETE\|COMPLETE.*phase\|updateStory.*COMPLETE" \
      src/modules/implementation-orchestrator/orchestrator-impl.ts | head -20
    ```
  - [ ] In the orchestrator factory function (the outer closure that contains `processStory`), instantiate:
    ```typescript
    import type { TypedEventBus } from '@substrate-ai/core'
    import type { SdlcEvents } from '@substrate-ai/sdlc'
    import { createDefaultVerificationPipeline } from '@substrate-ai/sdlc'
    import { assembleVerificationContext, VerificationStore } from './verification-integration.js'

    const verificationStore = new VerificationStore()
    const verificationPipeline = createDefaultVerificationPipeline(
      eventBus as TypedEventBus<SdlcEvents>  // SdlcEvents ⊇ CoreEvents — cast is safe
    )
    ```
  - [ ] In `processStory()`, locate the point where the story is about to be marked `COMPLETE` after a SHIP_IT verdict. Before the `updateStory(storyKey, { phase: 'COMPLETE', ... })` call, insert:
    ```typescript
    // -- Tier A verification pipeline (Story 51-5) --
    if (config.skipVerification !== true) {
      const verifContext = assembleVerificationContext({
        storyKey,
        workingDir: projectRoot ?? process.cwd(),
        reviewResult: latestReviewSignals,    // ReviewSignals from code review dispatch
        outputTokenCount: devOutputTokenCount, // from dev-story dispatch token usage
      })
      const verifSummary = await verificationPipeline.run(verifContext, 'A')
      verificationStore.set(storyKey, verifSummary)
      if (verifSummary.status === 'fail') {
        updateStory(storyKey, { phase: 'VERIFICATION_FAILED', completedAt: new Date().toISOString() })
        persistStoryState(storyKey, _stories.get(storyKey)!).catch((err) =>
          logger.warn({ err, storyKey }, 'StateStore write failed after verification-failed'),
        )
        await writeStoryMetricsBestEffort(storyKey, 'verification-failed', reviewCycles)
        await persistState()
        return  // do NOT mark as COMPLETE
      }
      // warn or pass — fall through to COMPLETE
    }
    ```
  - [ ] For `latestReviewSignals`: extract `ReviewSignals` from the code review dispatch result after the SHIP_IT branch is reached. The `runCodeReview()` result should have `dispatchFailed`, `error`, and `rawOutput` fields — map them to `ReviewSignals`. If the fields are not directly on the result, set `reviewResult: undefined` (PhantomReviewCheck handles missing reviewResult gracefully)
  - [ ] For `devOutputTokenCount`: extract `result.tokenUsage?.output ?? result.tokens?.output` from the last successful `runDevStory()` result. If not available, pass `undefined`
  - [ ] Run `npm run build` — confirm zero TypeScript errors in all modified files

- [ ] Task 5: Write unit tests (AC: #7)
  - [ ] Create `src/modules/implementation-orchestrator/__tests__/verification-integration.test.ts`
  - [ ] Import: `import { assembleVerificationContext, VerificationStore } from '../verification-integration.js'`
  - [ ] Mock `node:child_process`:
    ```typescript
    vi.mock('node:child_process', () => ({ execSync: vi.fn() }))
    import { execSync } from 'node:child_process'
    const mockExecSync = vi.mocked(execSync)
    ```
  - [ ] Test cases (minimum 8):
    1. `assembleVerificationContext` — storyKey, workingDir, timeout in returned context
    2. `assembleVerificationContext` — commitSha from mocked `execSync` return value
    3. `assembleVerificationContext` — commitSha falls back to `'unknown'` when `execSync` throws
    4. `assembleVerificationContext` — reviewResult and outputTokenCount forwarded when provided
    5. `VerificationStore.set/get` — round-trip stores and retrieves summary by storyKey
    6. `VerificationStore.getAll` — returns a ReadonlyMap with all set entries
    7. `assembleVerificationContext` — reviewResult and outputTokenCount are `undefined` when omitted
    8. `VerificationStore.get` — returns `undefined` for unknown storyKey
  - [ ] Minimum 8 `it(...)` cases; verify: `grep -c "it(" src/modules/implementation-orchestrator/__tests__/verification-integration.test.ts`

- [ ] Task 6: Build and run tests (AC: #7)
  - [ ] Run `npm run build`; confirm zero TypeScript errors in new and modified files
  - [ ] Run `npm run test:fast` with `timeout: 300000`; confirm "Test Files" summary line shows the new test file green with zero failures
  - [ ] NEVER pipe test output through `tail`, `head`, `grep`, or any filtering command

## Dev Notes

### Architecture Constraints
- All imports of sdlc types/classes must use the package name `'@substrate-ai/sdlc'` — never relative paths from `src/` into `packages/sdlc/src/`
- All relative imports within `src/` MUST use `.js` extensions (ESM)
- The `VerificationPipeline` constructor accepts `TypedEventBus<SdlcEvents>`. The monolith's `eventBus` is typed as `TypedEventBus` (CoreEvents). Cast it: `eventBus as TypedEventBus<SdlcEvents>`. This is safe because `SdlcEvents` is a superset of `CoreEvents` and the additional verification events are only emitted (not subscribed to via monolith listeners)
- **No LLM calls** — the verification integration module is pure orchestration; `VerificationPipeline` handles all static analysis (FR-V9)
- `'VERIFICATION_FAILED'` is a **terminal phase** — no retry, no rework. The orchestrator moves to the next story
- `WgStoryStatus` does not have a `'failed'` value; map `'VERIFICATION_FAILED'` → `'escalated'` in `wgStatusForPhase()`. Do NOT add new `WgStoryStatus` values in this story
- **In-memory only**: `VerificationStore` holds results in a `Map`. Do NOT write to Dolt, SQLite, or any file system in this story — that is Epic 52 (story 52-7) scope

### Locating the SHIP_IT Integration Point
The `processStory()` function contains a code-review retry loop. The SHIP_IT path exits the loop and marks the story complete. The verification hook goes between the SHIP_IT check and the `updateStory(storyKey, { phase: 'COMPLETE' })` call. A reliable anchor:

```bash
grep -n "SHIP_IT\|'COMPLETE'" src/modules/implementation-orchestrator/orchestrator-impl.ts
```

Look for the block that:
1. Checks `verdict === 'SHIP_IT'`
2. Emits `orchestrator:story-complete`
3. Calls `updateStory(storyKey, { phase: 'COMPLETE', ... })`

Insert the verification block **between** steps 2 and 3, or alternatively between the verdict check and step 2 (either position preserves correctness since `verification:story-complete` is emitted by the pipeline itself).

### ReviewSignals From Code Review Result
After a SHIP_IT verdict, the variable holding the `runCodeReview()` result is available. Map it to `ReviewSignals`:
```typescript
const latestReviewSignals: ReviewSignals | undefined = codeReviewResult != null
  ? {
      dispatchFailed: (codeReviewResult as { dispatchFailed?: boolean }).dispatchFailed,
      error: (codeReviewResult as { error?: string }).error,
      rawOutput: (codeReviewResult as { rawOutput?: string }).rawOutput,
    }
  : undefined
```
If the shape doesn't match, set `reviewResult: undefined` — `PhantomReviewCheck` returns `'pass'` with a skip note when `reviewResult` is absent.

### Output Token Count Extraction
The `runDevStory()` result carries token usage. The exact field path varies by dispatch implementation. Try:
```typescript
const devOutputTokenCount: number | undefined =
  devResult?.tokenUsage?.output ??
  devResult?.tokens?.output ??
  undefined
```
Pass `undefined` if unavailable — `TrivialOutputCheck` returns `'warn'` gracefully.

### Failure Handling for `VERIFICATION_FAILED`
The `VERIFICATION_FAILED` phase should:
1. NOT call `updateStory` with `phase: 'COMPLETE'`
2. NOT emit `orchestrator:story-complete` (that event signals a successful run to consumers)
3. DO call `updateStory` with `phase: 'VERIFICATION_FAILED'`
4. DO call `persistStoryState` (best-effort, fire-and-forget)
5. DO call `writeStoryMetricsBestEffort(storyKey, 'verification-failed', reviewCycles)`
6. DO call `await persistState()` to flush
7. DO `return` immediately — do not fall through to COMPLETE

### New File Paths
```
src/modules/implementation-orchestrator/verification-integration.ts          — VerificationStore + context assembly
src/modules/implementation-orchestrator/__tests__/verification-integration.test.ts  — unit tests (≥8 cases)
```

### Modified File Paths
```
src/modules/implementation-orchestrator/types.ts          — add 'VERIFICATION_FAILED' to StoryPhase, skipVerification to OrchestratorConfig
src/modules/implementation-orchestrator/orchestrator-impl.ts  — hook pipeline into processStory(), add wgStatusForPhase case
src/cli/commands/run.ts                                    — add --skip-verification flag, wire into OrchestratorConfig
```

## Interface Contracts

- **Import**: `VerificationContext`, `VerificationSummary`, `ReviewSignals` @ `packages/sdlc/src/verification/types.ts` (from story 51-1)
- **Import**: `createDefaultVerificationPipeline` @ `packages/sdlc/src/verification/verification-pipeline.ts` (from story 51-1, pre-wired with checks from stories 51-2 through 51-4)
- **Export**: `VerificationStore` @ `src/modules/implementation-orchestrator/verification-integration.ts` (consumed by story 52-7 for run manifest persistence)
- **Export**: `assembleVerificationContext` @ `src/modules/implementation-orchestrator/verification-integration.ts` (testable helper; consumed by story 51-6 for event logging context)
- **Export**: `'VERIFICATION_FAILED'` phase @ `src/modules/implementation-orchestrator/types.ts` (consumed by story 54-x for recovery and completion report generation)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-04-05 | Initial story created for Epic 51 Phase D |
