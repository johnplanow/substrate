# Story 58-3: Regression E2E Fixture for Source AC Fidelity

## Story

As a pipeline maintainer,
I want an end-to-end integration test that exercises the full Epic 58 source-AC-fidelity
chain — from a raw epic fixture through `SourceAcFidelityCheck` and the default
`VerificationPipeline` — so that any regression in clause extraction, literal matching,
or pipeline projection is caught automatically before shipping.

## Acceptance Criteria

### AC1: New Test File
New test file `src/__tests__/e2e/epic-58-source-ac-fidelity-e2e.test.ts`

### AC2: Fixture Definition
Fixture: a minimal in-memory epic markdown string declaring one story with ACs containing
`MUST NOT retain legacy config`, an enumerated path `src/config/legacy.ts`, and a
`## Runtime Probes` fenced yaml block with one probe named `config-removed`

### AC3: Test 1 (Positive — All Hard Clauses Present)
Test 1 (positive): feed the epic as `sourceEpicContent` and a `storyContent` that contains
all three hard clauses verbatim; run `SourceAcFidelityCheck` → asserts `status: 'pass'`,
zero findings

### AC4: Test 2 (Negative — Softened MUST NOT)
Test 2 (negative — softened MUST NOT): feed same epic; feed a `storyContent` where
`MUST NOT retain legacy config` is rewritten as `Consider deprecating legacy config` →
asserts `status: 'fail'`, one finding with `category: 'source-ac-drift'`, severity
`error`, message mentions `MUST NOT`

### AC5: Test 3 (Negative — Missing Enumerated Path)
Test 3 (negative — missing enumerated path): `storyContent` drops the backtick-wrapped
`src/config/legacy.ts` → asserts one error finding with `source-ac-drift` mentioning
the path

### AC6: Test 4 (Negative — Dropped Runtime Probes)
Test 4 (negative — dropped Runtime Probes): `storyContent` omits the `## Runtime Probes`
heading entirely → asserts one error finding for the probes section

### AC7: Test 5 (Pipeline Integration Round-Trip)
Test 5 (integration): round-trip through `createDefaultVerificationPipeline().run()` with
a full `VerificationContext` including all the other 5 Tier A checks mocked to pass —
asserts the pipeline's aggregate status is `fail` when SourceAcFidelityCheck fails, and
the findings flow through the pipeline's projection to the final `VerificationSummary`
(no latent-Phase-1 projection bug regression)

## Tasks / Subtasks

- [ ] Task 1: Create the test file scaffold and fixtures (AC: #1, #2)
  - [ ] Create `src/__tests__/e2e/epic-58-source-ac-fidelity-e2e.test.ts` with file header and imports
  - [ ] Define `EPIC_FIXTURE` constant: minimal in-memory epic markdown with one story section containing `MUST NOT retain legacy config`, backtick-wrapped `src/config/legacy.ts`, and a `## Runtime Probes` yaml block with probe named `config-removed`
  - [ ] Define `FAITHFUL_STORY_CONTENT` helper: story content that reproduces all three hard clauses verbatim (satisfies AC3)
  - [ ] Add `beforeEach`/`afterEach` with temp-dir setup/teardown (matching epic-55/56 e2e pattern)

- [ ] Task 2: Implement Tests 1–4 (direct `SourceAcFidelityCheck.run()` unit cases) (AC: #3, #4, #5, #6)
  - [ ] Test 1 (positive): construct `VerificationContext` with `sourceEpicContent = EPIC_FIXTURE` and `storyContent = FAITHFUL_STORY_CONTENT`; call `new SourceAcFidelityCheck().run(ctx)`; assert `status === 'pass'` and `findings` length is 0
  - [ ] Test 2 (negative — softened MUST NOT): replace `MUST NOT retain legacy config` with `Consider deprecating legacy config` in storyContent; assert `status === 'fail'`, one finding with `category: 'source-ac-drift'`, `severity: 'error'`, `message` contains `'MUST NOT'`
  - [ ] Test 3 (negative — missing enumerated path): remove backtick-wrapped `src/config/legacy.ts` from storyContent; assert one error finding with `category: 'source-ac-drift'` whose message contains `src/config/legacy.ts`
  - [ ] Test 4 (negative — dropped Runtime Probes): omit `## Runtime Probes` heading from storyContent; assert one error finding with `category: 'source-ac-drift'` (probes-section clause)

- [ ] Task 3: Implement Test 5 (pipeline integration round-trip) (AC: #7)
  - [ ] Build a `VerificationContext` with `sourceEpicContent = EPIC_FIXTURE` and softened storyContent (to force SourceAcFidelityCheck to fail), plus fields to satisfy the other 5 Tier A checks: `reviewResult: { dispatchFailed: false, rawOutput: 'verdict: SHIP_IT\n' }`, `outputTokenCount: 500`, `devStoryResult` with all ACs met, `buildCommand: 'true'`
  - [ ] Call `createDefaultVerificationPipeline(createEventBus()).run(ctx, 'A')` — note: Story 58-2 registers SourceAcFidelityCheck as the 6th check, so no additional wiring needed here
  - [ ] Assert `summary.status === 'fail'`
  - [ ] Assert `summary.checks.find(c => c.checkName === 'source-ac-fidelity')?.status === 'fail'`
  - [ ] Assert that check's `findings` array is defined and has at least one entry (verifies no Phase-1 projection bug regression — findings are not dropped in the pipeline's result projection)
  - [ ] Assert each of the first 5 checks has `status === 'pass'` (confirms the failure is isolated to SourceAcFidelityCheck)

- [ ] Task 4: Verify test suite runs clean (AC: #1–#7)
  - [ ] Run `npm run test:fast` (or `npm run test:changed`) and confirm all 5 new tests pass with no regressions in the wider suite
  - [ ] Confirm "Test Files" summary line appears in output (do not pipe output; do not run concurrently with other vitest instances)

## Dev Notes

### Dependency on Story 58-2
This story depends on Story 58-2 having shipped the following before implementation begins:
- `SourceAcFidelityCheck` class exported from `@substrate-ai/sdlc`
- `VerificationContext.sourceEpicContent?: string | undefined` field present in the type
- `SourceAcFidelityCheck` registered as the 6th Tier A check in `createDefaultVerificationPipeline`

Story 58-2's check is registered with `name === 'source-ac-fidelity'` (verify against the actual implementation before writing the assertion in Task 3).

### File Location
- **New test file**: `src/__tests__/e2e/epic-58-source-ac-fidelity-e2e.test.ts`
- No other files are created or modified by this story.

### Import Pattern
Follow the same import pattern as `epic-56-runtime-probes-e2e.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

import { createDefaultVerificationPipeline, SourceAcFidelityCheck } from '@substrate-ai/sdlc'
import type { VerificationContext } from '@substrate-ai/sdlc'
import { createEventBus } from '@substrate-ai/core'
```

(Adjust the `SourceAcFidelityCheck` import name to match what Story 58-2 actually exports.)

### Fixture Design — EPIC_FIXTURE
The epic fixture must contain the three hard-clause types SourceAcFidelityCheck extracts:
1. A line with `MUST NOT retain legacy config` (keyword clause)
2. A backtick-wrapped path `` `src/config/legacy.ts` `` (enumerated path clause)
3. A `## Runtime Probes` heading followed by a fenced `yaml` block with a probe named `config-removed` (probes-section clause)

Example fixture shape:

```
### Story 58-e2e: Legacy Config Removal

The implementation MUST NOT retain legacy config.
The file `src/config/legacy.ts` SHALL be deleted.

## Runtime Probes

\`\`\`yaml
- name: config-removed
  sandbox: host
  command: test ! -f src/config/legacy.ts
\`\`\`
```

### FAITHFUL_STORY_CONTENT Design
The faithful story content used for the positive test (AC3/Test 1) must contain all three hard clauses **exactly as they appear in the fixture** (literal substrings). A minimal form:

```markdown
## Acceptance Criteria

### AC1: No legacy config

MUST NOT retain legacy config. The `src/config/legacy.ts` file must be removed.

## Runtime Probes

\`\`\`yaml
- name: config-removed
  sandbox: host
  command: test ! -f src/config/legacy.ts
\`\`\`
```

### Pipeline Integration Test Pattern
Follow `epic-56-runtime-probes-e2e.test.ts` for the `createDefaultVerificationPipeline` call:

```typescript
const bus = createEventBus()
const pipeline = createDefaultVerificationPipeline(bus)
const summary = await pipeline.run(ctx, 'A')
```

For the integration test (AC7/Test 5), set `buildCommand: 'true'` so BuildCheck exits 0 without touching the actual project build, just as the Epic 56 e2e does.

### Temp Directory Usage
Tests 1–4 construct a `VerificationContext` with `workingDir: process.cwd()` or a temp dir — SourceAcFidelityCheck does not shell out or read from disk, so any valid path works. The temp dir setup/teardown (beforeEach/afterEach) is present but not strictly required for Tests 1–4; it is there for symmetry with the other e2e tests and for future extensions.

### Testing Requirements
- Framework: `vitest` — follow the exact import style above (no `jest` globals)
- Never run tests concurrently with other vitest instances (`pgrep -f vitest` must return nothing before running)
- Use `npm run test:fast` during iteration; `npm test` for final validation
- Timeout: pass `timeout: 300000` when invoking tests via Bash (startup overhead)
- Do NOT pipe test output through `head`, `tail`, or `grep` — this discards the vitest summary line
- Confirm results by checking for "Test Files" in the output

### Architecture Constraints
- No mocking of `SourceAcFidelityCheck` itself in Tests 1–4 — call `.run()` directly against the real implementation
- For Test 5 (integration): do NOT mock `SourceAcFidelityCheck`; instead supply a `storyContent` that causes it to fail naturally, while supplying fields that make the other 5 checks pass. This validates the entire pipeline projection path end-to-end without test doubles on the check under test
- No LLM calls anywhere in this test file
- No shell invocations beyond `buildCommand: 'true'` in Test 5 (SourceAcFidelityCheck is pure static analysis)

## Interface Contracts

- **Import**: `SourceAcFidelityCheck` @ `packages/sdlc/src/verification/source-ac-fidelity-check.ts` (from story 58-2)
- **Import**: `VerificationContext` with `sourceEpicContent?: string` field @ `packages/sdlc/src/verification/types.ts` (extended by story 58-2)
- **Import**: `createDefaultVerificationPipeline` (6-check variant) @ `packages/sdlc/src/verification/verification-pipeline.ts` (extended by story 58-2)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
