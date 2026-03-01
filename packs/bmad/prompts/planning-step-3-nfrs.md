# BMAD Planning Step 3: NFRs, Tech Stack, Domain Model & Scope

## Context (pre-assembled by pipeline)

### Product Brief (from Analysis Phase)
{{product_brief}}

### Project Classification (from Step 1)
{{classification}}

### Functional Requirements (from Step 2)
{{functional_requirements}}

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
   - Choices should align with the product brief constraints

3. **Build the domain model:**
   - Key entities and their relationships
   - Each entity as a key with its attributes/relationships as the value
   - This informs database design and API structure downstream

4. **Define out-of-scope items** to prevent scope creep — what this product explicitly does NOT do.

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
  language: "TypeScript"
  framework: "Node.js CLI with Commander"
  database: "SQLite via better-sqlite3"
  testing: "Vitest"
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
