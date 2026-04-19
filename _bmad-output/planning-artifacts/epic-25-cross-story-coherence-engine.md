# Epic 25: Cross-Story Coherence Engine

## Vision

Eliminate the most persistent class of pipeline failures: cross-story contract mismatches where parallel stories independently design incompatible interfaces for shared message contracts. Add semantic awareness of inter-story dependencies so the pipeline can detect, prevent, or verify cross-boundary coherence before marking stories COMPLETE.

Secondary goals: wire the existing token ceiling config infrastructure through the CLI (completing the last-mile gap from Story 24-7), add a pre-flight build gate, reduce review cycle waste, and introduce structured test planning.

Source: Cross-project pipeline findings v0.2.29 run (2026-03-07), recurring cross-file coherence gaps from Epics 22-24, pipeline self-implementation findings (v0.2.21).

## Scope

### In Scope

- Contract registry: stories declare `exports` (schemas they create) and `imports` (schemas they consume) during story creation; pipeline builds a dependency graph
- Contract verification gate: post-sprint pass that validates producer output schemas match consumer input schemas across stories
- Pre-flight build check: verify the target project builds before dispatching any story
- LGTM_WITH_NOTES verdict: code-review can pass a story with advisory notes without triggering a fix cycle
- Test-plan prompt template: add a `test-plan` prompt to the bmad pack so dev agents follow structured test strategy
- Token ceiling CLI wiring: connect `token_ceilings` from config.yaml through the `run` command to the orchestrator (completing Story 24-7's last-mile gap)

### Out of Scope

- Automatic contract generation from TypeScript types (too heuristic-heavy for v1)
- Cross-story test execution (running one story's tests against another's code — future epic)
- Shared interface lock / monorepo-aware import enforcement (requires deep language tooling)
- TUI enhancements (frozen per architectural decision)

## Story Map

```
Sprint 1 — Quick Wins + Foundation (P0/P1) [IN PROGRESS]:
  Story 25-1: Token Ceiling CLI Wiring (P1, S) ✓
  Story 25-2: Pre-Flight Build Gate (P1, S)
  Story 25-3: LGTM_WITH_NOTES Code-Review Verdict (P2, M)

Sprint 2 — Contract Awareness (P0):
  Story 25-4: Contract Declaration in Story Creation (P0, M)
  Story 25-5: Contract-Aware Dispatch Ordering (P0, M)

Sprint 3 — Verification + Test Planning (P1/P2):
  Story 25-6: Post-Sprint Contract Verification Gate (P1, M)
  Story 25-7: Test-Plan Prompt Template for bmad Pack (P2, S)
```

## Story Details

### Story 25-1: Token Ceiling CLI Wiring (P1, S)

**Problem:** Story 24-7 built the full token ceiling infrastructure (config schema, getTokenCeiling(), orchestrator deps, prompt assembler integration) but the `run` CLI command never loads `token_ceilings` from config and passes it to the orchestrator. Config overrides are silently ignored.

**Acceptance Criteria:**
- AC1: `substrate run` loads the project config via `createConfigSystem` and extracts `token_ceilings`
- AC2: Both orchestrator creation sites in `run.ts` (implementation-only path line ~842, full-pipeline path line ~1325) receive `tokenCeilings` from config
- AC3: If config loading fails or `token_ceilings` is absent, the orchestrator uses hardcoded defaults (no behavioral change for existing users)
- AC4: Integration test verifies config `token_ceilings` propagate through CLI to orchestrator

**Files:** `src/cli/commands/run.ts`

### Story 25-2: Pre-Flight Build Gate (P1, S)

**Problem:** The pipeline dispatches stories into projects with pre-existing build failures. Dev agents produce code that "works" in isolation but may be masked by existing breakage. Build verification only runs post-dev.

**Acceptance Criteria:**
- AC1: Before dispatching the first story, the orchestrator runs the project's build command
- AC2: If the pre-flight build fails, emit a `pipeline:pre-flight-failure` event and abort with actionable error
- AC3: Pre-flight build respects the same `verifyCommand` config as the post-dev build gate (Story 24-2)
- AC4: Pre-flight build uses auto-detected package manager (Story 24-8)
- AC5: When `--skip-preflight` flag is passed, the check is skipped (escape hatch)

**Files:** `src/modules/implementation-orchestrator/orchestrator-impl.ts`, `src/cli/commands/run.ts`

### Story 25-3: LGTM_WITH_NOTES Code-Review Verdict (P2, M)

**Problem:** Both stories in the v0.2.29 run went through 2 review-fix cycles. 58% of wall-clock on story 4-6 was review/fix. When the code-review agent finds only style/advisory issues and no correctness bugs, the story should ship without a fix cycle.

**Acceptance Criteria:**
- AC1: Code-review schema adds `LGTM_WITH_NOTES` as a valid verdict alongside SHIP_IT, NEEDS_MINOR_FIXES, NEEDS_MAJOR_REWORK
- AC2: `LGTM_WITH_NOTES` completes the story (same as SHIP_IT) but persists the advisory notes in the decision store
- AC3: Code-review prompt instructs the agent: use LGTM_WITH_NOTES when all findings are advisory/style and no correctness issues exist
- AC4: Advisory notes from LGTM_WITH_NOTES are included in the story's `prior_findings` for future reference
- AC5: Pipeline metrics track LGTM_WITH_NOTES separately from SHIP_IT for observability

**Files:** `src/modules/compiled-workflows/code-review.ts`, `packs/bmad/prompts/code-review.md`, schema files

### Story 25-4: Contract Declaration in Story Creation (P0, M)

**Problem:** When parallel stories share a message contract (queue, API, schema), neither story knows about the other's interface design. This causes runtime integration failures that the pipeline cannot detect (Finding 1 from v0.2.29 run).

**Acceptance Criteria:**
- AC1: Story creation prompt instructs the agent to identify `exports` (schemas/interfaces the story creates) and `imports` (schemas/interfaces the story consumes from other stories)
- AC2: Created story files include an `## Interface Contracts` section listing exports and imports with schema names and locations
- AC3: The pipeline parses the Interface Contracts section and stores contract declarations in the decision store
- AC4: Contract declarations include: contract name, direction (export/import), schema location (file path), and message transport (queue name, API path, etc.)

**Files:** `packs/bmad/prompts/create-story.md`, `packs/bmad/templates/story.md`, `src/modules/compiled-workflows/create-story.ts`

### Story 25-5: Contract-Aware Dispatch Ordering (P0, M)

**Problem:** Stories with shared contracts run in parallel, independently designing incompatible schemas. The conflict detector only checks file-level conflicts, not semantic contract dependencies.

**Acceptance Criteria:**
- AC1: Before dispatching, the orchestrator builds a contract dependency graph from story declarations (Story 25-4)
- AC2: If story A exports a contract that story B imports, A is dispatched before B
- AC3: If two stories both export the same contract name, they are serialized (first creates, second imports)
- AC4: Stories with no contract overlap continue to run in parallel (no regression)
- AC5: Contract dependency edges are logged as structured events for observability

**Depends on:** Story 25-4

**Files:** `src/modules/implementation-orchestrator/orchestrator-impl.ts`, `src/modules/implementation-orchestrator/conflict-detector.ts`

### Story 25-6: Post-Sprint Contract Verification Gate (P1, M)

**Problem:** Even with ordering (Story 25-5), contract mismatches can occur if a dev agent deviates from the declared schema. A post-sprint verification step validates that all declared contracts are satisfied.

**Acceptance Criteria:**
- AC1: After all sprint stories complete, the orchestrator runs a contract verification pass
- AC2: For each export/import pair, verify the exported schema file exists and the importing story references the same schema
- AC3: Run a TypeScript type-check across the affected packages to detect interface mismatches
- AC4: If verification fails, emit `pipeline:contract-mismatch` event with details (exporter story, importer story, schema name, mismatch description)
- AC5: Contract verification failures escalate to the user (not auto-fixable)

**Depends on:** Stories 25-4, 25-5

**Files:** `src/modules/implementation-orchestrator/orchestrator-impl.ts`, new `src/modules/implementation-orchestrator/contract-verifier.ts`

### Story 25-7: Test-Plan Prompt Template for bmad Pack (P2, S)

**Problem:** The bmad pack has no `test-plan` prompt template. The pipeline silently skips test planning, and dev agents write tests ad-hoc with inconsistent coverage (e.g., 40% statement coverage on judge-agent).

**Acceptance Criteria:**
- AC1: Add a `test-plan.md` prompt template to `packs/bmad/prompts/`
- AC2: The template generates a structured test strategy: critical paths to cover, dependencies to mock, error conditions to assert, coverage targets
- AC3: Test plan output is passed to the dev-story agent as the `{{test_plan}}` section
- AC4: Pipeline no longer logs "Methodology pack bmad has no prompt for task type test-plan" warning

**Files:** `packs/bmad/prompts/test-plan.md`

## Dependency Analysis

- Sprint 1 (25-1, 25-2, 25-3): fully independent, can run in parallel
- Sprint 2 (25-4, 25-5): 25-5 depends on 25-4 (needs contract declarations to build the graph)
- Sprint 3 (25-6, 25-7): 25-6 depends on 25-4 + 25-5; 25-7 is independent

## Sprint Plan

**Sprint 1:** Stories 25-1, 25-2, 25-3 — quick wins, immediate pipeline quality improvement
**Sprint 2:** Stories 25-4, 25-5 — contract awareness foundation
**Sprint 3:** Stories 25-6, 25-7 — verification and test planning

## Success Metrics

- Zero cross-module schema mismatches in pipeline runs where contract declarations are present
- Config `token_ceilings` overrides propagate to all compiled workflows
- Pre-flight build failures abort the pipeline with actionable error before any story dispatches
- Review cycles per story drop from avg 2.0 to avg 1.2 (LGTM_WITH_NOTES absorbs advisory-only reviews)
- Test coverage on pipeline-generated code improves from ~40% to ~70% with structured test plans
- No more "Methodology pack has no prompt for test-plan" warnings in pipeline logs
