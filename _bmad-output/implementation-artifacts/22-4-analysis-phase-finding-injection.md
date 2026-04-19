# Story 22-4: Analysis-Phase Finding Injection

Status: review

## Story

As a pipeline user running substrate on an established project,
I want prior run findings (implementation issues, escalations, recurring patterns) injected into the analysis phase prompts,
so that the analysis agent produces a product brief that is informed by real implementation experience from previous runs rather than reasoning from the concept alone.

## Acceptance Criteria

### AC1: Multi-step path — prior findings injected into step-1-vision when available
**Given** prior run findings (story outcomes, operational findings, escalation diagnoses, story metrics) exist in the decision store
**When** `runAnalysisPhase()` is called and the methodology pack manifest defines analysis steps (multi-step path)
**Then** the assembled `analysis-step-1-vision` prompt contains the prior findings text returned by `getProjectFindings()`

### AC2: Multi-step path — no orphaned placeholder when store is empty
**Given** no prior run findings exist in the decision store
**When** the analysis phase runs via the multi-step path
**Then** the `{{prior_findings}}` placeholder is replaced with an empty string and the prompt contains no orphaned `{{...}}` text

### AC3: Single-dispatch path — prior findings appended when available
**Given** prior run findings exist in the decision store and the single-dispatch path is active (no manifest steps defined, or amendment context present)
**When** `runAnalysisPhase()` executes the single-dispatch path
**Then** the assembled analysis prompt includes a `--- PRIOR RUN FINDINGS ---` framing block containing the findings text

### AC4: Single-dispatch path — graceful fallback when no findings
**Given** no prior run findings exist in the decision store
**When** the analysis phase runs via the single-dispatch path
**Then** no prior findings block is added to the prompt; the phase proceeds normally and returns `result: success`

### AC5: Token budget compliance for single-dispatch path
**Given** prior run findings text is longer than the remaining token budget allows
**When** the analysis phase injects findings on the single-dispatch path
**Then** findings are truncated to fit within the `MAX_PROMPT_TOKENS` ceiling (rather than causing a `prompt_too_long` failure), and a `[TRUNCATED]` marker is appended to the truncated content

### AC6: `getProjectFindings` reuse — no duplication of query logic
**Given** prior run findings need to be retrieved for analysis prompt injection
**When** the analysis phase implementation queries prior findings
**Then** it calls the existing `getProjectFindings(db)` function from `src/modules/implementation-orchestrator/project-findings.ts`, not a duplicate implementation

### AC7: `analysis-step-1-vision.md` template updated with `{{prior_findings}}` placeholder
**Given** the multi-step analysis path resolves context into the `analysis-step-1-vision.md` prompt template
**When** the template is loaded and `prior_findings` is non-empty
**Then** the `{{prior_findings}}` placeholder in the template is replaced with the findings content; the template's Mission section instructs the agent to use findings as grounding context when available

## Tasks / Subtasks

- [x] Task 1: Update `packs/bmad/prompts/analysis-step-1-vision.md` to add `{{prior_findings}}` placeholder (AC7)
  - [x] Add `### Prior Run Findings\n{{prior_findings}}` section after the `### Research Context` block
  - [x] Add one sentence to the Mission section: "When Prior Run Findings are provided, use them as grounding context — recurring implementation patterns indicate where the concept underestimated complexity."

- [x] Task 2: Update `buildAnalysisSteps()` in `src/modules/phase-orchestrator/phases/analysis.ts` to inject `prior_findings` param into step-1-vision context (AC1, AC2)
  - [x] Add `{ placeholder: 'prior_findings', source: 'param:prior_findings' }` to step-1-vision's `context` array (after `research_findings` entry)

- [x] Task 3: Update `runAnalysisMultiStep()` in `src/modules/phase-orchestrator/phases/analysis.ts` to query and pass `prior_findings` (AC1, AC2, AC6)
  - [x] Import `getProjectFindings` at the top of `analysis.ts` from `'../../../modules/implementation-orchestrator/project-findings.js'`
  - [x] Before calling `runSteps(...)`, call `getProjectFindings(deps.db)` wrapped in try/catch (empty string on error)
  - [x] Add `prior_findings: priorFindings` to the params object passed to `runSteps`

- [x] Task 4: Add prior findings injection to the single-dispatch path in `runAnalysisPhase()` (AC3, AC4, AC5, AC6)
  - [x] Add constants `PRIOR_FINDINGS_HEADER`, `PRIOR_FINDINGS_FOOTER` near the existing `AMENDMENT_CONTEXT_*` constants
  - [x] After the `{{concept}}` replacement, call `getProjectFindings(db)` wrapped in try/catch
  - [x] If findings are non-empty, calculate available chars (`MAX_PROMPT_TOKENS * 4 - prompt.length - framing.length - TRUNCATED_MARKER.length`); truncate if needed; append framing block to `prompt`
  - [x] Place findings injection BEFORE the amendment context injection so amendment context can override/supplement

- [x] Task 5: Write unit tests for single-dispatch findings injection in `src/modules/phase-orchestrator/phases/__tests__/analysis.test.ts` (AC3, AC4, AC5)
  - [x] Add a capture-dispatcher helper or adapt the existing test setup to intercept the `prompt` argument passed to `dispatcher.dispatch()`
  - [x] Test: findings present → prompt contains `--- PRIOR RUN FINDINGS ---` header and findings text
  - [x] Test: no findings (empty DB) → prompt does NOT contain `--- PRIOR RUN FINDINGS ---`
  - [x] Test: oversized findings → prompt does NOT fail with `prompt_too_long`; prompt contains `[TRUNCATED]` marker
  - [x] Test: `getProjectFindings` throws → phase still returns `result: success` (graceful fallback)

- [x] Task 6: Write unit tests for multi-step findings injection in `src/modules/phase-orchestrator/phases/__tests__/analysis-multistep.test.ts` (AC1, AC2)
  - [x] Extend the existing capture-dispatcher pattern (or add new describe block) to seed operational/outcome decisions and verify they appear in the step-1-vision assembled prompt
  - [x] Test: findings present in DB → assembled step-1-vision prompt contains findings text
  - [x] Test: empty DB → assembled step-1-vision prompt does NOT contain orphaned `{{prior_findings}}` or findings-specific text

- [x] Task 7: Run test suite and confirm no regressions (AC1–AC7)
  - [x] Run: `npx vitest run --no-coverage -- "analysis"` (targeted run)
  - [x] Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` (full suite, 80% coverage enforced)

## Dev Notes

### Architecture Constraints
- All imports use `.js` extension (ESM): `import { getProjectFindings } from '../../../modules/implementation-orchestrator/project-findings.js'`
- `getProjectFindings(db)` is already used in `src/modules/compiled-workflows/dev-story.ts` — follow that exact import and call pattern
- Do NOT add a new source type to `resolveContext()` in `step-runner.ts`; use the existing `param:prior_findings` mechanism (Story 22-1 dependency is met — the findings function already exists)
- The `buildAnalysisSteps()` function is private to `analysis.ts` — no public API changes required
- The single-dispatch path token budget: `MAX_PROMPT_TOKENS = 2_500`. Findings truncation must leave budget for amendment context too. Guard: `const availableForFindings = maxPromptChars - prompt.length - framingLen - TRUNCATED_MARKER.length; if (availableForFindings > 0) { ... }`
- Findings injection order in single-dispatch: FINDINGS block → AMENDMENT CONTEXT block → token budget check. This ensures amendment context code (which uses `prompt.length` as base) naturally accounts for any injected findings.

### Key File Paths
- `src/modules/phase-orchestrator/phases/analysis.ts` — primary implementation file
- `packs/bmad/prompts/analysis-step-1-vision.md` — template for multi-step step-1
- `src/modules/phase-orchestrator/phases/__tests__/analysis.test.ts` — existing single-dispatch tests
- `src/modules/phase-orchestrator/phases/__tests__/analysis-multistep.test.ts` — existing multi-step tests
- `src/modules/implementation-orchestrator/project-findings.ts` — reuse, do not duplicate

### Testing Requirements
- Framework: Vitest (NOT jest)
- Use capture-dispatcher pattern to intercept the `prompt` string passed to `dispatcher.dispatch()` — see `src/modules/phase-orchestrator/__tests__/analysis-research-context.test.ts` for the exact pattern
- Seed decisions using `createDecision(db, { pipeline_run_id: runId, phase: 'implementation', category: 'story-outcome', key: '...' , value: JSON.stringify({ outcome: 'complete', reviewCycles: 3, verdictHistory: ['NEEDS_MINOR_FIXES', 'SHIP_IT'], recurringPatterns: ['missing error handling'] }) })` to trigger findings output
- The `STORY_OUTCOME`, `OPERATIONAL_FINDING` constants are in `src/persistence/schemas/operational.ts`
- Run only relevant tests during development: `npx vitest run --no-coverage -- "analysis"`
- Final validation: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3`

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Used `vi.mock` to control `getProjectFindings` in tests rather than real DB seeding — cleaner for truncation/throws tests
- Mock path `'../../../implementation-orchestrator/project-findings.js'` (3 levels up from `__tests__/` to `modules/`)
- Import in `analysis.ts` uses `'../../../modules/implementation-orchestrator/project-findings.js'` (goes to `src/` then back to `modules/`) per spec
- Added `makeCaptureDispatcher` helper to `analysis-multistep.test.ts` following the same pattern as `analysis-research-context.test.ts`
- All 4511 tests pass (175 test files, 6 new tests added)

### File List
- /Users/John.Planow/code/jplanow/substrate/packs/bmad/prompts/analysis-step-1-vision.md
- /Users/John.Planow/code/jplanow/substrate/src/modules/phase-orchestrator/phases/analysis.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/phase-orchestrator/phases/__tests__/analysis.test.ts
- /Users/John.Planow/code/jplanow/substrate/src/modules/phase-orchestrator/phases/__tests__/analysis-multistep.test.ts

## Change Log
