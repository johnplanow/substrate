# Story 43.5: SDLC Code-Review Handler

## Story

As a graph engine consumer,
I want a `sdlc.code-review` node handler that wraps the existing `runCodeReview()` compiled workflow,
so that the graph-based SDLC pipeline can route story execution to `exit` on SHIP_IT or back to `dev_story` on NEEDS_FIXES based on the three-way review verdict.

## Acceptance Criteria

### AC1: SHIP_IT and LGTM_WITH_NOTES Verdicts Map to SUCCESS
**Given** `runCodeReview()` returns a result with `verdict === 'SHIP_IT'` or `verdict === 'LGTM_WITH_NOTES'`
**When** the handler maps the result
**Then** it returns `{ status: 'SUCCESS', preferredLabel: 'SHIP_IT', contextUpdates: { codeReviewVerdict, codeReviewIssues, codeReviewIssueList } }`

### AC2: NEEDS_MINOR_FIXES and NEEDS_MAJOR_REWORK Verdicts Map to FAILURE with NEEDS_FIXES Label
**Given** `runCodeReview()` returns a result with `verdict === 'NEEDS_MINOR_FIXES'` or `verdict === 'NEEDS_MAJOR_REWORK'`
**When** the handler maps the result
**Then** it returns `{ status: 'FAILURE', preferredLabel: 'NEEDS_FIXES', failureReason: '<verdict>: <n> issue(s)', contextUpdates: { codeReviewVerdict, codeReviewIssues, codeReviewIssueList } }`

### AC3: Dispatch Failure Maps to Escalation
**Given** `runCodeReview()` returns a result with `dispatchFailed === true`
**When** the handler processes the result
**Then** it returns `{ status: 'FAILURE', failureReason: 'escalation: code-review dispatch failed: <result.error>' }` with no `contextUpdates` written

### AC4: Missing Required Context Fields Return FAILURE Without Calling runCodeReview
**Given** the graph context is missing `storyKey` or `storyFilePath`
**When** the handler validates required fields at entry
**Then** it returns `{ status: 'FAILURE', failureReason: 'Missing required context: storyKey, storyFilePath' }` without invoking `runCodeReview()`

### AC5: Optional Context Fields Are Passed Through to runCodeReview
**Given** the graph context contains `filesModified` (string[]), `pipelineRunId` (string), and/or `codeReviewIssueList` (CodeReviewIssue[]) from a prior review cycle
**When** the handler builds the `CodeReviewParams`
**Then** it passes `filesModified` as `params.filesModified`, `pipelineRunId` as `params.pipelineRunId`, and prior `codeReviewIssueList` as `params.previousIssues` for scoped re-review

### AC6: Telemetry Events Emitted Before and After Execution
**Given** the handler is invoked (any path — success, failure, or exception)
**When** execution begins and after `runCodeReview()` resolves or throws
**Then** it emits `orchestrator:story-phase-start` before calling `runCodeReview()` and `orchestrator:story-phase-complete` in a `finally` block with `{ storyKey, phase: 'code-review', status, verdict? }`

### AC7: Handler Exported from Package Barrel
**Given** the implementation is complete
**When** consumers import from `@substrate-ai/sdlc`
**Then** `createSdlcCodeReviewHandler` is exported from `packages/sdlc/src/handlers/sdlc-code-review-handler.ts` and re-exported from `packages/sdlc/src/handlers/index.ts`

## Tasks / Subtasks

- [ ] Task 1: Define local structural types and injectable interfaces (AC: #1, #4)
  - [ ] Define minimal local interfaces for `GraphNode`, `IGraphContext`, `Graph`, `Outcome`, `OutcomeStatus` — no cross-package imports (ADR-003)
  - [ ] Define injectable `CodeReviewParams` and `CodeReviewResult` types matching monolith signatures (or import from `src/modules/compiled-workflows/types` at composition root)
  - [ ] Define `RunCodeReviewFn` injectable type: `(deps: unknown, params: CodeReviewParams) => Promise<CodeReviewResult>`
  - [ ] Define `SdlcCodeReviewHandlerOptions` interface: `{ deps: unknown, eventBus: TypedEventBus<SdlcEvents>, runCodeReview: RunCodeReviewFn }`

- [ ] Task 2: Implement context extraction and validation (AC: #4, #5)
  - [ ] Extract `storyKey` (string, required) and `storyFilePath` (string, required) from context; return FAILURE immediately if either is missing (AC4)
  - [ ] Extract optional fields: `pipelineRunId` (string|undefined), `filesModified` (string[]|undefined), `codeReviewIssueList` (CodeReviewIssue[]|undefined)
  - [ ] Build `CodeReviewParams` with required + optional fields; map `codeReviewIssueList` to `params.previousIssues` (AC5)

- [ ] Task 3: Implement verdict mapping logic (AC: #1, #2, #3)
  - [ ] Emit `orchestrator:story-phase-start` event before calling `runCodeReview()` (AC6)
  - [ ] Call `runCodeReview(deps, params)` inside try/catch
  - [ ] Short-circuit on `dispatchFailed === true` → return escalation FAILURE with `'escalation: code-review dispatch failed: <error>'` (AC3)
  - [ ] Map `SHIP_IT` and `LGTM_WITH_NOTES` → `{ status: 'SUCCESS', preferredLabel: 'SHIP_IT', contextUpdates }` (AC1)
  - [ ] Map `NEEDS_MINOR_FIXES` and `NEEDS_MAJOR_REWORK` → `{ status: 'FAILURE', preferredLabel: 'NEEDS_FIXES', failureReason: '<verdict>: <n> issue(s)', contextUpdates }` (AC2)
  - [ ] Handle unexpected throws → `{ status: 'FAILURE', failureReason: error.message }`
  - [ ] Include `contextUpdates: { codeReviewVerdict, codeReviewIssues, codeReviewIssueList }` on all non-escalation/non-dispatch-failed outcomes

- [ ] Task 4: Implement telemetry finally block and error boundary (AC: #6)
  - [ ] Capture `outcome` variable before finally block so the finally clause always has a status to emit
  - [ ] Emit `orchestrator:story-phase-complete` in `finally` with `{ storyKey, phase: 'code-review', status: outcome.status, verdict: codeReviewVerdict }`
  - [ ] Ensure finally block fires even when `runCodeReview()` throws

- [ ] Task 5: Write unit tests (AC: #1–#7)
  - [ ] Create `packages/sdlc/src/handlers/__tests__/sdlc-code-review-handler.test.ts`
  - [ ] Test: `SHIP_IT` verdict → SUCCESS with `preferredLabel: 'SHIP_IT'` and correct contextUpdates
  - [ ] Test: `LGTM_WITH_NOTES` verdict → SUCCESS with `preferredLabel: 'SHIP_IT'` (treated same as SHIP_IT)
  - [ ] Test: `NEEDS_MINOR_FIXES` verdict → FAILURE with `preferredLabel: 'NEEDS_FIXES'` and failureReason containing issue count
  - [ ] Test: `NEEDS_MAJOR_REWORK` verdict → FAILURE with `preferredLabel: 'NEEDS_FIXES'`
  - [ ] Test: `dispatchFailed: true` → FAILURE with `failureReason` starting with `'escalation:'`, no contextUpdates written
  - [ ] Test: missing `storyKey` → FAILURE without calling `runCodeReview`
  - [ ] Test: missing `storyFilePath` → FAILURE without calling `runCodeReview`
  - [ ] Test: optional context pass-through — `filesModified`, `pipelineRunId`, `codeReviewIssueList` forwarded correctly as `params.filesModified`, `params.pipelineRunId`, `params.previousIssues`
  - [ ] Test: telemetry events emitted in correct order (start before call, complete in finally)
  - [ ] Test: `orchestrator:story-phase-complete` emitted even when `runCodeReview()` throws unexpectedly

- [ ] Task 6: Export handler from package barrel and run build (AC: #7)
  - [ ] Export `createSdlcCodeReviewHandler` and `SdlcCodeReviewHandlerOptions` from `packages/sdlc/src/handlers/index.ts`
  - [ ] Verify sdlc package top-level barrel (`packages/sdlc/src/index.ts`) re-exports from `handlers/index.ts`
  - [ ] Run `npm run build` from monorepo root — zero TypeScript errors, no circular dependencies
  - [ ] Run `npm run test:fast` — all new tests pass, no regressions

## Dev Notes

### Architecture Constraints

- **ADR-003 (no cross-package coupling)**: All factory/graph engine types (`GraphNode`, `IGraphContext`, `Graph`, `Outcome`, `OutcomeStatus`) must be defined locally as minimal structural interfaces. Do NOT import from `@substrate-ai/factory` at compile time. The handler is compatible via duck typing.
- **Injectable `runCodeReview`**: The factory function receives `RunCodeReviewFn` as a dependency so it can be mocked in tests. The CLI composition root (`src/cli/commands/run.ts`) injects the real implementation from the monolith at startup.
- **Import real `runCodeReview`** only from the monolith path: `src/modules/compiled-workflows/code-review` — this is a composition root concern, not the handler's.
- **`preferredLabel` on Outcome**: The graph engine's edge selector uses `outcome.preferredLabel` to match the DOT edge `label` attribute. The `SdlcOutcome` type (from story 43-2) must include `preferredLabel?: string`. Add this field if not already present.
- **`OutcomeStatus` values**: `'SUCCESS' | 'PARTIAL_SUCCESS' | 'FAILURE' | 'NEEDS_RETRY' | 'ESCALATE'` — do NOT use `'FAIL'`.
- **TypedEventBus** — import from `@substrate-ai/core` (same as create-story and dev-story handlers).

### File Paths

- **New file**: `packages/sdlc/src/handlers/sdlc-code-review-handler.ts`
- **New test**: `packages/sdlc/src/handlers/__tests__/sdlc-code-review-handler.test.ts`
- **Modify**: `packages/sdlc/src/handlers/index.ts` — add exports for `createSdlcCodeReviewHandler` and `SdlcCodeReviewHandlerOptions`
- **`runCodeReview` source**: `src/modules/compiled-workflows/code-review.ts`
- **`CodeReviewResult`/`CodeReviewParams`/`CodeReviewIssue` types**: `src/modules/compiled-workflows/types.ts`

### Verdict Mapping Reference

| `runCodeReview` verdict | `dispatchFailed` | Outcome `status` | `preferredLabel` | Context updates written? |
|---|---|---|---|---|
| `SHIP_IT` | false | `SUCCESS` | `'SHIP_IT'` | Yes |
| `LGTM_WITH_NOTES` | false | `SUCCESS` | `'SHIP_IT'` | Yes |
| `NEEDS_MINOR_FIXES` | false | `FAILURE` | `'NEEDS_FIXES'` | Yes |
| `NEEDS_MAJOR_REWORK` | false | `FAILURE` | `'NEEDS_FIXES'` | Yes |
| any | true | `FAILURE` | (omit) | No |
| throws | — | `FAILURE` | (omit) | No |

### Implementation Pattern

Mirror the structure of `sdlc-dev-story-handler.ts` (Story 43-4):

```typescript
// Local structural interfaces (no @substrate-ai/factory imports)
interface GraphNode { id: string; label: string; prompt: string }
interface IGraphContext {
  getString(key: string, defaultValue?: string): string
  getList?(key: string): string[]
}
interface Graph {}
type OutcomeStatus = 'SUCCESS' | 'FAILURE' | 'PARTIAL_SUCCESS' | 'NEEDS_RETRY' | 'ESCALATE'
interface Outcome {
  status: OutcomeStatus
  failureReason?: string
  contextUpdates?: Record<string, unknown>
  preferredLabel?: string
  notes?: string
}
type NodeHandler = (node: GraphNode, context: IGraphContext, graph: Graph) => Promise<Outcome>

interface CodeReviewParams {
  storyKey: string
  storyFilePath: string
  pipelineRunId?: string
  filesModified?: string[]
  previousIssues?: Array<{ severity?: string; description?: string; file?: string; line?: number }>
}
interface CodeReviewResult {
  verdict: 'SHIP_IT' | 'NEEDS_MINOR_FIXES' | 'NEEDS_MAJOR_REWORK' | 'LGTM_WITH_NOTES'
  issues: number
  issue_list: Array<{ severity: string; description: string; file?: string; line?: number }>
  error?: string
  dispatchFailed?: boolean
  tokenUsage: { input: number; output: number }
}
type RunCodeReviewFn = (deps: unknown, params: CodeReviewParams) => Promise<CodeReviewResult>

export interface SdlcCodeReviewHandlerOptions {
  deps: unknown
  eventBus: TypedEventBus<SdlcEvents>
  runCodeReview: RunCodeReviewFn
}

export function createSdlcCodeReviewHandler(options: SdlcCodeReviewHandlerOptions): NodeHandler {
  return async (_node, context, _graph): Promise<Outcome> => {
    const storyKey = context.getString('storyKey')
    const storyFilePath = context.getString('storyFilePath')
    if (!storyKey || !storyFilePath) {
      return { status: 'FAILURE', failureReason: 'Missing required context: storyKey, storyFilePath' }
    }
    // ... extract optional context, build params, emit start, call runCodeReview, map verdict, emit complete in finally
  }
}
```

### Context Keys Reference

| Key (read from context) | Type | Description |
|---|---|---|
| `storyKey` | string | Required. Story identifier (e.g., `43-5`) |
| `storyFilePath` | string | Required. Absolute path to story file on disk |
| `pipelineRunId` | string | Optional. Run ID for telemetry correlation |
| `filesModified` | string[] | Optional. Files modified by dev-story (for scoped git diff in code review) |
| `codeReviewIssueList` | CodeReviewIssue[] | Optional. Issue list from prior failed review cycle (passed as `previousIssues` for re-review) |

| Key (written to contextUpdates — non-escalation only) | Type | Description |
|---|---|---|
| `codeReviewVerdict` | string | e.g., `'SHIP_IT'`, `'NEEDS_MINOR_FIXES'` |
| `codeReviewIssues` | number | Total issue count from review result |
| `codeReviewIssueList` | CodeReviewIssue[] | Full issue list — persisted so retry cycle can pass as `previousIssues` |

### Telemetry Events

```typescript
// Before runCodeReview():
eventBus.emit('orchestrator:story-phase-start', { storyKey, phase: 'code-review', pipelineRunId })

// After runCodeReview() (in finally):
eventBus.emit('orchestrator:story-phase-complete', {
  storyKey,
  phase: 'code-review',
  status: outcome.status,
  verdict: codeReviewVerdict,  // may be undefined if dispatch failed or threw
  pipelineRunId,
})
```

### Testing Requirements

- **Framework**: Vitest (same as all sdlc package tests)
- **Mock pattern**: inject `runCodeReview` via `SdlcCodeReviewHandlerOptions.runCodeReview` — use `vi.fn()` in tests
- **Event bus mock**: use `vi.fn()` for `eventBus.emit`, verify call order (start emitted before complete)
- **Context mock**: implement minimal `IGraphContext` with `getString()` returning test values; add `getList()` for `filesModified` and `codeReviewIssueList`
- **Test file**: `packages/sdlc/src/handlers/__tests__/sdlc-code-review-handler.test.ts`
- **Run**: `npm run test:fast` from monorepo root; confirm zero failures

## Interface Contracts

- **Import**: `SdlcOutcome` @ `packages/sdlc/src/handlers/types.ts` (from story 43-2; extend with `preferredLabel?: string` if not present)
- **Import**: `SdlcEvents`, `TypedEventBus` @ `@substrate-ai/core` (event bus infrastructure)
- **Export**: `createSdlcCodeReviewHandler` @ `packages/sdlc/src/handlers/sdlc-code-review-handler.ts` (consumed by story 43-6 — handler registration)
- **Export**: `SdlcCodeReviewHandlerOptions` @ `packages/sdlc/src/handlers/sdlc-code-review-handler.ts` (consumed by story 43-6)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

- 2026-03-22: Story created for Epic 43, Phase A — SDLC Pipeline as Graph
