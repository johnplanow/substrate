---
stepsCompleted: [step-01-init, step-02-discovery, step-02b-vision, step-02c-executive-summary, step-03-success, step-04-journeys, step-05-domain, step-07-project-type, step-08-scoping, step-09-functional, step-10-nonfunctional, step-11-polish, step-12-complete]
inputDocuments:
  - product-brief-phase-d-autonomous-operations.md
  - product-brief-phase-d-autonomous-operations-distillate.md
  - phase-d-concept-autonomous-operations.md
  - findings-epic30-run-2026-03-14.md
  - findings-cross-project-epic4-2026-03-05.md
  - workflow-gap-analysis.md
workflowType: prd
projectType: CLI tool / daemon
domain: Multi-agent orchestration
complexity: high
context: brownfield (v0.19.25, 8,088 tests, 3-package monorepo)
---

# Product Requirements Document: Substrate Phase D — Autonomous Operations

**Version:** 1.1
**Date:** 2026-04-05
**Author:** Human
**Status:** Draft
**Elicitation:** Socratic questioning (7 findings) + Red team (8 findings) — all integrated
**Informed by:** Product Brief — Phase D Autonomous Operations (2026-04-05), Phase D Concept Document, Epic 30 Findings, Cross-Project Epic 4 Findings, Workflow Gap Analysis, Codex Validation Run Data

---

## 1. Executive Summary

### What This Is

Phase D adds autonomous operation capabilities to substrate's existing SDLC pipeline. The system gains the ability to verify its own output, maintain coherent run state, detect stalls intelligently, learn from past failures, govern its own spending, and recover from errors — enabling multi-story pipeline runs to complete without human intervention.

### What Makes This Special

Substrate is the first multi-agent orchestration system that can be trusted to run unsupervised. The key insight: the system's inability to verify its own output is more trust-destroying than any operational failure. An operator who trusts the output will tolerate babysitting. An operator who can't trust the output won't tolerate autonomy. Phase D therefore elevates output verification to co-primary priority alongside state management.

### Project Classification

- **Type:** CLI tool / daemon (brownfield enhancement)
- **Domain:** Multi-agent orchestration for AI coding agents
- **Complexity:** High — touches run state, supervisor, orchestrator, dispatch, and verification across 3 packages
- **Context:** Brownfield — v0.19.25, 8,088 tests, 3-package monorepo (@substrate-ai/core, @substrate-ai/sdlc, @substrate-ai/factory)
- **Prior Art:** Phases A-C (50 epics, software factory complete), 5 cross-project/cross-backend validation runs

---

## 2. Background

### 2.1 Current State

Substrate v0.19.25 is a multi-agent orchestration daemon with a complete SDLC pipeline (analysis → planning → solutioning → implementation), a graph execution engine with parallel fan-out/fan-in, convergence loops with satisfaction scoring, context engineering with pyramid summaries, and multi-backend agent dispatch (Claude Code, Codex). The system has been validated across 5 cross-project runs on TypeScript, Python, and Go codebases.

### 2.2 The Problem

Every validation run to date has required human intervention. The system can ship code, but it cannot be trusted to ship code unsupervised. Five categories of failure make every pipeline run an operator-dependent process:

1. **Split-brain state**: Run state is spread across JSON manifest, Dolt `pipeline_runs`, supervisor memory, and NDJSON events. No single consumer reads all four. The supervisor restart P0 (dispatching Epic 31 work during an Epic 30 run) is a direct consequence.

2. **Unreliable stall detection**: `last_activity` only updates on phase transitions. Healthy 30-minute code reviews are killed as "stalls." Process liveness detection returns null. Thresholds are not backend-aware (Codex runs 4-8x slower).

3. **No effective learning loop**: Findings are captured (`project-findings.ts`, 2,000-char cap, LIFO) but lack relevance ranking, root cause classification, inter-vs-intra-run distinction, and finding validation. The same failures repeat across runs.

4. **No output verification**: Phantom code reviews produce passing verdicts without reviewing code. <100-token stories count as successes. Cross-story consistency is unchecked. The pipeline records "complete" for work that is wrong or missing.

5. **Adapter brittleness**: Codex required 4 substrate code changes (v0.19.11-v0.19.14). Format compliance varies. Token tracking is heuristic-only.

### 2.3 Target State

A pipeline run starts with `substrate run --events`, runs for 2-8 hours unattended (configurable halt severity), and produces a structured completion report with per-story verified outcomes. The operator reviews results the next morning, resolves any escalations in <15 minutes each using the escalation report, and accepts or re-runs individual stories. The system has learned from previous runs and does not repeat prompt-addressable failures.

### 2.4 Evidence Base

| Validation Run | Stories | Runs Needed | Human Interventions | Root Cause Category |
|---|---|---|---|---|
| Board Game Sandbox | 15/15 | 3 | Manual restart after bugs | State, budget |
| NextGen Ticketing | 17/17 | 4 sprints | Sprint-by-sprint oversight | Custom harness needed |
| Codex on Ticketing | 1/1 | Multiple | 4 code fixes mid-run | Adapter gaps |
| Epic 30 (self-hosting) | 7/8 | 6 | Supervisor scope loss, manual fix | State, dependencies |
| Epic 4 (cross-project) | 5/6 | 2 | Epic shard cleanup, heading fix | Data integrity, OOM |

---

## 3. Success Criteria

### Prerequisite: Baseline Validation Run

Before Phase D implementation begins, run a 10-story validation on the current codebase (v0.19.25) with zero human intervention. Record: completion count, failure count, failure categories, total cost. Estimated: <$5, ~2-3 hours. This establishes the denominator for all outcome targets.

### User Success

- The operator can start a 10+ story run and review results the next morning without having monitored the run
- Escalated stories are resolvable in <15 minutes using only the escalation report
- The operator has graduated confidence through configurable `--halt-on` severity levels
- The post-run completion report provides per-story verification evidence, not just status counts

### Technical Success (Infrastructure Guarantees — Exit Criteria)

| # | Criterion | Target | Measurement |
|---|-----------|--------|-------------|
| TS-1 | Run scope preservation | 100% across supervisor restarts | Zero unscoped pipeline executions in validation runs |
| TS-2 | Stall detection accuracy | Zero false-positive kills | No kills within phase/backend-aware threshold in validation runs |
| TS-3 | Learning injection | Inter-run + intra-run with validation | Findings from run N verifiably present in run N+1 prompts; dispatch gating blocks known conflicts |
| TS-4 | Verification completeness | Zero phantom verdicts and zero trivial-output successes counted as completions | Per-story build status + diff analysis in report; semantic correctness is MO-1, not an infrastructure guarantee |
| TS-5 | Cost governance | Per-run ceiling enforced | No run exceeds 2x estimated cost without notification |
| TS-6 | Test integrity | 8,088+ tests green | Every commit passes; build <5s; no target project regression |

### Measurable Outcomes (Validation Milestones — Post-Delivery)

| # | Outcome | Target | Baseline Source |
|---|---------|--------|-----------------|
| MO-1 | Unattended completion | 80% stories succeed on 10+ story self-hosting run | Pre-Phase-D baseline run |
| MO-2 | Self-recovery rate | 50% of prompt-addressable first-attempt failures recovered | Pre-Phase-D baseline run |
| MO-3 | Learning effectiveness | 75% reduction in repeat prompt-addressable failures (same root cause category AND same file/namespace target). Evaluated only when baseline produces >= 4 prompt-addressable failures | Consecutive run comparison |

---

## 4. Product Scope

### MVP — Phase D Core

All five capabilities plus cross-cutting adapter hardening. The minimal viable autonomous loop:

1. Output Verification (co-primary) — per-story build check, diff validation, phantom review detection
2. Unified Run Model (co-primary) — durable scope persistence, per-story lifecycle, crash recovery
3. Intelligent Stall Detection — phase-aware, backend-aware thresholds with process liveness
4. Closed Learning Loop — root cause taxonomy, advisory injection, dispatch pre-condition gating, finding validation
5. Cost Governance — per-story retry budget, per-run ceiling, cost reporting
6. Cross-cutting: adapter hardening, `--halt-on` severity threshold, structured completion report, headless invocation support

### Post-MVP — Phase E Candidates

- Parallel story execution / concurrency dispatch (run model supports it by design)
- Multi-epic sequencing (carry findings across epic boundaries)
- Universal backend portability / plugin system
- CI/CD event-triggered runs (headless invocation enables this)
- Multi-backend cost-optimized routing

### Vision

- Substrate develops itself with verified, unattended pipeline runs
- One operator oversees 10+ concurrent pipelines
- Event-triggered runs from CI/CD with machine-readable exit codes

---

## 5. User Journeys

### Journey 1: The Overnight Run (Primary — Full Autonomous)

**Persona:** Experienced substrate operator, comfortable with the system, has run 5+ successful tethered runs.

**Before Phase D:**
Alex starts a 12-story epic run at 4 PM. She monitors the terminal, watching NDJSON events stream by. At 4:47 PM, story 3's code review takes 28 minutes — the supervisor declares a stall and kills it. She manually restarts. At 5:30 PM, story 6 fails because it tries to create a class that story 4 already created. She manually edits the story spec and re-dispatches. At 7 PM, she notices story 9 produced only 14 output tokens but was marked "complete." She adds it to her mental list of stories to re-check. At 9 PM, 10 of 12 stories are "done" but she has low confidence in 3 of them. She'll manually verify tomorrow.

**After Phase D:**
Alex starts the same run at 4 PM with `substrate run --events --halt-on none`. She closes her laptop and goes home. At 4:47 PM, story 3's code review runs for 28 minutes — the supervisor sees CPU activity and growing output, and does not intervene. At 5:30 PM, story 6's dispatch is blocked by a pre-condition gate: `TelemetryAdvisor` already exists from story 4. The system retries with context: "Extend existing class instead of creating new." Story 6 succeeds on retry. At 7 PM, story 9 produces 14 output tokens and is flagged as unverified — the verification layer marks it ESCALATED with root cause "trivial-output." At 9:15 PM, the run completes. Cost: $3.40 (under the $8.00 ceiling).

The next morning, Alex runs `substrate report` and sees: 11/12 stories verified-complete, 1 escalated (story 9: trivial output, suggested action: "Re-run with increased maxTurns"). She re-runs story 9 with `substrate run --stories 9 --halt-on critical`. Done in 12 minutes. Total operator time: 15 minutes.

### Journey 2: Building Trust (Primary — Graduated Confidence)

**Persona:** New operator, first time running substrate autonomously.

Sam has been using substrate in attended mode for a week. He starts a 6-story run with `substrate run --events --halt-on all`. The system runs but halts whenever it would make a recovery decision: "Story 2 failed with namespace-collision. Retry with context? [y/n]." Sam reviews the context, approves, and the retry succeeds. After 3 runs with zero scope violations, he moves to `--halt-on critical`. Now the system only halts on severe failures. After 5 clean tethered runs, he's confident enough for `--halt-on none`.

### Journey 3: The Self-Hosting Loop (Secondary — Dogfooding)

**Persona:** Substrate developer using substrate to develop substrate.

The substrate team is developing Phase E. They run `substrate run --events --stories 51-1,51-2,51-3 --halt-on critical` against substrate's own codebase. The learning loop has findings from Phase D's development: "Story 50-7 failed because FanInBranchResult was created in the wrong package." When story 51-2 touches the same area, the advisory injection warns: "FanInBranchResult shared type lives in @substrate-ai/core, not @substrate-ai/factory." Story 51-2 gets it right on the first attempt.

The post-run report shows build verification passed for all 3 stories, diff analysis confirms non-trivial changes, and all 8,088+ tests pass. The team reviews and accepts.

### Journey 4: The Cost-Conscious Run (Secondary — Budget Control)

**Persona:** Operator running pipeline on a cost-sensitive project.

Dana sets `--cost-ceiling 5.00` on a 10-story run. At story 7, the cumulative cost hits $4.50. Story 7's first attempt fails and the system would retry — but the retry would push estimated cost to $5.80. The system pauses with: "Cost ceiling approaching ($4.50/$5.00). Story 7 retry estimated at $1.30. Pausing. Options: [raise ceiling] [skip story 7] [abort run]." Dana raises the ceiling to $7.00 and the run continues.

### Journey 5: Morning Review (Primary — Reviewer Workflow)

**Persona:** Operator reviewing an overnight run.

Alex arrives at 8 AM. She runs `substrate report --run latest`:

```
Run #a3f7c2d — completed 2026-04-06T03:42:18Z
Stories: 12 total | 10 verified-complete | 1 recovered | 1 escalated
Cost: $3.40 / $8.00 ceiling
Duration: 4h 12m

VERIFIED (10):
  51-1  auth-middleware     ✓ build ✓ diff(+347/-12) ✓ quality:87
  51-2  token-refresh       ✓ build ✓ diff(+203/-8)  ✓ quality:91
  ...

RECOVERED (1):
  51-6  adapter-registry    ✗ attempt-1 (namespace-collision)
                            ✓ retry-with-context → build ✓ diff(+189/-22) quality:78
                            Recovery: "Extended existing AdapterRegistry instead of creating new"

ESCALATED (1):
  51-9  perf-benchmarks     ✗ trivial-output (14 tokens)
                            Suggested: Re-run with --max-turns 50
                            Blast radius: none (no downstream dependencies)
```

Alex accepts the 10 verified stories and the 1 recovery. She re-runs story 51-9 with the suggested fix. Total review time: 8 minutes.

---

## 6. Domain-Specific Requirements

### 6.1 Multi-Agent Orchestration Constraints

- **Agent opacity**: Dispatched agents (Claude Code, Codex) are black boxes. Verification cannot inspect agent reasoning, only outputs (files changed, tokens consumed, exit codes). All verification must be post-hoc, not inline.
- **Token economics**: Every retry, verification check, and learning loop query consumes tokens. Phase D must be cost-conscious in its own operation — verification that costs more than the story it verifies is counterproductive.
- **Backend heterogeneity**: Different backends produce different output formats, consume tokens at different rates, and have different timeout characteristics. Phase D capabilities must be backend-agnostic or backend-parameterized (via timeout multipliers, format normalization).
- **Self-hosting recursion**: Substrate runs on itself. Phase D changes to the supervisor, orchestrator, or verification layer affect the system's ability to develop itself. Regressions are immediately felt.

### 6.2 State Management Constraints

- **File-backed run manifest**: The run manifest (scope, config, lifecycle state) must be file-backed JSON (per established feedback constraint: no SQLite for run manifest).
- **Dolt for analytics**: Metrics, telemetry, decisions, and historical state remain in Dolt. The run manifest and Dolt serve distinct purposes with no overlap.
- **Crash recovery**: The run model must survive process death (OOM, SIGKILL, power loss). The system must be able to reconstruct current state from durable storage alone.
- **Forward compatibility**: The run model schema must support per-story independent state tracking to enable Phase E parallel execution without schema migration.

### 6.3 Existing Infrastructure Integration

Phase D builds on existing infrastructure, extending rather than replacing:

| Existing Component | Phase D Relationship |
|---|---|
| Convergence loop budget controls (Epic 45) | Extended to cover retry + verification costs |
| OutputQualityEstimator (v0.19.17) | Composed with new verification layer, not replaced |
| diffStats (v0.19.16) | Incorporated into verification report |
| `project-findings.ts` (2,000-char cap) | Replaced by relevance-ranked, validated injection |
| Supervisor `handleStallRecovery` | Replaced by phase-aware, backend-aware detection |
| `pipeline_runs` Dolt table | Becomes read-through projection from run manifest (or co-authoritative, per architecture decision) |

---

## 7. Functional Requirements

### 7.1 Output Verification

**Tier A** (pre-run-model, can ship as Increment 1):

| # | Requirement |
|---|-------------|
| FR-V1 | The system can distinguish review-dispatch failures from review verdicts and never produces fallback verdicts from failed dispatches |
| FR-V2 | The system can flag stories with <100 output tokens as unverified and escalate them with root cause "trivial-output" |
| FR-V9 | The default verification path (build check + phantom review detection) executes without LLM calls |
| FR-V11 | Verification commands (build check, git diff) execute with a hard timeout (default: 60 seconds). Verification timeout or crash results in the story being marked "verification-failed" (distinct from "failed"), included in the completion report, and does not block subsequent stories |

**Tier B** (requires run model from Increment 2):

| # | Requirement |
|---|-------------|
| FR-V3 | The system can validate that story diffs are non-trivial via git diff analysis after each story completes |
| FR-V4 | The system can run build verification after each individual story, not just at the end of the run |
| FR-V5 | The system can detect conflicting type definitions or duplicate namespace creation across stories in the same run, using observed file overlap from git diffs (post-hoc) |
| FR-V5a | The system extracts a file-level modification set from each completed story's git diff (--name-only) for use in cross-story conflict detection |
| FR-V6 | The system can detect contract mismatches between story outputs (e.g., story A exports interface X, story B imports interface X with different shape) |
| FR-V7 | The system can perform AC-to-test traceability via heuristic matching between acceptance criteria text and test names/descriptions (on-demand, not default path) |
| FR-V8 | The system can feed verification findings (false completions, trivial diffs, phantom reviews) back into the learning store as first-class inputs |
| FR-V10 | The system can produce a structured completion report with per-story build status, diff analysis, quality scores, cost breakdown, and recovery history |

### 7.2 Unified Run Model

| # | Requirement |
|---|-------------|
| FR-R1 | The system can persist original CLI flags (--stories, --epic, --agent, --halt-on, --cost-ceiling) in a durable run manifest |
| FR-R2 | The system can persist per-story lifecycle state (pending, dispatched, in-review, complete, failed, escalated, recovered) independently per story |
| FR-R3 | The system can persist supervisor ownership (which supervisor instance is attached, session ID) in the run manifest |
| FR-R4 | The system can persist recovery history per story (attempts, strategies used, outcomes) |
| FR-R5 | The system can persist cumulative cost accumulation per story and per run |
| FR-R6 | The system can recover run state from durable storage after process crash (OOM, SIGKILL) without data loss |
| FR-R7 | The supervisor can read the original story scope from the run manifest when restarting, preserving scope 100% of the time |
| FR-R8 | The `substrate status`, `substrate health`, and `substrate resume` commands all read from consistent state |
| FR-R9 | The run manifest is file-backed JSON; the Dolt state layer stores metrics, telemetry, and decisions separately |
| FR-R10 | The run model schema supports per-story independent state tracking (forward-compatible with Phase E concurrency) |
| FR-R11 | The run manifest uses flock-based advisory locking (or PID-file with liveness check) to enforce single-supervisor ownership. A second supervisor attachment attempt fails with a clear error identifying the existing supervisor |

### 7.3 Intelligent Stall Detection

| # | Requirement |
|---|-------------|
| FR-S1 | The supervisor can apply phase-aware staleness thresholds: create-story (5 min), dev-story (15 min), code-review (15 min), test-plan (10 min) |
| FR-S2 | The supervisor can multiply staleness thresholds by the active backend's timeout multiplier (e.g., Codex 3.0x) |
| FR-S3 | The supervisor can detect process liveness via CPU sampling and child PID tracking |
| FR-S4 | The supervisor can override staleness determination when liveness signals indicate an active agent (CPU > 0%, growing output) |
| FR-S3a | When CPU sampling returns zero or is unavailable (container, unsupported OS), the system falls back to output-growth detection (comparing story output size at consecutive poll intervals). Stall detection requires at least two independent signals before declaring a zombie |
| FR-S5 | The supervisor can detect and report zombie processes (child PID exists but CPU = 0 for extended period, confirmed by output-growth stagnation) |

### 7.4 Closed Learning Loop — Advisory Injection

| # | Requirement |
|---|-------------|
| FR-L1 | The system can classify failure root causes using a fixed taxonomy: namespace-collision, dependency-ordering, spec-staleness, adapter-format, build-failure, test-failure, resource-exhaustion |
| FR-L2 | The system can persist classified findings with root cause tags in the decision store |
| FR-L3 | The system can rank findings by relevance to the current story's domain/files when injecting into prompts |
| FR-L4 | The system can deduplicate findings so the same finding doesn't consume prompt budget across consecutive runs |
| FR-L5 | The system can propagate findings intra-run: when story N fails, the finding is immediately available to story N+K's prompts within the same run |
| FR-L6 | The system can validate finding relevance before injection (verify the conflicting class/file still exists) |
| FR-L3a | Relevance is computed as a weighted score: file-path overlap between finding's affected files and story's target files (weight: 0.5), package membership match (weight: 0.3), root cause category match with story's risk profile (weight: 0.2). Findings scoring below configurable threshold (default: 0.3) are excluded from injection |
| FR-L7 | The system can distinguish high-confidence findings (verified by code analysis) from low-confidence findings (inferred from output patterns) and inject them with appropriate framing (directive vs. warning) |
| FR-L8 | Findings have a maximum lifetime (configurable, default: 5 runs). Expired findings are archived, not injected. Findings contradicted by subsequent successful runs (same file/namespace, opposite outcome) are automatically demoted to low-confidence or retired |

### 7.5 Closed Learning Loop — Dispatch Gating

| # | Requirement |
|---|-------------|
| FR-G1 | The system can check for known conflicts between a story's target files/namespaces (extracted from its spec) and files already modified by completed stories in the current run (observed state, not predicted intent) |
| FR-G2 | The system can block a story's dispatch when a hard conflict is detected, holding it until the conflict is resolved |
| FR-G3 | The system can resolve gating conflicts automatically when possible (e.g., retry with "extend existing" instead of "create new") |
| FR-G4 | The system can escalate gating conflicts that cannot be auto-resolved, with conflict description and suggested resolution |

### 7.6 Escalation Recovery

| # | Requirement |
|---|-------------|
| FR-E1 | The system can retry failed stories with diagnostic context injected (retry-with-context, fully autonomous) |
| FR-E2 | The system can propose re-scope or split for failed stories, requiring operator approval before execution |
| FR-E3 | After 2 pending operator-approval proposals, the system pauses only stories that depend on the escalated stories (per work graph dependency edges). Independent stories continue dispatching. The run pauses entirely only when 5+ proposals are pending or all remaining stories depend on escalated stories |
| FR-E4 | The system can produce escalation reports with: root cause category, recovery attempts and outcomes, minimal operator action needed, and estimated blast radius |
| FR-E5 | Retry-with-context is the primary recovery mechanism; re-scope and split are rare, not default |

### 7.7 Cost Governance

| # | Requirement |
|---|-------------|
| FR-C1 | The operator can set a per-story retry budget via configuration (default: 2 retries) |
| FR-C2 | The operator can set a per-run cost ceiling via `--cost-ceiling <amount>` CLI flag |
| FR-C3 | The system can pause the run when cumulative cost approaches the ceiling, presenting options to the operator |
| FR-C4 | The system can track and report cost per story including all retry and verification costs |
| FR-C3a | Cost ceiling enforcement operates between story dispatches, not mid-story. A single story dispatch may exceed the remaining budget. The system estimates the next story's cost before dispatch and warns if it would exceed the ceiling |
| FR-C3b | When --halt-on none is active and the cost ceiling is reached, the system stops dispatching new stories, completes any in-progress story, and finalizes the run with status "budget-exhausted". Remaining undispatched stories are reported as "skipped (budget)" in the completion report |
| FR-C5 | The existing convergence loop budget controls (node/pipeline/session) are extended to cover Phase D retry and verification costs |

### 7.8 Operating Modes & CLI

| # | Requirement |
|---|-------------|
| FR-O1 | The operator can configure halt severity via `--halt-on <all\|critical\|none>` CLI flag (default: critical) |
| FR-O2 | `--halt-on all` halts on any recovery decision, presenting the decision to the operator |
| FR-O3 | `--halt-on critical` halts only on scope violations, cost ceiling breaches, and build verification failures; emits notification signal |
| FR-O4 | `--halt-on none` runs to completion, escalating what it can't fix |
| FR-O5 | The system can emit file-based notification signals when halting in tethered mode (webhook deferred to Phase E) |
| FR-O6 | The system supports headless invocation: machine-readable exit codes (0 = all passed, 1 = some escalated, 2 = run failed), structured JSON output, `--non-interactive` flag |
| FR-O7 | The operator can view a structured completion report via a new `substrate report` command or enhancement to `substrate metrics` |
| FR-O8 | In interactive mode (default when --non-interactive is not set), the system presents recovery decisions as numbered choices on stdout and accepts operator input via stdin. The system resumes from the exact decision point after operator input |

---

## 8. Non-Functional Requirements

### 8.1 Performance

| # | Requirement | Target |
|---|-------------|--------|
| NFR-P1 | Build time | <5 seconds (current: ~1.5s) |
| NFR-P2 | Default verification overhead per story | <30 seconds typical-case (build check + diff validation, no LLM calls); 60 seconds hard ceiling per FR-V11 |
| NFR-P3 | Run model read/write latency | <50ms for any single operation (file-backed JSON) |
| NFR-P4 | Stall detection poll interval | Configurable, default 30 seconds (current behavior) |

### 8.2 Reliability

| # | Requirement | Target |
|---|-------------|--------|
| NFR-R1 | Crash recovery | Run state reconstructable from durable storage after any process termination |
| NFR-R2 | Run scope integrity | Zero unscoped pipeline executions across all operating modes |
| NFR-R3 | Verification accuracy | Zero false-positive "completed" stories (no phantom verdicts, no trivial-output successes) |
| NFR-R4 | Target project safety | Autonomous recovery actions must not regress target project's test suite |

### 8.3 Scalability

| # | Requirement | Target |
|---|-------------|--------|
| NFR-S1 | Story count per run | Support 30+ stories in a single run (current validated max: 17) |
| NFR-S2 | Findings accumulation | Learning store handles 100+ findings across 20+ runs without prompt budget exhaustion (relevance ranking + deduplication) |
| NFR-S3 | Run duration | Support 8+ hour unattended runs without resource exhaustion (memory, file descriptors, disk) |

### 8.4 Compatibility

| # | Requirement | Target |
|---|-------------|--------|
| NFR-C1 | Backend compatibility | Existing Claude Code and Codex adapters work without substrate code changes for 5-story runs |
| NFR-C2 | Existing test suite | 8,088+ tests pass at every commit |
| NFR-C3 | Existing CLI | All existing commands (`run`, `status`, `health`, `resume`, `cancel`, `metrics`) continue to work; new functionality is additive |
| NFR-C4 | Dolt optional | System degrades gracefully when Dolt is unavailable (run model works; learning store falls back to file-based; metrics skipped) |

---

## 9. Project Scoping & Phased Development

### MVP Strategy

Phase D's MVP is the minimal set of capabilities that enables a single unattended pipeline run to complete with verified results. The ordering is:

**Increment 1 — Immediate Trust (Output Verification)**
Can ship before the full run model. Delivers per-story build checks, diff validation, phantom review detection, and the structured completion report. This is the highest-value, lowest-dependency increment.

**Increment 2 — State Foundation (Unified Run Model)**
The run model is the foundation for all other capabilities. Budget: 1 epic, max 8 stories. Architecture evaluates full unification vs. reconciliation layer. Scope persistence and crash recovery are the minimum viable deliverables.

**Increment 3 — Reliability (Stall Detection + Cost Governance)**
With the run model in place, these proceed in parallel. Phase-aware backend-aware thresholds and cost ceilings.

**Increment 4 — Intelligence (Learning Loop + Escalation Recovery)**
Requires the run model and root cause taxonomy. Advisory injection, dispatch pre-condition gating, finding validation, and tiered escalation recovery.

**Increment 5 — Polish (Operating Modes + Headless Support)**
The `--halt-on` severity threshold, notification signals, and machine-readable exit codes. Delivered as CLI enhancements across all increments rather than a separate block.

### Risk Mitigation Strategy

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Run model design too ambitious (eats timeline) | Medium | High | Budget cap: 1 epic, 8 stories. Architecture evaluates reconciliation layer alternative. |
| Learning loop amplifies errors (bad classification → bad advice) | Medium | High | Finding validation mechanism before injection. High/low confidence distinction. |
| Verification too expensive (doubles run cost) | Low | Medium | Lightweight default path. No LLM calls in default. AC traceability is on-demand only. |
| Escalation proposals accumulate (worse than babysitting) | Low | Medium | Max 2 pending proposals before pause. Retry-with-context is primary; re-scope is rare. |
| No baseline established (can't measure improvement) | High | Medium | Mandatory pre-Phase-D baseline run (prerequisite, not optional). |
| Adapter hardening scope creep | Low | Low | Demoted from standalone capability to cross-cutting. No plugin system in Phase D. |

---

## 10. Capability Dependencies

```
Increment 1: Output Verification (co-primary, can start immediately)
  │
  ↕ feedback circuit
  │
Increment 2: Unified Run Model (co-primary, foundation)
  │
  ├── Increment 3a: Intelligent Stall Detection (parallel)
  ├── Increment 3b: Cost Governance (parallel)
  │
  └── Increment 4: Closed Learning Loop (requires run model + taxonomy)
        ├── Advisory Injection (inter-run + intra-run)
        ├── Dispatch Pre-condition Gating
        └── Escalation Recovery

Cross-cutting: Adapter Hardening, Operating Modes, Headless Support
```

Output Verification and the Unified Run Model are co-primary. A minimal verification layer (per-story build check + diff validation + phantom review detection) can ship as a standalone increment before the full run model redesign, delivering immediate trust value. The remaining capabilities depend on the run model.

---

## 11. Design Constraints

1. **No shortcuts, no tech debt** — full planning cycle for all capabilities
2. **Language-agnostic** — no language-specific logic outside detection/config layers
3. **File-backed run manifest** — JSON; Dolt for metrics/telemetry/decisions (distinct purposes)
4. **Concurrency-ready schema** — per-story independent state for Phase E
5. **Extend, don't replace** — convergence loop budget controls (Epic 45) extended, not rebuilt
6. **Lightweight verification default** — no LLM calls in default verification path
7. **Run model budget** — 1 epic, max 8 stories; if it doesn't fit, simplify the design
8. **Existing tests** — 8,088+ tests pass at every commit; build <5 seconds
9. **Atomic manifest writes** — Run manifest writes use atomic file replacement (write to temp, fsync, rename) with backup of previous version. If current manifest fails integrity check, fall back to backup with warning
10. **Dual-signal stall detection** — Stall detection requires at least two independent signals before declaring a zombie; CPU sampling is supplementary, not required (may be unavailable in containers)
