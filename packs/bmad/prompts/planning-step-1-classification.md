# BMAD Planning Step 1: Project Classification

## Context (pre-assembled by pipeline)

### Product Brief (from Analysis Phase)
{{product_brief}}

---

## Mission

Classify the project and establish a clear **vision statement** with key goals. This classification guides the depth and structure of subsequent planning steps (requirements, tech stack, domain model).

## Instructions

1. **Classify the project type:**
   - What kind of software is this? (CLI tool, web app, API service, mobile app, library, platform, etc.)
   - Be specific — "TypeScript CLI tool" not just "application"

2. **Write a vision statement:**
   - One paragraph capturing the aspirational end-state
   - What does the world look like when this product succeeds?
   - Should inspire and constrain — broad enough to motivate, specific enough to guide decisions

3. **Define key goals (3-5):**
   - Concrete, prioritized goals that the project must achieve
   - Each goal should be achievable and verifiable
   - Order by priority — most critical first

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes. All array items MUST be plain strings.

```yaml
result: success
project_type: "TypeScript CLI tool for personal productivity"
vision: "A lightweight, terminal-native habit tracker that makes consistency visible and rewarding for developers who live in their terminals."
key_goals:
  - "Provide instant habit tracking without leaving the terminal"
  - "Make streak data visible to motivate daily consistency"
  - "Zero-config setup with local-first data storage"
```

If you cannot produce valid output:

```yaml
result: failed
```
