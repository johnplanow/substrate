# BMAD UX Design Step 2: Design System + Visual Foundation

## Context (pre-assembled by pipeline)

### Product Brief (from Analysis Phase)
{{product_brief}}

### Requirements (from Planning Phase)
{{requirements}}

### UX Discovery (from Step 1)
{{ux_discovery}}

---

## Mission

Build on the UX discovery to define the **design system and visual foundation** for this product. Your goal is to establish the design language that will guide all UI development decisions.

## Instructions

1. **Define the design system approach**:
   - Should this product use an existing component library (e.g., shadcn/ui, MUI, Chakra) or custom?
   - What is the rationale based on the target personas and core experience vision?
   - Example: "shadcn/ui with Tailwind CSS — minimal overhead, full customization, matches developer-focused audience"

2. **Establish the visual foundation** — the overall aesthetic:
   - Layout philosophy: spacious or dense? Grid or freeform?
   - Motion: animated transitions or static? Micro-interactions?
   - Personality: professional/corporate, playful/approachable, technical/utilitarian?

3. **Define 3-5 design principles**:
   - Short, actionable statements that guide UI decisions
   - Example: "Progressive disclosure: show complexity only when needed"
   - Example: "Keyboard first: every action reachable without a mouse"

4. **Specify color and typography direction**:
   - Color palette: light/dark mode? Primary accent color family?
   - Typography: serif, sans-serif, monospace for code? Specific families if known?
   - Example: "Dark-mode-first with neutral gray base, blue accent. Inter for UI, JetBrains Mono for code"

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
design_system: "shadcn/ui with Tailwind CSS — provides accessible, composable primitives with full design token control"
visual_foundation: "Dense-information layout with generous whitespace at page level. Subtle motion for state changes only. Technical-utilitarian personality with warm accents to reduce coldness."
design_principles:
  - "Progressive disclosure: surface complexity only when the user requests it"
  - "Keyboard-first: every interaction is achievable without a mouse"
  - "Visible state: system status is always visible, never hidden"
  - "Consistent feedback: every action produces an immediate, unambiguous response"
color_and_typography: "Dark-mode primary with light-mode option. Slate gray base with indigo accent. Inter 400/500/600 for UI text, JetBrains Mono for code and terminal output."
```

If you cannot produce valid output:

```yaml
result: failed
```
