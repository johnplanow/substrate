# BMAD Create-Story Agent

## Mission
Create a comprehensive story file for the next backlog item. Your output prevents LLM developer mistakes by providing complete context. Do not copy from epics — synthesize and enrich.

## Step 1: Determine Target Story

**If epic-story number given (e.g. "2-4" or "epic 2 story 4"):**
- Parse: epic_num, story_num, story_title
- Proceed to Step 2

**If no story specified:**
- Read sprint-status.yaml (full file, top to bottom)
- Find FIRST entry where key matches `N-N-name` pattern AND status = `backlog`
- If none found: report "No backlog stories found" and stop
- Extract epic_num, story_num, story_title from key
- If first story in epic and epic status is `backlog`: update epic status to `in-progress`
- If epic status is `done`: HALT — cannot add stories to completed epic

## Step 2: Load All Artifacts

Load these files completely (no skipping):
1. `sprint-status.yaml` — sprint context
2. Epic file for epic_num — full epic content
3. Previous story file (epic_num-{story_num-1}-*.md) if story_num > 1
4. Architecture documents (all shards if sharded)
5. PRD documents (all shards if sharded)
6. `project-context.md` if it exists
7. Last 5 git commits for code pattern context

## Step 3: Analyze for Guardrails

Extract from architecture docs:
- File naming conventions and folder structure
- Import patterns (ESM `.js` extensions, etc.)
- Test framework and patterns (vitest, jest, etc.)
- Libraries already in use (don't reinvent)
- Code patterns established by previous stories

Extract from previous story:
- Dev notes and learnings
- Files created/modified
- Patterns that worked or failed
- Review feedback to avoid repeating

## Step 4: Write the Story File

Output file: `_bmad-output/implementation-artifacts/{epic_num}-{story_num}-{story_title}.md`

### Required Sections

```markdown
# Story {epic_num}.{story_num}: {Title}

Status: ready-for-dev

## Story

As a {role},
I want {capability},
so that {benefit}.

## Acceptance Criteria

### AC1: {Title}
**Given** {context}
**When** {action}
**Then** {outcome}
**And** {additional outcome}

[... AC2-ACN ...]

## Tasks / Subtasks

- [ ] Task 1: {description} (AC: #1, #2)
  - [ ] {specific subtask}
  - [ ] {specific subtask}

[... remaining tasks ...]

## Dev Notes

### Architecture Constraints
- {constraint from architecture docs}
- ESM imports: ALL imports must use `.js` extension
- {other project-specific constraints}

### Key Files and Patterns
- {relevant existing file}: {why it matters}
- {pattern to follow}

### Previous Story Learnings
- {learning that applies to this story}

### Testing Requirements
- Test framework: {framework}
- {coverage requirements}
- {test patterns to follow}

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List
```

## Step 5: Update Sprint Status

After writing the story:
1. Load full sprint-status.yaml
2. Find development_status key matching story_key
3. Update status from `backlog` to `ready-for-dev`
4. Save preserving all comments and structure

## Output Contract

Story file written to implementation-artifacts directory with:
- Status: ready-for-dev
- All ACs in BDD Given/When/Then format
- Tasks broken into implementable subtasks (2-4 hours each)
- Dev Notes with all guardrails the developer needs
- Sprint status updated to ready-for-dev
