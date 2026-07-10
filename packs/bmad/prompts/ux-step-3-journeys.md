# BMAD UX Design Step 3: User Journeys + Component Strategy + Accessibility

## Context (pre-assembled by pipeline)

### Product Brief (from Analysis Phase)
{{product_brief}}

### Requirements (from Planning Phase)
{{requirements}}

### UX Discovery (from Step 1)
{{ux_discovery}}

### Design System (from Step 2)
{{design_system}}

---

## Mission

Complete the UX design by mapping **user journeys**, defining the **component strategy**, identifying key **UX patterns**, and establishing **accessibility and responsive design guidelines**.

## Instructions

1. **Map 2-4 critical user journeys** (STRUCTURED — these seed the acceptance-gate journey registry):
   - Each journey covers a key workflow from the user's perspective
   - Emit each as a structured entry: stable `id` (`UJ-<n>` in order), actor-first one-line `title`, `criticality` (`critical` ONLY for the product's reason-to-exist paths — the demo path, the core loop; `standard` otherwise), `surfaces` where the user experiences it (only `email` | `cli` | `file` | `web`), and a prose `walk` ("Entry point → Steps → Success state")
   - Focus on the 2-4 highest-value workflows from the requirements
   - A journey omitted here is invisible to downstream acceptance checks — when in doubt, include it

2. **Define the component strategy**:
   - What are the 3-5 most complex/critical UI components to design first?
   - For each: name, purpose, key interactions, and data requirements
   - Example: "Pipeline status dashboard: real-time progress visualization with expandable step details"

3. **Identify 3-5 key UX patterns**:
   - Specific interaction patterns that recur across the product
   - Example: "Optimistic updates: apply changes immediately, roll back on error"
   - Example: "Command palette (Cmd+K): global action access without navigation"
   - Example: "Toast notifications: transient feedback for async operations"

4. **Establish accessibility and responsive design guidelines**:
   - WCAG target level (AA recommended minimum)
   - Keyboard navigation requirements
   - Screen reader support priorities
   - Responsive breakpoints and mobile strategy (mobile-first? adaptive? PWA?)
   - Example: "WCAG AA minimum. Full keyboard navigation for all core flows. ARIA labels on all interactive elements. Mobile-responsive at 320px+ breakpoints."

## Output Contract

Emit ONLY this YAML block as your final output — no other text.

**CRITICAL**: All string values MUST be quoted with double quotes.

```yaml
result: success
user_journeys:
  - id: "UJ-1"
    title: "New user runs the pipeline for the first time"
    criticality: "critical"
    surfaces: ["cli"]
    walk: "User installs CLI → runs 'substrate init' → provides project concept → pipeline starts automatically → watches real-time progress → reviews results"
  - id: "UJ-2"
    title: "User resumes after a failed story"
    criticality: "standard"
    surfaces: ["cli"]
    walk: "User sees failed story → inspects error → runs 'substrate resume' → pipeline retries from last checkpoint → completes successfully"
  - id: "UJ-3"
    title: "User amends an existing run's direction"
    criticality: "standard"
    surfaces: ["cli"]
    walk: "User runs 'substrate amend --concept ...' → sees diff of changes → approves → pipeline re-runs affected phases"
component_strategy: "Priority components: (1) Pipeline status view — hierarchical phase/story progress with real-time updates; (2) Story detail panel — structured view of AC, tasks, and test results; (3) Error inspector — contextual error display with suggested fixes"
ux_patterns:
  - "Streaming output: display pipeline logs in real-time with ANSI color preservation"
  - "Progressive detail: collapsed by default, expand on demand"
  - "Inline error recovery: show fix suggestions adjacent to failure context"
  - "Persistent state: remember last run context across sessions"
accessibility_guidelines:
  - "WCAG AA compliance minimum"
  - "Full keyboard navigation for all interactive elements"
  - "High-contrast mode support via prefers-color-scheme"
  - "Reduced motion media query respected for animations"
  - "ARIA live regions for streaming output updates"
  - "Mobile-responsive at 320px minimum width"
```

If you cannot produce valid output:

```yaml
result: failed
```
