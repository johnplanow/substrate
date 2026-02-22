# BMAD Compiled Analysis Agent

## Context (pre-assembled by pipeline)

### Project Concept
{{concept}}

---

## Mission

Analyze the project concept above and produce a structured **Product Brief** that captures the essential product definition. Think like a senior business analyst conducting market analysis, user research, and feasibility assessment.

## Instructions

1. **Analyze the concept deeply** before generating output:
   - What problem does this solve? Who experiences this problem most acutely?
   - What existing solutions exist? Why do they fall short?
   - What are the real technical constraints and market dynamics?
   - What would make this succeed vs. fail?

2. **Generate each field with research-grade depth:**
   - `problem_statement`: A clear, specific articulation of the problem (minimum 2-3 sentences). Ground it in user pain, not technology. Include the impact of the problem remaining unsolved.
   - `target_users`: Specific user segments (not generic labels). Include role, context, and why they care. Minimum 2 distinct segments.
   - `core_features`: Capabilities that directly address the problem statement. Each feature should be a concrete capability, not a vague category. Prioritize by user impact.
   - `success_metrics`: Measurable outcomes tied to user value and business objectives. Include both leading indicators (engagement, adoption) and lagging indicators (retention, revenue). Be specific enough to measure.
   - `constraints`: Technical limitations, regulatory requirements, budget boundaries, timeline pressures, platform restrictions, or integration requirements. Omit if genuinely none exist.

3. **Quality bar**: Every field should contain enough detail that a product manager could begin writing a PRD from this brief alone. Avoid placeholder text, generic statements, or single-word items.

4. **Amendment awareness**: If amendment context from a parent run is provided below, refine and build upon existing decisions rather than starting from scratch. Identify what changes, what stays, and what new elements the amendment introduces.

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All array items MUST be plain strings, NOT objects/maps. Write each item as a single descriptive string on one line.

```yaml
result: success
product_brief:
  problem_statement: "A clear articulation of the problem in 2-3 sentences."
  target_users:
    - "Software developers who work in terminal environments and want habit tracking"
    - "DevOps engineers who need to maintain daily operational checklists"
  core_features:
    - "CLI command to register, check-off, and view daily habits with streak tracking"
    - "Local SQLite storage with export to JSON/CSV for portability"
  success_metrics:
    - "Daily active usage rate >60% among onboarded users within 30 days"
    - "Streak completion rate >40% across all tracked habits"
  constraints:
    - "CLI-only interface limits audience to terminal-comfortable users"
    - "Must work offline with local storage, no cloud dependency"
```

If you cannot produce a valid product brief:

```yaml
result: failed
```
