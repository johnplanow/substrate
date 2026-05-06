# Epic 73: Recovery Engine + Interactive Prompt — Autonomy Capstone

## Vision

Stream A+B sprint plan capstone: ship the Recovery Engine with Tiered
Autonomy (Phase D Story 54-1) and Interactive Prompt with Notification
Signal (Phase D Story 54-3). Together these complete the autonomy
gradient: Decision Router (Epic 72) classifies and routes halt
decisions, and Recovery Engine (Epic 73) acts on them — auto-retrying
recoverable failures, proposing re-scope for non-recoverable, and
prompting the operator with numbered choices when halts fire.

This is the **autonomous-overnight enabler**. After Epic 73 ships:
- `substrate run --halt-on none --non-interactive` runs fully
  autonomously through verification failures, with auto-retry on
  prompt-addressable root causes
- Non-recoverable failures land in `pending_proposals[]` for operator
  review via `substrate report` (Epic 71)
- Pending-proposal back-pressure pauses dispatching when ≥2 proposals
  accumulate (with work-graph-aware dependency pause; linear engine
  mode pauses ALL dispatching)
- ≥5 pending proposals halts the entire run regardless of dependency
  data (run-level safety valve)

Combined with Epic 70 (cross-story-race auto-recovery) and Epic 71
(`substrate report` for review), this enables overnight runs with
confidence: substrate either succeeds, recovers, or escalates with
sufficient context for the operator to decide quickly the next morning.

## Root cause it addresses

Today, when a verification fails after max-review-cycles:
1. Story is marked `failed` (or `escalated`) — no further action
2. Operator must investigate manually via `substrate metrics`,
   rendered story files, and dispatch logs
3. Operator must decide: retry with new context, re-scope the story,
   or accept the failure
4. There's no autonomous retry path for prompt-addressable failures
   (e.g., "test threshold off by 1", "missing import", "wrong file
   path")
5. Operators must run substrate attended even when 80% of failures
   are auto-recoverable

Epic 73 closes this gap with a tiered approach:
- **Tier A (auto-recover)**: prompt-addressable root causes
  (build-failure, test-coverage, missing-evidence) get auto-retried
  with diagnosis + findings injected into the retry prompt
- **Tier B (re-scope proposal)**: non-recoverable root causes
  (scope-violation, fundamental-design-error) land in
  `pending_proposals[]` for operator review
- **Tier C (halt for prompt)**: when `--halt-on` policy demands
  operator input, Interactive Prompt presents numbered choices and
  collects stdin response

## Why now

Three signals:

1. **Stream A+B capstone**: Recovery Engine is the final piece for
   autonomous-overnight operation. All prerequisites (Epic 71 report,
   Epic 72 Decision Router, Epic 70 race recovery) are now shipped.

2. **Empirical data on retry success rates exists**: today's 8 ships
   (v0.20.55-64) included multiple Path A reconciliations of
   verification-failed dispatches whose code was actually correct.
   Recovery Engine's auto-retry could have eliminated the manual step
   in ~70% of those cases.

3. **Notification primitive enables monitoring integration**: external
   monitors (Slack bots, dashboards) can watch
   `.substrate/notifications/` to alert operators when human input is
   needed. This unblocks tooling around supervised-mode runs.

## Story Map

- 73-1: Recovery Engine with Tiered Autonomy (Tier A auto-retry + Tier B re-scope proposals + back-pressure) (P0, Medium)
- 73-2: Interactive Prompt + Notification Signal (P0, Small)

Two focused stories. 73-1 implements the recovery decision logic and
back-pressure; 73-2 implements the operator-facing prompt + filesystem
notification.

## Story 73-1: Recovery Engine with Tiered Autonomy

**Priority**: must

**Description**: Implement the Recovery Engine that consumes Decision
Router's halt decisions (Epic 72) and applies tiered recovery actions
based on root-cause classification and retry budget.

The Recovery Engine fires when:
- A verification check fails after max-review-cycles
- A dev-story dispatch hits a checkpoint-retry-timeout
- An orchestrator-level decision requires recovery action

It classifies the failure root cause (consuming
`learning/failure-classifier.ts` from Story 53-5) and routes:

**Tier A — Auto-retry-with-context** (prompt-addressable root causes):
- `build-failure`: re-dispatch dev-story with build error output
  injected into prompt
- `test-coverage-gap`: re-dispatch with failing test output
- `ac-missing-evidence`: re-dispatch with explicit AC reminder
- `missing-import`: re-dispatch with missing-symbol context
- Retry budget tracked per-story (Story 53-9 budget enforcement)
- On retry exhaustion: escalate to Tier B

**Tier B — Re-scope proposal** (non-recoverable root causes):
- `scope-violation`: write proposal to `pending_proposals[]` in
  RunManifest (canonical helper)
- `fundamental-design-error`: same
- `cross-story-contract-mismatch`: same
- Each proposal includes: root cause, attempts, suggested action,
  blast radius (downstream stories from work graph)

**Tier C — Halt for prompt** (decision policy demands operator input):
- Returns control to Decision Router (Epic 72) which yields to the
  Interactive Prompt (Story 73-2)

**Back-pressure logic**:
- When `pending_proposals.length >= 2`:
  - Query work graph for dependency edges
  - Pause dispatching of stories that depend on stories with proposals
  - Continue dispatching independent stories
  - In `--engine=linear` mode (no work graph): pause ALL dispatching
- When `pending_proposals.length >= 5`: halt entire run regardless of
  dependency data (safety valve)

**Acceptance Criteria:**

1. New module `src/modules/recovery-engine/index.ts` exporting
   `runRecoveryEngine(input)` (action handler matching existing
   verification check shape — consult
   `packages/sdlc/src/verification/cross-story-race-recovery.ts` from
   Epic 70 for the contract). Pure logic in
   `classifyRecoveryAction(failure, budget) -> 'retry' | 'propose' |
   'halt'`.

2. **Tier A auto-retry-with-context**: when `classifyRecoveryAction`
   returns `retry`, invoke existing dev-story dispatcher with
   diagnosis + findings prepended to the retry prompt. Reuse
   `runVerificationPipeline` (existing helper); do NOT duplicate
   verification logic.

3. **Tier B re-scope proposal**: when `classifyRecoveryAction` returns
   `propose`, append a `Proposal` object to
   `RunManifest.pending_proposals` via the canonical helper:
   ```typescript
   import { RunManifest } from '@substrate-ai/sdlc/run-model/run-manifest.js'
   const manifest = new RunManifest(runId, runsDir)
   await manifest.appendProposal(proposal)
   ```
   **Do NOT introduce a new manifest format.** Use the existing
   `pending_proposals` field per Story 52-1 schema.

4. **Proposal shape**: `{ storyKey, rootCause, attempts, suggestedAction,
   blastRadius: string[] }` matching `ProposalSchema` from
   `packages/sdlc/src/run-model/schemas.ts`. If schema does not have
   this shape, extend it (separate AC below).

5. **`ProposalSchema` extension** (if needed): add `rootCause`,
   `attempts`, `suggestedAction`, `blastRadius` fields to
   ProposalSchema in
   `packages/sdlc/src/run-model/schemas.ts`. Use Zod's
   `.optional()` for backward-compat with pre-Epic-73 manifests.

6. **Back-pressure logic**:
   - When `pending_proposals.length >= 2`: read work graph from
     existing graph engine (consult `packages/factory/src/graph/` for
     the helper if present; if absent, fall back to wg_stories
     dependency edges via Dolt query); pause dispatches whose stories
     depend on a proposed story; continue independent dispatches
   - In linear engine mode (work graph unavailable): pause ALL
     dispatching at `>= 2`
   - When `pending_proposals.length >= 5`: halt run regardless of
     dependency data (emit `pipeline:halted-pending-proposals` event,
     exit 1 from orchestrator main loop)

7. **CRITICAL: use canonical helpers** (per Story 69-2 / 71-2 / 72-x
   lesson — 4 prior incidents from invented manifest formats):
   - Read run state via `RunManifest` class from
     `@substrate-ai/sdlc/run-model/run-manifest.js`
   - Run-id resolution via `manifest-read.ts` helpers
     (`resolveRunManifest`, `readCurrentRunId`)
   - Latest-run fallback via `getLatestRun(adapter)` from
     `packages/core/src/persistence/queries/decisions.ts`
   - Persistence via existing `DoltClient` from
     `src/modules/state/index.ts`
   - **Do NOT introduce new aggregate manifest formats.**

8. New event types declared + mirrored CoreEvents +
   OrchestratorEvents per Story 66-4 typecheck:gate discipline:
   - `recovery:tier-a-retry` — `{ runId, storyKey, rootCause,
     attempt, retryBudgetRemaining }`
   - `recovery:tier-b-proposal` — `{ runId, storyKey, rootCause,
     attempts, suggestedAction, blastRadius }`
   - `recovery:tier-c-halt` — `{ runId, storyKey, rootCause }`
   - `pipeline:halted-pending-proposals` — `{ runId,
     pendingProposalsCount }`

9. Orchestrator integration: after every verification failure or
   dev-story timeout in
   `src/modules/implementation-orchestrator/orchestrator-impl.ts`,
   invoke `runRecoveryEngine(...)` instead of marking the story
   directly `failed`. The Recovery Engine returns the next action.

10. **Idempotency**: re-running recovery on a story that's already
    in `pending_proposals` is a no-op (do not duplicate). Detection
    via `proposal.storyKey === currentStory.storyKey`.

11. **Tests** at `src/modules/recovery-engine/__tests__/index.test.ts`
    (≥7 cases): (a) Tier A — build-failure → retry with diagnosis
    injected; (b) Tier A — retry budget exhausted → escalate to Tier
    B; (c) Tier B — scope-violation → proposal appended; (d) Tier C
    — halt-policy demands prompt → returns halt; (e) back-pressure —
    work graph available, ≥2 proposals → independent stories continue;
    (f) back-pressure — linear mode, ≥2 proposals → all paused;
    (g) safety valve — ≥5 proposals → run halted regardless.

12. **Integration test** at
    `__tests__/integration/recovery-engine.test.ts` (≥1 case): real
    fixture run manifest with 1 proposed story and 2 ready stories;
    invoke recovery engine; assert independent story dispatches
    continue, dependent story is paused.

13. **Header comment** in implementation file cites Phase D Story
    54-1 (original 2026-04-05 spec) + Epic 70 (cross-story-race
    recovery, similar tier-A pattern) + Epic 72 (Decision Router
    that Recovery Engine consumes) + that Story 73-2 implements the
    Tier C prompt.

14. **No package additions**.

**Files involved:**
- `src/modules/recovery-engine/index.ts` (NEW)
- `src/modules/recovery-engine/__tests__/index.test.ts` (NEW)
- `__tests__/integration/recovery-engine.test.ts` (NEW)
- `packages/sdlc/src/run-model/schemas.ts` (extend ProposalSchema)
- `packages/sdlc/src/run-model/run-manifest.js` (add `appendProposal` method if absent)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (invoke Recovery Engine on verification failure)
- `packages/core/src/events/core-events.ts` (4 new event types)
- `src/core/event-bus.types.ts` (mirror events)

## Story 73-2: Interactive Prompt + Notification Signal

**Priority**: must

**Description**: Implement operator-facing UX for halt decisions:
numbered choices presented on stdout with context, stdin input
collection, and filesystem notification for external monitors.

When Decision Router (Epic 72) returns `halt: true` and substrate is
NOT in `--non-interactive` mode, the Interactive Prompt fires:
- Print decision context (severity, type, what triggered, what would
  happen autonomously)
- Print numbered choices: 1) accept default action, 2) custom retry
  with new context, 3) re-scope, 4) abort run
- Read operator input from stdin
- Resume orchestrator execution from the exact decision point

In parallel, write a notification file at
`.substrate/notifications/{run-id}-{timestamp}.json` containing the
decision context. External monitors (Slack bots, dashboards) can
watch this directory to alert operators.

After the run completes, `substrate report` (Epic 71) reads
notifications dir and includes them in the run summary, then deletes
processed notifications.

**Acceptance Criteria:**

1. New module `src/modules/interactive-prompt/index.ts` exporting
   `runInteractivePrompt(decisionContext)` returning the operator's
   chosen action (or default in `--non-interactive` mode).

2. **Numbered choice presentation**: prompt format:
   ```
   ─────────────────────────────────────────────────
   ⚠ Halt: <decision-type> (<severity>)
   ─────────────────────────────────────────────────
   <decision-context-summary>

   1) Accept default: <default-action>
   2) Retry with custom context
   3) Propose re-scope
   4) Abort run

   Choice [1]:
   ```
   Default `1` if operator presses Enter.

3. **Stdin input collection**: use `readline.createInterface` (Node
   stdlib, already used elsewhere — consult
   `src/cli/commands/reconcile-from-disk.ts` from Epic 69 for
   pattern). Read one line; trim; parse as 1-4 integer; default to 1
   on parse failure.

4. **`--non-interactive` mode bypass**: when
   `process.env.SUBSTRATE_NON_INTERACTIVE === 'true'` (set by Epic
   72's `--non-interactive` flag) OR `decisionContext.nonInteractive
   === true`, return default action without printing or reading
   stdin. Emit `decision:halt-skipped-non-interactive` event (Epic 72
   event type) for operator audit trail.

5. **Notification file**: write
   `.substrate/notifications/<runId>-<isoTimestamp>.json` with shape:
   ```json
   {
     "runId": "...",
     "timestamp": "2026-05-06T...",
     "decisionType": "...",
     "severity": "critical",
     "context": {...},
     "choices": [...],
     "operatorChoice": null
   }
   ```
   File written BEFORE prompting so external monitors can detect halt
   immediately. Update `operatorChoice` field after operator responds
   (or leave null if non-interactive).

6. **Cleanup contract**: `substrate report` (Epic 71) reads
   `.substrate/notifications/<run-id>-*.json` files for the run being
   reported, includes them in the report output, then deletes them.
   This is implemented in Story 73-2 by extending Epic 71's report
   command (small modification at `src/cli/commands/report.ts`).

7. **External-monitor delete tolerance**: substrate does NOT
   re-read notification files after writing. If an external monitor
   deletes the file (after processing), substrate continues normally.
   No retry / re-read logic.

8. **Use canonical helpers** (per Story 69-2 / 71-2 / 72-x lesson):
   - Run-id resolution via `manifest-read.ts` helpers
     (`resolveRunManifest`, `readCurrentRunId`)
   - Persistence via existing `DoltClient` if needed for state writes
   - **Do NOT introduce new aggregate manifest formats.**

9. **Tests** at
   `src/modules/interactive-prompt/__tests__/index.test.ts` (≥5
   cases): (a) presents numbered choices on stdout; (b) reads stdin
   and returns operator's choice; (c) `--non-interactive` returns
   default without stdin read; (d) writes notification file with
   correct shape; (e) handles malformed stdin input → defaults to 1.

10. **Integration test** at
    `__tests__/integration/interactive-prompt.test.ts` (≥1 case):
    spawn substrate run with halt-able decision; close stdin; assert
    notification file written; assert default action applied; assert
    notification file deleted by `substrate report` after the run.

11. **Header comment** cites Phase D Story 54-3 (original spec) +
    Epic 72 (Decision Router that triggers prompts) + Story 73-1
    (Recovery Engine that the prompt collects responses for).

12. **`substrate report` extension**: add notification reading + cleanup
    to `src/cli/commands/report.ts` (Epic 71). Notifications appear
    in human format under "Operator Halts" section; in JSON format
    as top-level `halts` array.

13. **No package additions**.

**Files involved:**
- `src/modules/interactive-prompt/index.ts` (NEW)
- `src/modules/interactive-prompt/__tests__/index.test.ts` (NEW)
- `__tests__/integration/interactive-prompt.test.ts` (NEW)
- `src/cli/commands/report.ts` (extend with notification read + cleanup)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (invoke Interactive Prompt when Decision Router halts)

## Risks and assumptions

**Assumption 1 (failure-classifier.ts is reliable)**: Story 53-5's
classifier maps verification failures to root-cause categories.
Recovery Engine's tier classification depends on this. Mitigation:
unit tests mock the classifier; integration test asserts known
root-cause categories produce correct tier routing.

**Assumption 2 (work graph is queryable)**: in `--engine=graph` mode,
work graph dependency edges are accessible. In `--engine=linear`
mode, fall back to "all stories may depend on each other" (pause all
on `>= 2` proposals). Mitigation: explicit linear-mode test case in
AC11(f).

**Risk: auto-retry creates infinite loop on persistent failure.**
Recovery Engine retries within budget, but if every retry produces
the same failure, loop hits budget exhaustion → Tier B proposal.
Mitigation: strict budget enforcement; dedup detection (consecutive
retries with identical findings → escalate immediately).

**Risk: notification files accumulate.** If external monitors don't
clean up, the directory grows unbounded. Mitigation: substrate report
deletes notifications it reads; document cleanup expectation in help
text and Epic 71's report README.

**Risk: stdin read blocks orchestrator on accidental tethered run
through CI.** If substrate runs in CI without `--non-interactive`,
the prompt blocks waiting for stdin that never arrives. Mitigation:
add startup check: if `process.stdin.isTTY === false` AND
`--non-interactive` not set, log warning and treat as
non-interactive automatically (defensive default).

**Self-applying validation**: Epic 73 itself dispatches under Epic
72's Decision Router and Epic 70's race recovery. After 73 ships, it
becomes the recovery layer for its own future failures.

## Dependencies

- **Phase D Story 54-1** (2026-04-05) — Recovery Engine spec.
- **Phase D Story 54-3** (2026-04-05) — Interactive Prompt spec.
- **Story 53-5** (v0.19.31) — Root cause taxonomy + failure
  classifier; Recovery Engine reads classifications.
- **Story 53-9** (v0.19.32) — Per-story retry budget; Recovery
  Engine enforces.
- **Epic 70** (v0.20.63) — cross-story-race recovery; pattern for
  tier-A auto-retry.
- **Epic 71** (v0.20.62) — `substrate report`; Story 73-2 extends to
  surface notifications.
- **Epic 72** (v0.20.64) — Decision Router; Recovery Engine consumes
  routed halt decisions.

## Out of scope

- **Custom retry context input via prompt** (choice 2 in Story 73-2):
  Story 73-2 collects the choice but full custom-context UX is
  deferred to potential Epic 75. For 73-2, choice 2 returns "retry"
  with last-known diagnosis injected (same as Tier A default).
- **Cross-run learning from proposals**: Story 53-X learning store
  could ingest accepted/rejected proposals to refine future
  classifications. Out of scope; Epic 74 (Verification-to-Learning
  Feedback) is the bridge.
- **Multi-operator concurrent prompt handling**: stdin is single-
  reader; multi-operator scenarios out of scope.

## References

- Phase D Plan 2026-04-05 — Stories 54-1 + 54-3 original specs
- Epic 70 (v0.20.63) — cross-story-race recovery; similar Tier A
  pattern
- Epic 71 (v0.20.62) — `substrate report`; Story 73-2 extends for
  notifications
- Epic 72 (v0.20.64) — Decision Router; Recovery Engine consumes
  halt decisions

## Status history

| At | By | Status | Note |
|---|---|---|---|
| 2026-05-06 | post-Epic 72 sprint progress | open | Filed as Stream A+B sprint plan capstone. 2-story epic (extraction of Phase D 54-1 + 54-3). ACs explicitly cite canonical helpers (RunManifest / DoltClient / getLatestRun / manifest-read) per Story 69-2 / 71-2 / 70 / 72 lesson (4 prior epics where this prevented format-invention). Substrate-on-substrate dispatch with `--max-review-cycles 3`. |
