---
external_state_dependencies:
  - filesystem
  - database
---

# Story 71-1: substrate report CLI command

## Story

As an operator,
I want a `substrate report` command that reads the run manifest and produces a structured completion report,
so that I can quickly understand the outcome of a pipeline run — including per-story outcome classifications, cost vs ceiling, verification findings, and escalation diagnostics — without manually parsing raw manifest or Dolt tables.

## Acceptance Criteria

<!-- source-ac-hash: dc5f45105e9406e929a1832410f3f81b586fe52e09bd93e99bf008b2464b509d -->

1. New command file `src/cli/commands/report.ts` exporting
   `registerReportCommand(program, version, projectRoot, registry)`
   matching the existing CLI registration shape (consult
   `reconcile-from-disk.ts` from Epic 69 for the contract).

2. Command shape: `substrate report [--run <id|latest>]
   [--output-format <human|json>]`. `--run` defaults to most recent
   run from `.substrate/runs/manifest.json`. When no runs exist, exit
   1 with friendly error.

3. **Outcome classification**: each story classified as one of
   `verified | recovered | escalated | failed` per the rules above.
   Logic isolated in pure helper `classifyStoryOutcome(story,
   manifest)` so it's unit-testable independent of CLI plumbing.

   Rules:
   - `verified` — status='complete' AND verification_ran=true AND no error-severity findings
   - `recovered` — status='complete' AND verification_ran=false (Path A reconciled) OR verification_ran=true AND review_cycles>0
   - `escalated` — status='escalated'
   - `failed` — status='failed' (rare; orchestrator-side)

4. **Diagnostic enrichment**: escalated stories enriched with
   `root_cause`, `recovery_attempts`, `suggested_operator_action`,
   `blast_radius`. Suggested-action heuristic mapping for at least
   these escalation reasons: `checkpoint-retry-timeout`,
   `verification-fail-after-cycles`, `dispatch:spawnsync-timeout`,
   `cost-ceiling-exceeded`, `unknown`.

   - For checkpoint-retry-timeout: suggested_action="Run `substrate
     reconcile-from-disk --run <id>` (Epic 69) — implementation may have
     shipped before timeout; gates will validate."
   - For verification-fail-after-cycles: suggested_action="Read findings
     via `substrate metrics --run <id> --findings`; consider --max-review-cycles
     3 retry."

5. **Human rendering**: banner with run-id + duration + cost +
   ceiling status + verdict; story count summary line
   (`X verified, Y recovered, Z escalated, W failed of N total`);
   per-story table (story_key | outcome | wall-clock | review-cycles |
   cost | findings | verified-tag); for each escalated, a detail block
   (root_cause, recovery_attempts, suggested_action, blast_radius).
   Table aligned (use a small helper, no need for a heavy library).
   Color (chalk) optional but consistent with other commands.

6. **JSON rendering**: structured output. Top-level keys: `runId`,
   `summary`, `stories`, `escalations`, `cost`, `duration`. JSDoc
   types exported alongside command for downstream Epic 73 consumption.

7. **`--run latest`**: explicit sugar for "most recent run" — same
   resolution as omitting `--run`. Both forms must produce identical
   output.

8. **Cost vs ceiling**: surface manifest's `cost.ceiling` (if set)
   and `cost.spent`; report cost utilization percentage and "OVER
   CEILING" tag if exceeded.

9. **Verification findings surfaces**: per-story
   `verification_findings: { error: N, warn: N, info: N, byAuthor:
   {...} }` shown in the table's findings column as `E:0 W:1 I:2`
   format; full breakdown available in JSON output under
   `stories[].verification_findings`.

10. **Tests** at `src/__tests__/cli/report.test.ts` (≥6 cases):
    (a) classification — verified/recovered/escalated/failed
    edge cases, (b) `--run latest` resolves correctly, (c) human
    output stable for golden-master fixture, (d) JSON output
    well-formed for golden-master fixture, (e) escalation diagnostic
    enrichment for checkpoint-retry-timeout, (f) escalation
    diagnostic for unknown reason (graceful fallback), (g) no-runs-
    exist friendly error.

11. **Integration test** at `__tests__/integration/report.test.ts`
    (≥1 case): real fixture run manifest with mixed outcomes
    (verified + recovered + escalated), invokes `substrate report
    --run <fixture-id>` and asserts output shape.

12. **Header comment** in implementation file cites Phase D Story
    54-5 (original 2026-04-05 spec) + Epic 69 Story 69-1 (Path A
    primitive that produces "recovered" outcomes this report classifies)
    + that Recovery Engine (Epic 73) will programmatically consume
    this command's JSON output.

13. **Commit message** references Phase D 54-5 extraction + Stream
    A+B sprint plan + that Epic 71 is independent and additive
    (zero gate changes, zero orchestrator changes).

14. **No package additions**: implementation must use existing deps
    (manifest reader from Story 52-3+, Dolt client from existing
    DoltClient, no new chalk/cli-table dependencies — keep small).

## Tasks / Subtasks

- [ ] Task 1: Scaffold `src/cli/commands/report.ts` with header comment + `registerReportCommand` Commander subcommand (AC1, AC12, AC13)
  - [ ] Add header comment citing Phase D 54-5, Epic 69 69-1, Epic 73
  - [ ] Export `registerReportCommand(program, version, projectRoot, registry)` matching reconcile-from-disk contract
  - [ ] Wire `--run <id|latest>` and `--output-format <human|json>` flags with correct defaults
  - [ ] Exit 1 with friendly error when no runs exist (AC2)

- [ ] Task 2: Implement run-id resolution + data assembly phase (AC2, AC7, AC8)
  - [ ] Resolve `--run latest` and bare default identically via manifest reader (`resolveRunManifest`) (AC7)
  - [ ] Load run manifest: stories, phases, token totals, cost, started_at, completed_at from `per_story_state`
  - [ ] Query Dolt `wg_stories` for status + completed_at per story (with graceful Dolt-absent fallback)
  - [ ] Extract per-story metrics: wall_clock_ms, tokens, review_cycles, dispatches, verification_findings, verification_ran
  - [ ] Surface `cost.ceiling` vs `cost.spent`; compute utilization %; set OVER CEILING flag if exceeded (AC8)

- [ ] Task 3: Implement pure `classifyStoryOutcome` helper + diagnostic enrichment (AC3, AC4)
  - [ ] Isolate classification in exported `classifyStoryOutcome(story, manifest): 'verified'|'recovered'|'escalated'|'failed'` with no CLI dependencies
  - [ ] Implement the four outcome rules verbatim (verified: complete+verification_ran+no-error-findings; recovered: complete with verification_ran=false OR review_cycles>0; escalated; failed)
  - [ ] Implement `enrichEscalation(story, runId)` mapping root_cause from escalation reason string to `recovery_attempts`, `suggested_operator_action`, `blast_radius`
  - [ ] Cover all five heuristic reasons: `checkpoint-retry-timeout`, `verification-fail-after-cycles`, `dispatch:spawnsync-timeout`, `cost-ceiling-exceeded`, `unknown` (graceful fallback)

- [ ] Task 4: Implement human-format renderer (AC5, AC9)
  - [ ] Banner: run-id, duration (started_at → completed_at), cost, ceiling status, overall verdict
  - [ ] Summary line: `X verified, Y recovered, Z escalated, W failed of N total`
  - [ ] Per-story table with columns: story_key (truncate to 50 chars) | outcome | wall-clock | review-cycles | cost | findings | verified-tag
  - [ ] Findings column: format as `E:N W:N I:N` from `verification_findings.error/warn/info` (AC9)
  - [ ] Small table-alignment helper (pad columns, no heavy library dependency — AC14)
  - [ ] Per-escalation detail block: root_cause, recovery_attempts, suggested_action, blast_radius

- [ ] Task 5: Implement JSON-format renderer + exported JSDoc types (AC6)
  - [ ] Structured output with top-level keys: `runId`, `summary`, `stories`, `escalations`, `cost`, `duration`
  - [ ] Export JSDoc-documented TypeScript interfaces `ReportOutput`, `StorySummary`, `EscalationDetail`, `ReportCost`, `ReportDuration` alongside command for Epic 73 downstream consumption
  - [ ] `stories[].verification_findings` full breakdown in JSON output

- [ ] Task 6: Register command in `src/cli/index.ts` + write tests (AC1, AC10, AC11)
  - [ ] Add `registerReportCommand` import and call in `src/cli/index.ts`
  - [ ] Write `src/__tests__/cli/report.test.ts` with ≥7 cases: (a) classification edge cases verified/recovered/escalated/failed, (b) `--run latest` resolves correctly, (c) human output golden-master (strip dynamic fields), (d) JSON output golden-master, (e) checkpoint-retry-timeout enrichment, (f) unknown reason graceful fallback, (g) no-runs-exist friendly error
  - [ ] Write `__tests__/integration/report.test.ts` with ≥1 case: fixture manifest with mixed outcomes, invoke via CLI, assert output shape

## Dev Notes

### Architecture Constraints

- **Command registration shape**: mirror `reconcile-from-disk.ts` exactly — `registerReportCommand(program: Command, version = '0.0.0', projectRoot = process.cwd(), registry?: AdapterRegistry): void`. The `registry` param is present even if unused so the signature is uniform.
- **Manifest reader**: use `resolveRunManifest(dbRoot, runId?)` from `./manifest-read.ts` — do NOT invent a new manifest-reading path. This helper handles the most-recent-run lookup when `runId` is undefined or `'latest'`.
- **DoltClient**: import from `../../modules/state/index.js`. Wrap Dolt queries in try/catch; report proceeds with manifest-only data if Dolt is unavailable (degraded mode).
- **No new packages** (AC14): the table formatter must be a local ~20-line helper (pad strings to fixed column widths). Do NOT add `cli-table3`, `table`, `chalk` (if not already present), or any other npm package.
- **`classifyStoryOutcome` is a pure function**: no filesystem or Dolt access. Accepts `(storyState: PerStoryState, runId: string)` and returns the four-valued enum. Place in the same file above the renderer functions, exported for testability.
- **Story key truncation**: in human format, truncate story_key display to 50 chars with `…` suffix; full key available in JSON.
- **Cost fields**: manifest's `cost_accumulation.run_total` is the primary cost; `cli_flags.costCeiling` or a dedicated `cost.ceiling` field (check actual manifest shape via `resolveRunManifest`) represents the ceiling. Surface utilization as `NN.N%`.
- **File header comment** (AC12) must be the first block after imports:
  ```
  // Phase D Story 54-5 (2026-04-05) extraction — Structured Completion Report.
  // Path A "recovered" outcomes classified here are produced by Epic 69 Story 69-1.
  // Recovery Engine (Epic 73) will programmatically consume this command's JSON output.
  ```

### Testing Requirements

- **Unit tests** (`src/__tests__/cli/report.test.ts`):
  - Import `classifyStoryOutcome` directly (no CLI invocation) for classification cases
  - Use `vitest` with `vi.mock` for filesystem/Dolt calls; inject fixture `PerStoryState` objects
  - Golden-master (human + JSON) tests: use a single shared fixture object; strip timestamps/durations before snapshot assertion (or use `expect.stringContaining` on stable substrings like `verified`, `E:0 W:1 I:0`)
  - No-runs-exist test: mock `resolveRunManifest` to return `null`/empty; assert process.exitCode = 1 and stderr includes "No runs found"

- **Integration test** (`__tests__/integration/report.test.ts`):
  - Write a real fixture manifest JSON to a temp `.substrate/runs/` directory
  - Fixture must include ≥3 stories with distinct outcomes (one `verified`, one `recovered` via review_cycles>0, one `escalated` with reason `checkpoint-retry-timeout`)
  - Invoke CLI via `execSync`/`spawnSync` against the compiled `dist/` build — not via ts-node
  - Assert human output contains summary line pattern and escalation detail block
  - Assert JSON output parses cleanly and has required top-level keys

- **Test file location**: unit at `src/__tests__/cli/report.test.ts`, integration at `__tests__/integration/report.test.ts` (matches existing integration test directory)
- **Run tests**: `npm run test:fast` for unit tests during iteration; `npm test` before merge

### File Paths

- `src/cli/commands/report.ts` — NEW (primary implementation)
- `src/cli/index.ts` — MODIFY (register subcommand)
- `src/__tests__/cli/report.test.ts` — NEW (unit tests)
- `__tests__/integration/report.test.ts` — NEW (integration test)

### Key Imports to Use

```typescript
import type { Command } from 'commander'
import { resolveRunManifest, readCurrentRunId } from './manifest-read.js'
import { DoltClient } from '../../modules/state/index.js'
import { resolveMainRepoRoot } from '../../utils/git-root.js'
```

### Reference Implementation for Manifest Resolution

```typescript
// --run latest → same as omitting --run (both resolve to most-recent run)
const effectiveRunId = (runId === 'latest' || runId == null) ? undefined : runId
const dbRoot = await resolveMainRepoRoot(projectRoot)
const { manifest, runId: resolvedId } = await resolveRunManifest(dbRoot, effectiveRunId)
if (!manifest) {
  process.stderr.write('No runs found. Run `substrate run` to start a pipeline.\n')
  process.exitCode = 1
  return
}
```

## Interface Contracts

- **Export**: `ReportOutput`, `StorySummary`, `EscalationDetail`, `ReportCost`, `ReportDuration` @ `src/cli/commands/report.ts` (for Epic 73 Recovery Engine consumption)
- **Import**: `PerStoryState` @ `packages/sdlc/src/run-model/per-story-state.ts` (from Story 52-3+)
- **Import**: `RunManifestData` @ `packages/sdlc/src/run-model/types.ts` (from Story 52-3+)
- **Import**: `resolveRunManifest`, `readCurrentRunId` @ `src/cli/commands/manifest-read.ts` (from Story 52-3+)

## Runtime Probes

```yaml
- name: report-no-runs-exits-with-error
  sandbox: host
  command: |
    set -e
    TMPDIR=$(mktemp -d)
    mkdir -p "$TMPDIR/.substrate/runs"
    echo '[]' > "$TMPDIR/.substrate/runs/manifest.json"
    cd /home/jplanow/code/jplanow/substrate
    node dist/cli.mjs report --run latest 2>&1 || true
  expect_stdout_regex:
    - 'No runs found'
  description: friendly error when no run manifests exist — exit 1 with helpful message

- name: report-human-output-with-fixture
  sandbox: host
  command: |
    set -e
    TMPDIR=$(mktemp -d)
    RUN_ID="test-run-$(date +%s)"
    mkdir -p "$TMPDIR/.substrate/runs"
    cat > "$TMPDIR/.substrate/runs/$RUN_ID.json" << 'MANIFEST'
    {
      "run_id": "test-run-fixture",
      "created_at": "2026-05-05T10:00:00.000Z",
      "updated_at": "2026-05-05T10:30:00.000Z",
      "run_status": "completed",
      "story_scope": ["71-1", "71-2", "71-3"],
      "generation": 5,
      "supervisor_pid": null,
      "supervisor_session_id": null,
      "cli_flags": {},
      "recovery_history": [],
      "cost_accumulation": { "per_story": {"71-1": 0.05, "71-2": 0.03, "71-3": 0.02}, "run_total": 0.10 },
      "pending_proposals": [],
      "per_story_state": {
        "71-1": { "status": "complete", "phase": "COMPLETE", "started_at": "2026-05-05T10:00:00.000Z", "completed_at": "2026-05-05T10:10:00.000Z", "verification_result": { "status": "pass", "findings": [], "verification_ran": true, "error_count": 0, "warn_count": 0, "info_count": 0 }, "cost_usd": 0.05, "review_cycles": 0, "dispatches": 1 },
        "71-2": { "status": "complete", "phase": "COMPLETE", "started_at": "2026-05-05T10:10:00.000Z", "completed_at": "2026-05-05T10:20:00.000Z", "verification_result": { "status": "pass", "findings": [], "verification_ran": true, "error_count": 0, "warn_count": 1, "info_count": 0 }, "cost_usd": 0.03, "review_cycles": 1, "dispatches": 2 },
        "71-3": { "status": "escalated", "phase": "ESCALATED", "started_at": "2026-05-05T10:20:00.000Z", "completed_at": "2026-05-05T10:30:00.000Z", "escalation_reason": "checkpoint-retry-timeout", "cost_usd": 0.02, "review_cycles": 2, "dispatches": 1 }
      }
    }
    MANIFEST
    echo "$RUN_ID" > "$TMPDIR/.substrate/runs/manifest.json"
    cd /home/jplanow/code/jplanow/substrate
    SUBSTRATE_PROJECT_ROOT="$TMPDIR" node dist/cli.mjs report --run test-run-fixture 2>&1
  expect_stdout_regex:
    - '1 verified'
    - '1 recovered'
    - '1 escalated'
    - 'checkpoint-retry-timeout'
    - 'reconcile-from-disk'
  description: human output contains summary line and escalation detail for fixture with 3 mixed-outcome stories

- name: report-json-output-well-formed
  sandbox: host
  command: |
    set -e
    TMPDIR=$(mktemp -d)
    mkdir -p "$TMPDIR/.substrate/runs"
    cat > "$TMPDIR/.substrate/runs/test-run-json.json" << 'MANIFEST'
    {
      "run_id": "test-run-json",
      "created_at": "2026-05-05T10:00:00.000Z",
      "updated_at": "2026-05-05T10:30:00.000Z",
      "run_status": "completed",
      "story_scope": ["71-1"],
      "generation": 2,
      "supervisor_pid": null,
      "supervisor_session_id": null,
      "cli_flags": {},
      "recovery_history": [],
      "cost_accumulation": { "per_story": {"71-1": 0.05}, "run_total": 0.05 },
      "pending_proposals": [],
      "per_story_state": {
        "71-1": { "status": "complete", "phase": "COMPLETE", "started_at": "2026-05-05T10:00:00.000Z", "completed_at": "2026-05-05T10:10:00.000Z", "verification_result": { "status": "pass", "findings": [], "verification_ran": true, "error_count": 0, "warn_count": 0, "info_count": 0 }, "cost_usd": 0.05, "review_cycles": 0, "dispatches": 1 }
      }
    }
    MANIFEST
    echo "test-run-json" > "$TMPDIR/.substrate/runs/manifest.json"
    cd /home/jplanow/code/jplanow/substrate
    SUBSTRATE_PROJECT_ROOT="$TMPDIR" node dist/cli.mjs report --run test-run-json --output-format json 2>&1 | python3 -m json.tool
  expect_stdout_regex:
    - '"runId"'
    - '"summary"'
    - '"stories"'
    - '"escalations"'
    - '"cost"'
    - '"duration"'
  expect_stdout_no_regex:
    - '"error":'
    - 'SyntaxError'
  description: JSON output parses cleanly and contains all required top-level keys

- name: report-run-latest-matches-default
  sandbox: host
  command: |
    set -e
    TMPDIR=$(mktemp -d)
    mkdir -p "$TMPDIR/.substrate/runs"
    cat > "$TMPDIR/.substrate/runs/test-run-latest.json" << 'MANIFEST'
    {
      "run_id": "test-run-latest",
      "created_at": "2026-05-05T10:00:00.000Z",
      "updated_at": "2026-05-05T10:10:00.000Z",
      "run_status": "completed",
      "story_scope": ["71-1"],
      "generation": 1,
      "supervisor_pid": null,
      "supervisor_session_id": null,
      "cli_flags": {},
      "recovery_history": [],
      "cost_accumulation": { "per_story": {"71-1": 0.01}, "run_total": 0.01 },
      "pending_proposals": [],
      "per_story_state": {
        "71-1": { "status": "complete", "phase": "COMPLETE", "started_at": "2026-05-05T10:00:00.000Z", "completed_at": "2026-05-05T10:10:00.000Z", "verification_result": { "status": "pass", "findings": [], "verification_ran": true, "error_count": 0, "warn_count": 0, "info_count": 0 }, "cost_usd": 0.01, "review_cycles": 0, "dispatches": 1 }
      }
    }
    MANIFEST
    echo "test-run-latest" > "$TMPDIR/.substrate/runs/manifest.json"
    cd /home/jplanow/code/jplanow/substrate
    OUT_DEFAULT=$(SUBSTRATE_PROJECT_ROOT="$TMPDIR" node dist/cli.mjs report 2>&1)
    OUT_LATEST=$(SUBSTRATE_PROJECT_ROOT="$TMPDIR" node dist/cli.mjs report --run latest 2>&1)
    [ "$OUT_DEFAULT" = "$OUT_LATEST" ] && echo "MATCH_OK" || echo "MISMATCH"
  expect_stdout_regex:
    - 'MATCH_OK'
  expect_stdout_no_regex:
    - 'MISMATCH'
  description: --run latest and omitting --run produce identical output (AC7)
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change |
|---|---|
| 2026-05-05 | Initial story file authored from Phase D 54-5 extraction spec |
