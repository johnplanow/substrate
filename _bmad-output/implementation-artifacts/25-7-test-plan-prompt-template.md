# Story 25-7: Test-Plan Prompt Template for bmad Pack

Status: review

## User Story

As a pipeline operator,
I want a test-plan prompt template in the bmad methodology pack,
so that dev agents follow a structured test strategy instead of writing tests ad-hoc with inconsistent coverage.

## Background

The bmad pack currently has no `test-plan` prompt template. Every pipeline run logs a warning: "Methodology pack bmad has no prompt for task type test-plan". The test-plan phase silently skips every time, and dev agents write tests ad-hoc — resulting in inconsistent coverage (e.g., 40% statement coverage on judge-agent in the v0.2.29 run).

The pipeline's test-plan compiled workflow at `src/modules/compiled-workflows/test-plan.ts` already supports a `test-plan` task type. It looks up the prompt from the methodology pack, assembles context (story file, architecture constraints), and dispatches to an LLM agent. The output is then passed to the dev-story agent as the `{{test_plan}}` section. All that's missing is the prompt template itself.

## Acceptance Criteria

### AC1: Test-Plan Prompt Template Exists
**Given** the bmad methodology pack
**When** the pipeline looks up the `test-plan` task type prompt
**Then** a `test-plan.md` prompt template exists at `packs/bmad/prompts/test-plan.md`

### AC2: Structured Test Strategy Output
**Given** the test-plan prompt is dispatched to an LLM agent
**When** the agent follows the prompt
**Then** the output includes: critical paths to cover, dependencies to mock, error conditions to assert, and coverage targets

### AC3: Test Plan Passed to Dev-Story
**Given** a test plan has been generated
**When** the dev-story prompt is assembled
**Then** the test plan content is injected into the `{{test_plan}}` placeholder

### AC4: No More Warning in Pipeline Logs
**Given** the test-plan prompt template exists
**When** the pipeline runs
**Then** the "Methodology pack bmad has no prompt for task type test-plan" warning is no longer emitted

## Dev Notes

- Create `packs/bmad/prompts/test-plan.md` — this is the only required file
- The prompt should accept `{{story_content}}` and `{{architecture_constraints}}` placeholders (these are what the test-plan compiled workflow injects)
- The output should follow the `TestPlanResultSchema` defined in `src/modules/compiled-workflows/schemas.ts`: result, test_strategy, critical_paths, mock_dependencies, error_conditions, coverage_targets
- Register the prompt in `packs/bmad/manifest.yaml` under the `prompts` section with task type `test-plan`
- Check `src/modules/compiled-workflows/test-plan.ts` to see exactly how the prompt is loaded and what placeholders it uses

## Tasks

- [x] Task 1: Create test-plan prompt template (AC: #1, #2)
  - [x] Create `packs/bmad/prompts/test-plan.md`
  - [x] Include sections for: critical paths, mock dependencies, error conditions, coverage targets
  - [x] Use `{{story_content}}` and `{{architecture_constraints}}` placeholders
  - [x] Include YAML output contract matching `TestPlanResultSchema`
- [x] Task 2: Register test-plan prompt in pack manifest (AC: #1, #4)
  - [x] Add `test-plan` entry to `packs/bmad/manifest.yaml` prompts section
  - [x] Verify the pack loader finds the prompt for task type `test-plan`
- [x] Task 3: Write tests verifying prompt registration and content (AC: #1, #3, #4)
  - [x] Test: pack loader returns a prompt for `test-plan` task type
  - [x] Test: prompt template contains expected placeholders
  - [x] Test: prompt output contract matches `TestPlanResultSchema` field names

## Files Modified
- `packs/bmad/prompts/test-plan.md` (pre-existing, verified correct)
- `packs/bmad/manifest.yaml` (added `test-plan` entry to prompts section)
- `src/modules/compiled-workflows/__tests__/test-plan-prompt-registration.test.ts` (new — 16 tests)
