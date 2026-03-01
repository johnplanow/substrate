# BMAD Analysis Step 1: Vision & Problem Analysis

## Context (pre-assembled by pipeline)

### Project Concept
{{concept}}

---

## Mission

Analyze the project concept above and produce a focused **vision analysis**: a clear problem statement and identification of target users. Do NOT define features or metrics yet — those come in a subsequent step.

## Instructions

1. **Analyze the concept deeply:**
   - What problem does this solve? Who experiences this problem most acutely?
   - What existing solutions exist? Why do they fall short?
   - What would make this succeed vs. fail?

2. **Generate a research-grade problem statement:**
   - A clear, specific articulation of the problem (minimum 2-3 sentences)
   - Ground it in user pain, not technology
   - Include the impact of the problem remaining unsolved

3. **Identify target users:**
   - Specific user segments (not generic labels)
   - Include role, context, and why they care
   - Minimum 2 distinct segments

4. **Quality bar**: Every field should contain enough detail that a product manager could begin scoping from this analysis alone.

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All array items MUST be plain strings, NOT objects/maps.

```yaml
result: success
problem_statement: "A clear articulation of the problem in 2-3 sentences."
target_users:
  - "Software developers who work in terminal environments and want habit tracking"
  - "DevOps engineers who need to maintain daily operational checklists"
```

If you cannot produce valid output:

```yaml
result: failed
```
