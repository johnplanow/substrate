---
title: "Product Brief: Substrate Phase D — Autonomous Operations"
status: "complete"
created: "2026-04-05"
updated: "2026-04-05"
inputs:
  - "_bmad-output/planning-artifacts/phase-d-concept-autonomous-operations.md"
  - "docs/findings-epic30-run-2026-03-14.md"
  - "docs/findings-cross-project-epic4-2026-03-05.md"
  - "docs/workflow-gap-analysis.md"
  - "memory/project_codex_improvement_backlog.md"
  - "memory/project_codex_validation_2026_04_01.md"
  - "memory/project_boardgame_improvement_suggestions.md"
review_lenses:
  - "skeptic-reviewer (15 findings)"
  - "opportunity-reviewer (11 findings)"
  - "developer-experience-critic (11 findings)"
elicitation:
  - "first-principles analysis (5 assumptions challenged)"
  - "pre-mortem analysis (5 failure scenarios)"
---

# Product Brief: Substrate Phase D — Autonomous Operations

## Executive Summary

Substrate is a multi-agent orchestration daemon that drives AI coding agents through full SDLC pipelines — from analysis through planning, solutioning, and implementation. After three phases of development (50 epics, 8,088 tests, cross-project and cross-backend validation), the system can reliably produce working code across TypeScript, Python, and Go codebases. But it can't do it alone — and worse, it can silently produce wrong output with no way for the operator to know.

Every validation run to date has required human intervention. The Epic 30 self-hosting run dispatched unrelated epic work when the supervisor lost scope. The cross-project Epic 4 run implemented two stories against the wrong epic specification. Phantom code reviews produced "NEEDS_MINOR_FIXES" verdicts without ever reviewing code. These aren't just operational inconveniences — they are trust-destroying failures that undermine confidence in the entire system. Phase D closes that gap.

The goal: **a multi-story pipeline run starts, runs overnight, and reports verified results in the morning — no human in the loop.** This isn't about adding features. It's about making the existing pipeline self-aware enough to reason about its own state, detect its own failures, learn from its own history, and verify its own output. Phase D transforms substrate from a powerful tool into reliable autonomous infrastructure.

## The Problem

The current system can ship code, but it cannot be trusted to ship code unsupervised. The failure modes fall into five categories, and together they make every pipeline run an operator-dependent process.

**The system forgets what it was doing.** A "run" is spread across four sources of truth — a JSON manifest, a Dolt database table, supervisor memory, and an event stream. The core issue: no single consumer reads all four. When the supervisor restarts a stalled pipeline, it loses the original story scope and discovers every ready story across every epic. This P0 bug caused the supervisor to start dispatching unrelated Epic 31 work during an Epic 30 run — a scope violation that could have shipped unauthorized code changes to a production codebase.

**The system can't tell working from stuck.** Stall detection relies on `last_activity` timestamps that only update on phase transitions. During a 30-minute code review — normal, healthy behavior — the supervisor declares a stall and kills the agent. Phase-aware thresholds don't exist. Process liveness detection returns null. And stall thresholds are not backend-aware: a 15-minute threshold appropriate for Claude false-positives on every Codex dispatch (which runs 4-8x slower).

**The system doesn't learn.** Findings from failed runs are captured in the decision store, supervisor reports, and experiment verdicts. A partial injection mechanism exists (`project-findings.ts`, capped at 2,000 chars), but it lacks relevance ranking, inter-vs-intra-run distinction, and root cause classification. Run N+1 hits the same namespace collision, the same dependency ordering bug, the same spec staleness issue that killed stories in run N. The data exists; the effective feedback loop doesn't.

**The system can't verify itself.** Code review fallback verdicts silently produce "NEEDS_MINOR_FIXES" when the review dispatch itself fails — zero code was actually reviewed, but the pipeline records a passing verdict. Major rework gets the same treatment as minor fixes. There's no AC-to-test traceability. Stories that produce <100 output tokens are counted as successes. Cross-story consistency is unchecked: story 8 can break assumptions story 3 made, and no one notices until all 10 are "complete."

**Non-Claude backends are fragile.** Codex required four substrate code changes (v0.19.11-v0.19.14) to dispatch one story successfully. Token tracking is heuristic-only. Output format compliance varies by backend. Each new backend is a manual integration project rather than a configuration exercise.

## The Solution

Phase D introduces five core capabilities that collectively enable unattended pipeline execution. The ordering reflects priority: Output Verification and the Unified Run Model are co-equal foundations; the remaining capabilities build on them.

### 1. Output Verification (co-primary with Run Model)

The system's inability to verify its own output is the most trust-destroying problem. An operator who can trust the output will tolerate babysitting; an operator who can't trust the output won't tolerate autonomy. Verification is therefore elevated to co-primary priority.

A post-implementation verification layer that produces a verifiable completion report:

- **Review verdict accuracy**: Distinguish review-dispatch failures (error) from review-ran-and-found-issues (verdict). Failed dispatches retry or escalate; they never produce fallback verdicts. Major rework triggers full re-dev with findings injected, not a patch.
- **Story output validation**: Flag stories with <100 output tokens as unverified. Validate that story diffs are non-trivial via git diff analysis. Run build verification after each story, not just at the end.
- **Cross-story consistency**: Validate no conflicting type definitions or duplicate namespace creation across stories in the same run. Detect contract mismatches between story outputs. Run only when stories share file-level dependencies (detectable from story specs) to keep costs low.
- **AC traceability** (optional, on-demand): For each acceptance criterion, verify that corresponding test coverage exists via heuristic matching between AC text and test names/descriptions. This is approximate, not exact, and should not require an LLM call in the default verification path.

**Feedback circuit**: Verification findings (false completions, trivial diffs, phantom reviews) feed back into the learning store as first-class inputs, enabling self-calibrating quality thresholds over time.

**Design principle**: Verification must be lightweight by default. Per-story build check and diff validation are mandatory and cheap. AC traceability and cross-story consistency are targeted (triggered by risk signals), not exhaustive. No LLM calls in the default verification path.

### 2. Unified Run Model (co-primary with Verification)

A coherent representation of a pipeline run's scope, state, configuration, and lifecycle. The supervisor, orchestrator, status endpoints, and resume command all operate on consistent state. No more split-brain.

The run model persists: original CLI flags, story scope, supervisor ownership, per-story lifecycle state, recovery history, and cost accumulation. It must survive process crashes (durable, not in-memory).

**Implementation spectrum**: The architecture phase should evaluate options ranging from full state unification (single authoritative store, all others become projections) to a reconciliation layer (each consumer cross-checks with others, divergence raises alerts). A reconciliation layer that persists scope and detects divergence may deliver 80% of the value at 20% of the cost of full unification. The brief does not prescribe the implementation — the architecture doc decides.

**Budget constraint**: The run model is a foundation, not the product. It must fit within 1 epic, max 8 stories. If the architecture can't fit that budget, the design is too ambitious.

**Design constraint**: The run model schema must support per-story independent state tracking to enable future parallel execution (Phase E) without schema migration.

**Design constraint**: Clarify the relationship between the file-backed run manifest (scope, config, lifecycle) and the Dolt state layer (metrics, telemetry, decisions). The run manifest (scope, configuration, lifecycle state) is file-backed JSON. The decision store, metrics, and telemetry remain in Dolt. No consumer needs to atomically read from both to determine run state.

### 3. Intelligent Stall Detection

Phase-aware staleness thresholds combined with process liveness signals. The supervisor distinguishes "working but quiet" from "actually stuck." Baseline thresholds (create-story: 5 min, dev-story: 15 min, code-review: 15 min) are multiplied by the active backend's timeout multiplier (e.g., Codex 3.0x), ensuring backend-aware detection without per-backend configuration.

Process liveness signals (CPU sampling, child PID tracking) provide staleness overrides: an agent at 5% CPU with growing output is working, not stuck, regardless of the timestamp.

### 4. Closed Learning Loop

This capability decomposes into three distinct sub-problems with two distinct mechanisms:

**Mechanism A — Advisory injection** (soft guidance in prompts):
- **Inter-run findings persistence**: Findings from run N are classified by root cause (taxonomy: namespace-collision, dependency-ordering, spec-staleness, adapter-format, build-failure, test-failure, resource-exhaustion) and injected into run N+1's prompts. A relevance scoring mechanism prioritizes findings applicable to the current story's domain/files over generic operational findings, with deduplication so the same finding doesn't consume budget across 10 consecutive runs.
- **Intra-run real-time propagation**: When story N fails within a run, the finding is immediately available to story N+3's prompts in the same run.

**Mechanism B — Dispatch pre-condition gating** (hard blocks):
- Before dispatching a story, check for known conflicts (e.g., a class the story intends to create already exists from a prior story). If a hard conflict is detected, the story is held — not dispatched with a warning, but blocked until the conflict is resolved. This addresses dependency ordering issues (the 30-6/30-8 namespace collision) where prompt injection is insufficient.

**Finding validation**: Before injecting a finding into a prompt, verify that it is still relevant (does the conflicting class still exist? has the spec been updated?). High-confidence findings (verified by code analysis) are injected directly. Low-confidence findings (inferred from output patterns) are presented as warnings, not directives.

**Escalation recovery**: Failed stories get recovery strategies tiered by autonomy level. **Retry-with-context** (fully autonomous): same scope, additional diagnostic context injected — this is the primary recovery mechanism. **Re-scope / split** (operator approval required): the system proposes the change and waits for confirmation. After 2 pending operator-approval escalations, the system pauses the run rather than continuing to accumulate proposals. This boundary exists because re-scoping is a product decision, not an infrastructure decision.

**Scope note**: The learning loop addresses semantic failures (namespace collisions, spec staleness, naming patterns) that are prompt-addressable. Infrastructure bugs (parser regex, schema mismatches, OOM) require code fixes and are outside the learning loop's scope. Success metrics apply only to the prompt-addressable category.

### 5. Cost Governance

Autonomous retry, recovery, and verification all consume tokens. Unattended runs need spending guardrails:

- **Per-story retry budget**: Maximum retry attempts before mandatory escalation (default: 2 retries, configurable).
- **Per-run cost ceiling**: Automatic pause when cumulative cost approaches operator-configured limit. The existing convergence loop budget controls (node/pipeline/session from Epic 45) are extended to cover retry and verification costs.
- **Cost-per-story in completion report**: Operator sees exactly what each story cost, including recovery attempts.

### Adapter Hardening (cross-cutting, not a standalone capability)

Rather than a standalone capability, adapter stability improvements are delivered as hardening work during implementation of other capabilities. When building the verification layer, harden the review dispatch's adapter handling. When building stall detection, ensure backend timeout multipliers flow through correctly. Concretely:

- Existing adapters (Claude Code, Codex) handle output format variance without substrate code changes for a 5-story run.
- Format normalization layer converts backend output into canonical form before downstream processing.
- Structured error reporting when adapter self-correction fails.

"New backend works on first integration without code changes" is a Phase E aspiration that requires a plugin/contract system. Phase D focuses on making existing adapters robust.

## What Makes This Different

This is not a monitoring dashboard or alerting layer bolted onto an existing system. It's a fundamental upgrade to substrate's self-awareness — the system's ability to verify its own output, reason about its own state, detect its own failures, learn from its own history, and govern its own spending.

The key architectural insight: capabilities share a common dependency on consistent run state. Session state, stall detection, learning loop, output verification, and cost governance all need to agree on what a "run" is, what it's supposed to do, and what happened. Get that right, and the capabilities compose naturally. Get it wrong, and they're independent patches that don't interact.

Substrate is also its own most demanding customer. It runs its own development pipeline. Every Phase D improvement immediately benefits substrate's ability to develop itself autonomously — the system that makes itself more reliable.

## Who This Serves

**Primary: The substrate operator** — today, the developer who starts pipeline runs, monitors them, and intervenes when things go wrong. Phase D shifts their role from babysitter to reviewer through a configurable autonomy level (see Operating Modes below).

**Secondary: Target project developers** — teams whose codebases substrate operates on. Higher autonomous completion rates mean more consistent, reliable code output with fewer partial or broken implementations. Autonomous recovery actions must not regress the target project's test suite.

**Tertiary: Multi-backend users** — engineers using non-Claude backends (Codex, future providers). Adapter hardening means existing backends work reliably without manual fixes.

## Operating Modes

Rather than three discrete modes, Phase D provides a single autonomous mode with a configurable `--halt-on` severity threshold. This is simpler to implement, simpler to explain, and lets operators customize their comfort level:

- `--halt-on all` (attended): Halts on any recovery decision. Operator watches and overrides. The starting point for building trust.
- `--halt-on critical` (tethered): Halts only on scope violations, cost ceiling breaches, and build verification failures. Emits notification signal (webhook/file) on halt. The "go to lunch" mode.
- `--halt-on none` (full autonomous): Runs to completion, escalates what it can't fix, produces structured completion report. The overnight mode.

Default is `--halt-on critical`. Operators graduate by adjusting the threshold as confidence grows.

## Reviewer Workflow

When the operator arrives to review an autonomous run, they see:

- **Structured completion report** (new CLI command or enhancement to `substrate metrics`): per-story outcome, recovery history, cost breakdown, quality scores — not raw NDJSON events.
- **Per-story actions**: accept, reject, re-run with context, or manually fix.
- **Escalation reports** with: root cause category, recovery attempts and why they failed, minimal operator action needed to unblock, and estimated blast radius (did this failure affect downstream stories?).

Target: an escalated story can be resolved by the operator in under 15 minutes using only the escalation report.

## Success Criteria

### Prerequisite: Baseline Validation Run

Before Phase D implementation begins, run a 10-story validation on the current codebase (v0.19.25) with zero human intervention. Record: how many stories complete, how many fail, what the failure categories are, and total cost. This is the baseline against which all outcome targets are measured. Estimated cost: <$5, ~2-3 hours.

### Infrastructure Guarantees (Phase D Exit Criteria)

These are what Phase D directly controls and must deliver:

1. **Run scope preservation**: The system preserves run scope across supervisor restarts 100% of the time. No unscoped pipeline execution.
2. **Stall detection accuracy**: Zero false-positive stall kills on dispatches within their phase-aware threshold (adjusted for backend multiplier).
3. **Learning injection**: Findings from run N appear in run N+1's prompts with relevance ranking and validation. Root cause classification taxonomy is implemented and applied to all escalations. Dispatch pre-condition gating blocks stories with known conflicts.
4. **Verification completeness**: Post-run report includes per-story build status, diff analysis, quality scores, cost breakdown, and recovery history. Zero false-positive "completed" stories (no phantom verdicts, no <100-token successes).
5. **Cost governance**: Per-run cost ceiling enforced. No unattended run exceeds 2x estimated cost without operator notification.
6. **Test integrity**: 8,088+ tests green at every commit. Build time under 5 seconds. Autonomous recovery actions do not regress the target project's test suite.

### Outcome Targets (Validation Milestones)

These depend on all layers working together and are validated post-delivery against the baseline run:

7. **Unattended completion**: A 10+ story run on substrate's own codebase completes without human intervention, with 80% of stories succeeding autonomously and remaining stories cleanly escalated.
8. **Self-recovery rate**: 50% of first-attempt failures in the prompt-addressable category (namespace collision, spec staleness, format mismatch) are recovered automatically via retry-with-context.
9. **Learning effectiveness**: Repeat failure rate for prompt-addressable failures drops by 75% compared to the baseline validation run.

## Scope

### In Scope (Phase D)

- Output verification layer (verdict accuracy, story validation, cross-story consistency, AC traceability)
- Unified run model with durable state, per-story lifecycle tracking, and crash recovery (budget: 1 epic, max 8 stories)
- Session state persistence (CLI flags, story scope, supervisor ownership)
- Phase-aware, backend-aware stall detection with process liveness signals
- Closed learning loop: root cause taxonomy, relevance-ranked inter-run injection, intra-run propagation, finding validation, dispatch pre-condition gating
- Escalation recovery with tiered autonomy (retry: autonomous; re-scope/split: operator approval; max 2 pending proposals before pause)
- Cost governance (per-story retry budget, per-run ceiling, cost reporting)
- Adapter hardening (format normalization, structured errors — delivered as cross-cutting work, not standalone epic)
- Configurable `--halt-on` severity threshold for operating mode
- Structured completion report and reviewer workflow
- Headless invocation support: machine-readable exit codes, structured JSON output, `--non-interactive` flag
- Pre-Phase-D baseline validation run

### Out of Scope

- Parallel story execution / concurrency dispatch (Phase E; the unified run model supports it by design constraint, but dispatch is separate)
- New backend integrations (Gemini, etc.) — Phase D stabilizes existing; new backends are separate
- Universal backend portability / plugin system (Phase E aspiration)
- External operator UI / dashboard — substrate remains CLI-first
- Cross-project orchestration (running pipelines across multiple repos simultaneously)
- Pre-implementation test planning (Priority 4 workflow gap; deferred until verification layer proves value)
- Multi-epic sequencing (natural extension of learning loop + run model; candidate for Phase E)

### Design Constraints

- No shortcuts, no tech debt — full planning cycle
- Substrate must remain language-agnostic
- File-backed storage for run manifest; Dolt for metrics/telemetry/decisions (distinct purposes, no overlap)
- Run model schema supports concurrent story execution as a forward-compatibility requirement
- Existing convergence loop budget controls (Epic 45) are extended, not replaced
- Verification lightweight by default — no LLM calls in default path
- Run model budget: 1 epic, max 8 stories

## Capability Dependencies

```
Output Verification ←──────────────────┐
  (co-primary, can start immediately    │ feedback circuit
   with minimal run model integration)  │
                                        │
Unified Run Model (foundation)          │
  ├── Intelligent Stall Detection       │
  ├── Cost Governance                   │
  ├── Closed Learning Loop ◄────────────┘
  │     ├── Advisory Injection (inter-run + intra-run)
  │     ├── Dispatch Pre-condition Gating
  │     └── Escalation Recovery
  └── Adapter Hardening (cross-cutting)
```

Output Verification and the Unified Run Model are co-primary. A minimal verification layer (per-story build check + diff validation + phantom review detection) can ship as a standalone increment before the full run model, delivering immediate trust value. The Unified Run Model enables the remaining capabilities. Stall Detection and Cost Governance proceed in parallel once the run model exists. Learning Loop requires the run model and root cause taxonomy. Escalation Recovery requires the learning loop.

## Vision

If Phase D succeeds, substrate becomes a multi-agent orchestration system that can be trusted to run unsupervised. The operator's job changes from "watch the pipeline" to "review the results." This directly unlocks:

- **Overnight execution**: Start a 10-story epic run before bed, review verified results in the morning.
- **Self-hosting autonomy**: Substrate develops itself with verified, unattended pipeline runs.
- **CI/CD integration path**: Headless invocation support makes event-triggered runs possible (Phase E delivery, Phase D enablement).

Longer-term (Phase E+):
- **Batch execution**: Queue multiple epics over a weekend with multi-epic sequencing.
- **Concurrent pipelines**: One operator oversees 10+ parallel runs (requires Phase E concurrency).
- **Multi-backend scheduling**: Route stories to the cheapest available backend with verified results.

Phase D is the inflection point where substrate stops being a tool and starts being infrastructure.
