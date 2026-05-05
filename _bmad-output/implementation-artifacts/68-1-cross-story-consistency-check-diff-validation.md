---
external_state_dependencies:
  - git
  - filesystem
---

# Story 68-1: Cross-story consistency check + diff validation

## Story

As a substrate orchestrator operator,
I want the pipeline to detect when concurrent stories modify the same files and validate their interface coherence,
so that cross-story interaction races (like those in Epic 66 run `a832487a` and Epic 67 run `a59e4c96`) are caught automatically rather than discovered through transient verification failures.

## Acceptance Criteria

<!-- source-ac-hash: db93d057617e441c8abd398062de821990aff72d6e1734e0d25b63e545f617d5 -->

1. New module `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
   exporting `runCrossStoryConsistencyCheck(input)` matching the
   existing check shape (consult `runtime-probe-check.ts` or
   `source-ac-shellout-check.ts` for the contract).
2. Check registered in the verification pipeline (likely
   `packages/sdlc/src/verification/verification-pipeline.ts` and
   `checks/index.ts` registry wiring).
3. New event type `dispatch:cross-story-file-collision` declared in
   `packages/core/src/events/core-events.ts` and mirrored in
   `src/core/event-bus.types.ts` `OrchestratorEvents` (per Epic 66
   discipline — both interfaces must stay in sync, typecheck:gate
   catches mirror gaps).
4. Layer 1 detection: when orchestrator assigns concurrent stories,
   if two stories' `target_files` (or per-story modified file lists
   from working-tree state) intersect, emit
   `dispatch:cross-story-file-collision` event with `storyKeys`,
   `collisionPaths`, `recommendedAction: 'serialize' | 'warn'`.
5. Layer 2 detection: new finding category
   `cross-story-concurrent-modification` at severity `warn`. Fires
   when post-completion analysis shows two stories modified the same
   file AND interface signatures differ between commits.
6. DiffValidationCheck: only runs if BuildCheck passed (gate the
   gate); reports binary-filtered diff stats per story.
7. Tests in `packages/sdlc/src/__tests__/verification/cross-story-consistency-check.test.ts`:
   ≥6 cases including the canonical Epic 66 + Epic 67 reproduction
   fixtures (concurrent stories modifying methodology-pack.test.ts
   with conflicting budget assertions).
8. Backward-compat: existing checks continue to pass; new check is
   additive and conditional (only fires when run model has multi-story
   per_story_state with file-modification overlap).
9. Cite Epic 66 (run a832487a) + Epic 67 (run a59e4c96) as motivating
   incidents in the implementation file's header comment, per Story
   60-4/60-10 convention.
10. Commit message references the cross-story-interaction class +
    Epic 66/67 reconciliation pattern.

## Tasks / Subtasks

- [ ] Task 1: Declare new event type and mirror it (AC: #3)
  - [ ] Add `dispatch:cross-story-file-collision` event type with payload fields `storyKeys: string[]`, `collisionPaths: string[]`, `recommendedAction: 'serialize' | 'warn'` to `packages/core/src/events/core-events.ts`
  - [ ] Mirror the identical event type (same field names and shape) in `src/core/event-bus.types.ts` `OrchestratorEvents` interface, following the Epic 66 / `dispatch:spawnsync-timeout` mirror pattern exactly
  - [ ] Confirm `typecheck:gate` passes after the mirror — typecheck:gate catches interfaces that are out of sync between the two files

- [ ] Task 2: Add finding category constant to findings registry (AC: #5)
  - [ ] Add `CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION = 'cross-story-concurrent-modification' as const` to `packages/sdlc/src/verification/findings.ts`
  - [ ] Add JSDoc above the constant citing Epic 66/67 motivation, severity `warn`, and the Story 60-16 defensive-rollout note (promotion to `error` after empirical validation)

- [ ] Task 3: Implement `cross-story-consistency-check.ts` (AC: #1, #4, #5, #6, #9)
  - [ ] Create `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
  - [ ] Add header comment citing Epic 66 (run `a832487a`) + Epic 67 (run `a59e4c96`) as motivating incidents, per Story 60-4/60-10 convention
  - [ ] Implement exported `CrossStoryConsistencyCheck` class satisfying the `VerificationCheck` interface (`name`, `tier: 'B'`, `run(context): Promise<VerificationResult>`)
  - [ ] Export standalone `runCrossStoryConsistencyCheck(context: VerificationContext): Promise<VerificationResult>` function (same as `runShelloutCheck` pattern in `source-ac-shellout-check.ts`)
  - [ ] **Layer 1** — detect path intersections: extract file lists from `context.priorStoryFiles` (Tier B cross-story context); if two or more stories share a path emit `dispatch:cross-story-file-collision` event via the event bus (if available) with `recommendedAction: 'serialize'`
  - [ ] **Layer 1 fallback** — when `target_files` absent (prompt-edit stories), fall back to working-tree mtime comparison: stat each file in `context.workingDir`, compare mtime windows across concurrent story commit timestamps to detect overlap
  - [ ] **Layer 2** — diff validation: only run when `buildPassed` signal is present and `true` (guard: `context` should carry a `buildCheckPassed` signal — consult `VerificationContext` in `types.ts`; if no such field exists yet, derive it from the summary's prior check results passed into context or add the field); run `git diff --no-renames --numstat <baseCommit>..<storyCommit>` filtering binary files; parse output for conflicting type definitions (same identifier name, different shapes across two story commits), duplicate namespace creation, contradictory exports
  - [ ] Emit `cross-story-concurrent-modification` finding at severity `warn` when Layer 2 detects a genuine interface signature divergence
  - [ ] Return `VerificationResult` with `status`, `details` (via `renderFindings`), `duration_ms`, and `findings` array

- [ ] Task 4: Register check in the verification pipeline (AC: #2, #8)
  - [ ] Export `CrossStoryConsistencyCheck` and `runCrossStoryConsistencyCheck` from `packages/sdlc/src/verification/checks/index.ts` (follow the barrel pattern; add after `SourceAcShelloutCheck` export)
  - [ ] Register `CrossStoryConsistencyCheck` in `packages/sdlc/src/verification/verification-pipeline.ts` as a Tier B check — additive and conditional; the check's `tier: 'B'` designation ensures it runs only when Tier B context (multi-story `priorStoryFiles`) is supplied, so existing single-story runs are unaffected

- [ ] Task 5: Wire Layer 1 collision detection into orchestrator dispatch loop (AC: #4)
  - [ ] Edit `src/modules/implementation-orchestrator/orchestrator-impl.ts` in the section that assigns concurrent story batches
  - [ ] Before dispatching a concurrent batch, collect each story's `target_files` from the story spec (or recently modified files from working-tree state as fallback)
  - [ ] Compute pairwise path intersections across all stories in the batch
  - [ ] When intersection found: emit `dispatch:cross-story-file-collision` event (via `this.eventBus.emit`) with `{ storyKeys, collisionPaths, recommendedAction: 'serialize' }` and serialize the colliding stories (run them sequentially rather than concurrently)
  - [ ] Log the serialization decision at `info` level so operators can observe it in event stream

- [ ] Task 6: Write ≥6 test cases (AC: #7, #8)
  - [ ] Create `packages/sdlc/src/__tests__/verification/cross-story-consistency-check.test.ts`
  - [ ] Case 1 (no overlap): two stories with non-overlapping `priorStoryFiles` → check returns `pass`, zero findings
  - [ ] Case 2 (Layer 1 path collision): two stories share a file path in their file lists → check emits event payload shape `{ storyKeys, collisionPaths, recommendedAction: 'serialize' }` and returns at minimum `warn`
  - [ ] Case 3 (same file, no interface conflict): shared file modified by both stories but diff shows no type signature divergence → no `cross-story-concurrent-modification` finding
  - [ ] Case 4 (Layer 2 interface conflict): same file modified with conflicting type definitions (e.g. `budget: number` vs `budget: string`) → check returns `warn` with `cross-story-concurrent-modification` finding
  - [ ] Case 5 (Epic 66 canonical reproduction): concurrent stories modifying `methodology-pack.test.ts` with conflicting budget constant assertions (30000 vs 32000) → Layer 1 fires collision, Layer 2 reports modification finding
  - [ ] Case 6 (Epic 67 canonical reproduction): same file-collision scenario, different story keys — verifies event `storyKeys` array contains the correct identifiers and `collisionPaths` lists the contested file
  - [ ] Case 7 (BuildCheck gate): build did not pass → Layer 2 diff validation does NOT run; zero `cross-story-concurrent-modification` findings regardless of file overlap
  - [ ] Case 8 (backward-compat): single-story context with no `priorStoryFiles` → check returns `pass` immediately (additive conditional, no interference with existing Tier A checks)

## Dev Notes

### Architecture Constraints

- **Check contract**: `CrossStoryConsistencyCheck` must implement `VerificationCheck` from `packages/sdlc/src/verification/types.ts`. Read `source-ac-shellout-check.ts` for the canonical class+standalone-function pattern to follow exactly. The `run(context)` method must resolve (never reject) — catch all exceptions internally.
- **Tier B**: set `tier: 'B'` on the class. Tier B checks only run when cross-story context is present (`priorStoryFiles` supplied). This is what makes the check additive and backward-compatible with single-story runs.
- **Event type mirror discipline (Epic 66)**: `dispatch:cross-story-file-collision` MUST appear identically in BOTH `packages/core/src/events/core-events.ts` (in `CoreEvents`) AND `src/core/event-bus.types.ts` (in `OrchestratorEvents`). Do not add it to only one. The `typecheck:gate` CI step catches mirror gaps — run `npm run typecheck:gate` (or the project's equivalent) after adding both declarations to verify.
- **Layer 2 BuildCheck gate**: before running `git diff --no-renames`, verify that the build passed. The `VerificationContext` does not currently carry a `buildCheckPassed` boolean — add it as an optional field `buildCheckPassed?: boolean` to the `VerificationContext` interface in `packages/sdlc/src/verification/types.ts`, or derive it from a prior check result if the pipeline passes results forward. Consult `verification-pipeline.ts` to see whether prior check results are accessible within `run(context)`. If `buildCheckPassed` is absent/undefined, treat it as `true` (fail-open, since existing single-story runs don't populate it).
- **`cross-story-concurrent-modification` severity**: ships at `warn` per Story 60-16 defensive rollout pattern. Do NOT set it to `error`. Add a JSDoc comment in `findings.ts` noting that promotion to `error` is deferred pending empirical low-false-positive validation.
- **Header comment convention (Story 60-4/60-10)**: the implementation file's top-of-file JSDoc MUST cite Epic 66 run `a832487a` and Epic 67 run `a59e4c96` as motivating incidents. Follow the same convention as `source-ac-shellout-check.ts` which cites its motivating observation.

### Key Files to Read Before Implementing

| File | Why |
|---|---|
| `packages/sdlc/src/verification/checks/source-ac-shellout-check.ts` | Canonical check class + standalone function pattern to mirror |
| `packages/sdlc/src/verification/checks/runtime-probe-check.ts` | Alternative check contract reference |
| `packages/sdlc/src/verification/types.ts` | `VerificationCheck`, `VerificationContext`, `VerificationResult` interfaces |
| `packages/sdlc/src/verification/findings.ts` | `CATEGORY_*` constants, `renderFindings`, `VerificationFinding` type |
| `packages/sdlc/src/verification/checks/index.ts` | Barrel export registration pattern |
| `packages/sdlc/src/verification/verification-pipeline.ts` | How checks are registered and how Tier A vs B is handled |
| `packages/core/src/events/core-events.ts` | `CoreEvents` interface — add `dispatch:cross-story-file-collision` here |
| `src/core/event-bus.types.ts` | `OrchestratorEvents` interface — mirror the new event type here |
| `src/modules/implementation-orchestrator/orchestrator-impl.ts` | Dispatch loop — where Layer 1 hooks in |

### Import Patterns

```typescript
// In cross-story-consistency-check.ts:
import { execSync } from 'child_process'
import * as path from 'path'
import { CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION, renderFindings } from '../findings.js'
import type { VerificationCheck, VerificationContext, VerificationResult } from '../types.js'
```

### git diff for Layer 2

Use `execSync('git diff --no-renames --numstat <base>..<head>', { cwd: context.workingDir, encoding: 'utf-8' })` to get line stats per file. Filter binary files (they appear as `-\t-\t<filename>` in numstat output). For interface conflict detection, parse the full text diff (`git diff --no-renames <base>..<head> -- <file>`) looking for `+export interface` / `-export interface` or `+export type` / `-export type` lines with the same identifier but differing shape lines immediately following.

### Testing Pattern

Mock `execSync` in the test file (vitest `vi.mock('child_process', ...)`) to avoid requiring a real git repo. Return controlled diff output strings to exercise all detection branches. For the Epic 66/67 reproduction fixtures, use realistic-looking diff output derived from the actual incident: `methodology-pack.test.ts` with conflicting `BUDGET_LIMIT = 30000` vs `BUDGET_LIMIT = 32000` assertion constants.

## Interface Contracts

- **Export**: `CrossStoryConsistencyCheck` @ `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
- **Export**: `runCrossStoryConsistencyCheck` @ `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
- **Export**: `CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION` @ `packages/sdlc/src/verification/findings.ts`
- **Export**: `dispatch:cross-story-file-collision` event type @ `packages/core/src/events/core-events.ts` (CoreEvents) + `src/core/event-bus.types.ts` (OrchestratorEvents mirror)

## Runtime Probes

```yaml
- name: layer1-collision-detection-produces-finding
  sandbox: twin
  command: |
    set -e
    cd <REPO_ROOT>
    npm run build --workspace=packages/sdlc 2>/dev/null || npm run build
    SHARED_PATH="src/shared/config.ts"
    node --input-type=module << 'EOF'
    import { CrossStoryConsistencyCheck } from './packages/sdlc/dist/verification/checks/cross-story-consistency-check.js';
    const check = new CrossStoryConsistencyCheck();
    const context = {
      storyKey: 'probe-story-a',
      workingDir: process.cwd(),
      commitSha: 'abc123',
      timeout: 30000,
      priorStoryFiles: ['src/shared/config.ts'],
      buildCheckPassed: true,
      _crossStoryConflictingFiles: ['src/shared/config.ts'],
    };
    const result = await check.run(context);
    process.stdout.write(JSON.stringify({ status: result.status, findings: result.findings ?? [] }));
    EOF
  expect_stdout_regex:
    - '"status":\s*"(warn|pass)"'
  expect_stdout_no_regex:
    - '"isError"\s*:\s*true'
  description: >
    Smoke-tests that the check module loads, instantiates, and returns a
    structured VerificationResult without throwing. Full collision detection
    requires two concurrent stories in a live pipeline run.

- name: layer2-diff-validation-skips-on-build-failure
  sandbox: twin
  command: |
    set -e
    cd <REPO_ROOT>
    npm run build --workspace=packages/sdlc 2>/dev/null || npm run build
    node --input-type=module << 'EOF'
    import { CrossStoryConsistencyCheck } from './packages/sdlc/dist/verification/checks/cross-story-consistency-check.js';
    const check = new CrossStoryConsistencyCheck();
    const context = {
      storyKey: 'probe-story-b',
      workingDir: process.cwd(),
      commitSha: 'abc123',
      timeout: 30000,
      priorStoryFiles: ['src/shared/config.ts', 'packages/core/src/events/core-events.ts'],
      buildCheckPassed: false,
    };
    const result = await check.run(context);
    const layer2Findings = (result.findings ?? []).filter(
      f => f.category === 'cross-story-concurrent-modification'
    );
    process.stdout.write(JSON.stringify({ layer2Count: layer2Findings.length, status: result.status }));
    EOF
  expect_stdout_regex:
    - '"layer2Count":\s*0'
  expect_stdout_no_regex:
    - '"isError"\s*:\s*true'
  description: >
    Confirms Layer 2 (DiffValidationCheck) is gated behind BuildCheck — when
    buildCheckPassed=false, zero cross-story-concurrent-modification findings
    are emitted regardless of file overlap.

- name: finding-category-constant-exported
  sandbox: host
  command: |
    cd <REPO_ROOT>
    npm run build --workspace=packages/sdlc 2>/dev/null || npm run build
    node --input-type=module << 'EOF'
    import { CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION } from './packages/sdlc/dist/verification/findings.js';
    if (CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION !== 'cross-story-concurrent-modification') {
      process.stderr.write('FAIL: constant value mismatch\n');
      process.exit(1);
    }
    process.stdout.write('OK: cross-story-concurrent-modification constant exported correctly\n');
    EOF
  expect_stdout_regex:
    - 'OK: cross-story-concurrent-modification constant exported correctly'
  description: >
    Verifies that the new finding category constant is exported from the findings
    module with the correct stable string value that downstream consumers rely on.
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
