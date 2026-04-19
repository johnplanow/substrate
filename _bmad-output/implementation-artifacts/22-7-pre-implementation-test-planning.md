# Story 22-7: Pre-Implementation Test Planning

Status: review

## Story

As a pipeline engineer,
I want a test plan generated per-story immediately after story creation and before dev-story begins,
so that the dev-story agent implements tests guided by a structured, AC-driven plan rather than improvising coverage.

## Acceptance Criteria

### AC1: `runTestPlan()` dispatches sub-agent and returns a typed result
**Given** a story file exists at `storyFilePath` and a `test-plan.md` prompt template is available in the pack
**When** `runTestPlan(deps, { storyKey, storyFilePath })` is called
**Then** it dispatches a sub-agent with the story content assembled into the test-plan prompt, validates the output against `TestPlanResultSchema`, and returns a `TestPlanResult` with `result: 'success'`, `test_files: string[]`, `test_categories: string[]`, and `coverage_notes: string`

### AC2: Test plan is stored in the decision store
**Given** `runTestPlan()` receives a valid `TestPlanResult` from the sub-agent
**When** the workflow completes successfully
**Then** the plan is persisted to the decision store with `phase='implementation'`, `category=TEST_PLAN` (the new constant), `key=storyKey`, and `value=JSON.stringify({ test_files, test_categories, coverage_notes })`

### AC3: Dev-story injects test plan when available
**Given** a `test-plan` decision exists in the decision store for the current `storyKey`
**When** `runDevStory()` assembles the prompt
**Then** the assembled prompt contains a `## Test Plan` section listing the planned test files, categories, and coverage notes, replacing the generic default Vitest patterns when a plan is present

### AC4: Dev-story graceful fallback when no test plan exists
**Given** no `test-plan` decision exists in the decision store for the current `storyKey`
**When** `runDevStory()` assembles the prompt
**Then** the prompt is assembled without a `## Test Plan` section and the existing default Vitest patterns are used instead — no error is thrown

### AC5: Orchestrator calls `runTestPlan()` between create-story and dev-story
**Given** create-story has completed successfully and a `storyFilePath` is available
**When** the orchestrator processes a story
**Then** `runTestPlan()` is invoked with the story key and file path before any `runDevStory()` dispatch begins, and the story phase is set to `IN_TEST_PLANNING` during test planning

### AC6: Test planning failure is non-blocking
**Given** `runTestPlan()` dispatch fails (bad exit code, timeout, or schema validation failure)
**When** the orchestrator processes the story
**Then** the failure is logged as a warning (not an error), `runDevStory()` still runs using default test patterns, and the story is NOT escalated due to the test-plan failure alone

### AC7: `TestPlanResultSchema` validates the expected output shape
**Given** a sub-agent returns a YAML block with `result`, `test_files`, `test_categories`, and `coverage_notes`
**When** the output is parsed against `TestPlanResultSchema`
**Then** `result` is one of `success | failed`, `test_files` and `test_categories` are arrays of strings, and `coverage_notes` is a string; missing optional fields default gracefully

## Tasks / Subtasks

- [x] Task 1: Add `TEST_PLAN` constant to `src/persistence/schemas/operational.ts` (AC: #2)
  - [x] Add `export const TEST_PLAN = 'test-plan' as const` with JSDoc comment describing the category purpose
  - [x] Document key schema: `{storyKey}`, value shape: `{ test_files: string[], test_categories: string[], coverage_notes: string }`

- [x] Task 2: Add `TestPlanResultSchema`, `TestPlanParams`, `TestPlanResult` to `schemas.ts` and `types.ts` (AC: #1, #7)
  - [x] In `src/modules/compiled-workflows/schemas.ts`: add `TestPlanResultSchema` — `result: z.preprocess(val => val === 'failure' ? 'failed' : val, z.enum(['success', 'failed']))`, `test_files: z.array(z.string()).default([])`, `test_categories: z.array(z.string()).default([])`, `coverage_notes: z.string().default('')`
  - [x] Export `TestPlanSchemaOutput = z.infer<typeof TestPlanResultSchema>` from `schemas.ts`
  - [x] In `src/modules/compiled-workflows/types.ts`: add `TestPlanParams` interface (`storyKey: string`, `storyFilePath: string`, `pipelineRunId?: string`) and `TestPlanResult` interface (`result: 'success' | 'failed'`, `test_files: string[]`, `test_categories: string[]`, `coverage_notes: string`, `error?: string`, `tokenUsage: { input: number, output: number }`)

- [x] Task 3: Create `packs/bmad/prompts/test-plan.md` prompt template (AC: #7)
  - [x] Include mission statement: "Analyze the story's Acceptance Criteria and tasks. Produce a concrete test plan listing the test files to create, the test categories to cover (unit/integration/e2e), and a brief note on AC coverage."
  - [x] Include `{{story_content}}` placeholder for story injection
  - [x] Include Output Contract section specifying the exact YAML shape the agent must emit:
    ```yaml
    result: success
    test_files:
      - src/modules/foo/__tests__/foo.test.ts
    test_categories:
      - unit
      - integration
    coverage_notes: "AC1 covered by foo.test.ts describe('runFoo'). AC2 covered by..."
    ```
  - [x] Keep prompt under ~1,500 tokens to minimize cost (lightweight planning call)

- [x] Task 4: Create `src/modules/compiled-workflows/test-plan.ts` implementing `runTestPlan()` (AC: #1, #2, #6)
  - [x] Import `readFile` from `node:fs/promises`, `WorkflowDeps`, `TestPlanParams`, `TestPlanResult` from `./types.js`, `TestPlanResultSchema` from `./schemas.js`, `assemblePrompt` from `./prompt-assembler.js`, `createDecision` from `../../persistence/queries/decisions.js`, `TEST_PLAN` from `../../persistence/schemas/operational.js`, `createLogger` from `../../utils/logger.js`
  - [x] Set `TOKEN_CEILING = 8_000` and `DEFAULT_TIMEOUT_MS = 300_000` (5 min — lightweight call)
  - [x] Step 1: `deps.pack.getPrompt('test-plan')` — return failure on error
  - [x] Step 2: `readFile(storyFilePath, 'utf-8')` — return failure on ENOENT/read error
  - [x] Step 3: Assemble prompt via `assemblePrompt(template, [{ name: 'story_content', content: storyContent, priority: 'required' }], TOKEN_CEILING)`
  - [x] Step 4: Dispatch via `deps.dispatcher.dispatch({ prompt, agent: 'claude-code', taskType: 'test-plan', timeout: DEFAULT_TIMEOUT_MS, outputSchema: TestPlanResultSchema, ...(deps.projectRoot ? { workingDirectory: deps.projectRoot } : {}) })`
  - [x] Step 5: On `status === 'timeout'` or `status === 'failed'` or `parsed === null`, return failure result
  - [x] Step 6: On success, call `createDecision(deps.db, { pipeline_run_id: params.pipelineRunId, phase: 'implementation', category: TEST_PLAN, key: storyKey, value: JSON.stringify({ test_files: parsed.test_files, test_categories: parsed.test_categories, coverage_notes: parsed.coverage_notes }), rationale: \`Test plan for ${storyKey}: ${parsed.test_files.length} test files, categories: ${parsed.test_categories.join(', ')}\` })`
  - [x] Step 7: Return typed `TestPlanResult` with tokenUsage

- [x] Task 5: Export new symbols from `src/modules/compiled-workflows/index.ts` (AC: #1)
  - [x] Add `export { runTestPlan } from './test-plan.js'`
  - [x] Add `TestPlanParams`, `TestPlanResult` to the types re-export block
  - [x] Add `TestPlanResultSchema` to the schemas re-export block
  - [x] Add `TestPlanSchemaOutput` to the schema types re-export block

- [x] Task 6: Update `runDevStory()` in `src/modules/compiled-workflows/dev-story.ts` to inject test plan (AC: #3, #4)
  - [x] Import `getDecisionsByCategory` from `../../persistence/queries/decisions.js` (already imported) and `TEST_PLAN` from `../../persistence/schemas/operational.js`
  - [x] After the `testPatternsContent` block (around line 149-168), add a new block that queries the test plan:
    ```typescript
    let testPlanContent = ''
    try {
      const allTestPlans = getDecisionsByCategory(deps.db, TEST_PLAN)
      const planDecision = allTestPlans.find((d) => d.key === storyKey)
      if (planDecision) {
        const plan = JSON.parse(planDecision.value)
        testPlanContent = [
          '## Test Plan',
          '',
          '**Test Files to Create:**',
          ...(plan.test_files ?? []).map((f: string) => `- ${f}`),
          '',
          '**Test Categories:** ' + (plan.test_categories ?? []).join(', '),
          '',
          '**Coverage Notes:** ' + (plan.coverage_notes ?? ''),
        ].join('\n')
      }
    } catch { /* graceful fallback */ }
    ```
  - [x] Add `{ name: 'test_plan', content: testPlanContent, priority: 'optional' }` to the `sections` array (after `test_patterns`, before `prior_findings`)
  - [x] When `testPlanContent` is non-empty, override `testPatternsContent` to only the framework/tooling guidance (not the full default), so the injected plan doesn't double up with patterns

- [x] Task 7: Update `orchestrator-impl.ts` to call `runTestPlan()` between create-story and dev-story (AC: #5, #6)
  - [x] Add `import { runTestPlan } from '../compiled-workflows/test-plan.js'` at top of `orchestrator-impl.ts`
  - [x] Add `IN_TEST_PLANNING` to `StoryPhase` union in `src/modules/implementation-orchestrator/types.ts`
  - [x] In `processStory()`, after the `storyFilePath` is established (line ~550, before `// -- dev-story phase --`), insert test planning block:
    ```typescript
    // -- test-plan phase --
    await waitIfPaused()
    if (_state !== 'RUNNING') return
    startPhase(storyKey, 'test-plan')
    updateStory(storyKey, { phase: 'IN_TEST_PLANNING' as StoryPhase })
    persistState()
    try {
      await runTestPlan(
        { db, pack, contextCompiler, dispatcher, projectRoot },
        { storyKey, storyFilePath, pipelineRunId: config.pipelineRunId },
      )
      logger.info({ storyKey }, 'Test plan generated successfully')
    } catch (err) {
      logger.warn({ storyKey, err }, 'Test planning failed — proceeding to dev-story without test plan')
    }
    endPhase(storyKey, 'test-plan')
    ```
  - [x] Emit `orchestrator:story-phase-complete` event after the test-plan phase (optional, best-effort — same pattern as create-story)

- [x] Task 8: Write unit tests (AC: #1–#7)
  - [x] Create `src/modules/compiled-workflows/__tests__/test-plan.test.ts`:
    - [x] Mock `deps.pack.getPrompt` to return a minimal template string
    - [x] Mock `deps.dispatcher.dispatch` to return a success parse result with `test_files: ['src/foo/__tests__/foo.test.ts']`, `test_categories: ['unit']`, `coverage_notes: 'AC1 covered'`
    - [x] Mock `createDecision` (via `vi.mock('../../persistence/queries/decisions.js', ...)`)
    - [x] Test: success path → `result === 'success'`, `createDecision` called with `category=TEST_PLAN`, `key=storyKey`
    - [x] Test: dispatch returns `status: 'failed'` → `result === 'failed'`, `createDecision` NOT called
    - [x] Test: dispatch returns `status: 'timeout'` → `result === 'failed'`, `createDecision` NOT called
    - [x] Test: story file not found (ENOENT) → `result === 'failed'`, error contains 'story_file_not_found'
    - [x] Test: `createDecision` throws → `result === 'success'` still returned (best-effort storage)
  - [x] Add test-plan injection tests to `src/modules/compiled-workflows/__tests__/dev-story.test.ts` (or create `dev-story-test-plan.test.ts`):
    - [x] Use `vi.mock` on `getDecisionsByCategory` to return a test-plan decision for the current storyKey
    - [x] Capture assembled prompt via capture-dispatcher pattern (see analysis-research-context.test.ts for the pattern)
    - [x] Test: test plan present → prompt contains `## Test Plan` and the test file names
    - [x] Test: test plan absent (empty array from mock) → prompt does NOT contain `## Test Plan`
  - [x] Run: `npx vitest run --no-coverage -- "test-plan"` (targeted run)
  - [x] Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` (full suite)

## Dev Notes

### Architecture Constraints
- **ESM imports**: All local imports use `.js` extension — e.g., `import { runTestPlan } from './test-plan.js'`
- **Test framework**: Vitest (NOT jest — `--testPathPattern` does not work, use `-- "pattern"`)
- **DI pattern**: `runTestPlan()` receives `WorkflowDeps` — do NOT import `better-sqlite3` directly in `test-plan.ts`
- **Decision store**: Use `createDecision()` (not `upsertDecision()`) — each pipeline run produces a fresh test plan decision; no need to upsert
- **Token budget for test-plan.md**: Keep the prompt template lightweight (~400-600 tokens). The story content adds ~2,000-4,000 tokens. Stay under `TOKEN_CEILING = 8_000`.
- **`TEST_PLAN` constant location**: `src/persistence/schemas/operational.ts` — import it in both `test-plan.ts` (to write) and `dev-story.ts` (to read)
- **`IN_TEST_PLANNING` StoryPhase**: Add to `types.ts` union — non-breaking addition; no consumers enumerate the full set

### Key File Paths
- `src/modules/compiled-workflows/test-plan.ts` — new compiled workflow (primary implementation)
- `packs/bmad/prompts/test-plan.md` — new prompt template
- `src/modules/compiled-workflows/schemas.ts` — add `TestPlanResultSchema`, `TestPlanSchemaOutput`
- `src/modules/compiled-workflows/types.ts` — add `TestPlanParams`, `TestPlanResult`
- `src/modules/compiled-workflows/index.ts` — add exports
- `src/modules/compiled-workflows/dev-story.ts` — inject test plan section (after testPatternsContent block)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — call `runTestPlan()` in `processStory()`
- `src/modules/implementation-orchestrator/types.ts` — add `IN_TEST_PLANNING` to `StoryPhase`
- `src/persistence/schemas/operational.ts` — add `TEST_PLAN` constant
- `src/modules/compiled-workflows/__tests__/test-plan.test.ts` — new tests

### Patterns to Follow
- **`runTestPlan()` structure**: Mirrors `runDevStory()` closely — same token-ceiling pattern, same dispatch/validate/return flow. Use `dev-story.ts` as the implementation reference.
- **`makeFailureResult` helper**: Define a local `makeTestPlanFailureResult(error: string): TestPlanResult` following the same pattern as `makeFailureResult` in `dev-story.ts`
- **Dev-story injection**: The `TEST_PLAN` query in `dev-story.ts` lives in the same region as the `testPatternsContent` block (~lines 149-168). The `test_plan` section goes AFTER `test_patterns` in the `sections` array. When `testPlanContent` is non-empty, consider setting `testPatternsContent` to a condensed version (just the framework line + no-full-suite warning) to avoid redundancy.
- **Capture-dispatcher pattern for tests**: See `src/modules/phase-orchestrator/__tests__/analysis-research-context.test.ts` — the pattern captures the `prompt` argument passed to `dispatcher.dispatch()` for assertion.
- **`getDecisionsByCategory` mock path** in test-plan.test.ts: `'../../persistence/queries/decisions.js'` (from `src/modules/compiled-workflows/__tests__/`)

### Testing Requirements
- Framework: Vitest with `vi.mock()`, `vi.fn()`, `describe`/`it`/`expect`
- Coverage threshold: 80% enforced — run full suite before marking done
- Targeted run during development: `npx vitest run --no-coverage -- "test-plan"`
- Final validation: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3`
- Do NOT run `npm test` repeatedly — run targeted tests until ready, then validate once

### Output Contract for `test-plan.md` Prompt
The agent must emit YAML matching `TestPlanResultSchema`. Include this exact contract in the prompt:
```yaml
result: success
test_files:
  - src/modules/<module>/__tests__/<file>.test.ts
test_categories:
  - unit
  - integration
coverage_notes: "Brief description of which ACs each test file covers."
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
