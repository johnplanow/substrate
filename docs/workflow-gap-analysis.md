# BMAD Workflow Gap Analysis

> Last updated: 2026-03-06 (v0.2.19)

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

### Priority 1: Closed Learning Loop (Partially Addressed)

The pipeline generates rich signals and **already persists them**: operational findings to the decision store (v0.2.16, Story 21-1), post-run analysis reports via the supervisor analysis engine (Story 17-3, `src/modules/supervisor/analysis.ts`), and experiment verdicts via the experimenter (Story 17-4, `src/modules/supervisor/experimenter.ts`). Reports are written to `_bmad-output/supervisor-reports/`.

**What's missing**: the feedback loop. Findings are captured but **not consumed by future runs**. A retrospective phase after terminal state could read decision store findings and write a persistent context artifact that downstream runs inject into analysis/planning prompts.

| Workflow | Gap |
|---|---|
| `bmad-bmm-retrospective` | Findings captured but not fed back — no closed loop |
| `bmad-bmm-generate-project-context` | No project-context artifact persisted for future runs |

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
| `bmad-bmm-sprint-status` | No mid-run sprint summary | Partially covered by NDJSON events + supervisor:poll |
| `bmad-tea-testarch-nfr` | No NFR assessment against implementation | Post-release concern |
| `bmad-tea-testarch-automate` | No post-implementation test expansion | E2E/UI coverage gap |

### Won't Build

Removed from active tracking — either covered by existing substrate patterns or out of scope:

| Workflow | Reason |
|---|---|
| `bmad-bmm-quick-spec` + `bmad-bmm-quick-dev` | Substrate's compiled prompts ARE the fast lane |
| `bmad-bmm-validate-prd` | Critique loop already covers PRD validation |
| `bmad-bmm-document-project` | Niche; not blocking pipeline usage |
| `bmad-bmm-edit-prd` | Amendment mode covers targeted edits |
| `bmad-tea-testarch-framework` | Assumes framework exists (correct assumption) |
| `bmad-tea-testarch-ci` | Out of scope for code pipeline |
| `bmad-tea-testarch-atdd` | Red-green-refactor constraint covers this |

### Not Applicable

BMB module workflows (agent/workflow/module CRUD) and editorial workflows (prose, structure) are meta-tools for building BMAD itself, not user project pipelines. Excluded from this analysis.

## Source Code TODOs

Small-scope items tracked in source rather than as stories:

| Location | Item |
|---|---|
| `src/cli/commands/adapters.ts:80,152` | AdapterRegistry should be initialized at CLI startup and injected, not constructed per-call |

## Shipped (historical)

Previously tracked gaps that have been resolved:

| Gap | Resolution | Version |
|---|---|---|
| Research validation (market, domain, technical) | Epic 20: optional research phase with 2-step compiled decomposition, `--research`/`--skip-research` CLI flags, `{{research_findings}}` context injection, web search graceful fallback | v0.2.7–v0.2.10 |
| Supervisor token tracking reports 0 tokens from dev builds/worktrees | `getTokenSnapshot`/`incrementRestarts` now resolve DB path via `resolveMainRepoRoot` | v0.2.15 |
| Constraint adherence (tech constraints dropped during analysis) | `technology_constraints` field threaded through planning, concept truncation removed | v0.1.24 |
| Operational findings capture | Story 21-1: supervisor stall events + run summaries persisted to decision store (`schemas/operational.ts`) | v0.2.16 |
| Post-run analysis reports | Story 17-3: supervisor analysis engine generates token efficiency, review cycle, and timing reports to `_bmad-output/supervisor-reports/` | v0.2.12 |
| Experiment mode / A/B testing | Story 17-4: `--experiment` flag, experiment state machine, verdict engine (IMPROVED/MIXED/REGRESSED), recommendations written to decision store | v0.2.12 |
| Resume command | `substrate resume --run-id` with checkpoint recovery, `--stop-after` phase support | v0.2.12 |
| Process group kill / orphan cleanup | `getAllDescendantPids()` recursive PID collection, SIGTERM + 5s grace + SIGKILL cascade, post-kill verification | v0.2.12 |
| Phase transition grace period | `NO_PIPELINE_RUNNING` requires consecutive polls, 5s liveness check with retries before declaring pipeline done | v0.2.12 |
| All-phase supervisor monitoring | Supervisor monitors analysis/planning/solutioning phases, not just implementation | v0.2.12 |
| macOS memory pressure false stalls | Pressure-level gate raised from `>= 2` (warn) to `>= 4` (critical); level 2 halves vm_stat estimate instead of hard-blocking | v0.2.18 |
| YAML fence wrapping causes false rework | `stripTrailingFence()` in YAML parser; schema-failure fallback changed from NEEDS_MAJOR_REWORK to NEEDS_MINOR_FIXES | v0.2.19 |
| Default memory threshold too aggressive | Lowered from 512MB to 256MB; macOS vm_stat reports conservatively | v0.2.19 |
| Phase end-time warning on skipped phases | `endPhase()` called on create-story skip path when story file exists from prior run | v0.2.19 |
