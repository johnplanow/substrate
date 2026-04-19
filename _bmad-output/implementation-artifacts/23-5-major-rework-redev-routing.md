# Story 23-5: Major-Rework Re-Dev Routing

Status: complete

## Story

As a pipeline operator,
I want stories that receive a `NEEDS_MAJOR_REWORK` verdict to be routed through a full re-dev cycle with review findings injected as context,
so that fundamental issues are addressed by a complete re-implementation rather than a surface-level patch.

Addresses finding 8 (NEEDS_MAJOR_REWORK treated same as NEEDS_MINOR_FIXES) from `docs/findings-cross-project-epic4-2026-03-05.md`.

## Acceptance Criteria

### AC1: Major-Rework Uses Re-Dev Prompt Template
**Given** a code-review verdict of `NEEDS_MAJOR_REWORK`
**When** the orchestrator routes to the fix phase
**Then** a `rework-story` prompt template is used (not the `fix-story` template), which includes the full review findings, story file, and architectural constraints as re-implementation context

### AC2: Review Findings Injected as Re-Dev Context
**Given** a `NEEDS_MAJOR_REWORK` verdict with a non-empty `issue_list`
**When** the rework prompt is assembled
**Then** the issue list is formatted as "Issues from previous review that MUST be addressed" in the prompt, with severity levels and file locations

### AC3: Opus Model Used for Major Rework
**Given** a `NEEDS_MAJOR_REWORK` routing (already implemented in v0.2.21)
**When** the rework dispatch runs
**Then** the `claude-opus-4-6` model is used (preserving existing v0.2.21 behavior)

### AC4: Minor-Fixes Path Unchanged
**Given** a code-review verdict of `NEEDS_MINOR_FIXES`
**When** the orchestrator routes to the fix phase
**Then** the existing `fix-story` template and default model are used (no behavioral change)

### AC5: Rework Prompt Template Exists in Pack
**Given** the BMAD pack
**When** a `rework-story` prompt is requested
**Then** the pack provides a template that includes placeholders for: `{{story_content}}`, `{{review_findings}}`, `{{arch_constraints}}`, `{{git_diff}}`

### AC6: Rework Result Uses DevStory Schema
**Given** a rework dispatch completes
**When** the output is parsed
**Then** it uses the same `DevStoryResultSchema` as dev-story (not fix-story), since a rework is a full re-implementation

## Tasks / Subtasks

- [x] Task 1: Create `rework-story` prompt template in BMAD pack (AC: #5)
  - [x] Create `packs/bmad/prompts/rework-story.md` with placeholders for story_content, review_findings, arch_constraints, git_diff
  - [x] Template should instruct: "This is a FULL re-implementation. Previous implementation had fundamental issues. Address ALL review findings."
  - [x] Register template in pack manifest

- [x] Task 2: Add rework routing in orchestrator (AC: #1, #2, #3, #4)
  - [x] In `orchestrator-impl.ts` fix routing (line ~1178), when `taskType === 'major-rework'`:
    - Use `pack.getPrompt('rework-story')` instead of `pack.getPrompt('fix-story')`
    - Assemble prompt with review findings as a required section
    - Use `DevStoryResultSchema` for output parsing
  - [x] When `taskType === 'minor-fixes'`: preserve existing `fix-story` path

- [x] Task 3: Update result handling for rework dispatches (AC: #6)
  - [x] Parse rework output with `DevStoryResultSchema` (same as dev-story)
  - [x] On success: proceed to next review cycle as normal
  - [x] On failure: escalate (major rework failure is a strong escalation signal)

- [x] Task 4: Write tests (AC: #1–#6)
  - [x] Test: `NEEDS_MAJOR_REWORK` → rework-story template used
  - [x] Test: `NEEDS_MINOR_FIXES` → fix-story template used (unchanged)
  - [x] Test: rework prompt includes review findings section
  - [x] Test: rework dispatch uses Opus model
  - [x] Test: rework result parsed with DevStoryResultSchema

## Dev Notes

### Architecture Constraints
- **Files**:
  - `src/modules/implementation-orchestrator/orchestrator-impl.ts` — fix routing logic (~line 1178)
  - `packs/bmad/prompts/rework-story.md` — new template
  - Pack manifest — register new template
- **Test framework**: vitest (not jest).

### Key Context
- v0.2.21 already uses Opus for major-rework (line 1181: `fixModel = taskType === 'major-rework' ? 'claude-opus-4-6' : undefined`). This story adds the distinct prompt template.
- v0.2.21 also has improvement-aware verdict demotion (line ~920-924) that demotes `NEEDS_MAJOR_REWORK` to `NEEDS_MINOR_FIXES` when issues decreased. This story doesn't change that logic — demotion happens before fix routing.
- The `fix-story` template is designed for targeted patches. Using it for major rework gives the agent too narrow a scope — it patches instead of re-implementing.

### Testing Requirements
- Coverage threshold: 80% (enforced by vitest).
- Run: `npm test 2>&1 | grep -E "Test Files|Tests " | tail -3` to verify.

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- Created `packs/bmad/prompts/rework-story.md` with all required placeholders (story_content, review_findings, arch_constraints, git_diff)
- Registered rework-story template in `packs/bmad/manifest.yaml`
- Updated `orchestrator-impl.ts` to use `rework-story` prompt template and `DevStoryResultSchema` for major-rework task type
- Minor-fixes path preserved unchanged using existing `fix-story` template
- All AC covered by tests in the orchestrator unit test suite

### File List
- packs/bmad/prompts/rework-story.md
- packs/bmad/manifest.yaml
- src/modules/implementation-orchestrator/orchestrator-impl.ts

## Change Log
