# Story 20.4: Research Context Injection into Analysis

Status: ready-for-dev

## Story

As a pipeline operator,
I want research findings injected into the analysis phase as optional context,
so that product vision and scope are grounded in evidence when research data is available.

## Acceptance Criteria

### AC1: Context wiring in manifest
**Given** the manifest step definition for `analysis-step-1-vision`
**When** research is enabled and the step context is resolved
**Then** a `{{research_findings}}` placeholder is injected from `decision:research.findings`

### AC2: Graceful absence
**Given** research is disabled (no research findings in decision store)
**When** the analysis step 1 prompt is rendered
**Then** `{{research_findings}}` resolves to empty string and the prompt works exactly as it does today

### AC3: Prompt template updated
**Given** the `analysis-step-1-vision.md` prompt template
**When** research findings are present
**Then** the prompt contains a "Research Context" section with the findings, instructing the agent to ground its vision analysis in evidence

### AC4: Prompt template unchanged path
**Given** the `analysis-step-1-vision.md` prompt template
**When** research findings are absent (empty string)
**Then** the "Research Context" section is omitted or empty, and the prompt produces the same output quality as before

### AC5: Decision store read
**Given** research phase completed and wrote to `research.findings`
**When** analysis step 1 resolves `decision:research.findings`
**Then** it receives the synthesized market context, competitive landscape, technical feasibility, risk flags, and opportunity signals

### AC6: Analysis step 2 receives research context indirectly
**Given** analysis step 1 has access to research findings
**When** step 1 produces a vision output
**Then** step 2 (scope) receives the research-informed vision output via `step:analysis-step-1-vision` (no direct research injection needed for step 2)

### AC7: End-to-end pipeline with research
**Given** research is enabled and the full pipeline runs
**When** the pipeline completes analysis
**Then** the product brief reflects research findings (mentions competitive context, market validation, or technical feasibility signals that were not in the original concept)

## Tasks / Subtasks

- [ ] Task 1: Add `research_findings` context entry to `analysis-step-1-vision` in `packs/bmad/manifest.yaml` (AC: #1)
  - [ ] Locate the `analysis-step-1-vision` step definition under the `analysis` phase entry
  - [ ] Append `{ placeholder: research_findings, source: "decision:research.findings" }` to its `context` array
  - [ ] Confirm no other analysis steps require direct research injection (step 2 gets it indirectly via step 1 output)

- [ ] Task 2: Update `packs/bmad/prompts/analysis-step-1-vision.md` prompt template (AC: #3, #4)
  - [ ] Add an optional "Research Context" section near the top, before the main instructions, using `{{research_findings}}`
  - [ ] When `{{research_findings}}` is non-empty: instruct the agent to ground its vision analysis in the provided evidence (market context, competitive landscape, technical feasibility, risk flags, opportunity signals)
  - [ ] When `{{research_findings}}` is empty: the section header remains in the template but contains no evidence — the prompt must produce output quality identical to the current version
  - [ ] Do NOT modify `analysis-step-2-scope.md` — step 2 already consumes step 1's output which will be research-informed

- [ ] Task 3: Verify step runner resolves missing decision store entries to empty string (AC: #2)
  - [ ] Read `src/modules/phase-orchestrator/step-runner.ts` to confirm `decision:` source type returns `""` when no entries exist in DB for the given category
  - [ ] If not already covered by existing tests, add a unit test for this edge case in the step-runner test file
  - [ ] No changes to step-runner implementation expected — this is a verification-only task unless a gap is found

- [ ] Task 4: Write integration test — research-enabled analysis path (AC: #1, #5, #7)
  - [ ] Create or extend `src/modules/phase-orchestrator/__tests__/analysis-research-context.test.ts`
  - [ ] Seed decision store with `research.findings` category entries: `market_context`, `competitive_landscape`, `technical_feasibility`, `risk_flags`, `opportunity_signals`
  - [ ] Run analysis phase step 1 with a mocked dispatcher
  - [ ] Verify the assembled prompt string passed to the dispatcher contains the seeded research context strings
  - [ ] Follow the pattern established in `ux-design-integration.test.ts` for DB seeding and mocked dispatch

- [ ] Task 5: Write integration test — research-disabled analysis path (AC: #2, #4)
  - [ ] In the same test file, add a test that runs analysis step 1 with no research findings in the decision store
  - [ ] Verify the assembled prompt does NOT contain the research context strings
  - [ ] Verify the prompt is structurally equivalent to the pre-research version

- [ ] Task 6: Run existing analysis test suite to confirm no regressions (AC: #4, #6)
  - [ ] Run `npm test` and verify all analysis-related tests pass
  - [ ] If the prompt template change causes snapshot mismatches, update the snapshots
  - [ ] Coverage threshold: 80% enforced — do not use filtered runs that skip coverage

## Dev Notes

### Architecture Constraints
- The step runner already resolves `decision:phase.category` context sources — if the category has no entries, it returns empty string. **No step runner changes should be needed.**
- The manifest change is additive: adding a new context entry to an existing step. The step runner processes all context entries; missing entries resolve to empty string automatically.
- **Do NOT inject `research_findings` into `analysis-step-2-scope`** — step 2 already receives step 1's research-informed output via `step:analysis-step-1-vision`. Adding direct injection would create redundant and potentially conflicting context.
- The prompt template change must be **strictly backward-compatible**. When `{{research_findings}}` is empty, the prompt must produce output quality identical to the current version. The simplest safe pattern: add a labeled section that renders its content only when the placeholder has a value, relying on the agent to skip empty sections.

### Key Files
- **Modified:** `packs/bmad/manifest.yaml` — add context entry `{ placeholder: research_findings, source: "decision:research.findings" }` to `analysis-step-1-vision` step
- **Modified:** `packs/bmad/prompts/analysis-step-1-vision.md` — add optional Research Context section
- **Verify only (no changes expected):** `src/modules/phase-orchestrator/step-runner.ts` — confirm `decision:` source type handles missing DB entries gracefully
- **New:** `src/modules/phase-orchestrator/__tests__/analysis-research-context.test.ts`
- **Reference patterns:** `src/modules/phase-orchestrator/__tests__/ux-design-integration.test.ts` (DB seeding + mocked dispatch pattern)

### Testing Requirements
- Test framework: **vitest** (not jest — `--testPathPattern` flag does not work; use vitest's `--` pattern matching syntax)
- Coverage thresholds: 80% enforced — run `npm test` (full suite), never filter in a way that bypasses coverage
- Integration test must seed the decision store with realistic values before running the analysis step
- Integration test must mock the dispatcher to intercept the assembled prompt without making real API calls
- When mocking `fs` in tests, if ConfigWatcher is involved add `watch: vi.fn(() => ({ on: vi.fn(), close: vi.fn() }))` to prevent regressions
- Regression check: existing analysis tests must pass without modification (unless snapshot updates are needed for the prompt template change)

### Dependency on Prior Stories
- **20-1** must be complete first: provides `--research`/`--skip-research` CLI flags and the research phase slot in `runFullPipeline()`
- **20-2** must be complete first: provides the prompt templates and schemas
- **20-3** must be complete first: provides `runResearchPhase()` and decision store persistence of `research.findings` entries
- This story is the **final story in Epic 20** — it closes the loop by making research findings visible to the downstream analysis phase

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
