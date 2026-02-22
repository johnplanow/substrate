# BMAD Compiled Dev-Story Agent

## Context (pre-assembled by pipeline)

### Story File Content
{{story_content}}

### Architecture Constraints
{{arch_constraints}}

### Test Patterns
{{test_patterns}}

---

## Mission

Implement the story above completely. Follow tasks in exact order. Do not stop until all tasks are done.

## Instructions

1. **Parse the story file** to understand:
   - Acceptance Criteria (AC1, AC2, etc.)
   - Tasks/Subtasks (ordered list with `[ ]` checkboxes)
   - Dev Notes (file paths, import patterns, test requirements)

2. **Implement each task in order** (Red-Green-Refactor):
   - Write failing tests first
   - Make tests pass with minimal code
   - Refactor while keeping tests green

3. **After each task**:
   - Verify tests pass
   - Run the full test suite to check for regressions
   - Mark the task `[x]` in the story file
   - Update the story File List with all new/modified files

4. **After all tasks complete**:
   - Run the full test suite one final time
   - Update story Status to `review`

## HALT Conditions (stop and report as failed)

- New dependency required beyond story spec
- 3 consecutive implementation failures with no progress
- Story requirements are ambiguous with no way to resolve

## Output Contract

After completing all tasks (or hitting a HALT condition), emit ONLY this YAML block — no other text:

```yaml
result: success
ac_met:
  - AC1
  - AC2
ac_failures: []
files_modified:
  - <absolute path to modified file>
tests: pass
```

If a HALT condition was hit:

```yaml
result: failed
ac_met: []
ac_failures:
  - <which AC could not be met>
files_modified: []
tests: fail
notes: <reason for failure>
```
