# Story 55-3: Persist findings in RunManifest + inject into retry prompts

## Story

As a substrate developer,
I want verification findings to be persisted on the per-story `RunManifest` record and injected verbatim into retry-prompt context,
so that retry/rework dispatches can react to each structured issue and post-run analysis can query findings programmatically instead of parsing free-form strings.

## Context

Story 55-1 defined the `VerificationFinding` type. Story 55-2 migrated the four Tier A checks to emit findings. This story closes the consumer loop:

1. **Persist** the findings array on the per-story verification record in `RunManifest` so they survive to post-run analysis and to the `substrate status --output-format json` / `substrate metrics` readers.
2. **Inject** the findings into the retry/rework/fix prompt context so subsequent dispatch cycles see each structured issue individually, not just the worst-case status.

This directly addresses the strata-flagged gap where `NEEDS_MINOR_FIXES` surfaced "3 issues" numerically with no queryable text. After this story, the 3 issues are stored as findings, accessible via the run manifest, and re-presented to the fix agent on the next cycle.

## Acceptance Criteria

### AC1: RunManifest schema accepts findings
**Given** the `RunManifest` per-story verification record (defined in `packages/sdlc/src/run-model/`)
**When** a story's verification summary contains findings
**Then** the manifest persists `findings: VerificationFinding[]` on each per-check record within the per-story verification entry
**And** the field is optional for backward compatibility (manifests from prior substrate versions continue to read cleanly with `findings` absent or undefined)
**And** the Zod schema (or equivalent runtime validator) accepts manifests with and without findings

### AC2: Findings round-trip through manifest write/read
**Given** a `RunManifest` persisted with findings
**When** the manifest is read back via the existing read path (`readRunManifest` or equivalent)
**Then** every `VerificationFinding` field that was written is present on the read result with the same value
**And** an integration test asserts this round-trip for a manifest containing at least one finding of each severity

### AC3: Orchestrator writes findings to manifest
**Given** the implementation orchestrator running a story and completing verification
**When** the verification summary is persisted to the run manifest
**Then** the per-check `findings` arrays are copied into the manifest record, not dropped or string-flattened
**And** an existing orchestrator integration test is extended (or a new one added) that verifies a story with one failing verification check persists the finding in the manifest

### AC4: Retry prompts receive structured findings
**Given** a story that dispatched, failed verification, and enters the retry/rework/fix path
**When** the retry-prompt assembly logic (in `src/modules/implementation-orchestrator/` — the existing finding-injector pattern from Story 53-6 is the model) builds the context section for the next dispatch
**Then** the context includes a section rendering each `VerificationFinding` (category, severity, message, and — when present — `command`, `exitCode`, and stderr tail)
**And** the formatting matches the pattern established for learning-loop findings so the dev agent sees a consistent shape across verification and learning sources

### AC5: Status / metrics commands surface findings count
**Given** a run with persisted findings
**When** the operator runs `substrate status --output-format json` or reads `substrate metrics --output-format json`
**Then** the JSON output includes a per-story count of verification findings by severity (`{error: n, warn: n, info: n}`) on each story record
**And** the full finding text is NOT included in the status/metrics default output (only counts; full findings are accessed via a dedicated `--verify-details` flag or by reading the manifest directly — deferred to a follow-up if complex)

### AC6: Backward compatibility with existing manifests
**Given** a `RunManifest` file on disk produced by a substrate version prior to this story (no `findings` field)
**When** the current code reads that manifest
**Then** it loads without error
**And** accessing `verification.checks[n].findings` yields `undefined` or `[]`
**And** an explicit test covers this backward-read case

### AC7: Unit and integration tests cover the full path
**Given** the changes landed in this story
**When** `npm run test:fast` runs
**Then** new tests cover: (a) manifest schema accepts findings, (b) orchestrator copies findings into the manifest record, (c) retry-prompt assembly renders findings in the expected format, (d) backward-compatible read of findings-less manifests
**And** all existing tests remain green

## Out of Scope

- A new `substrate verify --show-findings <run-id>` CLI reader — that's a separate ergonomic story.
- Unifying `VerificationFinding` with `CodeReviewResult.issue_list` — the code-review surface is adjacent and can converge in a later epic.
- Phase 2 runtime probes — this story only plumbs the existing findings from existing checks.

## Key File Paths

### Files to Modify
- `packages/sdlc/src/run-model/run-manifest.ts` (or its schema/types file) — add optional `findings` on per-check records
- `packages/sdlc/src/run-model/schemas.ts` — extend Zod schemas
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` — wire finding persistence into the verification-complete path
- The retry/rework/fix prompt assembly site (likely in `src/modules/implementation-orchestrator/` — examine the existing Story 53-6 findings-injector pattern for the exact integration point)
- CLI readers in `src/cli/commands/status.ts` and `src/cli/commands/metrics.ts` — surface findings counts in JSON output

### Test Files to Create or Extend
- `packages/sdlc/src/run-model/__tests__/run-manifest-findings.test.ts` — schema + round-trip
- `src/modules/implementation-orchestrator/__tests__/` — orchestrator copies findings
- Retry-prompt-assembly test (extend existing)
- Backward-compat read test for findings-less manifest

## Dependencies

- Blocked by Story 55-1 (requires `VerificationFinding` type).
- Blocked by Story 55-2 (checks must be emitting findings for anything to persist).

## Verification

- `npm run build` clean.
- `npm run test:fast` clean.
- An end-to-end manifest round-trip test demonstrates findings written by an orchestrator run are read back identically.
