---
external_state_dependencies:
  - git
  - database
  - filesystem
---

# Story 70-1: Cross-story-race auto-retry of stale verifications

## Story

As a pipeline operator,
I want the orchestrator to automatically detect stories whose verification results were recorded before concurrent story commits landed,
so that cross-story-interaction races produce accurate final verdicts without requiring manual Path A recovery.

## Acceptance Criteria

<!-- source-ac-hash: 0d21e02c200abbba497b13389941e995c455a60b5d63daa65a867c9bd4b5c3cf -->

1. New module `packages/sdlc/src/verification/cross-story-race-recovery.ts` exporting `detectStaleVerifications(batch, manifest)` (pure function returning array of stale story keys) and `runStaleVerificationRecovery(input)` (action handler matching existing verification check shape — consult `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts` from Epic 68 for the contract).

2. Orchestrator integration: after concurrent batch completion, invoke `runStaleVerificationRecovery` IF Epic 68's `dispatch:cross-story-file-collision` event fired during the batch. Wire into `src/modules/implementation-orchestrator/orchestrator-impl.ts`.

3. **Critical: use canonical helpers for state access.** Per Story 69-2 / 71-2 pattern (3 prior incidents from invented formats):
   - Read run state via `RunManifest` class from `@substrate-ai/sdlc/run-model/run-manifest.js` (NOT custom manifest reader)
   - Persistence via existing `DoltClient` from `src/modules/state/index.ts`
   - Run-id resolution via `manifest-read.ts` helpers (`resolveRunManifest`, `readCurrentRunId`)
   - Latest-run fallback via `getLatestRun(adapter)` from `packages/core/src/persistence/queries/decisions.ts`
   - **Do NOT introduce a new aggregate manifest format.**

4. New status `verification-stale` declared in `packages/sdlc/src/run-model/per-story-state.ts` PerStoryStatusSchema (extensible union pattern — add as additional literal). Documented in JSDoc as transient state during cross-story-race recovery.

5. New event types declared in `packages/core/src/events/core-events.ts` AND mirrored in `src/core/event-bus.types.ts` `OrchestratorEvents` per Story 66-4 typecheck:gate discipline:
   - `pipeline:cross-story-race-recovered` — `{ runId, storyKey, originalFindings, freshFindings, recoveryDurationMs }`
   - `pipeline:cross-story-race-still-failed` — `{ runId, storyKey, freshFindings, recoveryDurationMs }`

6. **Re-run verification reuses existing pipeline**: invoke the same `runVerificationPipeline` function used by the primary verification flow. Do NOT duplicate verification logic — race recovery is "just verification, again, against fresh tree".

7. **Detection heuristic**: stale-verification detection compares `s.verifiedAt` (recorded in PerStoryState's verification_result metadata) against `t.committedAt` (from git log of the auto-commit matching `feat(story-<t.storyKey>):` pattern). Boundary: if `t.committedAt > s.verifiedAt` AND `t` modified a file in `s.modifiedFiles ∪ s.testFiles`, mark stale.

8. **Idempotency**: re-running recovery on a run with no stale verifications is a no-op — exit 0 with empty arrays.

9. **Tests** at `packages/sdlc/src/__tests__/verification/cross-story-race-recovery.test.ts` (≥6 cases): (a) detection — no race → empty; (b) detection — race detected → correct story marked stale; (c) recovery — fresh verification passes → status complete; (d) recovery — fresh verification fails → status failed with `verification_re_run: true`; (e) idempotency on no-stale runs; (f) edge case — story with no modifiedFiles attribute, fall back to verification-result file list.

10. **Integration test** at `__tests__/integration/cross-story-race-recovery.test.ts` (≥1 case): real fixture with 2-story batch where story B's commit lands AFTER story A's verification ran, both modify the same test file. Recovery re-runs story A's verification, passes, marks complete.

11. **Header comment** in implementation file cites Epic 66 (run a832487a), Epic 67 (run a59e4c96), and the budget-bump pattern (`packages/sdlc/src/__tests__/methodology-pack.test.ts`) as motivating incidents.

12. **Commit message** references cross-story-interaction race class + Epic 66/67 motivating incidents + that this primitive eliminates manual Path A on the race class going forward.

13. **No package additions**: implementation must use existing deps.

## Tasks / Subtasks

- [ ] Task 1: Add `verification-stale` literal to PerStoryStatusSchema (AC4) — ~1h
  - [ ] Open `packages/sdlc/src/run-model/per-story-state.ts`
  - [ ] Add `z.literal('verification-stale')` before the trailing `z.string()` fallback
  - [ ] Add JSDoc on the new literal: "Transient state during cross-story-race recovery (Story 70-1). Story is re-verification pending; not a terminal failure."
  - [ ] Verify PerStoryStatus union type inference includes the new literal

- [ ] Task 2: Declare new event types in both `packages/core/src/events/core-events.ts` and `src/core/event-bus.types.ts` (AC5) — ~1h
  - [ ] Add `pipeline:cross-story-race-recovered` with payload `{ runId: string; storyKey: string; originalFindings: unknown[]; freshFindings: unknown[]; recoveryDurationMs: number }` to `CoreEvents`
  - [ ] Add `pipeline:cross-story-race-still-failed` with payload `{ runId: string; storyKey: string; freshFindings: unknown[]; recoveryDurationMs: number }` to `CoreEvents`
  - [ ] Mirror both events into `OrchestratorEvents` in `src/core/event-bus.types.ts` with matching JSDoc noting "Mirror of CoreEvents['pipeline:cross-story-race-recovered']; both must stay in sync." per Story 66-4 discipline
  - [ ] Add JSDoc on each event citing Story 70-1 and motivating incidents Epic 66 (a832487a) + Epic 67 (a59e4c96)

- [ ] Task 3: Implement `detectStaleVerifications` pure function in new module (AC1, AC7, AC8) — ~2h
  - [ ] Create `packages/sdlc/src/verification/cross-story-race-recovery.ts` with header comment citing Epic 66 (run a832487a), Epic 67 (run a59e4c96), and budget-bump pattern (`packages/sdlc/src/__tests__/methodology-pack.test.ts`)
  - [ ] Implement `detectStaleVerifications(batch: BatchEntry[], manifest: RunManifest): string[]` — pure function, no I/O
  - [ ] For each story `s`, read `s.verifiedAt` from `verification_result` metadata (fall back to `completed_at` if absent per Risk: Assumption 2)
  - [ ] For each other story `t` in batch: check `t.committedAt > s.verifiedAt` AND `t.modifiedFiles` overlaps `s.modifiedFiles ∪ s.testFiles` (fall back to verification-result file list when `modifiedFiles` absent per AC9-f)
  - [ ] Return empty array when no stale stories detected (idempotency per AC8)
  - [ ] Export `CommittedAtResolver` helper that reads `feat(story-<storyKey>):` pattern from `git log` (AC7 heuristic — this helper is used by `runStaleVerificationRecovery` for real git data, while `detectStaleVerifications` accepts pre-resolved data for purity)

- [ ] Task 4: Implement `runStaleVerificationRecovery` action handler using canonical helpers (AC1, AC3, AC6) — ~3h
  - [ ] Define input shape: `{ runId: string; batch: BatchEntry[]; workingDir: string; bus: TypedEventBus<SdlcEvents>; manifest: RunManifest; adapter: DatabaseAdapter }`
  - [ ] Use `RunManifest` from `@substrate-ai/sdlc/run-model/run-manifest.js` for state reads (AC3)
  - [ ] Use `DoltClient` from `src/modules/state/index.ts` for persistence (AC3)
  - [ ] Resolve `committedAt` per story via `CommittedAtResolver` (git log of `feat(story-<key>):` commits)
  - [ ] Call `detectStaleVerifications(batch, manifest)` to get stale story key list
  - [ ] For each stale story: transition status to `verification-stale` in manifest
  - [ ] Re-invoke `runVerificationPipeline` (from `packages/sdlc/src/verification/verification-pipeline.ts`) against current tree state — clearing any cached verification state first (AC6 + Risk: re-run uses stale fix-context)
  - [ ] On pass: transition status to `complete`; emit `pipeline:cross-story-race-recovered` event
  - [ ] On fail: transition status to `failed` with `verification_re_run: true` attribute; emit `pipeline:cross-story-race-still-failed` event
  - [ ] Return `{ recovered: string[]; stillFailed: string[]; noStale: boolean }` for caller

- [ ] Task 5: Wire batch-completion hook into orchestrator-impl.ts (AC2) — ~2h
  - [ ] Identify batch completion point in `src/modules/implementation-orchestrator/orchestrator-impl.ts` (after all concurrent stories resolve dev-story phase)
  - [ ] Track per-batch `collisionFired: boolean` by subscribing to `dispatch:cross-story-file-collision` events during each batch
  - [ ] After batch completion: if `collisionFired`, invoke `runStaleVerificationRecovery` with batch context, manifest, and adapter
  - [ ] Log recovery summary (recovered count, still-failed count) at info level
  - [ ] No-op when `collisionFired === false` (graceful degradation per Assumption 1)

- [ ] Task 6: Write unit tests ≥6 cases (AC9) — ~2-3h
  - [ ] Create `packages/sdlc/src/__tests__/verification/cross-story-race-recovery.test.ts`
  - [ ] Case (a): `detectStaleVerifications` — no race (t.committedAt < s.verifiedAt) → returns empty array
  - [ ] Case (b): `detectStaleVerifications` — race detected (t.committedAt > s.verifiedAt, overlapping files) → returns correct stale story key
  - [ ] Case (c): `runStaleVerificationRecovery` — re-verification passes → status transitions to `complete`, `pipeline:cross-story-race-recovered` emitted
  - [ ] Case (d): `runStaleVerificationRecovery` — re-verification fails → status transitions to `failed` with `verification_re_run: true`, `pipeline:cross-story-race-still-failed` emitted
  - [ ] Case (e): idempotency — no stale stories → returns `{ recovered: [], stillFailed: [], noStale: true }`, no Dolt writes
  - [ ] Case (f): edge case — story with no `modifiedFiles` attribute falls back to verification-result file list for overlap detection

- [ ] Task 7: Write integration test with 2-story batch fixture (AC10) — ~2h
  - [ ] Create `__tests__/integration/cross-story-race-recovery.test.ts`
  - [ ] Build fixture: 2-story batch (stories A and B) modifying the same test file
  - [ ] Simulate story A verifying before story B commits (timestamp ordering)
  - [ ] Run `runStaleVerificationRecovery` with real git fixture
  - [ ] Assert story A transitions to `complete` after recovery re-run passes
  - [ ] Assert `pipeline:cross-story-race-recovered` event emitted

- [ ] Task 8: Final validation pass — ~30min
  - [ ] Confirm header comment in `cross-story-race-recovery.ts` cites Epic 66 (run a832487a), Epic 67 (run a59e4c96), and budget-bump pattern (AC11)
  - [ ] Verify `package.json` files have no new deps added — `npm ls` diff clean (AC13)
  - [ ] Run `npm run build` + `npm run test:fast` — no new failures

## Dev Notes

### Architecture Constraints

- **Canonical state helpers only** (AC3): `RunManifest` from `@substrate-ai/sdlc/run-model/run-manifest.js`, `DoltClient` from `src/modules/state/index.ts`, `resolveRunManifest`/`readCurrentRunId` from `manifest-read.ts`, `getLatestRun(adapter)` from `packages/core/src/persistence/queries/decisions.ts`. Zero invented manifest formats.
- **No new package dependencies** (AC13): all imports must resolve to existing `package.json` entries.
- **Verification pipeline reuse** (AC6): import and invoke `runVerificationPipeline` from `packages/sdlc/src/verification/verification-pipeline.ts` — same function as primary verification flow. The recovery module must clear any cached verification state before re-invoking to avoid reading stale fixture data.
- **Event mirror discipline** (AC5 / Story 66-4): when adding events to `CoreEvents`, mirror them identically in `OrchestratorEvents` with JSDoc noting "Mirror of CoreEvents['...']; both must stay in sync." Failure to mirror causes typecheck:gate failures.
- **Extensible union pattern** (AC4): `verification-stale` MUST be inserted BEFORE the trailing `z.string()` fallback in `PerStoryStatusSchema`. The fallback MUST remain last.

### Key File Locations

| File | Role |
|---|---|
| `packages/sdlc/src/verification/cross-story-race-recovery.ts` | New module: `detectStaleVerifications` + `runStaleVerificationRecovery` |
| `packages/sdlc/src/run-model/per-story-state.ts` | Add `verification-stale` literal to PerStoryStatusSchema |
| `packages/core/src/events/core-events.ts` | New event types (source of truth) |
| `src/core/event-bus.types.ts` | Mirror new event types in OrchestratorEvents |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | Wire batch-completion hook |
| `packages/sdlc/src/__tests__/verification/cross-story-race-recovery.test.ts` | Unit tests |
| `__tests__/integration/cross-story-race-recovery.test.ts` | Integration test |

### Detection Heuristic (AC7)

The stale-verification boundary condition:
```
t.committedAt > s.verifiedAt
AND
t.modifiedFiles ∩ (s.modifiedFiles ∪ s.testFiles) ≠ ∅
```

Where `t.committedAt` is resolved from `git log --format=%cI --grep="feat(story-<t.storyKey>):" -1`. If `s.verifiedAt` is absent from `verification_result` metadata, fall back to `s.completed_at` (Story 52-4 field, always present at terminal state).

### Existing Pattern Reference

The check shape in `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts` is the contract template for `runStaleVerificationRecovery`. Study:
- `runCrossStoryConsistencyCheck(context: VerificationContext): Promise<VerificationResult>`
- `computeCollisionPaths(context)` — path intersection helper (reuse or adapt for `modifiedFiles` overlap)

The event mirror pattern in `packages/core/src/events/core-events.ts` lines 291–306 (`dispatch:cross-story-file-collision`) is the canonical template for AC5 event declarations.

### Testing Requirements

- Unit tests use Vitest. Mock `runVerificationPipeline` with controllable pass/fail outcomes.
- Mock `execSync` (git log) in unit tests to avoid filesystem dependency.
- Integration test uses a real temporary git fixture (two commits on separate branches that simulate concurrent dispatch commit ordering).
- Test file follows existing naming: `packages/sdlc/src/__tests__/verification/` directory.
- Use `npm run test:fast` during iteration; `npm test` for full suite validation.

### Failure Mode Reference (AC3 guardrail)

Three prior incidents from invented manifest formats (Stories 69-2, 71-2):
1. Custom manifest reader that parsed wrong fields → stale data reads
2. Invented aggregate format that diverged from `RunManifest` schema → runtime crashes on resume
3. Ad-hoc `readFileSync` on manifest path → bypassed `RunManifest` validation and cache layer

Always go through `RunManifest` class. Never read the `.substrate/manifest.json` file directly.

## Interface Contracts

- **Export**: `detectStaleVerifications` @ `packages/sdlc/src/verification/cross-story-race-recovery.ts` — pure function consumed by orchestrator batch-completion hook (Story 70-1)
- **Export**: `runStaleVerificationRecovery` @ `packages/sdlc/src/verification/cross-story-race-recovery.ts` — action handler consumed by orchestrator (Story 70-1)
- **Import**: `VerificationContext`, `VerificationResult` @ `packages/sdlc/src/verification/types.ts` — check contract shape
- **Import**: `RunManifest`, `PerStoryStatus` @ `@substrate-ai/sdlc/run-model/run-manifest.js` — canonical state accessor
- **Import**: `runVerificationPipeline` (or `VerificationPipeline`) @ `packages/sdlc/src/verification/verification-pipeline.ts` — reused pipeline (AC6)
- **Export**: `pipeline:cross-story-race-recovered` event @ `packages/core/src/events/core-events.ts` + mirror in `src/core/event-bus.types.ts`
- **Export**: `pipeline:cross-story-race-still-failed` event @ `packages/core/src/events/core-events.ts` + mirror in `src/core/event-bus.types.ts`

## Runtime Probes

```yaml
- name: detect-stale-verifications-no-race
  sandbox: host
  command: |
    set -e
    cd /home/jplanow/code/jplanow/substrate
    node -e "
    const { detectStaleVerifications } = require('./packages/sdlc/dist/verification/cross-story-race-recovery.js');
    // Story A verified AFTER story B committed — no race
    const batch = [
      { storyKey: 'A', verifiedAt: '2026-01-01T10:05:00Z', modifiedFiles: ['src/foo.ts'], testFiles: [] },
      { storyKey: 'B', committedAt: '2026-01-01T10:00:00Z', modifiedFiles: ['src/foo.ts'] }
    ];
    const stale = detectStaleVerifications(batch, {});
    if (stale.length !== 0) process.exit(1);
    console.log('ok: no stale detected');
    "
  expect_stdout_regex:
    - 'ok: no stale detected'
  description: detectStaleVerifications returns empty when no race condition exists

- name: detect-stale-verifications-race-detected
  sandbox: host
  command: |
    set -e
    cd /home/jplanow/code/jplanow/substrate
    node -e "
    const { detectStaleVerifications } = require('./packages/sdlc/dist/verification/cross-story-race-recovery.js');
    // Story A verified BEFORE story B committed — race!
    const batch = [
      { storyKey: 'A', verifiedAt: '2026-01-01T09:55:00Z', modifiedFiles: ['src/shared.ts'], testFiles: ['src/__tests__/shared.test.ts'] },
      { storyKey: 'B', committedAt: '2026-01-01T10:00:00Z', modifiedFiles: ['src/shared.ts'] }
    ];
    const stale = detectStaleVerifications(batch, {});
    if (!stale.includes('A')) process.exit(1);
    console.log('ok: stale detected for A');
    "
  expect_stdout_regex:
    - 'ok: stale detected for A'
  description: detectStaleVerifications marks story A stale when B committed after A verified and they share files

- name: recovery-integration-two-story-batch
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO" && git init -q
    git config user.email test@example.com && git config user.name test
    echo "shared content" > shared.test.ts
    git add . && git commit -qm "initial"
    # Simulate story A commit (earlier)
    echo "story A change" >> shared.test.ts
    git add . && git commit -qm "feat(story-70-A): implement story A"
    A_SHA=$(git rev-parse HEAD)
    # Simulate story B commit (later — after A would have verified)
    echo "story B change" >> shared.test.ts
    git add . && git commit -qm "feat(story-70-B): implement story B"
    B_SHA=$(git rev-parse HEAD)
    echo "A_SHA=$A_SHA B_SHA=$B_SHA repo=$REPO"
    # Verify the git log pattern resolves correctly
    B_COMMIT_DATE=$(git log --format=%cI --grep="feat(story-70-B):" -1)
    A_COMMIT_DATE=$(git log --format=%cI --grep="feat(story-70-A):" -1)
    echo "A_committed=$A_COMMIT_DATE B_committed=$B_COMMIT_DATE"
    # Both dates must be non-empty (git log pattern works)
    if [ -z "$A_COMMIT_DATE" ] || [ -z "$B_COMMIT_DATE" ]; then
      echo "FAIL: git log pattern did not resolve"
      exit 1
    fi
    echo "ok: git log pattern resolves for both stories"
  expect_stdout_regex:
    - 'ok: git log pattern resolves for both stories'
    - 'A_committed=\d{4}-\d{2}-\d{2}'
    - 'B_committed=\d{4}-\d{2}-\d{2}'
  description: git log commit-date resolution pattern works for 2-story batch fixture with overlapping files
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
