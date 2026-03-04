# Story 20.2: Research Prompt Templates and Output Schemas

Status: draft

## Story

As a pipeline operator,
I want research prompt templates and Zod output schemas,
so that the research phase can dispatch agents with validated structured output.

## Acceptance Criteria

### AC1: Discovery prompt template
**Given** the research phase executes step 1
**When** the prompt is rendered
**Then** it contains `{{concept}}` placeholder, instructs the agent to classify the concept and conduct web research across market, domain, and technical dimensions

### AC2: Synthesis prompt template
**Given** the research phase executes step 2
**When** the prompt is rendered
**Then** it contains `{{concept}}` and `{{raw_findings}}` placeholders and instructs the agent to synthesize findings into a structured brief

### AC3: Critique prompt template
**Given** the research phase triggers a critique loop
**When** the critique prompt is rendered
**Then** it evaluates research quality: source credibility, finding relevance, gap identification, and synthesis coherence

### AC4: Discovery output schema
**Given** the discovery agent completes
**When** its YAML output is validated
**Then** it passes the `ResearchDiscoveryOutputSchema` with fields: `result`, `concept_classification`, `market_findings`, `domain_findings`, `technical_findings`

### AC5: Synthesis output schema
**Given** the synthesis agent completes
**When** its YAML output is validated
**Then** it passes the `ResearchSynthesisOutputSchema` with fields: `result`, `market_context`, `competitive_landscape`, `technical_feasibility`, `risk_flags`, `opportunity_signals`

### AC6: Prompt registered in manifest
**Given** the pack manifest prompts section
**When** the manifest is loaded
**Then** `research-step-1-discovery`, `research-step-2-synthesis`, and `critique-research` are registered with paths to their prompt files

### AC7: Failed result path
**Given** the agent cannot produce valid research output
**When** it emits `result: failed`
**Then** the schema accepts the failed result without requiring content fields (optional fields pattern)

### AC8: Web search instruction
**Given** the discovery prompt is rendered
**When** the agent reads the prompt
**Then** it contains explicit instructions to use web search for real-time data, with a fallback instruction to perform concept analysis if web search is unavailable

## Tasks / Subtasks

- [ ] Task 1: Create `research-step-1-discovery.md` prompt template (AC: #1, #8)
  - [ ] Concept classification section (product vs internal tool, industry vertical, tech domain)
  - [ ] Web search instructions with 3-4 search query patterns per research type
  - [ ] Fallback instruction for when web search is unavailable
  - [ ] YAML output contract matching schema
- [ ] Task 2: Create `research-step-2-synthesis.md` prompt template (AC: #2)
  - [ ] Inject `{{concept}}` and `{{raw_findings}}` context
  - [ ] Synthesis instructions: market context, competitive landscape, technical feasibility, risks, opportunities
  - [ ] YAML output contract matching schema
- [ ] Task 3: Create `critique-research.md` prompt template (AC: #3)
  - [ ] Quality dimensions: source credibility, finding relevance, gap identification, synthesis coherence
  - [ ] Follow existing critique prompt structure (critique-analysis.md as reference)
  - [ ] YAML output matching CritiqueOutputSchema
- [ ] Task 4: Add Zod schemas to `schemas.ts` (AC: #4, #5, #7)
  - [ ] `ResearchDiscoveryOutputSchema` with optional content fields
  - [ ] `ResearchSynthesisOutputSchema` with optional content fields
  - [ ] Export types
- [ ] Task 5: Register prompts in `manifest.yaml` (AC: #6)
  - [ ] Add `research-step-1-discovery`, `research-step-2-synthesis`, `critique-research` to prompts section
- [ ] Task 6: Update critique prompt mapping in `critique-loop.ts` (AC: #3)
  - [ ] Add `research: 'critique-research'` to `getCritiquePromptName` mapping
- [ ] Task 7: Write schema validation tests (AC: #4, #5, #7)
  - [ ] Test valid discovery output parses
  - [ ] Test valid synthesis output parses
  - [ ] Test `result: failed` parses without content fields
  - [ ] Test invalid output is rejected
- [ ] Task 8: Write critique prompt structural tests (AC: #3)
  - [ ] Follow pattern from `critique-prompts.test.ts`
  - [ ] Verify YAML output contract, quality standards section, phase-specific content

## Dev Notes

### Architecture Constraints
- Prompt templates follow the exact pattern of existing step prompts (e.g., `ux-step-1-discovery.md`, `analysis-step-1-vision.md`)
- Output contracts MUST use the `result: success|failed` + optional content fields pattern
- All string values in YAML examples must be double-quoted (pipeline YAML parser requirement)
- Discovery prompt should instruct 3-4 web searches per research dimension (market, domain, technical) — ~12 searches total
- Critique prompt follows the structure in `critique-analysis.md`: quality standards section, YAML-only output, adversarial posture

### Key Files
- New: `packs/bmad/prompts/research-step-1-discovery.md`
- New: `packs/bmad/prompts/research-step-2-synthesis.md`
- New: `packs/bmad/prompts/critique-research.md`
- `src/modules/phase-orchestrator/phases/schemas.ts` — Zod schemas
- `src/modules/phase-orchestrator/critique-loop.ts` — critique prompt mapping
- `packs/bmad/manifest.yaml` — prompt registration

### Testing Requirements
- Zod schema validation tests (valid, failed, invalid cases)
- Critique prompt structural tests following `critique-prompts.test.ts` patterns

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
