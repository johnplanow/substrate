# Story 22-9: Post-Implementation Test Expansion

Status: review

## Story

As a pipeline agent running automated implementations,
I want coverage gap analysis to run automatically after each story ships,
so that E2E and integration test gaps are identified and persisted for later action without blocking story delivery.

## Acceptance Criteria

### AC1: Test Expansion Triggers After SHIP_IT Verdict
**Given** a story has received a SHIP_IT code-review verdict in the orchestrator
**When** the orchestrator completes the story's review phase
**Then** `runTestExpansion()` is called with the story key, story file path, files modified by dev-story, working directory, and pipeline run ID; any error from `runTestExpansion` is caught and logged without altering the story's SHIP_IT state

### AC2: Prompt Assembles Story Content and Scoped Git Diff
**Given** a story file path and list of files modified by dev-story
**When** `runTestExpansion()` assembles the prompt
**Then** the prompt template receives story_content (priority=required, never truncated), git_diff scoped to modified files with stat-only fallback when oversized (priority=important), and arch_constraints from the solutioning-phase decision store (priority=optional); total prompt stays within a 20,000-token ceiling using `assemblePrompt()`

### AC3: Structured YAML Output with Coverage Gaps and Suggested Tests
**Given** the assembled prompt is dispatched to a sub-agent with `taskType: 'test-expansion'`
**When** the agent completes analysis
**Then** the agent emits YAML with: `expansion_priority` (low/medium/high), `coverage_gaps` (array of objects each with `ac_ref: string`, `description: string`, `gap_type: missing-e2e | missing-integration | unit-only`), `suggested_tests` (array with `test_name`, `test_type: e2e | integration | unit`, `description`, optional `target_ac`), and optional `notes`; the result is validated against `TestExpansionResultSchema`

### AC4: Result Persisted to Decision Store
**Given** `runTestExpansion()` returns any result — success or graceful fallback
**When** the orchestrator stores the result
**Then** the result JSON is persisted via `createDecision(db, { pipeline_run_id: pipelineRunId, phase: 'implementation', category: TEST_EXPANSION_FINDING, key: \`${storyKey}:${pipelineRunId}\`, value: JSON.stringify(expansionResult) })`; the constant `TEST_EXPANSION_FINDING = 'test-expansion-finding'` is defined in `src/persistence/schemas/operational.ts`

### AC5: Graceful Fallback on Dispatch Failure
**Given** the sub-agent dispatch fails, times out, or returns invalid / unparseable YAML
**When** `runTestExpansion()` encounters an error
**Then** it returns a result with `expansion_priority: 'low'`, `coverage_gaps: []`, `suggested_tests: []`, a non-empty `error` field, and valid `tokenUsage`; `runTestExpansion` never throws — all error paths return a typed result

### AC6: `TestExpansionResultSchema` and Types Are Correctly Defined
**Given** the Zod schema and TypeScript types are added to the compiled-workflows module
**When** `TestExpansionResultSchema.safeParse()` is called on agent output
**Then** `expansion_priority` coerces unknown enum values to 'low'; `coverage_gaps` and `suggested_tests` default to empty arrays when missing; the schema and types are exported from `src/modules/compiled-workflows/index.ts` alongside existing schema/type exports

## Tasks / Subtasks

- [x] Task 1: Add `TEST_EXPANSION_FINDING` constant to `src/persistence/schemas/operational.ts` (AC: #4)
  - [x] Add export with JSDoc documenting key schema `{storyKey}:{runId}` and value shape (expansion_priority, coverage_gaps, suggested_tests, notes, error?)
  - [x] Place after existing `STORY_OUTCOME` constant

- [x] Task 2: Add `TestExpansionResultSchema` to `src/modules/compiled-workflows/schemas.ts` (AC: #3, #6)
  - [x] Define `CoverageGapSchema`: `ac_ref: z.string()`, `description: z.string()`, `gap_type: z.enum(['missing-e2e', 'missing-integration', 'unit-only'])`
  - [x] Define `SuggestedTestSchema`: `test_name: z.string()`, `test_type: z.enum(['e2e', 'integration', 'unit'])`, `description: z.string()`, `target_ac: z.string().optional()`
  - [x] Define `TestExpansionResultSchema`: `expansion_priority: z.preprocess((val) => (['low','medium','high'].includes(val as string) ? val : 'low'), z.enum(['low', 'medium', 'high']))`, `coverage_gaps: z.array(CoverageGapSchema).default([])`, `suggested_tests: z.array(SuggestedTestSchema).default([])`, `notes: z.string().optional()`
  - [x] Export `TestExpansionSchemaOutput` type

- [x] Task 3: Add `TestExpansionParams` and `TestExpansionResult` to `src/modules/compiled-workflows/types.ts` (AC: #1, #3, #5)
  - [x] `TestExpansionParams`: `storyKey: string`, `storyFilePath: string`, `pipelineRunId?: string`, `filesModified?: string[]`, `workingDirectory?: string`
  - [x] `TestExpansionResult`: `expansion_priority: 'low' | 'medium' | 'high'`, `coverage_gaps: CoverageGap[]`, `suggested_tests: SuggestedTest[]`, `notes?: string`, `error?: string`, `tokenUsage: { input: number; output: number }`
  - [x] Define inline `CoverageGap` and `SuggestedTest` interfaces matching the Zod schema shapes
  - [x] Place after the `CodeReviewResult` section following existing file conventions

- [x] Task 4: Create prompt template `packs/bmad/prompts/test-expansion.md` (AC: #2, #3)
  - [x] Sections: Mission (identify gaps in E2E and integration coverage — unit tests alone are insufficient for pipeline confidence), Story Content (`{{story_content}}`), Git Changes (`{{git_diff}}`), Architecture Context (`{{arch_constraints}}`)
  - [x] Mission instructs agent to: (1) read each AC, (2) check if the git diff includes only unit tests for it, (3) flag ACs whose happy path is not exercised at the module-boundary or system level
  - [x] Output Contract: emit YAML exactly as: `expansion_priority`, `coverage_gaps` list, `suggested_tests` list, optional `notes`
  - [x] Include example YAML in Output Contract so the agent knows the exact shape

- [x] Task 5: Implement `runTestExpansion()` in `src/modules/compiled-workflows/test-expansion.ts` (AC: #2, #3, #5, #6)
  - [x] Signature: `export async function runTestExpansion(deps: WorkflowDeps, params: TestExpansionParams): Promise<TestExpansionResult>`
  - [x] Step 1: `deps.pack.getPrompt('test-expansion')` — on failure return graceful fallback (AC5)
  - [x] Step 2: `readFile(storyFilePath, 'utf-8')` — on failure return graceful fallback (AC5)
  - [x] Step 3: Query arch constraints using private `getArchConstraints(deps)` function — replicate the pattern from `code-review.ts` (`getDecisionsByPhase(deps.db, 'solutioning')` filtered to `category === 'architecture'`)
  - [x] Step 4: Get scoped git diff using `getGitDiffForFiles(filesModified, cwd)` with stat-only fallback via `getGitDiffStatSummary(cwd)` when token budget exceeded (AC2)
  - [x] Step 5: `assemblePrompt(template, sections, 20_000)` where sections=[story_content(required), git_diff(important), arch_constraints(optional)]
  - [x] Step 6: `dispatcher.dispatch({ prompt, agent: 'claude-code', taskType: 'test-expansion', outputSchema: TestExpansionResultSchema, workingDirectory: deps.projectRoot })`
  - [x] Step 7: `TestExpansionResultSchema.safeParse(dispatchResult.parsed)` — on parse failure return graceful fallback (AC5)
  - [x] Import `createLogger` from `../../utils/logger.js`; logger name `'compiled-workflows:test-expansion'`

- [x] Task 6: Export from index and integrate into orchestrator (AC: #1, #4)
  - [x] Add to `src/modules/compiled-workflows/index.ts`: `export { runTestExpansion } from './test-expansion.js'`, export `TestExpansionResultSchema`, `TestExpansionSchemaOutput`, `TestExpansionParams`, `TestExpansionResult`, `CoverageGap`, `SuggestedTest`
  - [x] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`: import `runTestExpansion` from `'../compiled-workflows/test-expansion.js'` and `TEST_EXPANSION_FINDING` from `'../../persistence/schemas/operational.js'`
  - [x] After the SHIP_IT branch where story is marked complete, add: call `runTestExpansion(workflowDeps, { storyKey, storyFilePath, pipelineRunId, filesModified, workingDirectory: projectRoot })` wrapped in try/catch
  - [x] Persist result: `createDecision(db, { pipeline_run_id: pipelineRunId ?? 'unknown', phase: 'implementation', category: TEST_EXPANSION_FINDING, key: \`${storyKey}:${pipelineRunId ?? 'unknown'}\`, value: JSON.stringify(expansionResult) })`
  - [x] Log expansion_priority and coverage_gaps count at debug level; log errors at warn level without re-throwing

- [x] Task 7: Write unit tests in `src/modules/compiled-workflows/__tests__/test-expansion.test.ts` (AC: #1–#6)
  - [x] Follow the exact mock setup from `code-review.test.ts`: `vi.hoisted()`, `vi.mock('node:fs/promises', ...)`, `vi.mock('../git-helpers.js', ...)`, `vi.mock('../../../utils/logger.js', ...)`
  - [x] Test: happy path — dispatch returns valid YAML → result has expansion_priority, populated coverage_gaps and suggested_tests
  - [x] Test: story_content never truncated even when git diff pushes near 20,000-token ceiling (verify sections priority ordering)
  - [x] Test: when filesModified provided and scoped diff exceeds budget → stat-only summary used
  - [x] Test: dispatch status='failed' → graceful fallback returned with error field, coverage_gaps=[]
  - [x] Test: dispatch returns unparseable YAML (parsed=null) → graceful fallback, tests pass
  - [x] Test: schema safeParse failure (missing required field) → graceful fallback
  - [x] Test: arch constraints from decision store injected into prompt sections
  - [x] Use `makeMockDeps` helper matching the pattern in `code-review.test.ts`

- [x] Task 8: Run test suite and confirm no regressions (AC: #1–#6)
  - [x] Run: `npx vitest run --no-coverage -- "test-expansion"` (targeted run first) — 16 tests pass
  - [x] Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` (full suite, 80% coverage enforced) — 178 files, 4564 tests pass
  - [x] Confirm test count is higher than before this story (new tests added)

## Dev Notes

### Architecture Constraints
- **Import style**: All local imports use `.js` extension (ESM): e.g., `import { runTestExpansion } from './test-expansion.js'`
- **Modular monolith pattern**: `runTestExpansion` follows identical structure to `runCodeReview` — WorkflowDeps injection, pack.getPrompt, readFile, assemblePrompt, dispatcher.dispatch, schema validation, typed return
- **Git diff helpers**: Reuse `getGitDiffForFiles` and `getGitDiffStatSummary` from `./git-helpers.js` — same import pattern as `code-review.ts`
- **Arch constraints**: Define a private `getArchConstraints(deps: WorkflowDeps): string` function in `test-expansion.ts` replicating the pattern from `code-review.ts` (query `getDecisionsByPhase(deps.db, 'solutioning')`, filter to `category === 'architecture'`) — do NOT extract to a shared module (out of scope)
- **Token budget**: TOKEN_CEILING = 20_000; use `assemblePrompt()` from `./prompt-assembler.js`; never truncate story_content
- **Decision store persistence**: Use `createDecision` from `../../persistence/queries/decisions.js`; `TEST_EXPANSION_FINDING` from `../../persistence/schemas/operational.js`
- **Non-blocking contract**: `runTestExpansion` MUST NOT throw — every error path returns a typed `TestExpansionResult` with graceful fallback values
- **Orchestrator contract**: test-expansion failure MUST NOT change story verdict or state; wrap the entire call in try/catch in `orchestrator-impl.ts`
- **taskType**: Use `'test-expansion'` in the dispatcher call (consistent with `'code-review'` and `'dev-story'` naming)

### Key File Paths
- `src/modules/compiled-workflows/test-expansion.ts` — new compiled workflow (primary implementation)
- `src/modules/compiled-workflows/schemas.ts` — add TestExpansionResultSchema, CoverageGapSchema, SuggestedTestSchema
- `src/modules/compiled-workflows/types.ts` — add TestExpansionParams, TestExpansionResult, CoverageGap, SuggestedTest
- `src/modules/compiled-workflows/index.ts` — export new workflow, schema, and types
- `src/modules/compiled-workflows/__tests__/test-expansion.test.ts` — new unit tests
- `packs/bmad/prompts/test-expansion.md` — new prompt template
- `src/persistence/schemas/operational.ts` — add TEST_EXPANSION_FINDING constant
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — invoke post-SHIP_IT (search for SHIP_IT verdict handling)

### Testing Requirements
- **Framework**: Vitest (NOT jest — `--testPathPattern` flag does not work, use `-- "pattern"`)
- **Mock pattern**: Follow `src/modules/compiled-workflows/__tests__/code-review.test.ts` exactly — use `vi.hoisted()` for mock fns, mock `node:fs/promises`, `../git-helpers.js`, `../../../utils/logger.js`, and the db's `.prepare().all()` chain
- **DB mock**: Mock `deps.db.prepare` to return `{ all: vi.fn().mockReturnValue([]) }` for arch constraints; seed with fake architecture decisions for the constraint-injection test
- **Coverage threshold**: 80% enforced — do not filter tests when running the final coverage check
- **Targeted development run**: `npx vitest run --no-coverage -- "test-expansion"`
- **Final validation**: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3`
- Do NOT add integration or E2E tests for this story — unit tests only (consistent with existing compiled-workflow tests)

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 8 tasks completed successfully
- 16 new unit tests added in test-expansion.test.ts
- Full test suite: 178 files, 4564 tests (all passing)
- runTestExpansion follows identical structure to runCodeReview (WorkflowDeps injection, graceful fallbacks, schema validation)
- Orchestrator integration: non-blocking post-SHIP_IT call with try/catch wrapping

### File List
- /Users/John.Planow/code/jplanow/substrate/src/persistence/schemas/operational.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/compiled-workflows/schemas.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/compiled-workflows/types.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/compiled-workflows/index.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/compiled-workflows/test-expansion.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/compiled-workflows/__tests__/test-expansion.test.ts
- /Users/John.Planow/code/jplanow/substrate/packs/bmad/prompts/test-expansion.md
- /Users/John.Planow/code/jplanow/substrate/src/modules/implementation-orchestrator/orchestrator-impl.ts

## Change Log
