---
external_state_dependencies:
  - filesystem
  - database
  - subprocess
---

# Story 73-1: Recovery Engine with Tiered Autonomy

## Story

As a pipeline orchestrator,
I want a Recovery Engine that consumes Decision Router halt decisions and applies tiered recovery actions based on root-cause classification and retry budget,
so that failed stories are automatically retried with injected context, re-scoped when non-recoverable, and critical accumulations halt the pipeline safely — reducing manual escalation overhead.

## Acceptance Criteria

<!-- source-ac-hash: 5bb6d8a68405bfd2f74228f9e0fece499947df3cf0b00a94aae8a7a239e2aa6b -->

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

## Tasks / Subtasks

- [ ] Task 1: Scaffold Recovery Engine module with pure classification logic (AC1, AC13, AC14)
  - [ ] Create `src/modules/recovery-engine/index.ts` with header comment citing Phase D Story 54-1, Epic 70, Epic 72, Story 73-2
  - [ ] Export `runRecoveryEngine(input)` matching the action handler contract modeled on `packages/sdlc/src/verification/cross-story-race-recovery.ts` (input shape: `{ runId, storyKey, failure, budget, bus, manifest, adapter, engine?, workGraph? }`)
  - [ ] Implement `classifyRecoveryAction(failure, budget) -> 'retry' | 'propose' | 'halt'` as pure function with no I/O
  - [ ] Map root causes: `build-failure`, `test-coverage-gap`, `ac-missing-evidence`, `missing-import` → `retry`; `scope-violation`, `fundamental-design-error`, `cross-story-contract-mismatch` → `propose`; halt-policy root causes → `halt`

- [ ] Task 2: Extend ProposalSchema and add `appendProposal` to RunManifest (AC4, AC5, AC3, AC7)
  - [ ] Inspect `packages/sdlc/src/run-model/schemas.ts` ProposalSchema — current shape has `id`, `created_at`, `description`, `type`, `story_key`, `payload`
  - [ ] Extend ProposalSchema with `rootCause: z.string().optional()`, `attempts: z.number().int().optional()`, `suggestedAction: z.string().optional()`, `blastRadius: z.array(z.string()).optional()` (all `.optional()` for backward-compat with pre-Epic-73 manifests)
  - [ ] Inspect `packages/sdlc/src/run-model/run-manifest.ts` — add `appendProposal(proposal: ProposalInput): Promise<void>` method to `RunManifest` class using the existing `_enqueue` + `update()` pattern (reads current `pending_proposals`, deduplicates by `storyKey`, appends, writes atomically)
  - [ ] Wire Tier B path in `runRecoveryEngine`: when classify returns `propose`, call `manifest.appendProposal(proposal)` and emit `recovery:tier-b-proposal` event

- [ ] Task 3: Implement Tier A auto-retry and Tier C halt (AC2)
  - [ ] When `classifyRecoveryAction` returns `retry`: prepend `diagnosis + findings` to the dev-story dispatcher retry prompt; invoke the existing dev-story dispatcher with the enriched prompt
  - [ ] Reuse `runVerificationPipeline` (existing helper from `packages/sdlc/src/verification/`) for post-retry verification — do NOT duplicate verification logic
  - [ ] Emit `recovery:tier-a-retry` event with `{ runId, storyKey, rootCause, attempt, retryBudgetRemaining }`
  - [ ] On retry budget exhaustion (budget.remaining <= 0): escalate — call the Tier B proposal path
  - [ ] When `classifyRecoveryAction` returns `halt`: emit `recovery:tier-c-halt` event and return a halt-action result for the orchestrator; do NOT mark the story directly failed

- [ ] Task 4: Declare 4 new event types in event bus (AC8)
  - [ ] Add to `packages/core/src/events/core-events.ts`: `recovery:tier-a-retry`, `recovery:tier-b-proposal`, `recovery:tier-c-halt`, `pipeline:halted-pending-proposals` with their typed payload shapes
  - [ ] Mirror all 4 event types in `src/core/event-bus.types.ts` following the Story 66-4 pattern used by existing orchestrator and SDLC events

- [ ] Task 5: Back-pressure logic, safety valve, and idempotency (AC6, AC10)
  - [ ] After every proposal appended, read `pending_proposals.length` from the manifest
  - [ ] At `>= 2` with work graph available (`packages/factory/src/graph/`): query dependency edges; compute which ready stories depend on a proposed story; return `{ pause: dependentKeys, continue: independentKeys }` to the orchestrator
  - [ ] At `>= 2` in linear engine mode (no work graph): pause ALL remaining dispatching; return `{ pauseAll: true }` to orchestrator
  - [ ] At `>= 5` proposals: emit `pipeline:halted-pending-proposals` event; return halt-entire-run action to orchestrator (orchestrator exits main loop with code 1)
  - [ ] Idempotency guard in `appendProposal`: check `existing.pending_proposals.some(p => p.storyKey === proposal.storyKey)` before appending — return silently if already present

- [ ] Task 6: Orchestrator integration (AC9)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`: on every verification failure or dev-story dispatch timeout, call `runRecoveryEngine(...)` instead of directly marking the story `failed`
  - [ ] Handle the returned action from Recovery Engine: `retry` → continue the story dispatch cycle; `propose` → apply back-pressure; `halt` → yield to Decision Router / Interactive Prompt (Story 73-2); `halt-entire-run` → exit main loop with code 1

- [ ] Task 7: Unit tests ≥7 cases (AC11)
  - [ ] Write `src/modules/recovery-engine/__tests__/index.test.ts` covering: (a) Tier A — build-failure → retry with diagnosis injected into prompt; (b) Tier A — retry budget 0 → escalates to Tier B proposal; (c) Tier B — scope-violation → proposal appended to manifest; (d) Tier C — halt-policy root cause → returns halt action; (e) back-pressure with work graph ≥2 proposals → independent stories continue, dependent paused; (f) linear mode ≥2 proposals → all dispatching paused; (g) safety valve ≥5 proposals → run-halt returned regardless of dependency data

- [ ] Task 8: Integration test ≥1 case (AC12)
  - [ ] Write `__tests__/integration/recovery-engine.test.ts` using a real fixture RunManifest (temp dir) pre-populated with 1 proposed story and 2 ready stories (one dependent, one independent)
  - [ ] Invoke recovery engine with back-pressure scenario; assert: independent story continues dispatching, dependent story is paused

## Dev Notes

### Architecture Constraints

- **Action handler contract**: model `runRecoveryEngine` on `runStaleVerificationRecovery` from `packages/sdlc/src/verification/cross-story-race-recovery.ts`. Input type includes `{ runId, storyKey, failure, budget, bus, manifest, adapter }`. Returns a typed result discriminated union.
- **Pure core, I/O at the boundary**: `classifyRecoveryAction(failure, budget)` MUST be a pure function — no imports from I/O modules, no side effects. The action handler (`runRecoveryEngine`) owns all I/O.
- **Canonical manifest helpers ONLY** — never read or write manifest JSON directly. Always use `RunManifest` class. Never introduce a new aggregate manifest file. Lesson from 4 prior incidents (69-2, 71-2, 72-x).
- **`run-manifest.ts` not `.js`**: the actual implementation file is `packages/sdlc/src/run-model/run-manifest.ts` — the AC's `.js` reference is the TypeScript ESM import path convention. Add `appendProposal` to the class in `run-manifest.ts`.
- **No package additions**: all implementation must use existing packages. Verify with `pnpm ls` before adding any import.
- **Event typecheck gate**: new event types MUST be declared in both `packages/core/src/events/core-events.ts` AND mirrored in `src/core/event-bus.types.ts`. Missing mirror causes a typecheck:gate failure per Story 66-4 discipline.
- **`runVerificationPipeline` import path**: lives in `packages/sdlc/src/verification/` — find the correct helper name by grepping `orchestrator-impl.ts` which already imports it.
- **Work graph helper location**: check `packages/factory/src/graph/` for a dependency-query helper. If absent, fall back to a direct Dolt query on `wg_stories` (columns: `story_key`, `depends_on` or equivalent).
- **`appendProposal` idempotency**: implement inside the `_enqueue` chain (same pattern as other write methods) so concurrent callers serialize safely.
- **Linear mode detection**: check `input.engine === 'linear'` or detect via absence of `workGraph` in input.

### Testing Requirements

- Test framework: Vitest (existing pattern — consult `src/modules/recovery-engine/` sibling modules or `packages/sdlc/src/verification/cross-story-race-recovery.ts` tests for import style)
- Mock the dev-story dispatcher in unit tests (do not dispatch real stories)
- Mock `runVerificationPipeline` in unit tests
- Mock the event bus (`bus.emit`) and assert event payloads for each tier
- Integration test uses a real temp-dir RunManifest (no mock) but mocks the dev-story dispatcher and work-graph query
- Run targeted tests during iteration: `npm run test:changed`
- Full suite before merge: `npm test`
- Never run concurrent vitest instances

### File Paths Reference

| File | Action |
|---|---|
| `src/modules/recovery-engine/index.ts` | NEW — main module |
| `src/modules/recovery-engine/__tests__/index.test.ts` | NEW — unit tests |
| `__tests__/integration/recovery-engine.test.ts` | NEW — integration test |
| `packages/sdlc/src/run-model/schemas.ts` | EXTEND ProposalSchema |
| `packages/sdlc/src/run-model/run-manifest.ts` | ADD `appendProposal` method |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | MODIFY — invoke Recovery Engine on failure/timeout |
| `packages/core/src/events/core-events.ts` | ADD 4 event type declarations |
| `src/core/event-bus.types.ts` | MIRROR 4 event types |

## Interface Contracts

- **Export**: `runRecoveryEngine` @ `src/modules/recovery-engine/index.ts` (consumed by orchestrator-impl.ts)
- **Export**: `classifyRecoveryAction` @ `src/modules/recovery-engine/index.ts` (pure function, testable in isolation)
- **Import**: `RunManifest` @ `@substrate-ai/sdlc/run-model/run-manifest.js` (from Story 52-1)
- **Import**: `ProposalSchema` @ `packages/sdlc/src/run-model/schemas.ts` (extended by this story)
- **Import**: `runVerificationPipeline` @ `packages/sdlc/src/verification/` (from Epic 51)
- **Import**: `getLatestRun` @ `packages/core/src/persistence/queries/decisions.ts` (from Story 52-x)
- **Import**: `DoltClient` @ `src/modules/state/index.ts` (existing persistence layer)
- **Import**: `FailureClassifier` / `classifyFailure` @ `packages/sdlc/src/learning/failure-classifier.ts` (from Story 53-5)

## Runtime Probes

```yaml
- name: proposal-schema-validates-extended-fields
  sandbox: host
  command: |
    cd /home/jplanow/code/jplanow/substrate
    node --input-type=module << 'EOF'
    import { ProposalSchema } from './packages/sdlc/src/run-model/schemas.js';
    const result = ProposalSchema.safeParse({
      id: 'prop-001',
      created_at: new Date().toISOString(),
      description: 'scope violation on story 73-1',
      type: 'escalate',
      storyKey: '73-1',
      rootCause: 'scope-violation',
      attempts: 2,
      suggestedAction: 'split story into 73-1a and 73-1b',
      blastRadius: ['73-2', '73-3']
    });
    if (!result.success) {
      console.error('SCHEMA_FAIL', JSON.stringify(result.error.errors));
      process.exit(1);
    }
    console.log('schema-ok rootCause=' + result.data.rootCause);
    EOF
  expect_stdout_regex:
    - 'schema-ok'
    - 'rootCause=scope-violation'
  description: Extended ProposalSchema (with rootCause/attempts/suggestedAction/blastRadius) validates without errors

- name: append-proposal-writes-to-manifest
  sandbox: twin
  command: |
    set -e
    cd /home/jplanow/code/jplanow/substrate
    node --input-type=module << 'EOF'
    import { mkdtemp } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { RunManifest } from './packages/sdlc/src/run-model/run-manifest.js';
    const runsDir = await mkdtemp(tmpdir() + '/substrate-probe-');
    const manifest = new RunManifest('probe-run-001', runsDir);
    // appendProposal must exist and write to pending_proposals
    await manifest.appendProposal({
      id: 'prop-001',
      created_at: new Date().toISOString(),
      description: 'probe: scope violation',
      type: 'escalate',
      storyKey: '73-1',
      rootCause: 'scope-violation',
      attempts: 2,
      suggestedAction: 'split story',
      blastRadius: ['73-2']
    });
    const data = await manifest.read();
    const proposals = data.pending_proposals ?? [];
    if (proposals.length === 0) { console.error('NO_PROPOSALS_WRITTEN'); process.exit(1); }
    console.log('proposals-count:' + proposals.length);
    console.log('root-cause:' + proposals[0].rootCause);
    console.log('blast-radius-len:' + (proposals[0].blastRadius ?? []).length);
    EOF
  expect_stdout_regex:
    - 'proposals-count:1'
    - 'root-cause:scope-violation'
    - 'blast-radius-len:1'
  description: appendProposal persists a Proposal to RunManifest.pending_proposals atomically

- name: append-proposal-idempotent-on-duplicate-story-key
  sandbox: twin
  command: |
    set -e
    cd /home/jplanow/code/jplanow/substrate
    node --input-type=module << 'EOF'
    import { mkdtemp } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { RunManifest } from './packages/sdlc/src/run-model/run-manifest.js';
    const runsDir = await mkdtemp(tmpdir() + '/substrate-probe-');
    const manifest = new RunManifest('probe-run-002', runsDir);
    const proposal = {
      id: 'prop-002',
      created_at: new Date().toISOString(),
      description: 'idempotency probe',
      type: 'escalate',
      storyKey: '73-1',
      rootCause: 'scope-violation',
      attempts: 2,
      suggestedAction: 'split',
      blastRadius: []
    };
    await manifest.appendProposal(proposal);
    await manifest.appendProposal(proposal); // second call must be no-op
    const data = await manifest.read();
    const count = (data.pending_proposals ?? []).filter(p => p.storyKey === '73-1').length;
    console.log('deduped-count:' + count);
    if (count !== 1) { console.error('IDEMPOTENCY_VIOLATED count=' + count); process.exit(1); }
    EOF
  expect_stdout_regex:
    - 'deduped-count:1'
  description: Calling appendProposal twice with the same storyKey results in exactly one entry (idempotent)

- name: recovery-engine-classify-pure-function
  sandbox: host
  command: |
    cd /home/jplanow/code/jplanow/substrate
    node --input-type=module << 'EOF'
    import { classifyRecoveryAction } from './src/modules/recovery-engine/index.js';
    const budget = { remaining: 2, max: 3 };
    const r1 = classifyRecoveryAction({ rootCause: 'build-failure' }, budget);
    const r2 = classifyRecoveryAction({ rootCause: 'scope-violation' }, { remaining: 0, max: 3 });
    const r3 = classifyRecoveryAction({ rootCause: 'build-failure' }, { remaining: 0, max: 3 });
    if (r1 !== 'retry') { console.error('build-failure with budget should be retry, got: ' + r1); process.exit(1); }
    if (r2 !== 'propose') { console.error('scope-violation should be propose, got: ' + r2); process.exit(1); }
    if (r3 !== 'propose') { console.error('budget-exhausted build-failure should escalate to propose, got: ' + r3); process.exit(1); }
    console.log('classify-ok r1=' + r1 + ' r2=' + r2 + ' r3=' + r3);
    EOF
  expect_stdout_regex:
    - 'classify-ok'
    - 'r1=retry'
    - 'r2=propose'
    - 'r3=propose'
  description: classifyRecoveryAction pure function routes root causes to correct tiers and respects retry budget exhaustion
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
