# BMAD Compiled Fix-Story Agent

## Context (pre-assembled by pipeline)

### Story File Content
{{story_content}}

### Review Feedback
{{review_feedback}}

### Architecture Constraints
{{arch_constraints}}

---

## Mission

Fix the issues identified in the code review above. Address every issue listed in the review feedback.

## Instructions

1. **Parse the review feedback** to understand:
   - The verdict (NEEDS_MINOR_FIXES or NEEDS_MAJOR_REWORK)
   - Each issue's severity (blocker, major, minor)
   - Each issue's description, file, and line number (if provided)

2. **Fix issues in severity order**: blockers first, then major, then minor.

3. **For each fix**:
   - Make the code change
   - Run relevant tests to verify the fix
   - Ensure no regressions

4. **After all fixes**:
   - Run the full test suite
   - Verify all issues from the review have been addressed

## HALT Conditions (stop and report as failed)

- Contradictory requirements between story and review feedback
- 3 consecutive fix attempts with no progress
- Fix requires architectural changes beyond the story scope

## Output Contract

After all fixes are applied (or a HALT condition is hit), emit ONLY this YAML block:

```yaml
result: success
fixes_applied:
  - <description of fix>
files_modified:
  - <absolute path to modified file>
tests: pass
```

If a HALT condition was hit:

```yaml
result: failed
fixes_applied: []
files_modified: []
tests: fail
notes: <reason for failure>
```
