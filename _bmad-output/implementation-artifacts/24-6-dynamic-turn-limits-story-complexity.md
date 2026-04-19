# Story 24-6: Dynamic Turn Limits Based on Story Complexity

Status: ready

## Story

As a pipeline operator,
I want the dispatcher to scale the agent turn limit based on story complexity,
so that large stories (many tasks, many new files) get enough turns to complete instead of exhausting the hardcoded limit.

Addresses: Cross-project Epic 4 run where story 4-6 (8 tasks, 15 new files) exhausted the 75-turn dev-story limit with only 2 of 15 files written. The hardcoded limit is adequate for small-to-medium stories but insufficient for large ones.

## Acceptance Criteria

### AC1: Story Complexity Score Computation
**Given** a story markdown file with Tasks/Subtasks and File Layout sections
**When** the dev-story workflow prepares to dispatch
**Then** a complexity score is computed from: task count (number of `- [ ] Task N:` lines), subtask count (nested `- [ ]` lines), and file count (lines in the File Layout code block matching common file extensions)

### AC2: Turn Limit Scaling
**Given** the computed complexity score
**When** the dispatcher resolves `maxTurns` for a `dev-story` dispatch
**Then** the turn limit scales: base 75 turns for score <= 10, +10 turns per additional complexity point, capped at 200 turns

### AC3: Complexity Score Passed Through DispatchRequest
**Given** the dev-story workflow computes a complexity score
**When** it builds the `DispatchRequest`
**Then** the request includes an optional `maxTurns` override computed from the score, which the dispatcher uses instead of `DEFAULT_MAX_TURNS['dev-story']`

### AC4: Default Behavior Preserved
**Given** a story markdown with no parseable tasks or file layout (e.g. manually written story with no standard sections)
**When** the complexity scorer runs
**Then** the score defaults to 0 and the existing 75-turn limit applies unchanged

### AC5: Fix-Story Scales Similarly
**Given** a fix-story dispatch (major rework)
**When** the dispatcher resolves `maxTurns`
**Then** the same complexity score applies with base 50 turns (existing default) and the same +10/point scaling, capped at 150

### AC6: Complexity Score Logged
**Given** a dev-story or fix-story dispatch
**When** the complexity score is computed
**Then** it is logged at `info` level with `{ storyKey, taskCount, subtaskCount, fileCount, complexityScore, resolvedMaxTurns }`

## Tasks / Subtasks

- [ ] Task 1: Implement `computeStoryComplexity()` (AC: #1, #4)
  - [ ] Create `src/modules/compiled-workflows/story-complexity.ts`
  - [ ] Parse markdown for `- [ ] Task N:` lines (top-level tasks)
  - [ ] Parse markdown for nested `- [ ]` lines (subtasks)
  - [ ] Parse File Layout fenced code block for file entries (lines matching `*.ts`, `*.js`, `*.json`, `*.sql`, `*.yaml`, `*.md`)
  - [ ] Score = taskCount + (subtaskCount * 0.5) + (fileCount * 0.5), rounded to nearest integer
  - [ ] Return `{ taskCount, subtaskCount, fileCount, complexityScore }`
  - [ ] Return score 0 when sections are not found

- [ ] Task 2: Integrate into dev-story workflow (AC: #2, #3, #6)
  - [ ] In `src/modules/compiled-workflows/dev-story.ts`, after reading the story file content
  - [ ] Call `computeStoryComplexity(storyContent)`
  - [ ] Compute `resolvedMaxTurns = Math.min(200, 75 + Math.max(0, complexityScore - 10) * 10)`
  - [ ] Pass `maxTurns: resolvedMaxTurns` in the `DispatchRequest`
  - [ ] Log complexity score and resolved turns

- [ ] Task 3: Integrate into fix-story path (AC: #5)
  - [ ] In the fix-story dispatch path (orchestrator-impl.ts or wherever major-rework dispatches)
  - [ ] Apply same complexity scoring with base 50, cap 150: `Math.min(150, 50 + Math.max(0, complexityScore - 10) * 10)`

- [ ] Task 4: Unit tests (AC: #1-#6)
  - [ ] Test: story with 3 tasks, 6 subtasks, 4 files → score = 3 + 3 + 2 = 8, turns = 75
  - [ ] Test: story with 8 tasks, 20 subtasks, 15 files → score = 8 + 10 + 7.5 = 26, turns = min(200, 75 + 160) = 200
  - [ ] Test: story with no parseable sections → score = 0, turns = 75
  - [ ] Test: fix-story path uses base 50 and cap 150
  - [ ] Test: complexity score is logged

## Dev Notes

### Key Files
- New: `src/modules/compiled-workflows/story-complexity.ts`
- `src/modules/compiled-workflows/dev-story.ts` — integration point
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — fix-story dispatch
- `src/modules/agent-dispatch/types.ts` — `DEFAULT_MAX_TURNS` reference (not modified)

### Design Decisions
- Scoring is heuristic — tasks and files are weighted equally because both correlate with agent turn consumption
- Cap at 200 turns prevents runaway agents; if 200 turns isn't enough, the story should be split
- The scorer is a pure function on markdown content — no filesystem or git access needed
- Subtasks weighted at 0.5 because they're smaller units of work than top-level tasks

## Change Log
- 2026-03-06: Story created from cross-project pipeline findings (code-review-agent 4-6)
