# Story 16.5: Optional UX Design Phase

Status: review
Blocked-by: 16-2

## Story

As a pipeline operator,
I want the pipeline to optionally run a UX design phase between planning and architecture,
so that user experience considerations inform architecture decisions — matching the BMAD interactive workflow where UX design is a dedicated stage.

## Context

The BMAD interactive workflow includes a 14-step UX design workflow (`create-ux-design`) covering discovery, core experience, emotional response, design system, visual foundation, user journeys, component strategy, UX patterns, and responsive/accessibility concerns. The compiled pipeline skips this entirely. For UI-heavy projects (web apps, mobile, dashboards), this is a significant quality gap — architecture decisions about frontend frameworks, component libraries, and rendering approaches are made without UX input. This story adds UX design as an optional, configurable phase.

## Acceptance Criteria

### AC1: UX Design Phase Registration
**Given** the phase orchestrator loads built-in phases
**When** UX design is enabled in the pack manifest
**Then** a `ux-design` phase is registered between `planning` and `solutioning`
**And** entry gate: `prd` artifact exists
**And** exit gate: `ux-design` artifact exists

### AC2: UX Design Phase Steps
**Given** the UX design phase executes
**When** the pipeline dispatches sub-agents
**Then** it runs at least 3 sequential steps: (1) UX discovery + core experience, (2) design system + visual foundation, (3) user journeys + component strategy + accessibility
**And** each step builds on prior step decisions via the decision store

### AC3: UX Design Prompt Templates
**Given** the UX design phase needs prompt templates
**When** the pack is loaded
**Then** `packs/bmad/prompts/ux-step-1-discovery.md`, `ux-step-2-design-system.md`, `ux-step-3-journeys.md` exist
**And** templates inject `{{product_brief}}` and `{{requirements}}` from prior phases

### AC4: Pack Manifest Configuration
**Given** a methodology pack defines its phases
**When** the pack author wants to enable or disable UX design
**Then** the manifest includes `uxDesign: true|false` (default: `false`)
**And** when `false`, the phase is skipped and solutioning proceeds without it
**And** when `true`, the phase runs and its decisions are available to architecture

### AC5: Architecture Receives UX Context
**Given** UX design phase completed and stored decisions
**When** the architecture sub-phase assembles its prompt
**Then** UX design decisions are injected alongside requirements
**And** the architecture prompt template includes a `{{ux_decisions}}` placeholder

### AC6: Elicitation and Critique Integration
**Given** the UX design phase has steps with `elicitate: true` or `critique: true` flags
**When** those steps complete
**Then** automated elicitation and/or critique-refine loops run (per stories 16-3 and 16-4)
**And** UX-appropriate elicitation methods are preferred (e.g., User Persona Focus Group, SCAMPER)

### AC7: Phase Skippable at Runtime
**Given** a project has `uxDesign: true` in the pack manifest
**When** the operator runs `substrate auto run --skip-ux`
**Then** the UX design phase is skipped for that run
**And** no `ux-design` artifact gate blocks solutioning (the gate is conditionally applied)

## Dev Notes

### Architecture

- New file: `src/modules/phase-orchestrator/phases/ux-design.ts`
  - Follows same pattern as `analysis.ts`, `planning.ts`
  - Reads step definitions from pack manifest
  - Uses step runner for sequential dispatch

- New files: `packs/bmad/prompts/ux-step-1-discovery.md`, `ux-step-2-design-system.md`, `ux-step-3-journeys.md`

- Modified: `src/modules/phase-orchestrator/built-in-phases.ts`
  - Add `ux-design` phase with conditional registration based on pack config

- Modified: `src/modules/phase-orchestrator/phase-orchestrator-impl.ts`
  - Support conditional phase insertion in `phaseOrder`
  - Handle `--skip-ux` flag

- Modified: `packs/bmad/manifest.yaml`
  - Add `uxDesign: true` and UX step definitions

- Modified: `packs/bmad/prompts/architecture-step-2-decisions.md`
  - Add `{{ux_decisions}}` placeholder (empty string when UX phase was skipped)

- Modified: `src/cli/commands/auto.ts`
  - Add `--skip-ux` flag to `auto run` command

### UX Step Content Mapping (from BMAD 14-step workflow → 3 compiled steps)

| Compiled Step | BMAD Steps Covered |
|---------------|-------------------|
| Step 1: Discovery + Core Experience | Steps 2-5 (discovery, core experience, emotional response, inspiration) |
| Step 2: Design System + Visual | Steps 6-9 (design system, defining experience, visual foundation, design directions) |
| Step 3: Journeys + Components + A11y | Steps 10-13 (user journeys, component strategy, UX patterns, responsive/accessibility) |

## Tasks

- [ ] Create UX design phase implementation (`ux-design.ts`) (AC1, AC2)
- [ ] Create 3 UX step prompt templates (AC3)
- [ ] Add `uxDesign` flag and UX steps to pack manifest (AC4)
- [ ] Register UX design as conditional phase in `built-in-phases.ts` (AC1)
- [ ] Add UX context injection to architecture prompt (AC5)
- [ ] Mark UX steps for elicitation and critique (AC6)
- [ ] Add `--skip-ux` CLI flag (AC7)
- [ ] Write unit tests for conditional phase registration
- [ ] Write unit tests for UX phase step execution
- [ ] Write integration test for full pipeline with UX enabled
- [ ] Write integration test for pipeline with UX skipped
