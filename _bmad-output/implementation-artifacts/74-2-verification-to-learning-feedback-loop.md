---
external_state_dependencies:
  - database
---

# Story 74-2: Verification-to-Learning Feedback Loop

## Story

As a substrate pipeline orchestrator,
I want every verification finding wired into the learning store via the existing Dolt decisions table,
so that future dispatches' FindingsInjector automatically picks up verification-generated signal without manual intervention.

## Acceptance Criteria

<!-- source-ac-hash: 8896f8443f215fe2ee17741ca4da2900cc6621f7889ed7eaeceb6169008f0853 -->

1. New module `packages/sdlc/src/verification/findings-to-learning-store.ts` exporting `injectVerificationFindings(verificationSummary, storyContext)`. Consumes existing `VerificationSummary` shape (from `packages/sdlc/src/verification/types.ts`) and produces `Finding[]` matching the existing learning-store Finding shape from `packages/sdlc/src/learning/types.ts` (or wherever Finding is defined).

2. **Root-cause derivation map** (consume in `injectVerificationFindings`):
   - `phantom-review` failures → root cause `build-failure`
   - `trivial-output` failures → root cause `resource-exhaustion`
   - `build` failures → root cause `build-failure`
   - `acceptance-criteria-evidence` failures → root cause `ac-missing-evidence`
   - `runtime-probes` failures → root cause `runtime-probe-fail`
   - `source-ac-fidelity` failures → root cause `source-ac-drift`
   - `cross-story-consistency` failures → root cause `cross-story-concurrent-modification`

3. **Confidence**: every verification-generated Finding has `confidence: 'high'` (verified by static analysis, not heuristic).

4. **Affected files**: from the story's `files_modified` (in per-story state).

5. **Persistence**: write Finding objects to existing Dolt decisions table via existing `DoltClient` helper. Reuse existing `appendFinding(adapter, finding)` from `packages/core/src/persistence/queries/decisions.ts` (if absent, look for similar helper; do NOT create new table).

6. **Trigger**: `injectVerificationFindings` is invoked by `runVerificationPipeline` (existing fn at `packages/sdlc/src/verification/verification-pipeline.ts`) AFTER the verification result is finalized for each story. Wire as side-effect at the end of the pipeline (NOT a dependency — verification result is independent of learning write).

7. **CRITICAL: use canonical helpers** (per Story 69-2 / 71-2 / 72-x / 73-x lesson — 5 prior epics):
   - Persistence via existing `DoltClient` from `src/modules/state/index.ts`
   - Findings shape per `packages/sdlc/src/learning/types.ts` (do NOT introduce new finding format)
   - **Do NOT introduce new aggregate manifest formats.**

8. **`FindingsInjector` consumption**: Story 53-X's `FindingsInjector` (consult `packages/sdlc/src/learning/findings-injector.ts` if present) should automatically pick up verification-generated findings on future dispatches via the same query path it uses for external Findings. No code changes required to FindingsInjector; verification findings just appear in the same Dolt rows.

9. **Tests** at `packages/sdlc/src/__tests__/verification/findings-to-learning-store.test.ts` (≥5 cases): (a) phantom-review fail → root_cause build-failure; (b) trivial-output fail → root_cause resource-exhaustion; (c) build fail → root_cause build-failure; (d) all warns produce findings (not just fails); (e) findings persist via DoltClient mock (assert `appendFinding` invoked with correct shape).

10. **Integration test** at `__tests__/integration/findings-to-learning-store.test.ts` (≥1 case): real fixture verification summary; invoke injection; assert Dolt decisions table contains expected Finding rows queryable via existing FindingsInjector.

11. **Header comment** cites Phase D Story 54-8 (original spec) + Story 53-5 (root cause taxonomy this consumes) + that closes the feedback circuit (verification → learning → dispatch).

12. **No package additions**.

## Tasks / Subtasks

- [ ] Task 1: Audit existing types and helpers (AC: #1, #5, #7, #8)
  - [ ] Read `packages/sdlc/src/verification/types.ts` — confirm `VerificationSummary` fields and `VerificationCheckResult.checkName` / `.status` fields
  - [ ] Read `packages/sdlc/src/learning/types.ts` — confirm `Finding` schema fields (`id`, `run_id`, `story_key`, `root_cause`, `affected_files`, `description`, `confidence`, `created_at`, `expires_after_runs`)
  - [ ] Read `packages/core/src/persistence/queries/decisions.ts` — confirm `appendFinding` is absent; identify table name from existing query patterns or from `packages/sdlc/src/learning/findings-injector.ts`
  - [ ] Read `packages/sdlc/src/learning/findings-injector.ts` (if present) — identify the Dolt table name and query pattern FindingsInjector uses to read findings

- [ ] Task 2: Add `appendFinding` to decisions.ts (AC: #5, #7)
  - [ ] If `appendFinding` is absent from `packages/core/src/persistence/queries/decisions.ts`: add it following the same adapter pattern as `createDecision` and `addTokenUsage` in that file — insert a row into the existing findings table (do NOT create a new table; use the table that Story 53-5/FindingsInjector already queries)
  - [ ] Signature: `appendFinding(adapter: DoltAdapter, finding: Finding): Promise<void>`
  - [ ] Use `crypto.randomUUID()` or the existing UUID pattern in the file for the `id` field if not already set on the Finding passed in

- [ ] Task 3: Implement `packages/sdlc/src/verification/findings-to-learning-store.ts` (AC: #1, #2, #3, #4, #7, #11)
  - [ ] Add header comment citing Phase D Story 54-8, Story 53-5, and the feedback circuit closure
  - [ ] Export `injectVerificationFindings(verificationSummary: VerificationSummary, storyContext: StoryContext): Promise<void>`
  - [ ] Define `StoryContext` interface (inline or import from existing context types): `{ runId: string; filesModified: string[] }`
  - [ ] Implement root-cause derivation map (7 entries from AC2); unmapped checkNames → skip (do not inject)
  - [ ] Filter checks to `status === 'fail'` OR `status === 'warn'` only — skip `pass` and any status not in that set (AC per risks section: only fail/warn, not info/pass)
  - [ ] Set `confidence: 'high'` on every Finding (AC3)
  - [ ] Set `affected_files` from `storyContext.filesModified` (AC4)
  - [ ] Acquire DoltClient from `src/modules/state/index.ts`; call `appendFinding` for each Finding

- [ ] Task 4: Wire injection into `packages/sdlc/src/verification/verification-pipeline.ts` (AC: #6)
  - [ ] After `this._bus.emit('verification:story-complete', summary)` and before `return summary`, call `injectVerificationFindings(summary, context)` as fire-and-forget: `.catch(err => logger.warn('verification learning injection failed', err))` — do not await; do not let learning write errors propagate to callers
  - [ ] Import `injectVerificationFindings` from `./findings-to-learning-store.js`
  - [ ] Confirm `context` passed to `runVerificationPipeline` supplies `runId` and `filesModified`; if the pipeline context uses different field names, map them at the call site

- [ ] Task 5: Unit tests at `packages/sdlc/src/__tests__/verification/findings-to-learning-store.test.ts` (AC: #9)
  - [ ] (a) `phantom-review` check with `status: 'fail'` → `root_cause: 'build-failure'`
  - [ ] (b) `trivial-output` check with `status: 'fail'` → `root_cause: 'resource-exhaustion'`
  - [ ] (c) `build` check with `status: 'fail'` → `root_cause: 'build-failure'`
  - [ ] (d) `source-ac-fidelity` check with `status: 'warn'` → Finding produced (warns inject, not just fails)
  - [ ] (e) Mock DoltClient/appendFinding; assert `appendFinding` called with correct Finding shape (`confidence: 'high'`, `affected_files` matching storyContext.filesModified, correct `root_cause`)
  - [ ] Negative case: `status: 'pass'` checks produce zero findings

- [ ] Task 6: Integration test at `__tests__/integration/findings-to-learning-store.test.ts` (AC: #10)
  - [ ] Use real (test-isolated) Dolt connection; real fixture VerificationSummary with at least one `fail` and one `warn` check
  - [ ] Invoke `injectVerificationFindings`; query Dolt decisions (findings) table; assert rows exist with correct `root_cause` and `story_key`
  - [ ] Assert findings are queryable via existing FindingsInjector (call FindingsInjector.getFindings or equivalent query) to prove the feedback circuit is closed (AC8)

## Dev Notes

### Architecture Constraints

- **DoltClient import**: `import { DoltClient, createDoltClient } from '../../../../src/modules/state/index.js'` (adjust relative path per file location). Do NOT introduce new state management.
- **Finding shape**: `packages/sdlc/src/learning/types.ts` — fields: `id` (uuid), `run_id`, `story_key`, `root_cause` (must match `RootCauseCategorySchema` enum), `affected_files` (string[]), `description` (string), `confidence` ('high' | 'low'), `created_at` (ISO string), `expires_after_runs` (positive int, default 5). Do NOT add new fields.
- **VerificationCheckResult**: extends `VerificationResult` — has `checkName: string`, `status: 'pass' | 'warn' | 'fail'`, `details: string`, `duration_ms: number`.
- **No package additions**: use only existing imports (`crypto` built-in for UUID, existing Zod schemas, existing DoltClient).
- **Fire-and-forget wiring** in verification-pipeline.ts: the verification result (`return summary`) must not be gated on the Dolt write. Pattern: `injectVerificationFindings(summary, ctx).catch(err => logger.warn(...))`.

### appendFinding Implementation Guidance

`appendFinding` is absent from `packages/core/src/persistence/queries/decisions.ts`. Before creating it:
1. Read `packages/sdlc/src/learning/findings-injector.ts` — it queries an existing table (likely `wg_findings` or similar). Use that same table name.
2. If FindingsInjector is absent, search for any `wg_findings` table reference across the codebase.
3. Add `appendFinding` to `decisions.ts` following the exact adapter pattern used by `addTokenUsage` and `createDecision`.

### Root-Cause Derivation Map (from AC2)

```typescript
const ROOT_CAUSE_MAP: Record<string, string> = {
  'phantom-review':              'build-failure',
  'trivial-output':              'resource-exhaustion',
  'build':                       'build-failure',
  'acceptance-criteria-evidence':'ac-missing-evidence',
  'runtime-probes':              'runtime-probe-fail',
  'source-ac-fidelity':          'source-ac-drift',
  'cross-story-consistency':     'cross-story-concurrent-modification',
}
```

Only inject findings for checks where `ROOT_CAUSE_MAP[checkName]` is defined AND `status` is `'fail'` or `'warn'`.

### Testing Requirements

- Unit tests: mock `appendFinding` (vi.mock or jest.mock on the decisions module); do NOT hit real Dolt
- Integration test: use the project's existing test-Dolt setup (check existing integration tests for the Dolt connection pattern)
- Test file locations must match exactly as specified in ACs (9 and 10)

### Header Comment (AC11)

```typescript
/**
 * Verification-to-Learning feedback bridge.
 *
 * Original spec: Phase D Story 54-8 (2026-04-05)
 * Root-cause taxonomy consumed: Story 53-5 (v0.19.31)
 *
 * Closes the feedback circuit: verification pipeline findings →
 * learning store (Dolt decisions table) → FindingsInjector →
 * future dispatch context.
 */
```

## Runtime Probes

```yaml
- name: findings-to-learning-store-exports-function
  sandbox: host
  command: |
    cd /home/jplanow/code/jplanow/substrate
    npm run build 2>&1 | tail -3
    node --input-type=module -e "
      import('./packages/sdlc/dist/verification/findings-to-learning-store.js')
        .then(m => {
          if (typeof m.injectVerificationFindings !== 'function') {
            throw new Error('injectVerificationFindings not exported');
          }
          console.log('export-ok');
        });
    "
  expect_stdout_regex:
    - 'export-ok'
  description: module builds cleanly and exports injectVerificationFindings

- name: findings-written-to-dolt-decisions
  sandbox: twin
  command: |
    set -e
    cd /home/jplanow/code/jplanow/substrate
    node --input-type=module << 'PROBE_EOF'
    import { injectVerificationFindings } from './packages/sdlc/dist/verification/findings-to-learning-store.js';
    const summary = {
      storyKey: 'probe-74-2-build',
      checks: [
        { checkName: 'build', status: 'fail', details: 'tsc error in probe', duration_ms: 10 },
        { checkName: 'phantom-review', status: 'warn', details: 'phantom warn in probe', duration_ms: 5 }
      ],
      status: 'fail',
      duration_ms: 50
    };
    const ctx = { runId: 'probe-run-74-2', filesModified: ['packages/probe/src/test.ts'] };
    await injectVerificationFindings(summary, ctx);
    console.log('probe-injection-complete');
    PROBE_EOF
    dolt sql -q "SELECT root_cause FROM wg_findings WHERE story_key = 'probe-74-2-build' ORDER BY root_cause"
  expect_stdout_regex:
    - 'probe-injection-complete'
    - 'build-failure'
  description: >
    build-fail and phantom-warn checks produce findings with build-failure root cause,
    persisted to Dolt and queryable — verifies full pipeline from injectVerificationFindings
    through DoltClient to the decisions table
```

**Note on probe table name**: the probe uses `wg_findings` as the expected table name. If FindingsInjector uses a different table name, update the `dolt sql` command in the probe to match. The dev agent should confirm the table name when implementing `appendFinding`.

## Interface Contracts

- **Import**: `VerificationSummary` @ `packages/sdlc/src/verification/types.ts`
- **Import**: `Finding`, `RootCauseCategorySchema` @ `packages/sdlc/src/learning/types.ts`
- **Import**: `appendFinding` (to be added) @ `packages/core/src/persistence/queries/decisions.ts`
- **Import**: `DoltClient`, `createDoltClient` @ `src/modules/state/index.ts`
- **Export**: `injectVerificationFindings` @ `packages/sdlc/src/verification/findings-to-learning-store.ts` (consumed by `packages/sdlc/src/verification/verification-pipeline.ts`)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-05-06 | Initial story file authored for Story 74-2 |
