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
5. **Apply the scope cap** — see Scope Cap Guidance below
6. **Write the story file** to: `_bmad-output/implementation-artifacts/{{story_key}}-<kebab-title>.md`
   - Status must be: `ready-for-dev`
   - Dev Agent Record section must be present but left blank (to be filled by dev agent)

## Scope Cap Guidance

**Aim for 6-7 acceptance criteria and 7-8 tasks per story.**

Each story will be implemented by an AI agent in a single pass. Stories with more than 7 ACs tend to exceed agent capabilities and require decomposition, adding latency and complexity to the pipeline.

If the scope requires more than 7 ACs, split into multiple sequential stories (e.g., `7-1a: Core Setup`, `7-1b: Advanced Features`). Splitting is preferable to cramming too much scope into a single story.

This is guidance, not enforcement — if the scope genuinely fits in a slightly larger story, use your judgment. The goal is to avoid stories that will predictably fail during implementation.

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
