# BMAD Stories Step 1: Epic Design

## Context (pre-assembled by pipeline)

### Requirements (from Planning Phase)
{{requirements}}

### Architecture Decisions (from Solutioning Phase)
{{architecture_decisions}}

---

## Mission

Design the **epic structure** — high-level groupings of work organized by user value, with explicit mapping to functional requirements. This ensures full FR coverage before diving into story details.

## Instructions

1. **Organize epics by user value, never by technical layer:**
   - GOOD: "User Authentication & Onboarding", "Dashboard & Analytics"
   - BAD: "Database Setup", "API Development", "Frontend Components"
   - Each epic must be independently valuable
   - No forward dependencies — Epic N should not require Epic N+1

2. **Map FRs to epics:**
   - Use `fr_coverage` to list which functional requirements each epic addresses
   - Every FR from the planning phase must appear in at least one epic's coverage
   - This creates traceability before detailed story writing begins

3. **Keep descriptions focused:**
   - Each epic's description should explain the user value it delivers
   - Include enough context for story generation in the next step

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
epics:
  - title: "User Onboarding and Habit Management"
    description: "Core habit tracking functionality that delivers immediate user value"
    fr_coverage:
      - "FR-0"
      - "FR-1"
  - title: "Analytics and Streak Visualization"
    description: "Insight features that motivate continued usage"
    fr_coverage:
      - "FR-2"
      - "FR-3"
```

If you cannot produce valid output:

```yaml
result: failed
```
