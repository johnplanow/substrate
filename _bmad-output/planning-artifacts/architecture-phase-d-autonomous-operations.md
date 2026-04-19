---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - prd-phase-d-autonomous-operations.md
  - product-brief-phase-d-autonomous-operations.md
  - product-brief-phase-d-autonomous-operations-distillate.md
  - architecture-software-factory.md
workflowType: architecture
project_name: substrate-phase-d
status: draft
date: "2026-04-05"
---

# Architecture Decision Document: Substrate Phase D — Autonomous Operations

**Version:** 1.1
**Date:** 2026-04-05
**Author:** Human
**Status:** Draft
**Informed by:** PRD Phase D v1.1 (55+ FRs), Product Brief Phase D, Software Factory Architecture v1.1, Codebase analysis (v0.19.25)

---

## 1. Project Context Analysis

### 1.1 Requirements Overview

Phase D adds autonomous operation capabilities to the existing substrate monorepo. The PRD defines 55+ functional requirements across 8 capability areas, 10 non-functional requirements, and 10 design constraints.

**Functional Requirements Summary:**
- Output Verification: 13 FRs (FR-V1 through FR-V11, split into Tier A/B)
- Unified Run Model: 11 FRs (FR-R1 through FR-R11)
- Stall Detection: 7 FRs (FR-S1 through FR-S5, FR-S3a)
- Learning Loop — Advisory: 9 FRs (FR-L1 through FR-L8, FR-L3a)
- Learning Loop — Gating: 4 FRs (FR-G1 through FR-G4)
- Escalation Recovery: 5 FRs (FR-E1 through FR-E5)
- Cost Governance: 7 FRs (FR-C1 through FR-C5, FR-C3a, FR-C3b)
- Operating Modes & CLI: 8 FRs (FR-O1 through FR-O8)

**Non-Functional Requirements:**
- Performance: build <5s, verification <30s/story, run model I/O <50ms
- Reliability: crash recovery, zero unscoped executions, zero phantom verdicts
- Scalability: 30+ stories/run, 100+ findings across 20+ runs, 8+ hour unattended runs
- Compatibility: existing adapters work, 8,088+ tests pass, Dolt optional

### 1.2 Technical Constraints & Dependencies

| Constraint | Source | Architectural Impact |
|---|---|---|
| File-backed run manifest (no SQLite) | Feedback constraint | Run model is JSON on disk, not DB-backed |
| Dolt for metrics/telemetry/decisions | Existing architecture | Two persistence layers with clear boundary |
| Atomic file writes | PRD DC-9 | Write-to-temp + fsync + rename pattern |
| Per-story independent state | PRD forward-compat | Run model schema must not assume sequential execution |
| Lightweight verification default | PRD DC-6 | No LLM calls in default path; verification is static analysis only |
| Run model budget: 1 epic, 8 stories | Product brief | Favors reconciliation/extension over full rewrite |
| 8,088+ tests pass at every commit | Existing | Incremental, backward-compatible changes only |

### 1.3 Cross-Cutting Concerns

1. **Event system integration**: All Phase D capabilities emit events via `TypedEventBus`. New event types needed for: verification results, learning injection, dispatch gating, cost ceiling warnings, operating mode transitions.
2. **Backward compatibility**: All existing CLI commands (`run`, `status`, `health`, `resume`, `cancel`, `metrics`) must continue working. Phase D adds new flags and behaviors, doesn't change existing.
3. **Package placement**: Most Phase D work lives in `@substrate-ai/sdlc` (orchestrator-level concerns). Some capabilities (verification primitives, budget extensions) may touch `@substrate-ai/core`.
4. **Configuration**: New config fields (`halt_on`, `cost_ceiling`, `retry_budget`, `finding_max_lifetime`) extend `SubstrateConfig` via the existing config schema extension pattern.

---

## 2. Core Architectural Decisions

### Decision 1: Run Model — Reconciliation Layer (not full unification)

**Decision:** Extend the existing run manifest (`.substrate/current-run.json`) with scope, per-story state, and recovery history rather than unifying all four state sources into a single store.

**Rationale:**
- Full unification would require rewriting every CLI command's state reader (supervisor, status, health, resume, cancel) — estimated 15+ stories, well over the 1-epic/8-story budget.
- The core problem is not four sources of truth; it's that no consumer reads all four. A reconciliation layer that cross-checks and persists scope solves the P0 (supervisor restart scope loss) directly.
- The existing Dolt `pipeline_runs` table remains the historical/analytics store. The JSON run manifest becomes the operational state of truth for scope and lifecycle.

**Implementation:**
- The run manifest is a single JSON file (`.substrate/runs/{run-id}.json`) containing: `cli_flags`, `story_scope`, `supervisor_pid`, `supervisor_session_id`, `per_story_state{}`, `recovery_history[]`, `cost_accumulation`, `created_at`, `updated_at`.
- All writes use atomic file replacement: write to `.substrate/runs/{run-id}.json.tmp`, fsync, rename. Previous version kept as `.substrate/runs/{run-id}.json.bak`.
- A `RunManifest` class provides typed read/write/lock operations. Two-layer locking prevents concurrent supervisor writes (FR-R11): primary via `flock` on `.substrate/runs/{run-id}.lock`, fallback via PID-file with liveness check (`kill(pid, 0)`) when flock is unavailable (NFS v3, WSL1, rootless containers). Flock failure (ENOSYS, EOPNOTSUPP) triggers automatic fallback with a logged warning.
- `substrate status`, `substrate health`, and `substrate resume` read from the run manifest for scope/lifecycle and from Dolt for metrics/telemetry.
- The supervisor reads `cli_flags.stories` from the manifest on restart, preserving scope (FR-R7).

**Source Demotion Declarations:**

The new run manifest replaces/demotes existing state sources:

| Existing Source | Post-Phase-D Role | Action |
|---|---|---|
| `.substrate/current-run-id` file | **Replaced** by run manifest. Kept only for backward compat (write-through, never read for state). | Demote to write-only alias |
| `.substrate/orchestrator.pid` file | **Replaced** by `supervisor_pid` in run manifest. | Remove after migration |
| Supervisor in-memory `ProjectCycleState` | **Non-authoritative**. Read-through from manifest on startup. In-memory state is a performance cache only. | Document as cache, not source |
| NDJSON event stream | **Write-only audit log**. Never read for state reconstruction. Resume and status read from manifest. | Document as audit, not state |
| Dolt `pipeline_runs` table | **Historical/analytics**. Updated periodically from manifest for metrics queries. Not read for operational decisions. | Demote to analytics projection |

**What lives where:**

| Data | Store | Rationale |
|---|---|---|
| CLI flags, story scope | Run manifest (JSON) | Operational, must survive crash, read on restart |
| Per-story lifecycle state | Run manifest (JSON) | Changes frequently, needs atomic updates |
| Supervisor ownership, session ID | Run manifest (JSON) | Used for locking, must be in same file |
| Recovery history per story | Run manifest (JSON) | Needed for escalation reports |
| Cost accumulation | Run manifest (JSON) | Used for ceiling enforcement between dispatches |
| Token usage metrics | Dolt `pipeline_runs` | Analytics, not operational |
| Decisions, findings | Dolt `decisions` table | Historical, queried by learning loop |
| Story specs, epic shards | Dolt `decisions` table | Existing behavior, unchanged |

**Risks:**
- JSON file I/O is slower than DB queries for large state. Mitigated by: run manifest is small (one object with per-story sub-objects, <100KB for 30 stories).
- Crash during rename is extremely rare on modern filesystems (ext4, APFS) but possible on NFS. Mitigated by: backup file + integrity check on read.

---

### Decision 2: Output Verification — Static Analysis Pipeline

**Decision:** Implement verification as a pipeline of static analysis checks that run after each story's dispatch completes. No LLM calls in the default path.

**Rationale:**
- FR-V9 mandates no LLM calls in default verification. This rules out semantic analysis and forces a static approach.
- The existing `OutputQualityEstimator` (regex-based hedging/error detection, 0-100 score) and `diffStats` (file-level change counts) are already static. Phase D extends this pipeline with additional checks.

**Implementation:**
- A `VerificationPipeline` class runs an ordered chain of `VerificationCheck` implementations:
  1. `PhantomReviewCheck` — detects review-dispatch failures masquerading as verdicts (FR-V1). Checks: was the dispatch exit code non-zero? Was the output empty or schema-invalid? If yes, mark as `verification-failed`, not `NEEDS_MINOR_FIXES`.
  2. `TrivialOutputCheck` — flags stories with <100 output tokens (FR-V2). Uses existing `token_usage_json.stories` data.
  3. `BuildCheck` — runs the target project's build command (FR-V4). Hard timeout: 60 seconds (FR-V11). Uses `child_process.spawn` with `detached: true` and `process.kill(-pid, 'SIGKILL')` on timeout to kill the entire process group (reusing the `getAllDescendants` pattern from supervisor). Failure marks story as `verification-failed`.
  4. `DiffValidationCheck` — runs `git diff --numstat <baseline-sha>..<story-sha>` (FR-V3). Filters binary files (shown as `-` in numstat). Flags if diff is empty or trivially small (<10 lines of non-binary changes). Only runs if BuildCheck passed (broken code diffs are misleading).
  5. `CrossStoryConsistencyCheck` — compares `git diff --name-only --no-renames <baseline-sha>..<story-sha>` across completed stories (FR-V5, FR-V5a). Uses `--no-renames` so both old and new names appear. When two stories modify the same file, runs a type-level conflict check. Triggered only on file overlap.

- Tier A checks (1-3) run immediately, before the run model is complete. BuildCheck has no run model dependency — it shells out to a build command using the existing `detectPackageManager`/`runBuildVerification` pattern in `dispatcher-impl.ts`. Tier B checks (4-5) require per-story state tracking from the run model.
- Each check returns a `VerificationResult { status: 'pass' | 'warn' | 'fail', details: string }`. Results are aggregated into the structured completion report (FR-V10).
- AC traceability (FR-V7) is a separate, on-demand check that does use an LLM call. It is never part of the default pipeline.

**Package placement:** `VerificationPipeline`, `VerificationCheck` interface, and all check implementations live in `packages/sdlc/src/verification/`. The interface is SDLC-specific (references `storyKey`, `commitSha`, `priorStoryFiles`). If a generic quality gate interface is needed in core, `VerificationCheck` extends it in sdlc — same pattern as `IBaseService`.

---

### Decision 3: Stall Detection — Multi-Signal with Backend Awareness

**Decision:** Replace the current single-signal staleness check with a multi-signal detection algorithm that requires two independent signals before declaring a stall.

**Rationale:**
- FR-S3a requires dual-signal confirmation. Single-signal (timestamp only) caused the P0 false-positive kills.
- Backend awareness (FR-S2) is achieved by multiplying thresholds by `timeoutMultiplier`, which is already in the adapter registry (Codex: 3.0x).

**Implementation:**
- Replace `handleStallRecovery` in the supervisor with a `StallDetector` class.
- Signal sources:
  1. **Staleness timer** — phase-aware threshold × backend multiplier. Read from run manifest: current phase (per-story state) and backend (`cli_flags.agent`).
  2. **Output growth** — compare story output size (bytes on disk or token count) between consecutive polls. Zero growth over 2 consecutive polls = stagnation signal.
  3. **Process liveness** — attempt CPU sampling via `/proc/{pid}/stat` (Linux) or `ps -p {pid} -o %cpu` (macOS). If unavailable (container, permission denied), this signal is skipped — output growth becomes the required second signal.
- **Declaration rule:** A stall is declared only when: staleness timer exceeded AND (output stagnation OR process not alive). A zombie is declared when: process alive but CPU = 0 AND output stagnation over 3 consecutive polls.
- Phase-aware thresholds are stored in the run manifest config, not hardcoded: `{ "create-story": 300, "dev-story": 900, "code-review": 900, "test-plan": 600 }` (seconds).

**Package placement:** `StallDetector` lives in `src/modules/supervisor/stall-detector.ts` (extends existing supervisor module).

---

### Decision 4: Learning Loop — Dual-Mechanism with Relevance Scoring

**Decision:** Implement two distinct mechanisms: advisory injection (soft prompt guidance) and dispatch pre-condition gating (hard blocks). Findings are classified, validated, and relevance-scored before injection.

**Rationale:**
- The PRD distinguishes advisory injection (FR-L1-L8) from dispatch gating (FR-G1-G4) as architecturally different mechanisms. Advisory injection works within the existing prompt assembly pipeline. Dispatch gating is a new pre-dispatch check in the orchestrator.
- The existing `project-findings.ts` (2,000-char cap, LIFO) is the starting point for advisory injection. It is replaced, not extended, because the new mechanism needs structured findings with metadata.

**Implementation:**

**Findings Store:**
- A `Finding` type: `{ id, run_id, story_key, root_cause: RootCauseCategory, affected_files: string[], description, confidence: 'high' | 'low', created_at, expires_after_runs: number, contradicted_by?: string }`.
- `RootCauseCategory` enum: `namespace-collision`, `dependency-ordering`, `spec-staleness`, `adapter-format`, `build-failure`, `test-failure`, `resource-exhaustion`.
- Findings are stored in the Dolt `decisions` table (category: `finding`, schema extended with root cause fields). This leverages existing persistence without new tables.

**Advisory Injection (Mechanism A):**
- `FindingsInjector` replaces `getProjectFindings()` in the prompt assembly pipeline.
- Before injection, each finding is validated: check if `affected_files` still exist in the working tree. If not, demote to `low` confidence or skip.
- Relevance scoring per FR-L3a: `score = 0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch`. Jaccard similarity: `intersectionCount / min(findingFileCount, storyFileCount)`. Cap target files per story at 20 (by specificity). Finding saturation guard: if >10 findings score above threshold for a single story, dynamically raise threshold for that story. Findings below threshold (0.3) are excluded. Remaining sorted by score descending, serialized until prompt budget exhausted.
- Findings expire after `expires_after_runs` (default: 5). Findings contradicted by subsequent success on the same file/namespace are retired.
- Intra-run propagation: when a story fails within a run, the `Finding` is written immediately and available to subsequent stories in the same run (since the injector queries at dispatch time).

**Dispatch Pre-condition Gating (Mechanism B):**
- `DispatchGate` runs before each story dispatch in the implementation orchestrator.
- Checks: for each file/namespace the story spec mentions as "create" or "new", check if that file/namespace already exists in the working tree (from a prior story's output).
- If conflict detected: attempt auto-resolution (rewrite the story dispatch prompt with "extend existing {class} instead of creating new"). If auto-resolution is not possible (ambiguous conflict), hold the story as `gated` and escalate.
- The gate queries the run manifest's `per_story_state` to know which stories have completed and which files they modified (from verification's `git diff --name-only`).

**Package placement:** `FindingsInjector` in `packages/sdlc/src/learning/findings-injector.ts`. `DispatchGate` in `packages/sdlc/src/learning/dispatch-gate.ts`. `Finding` type and `RootCauseCategory` in `packages/sdlc/src/learning/types.ts`.

---

### Decision 5: Cost Governance — New Implementation on Budget Skeleton

**Decision:** Implement cost accumulation, ceiling checks, and per-story tracking on top of the existing `BudgetTracker` stub. Enforced between dispatches.

**Rationale:**
- FR-C3a explicitly states cost ceiling operates between dispatches, not mid-story. This aligns with the `checkPipelineBudget` function in `budget-utils.ts`.
- The existing `BudgetTrackerImpl` is a stub (no state, no tracking logic, only event subscriptions). This is new implementation using the existing interface shape, not extension of working code. Stories should be sized accordingly (3-4 stories, not 1-2).

**Implementation:**
- `SubstrateConfig` gains: `cost_ceiling?: number` (per-run, in USD), `retry_budget?: number` (per-story, default: 2).
- CLI flag `--cost-ceiling <amount>` sets it for the run. Persisted in run manifest `cli_flags`.
- Before each dispatch, `checkPipelineBudget()` now also checks: `cumulative_cost + estimated_next_story_cost > cost_ceiling`. If approaching (within 80%), emit a `cost:warning` event. If exceeded, behavior depends on `--halt-on`:
  - `all` or `critical`: pause and prompt operator.
  - `none`: stop dispatching, complete in-progress story, finalize as `budget-exhausted` (FR-C3b).
- Per-story retry budget: after N failed retries, the story is mandatory-escalated regardless of learning loop suggestions.
- Cost tracking per story is already partially implemented via `token_usage_json.stories`. Phase D extends to include retry costs.

**Package placement:** Budget extension in `packages/core/src/budget/`. Cost ceiling check in `src/modules/phase-orchestrator/budget-utils.ts`. Per-story retry tracking in the run manifest.

---

### Decision 6: Escalation Recovery — Tiered Autonomy

**Decision:** Implement escalation recovery as three tiers with dependency-aware pausing.

**Rationale:**
- FR-E5 makes retry-with-context the primary mechanism. Re-scope/split require operator approval.
- FR-E3 (revised) pauses only dependent stories, not the entire run — maximizing autonomy.

**Implementation:**
- `RecoveryEngine` in the implementation orchestrator:
  1. On story failure, classify root cause (using `RootCauseCategory`).
  2. If retry budget not exhausted and root cause is prompt-addressable: retry-with-context (autonomous). Inject the failure diagnosis + relevant findings into the retry prompt.
  3. If retry budget exhausted or non-recoverable: propose re-scope or escalate. Write proposal to run manifest `pending_proposals[]`.
  4. If `pending_proposals.length >= 2`: pause dependent stories only (check work graph dependency edges). Independent stories continue. Full run pause at 5+ pending proposals.
- Proposals include: root cause, attempts made, suggested action, blast radius (which downstream stories are affected).
- In `--halt-on all` mode, every recovery decision halts and presents choices via stdin (FR-O8).
- In `--halt-on none` mode, only autonomous retries execute. Non-recoverable failures are escalated to the completion report without pausing.

**Package placement:** `RecoveryEngine` in `packages/sdlc/src/recovery/recovery-engine.ts`. Integrates with `ImplementationOrchestrator` via event hooks.

---

### Decision 7: Operating Modes — Single Mode with Severity Threshold

**Decision:** Implement `--halt-on <all|critical|none>` as a single code path with a severity filter, not three separate modes.

**Rationale:**
- The product brief's first-principles analysis showed three modes are really one mode with a config knob. A single code path is simpler to implement and test.

**Implementation:**
- Every decision point in the system (recovery, cost ceiling, verification failure, gating conflict) emits a `decision:pending` event with a `severity: 'info' | 'warning' | 'critical' | 'fatal'` field.
- A `DecisionRouter` checks: `if (severity >= halt_threshold) { pause and prompt } else { apply default action }`.
- Severity assignments: retry-with-context → `info` (always autonomous), cost ceiling → `critical`, build failure → `critical`, scope violation → `fatal`, re-scope proposal → `warning`, split proposal → `warning`.
- Interactive prompt (FR-O8): presents numbered choices on stdout, accepts via stdin. Non-interactive mode (`--non-interactive`) applies default actions for all severities.

**Package placement:** `DecisionRouter` in `packages/sdlc/src/operating-mode/decision-router.ts`.

---

### Decision 8: Completion Report — CLI Command

**Decision:** Implement `substrate report` as a new CLI command that reads the run manifest and produces a structured human-readable or JSON output.

**Implementation:**
- `substrate report [--run <id>] [--format human|json]`
- Reads from: run manifest (scope, per-story state, recovery history, cost) + Dolt (token metrics) + verification results (stored in run manifest per story).
- Human format: the table format shown in Journey 5 of the PRD.
- JSON format: structured output for CI/CD integration, machine-readable exit codes.
- Also enhances `substrate metrics` to show the latest run's summary by default.

---

## 3. Implementation Patterns & Consistency Rules

### 3.1 Run Manifest I/O Pattern

All run manifest operations use atomic writes:

```typescript
// Write: serialize → validate → fsync → backup → rename
async writeManifest(runId: string, data: RunManifest): Promise<void> {
  const path = `.substrate/runs/${runId}.json`;
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  const json = JSON.stringify(data, null, 2);
  // Write-ahead validation: parse the serialized JSON before any renames
  JSON.parse(json); // throws if serialization produced invalid JSON
  await fs.writeFile(tmp, json);
  await fsync(tmp);
  if (await exists(path)) await fs.rename(path, bak);
  await fs.rename(tmp, path);
}

// Read: integrity check → backup → tmp → Dolt reconstruction
async readManifest(runId: string): Promise<RunManifest> {
  const path = `.substrate/runs/${runId}.json`;
  for (const candidate of [path, `${path}.bak`, `${path}.tmp`]) {
    try {
      return JSON.parse(await fs.readFile(candidate, 'utf-8'));
    } catch { continue; }
  }
  // All files corrupted: reconstruct minimal state from Dolt
  logger.error(`All manifest files corrupted for ${runId}, reconstructing from Dolt`);
  return this.reconstructFromDolt(runId); // returns degraded but functional state
}
```

### 3.2 Verification Check Pattern

All verification checks implement a common interface:

```typescript
interface VerificationCheck {
  name: string;
  tier: 'A' | 'B';
  run(context: VerificationContext): Promise<VerificationResult>;
}

interface VerificationResult {
  status: 'pass' | 'warn' | 'fail';
  details: string;
  duration_ms: number;
}

interface VerificationContext {
  storyKey: string;
  workingDir: string;
  commitSha: string;
  priorStoryFiles: Map<string, string[]>; // storyKey → modified files
  timeout: number; // ms
}
```

### 3.3 Event Naming Pattern

Phase D events follow the existing `namespace:action` pattern:

```
verification:check-complete    # per-check result
verification:story-complete    # all checks done for a story
learning:finding-created       # new finding classified
learning:finding-injected      # finding included in prompt
learning:finding-expired       # finding aged out
gating:conflict-detected       # dispatch blocked
gating:conflict-resolved       # auto-resolution succeeded
recovery:retry-initiated       # retry-with-context started
recovery:proposal-created      # re-scope/split proposal pending
recovery:proposal-resolved     # operator accepted/rejected
cost:warning                   # approaching ceiling
cost:ceiling-reached           # ceiling hit, action taken
mode:decision-pending          # halt-on threshold triggered
mode:decision-resolved         # operator responded
report:generated               # completion report created
```

### 3.4 Finding Classification Pattern

Root cause classification follows a deterministic rule chain, not LLM inference:

```typescript
function classifyFailure(story: StoryResult): RootCauseCategory {
  if (story.error?.includes('already exists')) return 'namespace-collision';
  if (story.error?.includes('depends on') || story.error?.includes('not found')) return 'dependency-ordering';
  if (story.outputTokens < 100) return 'resource-exhaustion'; // agent gave up
  if (story.buildFailed) return 'build-failure';
  if (story.testsFailed) return 'test-failure';
  if (story.adapterError) return 'adapter-format';
  if (story.error?.match(/heap out of memory|ENOSPC|EACCES|SIGKILL/)) return 'infrastructure';
  return 'unclassified'; // unknown root cause — injected as low-confidence with raw error
}
```

### 3.5 File Organization Pattern

New Phase D files follow existing module organization:

```
packages/sdlc/src/
  verification/
    verification-pipeline.ts
    verification-check.ts       (interface — SDLC-specific, not in core)
    checks/
      phantom-review-check.ts
      trivial-output-check.ts
      build-check.ts            (Tier A — moved up, runs before diff)
      diff-validation-check.ts  (Tier B — only after build passes)
      cross-story-check.ts
      ac-traceability-check.ts  (on-demand only)
    types.ts
  learning/
    findings-injector.ts
    dispatch-gate.ts
    finding-store.ts
    relevance-scorer.ts
    types.ts
  recovery/
    recovery-engine.ts
    types.ts
  operating-mode/
    decision-router.ts
    interactive-prompt.ts
    types.ts
  report/
    report-command.ts
    report-renderer.ts
    types.ts

src/modules/supervisor/
  stall-detector.ts           (replaces inline logic in supervisor)

packages/core/src/budget/
  cost-ceiling.ts             (extends BudgetTracker)
```

---

## 4. Project Structure & Boundaries

### 4.1 Architectural Boundaries

**Run Manifest ↔ Dolt:**
- Run manifest: operational state (scope, lifecycle, recovery, cost accumulator). Written by orchestrator and supervisor. Read by all CLI commands.
- Dolt: analytics and historical state (token metrics, decisions, findings). Written by telemetry pipeline and findings store. Read by learning loop and metrics command.
- No cross-boundary atomic operations. If Dolt is unavailable, run manifest works independently (NFR-C4).

**Verification ↔ Orchestrator:**
- Verification is invoked after each story dispatch completes, before the orchestrator moves to the next story.
- Verification reads from the working tree (git diff, build command) and writes results to the run manifest.
- Verification never modifies the working tree. It is read-only with respect to the target project.

**Learning Loop ↔ Prompt Assembly:**
- The findings injector is called during prompt assembly (existing `compile(descriptor)` pipeline). It queries the findings store, scores relevance, validates, and returns a formatted string for inclusion in the prompt.
- The injector respects the existing prompt budget (competing with architecture constraints at 12K chars). Finding injection budget: max 2,000 chars (extensible via config).

**Dispatch Gating ↔ Story Discovery:**
- Dispatch gating runs after story discovery and before dispatch. It is a filter in the orchestrator's story processing loop.
- Gating reads: story spec (target files/namespaces), run manifest (completed stories and their modified files), working tree (file existence checks).

**Recovery ↔ Operating Mode:**
- Recovery decisions emit `decision:pending` events. The `DecisionRouter` intercepts based on severity threshold.
- In autonomous mode, recovery proceeds without halting. In interactive mode, the router pauses the orchestrator's event loop and waits for stdin input.

### 4.2 Integration Points with Existing Code

| Existing Component | Phase D Integration Point | Change Type |
|---|---|---|
| `ImplementationOrchestrator.processStory()` | Insert verification pipeline call after dispatch returns | Hook insertion |
| `ImplementationOrchestrator.processStory()` | Insert dispatch gate check before `dispatcher.dispatch()` | Hook insertion |
| `prompt-assembler.ts` (compiled workflows) | Replace `getProjectFindings()` call with `FindingsInjector.inject()` | Swap callsite |
| `supervisor.ts` (`handleStallRecovery`) | Replace inline logic with `StallDetector.evaluate()` | Method replacement |
| `budget-utils.ts` (`checkPipelineBudget`) | Add cost ceiling check after existing budget checks | Extension |
| `run-command.ts` | Add `--halt-on`, `--cost-ceiling` flags, initialize run manifest | CLI extension |
| `resume-command.ts` | Read scope from run manifest instead of inferring | Read source change |
| `status-command.ts` | Read per-story state from run manifest | Read source addition |
| `health-command.ts` | Include stall detector signal summary | Output extension |

---

## 5. Architecture Validation Results

### 5.1 Requirements Coverage

**FR Coverage:**

| Capability Area | FR Count | Covered | Notes |
|---|---|---|---|
| Output Verification | 13 | 13/13 | Tier A/B split mapped to Decisions 2 + implementation pattern |
| Unified Run Model | 11 | 11/11 | Decision 1 covers all FRs including FR-R11 (locking) |
| Stall Detection | 7 | 7/7 | Decision 3 + multi-signal pattern |
| Learning — Advisory | 9 | 9/9 | Decision 4 Mechanism A |
| Learning — Gating | 4 | 4/4 | Decision 4 Mechanism B |
| Escalation Recovery | 5 | 5/5 | Decision 6 |
| Cost Governance | 7 | 7/7 | Decision 5, including FR-C3a/C3b |
| Operating Modes | 8 | 8/8 | Decision 7 + FR-O8 interactive protocol |

**NFR Coverage:**

| NFR | Addressed By |
|---|---|
| NFR-P1 (build <5s) | No new packages; all changes are within existing packages |
| NFR-P2 (verification <30s) | Decision 2: static analysis only, 60s hard timeout |
| NFR-P3 (manifest I/O <50ms) | Decision 1: single JSON file, <100KB |
| NFR-R1 (crash recovery) | Decision 1: atomic writes + backup |
| NFR-R2 (zero unscoped) | Decision 1: scope in run manifest, read on restart |
| NFR-R3 (zero phantom verdicts) | Decision 2: PhantomReviewCheck |
| NFR-R4 (target project safety) | Decision 2: verification is read-only |
| NFR-S1 (30+ stories) | Decision 1: per-story state in JSON, scales to 100+ |
| NFR-S2 (100+ findings) | Decision 4: relevance scoring + expiry prevents budget exhaustion |
| NFR-S3 (8+ hour runs) | Decision 3: multi-signal prevents false kills during long runs |
| NFR-C1 (backend compat) | Decision 3: timeout multiplier already in adapters |
| NFR-C4 (Dolt optional) | Decision 1: run manifest independent of Dolt |

### 5.2 Design Constraint Compliance

| Constraint | Compliance |
|---|---|
| DC-1: No shortcuts, no tech debt | Full planning cycle followed |
| DC-2: Language-agnostic | All Phase D capabilities operate on build output and git diffs, not language ASTs |
| DC-3: File-backed manifest, Dolt for analytics | Decision 1 explicitly separates |
| DC-4: Concurrency-ready schema | Per-story independent state, no sequential assumptions |
| DC-5: Extend, don't replace | Budget, quality gates, supervisor all extended |
| DC-6: Lightweight verification | No LLM calls in default path |
| DC-7: Run model budget 1 epic, 8 stories | Reconciliation approach (not full rewrite) fits budget |
| DC-8: 8,088+ tests, build <5s | Incremental changes, no new packages |
| DC-9: Atomic manifest writes | Pattern 3.1 |
| DC-10: Dual-signal stall detection | Decision 3 |

### 5.3 Risk Assessment

| Risk | Mitigation | Residual Risk |
|---|---|---|
| Run manifest corruption | Atomic writes + backup (DC-9) | NFS edge case (very low) |
| Two supervisors racing | Advisory flock + PID check (FR-R11) | Manual `--force` override (operator's choice) |
| Finding poisoning | Validation + expiry + confidence levels (FR-L6, L7, L8) | Novel failure patterns not in taxonomy |
| Verification timeout | 60s hard timeout + `verification-failed` status (FR-V11) | Build command that ignores SIGTERM |
| Cost overrun mid-story | Between-dispatch enforcement + estimate-before-dispatch (FR-C3a) | Single expensive story |

### 5.4 Implementation Sequence

```
Increment 1 — Verification Tier A (immediate, no run model dependency)
  ├── PhantomReviewCheck
  ├── TrivialOutputCheck
  ├── BuildCheck (process group kill on timeout)
  └── VerificationPipeline (Tier A only)

Increment 2 — Run Model (foundation)
  ├── RunManifest class (atomic I/O, locking)
  ├── CLI flag persistence (--stories, --halt-on, --cost-ceiling)
  ├── Per-story lifecycle state
  ├── Supervisor restart scope preservation
  └── Status/health/resume read from manifest

Increment 3a — Stall Detection (parallel)
  ├── StallDetector (multi-signal)
  └── Supervisor integration

Increment 3b — Cost Governance (parallel)
  ├── CostCeiling extension to BudgetTracker
  ├── Between-dispatch enforcement
  └── Budget-exhausted finalization

Increment 4 — Learning Loop + Gating
  ├── Finding type + RootCauseCategory
  ├── FindingsInjector (replaces getProjectFindings)
  ├── RelevanceScorer
  ├── DispatchGate
  └── Finding validation + expiry

Increment 5 — Recovery + Operating Mode + Report
  ├── RecoveryEngine (tiered autonomy)
  ├── DecisionRouter (--halt-on threshold)
  ├── InteractivePrompt (stdin/stdout)
  ├── substrate report command
  └── Verification Tier B (cross-story consistency, diff validation, AC traceability)
```

Estimated: 3-4 epics, 25-35 stories total. Run model increment fits within 1-epic budget.
