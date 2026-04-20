# Story 57.3: Surface `verification_ran` Signal in Status and Metrics JSON

## Story

As a pipeline operator,
I want `substrate status` and `substrate metrics` to tell me whether verification actually ran for each story,
so that I can distinguish "verification ran and found nothing" from "verification was skipped or never ran."

## Acceptance Criteria

### AC1: `verification_ran` Field in Status JSON
**Given** a pipeline run where some stories completed with verification and some without
**When** the operator runs `substrate status --output-format json`
**Then** each per-story entry includes a `verification_ran: true` field when `per_story_state[storyKey].verification_result` is present (any status), and `verification_ran: false` when it is absent or null

### AC2: `verification_ran` Field in Metrics JSON
**Given** a pipeline run manifest with mixed verification coverage across stories
**When** the operator runs `substrate metrics --output-format json`
**Then** each per-story record includes a `verification_ran` boolean matching the same presence-of-`verification_result` logic as status

### AC3: `verification_findings` Backward Compatibility Preserved
**Given** a story whose `verification_result` is absent (verification never ran)
**When** status or metrics JSON is produced
**Then** `verification_findings` still reports `{error: 0, warn: 0, info: 0}` (unchanged behavior); `verification_ran` is `false`

### AC4: Absent Manifest Degrades Gracefully
**Given** a run with no manifest file on disk (or a manifest that fails to parse)
**When** status or metrics JSON is produced
**Then** every story entry has `verification_ran: false` and `verification_findings: {error: 0, warn: 0, info: 0}` — no throw, no missing field

### AC5: Status Command Tests Extended
**Given** the existing test file `status-verification-findings-counts.test.ts`
**When** new test cases are added
**Then** at least two scenarios assert `verification_ran: true` (manifest present with `verification_result`) and at least one asserts `verification_ran: false` (absent or null `verification_result`), covering both backward-compat and absent-manifest paths

### AC6: Metrics Command Tests Extended
**Given** the existing test file `metrics-verification-findings-counts.test.ts`
**When** new test cases are added
**Then** at least two scenarios assert `verification_ran: true` and at least one asserts `verification_ran: false`, mirroring the same coverage as the status tests

### AC7: Mesh Reporter Forwards `verification_ran`
**Given** the agent-mesh telemetry reporter reads per-story verification data from the manifest
**When** it assembles the per-story payload to push to the mesh server
**Then** it includes `verification_ran` alongside any existing verification fields, set using the same presence-of-`verification_result` logic

## Tasks / Subtasks

- [ ] Task 1: Add `verification_ran` to status command per-story rollup (AC: #1, #3, #4)
  - [ ] In `src/cli/commands/status.ts`, locate the block that calls `rollupFindingCounts(verificationResult)` and adds `verification_findings` to the per-story JSON output (around line 353-357)
  - [ ] Inline `verification_ran: verificationResult !== undefined && verificationResult !== null` in the same per-story object, immediately adjacent to `verification_findings`
  - [ ] Verify the absent-manifest path (where `verificationResult` is undefined) yields `verification_ran: false`

- [ ] Task 2: Add `verification_ran` to metrics command per-story rollup (AC: #2, #3, #4)
  - [ ] In `src/cli/commands/metrics.ts`, locate the Map population loop (`findingCountsByStoryRun`) that reads `entry.verification_result` and calls `rollupFindingCounts`
  - [ ] Extend the stored value (or add a parallel Map `verificationRanByStoryRun`) to also record `entry.verification_result !== undefined && entry.verification_result !== null`
  - [ ] In the output mapping (around line 851-855), add `verification_ran` from the map lookup, defaulting to `false` when the key is missing

- [ ] Task 3: Extend status command tests (AC: #5)
  - [ ] Open `src/cli/commands/__tests__/status-verification-findings-counts.test.ts`
  - [ ] Add a test case asserting `verification_ran: true` for a story whose manifest entry has a `verification_result` object
  - [ ] Add a test case asserting `verification_ran: false` for a story whose manifest entry has `verification_result: undefined`
  - [ ] Add a test case asserting `verification_ran: false` for a story absent from the manifest entirely (absent-manifest backward-compat path)
  - [ ] Confirm existing AC assertions for `verification_findings` counts still pass (no regression)

- [ ] Task 4: Extend metrics command tests (AC: #6)
  - [ ] Open `src/cli/commands/__tests__/metrics-verification-findings-counts.test.ts`
  - [ ] Add a test case asserting `verification_ran: true` for a story with `verification_result` in the manifest
  - [ ] Add a test case asserting `verification_ran: false` for a story with absent `verification_result`
  - [ ] Add a test case asserting `verification_ran: false` for the absent-manifest path
  - [ ] Confirm existing AC assertions for `verification_findings` counts still pass

- [ ] Task 5: Update mesh reporter to forward `verification_ran` (AC: #7)
  - [ ] Open `src/modules/telemetry/mesh-reporter.ts`
  - [ ] In `loadVerificationResults()` or the story payload assembly block (around line 161-192), add `verification_ran: verificationResult !== undefined && verificationResult !== null`
  - [ ] Confirm the field appears in the per-story payload sent to the mesh server
  - [ ] Do NOT add new tests for mesh-reporter beyond what already exists — this is a minor additive field

- [ ] Task 6: Build and run targeted tests (AC: all)
  - [ ] Run `npm run build` — zero TypeScript errors
  - [ ] Run `npm run test:changed` or `npx vitest run src/cli/commands/__tests__/status-verification-findings-counts.test.ts src/cli/commands/__tests__/metrics-verification-findings-counts.test.ts` — all tests green

## Dev Notes

### Architecture Constraints

- **No new helper function needed**: `verification_ran` is a simple presence check (`!= null && != undefined`) that can be inlined at each call site. Do NOT introduce a `rollupVerificationRan()` helper in `@substrate-ai/sdlc` — the package is published and changes there require a release cycle. Inline the boolean expression directly in status.ts and metrics.ts.
- **Import style**: Both commands already import `rollupFindingCounts` and `ZERO_FINDING_COUNTS` from `@substrate-ai/sdlc`. No new imports are needed for this story.
- **Test framework**: Vitest (`import { describe, it, expect, beforeEach } from 'vitest'`). Extend existing test files; do not create new ones.
- **Fire-and-forget callers**: `verification_ran` is read-only — no write path is changed. The manifest write serialization fix (57-1) is a separate story.

### Key File Paths

| File | Action |
|---|---|
| `src/cli/commands/status.ts` | Modify — add `verification_ran` to per-story JSON object, ~line 357 |
| `src/cli/commands/metrics.ts` | Modify — add `verification_ran` to Map + output mapping, ~lines 825 and 855 |
| `src/cli/commands/__tests__/status-verification-findings-counts.test.ts` | Extend — 3 new test cases |
| `src/cli/commands/__tests__/metrics-verification-findings-counts.test.ts` | Extend — 3 new test cases |
| `src/modules/telemetry/mesh-reporter.ts` | Modify — add `verification_ran` to per-story telemetry payload |

### Status Command Rollup Pattern (current, to extend)

```typescript
// src/cli/commands/status.ts ~line 353
const verificationResult = manifestPerStoryState?.[row.story_key]?.verification_result;
const verificationFindings = rollupFindingCounts(verificationResult);

// ADD: alongside verificationFindings in the per-story output object
const verificationRan = verificationResult !== undefined && verificationResult !== null;
```

### Metrics Command Rollup Pattern (current, to extend)

In the Map population loop that iterates `manifest.per_story_state` entries:

```typescript
// src/cli/commands/metrics.ts ~line 825
findingCountsByStoryRun.set(key, rollupFindingCounts(entry.verification_result));
// ADD a parallel map:
verificationRanByStoryRun.set(key, entry.verification_result !== undefined && entry.verification_result !== null);
```

In the output mapping (~line 855):

```typescript
verification_findings: findingCountsByStoryRun.get(key) ?? ZERO_FINDING_COUNTS,
verification_ran: verificationRanByStoryRun.get(key) ?? false,  // ADD
```

### Testing Requirements

- Extend the two existing test files — do not create new ones
- Each extended file needs at minimum three new `it()` blocks:
  1. Story with `verification_result` present → `verification_ran: true`
  2. Story with `verification_result` absent/undefined → `verification_ran: false`
  3. Absent manifest path → `verification_ran: false` (backward compat)
- Existing tests must remain green (no regression on `verification_findings` shape)
- Build must pass with zero TypeScript errors: `npm run build`

### Related Stories

- **57-1** (Serialize Manifest Writes): independent, implements write-side serialization — does not change read behavior
- **57-2** (Await Verification-Result Persist): independent, fixes orchestrator await ordering — does not change status/metrics output
- **55-3b** (Verification Findings Counts): predecessor that added `verification_findings` — this story is a direct additive follow-on

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
