---
stepsCompleted: [step-01, step-02, step-03, step-04]
inputDocuments:
  - prd-phase-d-autonomous-operations.md
  - architecture-phase-d-autonomous-operations.md
  - product-brief-phase-d-autonomous-operations-distillate.md
workflowType: epics
status: draft
date: "2026-04-05"
epicCount: 4
storyCount: 34
---

# Epics and Stories: Substrate Phase D — Autonomous Operations

**Version:** 1.1
**Date:** 2026-04-05
**Status:** Draft
**Informed by:** PRD v1.1 (55+ FRs), Architecture v1.1 (8 decisions), Product Brief Distillate

---

## Overview

Phase D transforms substrate from a tool requiring human babysitting into reliable autonomous infrastructure. Four epics map to the architecture's five increments (Increments 3a/3b are combined into one epic). Total: 34 stories across 4 epics.

**Epic numbering** continues from the existing project (Epics 1-50 complete). Phase D starts at Epic 51.

**Dependency chain:** Epic 51 has no dependencies (can start immediately). Epic 52 is the foundation for Epics 53-54. Epic 53 and 54 depend on Epic 52.

---

## FR Coverage Map

| FR Range | Epic | Coverage |
|---|---|---|
| FR-V1, FR-V2, FR-V3, FR-V4, FR-V9, FR-V11 | Epic 51 (Verification Tier A) | Tier A checks (including build) |
| FR-V5, FR-V5a, FR-V6, FR-V7, FR-V8, FR-V10 | Epic 54 (Verification Tier B + Report) | Tier B checks + feedback + report |
| FR-R1 through FR-R11 | Epic 52 (Run Model) | All run model FRs |
| FR-S1 through FR-S5, FR-S3a | Epic 53 (Stall + Cost + Learning) | Stall detection |
| FR-C1 through FR-C5, FR-C3a, FR-C3b | Epic 53 (Stall + Cost + Learning) | Cost governance |
| FR-L1 through FR-L8, FR-L3a | Epic 53 (Stall + Cost + Learning) | Learning loop |
| FR-G1 through FR-G4 | Epic 53 (Stall + Cost + Learning) | Dispatch gating |
| FR-E1 through FR-E5 | Epic 54 (Recovery + Modes + Report) | Escalation recovery |
| FR-O1 through FR-O8 | Epic 54 (Recovery + Modes + Report) | Operating modes |

---

## Epic 51: Output Verification Tier A

**Goal:** The system can detect phantom reviews, trivial output, and build failures after each story dispatch — delivering immediate trust value with no run model dependency.

**Architecture Increment:** 1
**Dependency:** None (can start immediately)
**Estimated Stories:** 6

---

### Story 51-1: Verification Pipeline Framework

**As a** substrate developer,
**I want** a `VerificationPipeline` class that runs an ordered chain of `VerificationCheck` implementations after each story dispatch,
**So that** verification checks can be composed, ordered, and extended independently.

**Acceptance Criteria:**

- Given a `VerificationCheck` interface with `name`, `tier`, and `run(context): Promise<VerificationResult>` method
- When the pipeline is invoked after a story dispatch completes
- Then all registered Tier A checks execute in order, each returning `{ status: 'pass' | 'warn' | 'fail', details: string, duration_ms: number }`
- And pipeline results are aggregated into a per-story verification summary
- And the pipeline emits `verification:check-complete` and `verification:story-complete` events
- And a check that throws an unhandled exception is caught, logged, and treated as `status: 'warn'` (verification itself should not crash the pipeline)

**Technical Notes:**
- Interface and implementations in `packages/sdlc/src/verification/`
- `VerificationContext` includes: `storyKey`, `workingDir`, `commitSha`, `timeout`
- Tier B context fields (`priorStoryFiles`) are optional, populated only when run model is available

**FRs:** FR-V9 (no LLM calls in default path)

---

### Story 51-2: Phantom Review Detection

**As a** substrate operator,
**I want** the system to detect when a code review dispatch failed but was recorded as a passing verdict,
**So that** stories that were never actually reviewed are not counted as verified.

**Acceptance Criteria:**

- Given a story that went through code review
- When the review dispatch exit code was non-zero OR the review output was empty OR the review output failed schema validation
- Then the story is marked `verification-failed` with reason "phantom-review"
- And the fallback verdict logic (which currently produces `NEEDS_MINOR_FIXES` on schema failure) is removed
- And the event `verification:check-complete` includes `{ check: 'phantom-review', status: 'fail' }`

**Technical Notes:**
- Modifies the review verdict handling in `code-review.ts` compiled workflow
- Must handle both Claude Code and Codex output formats

**FRs:** FR-V1

---

### Story 51-3: Trivial Output Detection

**As a** substrate operator,
**I want** stories that produced <100 output tokens to be flagged as unverified,
**So that** I don't mistakenly treat minimal-output stories as successful completions.

**Acceptance Criteria:**

- Given a completed story dispatch
- When the story's output token count (from `token_usage_json.stories`) is below 100
- Then the story is flagged with `verification-failed` and reason "trivial-output"
- And the escalation includes suggested action: "Re-run with increased maxTurns"
- And the check passes if tokens >= 100

**Technical Notes:**
- Uses existing token tracking data
- Threshold (100) should be configurable via `SubstrateConfig`

**FRs:** FR-V2

---

### Story 51-4: Build Verification Check

**As a** substrate operator,
**I want** the target project's build to be verified after each story completes,
**So that** stories that break the build are caught immediately.

**Acceptance Criteria:**

- Given a completed story dispatch
- When the build check runs the target project's build command (detected via `detectPackageManager`)
- Then a passing build marks the check as `status: 'pass'`
- And a failing build marks the story as `verification-failed` with the build error output
- And the build command executes with a hard 60-second timeout
- And timeout uses `child_process.spawn` with `detached: true` and `process.kill(-pid, 'SIGKILL')` to kill the entire process group
- And timeout/crash results in `verification-failed` (distinct from story `failed`), does not block subsequent stories

**Technical Notes:**
- Reuse `getAllDescendants` pattern from supervisor for process group kill
- Existing `detectPackageManager` / `runBuildVerification` in `dispatcher-impl.ts` provides the starting point
- BuildCheck is Tier A — no run model dependency

**FRs:** FR-V4, FR-V11

---

### Story 51-5: Pipeline Integration into Implementation Orchestrator

**As a** substrate developer,
**I want** the verification pipeline to run automatically after each story dispatch in the implementation orchestrator,
**So that** verification is a standard part of every pipeline run without operator action.

**Acceptance Criteria:**

- Given the implementation orchestrator's `processStory()` method
- When a story dispatch returns
- Then the Tier A verification pipeline runs before the orchestrator moves to the next story
- And verification results are stored in memory (pending run manifest in Epic 52)
- And verification failures are treated as a new story state (`verification-failed`) distinct from dispatch `failed`
- And existing story phase transitions (create → dev → review → complete) continue to work unchanged
- And the pipeline is skipped when `--skip-verification` flag is passed (escape hatch for debugging)

**FRs:** FR-V9

---

### Story 51-6: Verification Events and Logging

**As a** substrate operator,
**I want** verification results emitted as NDJSON events and logged clearly,
**So that** I can monitor verification progress in real-time when running with `--events`.

**Acceptance Criteria:**

- Given a verification pipeline run
- When each check completes, a `verification:check-complete` event is emitted with check name, status, details, and duration
- And when all checks complete for a story, a `verification:story-complete` event is emitted with the aggregated result
- And the progress renderer shows verification status in the terminal output
- And events follow the existing `namespace:action` pattern

**FRs:** FR-V9

---

## Epic 52: Unified Run Model

**Goal:** The system maintains coherent, durable run state that survives crashes and preserves scope across supervisor restarts — the foundation for all subsequent Phase D capabilities.

**Architecture Increment:** 2
**Dependency:** None (can start in parallel with Epic 51)
**Estimated Stories:** 8 (budget cap per architecture decision)

---

### Story 52-1: RunManifest Class with Atomic I/O

**As a** substrate developer,
**I want** a `RunManifest` class that provides typed read/write operations with atomic file replacement,
**So that** run state survives process crashes without corruption.

**Acceptance Criteria:**

- Given a `RunManifest` stored at `.substrate/runs/{run-id}.json`
- When writing, the class serializes to JSON, validates the output is parseable, writes to `.tmp`, fsyncs, backs up current to `.bak`, and renames `.tmp` to final path
- And when reading, if primary fails JSON parse, falls back to `.bak`, then `.tmp`, then reconstructs minimal state from Dolt (degraded but functional)
- And I/O latency is <50ms for a manifest with 30 stories
- And manifest includes `generation` counter (monotonic) for corruption detection

**Technical Notes:**
- File at `.substrate/runs/{run-id}.json`
- Schema: `{ run_id, cli_flags, story_scope, supervisor_pid, supervisor_session_id, per_story_state: {}, recovery_history: [], cost_accumulation: {}, pending_proposals: [], generation, created_at, updated_at }`

**FRs:** FR-R1, FR-R6, FR-R9

---

### Story 52-2: Supervisor Locking and Ownership

**As a** substrate operator,
**I want** only one supervisor to be able to attach to a run at a time,
**So that** cross-session supervisor interference is prevented.

**Acceptance Criteria:**

- Given a run manifest with supervisor ownership fields
- When a supervisor attaches, it acquires a flock on `.substrate/runs/{run-id}.lock`
- And if flock fails (ENOSYS, EOPNOTSUPP), automatically falls back to PID-file with liveness check
- And a second supervisor attempting to attach fails with: "Run {id} is already supervised by PID {pid}. Use --force to take over."
- And `--force` flag kills the existing supervisor PID and takes ownership
- And when a supervisor detaches (clean exit), ownership is cleared

**FRs:** FR-R3, FR-R11

---

### Story 52-3: CLI Flag Persistence

**As a** substrate operator,
**I want** all CLI flags (--stories, --halt-on, --cost-ceiling, --agent, --skip-verification) persisted in the run manifest at run start,
**So that** the supervisor can read the original scope on restart.

**Acceptance Criteria:**

- Given `substrate run --events --stories 51-1,51-2 --halt-on critical --cost-ceiling 5.00`
- When the run starts, all flags are written to `run_manifest.cli_flags`
- And `substrate resume` reads flags from the manifest, not from CLI args
- And the supervisor on restart reads `cli_flags.stories` and passes them to the story resolver
- And scope is preserved 100% of the time across supervisor restarts (TS-1)

**FRs:** FR-R1, FR-R7

---

### Story 52-4: Per-Story Lifecycle State

**As a** substrate developer,
**I want** each story's lifecycle state tracked independently in the run manifest,
**So that** any consumer can determine which stories are complete, in-progress, or failed without querying multiple sources.

**Acceptance Criteria:**

- Given a run with N stories
- When each story transitions between states (pending → dispatched → in-review → complete → failed → escalated → recovered → verification-failed → gated → skipped)
- Then the transition is recorded in `per_story_state[storyKey]` with timestamp and phase
- And state updates are atomic (single manifest write per transition)
- And the schema supports per-story independent tracking (no global `current_phase` field)
- And each story state entry includes: `status`, `phase`, `started_at`, `completed_at`, `verification_result`, `cost_usd`
- And the status field uses an extensible union type with string fallback (z.union pattern from v0.19.6) to accommodate states added in later stories (`gated` from 53-9, `skipped` from 53-3)

**FRs:** FR-R2, FR-R10

---

### Story 52-5: Source Demotion and Migration

**As a** substrate developer,
**I want** existing state sources demoted to non-authoritative roles,
**So that** the run manifest is the single operational source of truth.

**Acceptance Criteria:**

- Given the existing `.substrate/current-run-id` file
- When it is written, the run manifest is also written (write-through alias)
- And `.substrate/current-run-id` is never read for state decisions (existing readers migrated to manifest)
- And `orchestrator.pid` is replaced by `supervisor_pid` in the manifest
- And supervisor in-memory `ProjectCycleState` becomes a read-through cache from manifest
- And NDJSON event stream is documented as write-only audit log
- And Dolt `pipeline_runs` is synced from manifest at run start, after each story completion, and at run end. Sync is non-blocking and fire-and-forget (errors logged at debug, not propagated)
- And when Dolt is unavailable, sync is silently skipped; manifest remains the source of truth (aligns with existing `addTokenUsage` `.catch()` pattern from v0.18.0)

**FRs:** FR-R8

---

### Story 52-6: Status/Health/Resume Read from Manifest

**As a** substrate operator,
**I want** `substrate status`, `substrate health`, and `substrate resume` to read from the run manifest,
**So that** all CLI commands report consistent state.

**Acceptance Criteria:**

- Given an active run with a manifest
- When `substrate status` is invoked, it reads per-story state from the manifest and token metrics from Dolt
- And `substrate health` reads supervisor ownership, staleness, and per-story progress from the manifest
- And `substrate resume` reads CLI flags and story scope from the manifest
- And all three commands produce consistent output (same story counts, same statuses)
- And when the manifest doesn't exist (pre-Phase-D run), commands fall back to existing behavior

**FRs:** FR-R8

---

### Story 52-7: Verification Results in Run Manifest

**Depends on:** 52-1 (RunManifest class), 51-1 + 51-5 (verification pipeline producing results)

**As a** substrate developer,
**I want** verification results from Epic 51 stored in the run manifest per story,
**So that** the completion report and other consumers can access verification data.

**Acceptance Criteria:**

- Given a story that has been verified by the Tier A pipeline
- When verification completes, results are written to `per_story_state[storyKey].verification_result`
- And each result includes: check name, status, details, duration
- And the existing in-memory storage from Epic 51 is replaced by manifest persistence
- And verification results survive process crashes

**FRs:** FR-V10 (partial — completion report in Epic 54)

---

### Story 52-8: Recovery History and Cost Accumulation

**As a** substrate developer,
**I want** recovery history and cost accumulation tracked per story in the manifest,
**So that** the escalation report and cost governance can operate on durable data.

**Acceptance Criteria:**

- Given a story that has been retried
- When a retry occurs, an entry is added to `recovery_history[]` with: story_key, attempt_number, strategy, root_cause, outcome, cost_usd
- And cumulative cost per story and per run is updated in `cost_accumulation`
- And this data survives crashes and is available for the completion report

**FRs:** FR-R4, FR-R5

---

## Epic 53: Intelligent Stall Detection + Cost Governance + Learning Loop

**Goal:** The system can detect stalls reliably, enforce cost ceilings, learn from past failures, and gate dispatches on known conflicts — the intelligence layer that makes autonomous operation safe.

**Architecture Increments:** 3a, 3b, 4
**Dependency:** Epic 52 (run model)
**Estimated Stories:** 12

---

### Story 53-1: StallDetector with Phase-Aware Thresholds

**As a** substrate operator,
**I want** the supervisor to use phase-aware staleness thresholds that are multiplied by the backend's timeout multiplier,
**So that** healthy long-running dispatches are not killed as stalls.

**Acceptance Criteria:**

- Given a stall detection configuration with phase thresholds: create-story (300s), dev-story (900s), code-review (900s), test-plan (600s)
- When the active backend is Codex (timeoutMultiplier: 3.0)
- Then the effective threshold for code-review is 2700s (900 × 3.0)
- And thresholds are stored in run manifest config (not hardcoded)
- And the `StallDetector` class replaces inline logic in `handleStallRecovery`
- And the poll interval is configurable via `SubstrateConfig` (default: 30s). When all effective thresholds exceed 600s (e.g., Codex backend), the poll interval is automatically increased to 60s to reduce overhead

**FRs:** FR-S1, FR-S2, NFR-P4

---

### Story 53-2: Multi-Signal Stall Detection

**As a** substrate developer,
**I want** stall detection to require two independent signals before declaring a stall,
**So that** false positives are eliminated.

**Acceptance Criteria:**

- Given a dispatch that has exceeded its phase-aware threshold
- When output growth is still positive (file size or token count increasing between polls)
- Then the stall is NOT declared (one signal insufficient)
- And when output growth stagnates over 2 consecutive polls AND threshold exceeded, the stall IS declared
- And when CPU sampling is unavailable (container, permission denied), output growth becomes the required second signal (with a logged warning)
- And zombie detection requires: process alive but CPU = 0 AND output stagnation over 3 consecutive polls

**FRs:** FR-S3, FR-S3a, FR-S4, FR-S5

---

### Story 53-3a: Cost Tracking and Ceiling CLI Flag

**As a** substrate developer,
**I want** cumulative cost tracked per story and per run with a `--cost-ceiling` CLI flag,
**So that** cost governance has the data foundation it needs.

**Depends on:** 52-1 (RunManifest class), 52-3 (CLI flag persistence), 52-8 (cost accumulation schema)

**Acceptance Criteria:**

- Given `--cost-ceiling 5.00` on the CLI
- When the run starts, the ceiling is persisted in `cli_flags.cost_ceiling`
- And cost per story is tracked in `cost_accumulation` (survives crashes)
- And cost includes all retry and verification overhead
- And when cumulative cost reaches 80% of ceiling, a `cost:warning` event is emitted

**FRs:** FR-C2, FR-C4, FR-C5

---

### Story 53-3b: Ceiling Enforcement and Halt-On Integration

**As a** substrate developer,
**I want** cost ceiling enforced between story dispatches with behavior varying by `--halt-on`,
**So that** the system pauses or prompts before overspending.

**Depends on:** 53-3a

**Acceptance Criteria:**

- Given a cost ceiling is set and cumulative cost is approaching it
- When the estimated next story cost would exceed remaining budget
- Then with `--halt-on all`/`critical`: pause and prompt operator with options (raise ceiling, skip story, abort)
- And enforcement operates between dispatches, not mid-story (FR-C3a)
- And a single story dispatch may exceed the remaining budget (acknowledged in FR-C3a)

**FRs:** FR-C3, FR-C3a

---

### Story 53-3c: Budget-Exhausted Finalization

**As a** substrate operator,
**I want** the system to cleanly finalize when the budget is exhausted in autonomous mode,
**So that** overnight runs don't silently overspend.

**Depends on:** 53-3b

**Acceptance Criteria:**

- Given `--halt-on none` and cost ceiling reached
- When the ceiling is hit, the system stops dispatching new stories
- And any in-progress story completes normally
- And the run finalizes with status `budget-exhausted`
- And remaining undispatched stories are reported as "skipped (budget)" in the completion report

**FRs:** FR-C3b, FR-C1

---

### Story 53-4: Per-Story Retry Budget

**As a** substrate developer,
**I want** a configurable maximum retry count per story,
**So that** the system doesn't endlessly retry non-recoverable failures.

**Acceptance Criteria:**

- Given a per-story retry budget (default: 2, configurable in `SubstrateConfig`)
- When a story fails and has retries remaining, retry-with-context proceeds
- And when retries are exhausted, the story is mandatory-escalated regardless of learning loop suggestions
- And retry count per story is tracked in run manifest `per_story_state[key].retry_count`

**FRs:** FR-C1

---

### Story 53-5: Root Cause Taxonomy and Failure Classification

**As a** substrate developer,
**I want** every story failure classified by root cause using a deterministic rule chain,
**So that** findings can be tagged, scored, and injected accurately.

**Acceptance Criteria:**

- Given a `RootCauseCategory` enum: namespace-collision, dependency-ordering, spec-staleness, adapter-format, build-failure, test-failure, resource-exhaustion, infrastructure, unclassified
- When a story fails, the `classifyFailure` function applies the rule chain (per architecture section 3.4)
- And `unclassified` findings are automatically set to `low` confidence and injected with raw error context
- And `infrastructure` catches OOM, disk full, permission errors via pattern matching
- And classified findings are persisted in Dolt `decisions` table with root cause tags

**FRs:** FR-L1, FR-L2

---

### Story 53-6: Findings Injector with Relevance Scoring

**As a** substrate developer,
**I want** classified findings injected into story prompts ranked by relevance,
**So that** the most applicable findings get prompt budget priority.

**Acceptance Criteria:**

- Given accumulated findings from prior runs and the current run
- When assembling a story's prompt, `FindingsInjector.inject()` replaces `getProjectFindings()`
- And relevance is scored: `0.5 * jaccardFileOverlap + 0.3 * packageMatch + 0.2 * rootCauseMatch`
- And findings below threshold (0.3) are excluded
- And finding saturation guard: if >10 findings score above threshold, dynamically raise threshold
- And total injection budget is configurable (default: 2,000 chars)
- And high-confidence findings are framed as directives; low-confidence as warnings

**FRs:** FR-L3, FR-L3a, FR-L7

---

### Story 53-7: Finding Validation, Deduplication, and Expiry

**As a** substrate developer,
**I want** findings validated before injection, deduplicated across runs, and expired after N runs,
**So that** the learning loop doesn't poison prompts with stale or incorrect advice.

**Acceptance Criteria:**

- Given a finding with `affected_files`
- When the injector runs, it checks if affected files still exist in the working tree
- And files that no longer exist cause the finding to be skipped or demoted to low-confidence
- And duplicate findings (same root cause + same affected files) across runs are merged, not stacked
- And findings expire after `expires_after_runs` (default: 5) and are archived
- And findings contradicted by subsequent success on the same file/namespace are retired

**FRs:** FR-L4, FR-L6, FR-L8

---

### Story 53-8: Intra-Run Finding Propagation

**As a** substrate developer,
**I want** findings from story N's failure immediately available to story N+K in the same run,
**So that** the system doesn't repeat the same mistake within a single pipeline run.

**Acceptance Criteria:**

- Given story 3 fails with a namespace-collision in the current run
- When story 5 is about to be dispatched
- Then the finding from story 3 is included in story 5's prompt injection (if relevant)
- And the finding is written to the Dolt decisions table immediately on failure (not at run end)
- And the injector queries include findings from the current run_id

**FRs:** FR-L5

---

### Story 53-9: Dispatch Pre-Condition Gating

**As a** substrate developer,
**I want** stories blocked from dispatch when known conflicts exist with completed stories,
**So that** namespace collisions and dependency ordering issues are prevented rather than diagnosed after the fact.

**Acceptance Criteria:**

- Given story 6 that will create class `TelemetryAdvisor`
- When story 4 has already completed and modified a file containing `TelemetryAdvisor`
- Then story 6's dispatch is blocked with reason: "namespace-collision: TelemetryAdvisor exists in {file} from story 4"
- And file overlap alone is a `warn`, not a `block`. The gate blocks only when the overlapping file contains a conflicting export/namespace (detected via text search for `class`, `export`, `interface` followed by the same identifier)
- And auto-resolution prompt rewrite is only attempted for `namespace-collision` conflicts (rewrite: "extend existing class instead of creating new")
- And for other conflict types (e.g., both stories modifying the same function body), the story is held as `gated` for operator review
- And if auto-resolution succeeds, the story proceeds with modified context
- And if auto-resolution fails, the story is held as `gated` and escalated
- And conflict detection uses `git diff --name-only --no-renames` from completed stories (observed state, not predicted intent)

**FRs:** FR-G1, FR-G2, FR-G3, FR-G4

---

### Story 53-10: Adapter Hardening (Cross-Cutting)

**As a** substrate developer,
**I want** existing adapters hardened against format variance without requiring code changes,
**So that** a 5-story Codex run completes without manual substrate fixes.

**Acceptance Criteria:**

- Given a Codex dispatch that produces output in an unexpected format variation
- When the output fails initial parsing, a format normalization layer attempts canonical extraction
- And structured error reporting provides enough context for diagnosis without reading raw logs
- And the existing Claude Code adapter and Codex adapter both pass a 5-story integration test without substrate code changes
- And adapter errors are classified as `adapter-format` in the root cause taxonomy

**FRs:** NFR-C1

---

### Story 53-11: File-Scope Guardrail in Code Review

**Priority**: must

**Description**: Add a file-scope check to the code review step that flags when the dev agent modifies or creates files not listed in the story spec's "Key File Paths" section. This prevents agents from over-implementing — pulling in work from future stories. The guardrail should surface as a review finding (not a hard block), since legitimate edge cases exist where the agent needs to touch an unlisted file.

**Acceptance Criteria**:
- Code review prompt includes instructions to check modified files against the story spec's "Key File Paths" and "Tasks / Subtasks" sections
- If the agent created files not mentioned in the story spec, the review notes this as a finding with category "scope-creep"
- If the agent modified files not mentioned in the story spec (excluding test files), the review notes this as a finding
- The scope check is advisory — it does not change the review verdict from SHIP_IT to NEEDS_FIXES on its own
- Test files created by the agent are exempt from scope checking (agents are expected to create tests not explicitly listed)

**FRs:** MO-1 (completion quality)

---

### Story 53-12: RunManifest Directory Bootstrap

**Priority**: must

**Description**: Ensure the `.substrate/runs/` directory exists before any manifest write attempt. Currently, `RunManifest.write()` fails with ENOENT if the directory doesn't exist, silently losing run state. The fix should create the directory on first write using `mkdirSync` with `recursive: true`.

**Acceptance Criteria**:
- `RunManifest.write()` creates the `.substrate/runs/` directory if it does not exist, before writing the temp file
- `RunManifest.write()` does not throw ENOENT when called on a fresh project where `.substrate/runs/` has never been created
- Existing behavior is unchanged when the directory already exists
- Unit test verifies write succeeds to a temp directory that does not pre-exist

**FRs:** FR-R4 (crash recovery)

---

### Story 53-13: Review Cycle Counter Accuracy

**Priority**: should

**Description**: Fix the review cycle counter discrepancy where `story:done` reports `review_cycles: 0` but `story:metrics` reports `reviewCycles: 1` for stories that receive a single-pass SHIP_IT verdict. The counter should consistently reflect the actual number of code review dispatches that occurred.

**Acceptance Criteria**:
- A story that receives SHIP_IT on the first code review reports `review_cycles: 1` in both `story:done` and `story:metrics` events
- A story that receives NEEDS_MINOR_FIXES on the first review and SHIP_IT on the second reports `review_cycles: 2` in both events
- A story that is auto-approved (max review cycles exhausted with only minor issues) reports the actual number of review dispatches
- Unit test verifies counter values for 1-cycle and 2-cycle scenarios

**FRs:** MO-3 (telemetry accuracy)

---

## Epic 54: Recovery Engine + Operating Modes + Completion Report

**Goal:** The system can recover from failures autonomously, operate at configurable halt severity levels, and produce a structured completion report for morning review — the capstone that enables overnight runs.

---

### Story 53-14: Dolt Adapter Transaction Safety

**Priority**: must

**Description**: The DoltDatabaseAdapter's `transaction()` method is fundamentally broken in both operating modes. In pool mode, BEGIN and subsequent queries may hit different connections from the mysql2 pool — the transaction boundary is meaningless. In CLI mode, each `dolt sql -q` invocation is a separate Dolt session — BEGIN/COMMIT across separate invocations have no effect. This causes intermittent data loss on all transactional writes (story_metrics, run_metrics, decisions).

Root cause found by analyzing missing `story_metrics` rows via agent-mesh telemetry: the mesh reporter read the row within the same process (same connection), but after process exit the data was not persisted to Dolt's committed state.

**Acceptance Criteria**:

AC1: Pool mode transactions use a dedicated connection
- `transaction()` acquires a single connection from the pool via `getConnection()`
- BEGIN, all queries within the transaction function, and COMMIT/ROLLBACK execute on that same connection
- The connection is released back to the pool in a `finally` block regardless of success or failure
- Unit test: two concurrent transactions on the same adapter do not interleave their queries

AC2: CLI mode transactions use a single multi-statement invocation
- When in CLI mode, `transaction()` collects all SQL statements issued within `fn()` and executes them as a single `dolt sql -q "BEGIN; stmt1; stmt2; COMMIT"` invocation
- Alternatively: CLI mode wraps the statements in a single session using `dolt sql` with stdin piping
- If the combined statement fails, none of the individual statements persist (atomic)
- Unit test: a transaction that inserts two rows in CLI mode either persists both or neither

AC3: Data survives process exit
- After `adapter.close()` is called, all committed transaction data is readable by a subsequent `dolt sql -q` CLI invocation from a new process
- Integration test: write via adapter transaction, close adapter, verify via fresh CLI query

AC4: Backward compatible
- Existing code that calls `adapter.transaction()` does not need changes
- The `DatabaseAdapter` interface does not change
- Non-Dolt adapters (InMemoryAdapter) continue to work as before

**Key Files**:
- `packages/core/src/persistence/dolt-adapter.ts` — `transaction()` method
- `packages/core/src/persistence/dolt-client.ts` — `DoltClient.query()`, pool vs CLI mode
- `packages/core/src/persistence/dolt-adapter.test.ts` or new test file

**FRs:** FR-R4 (crash recovery), NFR-C1 (adapter reliability)

---

**Architecture Increment:** 5
**Dependency:** Epics 52 and 53
**Estimated Stories:** 8

---

### Story 54-1: Recovery Engine with Tiered Autonomy

**As a** substrate operator,
**I want** failed stories to be automatically retried with diagnostic context, and non-recoverable failures proposed for re-scope with my approval,
**So that** the system maximizes autonomous completion while respecting product decisions.

**Acceptance Criteria:**

- Given a failed story with root cause classification
- When retry budget is not exhausted AND root cause is prompt-addressable
- Then retry-with-context proceeds autonomously: diagnosis + relevant findings injected into retry prompt
- And when retry budget is exhausted OR root cause is non-recoverable, a proposal is written to `pending_proposals[]`
- And when `pending_proposals.length >= 2`, only dependent stories are paused (check work graph dependency edges); independent stories continue
- And when work graph dependency data is unavailable (linear engine mode), treat all remaining stories as potentially dependent and pause all dispatching at 2+ pending proposals
- And when `pending_proposals.length >= 5`, the entire run pauses regardless of dependency data
- And each proposal includes: root cause, attempts, suggested action, blast radius (affected downstream stories)

**FRs:** FR-E1, FR-E2, FR-E3, FR-E4, FR-E5

---

### Story 54-2: Decision Router and --halt-on Flag

**As a** substrate operator,
**I want** to configure how much autonomy the system has via `--halt-on <all|critical|none>`,
**So that** I can gradually build trust from attended to fully autonomous runs.

**Acceptance Criteria:**

- Given `--halt-on critical` (default)
- When a recovery retry occurs (severity: info), it proceeds without halting
- And when a cost ceiling is hit (severity: critical), the system halts and prompts
- And when a build verification fails (severity: critical), the system halts
- And with `--halt-on all`, every recovery decision halts for operator input
- And with `--halt-on none`, all autonomous actions proceed; non-recoverable failures are escalated to the report
- And severity assignments: retry-with-context → info, cost ceiling → critical, build failure → critical, scope violation → fatal, re-scope proposal → warning

**FRs:** FR-O1, FR-O2, FR-O3, FR-O4

---

### Story 54-3: Interactive Prompt and Notification Signal

**As a** substrate operator,
**I want** the system to present recovery decisions as numbered choices when halted, and emit a notification signal in tethered mode,
**So that** I can respond to decisions in real-time or be alerted when attention is needed.

**Acceptance Criteria:**

- Given a decision point that triggers a halt (based on --halt-on threshold)
- When in interactive mode (default), numbered choices are presented on stdout with context
- And operator input is accepted via stdin; the system resumes from the exact decision point
- And `--non-interactive` flag applies default actions for all severities (no stdin required)
- And each notification creates a new file: `.substrate/notifications/{run-id}-{timestamp}.json` (one per decision point)
- And notification files are cleaned up by `substrate report` after the run is reviewed
- And external monitors may delete notification files after processing; the system does not re-read them

**FRs:** FR-O5, FR-O6, FR-O8

---

### Story 54-4: Verification Tier B — Cross-Story Consistency and Diff Validation

**As a** substrate developer,
**I want** cross-story conflict detection and diff validation to run when the run model is available,
**So that** stories that conflict with each other or produce broken code are caught.

**Acceptance Criteria:**

- Given completed stories with `git diff --name-only --no-renames` file sets stored in the run manifest
- When two stories modify the same file, the CrossStoryConsistencyCheck runs
- And it detects conflicting type definitions and duplicate namespace creation
- And DiffValidationCheck runs `git diff --numstat <baseline>..<story>` filtering binary files
- And diff validation only runs if BuildCheck passed (broken code diffs are misleading)
- And contract mismatches between story outputs are detected and reported

**FRs:** FR-V5, FR-V5a, FR-V6, FR-V3 (Tier B portion)

---

### Story 54-5: Structured Completion Report

**As a** substrate operator,
**I want** a `substrate report` command that shows verified results of a completed run,
**So that** I can review overnight runs in minutes, not hours.

**Acceptance Criteria:**

- Given a completed run with a manifest
- When `substrate report [--run <id>] [--format human|json]` is invoked
- Then human format shows: story count summary, verified/recovered/escalated breakdown, cost vs ceiling, and per-story table with build/diff/quality columns
- And escalated stories include: root cause, recovery attempts, suggested operator action, blast radius
- And JSON format provides machine-readable output for CI/CD integration
- And `substrate report --run latest` shows the most recent run
- And target: escalated story resolvable in <15 minutes from report alone

**FRs:** FR-V10, FR-O7

---

### Story 54-6: Headless Invocation Support

**As a** CI/CD system,
**I want** substrate to support machine-readable exit codes and non-interactive operation,
**So that** pipeline runs can be triggered from automated systems.

**Acceptance Criteria:**

- Given `substrate run --non-interactive --halt-on none --events`
- When the run completes, exit code is: 0 (all passed), 1 (some escalated), 2 (run failed)
- And `--non-interactive` suppresses all stdin prompts; default actions are applied
- And structured JSON output is available via `--output-format json`
- And the exit code + JSON output provides enough information for a CI/CD pipeline to determine next steps

**FRs:** FR-O6

---

### Story 54-7: AC-to-Test Traceability Check (On-Demand)

**As a** substrate operator,
**I want** to optionally verify that each acceptance criterion has corresponding test coverage,
**So that** I can have higher confidence in story completeness for critical stories.

**Acceptance Criteria:**

- Given a completed story with acceptance criteria in its spec and test files in its diff
- When the AC traceability check is invoked (on-demand via `--verify-ac` flag or `substrate report --verify-ac`)
- Then heuristic matching between AC text and test names/descriptions produces a coverage matrix
- And the matching is approximate (acknowledged in output) — not exact semantic analysis
- And this check may use an LLM call (not part of default verification path)
- And results are included in the completion report under a "traceability" column

**FRs:** FR-V7

---

### Story 54-8: Verification-to-Learning Feedback Loop

**As a** substrate developer,
**I want** verification findings (phantom reviews, trivial output, build failures) fed back into the learning store as first-class findings,
**So that** the learning loop can learn from verification patterns and self-calibrate quality thresholds.

**Acceptance Criteria:**

- Given a verification result of `fail` or `warn` for any check
- When the verification pipeline completes for a story
- Then a `Finding` object is created with: root cause derived from the check type (phantom-review → `build-failure`, trivial-output → `resource-exhaustion`, build-fail → `build-failure`), affected files from the story's diff, and confidence `high` (verified by static analysis)
- And these findings are stored in the Dolt decisions table (same as learning loop findings)
- And the learning loop's `FindingsInjector` can consume verification-generated findings for future stories
- And this creates the closed feedback circuit: verification → learning → better dispatch → better verification

**FRs:** FR-V8

---

## Dependency Graph

```
Epic 51 (Verification Tier A)     Epic 52 (Run Model)
  │ no dependencies                 │ no dependencies
  │                                 │
  │    ┌────────────────────────────┘
  │    │
  │    ▼
  │  Epic 53 (Stall + Cost + Learning)
  │    │
  │    │
  ▼    ▼
  Epic 54 (Recovery + Modes + Report)
    │ depends on: Epics 51 (Tier B verification), 52 (run model), 53 (learning + cost)
```

Epic 51 and 52 can run in parallel (independent). Epic 53 requires 52. Epic 54 requires 51, 52, and 53.

---

## Baseline Validation Run (Prerequisite)

**Status: COMPLETE** (2026-04-05)

Ran against boardgame-sandbox Epic 5 (7 stories) on v0.19.27 with zero human intervention.

| Metric | Value |
|---|---|
| Run ID | b39ff8b9-d88e-4e80-988f-447d7b0e6ed6 |
| Stories | 7 attempted, 6 succeeded, 1 failed (5-7: create-story timeout) |
| Autonomous completion rate | 85.7% (6/7) |
| Human interventions | 0 |
| Total cost | $2.05 |
| Wall clock | 150 minutes |
| Total review cycles | 9 |
| Failure root cause | resource-exhaustion (create-story agent produced 0 output tokens, 600s timeout) |

### Hard Baseline: Substrate Epic 51 (2026-04-05)

Ran substrate Epic 51 (6 stories) against its own codebase on v0.19.27, zero human intervention.

| Metric | Value |
|---|---|
| Stories | 6 attempted, 4 succeeded, 2 escalated |
| Autonomous completion rate | 66.7% (4/6) |
| Human interventions | 0 |
| Total cost | $1.72 |
| Wall clock | 92 minutes (3-way concurrency) |
| Total review cycles | 4 |

**Escalation analysis:**
- **51-1** (Verification Pipeline Framework): Dev completed, build passed, code review found NEEDS_MINOR_FIXES, **fix dispatch timed out**. Also: Dolt stdout maxBuffer exceeded during decision retrieval. Root cause: fix-timeout + Dolt buffer overflow.
- **51-2** (Phantom Review Detection): Dev completed but **build verification failed** — TypedEventBus type error in orchestrator-impl.ts. Build-fix agent cascaded the failure. Root cause: build-failure (type system error in complex generics).

**Dual-baseline targets:**
- MO-1 (80% completion): Easy project 85.7%, hard project 66.7%. **Raise target to 90%+ on easy, 80%+ on hard.**
- MO-2 (50% recovery): 0% across both runs (3 failures, 0 recoveries). Phase D retry-with-context should recover fix-timeout and build-fix cascade.
- MO-3 (75% repeat reduction): Requires second run on same project to measure.

---

## Summary

| Epic | Stories | Increment | Depends On | Key Deliverable |
|---|---|---|---|---|
| 51 | 6 | 1 | None | Phantom review detection, build verification, trivial output flagging |
| 52 | 8 | 2 | None | Durable run manifest, scope preservation, crash recovery |
| 53 | 12 | 3a+3b+4 | 52 | Stall detection, cost ceiling (3 stories), learning loop, dispatch gating, adapter hardening |
| 54 | 8 | 5 | 51+52+53 | Recovery engine, operating modes, completion report, headless, AC traceability, verification→learning feedback |
| **Total** | **34** | | | |
