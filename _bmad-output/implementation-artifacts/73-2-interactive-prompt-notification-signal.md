---
external_state_dependencies:
  - filesystem
  - subprocess
---
# Story 73-2: Interactive Prompt + Notification Signal

## Story

As a substrate operator,
I want an interactive numbered-choice prompt when the Decision Router halts execution,
so that I can make informed decisions about how to proceed, while filesystem notifications let external monitors detect halts immediately.

## Acceptance Criteria

<!-- source-ac-hash: 928a52002f7c07817c97553cf13001663906f402dd005f1cb8976f1a37dbab09 -->

### AC1: New interactive-prompt module
New module `src/modules/interactive-prompt/index.ts` exporting
`runInteractivePrompt(decisionContext)` returning the operator's
chosen action (or default in `--non-interactive` mode).

### AC2: Numbered choice presentation
**Numbered choice presentation**: prompt format:
```
─────────────────────────────────────────────────
⚠ Halt: <decision-type> (<severity>)
─────────────────────────────────────────────────
<decision-context-summary>

1) Accept default: <default-action>
2) Retry with custom context
3) Propose re-scope
4) Abort run

Choice [1]:
```
Default `1` if operator presses Enter.

### AC3: Stdin input collection
**Stdin input collection**: use `readline.createInterface` (Node
stdlib, already used elsewhere — consult
`src/cli/commands/reconcile-from-disk.ts` from Epic 69 for
pattern). Read one line; trim; parse as 1-4 integer; default to 1
on parse failure.

### AC4: `--non-interactive` mode bypass
**`--non-interactive` mode bypass**: when
`process.env.SUBSTRATE_NON_INTERACTIVE === 'true'` (set by Epic
72's `--non-interactive` flag) OR `decisionContext.nonInteractive
=== true`, return default action without printing or reading
stdin. Emit `decision:halt-skipped-non-interactive` event (Epic 72
event type) for operator audit trail.

### AC5: Notification file
**Notification file**: write
`.substrate/notifications/<runId>-<isoTimestamp>.json` with shape:
```json
{
  "runId": "...",
  "timestamp": "2026-05-06T...",
  "decisionType": "...",
  "severity": "critical",
  "context": {...},
  "choices": [...],
  "operatorChoice": null
}
```
File written BEFORE prompting so external monitors can detect halt
immediately. Update `operatorChoice` field after operator responds
(or leave null if non-interactive).

### AC6: Cleanup contract
**Cleanup contract**: `substrate report` (Epic 71) reads
`.substrate/notifications/<run-id>-*.json` files for the run being
reported, includes them in the report output, then deletes them.
This is implemented in Story 73-2 by extending Epic 71's report
command (small modification at `src/cli/commands/report.ts`).

### AC7: External-monitor delete tolerance
**External-monitor delete tolerance**: substrate does NOT
re-read notification files after writing. If an external monitor
deletes the file (after processing), substrate continues normally.
No retry / re-read logic.

### AC8: Use canonical helpers
**Use canonical helpers** (per Story 69-2 / 71-2 / 72-x lesson):
- Run-id resolution via `manifest-read.ts` helpers
  (`resolveRunManifest`, `readCurrentRunId`)
- Persistence via existing `DoltClient` if needed for state writes
- **Do NOT introduce new aggregate manifest formats.**

### AC9: Unit tests
**Tests** at
`src/modules/interactive-prompt/__tests__/index.test.ts` (≥5
cases): (a) presents numbered choices on stdout; (b) reads stdin
and returns operator's choice; (c) `--non-interactive` returns
default without stdin read; (d) writes notification file with
correct shape; (e) handles malformed stdin input → defaults to 1.

### AC10: Integration test
**Integration test** at
`__tests__/integration/interactive-prompt.test.ts` (≥1 case):
spawn substrate run with halt-able decision; close stdin; assert
notification file written; assert default action applied; assert
notification file deleted by `substrate report` after the run.

### AC11: Header comment
**Header comment** cites Phase D Story 54-3 (original spec) +
Epic 72 (Decision Router that triggers prompts) + Story 73-1
(Recovery Engine that the prompt collects responses for).

### AC12: `substrate report` extension
**`substrate report` extension**: add notification reading + cleanup
to `src/cli/commands/report.ts` (Epic 71). Notifications appear
in human format under "Operator Halts" section; in JSON format
as top-level `halts` array.

### AC13: No package additions
**No package additions**.

## Tasks / Subtasks

- [ ] Task 1: Create `src/modules/interactive-prompt/index.ts` (AC: #1, #2, #3, #4, #11)
  - [ ] Define `DecisionContext` interface: `runId`, `decisionType`, `severity`, `summary`, `defaultAction`, `choices`, `nonInteractive?`, and any event-emitter callback
  - [ ] Define `OperatorAction` return type (choice 1–4 mapped to action string)
  - [ ] Write header comment citing Phase D Story 54-3, Epic 72, Story 73-1
  - [ ] Implement `--non-interactive` bypass: check `process.env.SUBSTRATE_NON_INTERACTIVE === 'true'` OR `decisionContext.nonInteractive === true`; emit `decision:halt-skipped-non-interactive` event
  - [ ] Add startup TTY guard: if `process.stdin.isTTY === false` AND non-interactive not set, log warning and treat as non-interactive (defensive default)
  - [ ] Implement `renderPrompt(ctx)`: write separator line, `⚠ Halt: <type> (<severity>)`, separator, summary, numbered choices, `Choice [1]:` to stdout
  - [ ] Implement stdin collection via `readline.createInterface` (matching `reconcile-from-disk.ts` pattern): read one line, trim, parse 1–4 integer, default to 1 on parse failure or empty Enter

- [ ] Task 2: Implement notification file write/update (AC: #5, #7, #8)
  - [ ] Resolve notifications directory: `<repoRoot>/.substrate/notifications/` using `resolveMainRepoRoot()`
  - [ ] Construct file path: `<runId>-<new Date().toISOString().replace(/:/g, '-')>.json`
  - [ ] Write notification JSON file BEFORE printing prompt (shape: `runId`, `timestamp`, `decisionType`, `severity`, `context`, `choices`, `operatorChoice: null`)
  - [ ] After operator input (or non-interactive return), update `operatorChoice` field in the same file; if file was deleted by external monitor, swallow ENOENT and continue (AC7)
  - [ ] Use `readCurrentRunId()` from `manifest-read.ts` if `runId` not provided in `decisionContext`; do NOT invent aggregate formats (AC8)

- [ ] Task 3: Extend `src/cli/commands/report.ts` with notification read + cleanup (AC: #6, #12)
  - [ ] Add `readNotificationsForRun(runId, repoRoot)` helper: glob `.substrate/notifications/<runId>-*.json`, parse each, return array
  - [ ] Add `HaltNotification` interface and add `halts: HaltNotification[]` to `ReportOutput`
  - [ ] In `renderHuman()`: after escalation details, emit `──── Operator Halts ────` section listing each halt (timestamp, type, severity, operatorChoice)
  - [ ] In `renderJson()` / `assembleReport()`: include `halts` array in JSON output
  - [ ] After reading notifications, delete each file (swallow ENOENT — may have been cleaned by external monitor)
  - [ ] Update `ReportOutput` type export so Epic 73 Recovery Engine can consume the `halts` field

- [ ] Task 4: Integrate with orchestrator (AC: #1 — invocation wiring)
  - [ ] In `src/modules/implementation-orchestrator/orchestrator-impl.ts`: locate Decision Router halt handling (from Epic 72)
  - [ ] Import `runInteractivePrompt` from `../../modules/interactive-prompt/index.js`
  - [ ] When Decision Router returns `halt: true` and substrate is NOT in `--non-interactive` mode, call `runInteractivePrompt(decisionContext)` and route returned action to orchestrator continuation

- [ ] Task 5: Write unit tests (AC: #9)
  - [ ] Create `src/modules/interactive-prompt/__tests__/index.test.ts`
  - [ ] Test (a): mock stdout, call `runInteractivePrompt` with interactive context; assert separator, `⚠ Halt:`, numbered choices appear in stdout
  - [ ] Test (b): mock stdin input `"2\n"`, assert `runInteractivePrompt` returns choice-2 action
  - [ ] Test (c): set `decisionContext.nonInteractive = true`, assert returns `defaultAction` without touching stdin mock; assert `decision:halt-skipped-non-interactive` event emitted
  - [ ] Test (d): mock fs.writeFile, assert notification file written BEFORE readline question with correct JSON shape including `operatorChoice: null` initially
  - [ ] Test (e): mock stdin with `"abc\n"` (malformed), assert `runInteractivePrompt` returns default action (choice 1)

- [ ] Task 6: Write integration test (AC: #10)
  - [ ] Create `__tests__/integration/interactive-prompt.test.ts`
  - [ ] Spawn subprocess: `substrate run --events --non-interactive` with a fixture story configured to trigger a halt decision
  - [ ] After run, assert `.substrate/notifications/<runId>-*.json` file exists and has correct shape
  - [ ] Assert run applied default action (no manual override)
  - [ ] Run `substrate report --run <runId>`; assert output contains "Operator Halts" section; assert notification file deleted after report

## Dev Notes

### Architecture Constraints
- Module location: `src/modules/interactive-prompt/index.ts` — follow existing module conventions (`src/modules/*/index.ts`)
- Stdin pattern: mirror `src/cli/commands/reconcile-from-disk.ts` `promptOperator()` — `readline.createInterface({ input: process.stdin, output: process.stdout })`, call `rl.close()` after reading one line
- Run-id resolution: use `resolveRunManifest` / `readCurrentRunId` from `src/cli/commands/manifest-read.ts` — do NOT introduce new aggregate manifest formats
- Notification dir: `.substrate/notifications/` relative to `resolveMainRepoRoot()` output
- Timestamp in filenames: use `new Date().toISOString()` (UTC) — consistent with existing Dolt timestamp discipline (v0.18.0 UTC rule); sanitize colons for filesystem safety
- Non-interactive env var: `process.env.SUBSTRATE_NON_INTERACTIVE === 'true'` (string, not boolean) — matches Epic 72's convention
- Event emission: emit `decision:halt-skipped-non-interactive` via the same event emitter used by Epic 72's Decision Router; import pattern consistent with Epic 72 event types
- `ReportOutput` extension: `halts` field should be optional (`halts?: HaltNotification[]`) to maintain backward compatibility with callers that don't spread the interface

### Testing Requirements
- Unit tests: use Vitest with vi.mock for `fs/promises`, `readline`, `process.stdout.write`, and `resolveMainRepoRoot`
- Do NOT mock `process.env.SUBSTRATE_NON_INTERACTIVE` globally — restore after each test
- Integration test: use a temp directory fixture; ensure cleanup after test completes
- Run with `npm run test:fast` during iteration; full suite with `npm test` before merge
- Integration test may be slow (~30s for subprocess spawn) — add `timeout: 60000` to the test case
- NEVER run tests concurrently — check `pgrep -f vitest` returns nothing before running

### File Paths
- `src/modules/interactive-prompt/index.ts` (NEW)
- `src/modules/interactive-prompt/__tests__/index.test.ts` (NEW)
- `__tests__/integration/interactive-prompt.test.ts` (NEW)
- `src/cli/commands/report.ts` (extend with notification read + cleanup)
- `src/modules/implementation-orchestrator/orchestrator-impl.ts` (invoke Interactive Prompt on halt)

### Pattern References
- `readline.createInterface` usage: `src/cli/commands/reconcile-from-disk.ts` lines 29, 303–311
- Notification shape: JSON file, not Dolt row — consistent with run manifest file-backed storage discipline (`feedback_no_sqlite_run_manifest.md`)
- Report output rendering: `src/cli/commands/report.ts` `renderHuman()` / `renderJson()` — add "Operator Halts" section after escalation details block (line ~423 in current file)

## Interface Contracts

- **Export**: `HaltNotification` @ `src/cli/commands/report.ts` (top-level `halts` array in `ReportOutput`)
- **Export**: `runInteractivePrompt` @ `src/modules/interactive-prompt/index.ts` (consumed by `orchestrator-impl.ts` and unit tests)
- **Import**: Epic 72 event types / event emitter @ `src/modules/decision-router/index.ts` (or equivalent Epic 72 export) — for emitting `decision:halt-skipped-non-interactive`
- **Import**: `resolveRunManifest`, `readCurrentRunId` @ `src/cli/commands/manifest-read.ts` (from Story 71-2)

## Runtime Probes

```yaml
- name: notification-file-written-non-interactive
  sandbox: twin
  command: |
    set -e
    REPO_ROOT="$(pwd)"
    TMPDIR_PROBE="$(mktemp -d)"
    cd "$TMPDIR_PROBE"
    mkdir -p .substrate/notifications

    # Build first to ensure dist is current
    cd "$REPO_ROOT" && npm run build --silent 2>/dev/null || true
    cd "$TMPDIR_PROBE"

    SUBSTRATE_NON_INTERACTIVE=true node -e "
      const path = require('path');
      process.chdir('$TMPDIR_PROBE');
      const mod = require('$REPO_ROOT/dist/modules/interactive-prompt/index.js');
      mod.runInteractivePrompt({
        runId: 'probe-run-73-2-a',
        decisionType: 'story-failure',
        severity: 'critical',
        summary: 'Probe halt for runtime verification',
        defaultAction: 'retry',
        choices: ['retry', 'abort'],
        nonInteractive: true
      }).then(() => {
        const fs = require('fs');
        const notifDir = path.join('$TMPDIR_PROBE', '.substrate', 'notifications');
        const files = fs.readdirSync(notifDir).filter(f => f.includes('probe-run-73-2-a'));
        if (files.length === 0) { console.error('no notification file written'); process.exit(1); }
        const content = JSON.parse(fs.readFileSync(path.join(notifDir, files[0]), 'utf8'));
        console.log(JSON.stringify({ found: true, keys: Object.keys(content) }));
      }).catch(err => { console.error(err.message); process.exit(1); });
    "
  expect_stdout_regex:
    - '"found":true'
    - '"runId"'
    - '"operatorChoice"'
  description: non-interactive mode writes correctly shaped notification JSON file before returning

- name: report-reads-and-deletes-notifications
  sandbox: twin
  command: |
    set -e
    REPO_ROOT="$(pwd)"
    TMPDIR_PROBE="$(mktemp -d)"
    cd "$TMPDIR_PROBE"
    mkdir -p .substrate/notifications .substrate/runs

    # Plant a notification file and a minimal run manifest
    RUN_ID="probe-run-73-2-b"
    NOTIF_FILE=".substrate/notifications/${RUN_ID}-2026-05-06T00-00-00-000Z.json"
    cat > "$NOTIF_FILE" << 'NOTIF_EOF'
    {
      "runId": "probe-run-73-2-b",
      "timestamp": "2026-05-06T00:00:00.000Z",
      "decisionType": "story-failure",
      "severity": "critical",
      "context": {},
      "choices": ["retry", "abort"],
      "operatorChoice": null
    }
    NOTIF_EOF

    cat > ".substrate/runs/${RUN_ID}.json" << 'MANIFEST_EOF'
    {
      "run_id": "probe-run-73-2-b",
      "created_at": "2026-05-06T00:00:00.000Z",
      "updated_at": "2026-05-06T00:01:00.000Z",
      "run_status": "complete",
      "per_story_state": {}
    }
    MANIFEST_EOF
    printf '%s' "$RUN_ID" > .substrate/current-run-id

    cd "$REPO_ROOT"
    node dist/cli.mjs report --run "$RUN_ID" --basePath "$TMPDIR_PROBE" 2>&1 || true

    # Notification file should be deleted after report reads it
    if [ -f "$TMPDIR_PROBE/$NOTIF_FILE" ]; then
      echo "NOTIFICATION_FILE_NOT_DELETED"
      exit 1
    fi
    echo "NOTIFICATION_DELETED_OK"
  expect_stdout_regex:
    - 'Operator Halts'
    - 'NOTIFICATION_DELETED_OK'
  expect_stdout_no_regex:
    - 'NOTIFICATION_FILE_NOT_DELETED'
  description: substrate report reads notification files (shows Operator Halts), then deletes them
```

## Dev Agent Record

### Agent Model Used
### Completion Notes List
### File List

## Change Log

| Date | Change | By |
|---|---|---|
| 2026-05-06 | Story authored by create-story agent | pipeline |
