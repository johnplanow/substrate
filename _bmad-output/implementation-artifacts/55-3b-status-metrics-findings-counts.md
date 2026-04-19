# Story 55-3b: Surface verification finding counts in status/metrics CLI JSON

## Story

As a substrate operator,
I want `substrate status --output-format json` and `substrate metrics --output-format json` to report per-story counts of verification findings grouped by severity,
so that I can see at a glance how many errors/warnings/info findings each story produced without having to parse a run manifest or retry prompt.

## Context

Closes the AC5 acceptance criterion that was explicitly deferred out of
Story 55-3. Story 55-3 landed the persistence surface (findings are
stored on `RunManifest` per-check records) but the CLI readers in
`src/cli/commands/status.ts` and `src/cli/commands/metrics.ts` were not
extended to surface them. That decision was deliberate — 55-3 shipped
the retry-prompt consumer which was the load-bearing path — but a
colleague querying JSON today can't tell that story 1-4 had 3 findings
without reading the manifest directly.

This story does not add any new findings or change any check behavior.
It is pure ergonomic surfacing over data that already round-trips.

## Acceptance Criteria

### AC1: Status JSON includes finding counts per story
**Given** a substrate run that completed with at least one story
carrying `verification_result.checks[n].findings` in the run manifest
**When** the operator runs `substrate status --output-format json`
**Then** each story record in the JSON output includes a
`verification_findings: { error: number, warn: number, info: number }`
field summing findings across all checks for that story
**And** when a story has no findings on any check, the field is
`{ error: 0, warn: 0, info: 0 }` (not omitted — consumers should not
have to test for presence)

### AC2: Metrics JSON includes the same per-story counts
**Given** the same manifest state
**When** the operator runs `substrate metrics --output-format json`
**Then** the per-story summary JSON includes the same
`verification_findings` field with the same shape as AC1
**And** the field is populated for every story the metrics command
surfaces, matching the existing coverage of other per-story fields

### AC3: Backward-read — absent findings field treated as zero counts
**Given** a manifest entry where `verification_result` exists but one or
more checks lack a `findings` field (i.e., a manifest written before
Story 55-2 migrated the checks, or by a check that never emits findings)
**When** status or metrics JSON is rendered
**Then** that check contributes `0` to each severity count — no error,
no warn, no placeholder
**So that** upgrades do not spuriously mark old runs as "broken"

### AC4: Default human-readable output remains unchanged
**Given** an operator running `substrate status` or `substrate metrics`
without `--output-format json`
**When** the command renders
**Then** the human-readable output is unchanged — no finding counts are
printed in the default view
**So that** this story is purely additive on the JSON surface

### AC5: Full finding text is NOT included in these JSON surfaces
**Given** a story with non-trivial findings
**When** `substrate status --output-format json` is rendered
**Then** the JSON contains ONLY counts — not the finding messages,
commands, stdout tails, or stderr tails themselves
**So that** status payloads stay small and the sensitive command/stderr
content remains accessible only via direct manifest reads or a
dedicated `--verify-details` flag (which is a separate follow-up story)

### AC6: Unit + integration tests cover the new surface
**Given** the changes landed
**When** `npm run test:fast` runs
**Then** new tests cover:
  - status command emits `verification_findings` field with correct counts
  - metrics command emits it with the same shape
  - absent-findings manifests yield zero counts cleanly
  - human-readable (non-JSON) output is unchanged

## Out of Scope

- `--verify-details` flag to dump full finding text via CLI. Separate follow-up.
- Filtering / sorting stories by finding count.
- Rendering findings in the TUI (frozen per pre-existing decision).
- Any new finding categories, or changes to existing checks.

## Key File Paths

### Files to Modify
- `src/cli/commands/status.ts` — add finding-count roll-up to JSON output
- `src/cli/commands/metrics.ts` — add same field to per-story JSON records
- Small helper likely warranted — consider
  `src/cli/commands/_verification-findings-summary.ts` or a util under
  `packages/sdlc/src/run-model/` that rolls findings into counts, so
  both CLI readers share one implementation

### Test Files to Create or Extend
- `src/cli/commands/__tests__/status-verification-findings.test.ts`
- `src/cli/commands/__tests__/metrics-verification-findings.test.ts`
- Backward-compat test exercising a manifest fixture with findings
  omitted on some checks

## Dependencies

- Blocked by Story 55-3 (findings must be persisted on the manifest
  before they can be rolled up) — satisfied as of v0.20.4.

## Verification

- `npm run build` clean
- `npm run check:circular` clean
- `npm run typecheck:gate` clean
- `npm run test:fast` clean
- `substrate status --output-format json` over a run with findings shows
  non-zero counts; over a clean run shows zero counts on every story
