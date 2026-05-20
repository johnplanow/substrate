---
external_state_dependencies:
  - subprocess
  - git
---

# Story 54-4: Verification Tier B — Cross-Story Consistency and Diff Validation

## Story

As a substrate developer,
I want cross-story conflict detection and diff validation to run when the run model is available,
so that stories that conflict with each other or produce broken code are caught.

## Acceptance Criteria

<!-- Source AC verbatim from epics-and-stories-phase-d-autonomous-operations.md §Story 54-4 -->

- Given completed stories with `git diff --name-only --no-renames` file sets stored in the run manifest
- When two stories modify the same file, the CrossStoryConsistencyCheck runs
- And it detects conflicting type definitions and duplicate namespace creation
- And DiffValidationCheck runs `git diff --numstat <baseline>..<story>` filtering binary files
- And diff validation only runs if BuildCheck passed (broken code diffs are misleading)
- And contract mismatches between story outputs are detected and reported

**FRs:** FR-V5, FR-V5a, FR-V6, FR-V3 (Tier B portion)

### Create-story reformulation (optional)

The source AC above is a single Given/When/And scenario. The individual clauses map to the following distinct requirements:

#### AC1: CrossStoryConsistencyCheck module
**Given** a story whose `VerificationContext` includes `priorStoryFiles` from the run model
**When** `runCrossStoryConsistencyCheck(context)` is invoked
**Then** the function returns a `VerificationResult` matching the existing check contract (`pass | warn | fail`, `details`, `duration_ms`, `findings[]`)

#### AC2: Layer 1 — file-path collision detection
**Given** a story whose `devStoryResult.files_modified` intersects with `context.priorStoryFiles`
**When** the CrossStoryConsistencyCheck runs
**Then** a `cross-story-file-collision` finding (severity: `warn`) is emitted listing the collision paths and recommending serialization

#### AC3: Layer 2 — interface and constant conflict detection
**Given** two concurrent stories that both modified the same file AND BuildCheck passed
**When** the check runs `git diff --no-renames <sha>~1 <sha>` on the collision file
**Then** if the diff contains added or removed export interface/type declarations or constant assignments, a `cross-story-concurrent-modification` finding (severity: `warn`) is emitted

#### AC4: DiffValidationCheck gated behind BuildCheck
**Given** a story where `context.buildCheckPassed === false`
**When** the CrossStoryConsistencyCheck runs
**Then** Layer 2 diff analysis is skipped entirely (broken code diffs are misleading); only Layer 1 path intersection may fire

#### AC5: Backward-compat — single-story context
**Given** a story context with no `priorStoryFiles` and no test-hook override
**When** the CrossStoryConsistencyCheck runs
**Then** it returns `pass` immediately without any `execSync` calls (Tier B check is a no-op for single-story dispatches)

#### AC6: Finding category and pipeline registration
**Given** the verification pipeline is constructed with the default check set
**When** Tier B checks are requested
**Then** `CrossStoryConsistencyCheck` is registered with `tier: 'B'` and all existing Tier A checks continue to pass unchanged (additive, backward-compatible)

#### AC7: Tests with Epic 66 + Epic 67 reproduction fixtures
**Given** the test suite in `packages/sdlc/src/__tests__/verification/cross-story-consistency-check.test.ts`
**When** tests are run via vitest
**Then** at least 6 cases pass, including canonical Epic 66 (run a832487a — `methodology-pack.test.ts` budget constant race) and Epic 67 (run a59e4c96 — same file, different concurrent story keys) reproduction fixtures

## Tasks / Subtasks

- [ ] Task 1: Extend VerificationContext with Tier B fields (AC1, AC4, AC5) — ~1h
  - [ ] Add `priorStoryFiles?: string[]` optional field (already typed as optional in types.ts)
  - [ ] Add `buildCheckPassed?: boolean` field with JSDoc: absent/undefined treated as `true` (fail-open)
  - [ ] Add `_crossStoryConflictingFiles?: string[]` test-hook override field
  - [ ] File: `packages/sdlc/src/verification/types.ts`

- [ ] Task 2: Add finding category constants (AC2, AC3) — ~30min
  - [ ] Add `CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION = 'cross-story-concurrent-modification' as const` to `packages/sdlc/src/verification/findings.ts`
  - [ ] JSDoc must cite Epic 66 (run a832487a) + Epic 67 (run a59e4c96) as motivating incidents
  - [ ] Severity: `warn` (defensive rollout per Story 60-16 pattern; do NOT promote to `error` without 3 consecutive low-false-positive runs)

- [ ] Task 3: Implement CrossStoryConsistencyCheck (AC1–AC5) — ~3h
  - [ ] New file: `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
  - [ ] Export standalone `runCrossStoryConsistencyCheck(context: VerificationContext): Promise<VerificationResult>` (consult `source-ac-shellout-check.ts` for the standalone-function + class pattern)
  - [ ] Export `CrossStoryConsistencyCheck` class implementing `VerificationCheck` with `name = 'cross-story-consistency'` and `tier = 'B' as const`
  - [ ] Export helper `computeCollisionPaths(context)` (test-hook: uses `_crossStoryConflictingFiles` override when set, otherwise computes `files_modified ∩ priorStoryFiles`)
  - [ ] Export helper `diffContainsInterfaceOrConstChange(diffText: string): boolean` (regex patterns for `export interface/type` and `const/let/var` assignment lines prefixed with `+` or `-`)
  - [ ] Layer 1: emit `cross-story-file-collision` finding when `computeCollisionPaths` is non-empty
  - [ ] Layer 2: for each collision path (skipping binary files from numstat), run `git diff --no-renames <sha>~1 <sha> -- <file>` via `execSync`; emit `cross-story-concurrent-modification` finding when `diffContainsInterfaceOrConstChange` returns true
  - [ ] Gate Layer 2 behind `context.buildCheckPassed !== false`
  - [ ] Early return `{ status: 'pass', ... }` when no Tier B context (priorStoryFiles absent and no test-hook override)
  - [ ] Header comment cites Epic 66 (a832487a) + Epic 67 (a59e4c96) per Story 60-4/60-10 convention

- [ ] Task 4: Register in verification pipeline (AC6) — ~1h
  - [ ] Barrel export in `packages/sdlc/src/verification/checks/index.ts`: `CrossStoryConsistencyCheck`, `runCrossStoryConsistencyCheck`, `computeCollisionPaths`, `diffContainsInterfaceOrConstChange`
  - [ ] Import and instantiate `CrossStoryConsistencyCheck` in `packages/sdlc/src/verification/verification-pipeline.ts`
  - [ ] Confirm check appears AFTER all Tier A checks in registration order (Tier B checks run only when Tier B context is provided)

- [ ] Task 5: Write test suite (AC7) — ~3h
  - [ ] New file: `packages/sdlc/src/__tests__/verification/cross-story-consistency-check.test.ts`
  - [ ] Framework: vitest (`describe` / `it` / `expect` — NO Jest globals); `vi.mock('child_process')` to avoid real git calls
  - [ ] Case 1 (no file overlap → pass, zero findings)
  - [ ] Case 2 (Layer 1 collision → `cross-story-file-collision` warn finding)
  - [ ] Case 3 (shared file, no interface conflict → no `cross-story-concurrent-modification` finding)
  - [ ] Case 4 (Layer 2 interface conflict → `cross-story-concurrent-modification` warn finding)
  - [ ] Case 5 (Epic 66 canonical reproduction: `methodology-pack.test.ts`, `BUDGET_LIMIT` constant from 30000 to 32000)
  - [ ] Case 6 (Epic 67 canonical reproduction: same-file concurrent modification, different story keys)
  - [ ] Case 7 (BuildCheck gate: Layer 2 skipped when `buildCheckPassed=false`; `execSync` must NOT be called)
  - [ ] Case 8 (backward-compat: single-story context with no `priorStoryFiles` → pass immediately)

## Dev Notes

### Architecture Constraints

- **Package placement**: `packages/sdlc/src/verification/` — the `VerificationContext` type references SDLC-specific fields (`storyKey`, `commitSha`, `priorStoryFiles`) making these types inappropriate for `@substrate-ai/core`
- **No LLM calls** in this check (FR-V9 mandates static analysis in default verification path)
- **Check interface**: `VerificationCheck` (from `packages/sdlc/src/verification/types.ts`): `name: string`, `tier: 'A' | 'B'`, `run(context: VerificationContext): Promise<VerificationResult>`
- **Tier B**: checks with `tier: 'B'` are only invoked when the orchestrator has multi-story run model state; they MUST return `pass` immediately with a skip note when `priorStoryFiles` is absent (single-story dispatch)
- **Reference implementation for check shape**: `packages/sdlc/src/verification/checks/source-ac-shellout-check.ts` (standalone function + class pattern); `packages/sdlc/src/verification/checks/runtime-probe-check.ts` (full VerificationContext consumption pattern)
- **Finding category registration**: new categories are declared as `export const CATEGORY_* = '...' as const` in `packages/sdlc/src/verification/findings.ts` — NOT inline in the check file
- **Commit header comment convention**: Story 60-4/60-10 requires motivating incident citations in the implementation file header, not inline in the check logic
- **TypeScript strict mode + ESM imports**: import `.js` extension for local imports; use `as const` tier assertion

### Testing Requirements

- Framework: **vitest** (`describe` / `it` / `expect` — no Jest globals)
- `vi.mock('child_process')` to stub `execSync` — avoids requiring a real git repo in CI
- Test-hook path: `_crossStoryConflictingFiles` on context bypasses intersection computation; tests use this to exercise Layer 2 detection without populating `files_modified`/`priorStoryFiles`
- Minimum 6 test cases; Epic 66 + Epic 67 reproduction fixtures are load-bearing (they document the canonical failure mode that motivated this story)
- All tests must pass `npm run test:fast` before merge

### Files Involved

- `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts` — **NEW** (primary implementation)
- `packages/sdlc/src/verification/types.ts` — extend `VerificationContext` with `buildCheckPassed?`, `_crossStoryConflictingFiles?`
- `packages/sdlc/src/verification/findings.ts` — add `CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION`
- `packages/sdlc/src/verification/checks/index.ts` — barrel export
- `packages/sdlc/src/verification/verification-pipeline.ts` — register `CrossStoryConsistencyCheck` (Tier B)
- `packages/sdlc/src/__tests__/verification/cross-story-consistency-check.test.ts` — **NEW** tests

## Runtime Probes

The check uses `execSync` to run `git diff --numstat` and `git diff --no-renames` against real commits. These git subprocess invocations are the runtime-dependent surface that unit tests mock but cannot validate against actual git behavior.

```yaml
- name: git-numstat-binary-filter-format
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO"
    git init -q
    git config user.email t@example.com && git config user.name test
    # Baseline commit: one text file + one binary file
    echo "export const X = 1" > shared.ts
    printf '\x00\x01\x02\x03' > image.png
    git add . && git commit -qm "baseline"
    # Second commit: modify both
    echo "export const X = 2" > shared.ts
    printf '\x00\x01\x02\x04' > image.png
    git add . && git commit -qm "story-commit"
    SHA=$(git rev-parse HEAD)
    # Verify numstat output shape that the implementation parses
    git diff --no-renames --numstat "${SHA}~1" "$SHA"
  expect_stdout_regex:
    - '-\t-\timage\.png'
    - '[0-9]+\t[0-9]+\tshared\.ts'
  description: >
    git numstat shows "-\t-\t<file>" for binary files and numeric stats for text files.
    The implementation parses this format to skip binary files before running per-file diffs.

- name: git-diff-const-change-parseable
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO"
    git init -q
    git config user.email t@example.com && git config user.name test
    mkdir -p packages/sdlc/src/__tests__
    # Epic 67 canonical scenario: METHODOLOGY_BUDGET constant changed concurrently
    printf 'export const METHODOLOGY_BUDGET = 30000\n' > packages/sdlc/src/__tests__/methodology-pack.test.ts
    git add . && git commit -qm "baseline"
    printf 'export const METHODOLOGY_BUDGET = 32000\n' > packages/sdlc/src/__tests__/methodology-pack.test.ts
    git add . && git commit -qm "story-67-1-budget-bump"
    SHA=$(git rev-parse HEAD)
    # Verify unified diff output that Layer 2 pattern-matches
    git diff --no-renames "${SHA}~1" "$SHA" -- packages/sdlc/src/__tests__/methodology-pack.test.ts
  expect_stdout_regex:
    - '\+export const METHODOLOGY_BUDGET = 32000'
    - '-export const METHODOLOGY_BUDGET = 30000'
  description: >
    Epic 67 reproduction: git diff output contains added/removed const lines with the
    +/- prefix that diffContainsInterfaceOrConstChange() pattern-matches. Verifies the
    real git output format matches the regex patterns in the implementation.

- name: git-diff-interface-change-parseable
  sandbox: twin
  command: |
    set -e
    REPO=$(mktemp -d)
    cd "$REPO"
    git init -q
    git config user.email t@example.com && git config user.name test
    # Create a file with an interface definition
    printf 'export interface Config {\n  budget: string\n}\n' > config.ts
    git add . && git commit -qm "baseline"
    # Change the interface shape (conflicting concurrent story scenario)
    printf 'export interface Config {\n  budget: number\n}\n' > config.ts
    git add . && git commit -qm "story-interface-change"
    SHA=$(git rev-parse HEAD)
    git diff --no-renames "${SHA}~1" "$SHA" -- config.ts
  expect_stdout_regex:
    - '\-export interface Config'
    - '\+export interface Config'
  description: >
    Verifies git diff output contains added/removed export interface lines with the
    +/- prefix. The Layer 2 INTERFACE_CHANGE_PATTERN regex relies on this format.
```

## Interface Contracts

- **Export**: `CrossStoryConsistencyCheck` @ `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
- **Export**: `runCrossStoryConsistencyCheck` @ `packages/sdlc/src/verification/checks/cross-story-consistency-check.ts`
- **Export**: `CATEGORY_CROSS_STORY_CONCURRENT_MODIFICATION` @ `packages/sdlc/src/verification/findings.ts`
- **Import**: `VerificationCheck`, `VerificationContext`, `VerificationResult` @ `packages/sdlc/src/verification/types.ts` (from story 51-1)

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-05-20 | Story created by create-story agent; source AC from Phase D planning artifact (epics-and-stories-phase-d-autonomous-operations.md §Story 54-4). Implementation was delivered via Epic 68 Story 68-1 (v0.20.59) after the original dispatch escalated due to epic-shard-discovery locating the multi-epic Phase D format. |
