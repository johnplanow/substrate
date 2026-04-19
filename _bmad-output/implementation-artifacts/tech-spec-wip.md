---
title: 'Fix-Story Prompt Enrichment and Turn Limit Wiring'
slug: 'fix-story-prompt-enrichment'
created: '2026-03-07'
status: 'in-progress'
stepsCompleted: [1]
tech_stack: [typescript, vitest]
files_to_modify:
  - packs/bmad/prompts/fix-story.md
  - src/modules/implementation-orchestrator/orchestrator-impl.ts
  - src/modules/implementation-orchestrator/__tests__/orchestrator-impl.test.ts
code_patterns:
  - assemblePrompt with PromptSection[] and token ceiling
  - dispatcher.dispatch with maxTurns option
  - resolveFixStoryMaxTurns from story-complexity.ts
test_patterns:
  - vitest with vi.mock hoisting
  - orchestrator tests use 2s mock delays
  - run targeted tests with npx vitest run --no-coverage -- "pattern"
---

# Tech-Spec: Fix-Story Prompt Enrichment and Turn Limit Wiring

**Created:** 2026-03-07

## Overview

### Problem Statement

Fix-story agents spend 8-10 minutes re-reading codebase context for 1-line fixes, then timeout before emitting YAML output. In Epic 24 Sprint 3, 3 of 4 stories escalated because the fix agent timed out — despite the actual code fix being applied correctly on disk. The root causes:

1. **No `maxTurns` on minor-fix dispatches** — the auto-approve path (orchestrator-impl.ts:1412) and the general minor-fix path (orchestrator-impl.ts:1558) both dispatch without turn limits, so agents thrash until the 10-min hard timeout kills them.
2. **Prompt lacks targeted file directives** — the fix-story template tells the agent to "parse the review feedback" but doesn't front-load exact file paths. The agent wastes turns re-reading story context and scanning the codebase before finding the 1 file it needs to edit.

### Solution

Two changes:

1. **Add a `targeted_files` prompt section** to the fix-story template that lists the exact files + line numbers from code-review issues, with a "read ONLY these files first" instruction. This section is assembled from the `issue_list[].file` and `issue_list[].line` data already available in the orchestrator.
2. **Wire `resolveFixStoryMaxTurns` to both minor-fix dispatch paths** — the auto-approve path and the general fix path. The infrastructure exists from story 24-6 but is only connected for major-rework dispatches today.

### Scope

**In Scope:**
- `packs/bmad/prompts/fix-story.md` — add `{{targeted_files}}` placeholder and "start here" instruction
- `orchestrator-impl.ts` auto-approve minor-fix path (~line 1375-1418) — add `targeted_files` section and `maxTurns`
- `orchestrator-impl.ts` general fix path (~line 1471-1562) — add `targeted_files` section and wire `maxTurns` for minor fixes (not just major-rework)
- Unit tests for both paths

**Out of Scope:**
- `rework-story` template (already has maxTurns wired)
- Code-review changes
- Config schema changes
- Token ceiling changes

## Context for Development

### Codebase Patterns

- Prompt templates use `{{placeholder}}` syntax, assembled via `assemblePrompt(template, sections, ceiling)`
- PromptSection has `{ name, content, priority: 'required' | 'important' | 'optional' }`
- Dispatcher accepts `{ maxTurns?: number }` in dispatch options
- `resolveFixStoryMaxTurns(complexityScore)` returns base 50, +10/point above 10, cap 150
- `computeStoryComplexity(storyContent)` parses tasks/subtasks/files from story markdown
- Issue list items have shape: `{ severity, description, file?, line? }`

### Files to Reference

| File | Purpose |
| ---- | ------- |
| `packs/bmad/prompts/fix-story.md` | Fix-story prompt template — add `{{targeted_files}}` section |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | Two fix dispatch paths to modify (~L1375 and ~L1471) |
| `src/modules/compiled-workflows/story-complexity.ts` | `resolveFixStoryMaxTurns` — already exists, just needs wiring |
| `src/modules/compiled-workflows/prompt-assembler.ts` | `assemblePrompt` — no changes needed, just used |
| `src/modules/implementation-orchestrator/__tests__/orchestrator-impl.test.ts` | Add tests for new behavior |

### Technical Decisions

- `targeted_files` section priority is `important` (not required) — if no files are in the issue list, the section is empty and gets dropped
- maxTurns for minor-fix uses `resolveFixStoryMaxTurns` with a floor of 20 (minor fixes should never need 50+ turns for 1-3 issues)
- The auto-approve path (first review cycle minor fix) gets the same treatment as the general path — no special casing

## Implementation Plan

### Tasks

- [ ] Task 1: Add `{{targeted_files}}` placeholder to `packs/bmad/prompts/fix-story.md` with a "Start by reading ONLY these files" instruction block above the Mission section
- [ ] Task 2: Build `targeted_files` content string from `issueList` in the orchestrator — deduplicate file paths, include line numbers, format as a bullet list
- [ ] Task 3: Add `targeted_files` section to auto-approve minor-fix prompt assembly (~L1400)
- [ ] Task 4: Add `targeted_files` section to general fix/rework prompt assembly (~L1527)
- [ ] Task 5: Wire `resolveFixStoryMaxTurns` to auto-approve minor-fix dispatch (~L1412) — read story content, compute complexity, pass maxTurns
- [ ] Task 6: Wire `resolveFixStoryMaxTurns` to general minor-fix dispatch (~L1558) — the major-rework path already has it, add it for minor fixes too
- [ ] Task 7: Add unit tests — verify targeted_files section is assembled, verify maxTurns is passed to dispatch for minor fixes

### Acceptance Criteria

- **AC1**: Given a code-review with issues containing `file` and `line` fields, when the fix-story prompt is assembled, then a `targeted_files` section lists deduplicated file paths with line numbers
- **AC2**: Given a code-review with issues that have no `file` field, when the fix-story prompt is assembled, then the `targeted_files` section is empty and dropped by the assembler
- **AC3**: Given a minor-fix dispatch (auto-approve path), when the dispatcher is called, then `maxTurns` is set to the value from `resolveFixStoryMaxTurns(complexityScore)`
- **AC4**: Given a minor-fix dispatch (general path), when the dispatcher is called, then `maxTurns` is set to the value from `resolveFixStoryMaxTurns(complexityScore)`
- **AC5**: Given a major-rework dispatch, when the dispatcher is called, then `maxTurns` behavior is unchanged (already wired via story 24-6)
- **AC6**: The fix-story.md template contains a `{{targeted_files}}` section with instruction text directing the agent to read those files first

## Additional Context

### Dependencies

- `story-complexity.ts` — already exists from story 24-6, no changes needed
- `prompt-assembler.ts` — already exists, no changes needed

### Testing Strategy

- Unit tests in orchestrator test file: mock `dispatcher.dispatch` and assert `maxTurns` is passed
- Unit tests: mock `issueList` with file/line data, assert `targeted_files` section content
- Run targeted: `npx vitest run --no-coverage -- "orchestrator-impl"`
- Final validation: `npm test`

### Notes

- The auto-approve minor-fix path (L1375-1418) is a separate code path from the general fix/rework loop (L1471-1562). Both need the same changes applied independently.
- Story content is already read from disk at L1380 (auto-approve) and L1479 (general) — `computeStoryComplexity` can use this existing content, no extra file read needed.
- The 10-min hard timeout (`DEFAULT_TIMEOUT_MS = 1_800_000` in dev-story.ts) is separate from maxTurns. maxTurns limits agent turns; the timeout is a wall-clock safety net. Both should be applied.
