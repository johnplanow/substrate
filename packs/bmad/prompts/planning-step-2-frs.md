# BMAD Planning Step 2: Functional Requirements & User Stories

## Context (pre-assembled by pipeline)

### Product Brief (from Analysis Phase)
{{product_brief}}

### Project Classification (from Step 1)
{{classification}}

---

## Mission

Derive **functional requirements** and **user stories** from the product brief and project classification. These define WHAT the system must do from the user's perspective.

## Instructions

1. **Derive functional requirements:**
   - Each FR must be specific, testable, and traceable to a core feature or user need
   - Use MoSCoW prioritization: `must` (MVP-critical), `should` (high-value), `could` (nice-to-have)
   - Minimum 3 FRs, but don't pad — every FR should earn its place
   - Frame as capabilities: "Users can filter by date range" not "Add a date picker component"

2. **Write user stories:**
   - Each story captures a user journey or interaction pattern
   - Title should be scannable; description should explain the "why"
   - Stories bridge the gap between requirements and implementation

3. **Align with classification:**
   - FRs should support the key goals from the classification step
   - Prioritization should reflect the project type and vision

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
functional_requirements:
  - description: "Users can register new habits with a name and frequency"
    priority: must
  - description: "Users can view current streaks for all tracked habits"
    priority: must
  - description: "Users can export habit data to JSON or CSV format"
    priority: should
user_stories:
  - title: "Habit Registration"
    description: "As a developer, I want to register daily habits so I can track my consistency"
  - title: "Streak Dashboard"
    description: "As a user, I want to see my current streaks so I stay motivated"
```

If you cannot produce valid output:

```yaml
result: failed
```
