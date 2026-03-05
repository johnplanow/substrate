# BMAD Workflow Gap Analysis

> Last updated: 2026-03-05 (v0.2.15)

Analysis of BMAD workflows not currently utilized by the substrate pipeline, with integration recommendations.

## Current Coverage

The substrate pipeline reimplements these BMAD workflows as decomposed compiled prompt steps:

| BMAD Workflow | Substrate Equivalent |
|---|---|
| `bmad-bmm-market-research` | Research phase step-1-discovery + step-2-synthesis (Epic 20, v0.2.7–v0.2.10) |
| `bmad-bmm-domain-research` | Research phase step-1-discovery + step-2-synthesis (Epic 20) |
| `bmad-bmm-technical-research` | Research phase step-1-discovery + step-2-synthesis (Epic 20) |
| `bmad-bmm-create-product-brief` | Analysis phase (step-1-vision + step-2-scope) |
| `bmad-bmm-create-prd` | Planning phase (step-1-classification + step-2-frs + step-3-nfrs) |
| `bmad-bmm-create-ux-design` | UX Design phase (step-1-discovery + step-2-design-system + step-3-journeys) |
| `bmad-bmm-create-architecture` | Solutioning/architecture (step-1-context + step-2-decisions + step-3-patterns) |
| `bmad-bmm-create-epics-and-stories` | Solutioning/stories (step-1-epics + step-2-stories) |
| `bmad-bmm-check-implementation-readiness` | `readiness-check.md` |
| `bmad-bmm-sprint-planning` | Implementation orchestrator (internal sequencing) |
| `bmad-bmm-create-story` | `create-story.md` compiled workflow |
| `bmad-bmm-dev-story` | `dev-story.md` compiled workflow |
| `bmad-bmm-code-review` | `code-review.md` compiled workflow |

## Remaining Gaps

### Priority 1: Closed Learning Loop

The pipeline generates rich signals — analysis reports, experiment verdicts, token usage, stall patterns — but none of it feeds back into future runs. This is the biggest architectural gap: **no closed learning loop**.

Two workflows address different facets of this:

| Workflow | Gap |
|---|---|
| `bmad-bmm-retrospective` | No structured lesson extraction after pipeline completion |
| `bmad-bmm-generate-project-context` | No project-context artifact persisted for future runs |

Pipeline ends at story completion (or supervisor summary). A retrospective phase after terminal state could extract lessons (what stalled, what was escalated, what patterns led to first-pass SHIP_IT) and write them to the decision store or a persistent context artifact that downstream runs can consume.

### Priority 2: Post-Implementation Traceability

| Workflow | Gap |
|---|---|
| `bmad-tea-testarch-trace` | No requirements-to-tests traceability matrix after implementation |

Code-review validates code quality but not whether every AC has corresponding test evidence. A traceability step post-code-review would catch coverage gaps before marking a story COMPLETE.

### Priority 3: Escalation Recovery

| Workflow | Gap |
|---|---|
| `bmad-bmm-correct-course` | ESCALATED stories are a dead end |

When code-review exhausts review cycles with major issues, the story is marked ESCALATED with no recovery mechanism. A course-correction workflow could re-scope or re-plan the story — splitting it, relaxing ACs, or flagging it for human intervention with a specific diagnosis.

### Priority 4: Pre-Implementation Test Planning

| Workflow | Gap |
|---|---|
| `bmad-tea-testarch-test-design` | No test strategy before dev-story |

Dev-story has a `red-green-refactor` constraint but no structured test planning. An epic-level test design step before implementation would give dev-story a test strategy to follow rather than inventing test structure ad-hoc per story.

### Lower Priority

| Workflow | Gap | Notes |
|---|---|---|
| `bmad-bmm-quick-spec` + `bmad-bmm-quick-dev` | No lightweight fast lane for small changes | Full ceremony always required |
| `bmad-bmm-validate-prd` | No dedicated PRD validation (only critique loop) | Partially covered by critique-planning |
| `bmad-bmm-sprint-status` | No mid-run sprint summary | Partially covered by NDJSON events + supervisor:poll |
| `bmad-bmm-document-project` | No brownfield codebase analysis | Onboarding for existing projects |
| `bmad-bmm-edit-prd` | No targeted PRD edit (only full phase re-run) | Amendment mode partially covers |
| `bmad-tea-testarch-framework` | No test framework scaffolding | Assumes framework exists |
| `bmad-tea-testarch-ci` | No CI/CD pipeline generation | Out of scope for code pipeline |
| `bmad-tea-testarch-nfr` | No NFR assessment against implementation | Post-release concern |
| `bmad-tea-testarch-test-review` | No test quality gate between dev and review | Could slot between dev-story and code-review |
| `bmad-tea-testarch-atdd` | No dedicated ATDD scaffolding | Partially covered by red-green-refactor constraint |
| `bmad-tea-testarch-automate` | No post-implementation test expansion | E2E/UI coverage gap |

### Not Applicable

BMB module workflows (agent/workflow/module CRUD) and editorial workflows (prose, structure) are meta-tools for building BMAD itself, not user project pipelines. Excluded from this analysis.

## Source Code TODOs

Small-scope items tracked in source rather than as stories:

| Location | Item |
|---|---|
| `src/modules/compiled-workflows/code-review.ts:35` | Externalize pack config (max review cycles, severity thresholds) for multi-pack support |
| `src/cli/commands/adapters.ts:80,152` | AdapterRegistry should be initialized at CLI startup and injected, not constructed per-call |

## Shipped (historical)

Previously tracked gaps that have been resolved:

| Gap | Resolution | Version |
|---|---|---|
| Research validation (market, domain, technical) | Epic 20: optional research phase with 2-step compiled decomposition, `--research`/`--skip-research` CLI flags, `{{research_findings}}` context injection, web search graceful fallback | v0.2.7–v0.2.10 |
| Supervisor token tracking reports 0 tokens from dev builds/worktrees | `getTokenSnapshot`/`incrementRestarts` now resolve DB path via `resolveMainRepoRoot` | v0.2.15 |
| Constraint adherence (tech constraints dropped during analysis) | `technology_constraints` field threaded through planning, concept truncation removed | v0.1.24 |
