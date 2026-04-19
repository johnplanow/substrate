# Story 16.3: Automated Elicitation Rounds

Status: ready
Blocked-by: 16-2

## Story

As a pipeline operator,
I want the pipeline to automatically run 1-2 advanced elicitation methods after key phase steps,
so that artifacts benefit from structured critical thinking (First Principles, Pre-mortem, Red Team, etc.) without requiring human interaction.

## Context

The BMAD interactive workflows offer advanced elicitation (A/P/C menu) at 39+ points across the full solutioning flow. Users who select "A" invoke methods from a 50-method library organized into 10 categories (collaboration, advanced reasoning, competitive, technical, creative, research, risk, core, learning, philosophical). The compiled pipeline currently runs zero elicitation. This story ports the elicitation capability into an automated form: the pipeline analyzes context to auto-select the most impactful methods, then dispatches a sub-agent to apply them.

## Acceptance Criteria

### AC1: Elicitation Method Registry
**Given** the pipeline needs to select elicitation methods
**When** it loads the method registry
**Then** it reads from `packs/bmad/data/elicitation-methods.csv` (copied from `_bmad/core/workflows/advanced-elicitation/methods.csv`)
**And** each method has: name, category, description, output_pattern
**And** the registry contains all 50 methods from the BMAD library

### AC2: Context-Aware Method Selection
**Given** a phase step has completed and produced an artifact
**When** the pipeline decides which elicitation methods to apply
**Then** it analyzes: content type (brief/PRD/architecture/stories), domain complexity, risk level, and which categories have not been used recently
**And** it selects 1-2 methods that best match the context
**And** selection prefers higher-impact categories for the content type (e.g., `risk` methods for architecture, `core` methods for requirements)

### AC3: Elicitation Dispatch
**Given** 1-2 methods have been selected
**When** the elicitation sub-agent is dispatched
**Then** the prompt includes: the artifact content to enhance, the method name and description, the method's output_pattern, and instructions to apply the method and return enhanced content
**And** the dispatch uses task type `elicitation` with appropriate max turns and timeout

### AC4: Elicitation Output Integration
**Given** the elicitation agent returns enhanced content
**When** the pipeline processes the output
**Then** elicitation insights are stored in the decision store with category `elicitation` and a key referencing the source step
**And** the next step (refinement) receives the elicitation insights as additional context

### AC5: Elicitation Points Configuration
**Given** the pack manifest defines phase steps
**When** a step is marked with `elicitate: true`
**Then** automated elicitation runs after that step completes
**And** the default configuration applies elicitation after: analysis step 1 (vision), planning step 2 (FRs), architecture step 2 (core decisions), and stories step 1 (epic design)

### AC6: Elicitation Method Rotation
**Given** multiple elicitation rounds run across a pipeline execution
**When** methods are selected for a later round
**Then** methods used in earlier rounds are deprioritized
**And** the pipeline rotates across categories to ensure diverse perspectives

### AC7: Cost Tracking
**Given** elicitation dispatches consume tokens
**When** elicitation completes
**Then** the token cost is tracked separately from the main phase steps
**And** elicitation cost is included in the pipeline run summary

## Dev Notes

### Architecture

- New file: `src/modules/phase-orchestrator/elicitation-selector.ts`
  - `selectMethods(context: ElicitationContext, usedMethods: string[]): ElicitationMethod[]`
  - Context includes: content_type, domain_keywords, complexity_score, risk_level
  - Selection algorithm: score each method by category relevance × recency penalty → pick top 1-2

- New file: `packs/bmad/data/elicitation-methods.csv`
  - Copy of `_bmad/core/workflows/advanced-elicitation/methods.csv`

- New file: `packs/bmad/prompts/elicitation-apply.md`
  - Template: "Apply the {{method_name}} method to the following content: {{artifact_content}}. Method: {{method_description}}. Output pattern: {{output_pattern}}. Return enhanced content with insights clearly marked."

- Modified: `src/modules/phase-orchestrator/step-runner.ts`
  - After step execution, check `elicitate: true` flag → run elicitation selector → dispatch elicitation agent → store results

- Modified: `packs/bmad/manifest.yaml`
  - Add `elicitate: true` flag on target steps

### Method-to-Phase Affinity Matrix

| Phase | Preferred Categories | Example Methods |
|-------|---------------------|-----------------|
| Analysis | core, collaboration, creative | First Principles, Stakeholder Round Table, What If Scenarios |
| Planning | risk, core, research | Pre-mortem, 5 Whys, Comparative Analysis Matrix |
| Architecture | technical, competitive, risk | Red Team vs Blue Team, ADR method, Failure Mode Analysis |
| Stories | collaboration, risk | Expert Panel Review, Pre-mortem Analysis |

## Tasks

- [ ] Copy elicitation methods CSV to pack data directory (AC1)
- [ ] Implement elicitation method selector with context analysis (AC2)
- [ ] Implement method rotation / deduplication across rounds (AC6)
- [ ] Create elicitation prompt template (AC3)
- [ ] Integrate elicitation dispatch into step runner (AC3, AC4)
- [ ] Add `elicitate` flag to pack manifest steps (AC5)
- [ ] Store elicitation results in decision store (AC4)
- [ ] Add elicitation cost tracking (AC7)
- [ ] Write unit tests for method selection algorithm
- [ ] Write unit tests for elicitation integration in step runner
- [ ] Write integration test for end-to-end elicitation round
