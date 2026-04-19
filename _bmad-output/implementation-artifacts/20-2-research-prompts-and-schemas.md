# Story 20.2: Research Prompt Templates and Output Schemas

Status: ready-for-dev

## Story

As a pipeline operator,
I want research prompt templates and Zod output schemas,
so that the research phase can dispatch agents with validated structured output.

## Acceptance Criteria

### AC1: Discovery prompt template
**Given** the research phase executes step 1
**When** the prompt is rendered with a `{{concept}}` value
**Then** it instructs the agent to classify the concept and conduct web research across market, domain, and technical dimensions, and outputs YAML matching `ResearchDiscoveryOutputSchema`

### AC2: Synthesis prompt template
**Given** the research phase executes step 2
**When** the prompt is rendered
**Then** it contains both `{{concept}}` and `{{raw_findings}}` placeholders and instructs the agent to synthesize findings into market context, competitive landscape, technical feasibility, risk flags, and opportunity signals

### AC3: Critique prompt template
**Given** the research phase triggers a critique loop
**When** the critique prompt is rendered with `{{artifact_content}}` and `{{project_context}}`
**Then** it adopts an adversarial reviewer persona, defines quality standards for research artifacts (source credibility, finding relevance, gap identification, synthesis coherence), and specifies the standard YAML output contract with `verdict`, `issue_count`, and `issues`

### AC4: Discovery output schema
**Given** the discovery agent completes successfully
**When** its YAML output is validated against `ResearchDiscoveryOutputSchema`
**Then** it passes with required fields: `result`, `concept_classification`, `market_findings`, `domain_findings`, `technical_findings` — all content fields optional to permit `result: failed` without rejection

### AC5: Synthesis output schema
**Given** the synthesis agent completes successfully
**When** its YAML output is validated against `ResearchSynthesisOutputSchema`
**Then** it passes with required fields: `result`, `market_context`, `competitive_landscape`, `technical_feasibility`, `risk_flags`, `opportunity_signals` — all content fields optional to permit `result: failed` without rejection

### AC6: Prompts registered in manifest
**Given** the pack manifest prompts section
**When** the manifest is loaded by `MethodologyPack.getPrompt()`
**Then** `research-step-1-discovery`, `research-step-2-synthesis`, and `critique-research` are registered and resolve to their respective files under `packs/bmad/prompts/`

### AC7: Failed result path
**Given** the agent cannot produce valid research output
**When** it emits `result: "failed"` without any content fields
**Then** both `ResearchDiscoveryOutputSchema` and `ResearchSynthesisOutputSchema` accept the minimal object without Zod rejection

### AC8: Web search instruction with fallback
**Given** the discovery prompt is rendered
**When** the agent reads the prompt
**Then** it contains explicit instructions to perform web searches (3–4 query patterns per research dimension: market, domain, technical), plus a fallback instruction stating that if web search is unavailable the agent should perform concept analysis from training knowledge

## Tasks / Subtasks

- [ ] Task 1: Create `packs/bmad/prompts/research-step-1-discovery.md` (AC: #1, #8)
  - [ ] Add `{{concept}}` placeholder in the Context section
  - [ ] Add concept classification section (product vs internal tool, industry vertical, tech domain)
  - [ ] Add web search instructions with 3–4 query patterns per dimension (market, domain, technical) — ~12 searches total
  - [ ] Add explicit fallback instruction for when web search is unavailable
  - [ ] Add Output Contract with YAML block matching `ResearchDiscoveryOutputSchema` — all string values double-quoted
  - [ ] Add failure path: `result: "failed"` without content fields

- [ ] Task 2: Create `packs/bmad/prompts/research-step-2-synthesis.md` (AC: #2)
  - [ ] Add `{{concept}}` and `{{raw_findings}}` placeholders in the Context section
  - [ ] Add synthesis instructions covering: market_context, competitive_landscape, technical_feasibility, risk_flags, opportunity_signals
  - [ ] Add Output Contract with YAML block matching `ResearchSynthesisOutputSchema` — all string values double-quoted
  - [ ] Add failure path: `result: "failed"` without content fields

- [ ] Task 3: Create `packs/bmad/prompts/critique-research.md` (AC: #3)
  - [ ] Add `{{artifact_content}}` and `{{project_context}}` placeholders (required by `critique-loop.ts`)
  - [ ] Add adversarial reviewer persona ("Your job is to find what's wrong...")
  - [ ] Add Quality Standards section with 4 dimensions: Source Credibility, Finding Relevance, Gap Identification, Synthesis Coherence
  - [ ] Add Instructions section with severity classification (blocker / major / minor)
  - [ ] Add Output Contract with both `verdict: pass` and `verdict: needs_work` YAML examples
  - [ ] Include all required issue fields: `severity`, `category`, `description`, `suggestion`
  - [ ] Follow `critique-analysis.md` structure exactly (same section order, same tone)

- [ ] Task 4: Add Zod schemas to `src/modules/phase-orchestrator/phases/schemas.ts` (AC: #4, #5, #7)
  - [ ] Add `ResearchDiscoveryOutputSchema`: `result: z.enum(['success', 'failed'])`, plus optional `concept_classification: z.string().optional()`, `market_findings: z.string().optional()`, `domain_findings: z.string().optional()`, `technical_findings: z.string().optional()`
  - [ ] Export `ResearchDiscoveryOutputSchemaType = z.infer<typeof ResearchDiscoveryOutputSchema>`
  - [ ] Add `ResearchSynthesisOutputSchema`: `result: z.enum(['success', 'failed'])`, plus optional `market_context: z.string().optional()`, `competitive_landscape: z.string().optional()`, `technical_feasibility: z.string().optional()`, `risk_flags: z.array(z.string()).default([])`, `opportunity_signals: z.array(z.string()).default([])`
  - [ ] Export `ResearchSynthesisOutputSchemaType = z.infer<typeof ResearchSynthesisOutputSchema>`
  - [ ] Add section header comment `// Research phase schemas (Story 20-2)` to group with other phase schemas

- [ ] Task 5: Register prompts in `packs/bmad/manifest.yaml` (AC: #6)
  - [ ] Add under `prompts:` section, after the existing critique prompts block:
    ```yaml
    # Research phase prompts (Story 20-2)
    research-step-1-discovery: prompts/research-step-1-discovery.md
    research-step-2-synthesis: prompts/research-step-2-synthesis.md
    critique-research: prompts/critique-research.md
    ```

- [ ] Task 6: Update critique prompt mapping in `src/modules/phase-orchestrator/critique-loop.ts` (AC: #3, #6)
  - [ ] Add `research: 'critique-research'` entry to the `mapping` object inside `getCritiquePromptName()`
  - [ ] Entry must appear alongside existing phase mappings (analysis, planning, solutioning, architecture, stories)

- [ ] Task 7: Write Zod schema validation tests (AC: #4, #5, #7)
  - [ ] Create `src/modules/phase-orchestrator/phases/__tests__/research-schemas.test.ts`
  - [ ] Import `ResearchDiscoveryOutputSchema` and `ResearchSynthesisOutputSchema` from `../schemas.js`
  - [ ] Test: valid discovery output (all fields present) parses without error
  - [ ] Test: valid synthesis output (all fields present) parses without error
  - [ ] Test: `{ result: 'failed' }` parses successfully for both schemas (no content fields required)
  - [ ] Test: `{ result: 'invalid' }` is rejected by both schemas (invalid enum value)
  - [ ] Test: `risk_flags` and `opportunity_signals` default to `[]` when omitted from synthesis schema

- [ ] Task 8: Write critique prompt structural tests (AC: #3)
  - [ ] Add `critique-research` test case to `src/modules/phase-orchestrator/__tests__/critique-prompts.test.ts`
  - [ ] Call `assertCritiqueStructure(content, 'critique-research.md')` to verify all required structural elements
  - [ ] Additionally assert that research-specific quality dimensions are present: `source-credibility` (or `source credibility`), `finding-relevance` (or `finding relevance`), `gap` (gap identification), `synthesis`

## Dev Notes

### Architecture Constraints
- **Prompt template format**: Follow `packs/bmad/prompts/ux-step-1-discovery.md` and `critique-analysis.md` exactly — same section structure (Context → Mission → Instructions → Output Contract)
- **Double-quoted strings**: All YAML string values in prompt Output Contract examples MUST use double quotes (e.g., `market_context: "B2B SaaS market..."`) — pipeline YAML parser requirement
- **Optional content fields pattern**: All schema content fields must be `.optional()` so `{ result: 'failed' }` passes validation — this is the universal pattern in `schemas.ts`
- **`risk_flags` / `opportunity_signals`**: Use `z.array(z.string()).default([])` (not `.optional()`) because these are list fields that should default to empty array, matching `AnalysisScopeOutputSchema.constraints` pattern
- **Schema file**: Add ONLY to `src/modules/phase-orchestrator/phases/schemas.ts` — do not create a separate file
- **Critique loop mapping**: `getCritiquePromptName()` in `src/modules/phase-orchestrator/critique-loop.ts` uses a plain object map; add `research: 'critique-research'` as a new key-value pair
- **Manifest format**: `prompts:` section uses flat `key: path` format (no nesting); no phase entry needed in this story — that is added in Story 20-3

### Key Files

#### New files to create
- `packs/bmad/prompts/research-step-1-discovery.md` — Discovery prompt (concept + web search)
- `packs/bmad/prompts/research-step-2-synthesis.md` — Synthesis prompt (raw findings → structured brief)
- `packs/bmad/prompts/critique-research.md` — Research critique prompt
- `src/modules/phase-orchestrator/phases/__tests__/research-schemas.test.ts` — Schema validation tests

#### Files to modify
- `src/modules/phase-orchestrator/phases/schemas.ts` — Add `ResearchDiscoveryOutputSchema` and `ResearchSynthesisOutputSchema` with types
- `src/modules/phase-orchestrator/critique-loop.ts` — Add `research: 'critique-research'` to `getCritiquePromptName()` mapping (line ~68–76)
- `packs/bmad/manifest.yaml` — Add 3 prompt registrations after the existing critique prompts block (line ~188–191)
- `src/modules/phase-orchestrator/__tests__/critique-prompts.test.ts` — Add `critique-research` structural test

### Schema Reference (exact Zod patterns to use)

```typescript
// Research phase schemas (Story 20-2)

export const ResearchDiscoveryOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  concept_classification: z.string().optional(),
  market_findings: z.string().optional(),
  domain_findings: z.string().optional(),
  technical_findings: z.string().optional(),
})

export type ResearchDiscoveryOutputSchemaType = z.infer<typeof ResearchDiscoveryOutputSchema>

export const ResearchSynthesisOutputSchema = z.object({
  result: z.enum(['success', 'failed']),
  market_context: z.string().optional(),
  competitive_landscape: z.string().optional(),
  technical_feasibility: z.string().optional(),
  risk_flags: z.array(z.string()).default([]),
  opportunity_signals: z.array(z.string()).default([]),
})

export type ResearchSynthesisOutputSchemaType = z.infer<typeof ResearchSynthesisOutputSchema>
```

### Manifest Registration Reference (exact lines to add)

After line ~191 in `packs/bmad/manifest.yaml` (after `refine-artifact` and `readiness-check` entries):

```yaml
  # Research phase prompts (Story 20-2)
  research-step-1-discovery: prompts/research-step-1-discovery.md
  research-step-2-synthesis: prompts/research-step-2-synthesis.md
  critique-research: prompts/critique-research.md
```

### Critique Loop Mapping Reference (exact change in critique-loop.ts)

In `getCritiquePromptName()`, add one entry to the `mapping` object:

```typescript
const mapping: Record<string, string> = {
  analysis: 'critique-analysis',
  planning: 'critique-planning',
  solutioning: 'critique-architecture',
  architecture: 'critique-architecture',
  stories: 'critique-stories',
  research: 'critique-research',   // <-- ADD THIS
}
```

### Testing Requirements
- **Test framework**: vitest (NOT jest) — `import { describe, it, expect } from 'vitest'`
- **Schema tests**: Import from `'../schemas.js'` (not `.ts`) — ESM with explicit `.js` extension
- **Critique prompt tests**: Add to existing `critique-prompts.test.ts` using the shared `assertCritiqueStructure()` helper already defined in that file
- **Coverage**: The 80% coverage threshold is enforced — all new code paths must be tested
- **No agent dispatch**: Schema tests and prompt structural tests are static — no mock dispatchers needed

### Discovery Prompt Design Notes
The discovery prompt should structure web searches as explicit search tasks:
- Market dimension: `"{{concept}} market size"`, `"{{concept}} target customers"`, `"{{concept}} pricing models"`, `"{{concept}} market trends 2025"`
- Domain dimension: `"{{concept}} best practices"`, `"{{concept}} industry standards"`, `"{{concept}} regulatory requirements"`, `"{{concept}} use cases"`
- Technical dimension: `"{{concept}} technical architecture"`, `"{{concept}} technology stack"`, `"{{concept}} open source alternatives"`, `"{{concept}} implementation challenges"`

Fallback text (when web search unavailable): "If web search is unavailable in your environment, proceed with concept analysis using your training knowledge — acknowledge that findings may not reflect the latest market conditions."

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
