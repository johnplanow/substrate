# Story 16.2: Multi-Step Phase Decomposition

Status: ready
Blocked-by: 16-1

## Story

As a pipeline architect,
I want each solutioning phase to execute as a sequence of focused steps (mirroring the BMAD interactive workflow structure),
so that each sub-agent dispatch has a bounded scope and produces higher-quality output through cumulative context building.

## Context

The BMAD interactive workflows break each phase into 4-14 sequential steps, each building on the previous step's output. The compiled pipeline currently fires a single prompt per phase, asking the LLM to produce an entire artifact in one shot. This leads to lower quality (no iterative refinement) and instability (architecture decisions flip between runs because the LLM is making too many decisions simultaneously). Decomposing phases into steps keeps each dispatch focused and allows the decision store to accumulate context incrementally.

## Acceptance Criteria

### AC1: Analysis Phase Multi-Step
**Given** the analysis phase executes
**When** the pipeline dispatches sub-agents
**Then** it runs at least 2 sequential steps: (1) vision + problem statement, (2) users + metrics + scope
**And** step 2 receives step 1's output as input context via the decision store

### AC2: Planning Phase Multi-Step
**Given** the planning phase executes
**When** the pipeline dispatches sub-agents
**Then** it runs at least 3 sequential steps: (1) project classification + vision, (2) functional requirements, (3) non-functional requirements + tech stack
**And** each step receives all prior steps' decisions as context
**And** the final step produces the complete PRD artifact

### AC3: Architecture Sub-Phase Multi-Step
**Given** the solutioning/architecture sub-phase executes
**When** the pipeline dispatches sub-agents
**Then** it runs at least 3 sequential steps: (1) project context + starter decisions, (2) core architecture decisions (data, auth, API, frontend, infra), (3) implementation patterns + project structure
**And** decisions from step 1 inform step 2, and both inform step 3

### AC4: Story Generation Sub-Phase Multi-Step
**Given** the solutioning/story-generation sub-phase executes
**When** the pipeline dispatches sub-agents
**Then** it runs at least 2 sequential steps: (1) epic design with FR coverage mapping, (2) story creation with acceptance criteria per epic
**And** step 1's epic structure guides step 2's story creation

### AC5: Step Prompt Templates
**Given** a multi-step phase is configured
**When** the pipeline loads prompt templates
**Then** each step has its own prompt template in the methodology pack (`packs/bmad/prompts/`)
**And** templates use `{{placeholder}}` syntax for injected context from prior steps
**And** the pack manifest maps step names to template files

### AC6: Step Context Passing via Decision Store
**Given** step N completes and stores decisions
**When** step N+1 begins
**Then** it reads step N's decisions from the decision store (not from a growing prompt)
**And** each step's prompt size remains bounded regardless of how many prior steps ran

### AC7: Backward Compatibility
**Given** existing pipeline runs that used the single-dispatch model
**When** the multi-step model is deployed
**Then** existing artifacts and decisions in the database remain valid
**And** `substrate auto status` continues to report correctly

## Dev Notes

### Architecture

- New files: `packs/bmad/prompts/analysis-step-1-vision.md`, `analysis-step-2-scope.md`
- New files: `packs/bmad/prompts/planning-step-1-classification.md`, `planning-step-2-frs.md`, `planning-step-3-nfrs.md`
- New files: `packs/bmad/prompts/architecture-step-1-context.md`, `architecture-step-2-decisions.md`, `architecture-step-3-patterns.md`
- New files: `packs/bmad/prompts/stories-step-1-epics.md`, `stories-step-2-stories.md`

- Modified: `packs/bmad/manifest.yaml`
  - Add `steps` array to each phase definition mapping step names to prompt templates

- Modified: `src/modules/phase-orchestrator/phases/analysis.ts`
  - Refactor from single dispatch to step loop reading from manifest

- Modified: `src/modules/phase-orchestrator/phases/planning.ts`
  - Refactor from single dispatch to step loop

- Modified: `src/modules/phase-orchestrator/phases/solutioning.ts`
  - Refactor architecture and story sub-phases into step loops

- New file: `src/modules/phase-orchestrator/step-runner.ts`
  - Shared step execution logic: load template → inject context from decision store → dispatch → parse → store decisions → register artifact if final step

### Step Context Injection Pattern

Each step template declares what context it needs:
```yaml
# In manifest.yaml
phases:
  analysis:
    steps:
      - name: vision
        template: analysis-step-1-vision.md
        context: [concept]
      - name: scope
        template: analysis-step-2-scope.md
        context: [concept, analysis.vision]
```

The step runner resolves `context` entries from the decision store, formats them, and injects into the template's `{{placeholders}}`.

## Tasks

- [ ] Design step runner abstraction (`step-runner.ts`) (AC5, AC6)
- [ ] Create analysis step prompt templates (AC1)
- [ ] Create planning step prompt templates (AC2)
- [ ] Create architecture step prompt templates (AC3)
- [ ] Create story generation step prompt templates (AC4)
- [ ] Update pack manifest with step definitions (AC5)
- [ ] Refactor analysis phase to use step runner (AC1)
- [ ] Refactor planning phase to use step runner (AC2)
- [ ] Refactor solutioning phase to use step runner (AC3, AC4)
- [ ] Implement decision store context injection (AC6)
- [ ] Write unit tests for step runner
- [ ] Write integration test for multi-step analysis phase
- [ ] Write integration test for multi-step solutioning phase
- [ ] Verify backward compatibility with existing pipeline data (AC7)
