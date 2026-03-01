# BMAD Analysis Step 2: Scope & Features

## Context (pre-assembled by pipeline)

### Project Concept
{{concept}}

### Vision Analysis (from Step 1)
{{vision_output}}

---

## Mission

Building on the vision analysis above, define the **scope**: core features, success metrics, and constraints. The problem statement and target users are already established — now determine WHAT to build and HOW to measure success.

## Instructions

1. **Define core features** that directly address the problem statement:
   - Each feature should be a concrete capability, not a vague category
   - Prioritize by user impact — list the most critical features first
   - Ensure features serve the identified target users

2. **Define measurable success metrics:**
   - Tied to user value and business objectives
   - Include both leading indicators (engagement, adoption) and lagging indicators (retention, revenue)
   - Be specific enough to measure

3. **Identify constraints** (business, regulatory, and operational — NOT technology choices):
   - Regulatory requirements, budget boundaries, compliance mandates
   - Timeline pressures, integration requirements, market restrictions
   - Do NOT include cloud platform, language, or framework choices here — those go in `technology_constraints`
   - Omit if genuinely none exist

4. **Identify technology constraints** (technology choices and restrictions ONLY):
   - Extract explicit technology preferences or exclusions stated in the concept
   - Cloud platform choices (e.g., "GCP", "AWS"), programming language mandates (e.g., "Kotlin/JVM", "Node.js excluded"), framework preferences, infrastructure choices
   - If the concept has a "Technology Constraints" section, extract ALL items from it into this field
   - Include ONLY preferences explicitly stated by the user — do not infer or add your own
   - If none are stated in the concept, emit an empty array

5. **Quality bar**: A product manager should be able to write a PRD from the combined vision + scope output.

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All array items MUST be plain strings, NOT objects/maps.

```yaml
result: success
core_features:
  - "CLI command to register, check-off, and view daily habits with streak tracking"
  - "Local SQLite storage with export to JSON/CSV for portability"
success_metrics:
  - "Daily active usage rate >60% among onboarded users within 30 days"
  - "Streak completion rate >40% across all tracked habits"
constraints:
  - "CLI-only interface limits audience to terminal-comfortable users"
  - "Must work offline with local storage, no cloud dependency"
technology_constraints:
  - "Must use PostgreSQL for primary data store"
```

If you cannot produce valid output:

```yaml
result: failed
```
