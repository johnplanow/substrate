# Story 66-7: new `runtime-probe-placeholder-not-substituted` finding category

## Story

As a platform operator,
I want placeholder-class probe failures to emit a distinct `runtime-probe-placeholder-not-substituted` finding category,
so that operators and probe-author quality dashboards can carve placeholder substitution failures out from genuine runtime failures for cleaner triage and metrics.

## Acceptance Criteria

<!-- source-ac-hash: a2fb9298ca33316dafafc6b13e8200feeac68ba83802dce5e052b2e0fd175827 -->

### AC1: New finding category constant
New finding category `runtime-probe-placeholder-not-substituted` added alongside existing categories (`runtime-probe-fail`, `runtime-probe-error-response`, `runtime-probe-missing-production-trigger`, `runtime-probe-missing-declared-probes`) in `packages/sdlc/src/verification/checks/runtime-probe-check.ts`.

### AC2: Severity
Severity: `error` (matches `runtime-probe-fail` baseline).

### AC3: Detection rule
Detection rule: when probe exits non-zero AND stderr/stdout matches `/^[\w]*:\s*<[A-Z_]+>:?/` (placeholder leakage pattern) OR contains `Syntax error: "&&" unexpected` immediately after a `<` literal token.

### AC4: Hint field on finding
Finding includes a hint field: `unrecognizedPlaceholder: string` (the token that escaped substitution, e.g. `<UNKNOWN_VAR>`). This requires adding `unrecognizedPlaceholder?: string` to the `VerificationFinding` interface in `packages/sdlc/src/verification/findings.ts`.

### AC5: Tests
Tests: unit tests asserting category fires for representative stderr patterns (grep-no-such-file with placeholder, syntax-error with placeholder); does NOT fire for genuine runtime failures (assertion failures, exit-1 from real grep, syntax errors with no placeholder).

### AC6: Backward-compat
Backward-compat: probes that fail with non-placeholder patterns still emit `runtime-probe-fail` per existing semantics.

### AC7: Commit message
Commit message references obs_2026-05-04_024 fix #3.

## Tasks / Subtasks

- [ ] Task 1: Add `unrecognizedPlaceholder?: string` hint field to `VerificationFinding` (AC: #4)
  - [ ] Open `packages/sdlc/src/verification/findings.ts`
  - [ ] Add optional field `unrecognizedPlaceholder?: string` to the `VerificationFinding` interface, with a JSDoc comment explaining it carries the escaped token (e.g. `<UNKNOWN_VAR>`) for `runtime-probe-placeholder-not-substituted` findings

- [ ] Task 2: Add category constant and detection helper to `runtime-probe-check.ts` (AC: #1, #3)
  - [ ] Add `CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED = 'runtime-probe-placeholder-not-substituted'` alongside existing `CATEGORY_*` constants
  - [ ] Implement `detectPlaceholderLeakage(output: string): string | null` — returns the captured `<TOKEN>` string if the placeholder leakage pattern fires, `null` otherwise
    - Pattern 1: match `/^[\w]*:\s*(<[A-Z_]+>):?/m` against `output`; return captured group if matched
    - Pattern 2: check if `output` contains `Syntax error: "&&" unexpected` AND a `<[A-Z_]+>` token anywhere in `output`; if so, capture and return that token
  - [ ] Export the helper (mirrors the export pattern of `detectNegationContextLines`, `detectDependencyContextLines`, `detectsEventDrivenAC`)

- [ ] Task 3: Wire detection into probe execution path (AC: #1, #2, #3, #4, #6)
  - [ ] In the per-probe execution branch, after confirming non-zero exit and BEFORE the fallback `CATEGORY_FAIL` emit:
    - Combine `stderrTail` and `stdoutTail` into `outputForDetection`
    - Call `detectPlaceholderLeakage(outputForDetection)`
    - If a token is returned, emit a finding with `category: CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED`, `severity: 'error'`, `unrecognizedPlaceholder: <token>`, and the standard probe fields (`command`, `exitCode`, `stdoutTail`, `stderrTail`, `durationMs`, `_authoredBy`)
    - If no token matched, fall through to the existing `CATEGORY_FAIL` emit (backward-compat)
  - [ ] Ensure `CATEGORY_ERROR_RESPONSE` is still checked BEFORE `CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED` (error-response takes priority since exit-0 cases are already handled; placeholder detection only applies in the exit-non-zero path)

- [ ] Task 4: Write unit tests (AC: #5, #6)
  - [ ] Add tests to `packages/sdlc/src/__tests__/verification/runtime-probe-check.test.ts`
  - [ ] **Fires** cases:
    - `grep: <REPO_ROOT>: No such file or directory` in stderr → category `runtime-probe-placeholder-not-substituted`, severity `error`, `unrecognizedPlaceholder: '<REPO_ROOT>'`
    - `bash: <CONFIG_DIR>: No such file or directory` in stderr → fires with `unrecognizedPlaceholder: '<CONFIG_DIR>'`
    - `Syntax error: "&&" unexpected` in stderr WITH `<UNKNOWN_VAR>` elsewhere in combined output → fires with `unrecognizedPlaceholder: '<UNKNOWN_VAR>'`
  - [ ] **Does NOT fire** cases (must emit `runtime-probe-fail` instead):
    - `grep: /actual/path: No such file or directory` (no placeholder token) → category `runtime-probe-fail`
    - `AssertionError: expected 0 to equal 1` (assertion failure, no placeholder) → not `runtime-probe-placeholder-not-substituted`
    - `Syntax error: "&&" unexpected` with no `<X>` token in output → NOT fired; emits `runtime-probe-fail`
  - [ ] Verify `detectPlaceholderLeakage` is exported and testable in isolation (unit tests on the helper directly)

- [ ] Task 5: Run tests and verify (AC: all)
  - [ ] `npm run test:fast` — confirm all new tests pass and no regressions
  - [ ] Commit message: "feat: add runtime-probe-placeholder-not-substituted finding category — obs_2026-05-04_024 fix #3"

## Dev Notes

### Architecture Constraints

- **File to modify**: `packages/sdlc/src/verification/checks/runtime-probe-check.ts` — add `CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED`, `detectPlaceholderLeakage()`, and wire into execution path
- **File to modify**: `packages/sdlc/src/verification/findings.ts` — add `unrecognizedPlaceholder?: string` to `VerificationFinding`
- **Test file**: `packages/sdlc/src/__tests__/verification/runtime-probe-check.test.ts`
- **Import style**: no new imports needed; regex literals are inline constants; `detectPlaceholderLeakage` is a module-level exported function mirroring the existing `detectNegationContextLines` / `detectDependencyContextLines` export pattern

### Detection logic details

The `detectPlaceholderLeakage` helper must handle two shapes:

**Shape 1 — command-line tool "no such file" with placeholder argument:**
```
grep: <REPO_ROOT>: No such file or directory
bash: <CONFIG_DIR>: command not found
```
Regex (multiline): `/^[\w]*:\s*(<[A-Z_]+>):?/m`
Return the first capture group `(<[A-Z_]+>)`.

**Shape 2 — shell syntax error adjacent to placeholder token:**
```
Syntax error: "&&" unexpected
...and separately the combined output contains <UNKNOWN_VAR>
```
Heuristic: `output.includes('Syntax error: "&&" unexpected')` AND `/(<[A-Z_]+>)/.test(output)` — when both are true, return the placeholder token from the second match.

In both shapes the helper returns `null` when no placeholder is detected, allowing the existing `CATEGORY_FAIL` path to proceed unmodified.

### Execution order in runtime-probe-check

The existing per-probe failure path for `sandbox: host` non-zero exit is:
1. `outcome === 'timeout'` → emit `CATEGORY_TIMEOUT`
2. `assertionFailures` defined → emit `CATEGORY_ASSERTION_FAIL` (exit-0 path; won't conflict)
3. `errorShapeIndicators` defined → emit `CATEGORY_ERROR_RESPONSE` (exit-0 path; won't conflict)
4. (fallthrough) → emit `CATEGORY_FAIL`

The new detection sits at step 4, BEFORE the existing `CATEGORY_FAIL` emit:
4a. `detectPlaceholderLeakage(stderrTail + '\n' + stdoutTail)` → if token found, emit `CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED`; return
4b. (fallthrough) → emit `CATEGORY_FAIL`

This is correct: steps 2 and 3 apply to exit-0 cases, so they cannot conflict with placeholder detection (which requires non-zero exit).

### Finding shape

```typescript
{
  category: CATEGORY_PLACEHOLDER_NOT_SUBSTITUTED,  // 'runtime-probe-placeholder-not-substituted'
  severity: 'error',
  message: `Probe failed: unrecognized placeholder token "${token}" was not substituted before execution`,
  command: probe.command,
  exitCode: result.exitCode,
  stdoutTail: result.stdoutTail,
  stderrTail: result.stderrTail,
  durationMs: result.durationMs,
  unrecognizedPlaceholder: token,   // new hint field
  _authoredBy: probe._authoredBy,  // preserve attribution
}
```

### Testing Requirements

- Use the existing `RuntimeProbeCheck` test harness pattern: inject a fake `host` executor that returns synthetic `ProbeResult` with `outcome: 'fail'`, `exitCode: 1`, and the desired `stderrTail`/`stdoutTail`
- Also test `detectPlaceholderLeakage` directly as a unit (export it)
- Run `npm run test:fast` (not `npm test` — the full suite is ~140s)
- Confirm test count increment in the test summary line

### Backward-compatibility guarantee

No existing `runtime-probe-fail` tests should change behavior. The placeholder detection path is additive: if `detectPlaceholderLeakage` returns `null`, the fallthrough to `CATEGORY_FAIL` is unchanged. The only change to the `VerificationFinding` interface is adding an optional field — all existing consumers are unaffected.

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log
