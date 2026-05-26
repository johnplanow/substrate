---
external_state_dependencies:
  - subprocess
---

# Story 78-1: Fix `substrate report` recovery-attempts count for zero review cycles

## Story

As an operator reviewing substrate pipeline run reports,
I want `substrate report` to accurately display the recovery attempts count for stories with zero review cycles,
so that I can understand when recovery actually ran even when `review_cycles` is 0.

## Acceptance Criteria

<!-- source-ac-hash: 6e60f905bbaca0a15cde8f2d0141098b0a038e65f9983ca5c735ef374b2c6fd2 -->

1. `recovery_attempts` reflects actual recovery activity when `review_cycles` is 0:
   it must be at least the count of `recovery_history` entries for the story. Compute
   it as the maximum of `review_cycles` (when present) and the per-story
   `recovery_history` entry count — so neither signal is masked by the other.
2. When `review_cycles` is `undefined`/absent, the recovery_history count is still used
   (preserve the existing fallback behavior).
3. When both are 0/absent, `recovery_attempts` is 0 (unchanged).
4. The `blast_radius` string reflects the corrected count.
5. Unit test covering: (a) review_cycles=0 + 2 recovery_history entries → 2;
   (b) review_cycles=3 + 0 recovery_history → 3; (c) review_cycles=1 + 2
   recovery_history → 2; (d) both absent → 0.

## Tasks / Subtasks

- [ ] Task 1: Fix the `recovery_attempts` computation in `enrichEscalation` (AC: #1, #2, #3, #4)
  - [ ] Open `src/cli/commands/report.ts` and locate the `enrichEscalation` function (around line 333)
  - [ ] Replace the `??` (nullish coalescing) expression with a `Math.max` expression:
    - Old: `state.review_cycles ?? (manifest.recovery_history ?? []).filter((e) => e.story_key === storyKey).length`
    - New: `Math.max(state.review_cycles ?? 0, (manifest.recovery_history ?? []).filter((e) => e.story_key === storyKey).length)`
  - [ ] Verify `blast_radius` still references `recovery_attempts` (it does — no change needed there)

- [ ] Task 2: Create unit tests for `enrichEscalation` (AC: #5)
  - [ ] Create `src/cli/commands/__tests__/report.test.ts`
  - [ ] Import `enrichEscalation` from `../report.ts`
  - [ ] Write test case (a): `review_cycles=0` + 2 `recovery_history` entries for the story → `recovery_attempts === 2`
  - [ ] Write test case (b): `review_cycles=3` + 0 `recovery_history` entries → `recovery_attempts === 3`
  - [ ] Write test case (c): `review_cycles=1` + 2 `recovery_history` entries → `recovery_attempts === 2`
  - [ ] Write test case (d): both absent (undefined `review_cycles`, empty `recovery_history`) → `recovery_attempts === 0`
  - [ ] Verify `blast_radius` in each test case contains the corrected count

- [ ] Task 3: Run tests and confirm all pass (AC: #5)
  - [ ] Run `npx vitest run src/cli/commands/__tests__/report.test.ts` and confirm all 4 test cases pass
  - [ ] Run `npm run test:fast` to verify no regressions in other tests

## Dev Notes

### Architecture Constraints

**File to modify**: `src/cli/commands/report.ts`

The `enrichEscalation` function at line ~333 currently reads:
```ts
const recovery_attempts =
  state.review_cycles ??
  (manifest.recovery_history ?? []).filter((e) => e.story_key === storyKey).length
```

The `??` operator only falls through on `null`/`undefined` — NOT on `0`. So when `review_cycles === 0`, recovery_history is never consulted, even if it has entries. Fix:
```ts
const recovery_attempts = Math.max(
  state.review_cycles ?? 0,
  (manifest.recovery_history ?? []).filter((e) => e.story_key === storyKey).length,
)
```

This correctly takes the maximum of both signals so neither masks the other.

### Types

- `state: RawStoryState` — see interface in `src/cli/commands/report.ts`; `review_cycles` is optional (`number | undefined`)
- `manifest: RawManifest` — `recovery_history` is an optional array; each entry has `story_key: string`
- `EscalationDetail` interface has `recovery_attempts: number` (no change needed to interface)

### Test File

**New file**: `src/cli/commands/__tests__/report.test.ts`

Import path: `import { enrichEscalation } from '../report.js'` (use `.js` extension per project convention)

Minimal fixture shapes for unit tests:
```ts
// RawStoryState minimal shape
const stateWith = (review_cycles?: number) => ({
  escalation_reason: 'checkpoint-retry-timeout',
  review_cycles,
})

// RawManifest minimal shape
const manifestWith = (historyEntries: number) => ({
  recovery_history: Array.from({ length: historyEntries }, () => ({
    story_key: 'test-story-1',
    // other required fields...
  })),
})
```

Look at existing test files (e.g., `src/cli/commands/__tests__/health-manifest.test.ts`) for the test framework setup pattern (vitest with `describe`/`it`/`expect`).

### Testing Requirements

- Use vitest (`import { describe, it, expect } from 'vitest'`)
- All 4 AC5 sub-cases must be individual `it(...)` test cases
- Each test should assert both `recovery_attempts` and that `blast_radius` contains the expected count
- No mocking needed — `enrichEscalation` is a pure(-ish) function taking plain data

## Runtime Probes

```yaml
- name: report-recovery-count-unit-test
  sandbox: host
  command: npx vitest run src/cli/commands/__tests__/report.test.ts 2>&1
  expect_stdout_regex:
    - 'Test Files.*passed'
  description: the report recovery-attempts unit tests pass
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
