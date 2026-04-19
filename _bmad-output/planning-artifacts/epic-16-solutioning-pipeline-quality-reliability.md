# Epic 16: Solutioning Pipeline Quality & Reliability

## Vision

Transform the compiled solutioning pipeline from a single-shot-per-phase system into a multi-step, self-critiquing pipeline that matches the quality of BMAD interactive workflows — without requiring user interaction. Fix the engineering bugs that caused the pipeline to stall before story generation, and port the advanced elicitation and adversarial review patterns into automated equivalents that run as sub-agent dispatches.

## Scope

### In Scope

- Fix pipeline stall: missing max turns, prompt budget overflow, architecture retry loop, decision deduplication
- Multi-step phase decomposition: break each phase from 1 dispatch into N sequential steps (mirroring BMAD workflow structure)
- Automated elicitation: auto-select and run 1-2 elicitation methods per phase from the 50-method library
- Generate-critique-refine loops: adversarial review + refinement on critical artifacts
- Adversarial readiness check: replace keyword substring matching with a proper sub-agent dispatch
- Optional UX design phase in solutioning

### Out of Scope (Future)

- **Interactive elicitation (A/P/C menus)**: The compiled pipeline is autonomous. Interactive elicitation remains available via `bmad-auto-*` skills.
- **Party mode in pipeline**: Multi-agent debate is valuable but adds significant dispatch cost. Evaluate after quality metrics are established.
- **TUI enhancements**: Per architectural decision (2026-02-28), TUI is frozen. No further investment.

## Story Map

```
Story 16-1: Fix Solutioning Pipeline Reliability
    |
Story 16-2: Multi-Step Phase Decomposition
    |
    +-- Story 16-3: Automated Elicitation Rounds (parallel)
    +-- Story 16-4: Adversarial Review & Refinement Loops (parallel)
    |
Story 16-5: Optional UX Design Phase
    |
Story 16-6: Adversarial Readiness Check
```

### Dependency Analysis

| Story | Depends On | Can Parallelize With |
|-------|-----------|---------------------|
| 16-1  | None      | —                   |
| 16-2  | 16-1      | —                   |
| 16-3  | 16-2      | 16-4                |
| 16-4  | 16-2      | 16-3                |
| 16-5  | 16-2      | 16-3, 16-4          |
| 16-6  | 16-3, 16-4| —                   |

### Sprint Planning

- **Sprint 1 (Critical Fixes)**: Story 16-1. Unblocks all pipeline runs immediately.
- **Sprint 2 (Quality Foundation)**: Stories 16-2, 16-3, 16-4. Delivers multi-step decomposition with elicitation and critique loops.
- **Sprint 3 (Completeness)**: Stories 16-5, 16-6. Adds UX design phase and adversarial readiness gate.

## Architecture Decisions

- **Elicitation is automated, not interactive.** The pipeline auto-selects methods using the same context-analysis logic from `workflow.xml` step 1 (complexity, domain, risk, creative potential). No user in the loop.
- **Each elicitation round is a separate sub-agent dispatch.** The elicitation method prompt is injected alongside the artifact being refined. The agent applies the method and returns enhanced content.
- **Critique-refine is a bounded loop.** Max 2 iterations per artifact. If the critique agent finds issues, the refinement agent gets the critique as input. Loop terminates when the critique passes or max iterations are hit.
- **Phase steps share context via the decision store.** Each step within a phase reads prior step output from SQLite, not from a growing prompt. This keeps individual prompt sizes bounded.
- **UX design is a configurable phase.** Packs declare `uxDesign: true|false` in their manifest. When enabled, it runs between planning and architecture. When disabled, solutioning proceeds without it.
- **Readiness check uses an adversarial prompt, not keyword matching.** A dedicated sub-agent receives all FRs, NFRs, architecture decisions, and stories, then actively looks for gaps, contradictions, and quality issues. Returns a structured verdict.

## Phase Dispatch Model (Target State)

```
Analysis Phase (~3 dispatches):
  1. Generate product brief from concept
  2. Auto-elicitation: 1-2 methods (e.g., First Principles, Stakeholder Round Table)
  3. Refine brief with elicitation insights

Planning Phase (~4 dispatches):
  1. Generate PRD (FRs, NFRs, user stories, tech stack)
  2. Auto-elicitation on requirements (e.g., Pre-mortem, 5 Whys)
  3. Refine PRD with elicitation insights
  4. Adversarial PRD review + fix pass

UX Design Phase (~3 dispatches, optional):
  1. Generate UX strategy from PRD + product brief
  2. Auto-elicitation (e.g., User Persona Focus Group)
  3. Refine UX design

Solutioning Phase (~6 dispatches):
  1. Architecture decisions (data, auth, API, frontend, infra)
  2. Auto-elicitation on architecture (e.g., Red Team vs Blue Team, ADR method)
  3. Refine architecture with critique
  4. Epic design with FR coverage mapping
  5. Story creation per epic
  6. Adversarial readiness check (READY / NEEDS WORK / NOT READY)
     - If NEEDS WORK: one retry of story generation with gap analysis

Total: ~16-19 dispatches (up from 4)
Estimated cost: ~$1.50-2.50 per full run (up from $0.37)
```

## Success Metrics

- Pipeline completes all phases including story generation (no stalls at architecture→stories transition)
- Architecture decisions are stable: running the same project twice produces consistent core decisions (same system architecture, same data store, same message broker)
- Output quality is subjectively comparable to BMAD interactive workflow output (assessed by user review)
- Readiness check catches real gaps (FR coverage, architectural contradictions) — not just keyword matches
- Full solutioning run completes in under 30 minutes
- Token cost remains under $3.00 for a typical project
