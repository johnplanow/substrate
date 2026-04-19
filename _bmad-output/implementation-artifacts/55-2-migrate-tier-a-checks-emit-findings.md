# Story 55-2: Migrate Tier A checks to emit structured findings

## Story

As a substrate developer,
I want the four existing Tier A verification checks to populate the new `findings` array whenever they detect an issue,
so that downstream consumers (to be built in Story 55-3) receive structured data and not just a rendered string.

## Context

Story 55-1 introduces the `VerificationFinding` type and the optional `findings` field on `VerificationResult`. This story migrates the four existing Tier A checks — `PhantomReviewCheck`, `TrivialOutputCheck`, `AcceptanceCriteriaEvidenceCheck`, `BuildCheck` — to emit structured findings whenever they produce a `warn` or `fail` status. Checks that produce `pass` continue to emit `findings: []` (or omit the field).

The migration is deliberately conservative: each check produces one finding per distinct issue it already detects. No new detection logic is added. The `details` string remains equivalent — it is now derived from the findings via `renderFindings` (Story 55-1) instead of constructed ad hoc, which should produce byte-identical output for most cases. Existing test assertions on `details` may need minor tolerance updates if formatting shifts trivially; any such change must be preserved as a deliberate fix to the rendering, not masked.

## Acceptance Criteria

### AC1: PhantomReviewCheck emits findings on fail and warn
**Given** a code-review dispatch that failed (dispatchFailed=true) or produced no output
**When** `PhantomReviewCheck.run(context)` executes against that signal
**Then** the returned `VerificationResult` has `status: 'fail'` (or `'warn'` for skip conditions) AND `findings.length >= 1`
**And** the finding has `category: 'phantom-review'`, `severity: 'error'` for fail / `'warn'` for warn
**And** the finding's `message` is a single-line summary equivalent to the text that was previously written directly to `details`
**And** when the code-review dispatch is valid (review output is well-formed), the result is `status: 'pass'` with `findings: []` or undefined

### AC2: TrivialOutputCheck emits findings when below threshold
**Given** a story dispatch whose `outputTokenCount` is below the configured threshold
**When** `TrivialOutputCheck.run(context)` executes
**Then** the returned result has `status: 'fail'` AND exactly one finding with `category: 'trivial-output'`, `severity: 'error'`, and a `message` naming the observed token count and the threshold
**And** when `outputTokenCount` is above the threshold, result is `status: 'pass'` with no findings

### AC3: AcceptanceCriteriaEvidenceCheck emits one finding per missing AC
**Given** a story whose dev-story output claims fewer ACs than the story markdown declares (or claims failures)
**When** `AcceptanceCriteriaEvidenceCheck.run(context)` executes
**Then** each missing or failing AC produces its own `VerificationFinding`
**And** each finding has `category: 'ac-missing-evidence'` (for missing) or `'ac-explicit-failure'` (for claimed failures), `severity: 'error'`, and a `message` naming the specific AC identifier
**And** when all ACs are covered, result is `status: 'pass'` with no findings

### AC4: BuildCheck emits findings with compiler output
**Given** a story whose build command returns non-zero
**When** `BuildCheck.run(context)` executes
**Then** the returned result has `status: 'fail'` AND at least one finding with `category: 'build-error'`, `severity: 'error'`, and a populated `command` (the build command), `exitCode`, and `stderrTail` (last ≤ 4 KiB of build stderr)
**And** `durationMs` on the finding matches the build's wall-clock time
**And** when the build passes, result is `status: 'pass'` with no findings

### AC5: details continues to reflect findings content
**Given** any of the four migrated checks emitting at least one finding
**When** the check returns a `VerificationResult`
**Then** `result.details` is equal to `renderFindings(result.findings)` (from Story 55-1)
**So that** existing consumers reading only `details` receive equivalent information

### AC6: Existing unit tests remain green
**Given** the existing test suites under `packages/sdlc/src/verification/__tests__/` and `packages/sdlc/src/__tests__/verification/`
**When** `npm run test:fast` runs
**Then** every existing assertion on check behavior (status, details substrings, duration) continues to pass
**And** any test whose `details` string comparison is tightened or loosened by the rendering migration is updated in the same commit with a clear code comment explaining the change

### AC7: New unit tests assert structured findings per check
**Given** one new or extended unit test per check
**When** the test exercises a failing scenario
**Then** it asserts the presence and shape of the expected `VerificationFinding` (category, severity, message substring, and — for BuildCheck — `command`/`exitCode`/`stderrTail` presence)

## Out of Scope

- Adding new detection logic to any check (migration is conservative — same detections, structured output).
- Persisting findings in `RunManifest` (Story 55-3).
- Surfacing findings in retry prompts (Story 55-3).
- Changes to `CodeReviewResult.issue_list`.
- Changes to `VerificationPipeline.run()` or the check interface — just the check implementations.

## Key File Paths

### Files to Modify
- `packages/sdlc/src/verification/checks/phantom-review-check.ts`
- `packages/sdlc/src/verification/checks/trivial-output-check.ts`
- `packages/sdlc/src/verification/checks/acceptance-criteria-evidence-check.ts`
- `packages/sdlc/src/verification/checks/build-check.ts`

### Test Files to Modify or Create
- `packages/sdlc/src/verification/__tests__/phantom-review-check.test.ts` (extend)
- `packages/sdlc/src/verification/__tests__/trivial-output-check.test.ts` (extend)
- `packages/sdlc/src/__tests__/verification/acceptance-criteria-evidence-check.test.ts` (extend)
- `packages/sdlc/src/__tests__/verification/build-check.test.ts` (extend)

## Dependencies

- Blocked by Story 55-1 (requires `VerificationFinding` type and `renderFindings` helper).

## Verification

- `npm run build` is clean.
- `npm run test:fast` is clean.
- No regression in status/details/duration contracts of the four checks.
