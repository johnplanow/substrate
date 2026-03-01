# BMAD Architecture Step 2: Detailed Decisions

## Context (pre-assembled by pipeline)

### Requirements (from Planning Phase)
{{requirements}}

### Foundational Decisions (from Step 1)
{{starter_decisions}}

---

## Mission

Building on the foundational architecture decisions, produce **detailed architecture decisions** covering authentication, error handling, testing strategy, and remaining architectural concerns. Do NOT repeat decisions from Step 1 — extend and complement them.

## Instructions

1. **Extend the architecture with detailed decisions:**
   - **Authentication/authorization**: Strategy and implementation approach
   - **Error handling**: Strategy for errors, logging, monitoring
   - **Testing strategy**: Unit/integration/E2E split, framework choices
   - **Security**: Input validation, data protection, dependency management

2. **Build on foundational decisions:**
   - Reference the system architecture and data storage choices from Step 1
   - Ensure new decisions are compatible with existing ones
   - Don't contradict or repeat previous decisions

3. **Be concrete:**
   - "JWT with RS256 and 15-minute expiry" not "Use tokens"
   - "Vitest with 80% coverage threshold" not "Write tests"
   - Include rationale for each decision

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
architecture_decisions:
  - category: "crosscutting"
    key: "testing-strategy"
    value: "Vitest for unit and integration, no E2E needed for CLI"
    rationale: "Fast execution, native ESM support, compatible with TypeScript"
  - category: "crosscutting"
    key: "error-handling"
    value: "Structured error types with error codes, stderr for errors"
    rationale: "Machine-parseable errors enable automation and debugging"
  - category: "crosscutting"
    key: "logging"
    value: "Structured JSON logging to stderr, configurable verbosity"
    rationale: "Separates data output from diagnostic output"
```

If you cannot produce valid output:

```yaml
result: failed
```
