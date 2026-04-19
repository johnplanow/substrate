# Story 53-11: File-Scope Guardrail in Code Review

## Story

As a substrate developer,
I want the code review step to flag files the dev agent modified outside the story spec's declared scope,
so that over-implementation (scope creep) is surfaced as a review finding before the story is shipped.

## Acceptance Criteria

### AC1: Scope Compliance Section in Prompt Template
**Given** the code review prompt template at `packs/bmad/prompts/code-review.md`
**When** the prompt is rendered for any code review dispatch
**Then** it includes a "Scope Compliance" dimension instructing the reviewer to (1) identify the expected file list from the story spec's "Key File Paths" and "Tasks / Subtasks" sections, (2) compare that list against files present in the git diff, and (3) record any files created or modified outside that set as `scope-creep` findings in the `issue_list`
**And** the instructions explicitly state that test files (`*.test.ts`, `*.spec.ts`, `__tests__/` paths) are exempt from scope checking

### AC2: Scope-Creep Finding for Unexpected Created Files
**Given** a dev agent that creates a non-test source file not mentioned in the story spec's "Key File Paths" or "Tasks / Subtasks" sections
**When** the code review evaluates scope compliance
**Then** the `issue_list` in the review output contains an entry with `category: "scope-creep"`, `severity: "minor"`, and a description identifying the unexpected file path

### AC3: Scope-Creep Finding for Unexpected Modified Files
**Given** a dev agent that modifies a non-test file not mentioned in the story spec
**When** the code review evaluates scope compliance
**Then** the `issue_list` contains an entry with `category: "scope-creep"` and `severity: "minor"` identifying the file path
**And** the entry is distinct from functional issues found in other review dimensions

### AC4: Test Files Are Unconditionally Exempt
**Given** a dev agent that creates test files (paths matching `*.test.ts`, `*.spec.ts`, or containing `__tests__/` or `__mocks__/`)
**When** the scope compliance check is evaluated
**Then** those test files are never flagged as scope creep, regardless of whether they appear in the story spec

### AC5: Advisory-Only — Scope Creep Does Not Alter Verdict Alone
**Given** a code review where the only issues found are `scope-creep` category entries
**When** the prompt instructs the reviewer to determine the final verdict
**Then** the verdict is SHIP_IT or LGTM_WITH_NOTES (if no other functional issues exist)
**And** scope-creep findings do not independently trigger NEEDS_MINOR_FIXES or NEEDS_MAJOR_REWORK

### AC6: ScopeGuardrail Utility Parses Expected File Set
**Given** a story file's raw text content
**When** `ScopeGuardrail.parseExpectedFiles(storyContent: string)` is called
**Then** it returns a `Set<string>` of file paths extracted from the "### File Paths to Create", "### File Paths to Modify", "Key File Paths" sections, and path-like strings (containing `/` and a recognized extension) in "Tasks / Subtasks" bullet points
**And** the parsing is whitespace-tolerant and handles both backtick-wrapped and plain file paths

### AC7: Pre-Computed Scope Analysis Injected as Context Section
**Given** the code review workflow assembling its context sections
**When** the `scope_analysis` section is computed from `ScopeGuardrail.buildAnalysis(storyContent, filesModified)`
**Then** the returned markdown string lists: (a) the expected file set from the story spec, (b) the actual files in the diff, and (c) the computed delta — files not in the expected set, with test files already filtered
**And** this pre-computed `scope_analysis` section is injected into the prompt at `priority: 'optional'` so the LLM reviewer does not need to re-parse the spec sections manually

## Tasks / Subtasks

- [x] Task 1: Update code-review.md prompt template with Scope Compliance dimension (AC: #1, #4, #5)
  - [x] Open `packs/bmad/prompts/code-review.md` and add a "Scope Compliance" review dimension after the existing 5 dimensions (AC Validation, AC-to-Test Traceability, Task Audit, Code Quality, Test Quality)
  - [x] The new dimension instructs the reviewer to: identify expected files from the story spec's "Key File Paths", "File Paths to Create", "File Paths to Modify", and "Tasks / Subtasks" sections; compare against the git diff file list; and flag unexpected non-test files as `scope-creep` findings with `severity: minor`
  - [x] Add explicit exemption language: "Test files (paths containing `.test.ts`, `.spec.ts`, `__tests__/`, or `__mocks__/`) are always exempt from scope checking — do not flag them"
  - [x] Add advisory language: "Scope-creep findings are informational. If the only issues found are scope-creep entries, the verdict is SHIP_IT or LGTM_WITH_NOTES, not NEEDS_MINOR_FIXES"
  - [x] Add a `scope_analysis` context injection placeholder (e.g., `<!-- scope_analysis -->`) so the pre-computed delta can be injected if available
  - [x] Verify the `issue_list` YAML output schema documentation in the prompt already supports `category` field (add it if missing: `category: scope-creep`)

- [x] Task 2: Implement ScopeGuardrail utility (AC: #6, #7)
  - [x] Create `src/modules/compiled-workflows/scope-guardrail.ts`
  - [x] Export `class ScopeGuardrail` with two static methods:
    - `parseExpectedFiles(storyContent: string): Set<string>` — extracts file paths from the story spec
    - `buildAnalysis(storyContent: string, filesModified: string[]): string` — returns a formatted markdown string for the `scope_analysis` context section
  - [x] `parseExpectedFiles` implementation: scan the raw story text for lines under sections named "Key File Paths", "File Paths to Create", "File Paths to Modify", and path-like strings in "Tasks / Subtasks" bullets. A path-like string is any token containing `/` and a file extension (e.g., `.ts`, `.md`, `.json`, `.js`, `.py`). Strip backtick wrappers and leading `- ` list markers.
  - [x] `buildAnalysis` implementation: call `parseExpectedFiles`, compute the delta (actual files not in expected set), filter out test file paths (`isTestFile` helper using same patterns as `countTestMetrics` in `code-review.ts`), and format as: "Expected files (from spec): ...\nActual files (from diff): ...\nOut-of-scope files (excluding tests): ...". Return empty string if delta is empty (no scope violations detected).
  - [x] Export a `isTestFile(path: string): boolean` helper function from the same file for use by tests

- [x] Task 3: Wire ScopeGuardrail into the code review workflow (AC: #7)
  - [x] In `src/modules/compiled-workflows/code-review.ts`, import `ScopeGuardrail` from `./scope-guardrail.js`
  - [x] After `countTestMetrics` is computed (around line 272), add: `const scopeAnalysisContent = storyContent && filesModified ? ScopeGuardrail.buildAnalysis(storyContent, filesModified) : ''`
  - [x] Log at `debug` level if scope violations were found: `if (scopeAnalysisContent) logger.debug({ storyKey }, 'Scope analysis detected out-of-scope files')`
  - [x] Add the new section to the `sections` array (after `test_metrics`): `{ name: 'scope_analysis', content: scopeAnalysisContent, priority: 'optional' as const }`
  - [x] Verify the `assemblePrompt` call is unchanged — it already handles optional sections gracefully

- [x] Task 4: Unit tests — ScopeGuardrail (AC: #6, #4)
  - [x] Create `src/modules/compiled-workflows/__tests__/scope-guardrail.test.ts`
  - [x] Test `parseExpectedFiles`: a story with a "### File Paths to Create" section containing `src/foo/bar.ts` returns that path in the set
  - [x] Test `parseExpectedFiles`: paths in "Tasks / Subtasks" bullets (e.g., `` `packages/core/src/adapters/types.ts` ``) are also extracted
  - [x] Test `parseExpectedFiles`: non-path strings (plain text, headers, markdown with no `/`) are not returned
  - [x] Test `buildAnalysis` with no violations: when `filesModified` is a subset of expected files, returns empty string
  - [x] Test `buildAnalysis` with violations: when an unexpected file appears in `filesModified`, the returned string names it under "Out-of-scope files"
  - [x] Test `buildAnalysis` exempts test files: `src/foo/__tests__/bar.test.ts` in `filesModified` is never listed in the out-of-scope section, even if not in the expected set
  - [x] Test `isTestFile`: `.test.ts`, `.spec.ts`, `__tests__/bar.ts`, `__mocks__/foo.ts` all return `true`; `src/foo/bar.ts` returns `false`

- [x] Task 5: Unit tests — code-review workflow scope_analysis injection (AC: #7)
  - [x] Add test cases to `src/modules/compiled-workflows/__tests__/code-review-scope.test.ts` (new focused test file)
  - [x] Test: when `storyContent` includes a "File Paths to Create" section and `filesModified` is provided, the assembled prompt contains the `scope_analysis` section header with the pre-computed analysis
  - [x] Test: when no out-of-scope files are detected, the `scope_analysis` section is empty and `assemblePrompt` omits it (optional sections with empty content are dropped)
  - [x] Test: when `storyContent` is empty or undefined, `buildAnalysis` is skipped gracefully (no crash)
  - [x] Use the existing mock dispatcher pattern in `code-review.test.ts` — do not make real agent dispatches

## Dev Notes

### Architecture Constraints
- **Package placement**: `ScopeGuardrail` goes in `src/modules/compiled-workflows/scope-guardrail.ts` — this is a presentation/assembly concern tied to the compiled workflow, not a core package type. Do NOT place it in `packages/core/` or `packages/sdlc/`.
- **No changes to the `CodeReviewParams` or `CodeReviewResult` types**: the scope check is purely a prompt-assembly concern. The `issue_list` field already exists on `CodeReviewResult` and can carry scope-creep findings generated by the LLM.
- **Import rules**: `scope-guardrail.ts` must not import from `packages/sdlc/`, `packages/core/`, or any database/persistence layer. It takes plain strings and returns plain strings — pure utility.
- **Exemption pattern consistency**: the test-file exemption in `isTestFile()` must use the same patterns as the existing `countTestMetrics` function in `code-review.ts` (checks for `.test.`, `.spec.`, `__tests__`). Add `__mocks__/` as well.
- **Prompt template is advisory**: the scope compliance dimension in the prompt template MUST be described as advisory. Never use language that would cause the LLM to escalate a SHIP_IT to NEEDS_MINOR_FIXES solely because of scope-creep entries.
- **Empty-string short-circuit**: `buildAnalysis` returns `''` (empty string) when no violations are found. The `assemblePrompt` function already skips optional sections with empty content — rely on this behavior, do not add special-case logic in `code-review.ts`.
- **Prompt placeholder**: use the established `<!-- scope_analysis -->` XML-comment style placeholder in the prompt template (check how other optional sections like `<!-- prior_findings -->` are marked up in the template and follow the same pattern).

### Testing Requirements
- Test runner: `vitest` via `npm run test:fast` — all new test files are auto-discovered
- Use `describe` / `it` naming convention throughout
- `scope-guardrail.test.ts` tests the utility class in isolation — no mocks needed (pure string I/O)
- The code-review workflow tests mock the dispatcher — do NOT invoke real agent processes
- Test fixtures (story content strings) should be defined inline in the test file, not as external fixture files

### File Paths to Create
- `src/modules/compiled-workflows/scope-guardrail.ts`
- `src/modules/compiled-workflows/__tests__/scope-guardrail.test.ts`

### File Paths to Modify
- `packs/bmad/prompts/code-review.md` — add Scope Compliance dimension and `scope_analysis` placeholder
- `src/modules/compiled-workflows/code-review.ts` — import `ScopeGuardrail`, compute and inject `scope_analysis` section

## Dev Agent Record

### Agent Model Used
claude-sonnet-4-5

### Completion Notes List
- All 5 tasks completed. 31 new tests added (26 for ScopeGuardrail utility, 5 for code-review workflow injection).
- Pre-existing test failures in packages/sdlc/src/__tests__/parity-test.ts (reviewCycles count) are unrelated to this story.
- Build passes with zero type errors.

### File List
- `packs/bmad/prompts/code-review.md` (modified)
- `src/modules/compiled-workflows/code-review.ts` (modified)
- `src/modules/compiled-workflows/scope-guardrail.ts` (created)
- `src/modules/compiled-workflows/__tests__/scope-guardrail.test.ts` (created)
- `src/modules/compiled-workflows/__tests__/code-review-scope.test.ts` (created)

## Change Log
