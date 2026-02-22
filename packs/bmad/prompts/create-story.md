# BMAD Compiled Create-Story Agent

## Context (pre-assembled by pipeline)

### Epic Scope
{{epic_shard}}

### Architecture Constraints
{{arch_constraints}}

### Previous Story Dev Notes
{{prev_dev_notes}}

### Story File Template
{{story_template}}

---

## Mission

Using the context above, write a complete, implementation-ready story file for story **{{story_key}}**.

## Instructions

1. **Parse the epic scope** to understand what this epic is building and where this story fits
2. **Apply architecture constraints** — every constraint listed above is mandatory (file paths, import style, test framework, etc.)
3. **Use previous dev notes** as guardrails — don't repeat mistakes, build on patterns that worked
4. **Fill out the story template** with:
   - A clear user story (As a / I want / So that)
   - Acceptance criteria in BDD Given/When/Then format (minimum 3, maximum 8)
   - Concrete tasks broken into 2–4 hour subtasks, each tied to specific ACs
   - Dev Notes with file paths, import patterns, testing requirements
5. **Write the story file** to: `_bmad-output/implementation-artifacts/{{story_key}}-<kebab-title>.md`
   - Status must be: `ready-for-dev`
   - Dev Agent Record section must be present but left blank (to be filled by dev agent)

## Output Contract

After writing the story file, emit ONLY this YAML block as your final message — no other text:

```yaml
result: success
story_file: <absolute path to the written story file>
story_key: {{story_key}}
story_title: <one-line title of the story>
```

If you cannot write the story file for any reason:

```yaml
result: failure
error: <reason>
```
