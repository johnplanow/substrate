# BMAD Planning Step 3: NFRs, Tech Stack, Domain Model & Scope

## Context (pre-assembled by pipeline)

### Product Brief (from Analysis Phase)
{{product_brief}}

### Project Classification (from Step 1)
{{classification}}

### Functional Requirements (from Step 2)
{{functional_requirements}}

### Technology Constraints (from Analysis Phase)
{{technology_constraints}}

### Original Concept (user's exact words)
{{concept}}

---

## Mission

Complete the PRD by defining **non-functional requirements**, **tech stack**, **domain model**, and **out-of-scope items**. These constrain HOW the system is built and what it explicitly does NOT do.

## Instructions

1. **Define non-functional requirements:**
   - Each NFR must have a category (performance, security, scalability, accessibility, reliability)
   - Be concrete: "API responses under 200ms at p95" not "System should be fast"
   - Minimum 2 NFRs covering different categories
   - NFRs should align with the project type and constraints

2. **Specify the tech stack:**
   - Key-value pairs mapping technology concerns to specific choices
   - Use real, current technologies — do not fabricate frameworks
   - Cover at minimum: language, framework, database, testing
   - **MUST honor stated technology constraints** — if the analysis or original concept specifies a cloud platform, language, or framework preference, use it. Do not substitute alternatives unless the constraint is technically impossible for the requirements.
   - **When the original concept and the analysis disagree on the scope of a technology restriction, the original concept wins.** For example, if the concept says "JavaScript is not the right choice for backend" but the analysis narrowed it to "excluded from critical path only," honor the concept's broader restriction.
   - If a technology constraint discourages or excludes a language or runtime (e.g., "JavaScript/Node.js is almost certainly not the right choice"), do NOT use that language or any of its variants (including TypeScript on Node.js) for ANY backend service. This is a blanket backend exclusion, not a path-specific one.
   - If you must deviate from a stated constraint, explicitly note the deviation and rationale

3. **Build the domain model:**
   - Key entities and their relationships
   - Each entity as a key with its attributes/relationships as the value
   - This informs database design and API structure downstream

4. **Define out-of-scope items** to prevent scope creep — what this product explicitly does NOT do.

## Pre-Output Checklist

Before emitting your output, verify:
- [ ] The `language` field in `tech_stack` matches the technology constraints. If a constraint says to evaluate Go, Kotlin/JVM, or Rust (and NOT JavaScript/Node.js), then `language` MUST be one of those — not TypeScript, not JavaScript, not Node.js.
- [ ] The example below is a FORMAT example only — do not copy its technology choices. Choose technologies based on the constraints above.

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
non_functional_requirements:
  - description: "CLI commands complete within 200ms for local operations"
    category: "performance"
  - description: "All user data encrypted at rest using AES-256"
    category: "security"
tech_stack:
  language: "Kotlin 2.0 on JVM 21"
  framework: "Ktor with coroutines"
  database: "PostgreSQL 16 via Exposed ORM"
  testing: "Kotest with Testcontainers"
domain_model:
  Habit:
    attributes: ["name", "frequency", "created_at"]
    relationships: ["has_many: Completions"]
  Completion:
    attributes: ["habit_id", "completed_at"]
    relationships: ["belongs_to: Habit"]
out_of_scope:
  - "Web or mobile interface"
  - "Cloud sync or multi-device support"
```

If you cannot produce valid output:

```yaml
result: failed
```
