# Story 55-1: VerificationFinding type + backward-compat VerificationResult

## Story

As a substrate developer,
I want verification checks to emit a structured `findings` array alongside the existing `details` string,
so that downstream consumers (retry prompts, run manifest, learning loop) can reason about individual issues programmatically instead of string-parsing free-form blobs.

## Context

Today, `VerificationResult` in `packages/sdlc/src/verification/types.ts` has `{status, details, duration_ms}` where `details` is a free-form human-readable string. Every downstream consumer that wants to act on individual issues — retry-prompt assembly, post-run analysis, the strata-flagged "3 issues unqueryable" gap — has to string-parse a blob whose shape the emitting check never guaranteed. This story adds a structured `findings` field while preserving `details` for any existing consumer that reads it.

## Acceptance Criteria

### AC1: VerificationFinding type is defined
**Given** the verification types module
**When** `VerificationFinding` is imported from `packages/sdlc/src/verification/types.ts`
**Then** it is a TypeScript interface with at minimum these fields:
- `category: string` — stable machine-readable identifier (e.g. `'build-error'`, `'ac-missing-evidence'`, `'phantom-review'`, `'trivial-output'`)
- `severity: 'error' | 'warn' | 'info'`
- `message: string` — human-readable single-line summary
- `command?: string` — the command that produced this finding, if any (opaque to the type; reserved primarily for Phase 2 runtime probes)
- `exitCode?: number` — exit status of `command`, if applicable
- `stdoutTail?: string` — last ≤ 4 KiB of stdout from `command`, if captured
- `stderrTail?: string` — last ≤ 4 KiB of stderr from `command`, if captured
- `durationMs?: number` — wall-clock milliseconds the producing action took

### AC2: VerificationResult carries an optional findings array
**Given** a `VerificationResult`
**When** a check emits a result
**Then** the result may include a `findings: VerificationFinding[]` field
**And** the field is optional (backward-compatible — existing call sites that construct a result with `{status, details, duration_ms}` continue to type-check)
**And** when omitted or empty, downstream code treats it as equivalent to the current behavior (only `details` is available)

### AC3: details rendering is derivable from findings
**Given** a list of `VerificationFinding` objects
**When** `renderFindings(findings: VerificationFinding[]): string` is called from the new helper in `packages/sdlc/src/verification/findings.ts`
**Then** the returned string is a multi-line human-readable rendering (one line per finding, severity prefix, category, message)
**And** checks migrated in story 55-2 can call this helper to derive `details` from their emitted findings without duplicating formatting logic

### AC4: Empty-findings produces empty rendering
**Given** `renderFindings([])`
**When** called
**Then** it returns `''` (empty string)
**So that** checks that emit no findings produce a clean `details` string

### AC5: Type surface is re-exported from the verification index
**Given** `packages/sdlc/src/verification/index.ts`
**When** `VerificationFinding` and `renderFindings` are imported from `@substrate-ai/sdlc`
**Then** both resolve from the package's public entry point, matching the existing pattern used for `VerificationResult`, `VerificationCheck`, `VerificationPipeline`

### AC6: Unit tests cover type construction and rendering
**Given** `packages/sdlc/src/verification/__tests__/findings.test.ts`
**When** the test file runs under `npm run test:fast`
**Then** the test suite covers:
- A `VerificationFinding` can be constructed with only required fields (`category`, `severity`, `message`)
- A `VerificationFinding` can carry optional `command`, `exitCode`, `stdoutTail`, `stderrTail`, `durationMs`
- `renderFindings([])` returns `''`
- `renderFindings([oneError, oneWarn])` produces a deterministic multi-line string with severity prefixes and in input order
**And** all assertions pass

## Out of Scope

- Migrating the four existing Tier A checks to populate `findings` — that is Story 55-2.
- Persisting findings in the `RunManifest` — that is Story 55-3.
- Injecting findings into retry prompts — that is Story 55-3.
- Any `CodeReviewResult` / `issue_list` changes — the code-review surface is adjacent and separable.

## Key File Paths

### Files to Create
- `packages/sdlc/src/verification/findings.ts` — `VerificationFinding` interface + `renderFindings` helper
- `packages/sdlc/src/verification/__tests__/findings.test.ts` — unit tests for the above

### Files to Modify
- `packages/sdlc/src/verification/types.ts` — add optional `findings?: VerificationFinding[]` to `VerificationResult`; re-export `VerificationFinding`
- `packages/sdlc/src/verification/index.ts` — re-export `VerificationFinding` and `renderFindings`

## Dependencies

- None (this is the foundation story).

## Verification

- `npm run build` is clean.
- `npm run test:fast` is clean.
- No existing test needs modification (backward compatibility).
