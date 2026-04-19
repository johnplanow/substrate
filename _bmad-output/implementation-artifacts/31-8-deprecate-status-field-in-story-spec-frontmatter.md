# Story 31-8: Deprecate Status Field in Story Spec Frontmatter

Status: ready-for-dev

## Story

As the pipeline system,
I want the `Status:` field removed from story spec templates and stripped from spec content before agents see it,
so that story status is exclusively managed in the Dolt work graph (`wg_stories` table) and agents never interact with a stale, redundant status field.

## Acceptance Criteria

### AC1: Story spec template no longer includes the Status field
**Given** the story template at `packs/bmad/templates/story.md`
**When** a new story spec is generated from this template
**Then** the generated spec does NOT contain a `Status:` line — story status is tracked in `wg_stories.status`, not in the spec file

### AC2: create-story prompt no longer instructs agents to set Status
**Given** the create-story prompt at `packs/bmad/prompts/create-story.md`
**When** a create-story agent reads its instructions
**Then** the instruction "Status must be: `ready-for-dev`" is absent; in its place a note reads: "Do NOT add a `Status:` field — story status is managed by the Dolt work graph (`wg_stories` table)"

### AC3: `stripDeprecatedStatusField()` utility removes Status line from spec content
**Given** a story spec string containing a `Status: <value>` line (e.g. `Status: ready-for-dev`)
**When** `stripDeprecatedStatusField(content)` is called
**Then** the returned string does not contain the `Status:` line or its immediately following blank line; all other content is preserved unchanged; calling it on content without a Status field is a no-op

### AC4: dev-story workflow strips Status from spec content before prompt assembly
**Given** a story spec file containing `Status: ready-for-dev`
**When** the dev-story compiled workflow (`src/modules/compiled-workflows/dev-story.ts`) reads the spec and assembles the agent prompt
**Then** the `story_content` slot injected into the agent prompt does NOT contain the Status line — the dev agent receives only task-relevant spec content

### AC5: WARN log emitted when spec content contains a deprecated Status field
**Given** a story spec file that still contains a `Status:` line (generated before this story was implemented)
**When** the dev-story workflow reads and strips it
**Then** a WARN-level log entry is emitted containing the story file path and the stale status value (e.g. `staleStatus: 'ready-for-dev'`), making spec migration visible in pipeline logs

### AC6: create-story unit test mock updated to not include Status field
**Given** the test mock template in `src/modules/compiled-workflows/__tests__/create-story.test.ts` that currently includes `Status: draft`
**When** the unit tests run
**Then** the mock template string does not include `Status: draft`, mirroring the updated production template

## Tasks / Subtasks

- [ ] Task 1: Remove Status field from story spec template (AC: #1)
  - [ ] Edit `packs/bmad/templates/story.md`: remove the line `Status: draft` (line 3) and the blank line that immediately follows it (line 4)
  - [ ] Verify the resulting template retains all other sections intact: Story, Acceptance Criteria, Tasks / Subtasks, Dev Notes, Dev Agent Record, Change Log

- [ ] Task 2: Update create-story prompt to remove Status instruction (AC: #2)
  - [ ] Edit `packs/bmad/prompts/create-story.md`: locate the instruction line "Status must be: `ready-for-dev`" (currently in the Instructions section under item 6)
  - [ ] Replace it with: "Do NOT add a `Status:` field to the story file — story status is managed exclusively by the Dolt work graph (`wg_stories` table)"
  - [ ] Keep the change minimal; do not alter any surrounding instructions

- [ ] Task 3: Create `spec-migrator.ts` with utility functions (AC: #3)
  - [ ] Create `src/modules/work-graph/spec-migrator.ts` with two pure exported functions:
    ```typescript
    /**
     * Remove the deprecated `Status:` line from story spec content.
     * Also removes the blank line immediately following the Status line.
     * Returns the original content unchanged if no Status line is present.
     */
    export function stripDeprecatedStatusField(content: string): string {
      return content.replace(/^Status:[^\n]*\n(\n)?/m, (_, trailingBlank) =>
        trailingBlank !== undefined ? '' : ''
      )
    }

    /**
     * Detect whether a story spec contains the deprecated Status field.
     * Returns the status value string (e.g. 'ready-for-dev') if found, or null if absent.
     */
    export function detectDeprecatedStatusField(content: string): string | null {
      const match = /^Status:\s*(.+)$/m.exec(content)
      return match !== null ? match[1].trim() : null
    }
    ```
  - [ ] Export both functions from the work-graph module barrel. Check whether `src/modules/work-graph/index.ts` exists; if yes, add `export * from './spec-migrator.js'`; if the barrel does not exist, create it with exports for `spec-migrator.ts` and any other modules already in the directory

- [ ] Task 4: Write unit tests for `spec-migrator.ts` (AC: #3)
  - [ ] Create `src/modules/work-graph/__tests__/spec-migrator.test.ts`
  - [ ] Test `stripDeprecatedStatusField`:
    - Strips `Status: ready-for-dev` and trailing blank line from a full realistic spec string; confirm all content after Status is preserved
    - Strips `Status: draft` (different value)
    - No-op when content has no Status field (returns the input unchanged)
    - Does NOT strip a line that contains "Status" mid-sentence (e.g. `## Status Notes` or `The status is good`) — must be anchored at line start followed by `:`
    - Strips Status even when it appears after content (not just at the top of the file)
  - [ ] Test `detectDeprecatedStatusField`:
    - Returns `'ready-for-dev'` for content containing `Status: ready-for-dev`
    - Returns `null` for content without a Status line
    - Returns the trimmed value for `Status:   in_progress   ` (leading/trailing whitespace stripped)

- [ ] Task 5: Apply strip and warn in `dev-story.ts` (AC: #4, #5)
  - [ ] In `src/modules/compiled-workflows/dev-story.ts`, add the following import near the top of the file (after existing imports):
    ```typescript
    import { stripDeprecatedStatusField, detectDeprecatedStatusField } from '../work-graph/index.js'
    ```
  - [ ] After `storyContent` is assigned via `readFile(storyFilePath, 'utf-8')` (around line 134), and before it is used in complexity analysis or prompt assembly, add:
    ```typescript
    const staleStatus = detectDeprecatedStatusField(storyContent)
    if (staleStatus !== null) {
      logger.warn(
        { storyFilePath, staleStatus },
        'Story spec contains deprecated Status field — stripped before dispatch (status is managed by Dolt work graph)',
      )
      storyContent = stripDeprecatedStatusField(storyContent)
    }
    ```
  - [ ] Confirm `storyContent` is declared with `let` (not `const`) so the reassignment is valid

- [ ] Task 6: Update create-story test mock (AC: #6)
  - [ ] In `src/modules/compiled-workflows/__tests__/create-story.test.ts`, find the `getTemplate` mock:
    ```typescript
    getTemplate: vi.fn().mockResolvedValue('# Story Template\n\nStatus: draft\n\n## Story\n\n## Acceptance Criteria\n\n## Tasks / Subtasks\n\n## Dev Notes\n\n## Dev Agent Record'),
    ```
  - [ ] Remove `\nStatus: draft` from the string so it becomes:
    ```typescript
    getTemplate: vi.fn().mockResolvedValue('# Story Template\n\n## Story\n\n## Acceptance Criteria\n\n## Tasks / Subtasks\n\n## Dev Notes\n\n## Dev Agent Record'),
    ```
  - [ ] Run the affected test file individually to confirm it remains green before running the full suite

- [ ] Task 7: Build and test validation (all ACs)
  - [ ] Run `npm run build` — must exit 0
  - [ ] Run `npm run test:fast` — confirm output contains "Test Files" line with all tests passing; do NOT pipe output

## Dev Notes

### Architecture Constraints

- **New files to create**:
  - `src/modules/work-graph/spec-migrator.ts` — two pure functions, no DB or async dependencies
  - `src/modules/work-graph/__tests__/spec-migrator.test.ts` — unit tests (plain string operations, no adapter needed)

- **Files to modify**:
  - `packs/bmad/templates/story.md` — remove `Status: draft` line (line 3) and blank line (line 4)
  - `packs/bmad/prompts/create-story.md` — replace Status instruction in the Instructions section
  - `src/modules/compiled-workflows/dev-story.ts` — import + apply strip/warn after reading storyContent
  - `src/modules/compiled-workflows/__tests__/create-story.test.ts` — update mock template string
  - `src/modules/work-graph/index.ts` — add export for spec-migrator (or create if absent)

- **Import style**: All imports use named exports with `.js` extension (ESM project):
  ```typescript
  import { stripDeprecatedStatusField, detectDeprecatedStatusField } from '../work-graph/index.js'
  ```

- **Status field regex**: Use `/^Status:[^\n]*\n(\n)?/m` (multiline flag required). The `\n(\n)?` matches the Status line's newline plus optionally the blank line that follows it (the blank line between `Status: draft` and `## Story` in the current template). If the Status line is the last line of the file (no trailing newline), `/^Status:[^\n]*/m` without the `\n` will also match — handle this edge case by replacing with an empty string.

- **`storyContent` mutability in `dev-story.ts`**: The variable is declared with `let storyContent: string` around line 132. The strip/warn block must be inserted AFTER the assignment on line ~134 but BEFORE the `complexity` call on line ~154 and the `filesInScopeContent` call on line ~208. This ensures the stripped content flows through all downstream uses.

- **Scope of strip — NOT applied to orchestrator-impl.ts**: The orchestrator also reads spec content at lines ~934 (contract detection) and ~1047 (complexity analysis). These paths do NOT pass content to agents and are not affected by a Status line. Do NOT apply `stripDeprecatedStatusField` in `orchestrator-impl.ts` — only in `dev-story.ts`.

- **Work-graph barrel (`index.ts`)**: Story 31-7 introduced `cycle-detector.ts` and `errors.ts` in `src/modules/work-graph/`. Verify whether `index.ts` already exists in that directory. If it does, add `export * from './spec-migrator.js'`. If it does not, create it with:
  ```typescript
  export * from './cycle-detector.js'
  export * from './errors.js'
  export * from './spec-migrator.js'
  ```

- **Existing test fixtures with `Status:` lines**: Many test files (`batched-dev-story-dispatch.test.ts`, `epic-13-integration.test.ts`, `story-analyzer.test.ts`, etc.) include `Status: ready-for-dev` in fixture strings. Do NOT update these — those tests exercise other pipeline stages where the Status field is harmless (it will be stripped by the new code in `dev-story.ts` when encountered in production). Touching those fixtures would expand scope unnecessarily.

- **Test framework**: Vitest — use `describe`, `it`, `expect`. The `spec-migrator` tests are pure string operations and need no `InMemoryDatabaseAdapter` or mocking.

### Testing Requirements

- `spec-migrator.ts` tests use plain string operations — no DB adapter, no mocking
- `create-story.test.ts` mock template update is a single string edit; the test should remain green with no other changes
- All new code must remain above the 80% coverage threshold enforced by vitest config
- Run `npm run test:fast` (not `npm test`) during development — it completes in ~90s
- Do NOT pipe test output through `grep`, `tail`, or `head` — this discards the summary line and makes results unverifiable
- Confirm results by checking for "Test Files" in the raw output

## Interface Contracts

- **Export**: `stripDeprecatedStatusField`, `detectDeprecatedStatusField` @ `src/modules/work-graph/spec-migrator.ts` (consumed by `src/modules/compiled-workflows/dev-story.ts`)
- **Import**: work-graph module barrel @ `src/modules/work-graph/index.ts` (from story 31-7 — add new exports to existing barrel alongside `detectCycles` and `CyclicDependencyError`)

## Dev Agent Record

### Agent Model Used

### Completion Notes List

### File List

## Change Log
