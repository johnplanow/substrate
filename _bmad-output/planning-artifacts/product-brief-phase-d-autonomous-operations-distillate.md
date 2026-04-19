---
title: "Product Brief Distillate: Phase D — Autonomous Operations"
type: llm-distillate
source: "product-brief-phase-d-autonomous-operations.md"
created: "2026-04-05"
updated: "2026-04-05"
purpose: "Token-efficient context for downstream PRD creation"
review: "3 review lenses (skeptic, opportunity, devex-critic) + first-principles + pre-mortem elicitation"
---

## Core Thesis
- Make substrate complete multi-story pipeline runs without human intervention
- Every validation run to date required human intervention (5/5 cross-project runs)
- Gap is between "can run" and "can run unattended" — trust, not just capability
- Trust-destroying failures (phantom reviews, scope violations, wrong epic) are worse than operational burden
- Self-hosting dogfooding: substrate develops itself — Phase D improvements directly benefit substrate's own development

## Five Capabilities + Cross-Cutting Hardening (priority-ordered)

### 1. Output Verification (CO-PRIMARY — start immediately)
- **Rationale**: An operator who can trust the output will tolerate babysitting. An operator who can't trust the output won't tolerate autonomy. This is the most trust-destroying problem category.
- Review verdict accuracy: dispatch failure ≠ review verdict; failed dispatches retry/escalate, never produce fallback verdicts
- Story output validation: <100 token flagging, non-trivial diff check, per-story build verification (after each story, not just at end)
- Cross-story consistency: conflicting types, duplicate namespaces, contract mismatches — triggered only when stories share file-level dependencies (keep costs low)
- AC traceability: heuristic matching between AC text and test names (approximate, on-demand, NOT default path)
- Feedback circuit: verification findings → learning store (self-calibrating thresholds over time)
- **Design principle**: lightweight by default. No LLM calls in default verification path. Build check + diff validation = mandatory and cheap. AC traceability = optional and expensive.
- Existing to build on: OutputQualityEstimator (v0.19.17, 0-100 score), diffStats (v0.19.16)
- Can ship minimal version (build check + diff + phantom review detection) BEFORE full run model

### 2. Unified Run Model (CO-PRIMARY — foundation for capabilities 3-5)
- Single coherent representation of run scope, state, config, lifecycle
- Current split-brain: JSON manifest, Dolt pipeline_runs, supervisor memory, NDJSON events
- Core issue: no single consumer reads all four sources
- Must persist: CLI flags, story scope, supervisor ownership, per-story lifecycle, recovery history, cost accumulation
- Must survive process crashes (durable, not in-memory)
- **Implementation spectrum**: architecture phase evaluates full unification vs reconciliation layer. Reconciliation (cross-check + persist scope + alert on divergence) may deliver 80% value at 20% cost. Brief does not prescribe — architecture doc decides.
- **Budget constraint**: 1 epic, max 8 stories. If it can't fit, the design is too ambitious.
- Design constraint: per-story independent state tracking (concurrency-ready for Phase E)
- Design constraint: file-backed JSON for manifest/scope; Dolt for metrics/telemetry/decisions. No consumer needs atomic reads from both.
- Open question: crash recovery semantics (write-ahead? periodic checkpoint? transactional?)

### 3. Intelligent Stall Detection (parallel after run model)
- Phase-aware thresholds: create-story 5min, dev-story 15min, code-review 15min
- Backend-aware: multiply by timeoutMultiplier (Codex 3.0x already in codebase)
- Process liveness signals: CPU sampling, child PID tracking as staleness override
- Existing: rudimentary 2x for code review in handleStallRecovery; this replaces it
- Must integrate with run model to know current phase + backend

### 4. Closed Learning Loop (requires run model)
- **Two distinct mechanisms**:
  - **Mechanism A — Advisory injection** (soft guidance): inter-run findings with root cause taxonomy, relevance scoring, deduplication; intra-run real-time propagation (story N failure → story N+3 prompt in same run)
  - **Mechanism B — Dispatch pre-condition gating** (hard blocks): check for known conflicts before dispatch; block story until conflict resolved (not just warn in prompt). Solves 30-6/30-8 namespace collision properly.
- Root cause taxonomy: namespace-collision, dependency-ordering, spec-staleness, adapter-format, build-failure, test-failure, resource-exhaustion
- **Finding validation**: verify relevance before injection (does conflicting class still exist?). High-confidence (code-verified) → direct injection. Low-confidence (inferred) → warning only.
- Existing: `project-findings.ts` with 2000-char cap, LIFO ordering, no classification
- Gaps: no relevance ranking, no inter-vs-intra distinction, no root cause taxonomy, no decay/dedup, no validation
- Prompt budget constraint: findings compete with architecture constraints (already capped at 12K chars)
- Scope boundary: addresses prompt-addressable failures only (semantic, not infrastructure bugs)
- **Escalation recovery**: retry-with-context (autonomous, primary mechanism) vs re-scope/split (operator approval required). Max 2 pending operator-approval proposals before run pauses. Prevents proposal accumulation.

### 5. Cost Governance (parallel after run model)
- Per-story retry budget (default 2, configurable) — max retries before mandatory escalation
- Per-run cost ceiling with automatic pause + operator notification
- Extends existing convergence loop budget controls (node/pipeline/session from Epic 45)
- Cost-per-story in completion report including recovery attempt costs
- Target: no unattended run exceeds 2x estimated cost without notification

### Adapter Hardening (cross-cutting, NOT standalone capability)
- Demoted from capability-level: lowest-impact capability relative to autonomous completion goal (caused failures in 1/5 validation runs vs 3/5 for verification gaps)
- Delivered as hardening work during implementation of other capabilities
- Existing adapters (Claude Code, Codex) handle format variance without code changes for 5-story run
- Format normalization layer: canonical form before downstream processing
- "New backend zero-code" is Phase E aspiration requiring plugin/contract system

## Operating Modes (simplified from trust ladder)
- Single mode with configurable `--halt-on` severity threshold
- `--halt-on all`: halts on any recovery decision (attended, starting point)
- `--halt-on critical`: halts on scope violations, cost breaches, build failures; emits notification (default)
- `--halt-on none`: full autonomous, overnight mode
- Simpler to implement than three discrete codepaths — one behavior with a config knob

## Reviewer Workflow (new)
- Structured completion report (new CLI command or metrics enhancement)
- Per-story: outcome, recovery history, cost, quality score
- Escalation reports: root cause category, attempts made, minimal unblock action, blast radius
- Target: escalated story resolvable in <15 minutes from report alone

## Success Criteria Split

### Prerequisite: Baseline Validation Run
- Run 10-story validation on v0.19.25 with zero intervention BEFORE Phase D starts
- Record: completion count, failure count, failure categories, total cost
- Estimated: <$5, ~2-3 hours
- This is the denominator for all outcome targets

### Infrastructure Guarantees (exit criteria)
1. Run scope preservation: 100% across supervisor restarts
2. Stall detection accuracy: zero false-positive kills within phase/backend-aware thresholds
3. Learning injection: inter-run + intra-run with relevance ranking, validation, root cause taxonomy, dispatch gating
4. Verification completeness: per-story build status, diff analysis, quality scores, cost, recovery history; zero phantom verdicts
5. Cost governance: per-run ceiling enforced, no 2x+ overrun without notification
6. Test integrity: 8,088+ tests green, build <5s, no target project regression

### Outcome Targets (validation milestones, measured against baseline)
7. Unattended completion: 80% autonomous on 10+ story self-hosting run
8. Self-recovery: 50% of prompt-addressable first-attempt failures recovered via retry-with-context
9. Learning effectiveness: 75% repeat-failure reduction for prompt-addressable failures

## Capability Dependencies
```
Output Verification (co-primary, can start immediately)
  ↕ feedback circuit
Unified Run Model (co-primary, foundation)
  ├── Stall Detection (parallel)
  ├── Cost Governance (parallel)
  ├── Learning Loop (requires run model + taxonomy)
  │     ├── Advisory Injection
  │     ├── Dispatch Pre-condition Gating
  │     └── Escalation Recovery
  └── Adapter Hardening (cross-cutting)
```

## Rejected / Descoped
- Parallel story execution → Phase E (run model supports it by design, dispatch separate)
- Universal backend portability / plugin system → Phase E
- New backend integrations (Gemini) → separate from Phase D
- External UI/dashboard → CLI-first
- Cross-project orchestration → out of scope
- Pre-implementation test planning → deferred
- Multi-epic sequencing → Phase E
- SQLite for run manifest → feedback constraint, use file-backed JSON
- Adapter Stability as standalone capability → demoted to cross-cutting hardening
- Three discrete operating modes → simplified to `--halt-on` threshold

## Pre-mortem Failure Scenarios (from elicitation — architecture must address)
1. **Run model eats timeline**: unified model takes 3 epics instead of 1, nothing else ships → budget constraint (1 epic, 8 stories max) + reconciliation layer alternative
2. **Learning loop learns wrong things**: 40% misclassification amplifies errors → finding validation mechanism before injection
3. **Verification too expensive**: 30min + $1.50 per run, operators disable it → lightweight default path, no LLM calls
4. **Escalation recovery creates more problems**: operator arrives to 6 pending proposals → max 2 pending before pause, retry-with-context as primary mechanism
5. **No baseline established**: can't measure improvement → mandatory pre-Phase-D baseline run

## Key Evidence (from validation runs)
- Board Game Sandbox: 15/15 stories but 3 runs, $2.05 — manual restarts
- NextGen Ticketing: 17/17 stories, 4 sprints, custom harness
- Codex on Ticketing: 1/1 story, multiple attempts, 4 code fixes
- Epic 30 self-hosting: 7/8 stories, 6 runs, $1.90 — scope loss, namespace collision
- Epic 4 cross-project: 5/6 stories, 2 runs, $2.03 — staleness, OOM, phantom reviews

## Constraints
- No shortcuts, no tech debt
- Language-agnostic
- 8,088+ tests pass at every commit
- Build time <5s
- File-backed run manifest (no SQLite)
- Verification lightweight by default
- Run model budget: 1 epic, max 8 stories
