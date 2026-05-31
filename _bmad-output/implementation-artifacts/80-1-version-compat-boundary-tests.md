# Story 80-1: Add boundary-condition tests for `checkAdapterVersionCompat`

## Story

As substrate's adapter-quality maintainer,
I want explicit boundary-condition tests for `checkAdapterVersionCompat` (the v0.20.138 helper that surfaces CLI version drift),
so that the helper's behavior at the edges of the tested range — exact-match bounds and degenerate-range inputs — is locked in by test, not just by reading the code.

This story exists primarily as the substrate-on-substrate end-to-end smoke validating v0.20.138: it exercises agent derivation, the Claude Code adapter post-`--max-turns`-removal, Dolt pipeline_runs status finalization on the success path (v0.20.132 F1), worktree lifecycle, and `substrate report` verdict (v0.20.131). The test additions themselves are also genuinely useful coverage.

## Acceptance Criteria

1. New test case in `packages/core/src/adapters/__tests__/version-compat.test.ts`: asserts that when `actualVersion === tested.min`, the helper returns `{ compatible: true }` (the lower bound is INCLUSIVE). The test name should make the inclusivity contract explicit.
2. New test case in the same file: asserts that when `actualVersion === tested.max`, the helper returns `{ compatible: true }` (the upper bound is INCLUSIVE). The test name should make the inclusivity contract explicit.
3. New test case in the same file: asserts that when `tested.min === tested.max` and `actualVersion` equals both, the helper returns `{ compatible: true }` (degenerate single-version range is supported — useful when an adapter has only verified against exactly one CLI version, as Codex's `TESTED_CLI_VERSION_RANGE` currently does).
4. All 3 new tests pass; the existing 8 tests in `version-compat.test.ts` continue to pass (regression-safe).
5. The new tests follow the existing file's style: `describe('checkAdapterVersionCompat', ...)` block, `it(...)` cases with short descriptive names, `expect(...)` assertions matching the existing pattern.

## Tasks / Subtasks

- [ ] **Task 1 — Read the existing test file** to understand the style and the `RANGE` fixture pattern (AC 5).
- [ ] **Task 2 — Add the three boundary tests** in the order: exact-min, exact-max, degenerate-range (ACs 1, 2, 3).
- [ ] **Task 3 — Run the tests** with `npx vitest run packages/core/src/adapters/__tests__/version-compat.test.ts` to confirm all 11 pass (AC 4).
- [ ] **Task 4 — Verify the broader adapter test suite** is unaffected: `npx vitest run packages/core/src/adapters/__tests__/ test/adapters/`.

## Dev Notes

- The helper under test lives at `packages/core/src/adapters/version-compat.ts`. It uses semver's `compare` for bound checks; `compare(a, b) < 0` means a is strictly less than b, so equality is treated as in-range. The boundary tests lock that contract in.
- No source changes are expected — this story is test-only.
- No new dependencies, no schema changes, no behavior changes to substrate dispatch.
