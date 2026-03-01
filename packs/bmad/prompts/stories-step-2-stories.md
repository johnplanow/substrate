# BMAD Stories Step 2: Story Generation

## Context (pre-assembled by pipeline)

### Epic Structure (from Step 1)
{{epic_structure}}

### Requirements (from Planning Phase)
{{requirements}}

### Architecture Decisions (from Solutioning Phase)
{{architecture_decisions}}

---

## Mission

Expand the epic structure into **implementation-ready stories** with acceptance criteria. Each story should be sized for a single developer in 1-3 days.

## Instructions

1. **Write implementation-ready stories:**
   - `key`: Short identifier like "1-1" or "2-3" (epic number - story number)
   - `title`: Clear, action-oriented (e.g., "User registration with email verification")
   - `description`: What the developer needs to build and why. Include enough context to start coding.
   - `acceptance_criteria`: Specific, testable conditions. Minimum 1 per story. Use concrete language.
   - `priority`: must (MVP-critical), should (high-value post-MVP), could (nice-to-have)

2. **Ensure full FR coverage:**
   - The epic structure from Step 1 maps FRs to epics — generate stories that fulfill each FR
   - Cross-reference: every FR should be covered by at least one story's acceptance criteria

3. **Respect architecture decisions:**
   - Stories should reference the chosen tech stack and patterns
   - If architecture specifies a project structure, Epic 1 Story 1 should be project scaffolding

4. **Size stories appropriately:**
   - Each story completable by one developer in 1-3 days
   - If too large, split into multiple stories within the same epic
   - If an epic has more than 8 stories, consider if the epic should be split

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL YAML RULES**:
- All string values MUST be quoted with double quotes.
- Acceptance criteria must be plain English descriptions — NO code snippets, function calls, or special characters inside strings.
- BAD: `- "convertMarkdown('# hello') returns '<h1>hello</h1>'"` (embedded quotes break YAML)
- GOOD: `- "Converting a heading produces the correct HTML h1 tag"`

```yaml
result: success
epics:
  - title: "User Onboarding and Habit Management"
    description: "Core habit tracking functionality that delivers immediate user value"
    stories:
      - key: "1-1"
        title: "Project scaffolding and CLI setup"
        description: "Initialize the project with TypeScript, Commander, and SQLite"
        acceptance_criteria:
          - "CLI binary runs and shows help text"
          - "SQLite database is created on first run"
        priority: must
      - key: "1-2"
        title: "Register and list habits"
        description: "Users can create habits and view all tracked habits"
        acceptance_criteria:
          - "habit add command creates a new habit"
          - "habit list command shows all habits with status"
        priority: must
```

If you cannot produce valid output:

```yaml
result: failed
```
