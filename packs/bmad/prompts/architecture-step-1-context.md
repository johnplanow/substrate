# BMAD Architecture Step 1: Context Analysis

## Context (pre-assembled by pipeline)

### Requirements (from Planning Phase)
{{requirements}}

### Non-Functional Requirements
{{nfr}}

---

## Mission

Analyze the requirements context and produce **initial architecture decisions** focused on the foundational technology choices: system architecture style, API design, data storage, and project structure. Think like a pragmatic senior architect — choose boring technology that ships.

## Instructions

1. **Make concrete decisions, not suggestions:**
   - Each decision is a key-value pair capturing one architectural concern
   - The `key` identifies WHAT is being decided
   - The `value` states the CHOICE
   - The `rationale` explains WHY this choice over alternatives

2. **Focus on foundational decisions:**
   - **System architecture**: Monolith, modular monolith, microservices, or serverless
   - **API design**: REST, GraphQL, gRPC, or hybrid
   - **Data storage**: Database engine, schema strategy, migration approach
   - **Project structure**: Directory layout, module boundaries, dependency rules

3. **Align with requirements:**
   - Every `must` functional requirement should be architecturally supportable
   - NFRs should directly inform decisions
   - Tech stack choices from planning should be respected

4. **Use the `category` field** to group related decisions:
   - `infrastructure`: deployment, hosting, CI/CD
   - `backend`: API, database, auth, services
   - `frontend`: UI framework, state, routing
   - `crosscutting`: logging, error handling, testing, security

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
architecture_decisions:
  - category: "backend"
    key: "system-architecture"
    value: "Modular monolith with clear module boundaries"
    rationale: "Right complexity level for the project scope"
  - category: "backend"
    key: "database"
    value: "SQLite with better-sqlite3 driver"
    rationale: "Zero-config local storage, perfect for CLI tools"
  - category: "backend"
    key: "api-style"
    value: "CLI command interface with Commander.js"
    rationale: "Direct command-line interaction, no HTTP needed"
```

If you cannot produce valid output:

```yaml
result: failed
```
