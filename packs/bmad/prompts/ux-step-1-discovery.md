# BMAD UX Design Step 1: Discovery + Core Experience

## Context (pre-assembled by pipeline)

### Product Brief (from Analysis Phase)
{{product_brief}}

### Requirements (from Planning Phase)
{{requirements}}

---

## Mission

Conduct a thorough **UX discovery** for this product. Your goal is to define:
1. The target user personas and their goals
2. The core experience vision — what should it feel like to use this product?
3. Emotional response targets — what emotions should users feel?
4. Inspiration references — existing products, design patterns, or aesthetics to reference

This is the foundation for all subsequent UX design decisions. Be specific and user-centered.

## Instructions

1. **Define target personas** (2-4 personas):
   - Name + role (e.g., "Alex, startup founder")
   - Primary goal when using this product
   - Key frustrations the product should solve
   - Technical comfort level

2. **Articulate the core experience vision**:
   - What is the ONE sentence that captures how users should experience this product?
   - Example: "Effortless, like having a brilliant assistant who anticipates your needs"

3. **Set emotional response targets** (3-5 emotional goals):
   - What should users feel when they first open the product?
   - What should they feel after completing a key task?
   - Example: "Confident, not overwhelmed; Surprised by how fast it works"

4. **Identify inspiration references** (2-4 references):
   - Products, apps, or design systems whose UX quality to emulate
   - What specifically to borrow (interaction model, visual clarity, information density)

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
target_personas:
  - "Alex (startup founder): wants rapid iteration; frustrated by slow dev tools; high technical comfort"
  - "Sam (product manager): needs clear status visibility; frustrated by context-switching; moderate technical comfort"
core_experience: "Instant clarity — every action produces visible, understandable results within seconds"
emotional_goals:
  - "Empowered: users feel in control of a complex process"
  - "Focused: the interface surfaces only what matters right now"
  - "Confident: clear feedback means users always know what's happening"
inspiration_references:
  - "Linear.app: information density and keyboard-first workflow"
  - "Raycast: speed and discoverability without cognitive overload"
```

If you cannot produce valid output:

```yaml
result: failed
```
