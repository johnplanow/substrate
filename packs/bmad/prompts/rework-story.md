# BMAD Compiled Rework-Story Agent

## Context (pre-assembled by pipeline)

### Story File Content
{{story_content}}

### Issues from Previous Review that MUST be Addressed
{{review_findings}}

### Architecture Constraints
{{arch_constraints}}

### Previous Implementation Diff
{{git_diff}}

### Prior Pipeline Findings
{{prior_findings}}

### Automated Verification Findings
{{verification_findings}}

---

## Mission

This is a FULL re-implementation. The previous implementation had fundamental issues identified in a code review. You must address ALL review findings above while implementing the story from scratch.

Do NOT patch the existing implementation. Re-implement the story completely, using the review findings as guidance on what went wrong previously.

## Instructions

1. **Parse the review findings** to understand:
   - Each issue's severity (blocker, major, minor)
   - Each issue's description, file, and line number (if provided)
   - The root causes that led to the previous implementation's failure

2. **Re-read the story file** to understand:
   - Acceptance Criteria (AC1, AC2, etc.)
   - Tasks/Subtasks (ordered list with `[ ]` checkboxes)
   - Dev Notes (file paths, import patterns, test requirements)

3. **Re-implement each task in order** (Red-Green-Refactor):
   - Write failing tests first
   - Make tests pass with minimal code
   - Refactor while keeping tests green
   - Ensure each review finding is addressed

4. **After each task**:
   - Verify tests pass
   - Run the full test suite to check for regressions
   - Mark the task `[x]` in the story file
   - Update the story File List with all new/modified files

5. **After all tasks complete**:
   - Run the full test suite one final time
   - Verify ALL review findings have been addressed
   - Update story Status to `review`

## CRITICAL: Output Contract Emission

**You MUST emit the YAML output block (see Output Contract below) as the very last thing you produce.** The downstream pipeline depends on `files_modified` to generate scoped code-review diffs. If you exhaust your turns without emitting the YAML block, the pipeline cannot review your work properly.

- If you are running low on turns, **stop implementation and emit the YAML block immediately** with whatever progress you have made. A partial `files_modified` list is far more valuable than none at all.
- The YAML block must be the final output — no summary text, no explanation after it.

## HALT Conditions (stop and report as failed)

- New dependency required beyond story spec
- 3 consecutive implementation failures with no progress
- Story requirements are ambiguous with no way to resolve
- Review findings contradict the story requirements

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
