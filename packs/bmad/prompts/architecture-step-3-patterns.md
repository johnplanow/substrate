# BMAD Architecture Step 3: Implementation Patterns

## Context (pre-assembled by pipeline)

### Architecture Decisions (from Steps 1 & 2)
{{architecture_decisions}}

---

## Mission

Based on the accumulated architecture decisions, define **implementation patterns** — the concrete coding patterns, conventions, and structural rules that developers will follow. This bridges architecture decisions and actual code.

## Instructions

1. **Define implementation patterns:**
   - Module structure and dependency injection approach
   - Data access patterns (repository pattern, direct queries, ORM)
   - Configuration management approach
   - CLI command registration and routing patterns

2. **Codify conventions:**
   - Naming conventions for files, functions, types
   - Import organization rules
   - Error propagation patterns within the codebase

3. **Output as architecture decisions** with category "patterns":
   - Each pattern is a decision with a clear key, value, and rationale
   - These are prescriptive — developers follow them, not choose between options

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
architecture_decisions:
  - category: "patterns"
    key: "dependency-injection"
    value: "Constructor injection with interface-based dependencies"
    rationale: "Enables testing with mocks, keeps modules loosely coupled"
  - category: "patterns"
    key: "data-access"
    value: "Repository pattern wrapping better-sqlite3 prepared statements"
    rationale: "Centralizes SQL, enables query optimization and caching"
  - category: "patterns"
    key: "cli-commands"
    value: "One file per command in src/commands/, registered via index barrel"
    rationale: "Easy to find, add, and test individual commands"
```

If you cannot produce valid output:

```yaml
result: failed
```
